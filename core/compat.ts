/**
 * Compatibilidad con la versión de OpenCode que carga el plugin.
 *
 * apex usa `effect` sin declarar versión propia: la toma de `@opencode/plugin`
 * (peer opcional en package.json), así que npm instala UNA sola copia y la versión
 * sigue sola a la de OpenCode. Si aun así hubiera dos copias (una instalación vieja
 * en caché, un gestor que no hoistea), los efectos de una no se entienden con la otra
 * y el fallo llega críptico (`Schema.isStartsWith is not a function`, "missing TypeId").
 * Aquí se detecta al cargar y se dice qué hacer.
 *
 * La caché npm de plugins de OpenCode no se refresca sola: tras actualizar OpenCode,
 * apex sigue con las dependencias de cuando se instaló hasta que se reinstala.
 */

import { readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

interface Resolved {
  readonly dir: string
  readonly version: string
}

/**
 * Directorio y versión del paquete `name` tal como lo encuentra un módulo de `fromDir`:
 * el primer `node_modules/<name>` subiendo de directorio (la búsqueda de Node). No se usa
 * `require.resolve` porque los paquetes de OpenCode solo exportan la condición `import`.
 */
function resolvePackage(name: string, fromDir: string): Resolved | null {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, "node_modules", name)
    const pkg = readPackage(candidate)
    if (pkg?.name === name) return { dir: realpathSafe(candidate), version: pkg.version ?? "?" }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readPackage(dir: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  } catch {
    return null
  }
}

/** Cómo forzar que OpenCode reinstale apex y sus dependencias. */
const REINSTALL =
  "stop OpenCode, delete ~/.cache/opencode/npm/opencode-apex@* and start it again " +
  "(in 2.1 `opencode plugin update` only handles TUI plugins)"

/** major.minor numérico, o null si no se puede leer. */
function minor(version: string | undefined): [number, number] | null {
  const match = /^(\d+)\.(\d+)/.exec(version ?? "")
  return match ? [Number(match[1]), Number(match[2])] : null
}

/** true si `a` (major.minor) es posterior a `b`. */
export function newerMinor(a: string | undefined, b: string | undefined): boolean {
  const x = minor(a)
  const y = minor(b)
  if (!x || !y) return false
  return x[0] > y[0] || (x[0] === y[0] && x[1] > y[1])
}

/**
 * Avisos de compatibilidad (vacío = todo bien).
 * @param hostVersion versión de OpenCode (`ctx.app.version`)
 */
export function compatibilityWarnings(
  hostVersion: string | undefined,
  apexDir: string = dirname(dirname(fileURLToPath(import.meta.url))),
): string[] {
  const warnings: string[] = []
  const plugin = resolvePackage("@opencode/plugin", apexDir)
  const ownEffect = resolvePackage("effect", apexDir)
  const pluginEffect = plugin ? resolvePackage("effect", plugin.dir) : null

  if (ownEffect && pluginEffect && ownEffect.dir !== pluginEffect.dir) {
    warnings.push(
      `two copies of effect: apex uses ${ownEffect.version} and @opencode/plugin ${pluginEffect.version}. ` +
        `Reinstall the plugin: ${REINSTALL}.`,
    )
  }
  if (plugin && newerMinor(hostVersion, plugin.version)) {
    warnings.push(
      `OpenCode ${hostVersion} is newer than the @opencode/plugin ${plugin.version} installed with apex. ` +
        `Reinstall it to realign versions: ${REINSTALL}.`,
    )
  }
  return warnings
}
