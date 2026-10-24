/**
 * Apex Advisor — decisiones de permiso mediante una sesión advisor dedicada.
 *
 * Arquitectura:
 *   - El plugin define (upsert) el agente oculto `apex-advisor`, con su propio
 *     `model` (barato/rápido) y un ruleset que le permite SOLO la herramienta
 *     de decisión.
 *   - Existe UNA sesión advisor por ÁRBOL de sesiones: la raíz (sesión
 *     agente-usuario) y todos sus subagentes comparten la misma sesión advisor.
 *   - Ante cada tool call se pide decisión al advisor; el agente responde
 *     llamando a `apex_advisor_decide` con allow o deny+reason.
 *   - La sesión advisor queda registrada entera → auditoría completa.
 *
 * Vocabulario: aprobar = "allow"; denegar = "deny" + reason. No hay "consejo":
 * si `decisive` es false, la decisión simplemente no se aplica al permiso.
 */

import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { homedir } from "node:os"
import { ADVISOR_AGENT_ID, ensureAdvisorAgent } from "./core/advisor-agent.js"
import { readOrCreateTemplate } from "./core/templates.js"
import { registerAdvisorTool } from "./core/advisor-tool.js"
import {
  DEFAULT_ADVISOR_REQUEST_TEMPLATE,
  isAdvisorSession,
  requestAdvisorDecision,
} from "./core/advisor-session.js"

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export interface AdvisorConfig {
  /** Enable advisor module */
  enabled: boolean
  /** true = la decisión del advisor se aplica al permiso; false = solo se informa */
  decisive: boolean
  /**
   * Modelo del agente advisor, formato "providerID/modelID". Recomendado uno
   * rápido y barato: el advisor corre en su propia sesión con contexto completo.
   */
  model?: string
  /** System prompt del agente advisor (por defecto el protocolo allow/deny) */
  system?: string
  /** Plantilla de la PETICIÓN al advisor ({{requestID}}, {{action}}, {{resources}}, …) */
  promptTemplate?: string
  /** Fichero con la plantilla (relativo al proyecto o `~/home`; tiene prioridad).
   *  Si no existe se crea con la plantilla por defecto. */
  promptTemplateFile?: string
  /** Timeout de espera de la decisión (ms). Al agotarse no se altera el permiso. */
  timeoutMs?: number
  /** "ask-only" (default): solo cuando el efecto es "ask" · "all": en cada tool call */
  evaluate?: "ask-only" | "all"
  /** Filtro de acciones (nombres de tool). Vacío/ausente = todas. */
  actions?: string[]
  /**
   * Directorio de la sesión advisor. Por defecto uno dedicado fuera del
   * proyecto, para que NO se le inyecte el AGENTS.md del repo (la discovery de
   * instrucciones es por location). Fuera de $HOME evita también la cadena de
   * ancestros del home; el AGENTS.md global de ~/.config/opencode sigue aplicando.
   */
  location?: string
}

// ---------------------------------------------------------------------------
// Estado persistido (caché de veredictos + auditoría)
// ---------------------------------------------------------------------------

interface CacheEntry {
  verdict: "allow" | "deny"
  reason: string
  timestamp: number
}

interface AuditEntry {
  timestamp: number
  action: string
  resources: readonly string[]
  verdict: "allow" | "deny" | "ask"
  reason: string
  latencyMs: number
}

const ADVISOR_CACHE_KEY = "apex:advisor:cache"
const ADVISOR_AUDIT_KEY = "apex:auditlog"
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_AUDIT_ENTRIES = 100
const DEFAULT_TIMEOUT_MS = 10_000

/** Evento del hook de permisos (forma real del hook `permission.evaluate`). */
interface PermissionEvaluationEvent {
  sessionID: string
  agent?: string
  action: string
  resources: readonly string[]
  metadata?: Record<string, unknown>
  source?: unknown
  effect: "allow" | "deny" | "ask"
  message?: string
}

function generateCacheKey(action: string, resources: readonly string[]): string {
  const sorted = [...resources].sort()
  const input = action + JSON.stringify(sorted)
  return createHash("sha256").update(input).digest("hex").slice(0, 32)
}

async function loadCache(storage: Plugin.Context["storage"]): Promise<Map<string, CacheEntry>> {
  const stored = await Effect.runPromise(storage.get(ADVISOR_CACHE_KEY))
  if (!stored) return new Map()
  try {
    return new Map(JSON.parse(stored as string) as [string, CacheEntry][])
  } catch {
    return new Map()
  }
}

async function saveCache(storage: Plugin.Context["storage"], cache: Map<string, CacheEntry>): Promise<void> {
  await Effect.runPromise(storage.set(ADVISOR_CACHE_KEY, JSON.stringify(Array.from(cache.entries())) as never))
}

async function loadAuditLog(storage: Plugin.Context["storage"]): Promise<AuditEntry[]> {
  const stored = await Effect.runPromise(storage.get(ADVISOR_AUDIT_KEY))
  if (!stored) return []
  try {
    return JSON.parse(stored as string) as AuditEntry[]
  } catch {
    return []
  }
}

