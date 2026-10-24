/**
 * opencode-apex — Configuración central con validación Zod, resolución de variables de entorno
 * y patrón last-good para fallback seguro.
 */
import { z } from "zod"
import type { GuardConfigShape } from "./guard.js"
import { DEFAULT_BUNDLES } from "./patterns.js"
import { readFile } from "fs/promises"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { join } from "node:path"

// ============================================================================
// Tipos de configuración
// ============================================================================

export interface RedactConfig {
  mode: "strict" | "warn"
  /** Fuentes regex propias (se suman a los bundles) */
  patterns: string[]
  /** Bundles de patrones por nombre */
  bundles: string[]
  /** Confianza mínima para activar un patrón: low | medium | high */
  minConfidence: "low" | "medium" | "high"
  /** Regex de cadenas que nunca se redactan */
  allowlist: string[]
  /** Prefijo del marcador */
  prefix: string
  /** Sufijo del marcador */
  suffix: string
  /** Material de clave: literal | env:VAR | file:/ruta | hex:... | base64:... */
  key: string
  /** Salidas que se restauran (solo la entrada de tool por ahora) */
  restore: {
    toolInput: boolean
  }
}

export interface RuleCondition {
  field: string
  operator: "equals" | "contains" | "matches" | "gt" | "lt" | "in" | "notIn" | "exists" | "notExists"
  value?: unknown
  pattern?: string
}

export interface EventSubscription {
  id: string
  /** Sesión destino. Vacío/null/ausente → se vincula automáticamente a la
   *  sesión principal activa (la raíz creada al abrir opencode). */
  sessionID?: string | null
  agent?: string
  filters: RuleCondition[]
  promptTemplate?: string
  /** Fichero de plantilla (relativo al proyecto o `~/home`); prioridad sobre promptTemplate */
  promptTemplateFile?: string
  /** "prompt" (user prompt) | "synthetic" (mensaje sintético) */
  deliverAs?: "synthetic" | "prompt"
  /** Solo synthetic: despierta el bucle del agente (default false) */
  resume?: boolean
  delivery: "queue" | "steer"
  priority: number
  enabled: boolean
  readonly?: boolean
}

export interface EventsConfig {
  /** El toggle del módulo vive SOLO en `modules.events`. */
  routing: "first" | "all"
  subscriptions: Omit<EventSubscription, "id" | "readonly">[]
  /** Dónde alcanzan los procesos externos al servidor (lo descubre solo si no se fija). */
  server: EventsServerConfig
  /** RPC `apex/tools.run`: ejecutar herramientas de OpenCode desde fuera. */
  tools: EventsToolsConfig
}

export interface EventsServerConfig {
  /** URL base del servidor tal como la alcanzan los scripts locales. Vacío = descubrir. */
  url?: string
  /**
   * URL pública por DEFECTO (túnel o proxy inverso hacia el servidor) para emisores
   * de otras máquinas. El agente puede fijarla en runtime con `apex_set_callback_url`
   * (precedencia: runtime > esta config).
   */
  publicUrl?: string
}

export interface EventsToolsConfig {
  enabled: boolean
  /** Globs de herramientas ejecutables por RPC. */
  allow: string[]
  /** Globs denegados aunque casen con `allow` (gana deny). */
  deny: string[]
  /** Agente cuyos permisos se aplican por defecto. */
  agent: string
  timeoutMs: number
}

export interface AdvisorConfig {
  model?: string
  actions: string[]
  decisive: boolean
}

export interface ApexConfig {
  redact: RedactConfig
  events: EventsConfig
  advisor: AdvisorConfig
  guard: GuardConfigShape
  browser: z.infer<typeof browserConfigSchema>
  modules: Record<string, boolean>
}

// ============================================================================
// Esquema Zod (Standard Schema compatible)
// ============================================================================

