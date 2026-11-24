/**
 * Dónde alcanza un proceso externo a ESTE servidor de OpenCode y cómo se autentica.
 *
 * Un agente que deja un bucle externo corriendo (cron, systemd, n8n, un relay de
 * webhooks) necesita saber a qué URL apuntar. El plugin corre dentro del proceso
 * del servidor, pero la API de plugins no expone su dirección, así que se descubre:
 *
 *   1. `events.server.url` de la config (proxy inverso, host fijo…)
 *   2. el registro del servicio en segundo plano — `<state>/opencode/service*.json`,
 *      que escribe `opencode serve --service` con { url, pid, password } (modo 0600) —
 *      cuando su pid es este proceso
 *   3. los argumentos `--hostname`/`--port` de `opencode serve`
 *
 * La URL pública (emisores de otras máquinas) sale de: `apex_set_callback_url` (runtime) >
 * `events.server.publicUrl` (config) > el acceso remoto del propio servicio
 * (`opencode service set remote true`, un túnel OpenTunnel que OpenCode mantiene).
 *
 * La auth es HTTP Basic `opencode:<password>`. El password NUNCA se devuelve: solo
 * dónde leerlo, para que no acabe en la conversación (ni en el proveedor del modelo).
 */

import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export const SERVER_USERNAME = "opencode"

export interface PasswordSource {
  /** "file": fichero JSON + campo · "env": variable con la que arrancó el servidor. */
  readonly kind: "file" | "env"
  readonly file?: string
  readonly field?: string
  readonly env?: string
  /** Fragmento de shell que imprime el password (para scripts). */
  readonly shell: string
}

export interface ServerEndpoint {
  /** URL base del servidor, alcanzable desde esta máquina (null = desconocida). */
  readonly baseUrl: string | null
  readonly source: "config" | "service" | "argv" | null
  /** URL para procesos FUERA de esta máquina (túnel / proxy inverso), si se conoce. */
  readonly publicUrl: string | null
  /** De dónde salió publicUrl: runtime | config | service-remote (acceso remoto de OpenCode). */
  readonly publicUrlSource: "runtime" | "config" | "service-remote" | null
  /** Directorio del proyecto al que deben ir las llamadas RPC (`location[directory]`). */
  readonly directory: string
  readonly auth: { readonly scheme: "basic"; readonly username: string; readonly password: PasswordSource | null }
  /** URLs completas de los métodos RPC de apex para este directorio. */
  readonly rpc: RpcUrls
  /** Las mismas URLs sobre publicUrl, para emisores de otras máquinas (null sin publicUrl). */
  readonly publicRpc: RpcUrls | null
  readonly hint?: string
}

type RpcUrls = Readonly<Record<"ingest" | "toolsRun" | "status" | "ping", string>>

/** `<state>/opencode` — respeta XDG_STATE_HOME igual que OpenCode. */
export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0 ? env.XDG_STATE_HOME : join(home, ".local", "state")
  return join(base, "opencode")
}

/** Config de OpenCode — `OPENCODE_CONFIG_DIR`, si no `<XDG_CONFIG_HOME>/opencode`, como el CLI. */
export function configDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.OPENCODE_CONFIG_DIR && env.OPENCODE_CONFIG_DIR.length > 0) return env.OPENCODE_CONFIG_DIR
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config")
  return join(base, "opencode")
}

/** Identidades de OpenTunnel — `<XDG_DATA_HOME>/opentunnel`, como su SDK. */
export function tunnelDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opentunnel")
}

/**
 * URL del acceso remoto del servicio (`opencode service set remote true`), o null.
 *
 * El servicio sirve su ruta secreta (`remote.route` de su config, que se llama igual que su
 * registro) en el túnel OpenTunnel del perfil `default`: `https://<route>.<hostname>`. Es lo
 * mismo que calcula OpenCode (`RemoteTunnel.hostname`). Dice que está configurado, no que
 * el túnel esté conectado en este momento.
 */
export function findServiceRemoteUrl(serviceFile: string, configDir: string, tunnelDir: string): string | null {
  try {
    const config = JSON.parse(readFileSync(join(configDir, basename(serviceFile)), "utf8")) as {
      remote?: { route?: unknown }
    }
    const route = config.remote?.route
    if (typeof route !== "string" || !/^[a-z0-9-]+$/.test(route)) return null
    // Sin tunnel.json el certificado aún no está listo: no hay URL que dar.
    const tunnel = JSON.parse(readFileSync(join(tunnelDir, "default", "tunnel.json"), "utf8")) as { hostname?: unknown }
    if (typeof tunnel.hostname !== "string" || tunnel.hostname.length === 0) return null
    return `https://${route}.${tunnel.hostname}`
  } catch {
    return null
  }
}

