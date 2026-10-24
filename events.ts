/**
 * Apex Events — ingesta genérica de eventos por RPC + suscripciones + entrega.
 *
 * Todo entra por el RPC del servidor de OpenCode (`/api/rpc/apex/<método>`):
 * - `events.ingest`: un proceso externo (script, cron, n8n, un relay de webhooks)
 *   notifica un evento → las suscripciones que casan lo entregan a su sesión.
 * - `tools.run`: el mismo proceso ejecuta una herramienta de OpenCode (ver core/tools-run.ts).
 *
 * Por qué solo RPC (0.2.0): OpenCode descarga los plugins de un directorio tras 60 min
 * sin actividad de sesiones, y no los vuelve a cargar tras un reinicio hasta que algo
 * toca ese directorio. Un listener propio del plugin se cerraba con él; el RPC, en
 * cambio, levanta el directorio en la propia llamada. Un webhook es un callback con
 * un proceso intermedio que traduce la llamada HTTP a `events.ingest`.
 *
 * Estado por directorio: el módulo se importa una sola vez por proceso y se registra
 * en cada directorio, así que nada de lo que depende del directorio vive a nivel de
 * módulo (antes la sesión principal y el handler de ingest eran globales).
 *
 * - Bus interno (`apex:event`)
 * - Suscripciones con filtros (evaluador de condiciones de core/conditions.ts)
 * - Entrega vía session.switchAgent + session.prompt / synthetic
 * - Deduplicación por eventID con TTL
 * - Suscripciones estáticas (config) + dinámicas (storage)
 */

import { homedir } from "node:os"
import { Effect, Stream } from "effect"
import type { Scope } from "effect"
import { emit, subscribe } from "./core/bus.js"
import type { Plugin } from "@opencode/plugin/effect"
import type { ApexConfig, EventsConfig, EventSubscription } from "./core/config.js"

export type { EventSubscription } from "./core/config.js"
import { evaluateCondition, type RuleCondition } from "./core/conditions.js"
import { readOrCreateTemplate } from "./core/templates.js"
import { ADVISOR_AGENT_ID } from "./core/advisor-agent.js"
import { curlExample, resolveServerEndpoint, type ServerEndpoint } from "./core/server-endpoint.js"
import {
  ensureRunnerAgent,
  makeToolsRunner,
  RUNNER_AGENT_ID,
  type ToolsRunInput,
  type ToolsRunOutput,
} from "./core/tools-run.js"

/** JSON value type accepted by plugin storage */
type StorageJson = Parameters<Plugin.Context["storage"]["set"]>[1]

// ============================================================================
// Types
// ============================================================================

/** Events module configuration */
export type { EventsConfig } from "./core/config.js"

/** Ingest RPC input */
export interface IngestInput {
  /** Event source identifier (e.g., "github", "webhook", "custom") */
  source: string
  /** Optional event type/category */
  type?: string
  /** Event payload */
  readonly payload: Record<string, unknown>
  /** Optional event ID for deduplication (auto-generated if not provided) */
  readonly eventID?: string
}

/** Ingest RPC output */
export interface IngestOutput {
  /** Whether event was accepted (always true unless validation fails) */
  accepted: boolean
  /** Event ID (generated or provided) */
  eventID: string
  /** Subscription IDs that received the event */
  delivered: string[]
}

/** Internal event emitted on bus */
interface InternalEvent {
  eventID: string
  source: string
  type: string | undefined
  payload: Record<string, unknown>
  location: string
  timestamp: number
}

/** Estado del módulo en UN directorio. */
export interface EventsState {
  /** Sesión principal activa (raíz, no advisor ni runner). null si no hay ninguna. */
  autoBoundSessionID: string | null
  /** URL pública del servidor fijada en runtime por el agente (túnel). Gana a la config. */
  runtimePublicUrl: string | null
  /** eventID → timestamp de la primera vez que se vio. */
  readonly dedup: Map<string, number>
}