async function saveAuditLog(storage: Plugin.Context["storage"], log: AuditEntry[]): Promise<void> {
  await Effect.runPromise(storage.set(ADVISOR_AUDIT_KEY, JSON.stringify(log) as never))
}

async function addAuditEntry(
  storage: Plugin.Context["storage"],
  entry: Omit<AuditEntry, "timestamp">,
): Promise<void> {
  const log = await loadAuditLog(storage)
  log.push({ ...entry, timestamp: Date.now() })
  if (log.length > MAX_AUDIT_ENTRIES) log.splice(0, log.length - MAX_AUDIT_ENTRIES)
  await saveAuditLog(storage, log)
}

// ---------------------------------------------------------------------------
// Registro del módulo
// ---------------------------------------------------------------------------

export function register(
  ctx: Plugin.Context,
  config: AdvisorConfig,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (!config.enabled) return

    const decisive = config.decisive ?? false
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Plantilla: fichero (relativo, con creación por defecto) > inline > default
    const templateFile = readOrCreateTemplate(
      config.promptTemplateFile,
      { projectDir: ctx.location?.directory ?? process.cwd(), home: homedir() },
      config.promptTemplate ?? DEFAULT_ADVISOR_REQUEST_TEMPLATE,
    )
    const template = templateFile.content ?? config.promptTemplate ?? DEFAULT_ADVISOR_REQUEST_TEMPLATE
    const evaluateAll = config.evaluate === "all"
    const actionFilter = new Set(config.actions ?? [])

    // 1. Agente advisor dedicado (upsert)
    yield* ensureAdvisorAgent(ctx, { model: config.model, system: config.system, decisive })

    // 2. Única herramienta del advisor
    yield* registerAdvisorTool(ctx)

    // 3. Caché de veredictos
    const cache = yield* Effect.promise(() => loadCache(ctx.storage))

    // 4. Hook de permisos → sesión advisor
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.promise(async () => {
        const e = event as unknown as PermissionEvaluationEvent

        // Guardas: nunca evaluar la propia sesión advisor (por id de sesión o por
        // agente — robusto ante recargas, cuando el registro de sesiones se pierde);
        // filtro de acciones; por defecto solo cuando el usuario no resolvió ("ask").
        if (isAdvisorSession(e.sessionID)) return
        if (e.agent === ADVISOR_AGENT_ID) return
        if (actionFilter.size > 0 && !actionFilter.has(e.action)) return
        if (!evaluateAll && e.effect !== "ask") return

        const startedAt = Date.now()
        const cacheKey = generateCacheKey(e.action, e.resources)

        // Camino rápido: veredicto cacheado
        const cached = cache.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
          applyDecision(e, cached.verdict, cached.reason, decisive)
          await addAuditEntry(ctx.storage, {
            action: e.action,
            resources: e.resources,
            verdict: cached.verdict,
            reason: `${cached.reason} (cached)`,
            latencyMs: Date.now() - startedAt,
          })
          return
        }

        // Consultar a la sesión advisor del árbol
        const decision = await requestAdvisorDecision(ctx, {
          sessionID: e.sessionID,
          action: e.action,
          resources: e.resources,
          agent: e.agent,
          metadata: e.metadata,
          decisive,
          timeoutMs,
          template,
          location: config.location,
        })

        if (!decision) {
          // Degradación: sin decisión no se altera el permiso original.
          console.warn(`[apex.advisor] sin decisión para "${e.action}"; se mantiene el efecto original`)
          await addAuditEntry(ctx.storage, {
            action: e.action,
            resources: e.resources,
            verdict: "ask",
            reason: "sin decisión del advisor (timeout/error)",
            latencyMs: Date.now() - startedAt,
          })
          return
        }

        applyDecision(e, decision.decision, decision.reason ?? "", decisive)

        cache.set(cacheKey, {
          verdict: decision.decision,
          reason: decision.reason ?? "",
          timestamp: Date.now(),
        })
        await saveCache(ctx.storage, cache)

        await addAuditEntry(ctx.storage, {
          action: e.action,
          resources: e.resources,
          verdict: decision.decision,
          reason: decision.reason ?? "",
          latencyMs: Date.now() - startedAt,
        })
      }),
    )
  })
}

/**
 * Aplica la decisión al evento de permiso.
 *  - decisive=true  → allow/deny sustituyen el efecto (deny deja el motivo).
 *  - decisive=false → no se toca el efecto; la decisión se anota en el mensaje.
 */
function applyDecision(
  event: PermissionEvaluationEvent,
  decision: "allow" | "deny",
  reason: string,
  decisive: boolean,
): void {
  if (decisive) {
    event.effect = decision
    if (decision === "deny") {
      event.message = reason.length > 0 ? reason : "denegado por apex.advisor"
    }
    return
  }

  const note = `⚖ apex.advisor: ${decision}${reason ? ` — ${reason}` : ""}`
  event.message = event.message ? `${event.message}\n${note}` : note
}

export function createDefaultAdvisorConfig(): AdvisorConfig {
  return {
    enabled: true,
    decisive: false,
    evaluate: "ask-only",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    actions: [],
    promptTemplate: DEFAULT_ADVISOR_REQUEST_TEMPLATE,
  }
}
