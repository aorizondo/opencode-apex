/**
 * Apex Guard — el módulo que aplica los meta-permisos y los reporta.
 *
 * Dos piezas:
 *   1. `permission.hook("evaluate")` → reescribe el efecto según las reglas de
 *      `core/guard.ts` y anota la decisión.
 *   2. la tool `apex_guard_report` → devuelve lo anotado, para auditar qué ha
 *      intentado cada agente y qué se le dejó hacer.
 *
 * ORDEN DE REGISTRO. Debe registrarse ANTES del advisor. `hooks.trigger` del host
 * recorre los callbacks en orden de registro mutando el mismo evento, y el
 * advisor solo interviene cuando el efecto sigue siendo `"ask"`. Registrando el
 * guard primero, lo que el guard resuelve ya no llega al advisor, y lo que deja
 * en `"ask"` es exactamente lo que el advisor debe juzgar. Invertir el orden
 * haría que el advisor aprobara cosas que el guard iba a prohibir.
 *
 * EL CASO DEL PROPIO ADVISOR. El agente `apex-advisor` pasa por el guard como
 * cualquier otro: su política por defecto le deja `execute` (imprescindible —
 * opencode v2 invoca las herramientas desde el sandbox JS) y
 * `apex_advisor_decide`, y le deniega el resto. Así, si su modelo intenta
 * `write`, el guard lo corta sin consultarle a él mismo: el guard no llama a
 * ningún modelo, de modo que no hay recursión posible.
 */

import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { homedir } from "node:os"
import {
  decide,
  GuardReport,
  ruleLabel,
  type GuardConfigShape,
  type GuardEffect,
  type GuardEntry,
} from "./core/guard.js"

export type { GuardConfigShape }

const TOOL_NAME = "apex_guard_report"
const ADVISOR_AGENT = "apex-advisor"
const ADVISOR_TOOL = "apex_advisor_decide"

/**
 * Defaults: nada prohibido salvo lo del advisor, y en modo informe.
 *
 * Arrancar en `report` es deliberado: un guard recién configurado que empiece
 * denegando rompe la sesión antes de que nadie haya visto una sola regla en
 * acción. Se mira el informe, se ajustan las reglas y entonces se pasa a
 * `enforce`.
 */
export function createDefaultGuardConfig(): GuardConfigShape & { enabled: boolean } {
  return {
    enabled: false,
    mode: "report",
    fallback: "keep",
    keep: 500,
    agents: {
      [ADVISOR_AGENT]: [
        { action: "*", effect: "deny", reason: "el advisor solo decide; no toca el workspace" },
        { action: "execute", effect: "allow" },
        { action: ADVISOR_TOOL, effect: "allow" },
      ],
    },
  }
}

/**
 * Informe vivo, compartido por PROCESO.
 *
 * opencode instancia el plugin una vez por location (el propio advisor corre en
 * `/tmp/opencode-apex-advisor`, que es otra), así que con el informe en ámbito de
 * módulo el hook de una instancia anota donde la tool de otra no mira — y sale un
 * informe vacío con el guard funcionando. `Symbol.for` es el único ámbito que
 * coincide con el del recurso.
 */
const CELL = Symbol.for("apex.guard.report.v1")

function cell(keep: number): GuardReport {
  const holder = globalThis as Record<symbol, GuardReport | undefined>
  return (holder[CELL] ??= new GuardReport(keep))
}

export function guardReport(): GuardReport | null {
  return (globalThis as Record<symbol, GuardReport | undefined>)[CELL] ?? null
}

interface PermissionEvaluationEvent {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  effect: GuardEffect
  message?: string
}

