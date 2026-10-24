/**
 * Apex Advisor — sesión lateral de advisor (una por ÁRBOL de sesiones).
 *
 * Jerarquía: una sesión agente-usuario (raíz) puede invocar subagentes
 * (sesiones agente-agente, con `parentID`). TODAS ellas comparten UNA sola
 * sesión advisor: se resuelve la raíz subiendo por `parentID` y se mapea
 * raíz → sesión advisor.
 *
 * Round-trip: se encola una decisión pendiente (promesa en memoria), se hace
 * `session.prompt` a la sesión advisor y el agente advisor responde llamando a
 * la herramienta `apex_advisor_decide`, que resuelve la promesa.
 *
 * La sesión advisor queda registrada entera → auditoría de cada allow/deny.
 */

import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, normalize } from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { ADVISOR_AGENT_ID } from "./advisor-agent.js"

export interface AdvisorDecision {
  readonly decision: "allow" | "deny"
  readonly reason?: string
}

export interface AdvisorRequest {
  /** Sesión que solicita la ejecución (puede ser un subagente). */
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly agent?: string
  readonly metadata?: Record<string, unknown>
  /** true = la decisión se aplica; false = solo se informa al usuario. */
  readonly decisive: boolean
  readonly timeoutMs: number
  readonly template: string
  /** Directorio de la sesión advisor (aislado del proyecto por defecto). */
  readonly location?: string
}

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------

/**
 * Estado compartido por PROCESO, no por grafo de módulos.
 *
 * La sesión advisor vive en su propio location (`/tmp/opencode-apex-advisor`, para
 * no heredar el AGENTS.md del repo) y opencode instancia el plugin **una vez por
 * location**: en el log salen dos «[apex] config:», uno por el proyecto y otro por
 * el directorio del advisor. Con el estado en ámbito de módulo, la instancia que
 * registraba la petición y la que ejecutaba `apex_advisor_decide` eran distintas,
 * cada una con su `pending` vacío — la decisión llegaba con `accepted: false` («la
 * solicitud ya no estaba pendiente») y el permiso caducaba por plazo agotado,
 * medido incluso con el advisor respondiendo en 9 s sobre un plazo de 45 s.
 *
 * `Symbol.for` es el único ámbito que coincide con el del recurso: el proceso.
 * La clave lleva versión para que un cambio de forma no choque con una celda vieja.
 */
interface AdvisorCell {
  /** clave "rootID|location" → advisor sessionID (caché) */
  readonly sessionCache: Map<string, string>
  /** advisor sessionIDs conocidas (guardas anti-recursión) */
  readonly advisorSessions: Set<string>
  /** requestID → resolver de la promesa pendiente */
  readonly pending: Map<string, (decision: AdvisorDecision) => void>
}

const CELL_KEY = Symbol.for("apex.advisor.state.v1")

function cell(): AdvisorCell {
  const holder = globalThis as Record<symbol, AdvisorCell | undefined>
  const existing = holder[CELL_KEY]
  if (existing) return existing
  const created: AdvisorCell = {
    sessionCache: new Map(),
    advisorSessions: new Set(),
    pending: new Map(),
  }
  holder[CELL_KEY] = created
  return created
}

const sessionCache = cell().sessionCache
const advisorSessions = cell().advisorSessions
const pending = cell().pending

const STORAGE_KEY = (rootID: string) => `apex:advisor:session:${rootID}`
const MAX_DEPTH = 25

/**
 * Location por defecto de la sesión advisor: un directorio dedicado FUERA del
 * proyecto. La discovery de instrucciones es por location y solo camina el
 * árbol cuando la sesión está dentro del root del proyecto, así que aquí NO se
 * inyecta el AGENTS.md del repo.
 */
export const DEFAULT_ADVISOR_LOCATION = join(tmpdir(), "opencode-apex-advisor")

/** Guarda: ¿esta sesión es una sesión advisor? (nunca se evalúa a sí misma) */
export function isAdvisorSession(sessionID: string): boolean {
  return advisorSessions.has(sessionID)
}

/** Llamado por la herramienta del advisor para resolver una decisión pendiente. */
export function resolvePendingDecision(requestID: string, decision: "allow" | "deny", reason?: string): boolean {
  const resolver = pending.get(requestID)
  if (!resolver) return false
  pending.delete(requestID)
  resolver({ decision, reason })
  return true
}

/** Nº de peticiones pendientes (diagnóstico/tests). */
export function pendingCount(): number {
  return pending.size
}

// ---------------------------------------------------------------------------
// Jerarquía de sesiones
// ---------------------------------------------------------------------------

/** Sube por `parentID` hasta la raíz (sesión agente-usuario). */
export async function resolveRootSessionID(
  ctx: Plugin.Context,
  sessionID: string,
): Promise<string> {
  let current = sessionID
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let info: { parentID?: string } | undefined
    try {
      info = (await Effect.runPromise(ctx.session.get({ sessionID: current as never }))) as { parentID?: string }
    } catch {
      return current
    }
    const parent = info?.parentID
    if (!parent) return current
    current = parent
  }
  return current
}