/** Lo que el módulo publica por RPC (lo cablea core/rpc.ts). */
export interface EventsHandles {
  readonly ingest: (input: IngestInput) => Promise<IngestOutput>
  readonly endpoint: () => ServerEndpoint
  readonly toolsRun: (input: ToolsRunInput) => Promise<ToolsRunOutput>
}

// ============================================================================
// Constants
// ============================================================================

const SUBSCRIPTIONS_STORAGE_KEY = "apex:subscriptions"
const DEDUP_TTL_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_DELIVERY: "queue" | "steer" = "queue"
const DEFAULT_DELIVER_AS: "synthetic" | "prompt" = "prompt"
const DEFAULT_RESUME = false
const DEFAULT_PRIORITY = 0

// ---------------------------------------------------------------------------
// Auto-vinculación de suscripciones a la sesión principal
// ---------------------------------------------------------------------------

const AUTO_SESSION_STORAGE_KEY = "apex:events:autoSession"
const PUBLIC_URL_STORAGE_KEY = "apex:events:publicUrl"

export function createEventsState(): EventsState {
  return { autoBoundSessionID: null, runtimePublicUrl: null, dedup: new Map() }
}

/**
 * Fija (o limpia) la URL pública en runtime y la persiste.
 * Lo usa la tool `apex_set_callback_url` (el agente monta el túnel y la anuncia).
 */
async function setRuntimePublicUrl(ctx: Plugin.Context, state: EventsState, url: string | null): Promise<void> {
  state.runtimePublicUrl = url && url.trim().length > 0 ? url.trim() : null
  try {
    await Effect.runPromise(ctx.storage.set(PUBLIC_URL_STORAGE_KEY, (state.runtimePublicUrl ?? "") as never))
  } catch {
    // persistencia best-effort
  }
}

/** Fija (o limpia) la sesión principal y la persiste. */
async function setAutoBoundSession(ctx: Plugin.Context, state: EventsState, sessionID: string | null): Promise<void> {
  state.autoBoundSessionID = sessionID
  try {
    await Effect.runPromise(
      ctx.storage.set(AUTO_SESSION_STORAGE_KEY, (sessionID ?? "") as never),
    )
  } catch {
    // la persistencia es best-effort
  }
}

/**
 * ¿Esta sesión puede ser la principal?
 * Debe ser RAÍZ (sin parentID) y no ser una sesión técnica de apex (advisor, runner).
 */
export function isPrimaryCandidate(info: {
  parentID?: string | null
  agent?: string | null
}): boolean {
  if (info.parentID) return false
  if (info.agent === ADVISOR_AGENT_ID || info.agent === RUNNER_AGENT_ID) return false
  return true
}

/**
 * Resuelve la sesión destino de una suscripción:
 * `sessionID` explícito → ese; vacío/null/ausente → la sesión principal activa.
 */
export function resolveTargetSession(state: EventsState, subscription: { sessionID?: string | null }): string | null {
  const explicit = typeof subscription.sessionID === "string" ? subscription.sessionID.trim() : ""
  if (explicit.length > 0) return explicit
  return state.autoBoundSessionID
}

/** ¿El evento es de otro directorio? El bus de OpenCode es global: llegan los de todos. */
export function isForeignEvent(event: { location?: { directory?: string } | null }, directory: string): boolean {
  const other = event.location?.directory
  if (!other) return false
  const trim = (path: string) => path.replace(/\/+$/, "")
  return trim(other) !== trim(directory)
}

