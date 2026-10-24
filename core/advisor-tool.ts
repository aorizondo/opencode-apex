/**
 * Apex Advisor — la ÚNICA herramienta que expone el agente advisor.
 *
 * Contrato (el vocabulario es allow/deny, no "consejo"):
 *   - Aprobar la ejecución de una tool  → decision: "allow"
 *   - Denegarla                        → decision: "deny" + reason (obligatorio)
 *
 * El aspecto decisorio/aconsejador NO lo elige el modelo: lo determina el
 * llamante (config `advisor.decisive`) y se le comunica en la petición. La
 * herramienta solo resuelve la decisión y devuelve qué se hará con ella.
 */

import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { ADVISOR_TOOL_NAME } from "./advisor-agent.js"
import { resolvePendingDecision } from "./advisor-session.js"

export interface AdvisorDecisionInput {
  readonly requestID: string
  readonly decision: "allow" | "deny"
  readonly reason?: string
}

/** Registra la herramienta de decisión (solo visible para el agente advisor). */
export function registerAdvisorTool(
  ctx: Plugin.Context,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: ADVISOR_TOOL_NAME,
        description:
          'Resuelve una solicitud de permiso: decision="allow" aprueba la ejecución de la herramienta; ' +
          'decision="deny" la deniega (reason obligatorio).',
        input: {
          type: "object",
          properties: {
            requestID: { type: "string", description: "Identificador de la solicitud recibida" },
            decision: { type: "string", enum: ["allow", "deny"], description: "allow = aprobar, deny = denegar" },
            reason: { type: "string", description: "Motivo breve (obligatorio cuando decision=deny)" },
          },
          required: ["requestID", "decision"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            accepted: { type: "boolean", description: "true si la solicitud existía y quedó resuelta" },
            decision: { type: "string", enum: ["allow", "deny"] },
          },
          required: ["accepted", "decision"],
        },
        execute: (rawInput: unknown) =>
          Effect.promise(async () => {
            const input = rawInput as AdvisorDecisionInput
            // Validación estricta: un veredicto inválido se RECHAZA (nunca se
            // asume "allow" por defecto — eso sería fail-open).
            if (input.decision !== "allow" && input.decision !== "deny") {
              throw new Error("decision debe ser \"allow\" o \"deny\"")
            }
            const decision = input.decision
            const reason = typeof input.reason === "string" && input.reason.length > 0 ? input.reason : undefined

            // Regla del contrato: deny exige motivo.
            if (decision === "deny" && !reason) {
              throw new Error("decision=deny requiere 'reason'")
            }

            const accepted = resolvePendingDecision(input.requestID, decision, reason)
            return { output: { accepted, decision } }
          }),
      })
    })
  })
}