/** Obtiene (o crea) la ÚNICA sesión advisor del árbol. */
export async function getOrCreateAdvisorSession(
  ctx: Plugin.Context,
  rootID: string,
  location?: string,
): Promise<string> {
  // Directorio aislado: sin AGENTS.md del proyecto (y fuera de $HOME para no
  // caminar la cadena de ancestros del home). Las rutas relativas se resuelven
  // contra el cwd del proceso del servidor.
  const rawDir = location && location.trim().length > 0 ? location.trim() : DEFAULT_ADVISOR_LOCATION
  const directory = isAbsolute(rawDir) ? normalize(rawDir) : join(process.cwd(), rawDir)
  const cacheKey = `${rootID}|${directory}`

  const cached = sessionCache.get(cacheKey)
  if (cached) return cached

  // Persistida entre recargas (se valida que siga existiendo, que el agente sea
  // el advisor y que la location coincida; si no, se recrea).
  try {
    const stored = await Effect.runPromise(ctx.storage.get(STORAGE_KEY(rootID)))
    if (typeof stored === "string" && stored.length > 0) {
      const info = (await Effect.runPromise(ctx.session.get({ sessionID: stored as never }))) as
        | { id?: string; agent?: string; metadata?: Record<string, unknown> }
        | undefined
      const storedLocation = info?.metadata?.apexAdvisorLocation
      if (
        info?.id &&
        info.agent === ADVISOR_AGENT_ID &&
        (storedLocation === undefined || storedLocation === directory)
      ) {
        sessionCache.set(cacheKey, stored)
        advisorSessions.add(stored)
        return stored
      }
    }
  } catch {
    // sin sesión persistida válida → se crea
  }

  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    // si no se puede crear, se intenta crear la sesión igualmente
  }

  const created = (await Effect.runPromise(
    ctx.session.create({
      agent: ADVISOR_AGENT_ID as never,
      title: "apex advisor",
      metadata: { apexAdvisorFor: rootID, apexAdvisorLocation: directory } as never,
      location: { directory } as never,
    } as never),
  )) as { id: string }

  const advisorID = created.id
  sessionCache.set(cacheKey, advisorID)
  advisorSessions.add(advisorID)
  await Effect.runPromise(ctx.storage.set(STORAGE_KEY(rootID), advisorID as never))
  return advisorID
}

// ---------------------------------------------------------------------------
// Round-trip de decisión
// ---------------------------------------------------------------------------

/** Renderiza la petición para el advisor (placeholders de la plantilla). */
export function renderAdvisorRequest(template: string, input: AdvisorRequest, requestID: string): string {
  const enforcement = input.decisive
    ? "Tu decisión se APLICA automáticamente."
    : "Tu decisión se muestra al usuario, que decide."

  return template
    .replace(/\{\{requestID\}\}/g, requestID)
    .replace(/\{\{action\}\}/g, input.action)
    .replace(/\{\{resources\}\}/g, input.resources.join(", ") || "(ninguno)")
    .replace(/\{\{sessionID\}\}/g, input.sessionID)
    .replace(/\{\{agent\}\}/g, input.agent ?? "default")
    .replace(/\{\{enforcement\}\}/g, enforcement)
    .replace(/\{\{metadata\.([^}]+)\}\}/g, (_m, path: string) => {
      const value = path
        .split(".")
        .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], input.metadata)
      if (value === undefined || value === null) return ""
      return typeof value === "string" ? value : JSON.stringify(value)
    })
}

/** Plantilla por defecto de la petición al advisor. */
export const DEFAULT_ADVISOR_REQUEST_TEMPLATE = `Solicitud de permiso {{requestID}}
Herramienta: {{action}}
Recursos: {{resources}}
Sesión solicitante: {{sessionID}} · Agente: {{agent}}
{{enforcement}}

Decidí con \`apex_advisor_decide\` (requestID={{requestID}}). Si denegás, incluí un motivo.`

/**
 * Pide una decisión al advisor del árbol.
 * Devuelve null si: la sesión solicitante es la del advisor, no hay sesión
 * advisor disponible, o se agota el timeout.
 */
export async function requestAdvisorDecision(
  ctx: Plugin.Context,
  input: AdvisorRequest,
): Promise<AdvisorDecision | null> {
  if (isAdvisorSession(input.sessionID)) return null

  const rootID = await resolveRootSessionID(ctx, input.sessionID)
  const advisorSessionID = await getOrCreateAdvisorSession(ctx, rootID, input.location)

  // requestID impredecible: la tool de decisión es visible para todos los
  // agentes del servidor, así que el identificador no debe ser adivinable
  // (un requestID predecible permitiría a otro agente resolver decisiones ajenas).
  const requestID = `req_${randomUUID()}`

  const decisionPromise = new Promise<AdvisorDecision>((resolve) => {
    pending.set(requestID, resolve)
  })

  const text = renderAdvisorRequest(input.template, input, requestID)

  try {
    // Enviar la petición al advisor (steer: se incorpora al turno en curso;
    // resume: despierta la sesión si está ociosa).
    await Effect.runPromise(
      ctx.session.prompt({
        sessionID: advisorSessionID as never,
        text,
        delivery: "steer",
        resume: true,
      } as never),
    )
  } catch (error) {
    pending.delete(requestID)
    console.warn(`[apex.advisor] no se pudo enviar la petición al advisor: ${String(error)}`)
    return null
  }

  // Esperar la decisión con timeout (sin bloquear indefinidamente la tool).
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), input.timeoutMs))
  const decision = await Promise.race([decisionPromise, timeout])

  if (decision === null) {
    pending.delete(requestID)
    console.warn(`[apex.advisor] timeout esperando decisión para ${input.action} (${input.timeoutMs}ms)`)
  }
  return decision
}