/** Procesa eventos de ciclo de vida para (des)vincular la sesión principal. */
export async function handleLifecycleEvent(
  ctx: Plugin.Context,
  state: EventsState,
  event: { type: string; data: unknown; location?: { directory?: string } | null },
): Promise<void> {
  if (isForeignEvent(event, ctx.location.directory)) return
  const data = (event.data ?? {}) as {
    sessionID?: string
    parentID?: string | null
    agent?: string | null
  }
  const sessionID = data.sessionID
  if (!sessionID) return

  if (event.type === "session.created") {
    if (!isPrimaryCandidate(data)) return
    if (state.autoBoundSessionID === sessionID) return
    await setAutoBoundSession(ctx, state, sessionID)
    console.log(`[Apex Events] suscripciones auto vinculadas a la sesión principal ${sessionID}`)
    return
  }

  if (event.type === "session.deleted") {
    if (state.autoBoundSessionID !== sessionID) return
    await setAutoBoundSession(ctx, state, null)
    console.log(`[Apex Events] sesión principal ${sessionID} cerrada: suscripciones auto desvinculadas`)
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Generate a unique event ID */
function generateEventID(): string {
  return crypto.randomUUID()
}

/** Check if eventID was recently seen (within TTL), cleaning expired entries */
function isDuplicate(state: EventsState, eventID: string): boolean {
  const now = Date.now()
  for (const [id, timestamp] of state.dedup.entries()) {
    if (now - timestamp > DEDUP_TTL_MS) state.dedup.delete(id)
  }
  return state.dedup.has(eventID)
}

/** Load subscriptions from storage */
async function loadSubscriptions(ctx: Plugin.Context): Promise<EventSubscription[]> {
  try {
    const stored = await Effect.runPromise(ctx.storage.get(SUBSCRIPTIONS_STORAGE_KEY))
    if (stored && Array.isArray(stored)) {
      return stored as EventSubscription[]
    }
  } catch {
    // Ignore storage errors
  }
  return []
}

/** Save subscriptions to storage */
async function saveSubscriptions(ctx: Plugin.Context, subscriptions: EventSubscription[]): Promise<void> {
  try {
    await Effect.runPromise(
      ctx.storage.set(SUBSCRIPTIONS_STORAGE_KEY, subscriptions as unknown as StorageJson),
    )
  } catch (error) {
    console.error("[Apex Events] Failed to save subscriptions:", error)
  }
}

/** Plantilla por defecto que se escribe si el fichero no existe. */
export const DEFAULT_EVENT_PROMPT_TEMPLATE = `Evento {{type}} de {{source}} ({{eventID}})
Payload: {{payload}}
`

/**
 * Resuelve el texto de la plantilla: fichero si `promptTemplateFile` está
 * definido (solo rutas relativas; se crea con defaults si no existe), si no
 * el texto inline. Si la ruta es inválida se degrada al inline y se avisa.
 */
export function resolveTemplate(
  ctx: Plugin.Context,
  subscription: EventSubscription,
): string | undefined {
  const file = subscription.promptTemplateFile
  if (!file) return subscription.promptTemplate

  // Solo rutas relativas (proyecto o ~/home); si no existe se crea con defaults.
  const { content } = readOrCreateTemplate(
    file,
    { projectDir: ctx.location?.directory ?? process.cwd(), home: homedir() },
    DEFAULT_EVENT_PROMPT_TEMPLATE,
  )
  if (content !== null) return content
  return subscription.promptTemplate
}

export function renderPromptTemplate(template: string, event: InternalEvent): string {
  return template
    .replace(/\{\{eventID\}\}/g, event.eventID)
    .replace(/\{\{source\}\}/g, event.source)
    .replace(/\{\{type\}\}/g, event.type ?? "")
    // `{{payload}}` a secas: el payload entero en JSON (lo usa la plantilla por defecto).
    .replace(/\{\{payload\}\}/g, () => JSON.stringify(event.payload))
    .replace(/\{\{payload\.([^}]+)\}\}/g, (_match, path) => {
      const value = path.split(".").reduce((acc: unknown, key: string) => {
        return (acc as Record<string, unknown>)?.[key]
      }, event.payload)
      if (value === undefined || value === null) return ""
      // Los strings se insertan tal cual (sin comillas); el resto en JSON.
      return typeof value === "string" ? value : JSON.stringify(value)
    })
}

/** Get default prompt for event */
function getDefaultPrompt(event: InternalEvent): string {
  return JSON.stringify({
    eventID: event.eventID,
    source: event.source,
    type: event.type,
    payload: event.payload,
    timestamp: new Date(event.timestamp).toISOString(),
  }, null, 2)
}

/** Evaluate subscription filters against event context */
function matchesSubscription(subscription: EventSubscription, event: InternalEvent): boolean {
  if (!subscription.enabled) return false
  if (subscription.filters.length === 0) return true

  const context: Record<string, unknown> = {
    source: event.source,
    type: event.type,
    payload: event.payload,
    location: event.location,
    eventID: event.eventID,
    timestamp: event.timestamp,
  }

  return subscription.filters.every((condition) => evaluateCondition(condition, context))
}

/** Deliver event to a single subscription */
async function deliverToSubscription(
  ctx: Plugin.Context,
  state: EventsState,
  subscription: EventSubscription,
  event: InternalEvent,
): Promise<boolean> {
  const targetSession = resolveTargetSession(state, subscription)
  if (!targetSession) {
    console.warn(
      `[Apex Events] suscripción ${subscription.id} sin sesión destino (sessionID vacío y sin sesión principal activa)`,
    )
    return false
  }

  try {
    // Switch agent if specified
    if (subscription.agent) {
      await Effect.runPromise(
        ctx.session.switchAgent({
          sessionID: targetSession as never,
          agent: subscription.agent as never,
        }),
      )
    }

    // Render prompt (fichero de plantilla con prioridad sobre el inline)
    const template = resolveTemplate(ctx, subscription)
    const promptText = template
      ? renderPromptTemplate(template, event)
      : getDefaultPrompt(event)

    // Entrega según el modo elegido
    if (subscription.deliverAs === "synthetic") {
      // Mensaje sintético. `resume` controla si se despierta el bucle del agente:
      //   resume=true  → execution.wake → el modelo procesa el mensaje
      //   resume=false → inyección pasiva (solo aparece en la sesión)
      await Effect.runPromise(
        ctx.session.synthetic({
          sessionID: targetSession as never,
          text: promptText,
          description: `apex event: ${event.type ?? event.source}`,
          delivery: subscription.delivery,
          resume: subscription.resume ?? DEFAULT_RESUME,
        } as never),
      )
    } else {
      // User prompt: entra en la cola/inbox de la sesión
      await Effect.runPromise(
        ctx.session.prompt({
          sessionID: targetSession as never,
          text: promptText,
          delivery: subscription.delivery,
        } as never),
      )
    }

    return true
  } catch (error) {
    console.error(`[Apex Events] Delivery failed for subscription ${subscription.id}:`, error)
    return false
  }
}

/** Process event delivery according to routing policy */
async function processDelivery(
  ctx: Plugin.Context,
  state: EventsState,
  subscriptions: EventSubscription[],
  event: InternalEvent,
  routing: "first" | "all",
): Promise<string[]> {
  // Find matching subscriptions con sesión destino resoluble
  const matching = subscriptions.filter(
    (sub) => matchesSubscription(sub, event) && resolveTargetSession(state, sub) !== null,
  )

  if (matching.length === 0) {
    return []
  }

  // Sort by priority (highest first)
  matching.sort((a, b) => b.priority - a.priority)

  const delivered: string[] = []

  if (routing === "first") {
    // Only deliver to highest priority match
    const top = matching[0]
    if (top) {
      const success = await deliverToSubscription(ctx, state, top, event)
      if (success) {
        delivered.push(top.id)
      }
    }
  } else {
    // Fan-out to all matches
    await Promise.all(
      matching.map(async (sub) => {
        const success = await deliverToSubscription(ctx, state, sub, event)
        if (success) {
          delivered.push(sub.id)
        }
      }),
    )
  }

  return delivered
}

// ============================================================================
// Tools (Effect Schema pattern from awareness.ts)
// ============================================================================

/**
 * Tool: apex_callback_endpoint — informa al agente de DÓNDE y CÓMO llama un proceso
 * externo a este servidor: URL base, URLs de los métodos RPC para este directorio,
 * auth (sin el password: solo de dónde leerlo) y ejemplos curl.
 */
function registerCallbackEndpointTool(
  ctx: Plugin.Context,
  endpoint: () => ServerEndpoint,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "apex_callback_endpoint",
        description:
          "Returns how an external program (script, cron, systemd, n8n, webhook relay) reaches THIS OpenCode " +
          "server: base URL, the apex RPC URLs for this project (events.ingest to notify events that wake an " +
          "agent, tools.run to run OpenCode tools), Basic auth and where to read the password (never the " +
          "password itself), plus curl examples. Call it before writing any external script or loop.",
        input: { type: "object", properties: {}, additionalProperties: false },
        output: {
          type: "object",
          properties: {
            baseUrl: { type: ["string", "null"], description: "Server base URL, as reachable from this machine" },
            source: { type: ["string", "null"], description: "Where baseUrl came from: config | service | argv" },
            publicUrl: { type: ["string", "null"], description: "URL for senders on other machines (tunnel/proxy)" },
            directory: { type: "string", description: "Value of location[directory] for every call" },
            auth: { type: "object", description: "Basic opencode:<password>; password says where it is, password.shell prints it" },
            rpc: { type: "object", description: "Full URLs: ingest, toolsRun, status, ping" },
            examples: { type: "object", description: "Ready-to-run curl for ingest and toolsRun" },
            hint: { type: "string" },
          },
          additionalProperties: true,
        },
        execute: () =>
          Effect.sync(() => {
            const current = endpoint()
            return {
              output: {
                ...current,
                examples: {
                  ingest: curlExample(current, "ingest", {
                    source: "monitor",
                    type: "server.down",
                    payload: { host: "example.com" },
                  }),
                  toolsRun: curlExample(current, "toolsRun", { tool: "read", input: { path: "README.md" } }),
                },
              },
            }
          }),
      })
    })
  })
}

