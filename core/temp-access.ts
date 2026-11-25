/**
 * Acceso al directorio temporal de OpenCode sin preguntar.
 *
 * OpenCode le dice al modelo que use `<tmpdir>/opencode` en vez de `/tmp` ("pre-created
 * and approved for external access", core/instructions/builtins.ts), pero ninguna regla
 * lo aprueba: cada lectura o escritura ahí acaba en una petición `external_directory`.
 * Este módulo es esa regla.
 *
 * Va como hook de `permission.evaluate` y no como regla en los agentes:
 *   - vale para todos, también los que otros plugins crean después (claude-*);
 *   - el host evalúa ANTES los deny configurados, así que un deny del usuario sobre
 *     esa ruta sigue ganando, y aquí solo se pasa `ask` → `allow`.
 * Se registra después del guard (un deny suyo se respeta) y antes del advisor (que
 * deja de recibir lo que ya está resuelto).
 */

import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** El `Global.Path.tmp` de OpenCode: `path.join(os.tmpdir(), "opencode")`. */
export function opencodeTempDir(): string {
  return join(tmpdir(), "opencode").replaceAll("\\", "/")
}

/**
 * Recursos de `external_directory` que caen dentro de `dir`. OpenCode los pide como
 * `<directorio>/*`, con barras `/` (file-access.ts); se acepta el propio `dir` por si
 * acaso, nunca un prefijo como `/tmp/opencode-otra`.
 */
export function insideDir(resource: string, dir: string): boolean {
  const r = resource.replaceAll("\\", "/")
  const base = dir.replace(/\/+$/, "")
  return r === base || r === `${base}/*` || r.startsWith(`${base}/`)
}

interface PermissionEvaluationEvent {
  readonly action: string
  readonly resources: readonly string[]
  effect: "allow" | "deny" | "ask"
}

/** `ask` → `allow` cuando todo lo pedido está en el directorio temporal. */
export function applyTempAccess(event: PermissionEvaluationEvent, dir = opencodeTempDir()): boolean {
  if (event.effect !== "ask" || event.action !== "external_directory") return false
  if (event.resources.length === 0 || !event.resources.every((resource) => insideDir(resource, dir))) return false
  event.effect = "allow"
  return true
}

export function registerTempAccess(ctx: Plugin.Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const dir = opencodeTempDir()
    yield* Effect.logInfo(`[apex.tempAccess] external_directory permitido en ${dir}`)
    // Envuelto como en guard.ts: un fallo aquí no debe cortar los hooks de detrás.
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        try {
          applyTempAccess(event as unknown as PermissionEvaluationEvent, dir)
        } catch (error) {
          console.error(`[apex.tempAccess] fallo evaluando un permiso, se deja como estaba: ${String(error)}`)
        }
      }),
    )
  })
}