const redactConfigSchema = z.object({
  mode: z.enum(["strict", "warn"]).default("strict"),
  patterns: z.array(z.string()).default(() => []),
  bundles: z.array(z.string()).default(() => [...DEFAULT_BUNDLES]),
  minConfidence: z.enum(["low", "medium", "high"]).default("medium"),
  allowlist: z.array(z.string()).default(() => []),
  prefix: z.string().default("[SECRET:"),
  suffix: z.string().default("]"),
  key: z.string().default(""),
  restore: z
    .object({
      toolInput: z.boolean().default(true),
    })
    .default(() => ({ toolInput: true })),
})

const ruleConditionSchema = z.object({
  field: z.string(),
  operator: z.enum(["equals", "contains", "matches", "gt", "lt", "in", "notIn", "exists", "notExists"]),
  value: z.unknown().optional(),
  pattern: z.string().optional(),
})

const eventSubscriptionSchema = z.object({
  // Vacío/null → auto-vinculación a la sesión principal activa.
  sessionID: z.string().nullable().optional(),
  agent: z.string().optional(),
  filters: z.array(ruleConditionSchema).default([]),
  promptTemplate: z.string().optional(),
  promptTemplateFile: z.string().optional(),
  deliverAs: z.enum(["synthetic", "prompt"]).default("prompt"),
  resume: z.boolean().default(false),
  delivery: z.enum(["queue", "steer"]).default("queue"),
  priority: z.number().default(0),
  enabled: z.boolean().default(true),
})

const eventsServerSchema = z.object({
  url: z.string().optional(),
  publicUrl: z.string().optional(),
})

const DEFAULT_EVENTS_TOOLS = {
  enabled: true,
  allow: ["*"],
  // Sin nadie delante: `question` esperaría para siempre; `subagent`/`execute`
  // lanzarían un modelo; las de apex no tienen sentido desde fuera.
  deny: ["question", "subagent", "execute", "apex_*"],
  agent: "build",
  timeoutMs: 120000,
}

const eventsToolsSchema = z.object({
  enabled: z.boolean().default(DEFAULT_EVENTS_TOOLS.enabled),
  allow: z.array(z.string()).default(() => [...DEFAULT_EVENTS_TOOLS.allow]),
  deny: z.array(z.string()).default(() => [...DEFAULT_EVENTS_TOOLS.deny]),
  agent: z.string().default(DEFAULT_EVENTS_TOOLS.agent),
  timeoutMs: z.number().int().positive().default(DEFAULT_EVENTS_TOOLS.timeoutMs),
})

const defaultEventsTools = () => ({
  ...DEFAULT_EVENTS_TOOLS,
  allow: [...DEFAULT_EVENTS_TOOLS.allow],
  deny: [...DEFAULT_EVENTS_TOOLS.deny],
})

const eventsConfigSchema = z.object({
  // El toggle del módulo vive SOLO en `modules.events` (evita duplicidad).
  routing: z.enum(["first", "all"]).default("all"),
  subscriptions: z.array(eventSubscriptionSchema).default([]),
  server: eventsServerSchema.default(() => ({})),
  tools: eventsToolsSchema.default(defaultEventsTools),
})

const advisorConfigSchema = z.object({
  model: z.string().optional(),
  system: z.string().optional(),
  promptTemplate: z.string().optional(),
  promptTemplateFile: z.string().optional(),
  actions: z.array(z.string()).default(() => []),
  decisive: z.boolean().default(false),
  evaluate: z.enum(["ask-only", "all"]).default("ask-only"),
  timeoutMs: z.number().int().positive().default(10000),
  location: z.string().optional(),
})

const guardRuleSchema = z.object({
  action: z.string(),
  resource: z.string().optional(),
  effect: z.enum(["allow", "deny", "ask"]),
  reason: z.string().optional(),
})