/**
 * Tool: apex_set_callback_url — el agente anuncia (o limpia) la URL pública por la
 * que procesos de OTRAS máquinas alcanzan este servidor (túnel o proxy inverso hacia
 * él). Para scripts locales no hace falta: usan la URL base.
 */
function registerSetCallbackUrlTool(
  ctx: Plugin.Context,
  state: EventsState,
  endpoint: () => ServerEndpoint,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "apex_set_callback_url",
        description:
          "Sets (or clears) the public URL through which programs on OTHER machines reach this OpenCode " +
          "server, e.g. a tunnel (cloudflared/ngrok) pointing at its base URL. It is persisted and shown by " +
          "apex_callback_endpoint. Pass null to clear it. Precedence: runtime > config.",
        input: {
          type: "object",
          properties: {
            url: {
              type: ["string", "null"],
              description: "Public base URL of the server (e.g. https://x.trycloudflare.com) or null to clear",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            publicUrl: { type: ["string", "null"] },
            baseUrl: { type: ["string", "null"] },
          },
          additionalProperties: false,
        },
        execute: (rawInput: unknown) =>
          Effect.promise(async () => {
            const input = rawInput as { url?: string | null }
            const next = input.url === null || input.url === undefined || input.url === "" ? null : input.url
            await setRuntimePublicUrl(ctx, state, next)
            const current = endpoint()
            return { output: { publicUrl: current.publicUrl, baseUrl: current.baseUrl } }
          }),
      })
    })
  })
}