export function register(
  ctx: Plugin.Context,
  config: GuardConfigShape & { enabled: boolean },
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const projectDir = ctx.location?.directory ?? process.cwd()
    const home = homedir()
    const enforce = config.mode === "enforce"
    const live = cell(config.keep)

    yield* Effect.logInfo(
      `[apex.guard] activo · modo=${config.mode} · fallback=${config.fallback} · agentes con reglas: ${
        Object.keys(config.agents).join(", ") || "(ninguno)"
      }`,
    )

    // El cuerpo va envuelto porque `hooks.trigger` del host recorre los
    // callbacks con `yield* result`: si este lanza, la cadena se corta y los
    // hooks REGISTRADOS DESPUÉS no llegan a ejecutarse — el advisor, sin ir más
    // lejos, dejaría de evaluar y nadie se enteraría. Un fallo del guard debe
    // dejar el permiso como estaba, no desactivar lo que viene detrás.
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        try {
          aplicar(event as unknown as PermissionEvaluationEvent)
        } catch (error) {
          console.error(`[apex.guard] fallo evaluando un permiso, se deja como estaba: ${String(error)}`)
        }
      }),
    )

    function aplicar(e: PermissionEvaluationEvent): void {
      {
        const agent = e.agent ?? "(sin agente)"
        const verdict = decide(
          config,
          { agent: e.agent, action: e.action, resources: e.resources, incoming: e.effect },
          { projectDir, home },
        )

        // En modo informe se anota lo que HABRÍA pasado y no se toca el permiso.
        const applied: GuardEffect = enforce ? verdict.effect : e.effect

        const entry: GuardEntry = {
          at: Date.now(),
          agent,
          action: e.action,
          resources: e.resources,
          incoming: verdict.incoming,
          effect: verdict.effect,
          applied,
          reason: verdict.reason,
          rule: ruleLabel(verdict.rule),
        }
        live.add(entry)
        if (process.env.APEX_GUARD_TRACE)
          console.log(`[apex.guard] ${agent} ${e.action} ${verdict.incoming}→${applied} ${verdict.reason ?? ""}`)

        if (!enforce) return
        // Solo se escribe cuando hay veredicto propio. Sin regla que coincida el
        // permiso se deja intacto (`fallback: "keep"`), y eso es lo que permite
        // que las reglas de `shell` de la config y el advisor sigan operando en
        // los agentes para los que el guard no dice nada.
        //
        // Un `allow` SÍ eleva un `ask`, y es deliberado: es lo que deja a un
        // subagente escribir en su propio directorio sin molestar al usuario. La
        // elevación exige una regla explícita — nunca sale del fallback.
        if (verdict.effect === e.effect) return
        e.effect = verdict.effect
        if (verdict.effect === "deny") {
          const motivo = verdict.reason ?? "prohibido por los meta-permisos de apex"
          e.message = `⛔ apex.guard: ${motivo}${verdict.rule ? ` [${ruleLabel(verdict.rule)}]` : ""}`
        }
      }
    }

    // --- Tool de informe -------------------------------------------------
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        description:
          "Informe de los meta-permisos de apex: qué herramientas ha intentado cada agente y qué se decidió " +
          "(allow/deny/ask), con la regla que lo decidió. Úsalo para auditar por qué se bloqueó una acción " +
          "o para ajustar las reglas antes de pasar el guard a modo enforce.",
        input: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Cuántas decisiones recientes devolver (por defecto 40)" },
            agent: { type: "string", description: "Filtra por agente" },
            effect: { type: "string", enum: ["allow", "deny", "ask"], description: "Filtra por efecto aplicado" },
          },
          additionalProperties: false,
        },
        // El informe sale como TEXTO, no como objeto: un `type: "object"` con
        // claves dinámicas (el resumen va por agente) lo rechaza el validador de
        // salida del host — «Tool returned a non-JSON value for its output
        // schema» —, y además una tabla compacta cuesta bastantes menos tokens
        // que el mismo contenido en JSON anidado.
        output: {
          type: "object",
          properties: { report: { type: "string", description: "Informe en texto" } },
          required: ["report"],
          additionalProperties: false,
        },
        execute: (rawInput: unknown) =>
          Effect.sync(() => {
            const input = (rawInput ?? {}) as { limit?: number; agent?: string; effect?: GuardEffect }
            const limit = Math.max(1, Math.min(input.limit ?? 40, config.keep))
            let rows = live.recent(config.keep)
            if (input.agent) rows = rows.filter((r) => r.agent === input.agent)
            if (input.effect) rows = rows.filter((r) => r.applied === input.effect)
            const shown = rows.slice(0, limit)

            const lineas: string[] = [
              `apex.guard · modo=${config.mode} · fallback=${config.fallback} · ${live.all().length} decisiones registradas`,
            ]

            const resumen = live.summary()
            const agentes = Object.keys(resumen).sort()
            if (agentes.length > 0) {
              lineas.push("", "resumen (allow/deny/ask por agente):")
              for (const a of agentes) {
                const r = resumen[a]!
                lineas.push(`  ${a.padEnd(20)} allow=${r.allow} deny=${r.deny} ask=${r.ask}`)
              }
            }

            if (shown.length === 0) {
              lineas.push("", "sin decisiones que encajen con el filtro")
            } else {
              lineas.push("", `últimas ${shown.length} (más reciente primero):`)
              for (const r of shown) {
                const hora = new Date(r.at).toISOString().slice(11, 19)
                const flecha = r.incoming === r.applied ? r.applied : `${r.incoming}→${r.applied}`
                const recursos = r.resources.length > 0 ? ` ${r.resources.slice(0, 2).join(" ")}` : ""
                const regla = r.rule ? ` · regla: ${r.rule}` : ""
                const motivo = r.reason && r.applied === "deny" ? ` · ${r.reason}` : ""
                lineas.push(`  ${hora} ${r.agent} ${r.action}${recursos} → ${flecha}${regla}${motivo}`)
              }
            }

            if (config.mode === "report") {
              lineas.push(
                "",
                'modo "report": la columna → muestra lo que se HABRÍA aplicado; el permiso no se ha tocado.',
              )
            }

            return { output: { report: lineas.join("\n") } }
          }),
      })
    })
  })
}
