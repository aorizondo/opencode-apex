/**
 * Apex — resolución de plantillas de prompt.
 *
 * Reglas (por seguridad y portabilidad):
 *  - SOLO rutas relativas: al proyecto (`prompts/x.md`) o al home (`~/x.md`).
 *  - Las rutas absolutas se RECHAZAN con aviso.
 *  - Si el fichero no existe, se CREA con el contenido por defecto.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, normalize, sep } from "node:path"
import { normalize as winNormalize, sep as winSep } from "node:path/win32"

export interface TemplateLocation {
  /** Directorio del proyecto (base de las rutas relativas). */
  readonly projectDir: string
  /** Home del usuario (base de `~/...`). */
  readonly home: string
}

export type TemplateResolution =
  | { readonly ok: true; readonly path: string; readonly relative: boolean }
  | { readonly ok: false; readonly reason: string }

/** ¿La especificación es una ruta absoluta (POSIX, Windows o UNC)? */
export function isAbsoluteSpec(spec: string): boolean {
  const raw = spec.trim()
  return isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")
}

/**
 * Resuelve una ruta de plantilla.
 * `~/x` → home · `x` → proyecto · absoluta → rechazada.
 * Las rutas con `..` que ESCAPEN del directorio base también se rechazan
 * (lectura/escritura fuera de proyecto/home = primitiva de exfiltración).
 */
export function resolveTemplatePath(spec: string, location: TemplateLocation): TemplateResolution {
  const raw = spec.trim()
  if (raw.length === 0) return { ok: false, reason: "ruta vacía" }
  if (isAbsoluteSpec(raw)) {
    return { ok: false, reason: "no se permiten rutas absolutas (usa una relativa al proyecto o al home con ~/)" }
  }
  if (raw === "~") return { ok: false, reason: "'~' no es un fichero" }
  const base = raw.startsWith("~/") || raw.startsWith("~\\") ? location.home : location.projectDir
  const sub = raw.startsWith("~/") || raw.startsWith("~\\") ? raw.slice(2) : raw
  const normalized = normalize(join(base, sub))
  const baseNorm = normalize(base)
  const escapesPosix = normalized !== baseNorm && !normalized.startsWith(baseNorm + sep)
  // Defensa cross-platform: en Windows `\` también es separador, así que se
  // valida además con la semántica win32 aunque corramos en POSIX.
  const winPath = winNormalize(join(base, sub.replace(/\//g, "\\")))
  const winBase = winNormalize(base)
  const escapesWin = winPath !== winBase && !winPath.startsWith(winBase + winSep)
  if (escapesPosix || escapesWin) {
    return { ok: false, reason: "la ruta escapa del directorio base (../ no permitido)" }
  }
  return { ok: true, path: normalized, relative: true }
}

export interface TemplateReadResult {
  /** Contenido final, o null si la ruta es inválida. */
  readonly content: string | null
  readonly path?: string
  readonly created?: boolean
  readonly reason?: string
}

/**
 * Lee una plantilla; si no existe la crea con `defaultContent`.
 * Devuelve `content: null` si la ruta es inválida (absoluta/vacía).
 */
export function readOrCreateTemplate(
  spec: string | undefined,
  location: TemplateLocation,
  defaultContent: string,
): TemplateReadResult {
  if (spec === undefined || spec.trim().length === 0) {
    return { content: null, reason: "sin especificar" }
  }

  const resolved = resolveTemplatePath(spec, location)
  if (!resolved.ok) {
    console.warn(`[apex] plantilla "${spec}" rechazada: ${resolved.reason}`)
    return { content: null, reason: resolved.reason }
  }

  const path = resolved.path
  try {
    if (existsSync(path)) {
      return { content: readFileSync(path, "utf8"), path, created: false }
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, defaultContent, "utf8")
    console.info(`[apex] plantilla creada con valores por defecto: ${path}`)
    return { content: defaultContent, path, created: true }
  } catch (error) {
    console.warn(`[apex] no se pudo leer/crear la plantilla "${spec}": ${String(error)}`)
    return { content: null, path, reason: String(error) }
  }
}