/** Tool: apex_subscribe — create a new event subscription */
function registerSubscribeTool(ctx: Plugin.Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "apex_subscribe",
      description: "Create an event subscription with filters. Captures sessionID from execution context.",
      input: {
        type: "object",
        properties: {
          filters: {
            type: "array",
            description: "Filter conditions to match events",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                operator: {
                  type: "string",
                  enum: ["equals", "contains", "matches", "gt", "lt", "in", "notIn", "exists", "notExists"],
                },
                value: {},
                pattern: { type: "string" },
              },
              required: ["field", "operator"],
              additionalProperties: false,
            },
          },
          agent: { type: "string", description: "Agent to switch the target session to before delivering (the switch persists)" },
          promptTemplate: { type: "string", description: "Inline prompt template with {{payload}}, {{payload.x}}, {{source}}, {{type}}, {{eventID}} placeholders" },
          promptTemplateFile: { type: "string", description: "Path to a prompt template file (takes priority over promptTemplate)" },
          deliverAs: { type: "string", enum: ["synthetic", "prompt"], description: "Deliver as synthetic message or user prompt (default prompt)" },
          resume: { type: "boolean", description: "Synthetic only: wake the agent loop so the model processes the message (default false = passive)" },
          delivery: { type: "string", enum: ["queue", "steer"], description: "Inbox delivery mode when deliverAs=prompt (default queue)" },
          priority: { type: "number", description: "Subscription priority" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      execute: (rawInput: unknown, toolCtx: { sessionID: string }) =>
        Effect.promise(async () => {
        const input = rawInput as {
          filters?: RuleCondition[]
          agent?: string
          promptTemplate?: string
          promptTemplateFile?: string
          deliverAs?: "synthetic" | "prompt"
          resume?: boolean
          delivery?: "queue" | "steer"
          priority?: number
        }
        const sessionID = toolCtx.sessionID
        if (!sessionID) {
          throw new Error("No sessionID available in tool context")
        }

        const subscriptions = await loadSubscriptions(ctx)
        const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

        const subscription: EventSubscription = {
          id,
          sessionID,
          agent: input.agent,
          filters: input.filters ?? [],
          promptTemplate: input.promptTemplate,
          promptTemplateFile: input.promptTemplateFile,
          deliverAs: input.deliverAs ?? DEFAULT_DELIVER_AS,
          resume: input.resume ?? DEFAULT_RESUME,
          delivery: input.delivery ?? DEFAULT_DELIVERY,
          priority: input.priority ?? DEFAULT_PRIORITY,
          enabled: true,
          readonly: false,
        }

        subscriptions.push(subscription)
        await saveSubscriptions(ctx, subscriptions)

        return { output: { id } }
        })
    })
  })
})
}

