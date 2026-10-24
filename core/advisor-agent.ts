/**
 * Apex Advisor — definición del agente dedicado y su protocolo.
 *
 * El plugin define (upsert) un agente `apex-advisor` oculto, de modo `subagent`,
 * con su propio `model` (barato/rápido) y un ruleset de permisos que le permite
 * EXCLUSIVAMENTE la herramienta de decisión.
 *
 * El agente editor de v2 hace upsert: `update(id, fn)` sobre un id inexistente
 * lo crea partiendo de `Agent.Info.default(id)`.
 */

import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"

/** ID del agente advisor. */
export const ADVISOR_AGENT_ID = "apex-advisor"

/** Nombre de la única herramienta que expone el advisor. */
export const ADVISOR_TOOL_NAME = "apex_advisor_decide"

/** Instrucciones del agente: protocolo de decisión allow/deny. */
export function advisorSystemPrompt(decisive: boolean): string {
  const enforcement = decisive
    ? "Tu decisión se APLICA automáticamente: allow autoriza la ejecución, deny la bloquea."
    : "Tu decisión se muestra al usuario, que decide en última instancia."

  return `Eres el advisor de permisos de opencode-apex. Evaluás si se permite o se deniega
la ejecución de una herramienta solicitada por otra sesión de agente.

${enforcement}

Para responder debés llamar SIEMPRE a la herramienta \`${ADVISOR_TOOL_NAME}\` con:
  - requestID: el identificador de la solicitud (te lo damos en cada petición)
  - decision:  "allow" para APROBAR la ejecución
  - reason:    motivo breve — OBLIGATORIO cuando decision="deny", opcional si allow

Criterios:
  - "allow" si la acción es segura y apropiada en el contexto dado.
  - "deny" si puede causar daño, pérdida de datos, exfiltración de secretos,
    destrucción de recursos o es claramente inapropiada.

No ejecutes ninguna otra herramienta. No respondas con texto libre: usá la herramienta.`
}

/**
 * Define/actualiza el agente advisor en el runtime.
 * Se re-ejecuta en cada carga del plugin (upsert idempotente).
 */
export function ensureAdvisorAgent(
  ctx: Plugin.Context,
  options: { model?: string; system?: string; decisive: boolean },
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const model = parseModelRef(options.model)

    yield* ctx.agent.transform((editor) => {
      editor.update(ADVISOR_AGENT_ID, (agent) => {
        agent.name = ADVISOR_AGENT_ID as never
        agent.description = "Advisor de permisos de apex: decide allow/deny sobre herramientas de otras sesiones"
        agent.mode = "subagent"
        agent.hidden = true
        agent.system = options.system ?? advisorSystemPrompt(options.decisive)
        if (model) agent.model = model as never

        // Toolset = la herramienta de decisión y `execute`. El resto denegado, así
        // el advisor no puede tocar el workspace.
        //
        // `execute` es imprescindible, no un extra: en opencode v2 el modelo no
        // invoca las herramientas como function calls, las llama desde el sandbox
        // JS (`return await tools.apex_advisor_decide({…})`). Con `execute`
        // denegado el advisor decidía correctamente y su llamada quedaba en
        // `executed: false`, de modo que la decisión nunca llegaba y cada
        // evaluación terminaba en timeout. El sandbox no amplía privilegios:
        // toda herramienta que invoque vuelve a pasar por estos permisos.
        agent.permissions = [
          { action: "*", resource: "*", effect: "deny" },
          { action: "execute", resource: "*", effect: "allow" },
          { action: ADVISOR_TOOL_NAME, resource: "*", effect: "allow" },
        ] as never
      })
    })
  })
}

/** "providerID/modelID" → Model.Ref. Devuelve null si el formato no es válido. */
export function parseModelRef(spec: string | undefined): { providerID: string; id: string } | null {
  const raw = (spec ?? "").trim()
  if (!raw) return null
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash === raw.length - 1) return null
  return { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) }
}