const guardConfigSchema = z.object({
  // Arranca en "report": un guard que empieza denegando rompe la sesión antes
  // de que nadie haya visto una regla en acción.
  mode: z.enum(["enforce", "report"]).default("report"),
  // "keep" = no tocar lo que decidió el host. Ver GuardFallback.
  fallback: z.enum(["allow", "deny", "ask", "keep"]).default("keep"),
  keep: z.number().int().positive().default(500),
  agents: z.record(z.string(), z.array(guardRuleSchema)).default(() => ({})),
})

const browserConfigSchema = z.object({
  // in-app: no hacemos attach, sirve la app Electron (y soltamos el que haya).
  // external y auto: engancha el Chromium externo, pero solo cuando alguien lo
  // pide (browser.target o /browser-target), nunca en cada tool call.
  mode: z.enum(["in-app", "external", "auto"]).default("auto"),
  // "auto" = deducir del DevToolsActivePort. Un path explícito lo fuerza.
  cdpUrl: z.string().default("auto"),
  profile: z.string().default(""),
  connectTimeoutMs: z.number().int().positive().default(90000),
  // Segundos entre reintentos al conectar. El modo toggle de Chrome exige
  // aprobar un popup POR CONEXIÓN, así que no conviene reintentar rápido.
  reconnectSeconds: z.number().int().nonnegative().default(15),
  // Cabeceras y CA para un wss:// remoto detrás de un proxy inverso.
  headers: z.record(z.string(), z.string()).default(() => ({})),
  caFile: z.string().default(""),
  insecureSkipVerify: z.boolean().default(false),
})

export const apexConfigSchema = z.object({
  redact: redactConfigSchema.default(() => ({ mode: "strict" as const, patterns: [], bundles: [...DEFAULT_BUNDLES], minConfidence: "medium" as const, allowlist: [], prefix: "[SECRET:", suffix: "]", key: "", restore: { toolInput: true } })),
  events: eventsConfigSchema.default(() => ({ routing: "all" as const, subscriptions: [], server: {}, tools: defaultEventsTools() })),
  advisor: advisorConfigSchema.default(() => ({ actions: [], decisive: false, evaluate: "ask-only" as const, timeoutMs: 10000 })),
  guard: guardConfigSchema.default(() => ({
    mode: "report" as const,
    fallback: "keep" as const,
    keep: 500,
    agents: {},
  })),
  browser: browserConfigSchema.default(() => ({
    mode: "auto" as const,
    cdpUrl: "auto",
    profile: "",
    connectTimeoutMs: 90000,
    reconnectSeconds: 15,
    headers: {},
    caFile: "",
    insecureSkipVerify: false,
  })),
  modules: z
    .object({
      redact: z.boolean().optional(),
      events: z.boolean().optional(),
      advisor: z.boolean().optional(),
      guard: z.boolean().optional(),
      // Activado por defecto; en modo external puede abrir un popup de Chrome.
      browser: z.boolean().optional(),
    })
    .default(() => ({})),
})

const ENV_VAR_REGEX = /\$\{([^}:]+)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

/** Sustituye ${VAR} / ${VAR:-default} / $VAR por su valor de entorno. */
function resolveValue(value: string): string {
  return value.replace(ENV_VAR_REGEX, (_match, braceVar, defaultValue, simpleVar) => {
    const varName = braceVar ?? simpleVar
    const envValue = process.env[varName]

    if (envValue !== undefined) return envValue
    if (braceVar && defaultValue !== undefined) return defaultValue
    if (braceVar) throw new Error(`Variable de entorno requerida no encontrada: ${varName}`)
    return _match // $VAR sin valor y sin default -> mantener original
  })
}

function resolveEnvInObject(obj: unknown): unknown {
  if (typeof obj === "string") return resolveValue(obj)
  if (Array.isArray(obj)) return obj.map(resolveEnvInObject)
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvInObject(value)
    }
    return result
  }
  return obj
}

export function resolveEnvVariables(config: ApexConfig): ApexConfig {
  return resolveEnvInObject(config) as ApexConfig
}

// ============================================================================
// Carga y validación de configuración
// ============================================================================

// ============================================================================
// Parseo: comentarios #, // y /* */
// ============================================================================