/** Tool: apex_unsubscribe — remove an event subscription */
function registerUnsubscribeTool(ctx: Plugin.Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "apex_unsubscribe",
        description: "Remove an event subscription by ID",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "Subscription ID to remove" } },
          required: ["id"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { success: { type: "boolean" } },
          required: ["success"],
        },
        execute: (rawInput: unknown) =>
          Effect.promise(async () => {
            const input = rawInput as { id: string }
            const subscriptions = await loadSubscriptions(ctx)
            const index = subscriptions.findIndex((s) => s.id === input.id)

            if (index === -1) {
              return { output: { success: false } }
            }

            // Prevent deletion of static subscriptions
            const sub = subscriptions[index]
            if (sub && sub.readonly) {
              throw new Error("Cannot unsubscribe from static subscription (readonly)")
            }

            subscriptions.splice(index, 1)
            await saveSubscriptions(ctx, subscriptions)

            return { output: { success: true } }
          }),
      })
    })
  })
}

/** Tool: apex_list_subscriptions — list all subscriptions (static marked readonly) */
function registerListSubscriptionsTool(
  ctx: Plugin.Context,
  staticSubscriptions: EventSubscription[],
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "apex_list_subscriptions",
        description: "List all event subscriptions. Static subscriptions from config are marked readonly.",
        input: { type: "object", properties: {}, additionalProperties: false },
        output: {
          type: "object",
          properties: {
            subscriptions: { type: "array", items: { type: "object" } },
          },
          required: ["subscriptions"],
        },
        execute: () =>
          Effect.promise(async () => {
            // Las de config (readonly: true) primero, igual que en la entrega.
            const subscriptions = [...staticSubscriptions, ...(await loadSubscriptions(ctx))]
            return { output: { subscriptions } }
          }),
      })
    })
  })
}

