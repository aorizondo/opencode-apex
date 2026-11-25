/**
 * Apex Endpoints — el agente publica endpoints que reaccionan a llamadas externas, a
 * través del daemon de apex (daemon/main.ts):
 *
 * - apex_tunnel:  un puerto local en una ruta del túnel OpenTunnel (open/list/close, TTL)
 * - apex_webhook: un webhook con firma verificada que despierta al agente (create/list/delete)
 * - apex_daemon:  estado y parada del daemon
 *
 * El trabajo lo hace el daemon (un proceso por usuario, fuera del plugin, que OpenCode
 * descarga tras 60 min). Aquí solo se habla con él y se le dice cómo llegar al servidor
 * de este proyecto para los events.ingest de los webhooks.
 */

import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { daemonPaths } from "./daemon/shared.js"
import { ensureDaemon, hasRegistryEntries, serverTarget, type DaemonClient } from "./core/daemon-client.js"
import type { ServerEndpoint } from "./core/server-endpoint.js"

interface EndpointsInput {
  readonly version: string
  /** Del módulo events (null si está apagado: sin events, un webhook no despierta a nadie). */
  readonly endpoint: (() => ServerEndpoint) | null
}

type Args = Record<string, unknown>
type ToolContext = { sessionID?: string }

const PROVISIONING_HINT =
  "The device tunnel is being created (first time only, about a minute while its certificate is issued). " +
  "Call the list action shortly to get the URL."

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function withHint<T extends { url?: string | null; tunnel?: { state?: string; lastError?: string | null } }>(result: T) {
  if (result.url) return result
  const state = result.tunnel?.state
  return {
    ...result,
    hint:
      state === "error"
        ? `Tunnel error: ${result.tunnel?.lastError ?? "unknown"}. It retries by itself; check apex_daemon status.`
        : PROVISIONING_HINT,
  }
}