/** Host/puerto de `opencode serve` según su argv; null si no es un serve con puerto explícito. */
export function parseServeArgv(argv: readonly string[]): { host: string; port: number } | null {
  if (!argv.includes("serve")) return null
  const value = (flag: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!
      if (arg === flag) return argv[i + 1]
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
    }
    return undefined
  }
  const port = Number(value("--port"))
  if (!Number.isInteger(port) || port <= 0) return null
  const host = value("--hostname") ?? "127.0.0.1"
  // Escuchar en todas las interfaces no es una dirección: desde aquí, loopback.
  return { host: host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host, port }
}

interface ServiceRecord {
  readonly url?: string
  readonly pid?: number
}

/** El registro del servicio (ruta + url) cuyo pid es `pid`, entre `<state>/opencode/service*.json`. */
export function findServiceRecord(dir: string, pid: number): { file: string; url: string } | null {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => /^service(-[\w.-]+)?\.json$/.test(name))
  } catch {
    return null
  }
  for (const name of names) {
    const file = join(dir, name)
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as ServiceRecord
      if (record.pid === pid && typeof record.url === "string" && record.url.length > 0) return { file, url: record.url }
    } catch {
      // registro ilegible o a medio escribir: no es el nuestro
    }
  }
  return null
}

/** `<base>/api/rpc/apex/<método>?location[directory]=<dir>` (corchetes codificados, para curl). */
export function rpcUrl(base: string, method: string, directory: string): string {
  return `${base.replace(/\/+$/, "")}/api/rpc/apex/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
}

function rpcUrls(base: string, directory: string): RpcUrls {
  return {
    ingest: rpcUrl(base, "events.ingest", directory),
    toolsRun: rpcUrl(base, "tools.run", directory),
    status: rpcUrl(base, "status", directory),
    ping: rpcUrl(base, "ping", directory),
  }
}

export function resolveServerEndpoint(input: {
  readonly directory: string
  readonly configUrl?: string
  readonly publicUrl?: string | null
  /** Quién fijó `publicUrl` (por defecto config). */
  readonly publicUrlFrom?: "runtime" | "config"
  readonly argv?: readonly string[]
  readonly pid?: number
  readonly stateDir?: string
  readonly configDir?: string
  readonly tunnelDir?: string
}): ServerEndpoint {
  const argv = input.argv ?? process.argv
  const pid = input.pid ?? process.pid
  const stateDir = input.stateDir ?? stateDirectory()
  const service = findServiceRecord(stateDir, pid)
  const serve = service ? null : parseServeArgv(argv)

  let baseUrl: string | null = null
  let source: ServerEndpoint["source"] = null
  if (input.configUrl && input.configUrl.trim().length > 0) {
    baseUrl = input.configUrl.trim()
    source = "config"
  } else if (service) {
    baseUrl = service.url
    source = "service"
  } else if (serve) {
    baseUrl = `http://${serve.host.includes(":") ? `[${serve.host}]` : serve.host}:${serve.port}`
    source = "argv"
  }

  // El password lo custodia quien arrancó el servidor: el registro del servicio, o
  // la variable de entorno con la que se lanzó `opencode serve`.
  // `sed` y no `jq`: está en cualquier máquina y el registro es JSON plano.
  const password: PasswordSource | null = service
    ? {
        kind: "file",
        file: service.file,
        field: "password",
        shell: `sed -n 's/.*"password" *: *"\\([^"]*\\)".*/\\1/p' '${service.file}'`,
      }
    : serve
      ? { kind: "env", env: "OPENCODE_SERVER_PASSWORD", shell: "printenv OPENCODE_SERVER_PASSWORD" }
      : null

  const base = baseUrl ?? "<server-url>"
  const declared = input.publicUrl && input.publicUrl.trim().length > 0 ? input.publicUrl.trim() : null
  // Solo el proceso del servicio sirve el acceso remoto; un `opencode serve` suelto no.
  const remote =
    declared === null && service
      ? findServiceRemoteUrl(service.file, input.configDir ?? configDirectory(), input.tunnelDir ?? tunnelDirectory())
      : null
  const publicUrl = declared ?? remote
  const publicUrlSource: ServerEndpoint["publicUrlSource"] =
    declared !== null ? (input.publicUrlFrom ?? "config") : remote !== null ? "service-remote" : null
  return {
    baseUrl,
    source,
    publicUrl,
    publicUrlSource,
    directory: input.directory,
    auth: { scheme: "basic", username: SERVER_USERNAME, password },
    rpc: rpcUrls(base, input.directory),
    publicRpc: publicUrl ? rpcUrls(publicUrl, input.directory) : null,
    ...(baseUrl
      ? {}
      : { hint: "Server URL unknown: set events.server.url in the apex config (e.g. http://127.0.0.1:4096)" }),
  }
}

/** curl listo para una llamada RPC (el password se lee al ejecutar, nunca va en claro). */
export function curlExample(endpoint: ServerEndpoint, method: "ingest" | "toolsRun", body: unknown): string {
  const password = endpoint.auth.password?.shell ?? 'printenv OPENCODE_SERVER_PASSWORD'
  return [
    `curl -sS -X POST '${endpoint.rpc[method]}' \\`,
    `  -u "${endpoint.auth.username}:$(${password})" \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify({ input: body })}'`,
  ].join("\n")
}
