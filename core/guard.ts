/**
 * Apex Guard — meta-permisos por agente, decididos en el plugin.
 *
 * POR QUÉ EXISTE. La capa gratuita de OpenCode Zen rechaza la petición
 * («free tier can only be used from within OpenCode») cuando el agente tiene
 * alguna herramienta QUITADA, sea por `permission: <tool>: deny` o por
 * `tools: <tool>: false`. Medido: una sola regla `shell: deny` basta. Y hay un
 * segundo motivo para no usar `deny` en la config: opencode corta el camino
 * antes de llamar a los plugins —
 *
 *     // packages/core/src/permission.ts
 *     if (denied(input, rules)) return { effect: "deny", rules }   // sin hooks
 *     const event = yield* hooks.trigger("permission", "evaluate", …)
 *
 * — así que un `deny` de config no es interceptable ni auditable.
 *
 * De ahí el reparto: la config declara `allow`/`ask` y **nunca** `deny`, con lo
 * que el toolset se mantiene completo (el modelo las ve todas y el gate no
 * salta), y la prohibición efectiva se decide aquí, sobre el `effect: "ask"`
 * que sí llega al hook. Cada decisión queda registrada, que es lo que permite
 * reportar qué intentó cada agente.
 *
 * Este fichero es el motor puro: sin Effect, sin IO, sin dependencias del host,
 * para poder probarlo con una tabla de casos.
 */

export type GuardEffect = "allow" | "deny" | "ask"

/**
 * Qué hacer cuando NINGUNA regla coincide. `"keep"` deja el permiso como venía y
 * es el único valor seguro por defecto: cualquier otro reescribe en masa lo que
 * decidió la config del host — un `fallback: "allow"` convierte en `allow` todos
 * los `ask`, y con ello anula de golpe las reglas de `shell` y deja al advisor
 * sin nada que juzgar. (Pasó: un `rm -r` se ejecutó sin preguntar.)
 */
export type GuardFallback = GuardEffect | "keep"

/**
 * Una regla. `action` y `resource` son patrones con `*` (cualquier cosa), igual
 * que los de `permission` en la config de opencode: `"shell"`, `"hindsight_*"`,
 * `"rm -rf *"`, `".opencode/scout/**"`.
 *
 * `resource` ausente equivale a `"*"`.
 */
export interface GuardRule {
  readonly action: string
  readonly resource?: string
  readonly effect: GuardEffect
  readonly reason?: string
}

/** Política de un agente: lista ordenada, **la última coincidencia gana**. */
export type GuardPolicy = readonly GuardRule[]

export interface GuardConfigShape {
  /** "enforce" aplica el efecto; "report" solo registra y no toca el permiso. */
  readonly mode: "enforce" | "report"
  /** Efecto cuando ninguna regla coincide; "keep" respeta el del host. */
  readonly fallback: GuardFallback
  /**
   * Reglas por agente. La clave `"*"` es la base común: sus reglas se evalúan
   * ANTES que las del agente, así que las del agente pueden afinarlas.
   */
  readonly agents: Readonly<Record<string, GuardPolicy>>
  /** Entradas que conserva el informe en memoria. */
  readonly keep: number
}

export interface GuardDecision {
  readonly effect: GuardEffect
  /** Efecto que traía el permiso antes de pasar por aquí. */
  readonly incoming: GuardEffect
  readonly reason?: string
  /** Regla que decidió, o undefined si decidió el fallback. */
  readonly rule?: GuardRule
  /** Recurso concreto que provocó la decisión (el primero que la dispara). */
  readonly resource?: string
}

// ---------------------------------------------------------------------------
// Coincidencia de patrones
// ---------------------------------------------------------------------------

const cache = new Map<string, RegExp>()

/**
 * Glob a regex, con la misma semántica laxa que usa opencode en sus reglas de
 * permiso: `*` cubre cualquier cosa, incluidas las barras. Es deliberado — un
 * patrón de recurso lo mismo describe una ruta (`.opencode/x/**`) que una línea
 * de comando (`rm -rf *`), y distinguir `*` de `**` por tramos solo sorprendería
 * a quien escribe la regla.
 */
function toRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern)
  if (hit) return hit
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  const re = new RegExp(`^${body}$`, "s")
  cache.set(pattern, re)
  return re
}

export function matches(pattern: string, value: string): boolean {
  return pattern === "*" || pattern === value || toRegExp(pattern).test(value)
}

/**
 * Normaliza un patrón de recurso a ruta absoluta cuando es relativo.
 *
 * Los recursos que entrega el host para `read`/`edit`/`write` son rutas
 * absolutas, así que una regla escrita como `.opencode/scout/**` no coincidiría
 * nunca. Se expande contra el directorio del proyecto. Lo que ya es absoluto, un
 * `~` o un patrón que no parece ruta (un comando de shell) se deja intacto.
 */