/**
 * Elimina comentarios de línea con `#` respetando las cadenas Y los otros
 * comentarios: un `#` dentro de una cadena o de un bloque `/* ... *​/` NO es
 * un comentario (rompería el parseo sí se cortara ahí).
 * `//` y `/* *​/` los cubre jsonc-parser.
 */
export function stripHashComments(text: string): string {
  let out = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let quote = ""
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = i + 1 < text.length ? text[i + 1] : ""

    if (inString) {
      out += ch
      if (escaped) { escaped = false; continue }
      if (ch === "\\") { escaped = true; continue }
      if (ch === quote) inString = false
      continue
    }

    if (inLineComment) {
      if (ch === "\n") { inLineComment = false; out += ch }
      continue
    }

    if (inBlockComment) {
      out += ch
      if (ch === "*" && next === "/") { inBlockComment = false; i++; out += "/" }
      continue
    }

    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue }
    if (ch === "/" && next === "/") { inLineComment = true; i++; out += "//"; continue }
    if (ch === "/" && next === "*") { inBlockComment = true; i++; out += "/*"; continue }
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    out += ch
  }
  return out
}

/** Parsea un texto de configuración (JSONC + comentarios `#`). */
export function parseConfigText(text: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const source = stripHashComments(text)
  const parsed = parseJsonc(source, errors, { disallowComments: false, allowTrailingComma: true })
  // jsonc-parser recupera lo que puede: sin este aviso, una coma o una comilla de más
  // dejaba claves fuera de la config sin decir nada.
  if (errors.length > 0) {
    const where = errors
      .slice(0, 3)
      .map((e) => `${printParseErrorCode(e.error)} @ line ${source.slice(0, e.offset).split("\n").length}`)
      .join(", ")
    console.warn(`[apex] config syntax errors in ${path} (${where}): the affected keys may be missing`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Configuración inválida en ${path}: se esperaba un objeto`)
  }
  return parsed as Record<string, unknown>
}

// ============================================================================
// Merge profundo y jerarquía de fuentes
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Merge profundo: los objetos se combinan, los arrays se SUSTITUYEN y
 * `undefined` no pisa. (Los arrays se reemplazan para que una lista de
 * bundles/patrones se pueda sobrescribir por completo desde la config local.)
 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) {
      out[key] = key in out ? deepMerge(out[key], value) : value
    }
    return out as T
  }
  return override as T
}

/** Rutas de los ficheros de configuración de apex. */
export function apexConfigPaths(input: {
  projectDir: string
  home: string
  configDir?: string
}): { global: string; local: string } {
  const base = input.configDir ?? process.env.XDG_CONFIG_HOME ?? join(input.home, ".config")
  return {
    // Global: junto a la config global de opencode.
    global: join(base, "opencode", "opencode-apex.jsonc"),
    // Local: dentro de .opencode/ del proyecto (convención de opencode).
    local: join(input.projectDir, ".opencode", "opencode-apex.jsonc"),
  }
}

/** Lee una fuente de configuración. Ausente → {}. Sintaxis inválida → throw. */
async function loadConfigSource(path: string): Promise<Record<string, unknown>> {
  let content: string
  try {
    content = await readFile(path, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  return parseConfigText(content, path)
}

export interface ApexConfigLoadResult {
  readonly config: ApexConfig
  readonly sources: { readonly inline: boolean; readonly global: boolean; readonly local: boolean }
  readonly paths: { readonly global: string; readonly local: string }
}

/**
 * Carga la configuración con JERARQUÍA y dos canales.
 *
 * Precedencia (menor → mayor):
 *   1. Fichero GLOBAL → <config>/opencode/opencode-apex.jsonc
 *   2. Opciones inline en la definición del plugin (opencode.json) → ctx.options
 *      (el host ya mergea su config global y local, ganando la local)
 *   3. Fichero LOCAL  → <proyecto>/.opencode/opencode-apex.jsonc
 *
 * Es decir: el ámbito manda (local > global) y, dentro de cada ámbito, el
 * fichero gana a las opciones inline. El inline ocupa el nivel "local" porque
 * el host entrega ya mergeadas las opciones inline global+local.
 */
export async function loadApexConfig(input: {
  projectDir: string
  home: string
  options?: Record<string, unknown>
  configDir?: string
}): Promise<ApexConfigLoadResult> {
  const paths = apexConfigPaths(input)
  const inline = input.options ?? {}

  const readSource = async (path: string, label: string): Promise<Record<string, unknown>> => {
    try {
      return await loadConfigSource(path)
    } catch (error) {
      console.warn(`[apex] config ${label} inválida (${path}): ${String(error)} — se ignora`)
      return {}
    }
  }

  const globalRaw = await readSource(paths.global, "global")
  const localRaw = await readSource(paths.local, "local")

  // global-file < inline < local-file
  const merged = deepMerge(deepMerge(deepMerge({}, globalRaw), inline), localRaw)

  // Aviso de claves obsoletas: el toggle es `modules.<nombre>`.
  const legacy = (merged as Record<string, unknown>).events
  const legacyEnabled = (legacy as Record<string, unknown> | undefined)?.enabled
  if (legacyEnabled !== undefined) {
    console.warn(
      `[apex] "events.enabled" está obsoleto y se ignora; usa "modules.events" (valor indicado: ${String(legacyEnabled)})`,
    )
  }
  // 0.2.0: el listener HTTP plano desapareció (se cerraba al descargarse el plugin
  // por inactividad). Los callbacks y webhooks entran por el RPC.
  if ((legacy as Record<string, unknown> | undefined)?.listener !== undefined) {
    console.warn(
      `[apex] "events.listener" no longer exists and is ignored: use the apex/events.ingest RPC (tool apex_callback_endpoint)`,
    )
  }

  const result = apexConfigSchema.safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`Configuración inválida (merge inline+global+local): ${issues}`)
  }

  return {
    config: resolveEnvVariables(result.data),
    sources: {
      inline: Object.keys(inline).length > 0,
      global: Object.keys(globalRaw).length > 0,
      local: Object.keys(localRaw).length > 0,
    },
    paths,
  }
}

/** Carga un único fichero (compatibilidad y tests). Ausente → defaults. */
export async function loadConfig(path: string): Promise<ApexConfig> {
  const raw = await loadConfigSource(path)
  const result = apexConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`Configuración inválida en ${path}: ${issues}`)
  }
  return resolveEnvVariables(result.data)
}

// ============================================================================
// Gestor de configuración con patrón last-good
// ============================================================================

class ApexConfigManager {
  private currentConfig: ApexConfig | null = null
  private lastGoodConfig: ApexConfig | null = null

  get config(): ApexConfig | null {
    return this.currentConfig
  }

  get lastGood(): ApexConfig | null {
    return this.lastGoodConfig
  }

  async load(path: string): Promise<ApexConfig> {
    const config = await loadConfig(path)
    this.currentConfig = config
    this.lastGoodConfig = config
    return config
  }

  apply(config: ApexConfig): void {
    this.currentConfig = config
    this.lastGoodConfig = config
    // Los flags de módulos se aplican en el plugin principal (index.ts)
    // Aquí solo actualizamos el estado interno
  }

  dispose(): void {
    this.currentConfig = null
    this.lastGoodConfig = null
  }

}

// Singleton exportado
export const configManager = new ApexConfigManager()

// ============================================================================
// Helpers de conveniencia
// ============================================================================

export function getConfig(): ApexConfig | null {
  return configManager.config
}

export function getLastGoodConfig(): ApexConfig | null {
  return configManager.lastGood
}

export async function loadAndApplyConfig(path: string): Promise<ApexConfig> {
  const config = await configManager.load(path)
  configManager.apply(config)
  return config
}

export function disposeConfig(): void {
  configManager.dispose()
}