// ============================================================================
// RPC Handler: ingest
// ============================================================================

/** Handle ingest RPC call */
async function handleIngest(
  ctx: Plugin.Context,
  state: EventsState,
  input: IngestInput,
  staticSubscriptions: EventSubscription[],
  routing: "first" | "all",
): Promise<IngestOutput> {
  // Validate input
  if (!input?.source || typeof input.source !== "string") {
    throw new Error("Invalid input: 'source' is required and must be a string")
  }
  if (!input.payload || typeof input.payload !== "object") {
    throw new Error("Invalid input: 'payload' is required and must be an object")
  }

  // Generate or use provided eventID
  const eventID = input.eventID ?? generateEventID()

  // Deduplication check
  if (isDuplicate(state, eventID)) {
    // Idempotent: return previous result shape with empty delivered
    return { accepted: true, eventID, delivered: [] }
  }

  // Mark as seen
  state.dedup.set(eventID, Date.now())

  // Load dynamic subscriptions
  const dynamicSubscriptions = await loadSubscriptions(ctx)

  // Merge static + dynamic (static first, then dynamic)
  const allSubscriptions = [...staticSubscriptions, ...dynamicSubscriptions]

  // Create internal event
  const internalEvent: InternalEvent = {
    eventID,
    source: input.source,
    type: input.type,
    payload: input.payload,
    location: ctx.location?.directory ?? "unknown",
    timestamp: Date.now(),
  }

  // Emit on internal bus
  await emit("apex:event", internalEvent, "apex-events")

  // Process delivery using the routing policy captured from config in register()
  const delivered = await processDelivery(ctx, state, allSubscriptions, internalEvent, routing)

  return { accepted: true, eventID, delivered }
}

// ============================================================================
// Main Register Function
// ============================================================================

/** Create default events configuration */
export function createDefaultEventsConfig(): EventsConfig {
  return {
    routing: "all",
    subscriptions: [],
    server: {},
    tools: {
      enabled: true,
      allow: ["*"],
      deny: ["question", "subagent", "execute", "apex_*"],
      agent: "build",
      timeoutMs: 120000,
    },
  }
}