export function expandResource(pattern: string, projectDir: string, home: string): string {
  if (pattern === "*" || pattern === "") return "*"
  if (pattern.startsWith("/")) return pattern
  if (pattern === "~" || pattern.startsWith("~/")) return home + pattern.slice(1)
  // Un comando de shell no es una ruta: si lleva espacios, no se toca.
  if (/\s/.test(pattern)) return pattern
  return `${projectDir.replace(/\/+$/, "")}/${pattern}`
}

// ---------------------------------------------------------------------------
// Decisión
// ---------------------------------------------------------------------------

export interface GuardQuery {
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly incoming: GuardEffect
}

/**
 * Reglas aplicables a un agente: la base `"*"` primero y las suyas después, de
 * modo que las del agente ganan por ser posteriores.
 */
export function policyFor(config: GuardConfigShape, agent: string | undefined): GuardPolicy {
  const base = config.agents["*"] ?? []
  const own = agent ? config.agents[agent] ?? [] : []
  return [...base, ...own]
}

/**
 * Decide el efecto. Recorre las reglas y se queda con la ÚLTIMA que coincide —
 * el mismo criterio que opencode aplica a su propio ruleset, donde las reglas
 * del agente se añaden al final y por eso mandan.
 *
 * Un `deny` gana sobre un `allow` de la misma pasada solo si va después. Eso es
 * lo que permite «nada, salvo esta ruta»: primero el `deny` amplio, luego el
 * `allow` estrecho.
 */
export function decide(
  config: GuardConfigShape,
  query: GuardQuery,
  paths: { projectDir: string; home: string },
): GuardDecision {
  const rules = policyFor(config, query.agent)
  // Sin recursos el permiso sigue siendo evaluable: se trata como "*".
  const resources = query.resources.length > 0 ? query.resources : ["*"]

  let winner: { rule: GuardRule; resource: string } | undefined
  for (const rule of rules) {
    if (!matches(rule.action, query.action)) continue
    // El patrón se prueba TAL CUAL y expandido a absoluto, porque el host entrega
    // el recurso de las dos formas según la tool: medido, `read` llega como
    // `package.json` (relativo al cwd) mientras las reglas del propio opencode
    // hablan de `/home/…/.opencode/plan/*`. Expandir sin más dejaría sin efecto
    // toda regla de ruta escrita en relativo, que son justo las útiles.
    const patterns = new Set([rule.resource ?? "*", expandResource(rule.resource ?? "*", paths.projectDir, paths.home)])
    const hit = resources.find((resource) => [...patterns].some((pattern) => matches(pattern, resource)))
    if (hit === undefined) continue
    winner = { rule, resource: hit }
  }

  if (!winner) {
    const effect = config.fallback === "keep" ? query.incoming : config.fallback
    return { effect, incoming: query.incoming, reason: "ninguna regla coincide" }
  }
  return {
    effect: winner.rule.effect,
    incoming: query.incoming,
    reason: winner.rule.reason,
    rule: winner.rule,
    resource: winner.resource,
  }
}

// ---------------------------------------------------------------------------
// Informe
// ---------------------------------------------------------------------------

export interface GuardEntry {
  readonly at: number
  readonly agent: string
  readonly action: string
  readonly resources: readonly string[]
  readonly incoming: GuardEffect
  readonly effect: GuardEffect
  /** Efecto realmente aplicado: en modo "report" es el de entrada. */
  readonly applied: GuardEffect
  readonly reason?: string
  readonly rule?: string
}

/** Anillo de decisiones. Solo memoria: un informe no vale una escritura a disco por tool call. */
export class GuardReport {
  private entries: GuardEntry[] = []
  constructor(private readonly keep: number) {}

  add(entry: GuardEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep)
  }

  all(): readonly GuardEntry[] {
    return this.entries
  }

  /** Últimas `n`, de la más reciente a la más antigua. */
  recent(n: number): readonly GuardEntry[] {
    return this.entries.slice(-n).reverse()
  }

  /** Recuento por agente → efecto aplicado, para el resumen del informe. */
  summary(): Record<string, Record<GuardEffect, number>> {
    const out: Record<string, Record<GuardEffect, number>> = {}
    for (const e of this.entries) {
      const row = (out[e.agent] ??= { allow: 0, deny: 0, ask: 0 })
      row[e.applied]++
    }
    return out
  }

  clear(): void {
    this.entries = []
  }
}

/** Formatea una regla para el informe, sin volcar el objeto entero. */
export function ruleLabel(rule: GuardRule | undefined): string | undefined {
  if (!rule) return undefined
  const resource = rule.resource && rule.resource !== "*" ? ` ${rule.resource}` : ""
  return `${rule.effect} ${rule.action}${resource}`
}
