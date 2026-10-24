/**
 * RPC `apex/tools.run` — ejecuta UNA herramienta de OpenCode (nativa, de plugin o MCP)
 * desde fuera del servidor y devuelve su resultado.
 *
 * Es la pieza que permite que un bucle externo (cron, systemd, n8n) use herramientas
 * que solo existen dentro de OpenCode — el MCP de Easypanel, el navegador… — sin
 * modelo de por medio. La llamada RPC levanta el directorio si estaba descargado
 * (inactividad o reinicio), así que no depende de que el plugin siga vivo.
 *
 * Dos barreras, en este orden:
 *   1. `events.tools.allow` / `deny`: qué herramientas se pueden lanzar por aquí.
 *   2. los permisos del agente `events.tools.agent` (o el `agent` de la llamada): son
 *      los que evalúa cada herramienta. Sin nadie delante, un "ask" espera al advisor
 *      o hasta el timeout.
 *
 * Las herramientas corren en nombre de una sesión "runner" propia (una por
 * directorio, persistida), con el agente oculto `apex-runner`: así no se confunde
 * con la sesión principal ni aparece entre los agentes seleccionables.
 */

import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { EventsToolsConfig } from "./config.js"

export const RUNNER_AGENT_ID = "apex-runner"
const RUNNER_SESSION_KEY = "apex:tools:runnerSession"

export type ToolsRunConfig = EventsToolsConfig

export interface ToolsRunInput {
  readonly tool: string
  readonly input?: Record<string, unknown>
  /** Agente cuyos permisos se aplican a ESTA llamada (por defecto el de config). */
  readonly agent?: string
  readonly timeoutMs?: number
}

export interface ToolsRunOutput {
  readonly ok: boolean
  readonly tool: string
  readonly agent?: string
  /** Salida estructurada de la herramienta, si la declara. */
  readonly output?: unknown
  /** Texto que vería el modelo. */
  readonly content?: string
  readonly metadata?: unknown
  readonly error?: string
  readonly durationMs: number
}

/** Glob con `*` (cualquier secuencia) y `?` (un carácter); el resto literal. */
export function wildcard(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${source}$`).test(value)
}

export function checkTool(name: string, config: Pick<ToolsRunConfig, "allow" | "deny">): string | null {
  if (config.deny.some((pattern) => wildcard(pattern, name))) return `tool denied for tools.run (events.tools.deny): ${name}`
  if (!config.allow.some((pattern) => wildcard(pattern, name))) return `tool not in events.tools.allow: ${name}`
  return null
}

/** Texto de un `Tool.Result.content` (string o lista de partes). */
export function contentText(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content
    .map((part: { type?: string; text?: string }) => (typeof part?.text === "string" ? part.text : `[${part?.type ?? "?"}]`))
    .join("\n")
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message)
  return String(error)
}

/** Agente oculto que identifica a la sesión runner (sus permisos no se usan: manda el de la llamada). */
export function ensureRunnerAgent(ctx: Plugin.Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    yield* ctx.agent.transform((editor) => {
      editor.update(RUNNER_AGENT_ID, (agent) => {
        agent.name = RUNNER_AGENT_ID as never
        agent.description = "apex technical session for tools.run (RPC); not a working agent"
        agent.mode = "subagent"
        agent.hidden = true
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }] as never
      })
    })
  })
}

/** Crea el ejecutor de `tools.run` de un directorio (estado propio, nada global). */
export function makeToolsRunner(ctx: Plugin.Context, config: ToolsRunConfig) {
  let runnerSession: string | null = null
  let creating: Promise<string> | null = null
  let seq = 0

  const session = async (): Promise<string> => {
    if (runnerSession) return runnerSession
    creating ??= (async () => {
      const stored = await Effect.runPromise(ctx.storage.get(RUNNER_SESSION_KEY)).catch(() => undefined)
      if (typeof stored === "string" && stored.length > 0) {
        const alive = await Effect.runPromise(ctx.session.get({ sessionID: stored as never })).catch(() => undefined)
        if (alive) return stored
      }
      const created = await Effect.runPromise(
        ctx.session.create({ title: "apex · tools.run", agent: RUNNER_AGENT_ID as never }),
      )
      await Effect.runPromise(ctx.storage.set(RUNNER_SESSION_KEY, created.id as never)).catch(() => undefined)
      return created.id as string
    })().finally(() => {
      creating = null
    })
    runnerSession = await creating
    return runnerSession
  }

  return async (input: ToolsRunInput): Promise<ToolsRunOutput> => {
    const started = Date.now()
    const tool = typeof input?.tool === "string" ? input.tool.trim() : ""
    const fail = (error: string, agent?: string): ToolsRunOutput => ({
      ok: false,
      tool,
      ...(agent ? { agent } : {}),
      error,
      durationMs: Date.now() - started,
    })
    if (!config.enabled) return fail("tools.run is disabled (events.tools.enabled=false)")
    if (!tool) return fail("missing 'tool'")
    const blocked = checkTool(tool, config)
    if (blocked) return fail(blocked)

    const agent = input.agent && input.agent.trim().length > 0 ? input.agent.trim() : config.agent
    try {
      const tools = await Effect.runPromise(ctx.tool.list())
      const found = tools.find((candidate) => candidate.id === tool)
      if (!found) return fail(`tool not registered in this project: ${tool}`, agent)

      const sessionID = await session()
      const result = await Effect.runPromise(
        found.execute(input.input ?? {}, {
          sessionID: sessionID as never,
          agent: agent as never,
          messageID: `msg_apexrun${Date.now().toString(36)}` as never,
          id: `apex_run_${Date.now().toString(36)}_${++seq}` as never,
          progress: () => Effect.void,
        }),
        { signal: AbortSignal.timeout(input.timeoutMs ?? config.timeoutMs) },
      )
      return {
        ok: true,
        tool,
        agent,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.content !== undefined ? { content: contentText(result.content) } : {}),
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
        durationMs: Date.now() - started,
      }
    } catch (error) {
      const timedOut = Date.now() - started >= (input.timeoutMs ?? config.timeoutMs)
      return fail(timedOut ? `timed out after ${input.timeoutMs ?? config.timeoutMs} ms` : errorText(error), agent)
    }
  }
}
