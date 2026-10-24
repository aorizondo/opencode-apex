/**
 * Core RPC module for opencode-apex (Effect-native).
 * Registers the "apex" RPC namespace: `POST /api/rpc/apex/<method>?location[directory]=<dir>`.
 *
 * OpenCode registra los RPC por `definition.id` (antes de 0.2.0 apex declaraba `name`
 * y su RPC quedaba registrado sin nombre: `rpc.unavailable`). Cada directorio registra
 * el suyo, con los handlers de ESE directorio: nada sale de variables de módulo.
 *
 * La llamada RPC espera a que los plugins del directorio estén activos (y lo levanta
 * si OpenCode lo había descargado por inactividad), así que es una entrada fiable
 * para procesos externos de larga duración.
 */

import { Effect } from "effect"
import { emit as busEmit } from "./bus.js"
import type { EventsHandles, IngestInput } from "../events.js"
import type { ServerEndpoint } from "./server-endpoint.js"
import type { ToolsRunInput } from "./tools-run.js"
import { redactHandler } from "../redact.js"

const ANY = { type: "object", additionalProperties: true } as const

/** Contrato del namespace "apex" (JSON Schema, igual que las tools). */
export const APEX_RPC_DEFINITION = {
  id: "apex",
  methods: {
    /** Salud: `{ pong, timestamp }`. */
    ping: { input: ANY, output: ANY },
    /** `{ modules, version, uptimeMs, endpoint }`. */
    status: { input: ANY, output: ANY },
    /** `{ text, mode? }` → `{ redacted, findings }`. */
    "redact.process": {
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true },
      output: ANY,
    },
    /** `{ source, type?, payload, eventID? }` → `{ accepted, eventID, delivered }`. */
    "events.ingest": {
      input: {
        type: "object",
        properties: {
          source: { type: "string" },
          type: { type: "string" },
          payload: { type: "object" },
          eventID: { type: "string" },
        },
        required: ["source", "payload"],
        additionalProperties: true,
      },
      output: ANY,
    },
    /** `{ tool, input?, agent?, timeoutMs? }` → `{ ok, tool, output?, content?, error?, durationMs }`. */
    "tools.run": {
      input: {
        type: "object",
        properties: {
          tool: { type: "string" },
          input: { type: "object" },
          agent: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["tool"],
        additionalProperties: true,
      },
      output: ANY,
    },
    /** Dónde y cómo llamar a este servidor (lo mismo que la tool apex_callback_endpoint). */
    "server.info": { input: ANY, output: ANY },
  },
  events: {
    "config.changed": { schema: ANY },
  },
} as const

export interface CentralRpcInput {
  readonly version: string
  readonly modules: Record<string, { enabled: boolean }>
  /** null si el módulo events está desactivado. */
  readonly events: EventsHandles | null
}

/**
 * Register the central "apex" RPC namespace (Effect-native).
 */
export function registerCentralRpc(
  ctx: { rpc: import("@opencode/plugin/effect").Plugin.Context["rpc"] },
  input: CentralRpcInput,
): Effect.Effect<void, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    const startedAt = Date.now()
    const { modules, events } = input
    const eventsOff = "the events module is disabled (modules.events=false)"
    const endpoint = (): ServerEndpoint | null => events?.endpoint() ?? null

    yield* ctx.rpc.register(APEX_RPC_DEFINITION as never, {
      ping: (rpcInput: { payload?: string }) =>
        Effect.succeed({ pong: rpcInput?.payload ?? "pong", timestamp: Date.now() }),
      status: () =>
        Effect.sync(() => ({
          modules: Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, module?.enabled === true])),
          version: input.version,
          uptimeMs: Date.now() - startedAt,
          endpoint: endpoint(),
        })),
      "server.info": () => Effect.sync(() => endpoint() ?? { error: eventsOff }),
      "redact.process": (rpcInput: { text: string; mode?: "strict" | "warn" }) =>
        redactHandler
          ? Effect.sync(() => redactHandler!(rpcInput))
          : Effect.succeed({ redacted: rpcInput.text, findings: [] }),
      // Una entrada inválida vuelve como `error` legible, no como fallo interno opaco.
      "events.ingest": (rpcInput: IngestInput) =>
        events
          ? Effect.promise(() =>
              events.ingest(rpcInput).catch((error: unknown) => ({
                accepted: false,
                eventID: "",
                delivered: [],
                error: error instanceof Error ? error.message : String(error),
              })),
            )
          : Effect.succeed({ accepted: false, eventID: "", delivered: [], error: eventsOff }),
      "tools.run": (rpcInput: ToolsRunInput) =>
        events
          ? Effect.promise(() => events.toolsRun(rpcInput))
          : Effect.succeed({ ok: false, tool: rpcInput?.tool ?? "", error: eventsOff, durationMs: 0 }),
    } as never)

    // Emit a config.changed event on the bus for subscribers
    busEmit("config.changed", { modules }, "apex-rpc")
  }) as Effect.Effect<void, never, import("effect").Scope.Scope>
}