export function register(ctx: Plugin.Context, input: EndpointsInput): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const directory = ctx.location.directory
    const paths = daemonPaths()

    /** Daemon vivo + el servidor de este proyecto al día (su URL cambia al reiniciar). */
    const daemon = async (spawn = true): Promise<DaemonClient> => {
      const client = await ensureDaemon({ version: input.version, spawn, paths })
      if (!client) throw new Error("apex daemon is not running")
      const target = input.endpoint ? serverTarget(input.endpoint()) : null
      if (target) await client.request("POST", "/v1/server", { directory, target }).catch(() => undefined)
      return client
    }

    // Al cargar: si hay endpoints que mantener (p. ej. tras reiniciar el equipo), que el
    // daemon esté vivo. Sin registro no se lanza nada.
    if (hasRegistryEntries(paths)) {
      yield* Effect.promise(() =>
        daemon().catch((error) => console.warn(`[apex.endpoints] daemon: ${String((error as Error).message ?? error)}`)),
      )
    }

    const tool = (definition: {
      name: string
      description: string
      properties: Record<string, unknown>
      required?: string[]
      run: (args: Args, toolCtx: ToolContext) => Promise<unknown>
    }) =>
      ctx.tool.transform((editor) => {
        editor.add({
          name: definition.name,
          description: definition.description,
          input: {
            type: "object",
            properties: definition.properties,
            ...(definition.required ? { required: definition.required } : {}),
            additionalProperties: false,
          },
          output: { type: "object", additionalProperties: true },
          execute: (raw: unknown, toolCtx: ToolContext) =>
            Effect.promise(async () => {
              try {
                return { output: (await definition.run((raw ?? {}) as Args, toolCtx ?? {})) as Record<string, unknown> }
              } catch (error) {
                return { output: { ok: false, error: String((error as Error).message ?? error) } }
              }
            }),
        } as never)
      })

    const ttl = {
      type: "number",
      description: "Minutes until it is removed automatically (omit or 0 = permanent). Use one for anything temporary",
    }
    const owner = (args: Args, toolCtx: ToolContext) => ({
      directory,
      sessionID: toolCtx.sessionID ?? null,
      ttlMinutes: args.ttlMinutes,
    })

    yield* tool({
      name: "apex_tunnel",
      description:
        "Publish a local port on a public HTTPS URL through OpenTunnel (same device tunnel as OpenCode remote " +
        "access, own route). open → {id, url}; list; close {id}. Anyone with the URL reaches the port: the app " +
        "behind it MUST authenticate requests. Never publish the OpenCode server port.",
      properties: {
        action: { type: "string", enum: ["open", "list", "close"] },
        port: { type: "number", description: "open: local port" },
        host: { type: "string", description: "open: local host (default 127.0.0.1)" },
        name: { type: "string", description: "open: readable route name (default random, unguessable)" },
        proxyProtocol: { type: "string", enum: ["v1", "v2"], description: "open: send a PROXY header (only if the app expects it)" },
        ttlMinutes: ttl,
        id: { type: "string", description: "close: tunnel id or route name" },
      },
      required: ["action"],
      run: async (args, toolCtx) => {
        const client = await daemon()
        if (args.action === "list") {
          const state = await client.request<{ tunnel: unknown; tunnels: unknown[] }>("GET", "/v1/state")
          return { tunnel: state.tunnel, tunnels: state.tunnels }
        }
        if (args.action === "close") return client.request("DELETE", `/v1/tunnels/${encodeURIComponent(String(args.id ?? ""))}`)
        const server = input.endpoint?.().baseUrl
        if (server && Number(new URL(server).port) === Number(args.port))
          throw new Error("that is the OpenCode server port: use OpenCode remote access (opencode service set remote true) instead")
        const opened = await client.request<{ url?: string | null; tunnel?: { state?: string } }>("POST", "/v1/tunnels", {
          ...owner(args, toolCtx),
          port: args.port,
          host: str(args.host),
          name: str(args.name),
          proxyProtocol: args.proxyProtocol,
        })
        return withHint(opened)
      },
    })

    yield* tool({
      name: "apex_webhook",
      description:
        "Create a public webhook URL that verifies each call (github, stripe, slack, generic hmac or token) and " +
        "then wakes this project's agents through events.ingest locally (the server password never leaves the " +
        "machine). Pair it with apex_subscribe (filter source). create → {url, secretFile}; list; delete {id}.",
      properties: {
        action: { type: "string", enum: ["create", "list", "delete"] },
        name: { type: "string", description: "create: unique name (also prefixes event IDs)" },
        provider: {
          type: "string",
          enum: ["github", "stripe", "slack", "hmac", "token"],
          description:
            "create: github (X-Hub-Signature-256), stripe (Stripe-Signature, needs its whsec_ secret), slack " +
            "(signing secret), hmac (HMAC-SHA256 of the body in a header), token (Bearer / X-Apex-Token / ?token=)",
        },
        secret: { type: "string", description: "create: secret the sender gives you (stripe, slack). Omit to generate one" },
        header: { type: "string", description: "create, hmac: signature header (default X-Signature)" },
        encoding: { type: "string", enum: ["hex", "base64"], description: "create, hmac: signature encoding (default hex)" },
        source: { type: "string", description: "create: events.ingest source (default the provider)" },
        ttlMinutes: ttl,
        id: { type: "string", description: "delete: webhook id or name" },
      },
      required: ["action"],
      run: async (args, toolCtx) => {
        const client = await daemon()
        if (args.action === "list") return { webhooks: (await client.request<{ webhooks: unknown[] }>("GET", "/v1/state")).webhooks }
        if (args.action === "delete") return client.request("DELETE", `/v1/webhooks/${encodeURIComponent(String(args.id ?? ""))}`)
        if (!input.endpoint) throw new Error("the events module is off (modules.events): a webhook would wake nobody")
        if (!input.endpoint().baseUrl) throw new Error("OpenCode server URL unknown: set events.server.url in the apex config")
        const hook = await client.request<{ url?: string | null; secretFile: string; source: string; provider: string }>(
          "POST",
          "/v1/webhooks",
          {
            ...owner(args, toolCtx),
            name: args.name,
            provider: args.provider,
            secret: str(args.secret),
            header: str(args.header),
            encoding: args.encoding,
            source: str(args.source),
          },
        )
        return withHint({
          ...hook,
          secretShell: `cat '${hook.secretFile}'`,
          next:
            `Configure the sender with this URL and the secret read from secretFile at run time (never paste it in ` +
            `the chat). Then apex_subscribe with filter {field:"source", operator:"equals", value:"${hook.source}"}.`,
        })
      },
    })

    yield* tool({
      name: "apex_daemon",
      description:
        "The apex daemon that keeps tunnels and webhooks alive: status (tunnel state, everything it keeps, log " +
        "file) or stop (the next apex tool call or plugin load starts it again).",
      properties: {
        action: { type: "string", enum: ["status", "stop"] },
      },
      required: ["action"],
      run: async (args) => {
        const client = await daemon(args.action !== "stop")
        if (args.action === "stop") {
          await client.request("POST", "/v1/shutdown", {}).catch(() => undefined)
          return { stopped: true }
        }
        const state = await client.request("GET", "/v1/state")
        return { ...state, log: paths.log, home: paths.home }
      },
    })
  })
}