/** Register events module (Effect-native). Devuelve los handlers que publica el RPC. */
export function register(
  ctx: Plugin.Context,
  config: ApexConfig,
): Effect.Effect<EventsHandles, never, Scope.Scope> {
  return Effect.gen(function* () {
    // El gating del módulo lo hace index.ts con `modules.events`.
    const defaults = createDefaultEventsConfig()
    const configured = (config.events as unknown as Partial<EventsConfig>) ?? {}
    const eventsConfig: EventsConfig = {
      ...defaults,
      ...configured,
      server: { ...defaults.server, ...configured.server },
      tools: { ...defaults.tools, ...configured.tools },
    }
    const state = createEventsState()

    console.log("[Apex Events] Initializing RPC-based event system...")

    // Convert static subscriptions from config (add auto-generated IDs and readonly flag)
    const staticSubscriptions: EventSubscription[] = (eventsConfig.subscriptions ?? []).map(
      (sub, index) => ({
        ...sub,
        id: `static-${index}`,
        readonly: true,
        deliverAs: sub.deliverAs ?? DEFAULT_DELIVER_AS,
        resume: sub.resume ?? DEFAULT_RESUME,
        delivery: sub.delivery ?? DEFAULT_DELIVERY,
        priority: sub.priority ?? DEFAULT_PRIORITY,
        enabled: sub.enabled ?? true,
      }),
    )

    // Restaurar la URL pública fijada en runtime (túnel anunciado por el agente).
    const storedUrl = yield* Effect.promise(() =>
      Effect.runPromise(ctx.storage.get(PUBLIC_URL_STORAGE_KEY)).catch(() => undefined),
    )
    if (typeof storedUrl === "string" && storedUrl.length > 0) state.runtimePublicUrl = storedUrl

    // Restaurar la vinculación persistida (se valida que la sesión siga viva).
    const restored = yield* Effect.promise(async (): Promise<string | null> => {
      try {
        const stored = await Effect.runPromise(ctx.storage.get(AUTO_SESSION_STORAGE_KEY))
        if (typeof stored !== "string" || stored.length === 0) return null
        const info = (await Effect.runPromise(ctx.session.get({ sessionID: stored as never }))) as
          | { id?: string; parentID?: string | null; agent?: string | null }
          | undefined
        return info?.id && isPrimaryCandidate(info) ? stored : null
      } catch {
        return null
      }
    })
    if (restored) {
      state.autoBoundSessionID = restored
      console.log(`[Apex Events] sesión principal restaurada: ${restored}`)
    } else {
      yield* Effect.promise(() => setAutoBoundSession(ctx, state, null))
    }

    // Watcher de ciclo de vida: vincula/desvincula la sesión principal.
    //  - session.created (raíz, no advisor/runner) → vincula
    //  - session.deleted de la vinculada            → desvincula (auto-desuscripción)
    yield* ctx.event.subscribe().pipe(
      Stream.tap((event) =>
        Effect.promise(() =>
          handleLifecycleEvent(ctx, state, event as { type: string; data: unknown; location?: { directory?: string } }),
        ),
      ),
      Stream.runDrain,
      Effect.forkScoped,
    )

    // Register tools
    yield* registerSubscribeTool(ctx)
    yield* registerUnsubscribeTool(ctx)
    yield* registerListSubscriptionsTool(ctx, staticSubscriptions)

    // Dirección del servidor: se resuelve en cada consulta (el servicio puede haber
    // reescrito su registro tras un reinicio).
    const endpoint = (): ServerEndpoint =>
      resolveServerEndpoint({
        directory: ctx.location.directory,
        configUrl: eventsConfig.server.url,
        publicUrl: state.runtimePublicUrl ?? eventsConfig.server.publicUrl ?? null,
      })
    yield* registerCallbackEndpointTool(ctx, endpoint)
    yield* registerSetCallbackUrlTool(ctx, state, endpoint)

    // tools.run: agente oculto de la sesión runner + ejecutor de este directorio.
    yield* ensureRunnerAgent(ctx)
    const toolsRun = makeToolsRunner(ctx, eventsConfig.tools)

    // Subscribe to internal bus for any apex:event (optional, for logging/debugging)
    const busSubscription = subscribe("apex:event", (event) => {
      console.debug(`[Apex Events] Bus event: ${event.type}`, event.payload)
    })

    const current = endpoint()
    console.log(
      `[Apex Events] Event system initialized · RPC ${current.baseUrl ?? "(server URL unknown)"} · ` +
        `tools.run ${eventsConfig.tools.enabled ? `on (agente ${eventsConfig.tools.agent})` : "off"}`,
    )

    // Finalizer: cleanup when the plugin scope closes
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        console.log("[Apex Events] Cleaning up...")
        busSubscription.unsubscribe()
        state.dedup.clear()
        // La vinculación persistida se conserva para la próxima carga
        console.log("[Apex Events] Cleanup complete")
      }),
    )

    return {
      ingest: (input: IngestInput) => handleIngest(ctx, state, input, staticSubscriptions, eventsConfig.routing),
      endpoint,
      toolsRun,
    } satisfies EventsHandles
  })
}
