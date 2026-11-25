/**
 * apex-daemon — un proceso por usuario que mantiene lo que el plugin no puede mantener
 * (OpenCode descarga los plugins tras 60 min sin actividad):
 *
 * - rutas propias en el túnel OpenTunnel del perfil `default`, el mismo que usa el acceso
 *   remoto de OpenCode (cada uno reclama sus rutas), con caducidad;
 * - el receptor de webhooks: verifica la firma o el token de cada uno y solo entonces
 *   llama en local a `events.ingest` (el password del servidor no sale de la máquina).
 *
 * Multiplataforma a propósito: sin systemd ni launchd. Lo lanza el plugin desacoplado con
 * el propio binario de OpenCode en modo bun (`BUN_BE_BUN=1`); un lockfile evita dos.
 *
 * Dos listeners en 127.0.0.1: control (token del daemon; nunca se publica) y webhooks
 * (lo único que apunta el túnel). Separarlos es lo que pide OpenTunnel: lo que solo debe
 * ser local, en un listener que nunca se enruta.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"
import { rpcUrl, tunnelDirectory } from "../core/server-endpoint.js"
import {
  daemonPaths,
  emptyRegistry,
  randomRoute,
  randomToken,
  validRouteName,
  type DaemonInfo,
  type ProxyProtocol,
  type Registry,
  type ServerTarget,
  type TunnelEntry,
  type WebhookEntry,
  type WebhookProvider,
} from "./shared.js"
import { parseBody, slackChallenge, toIngest, verify, type Headers } from "./webhooks.js"

const VERSION = process.env.APEX_DAEMON_VERSION ?? "dev"
const paths = daemonPaths()
const IDLE_EXIT_MS = Number(process.env.APEX_DAEMON_IDLE_MINUTES ?? 10) * 60_000
const MAX_BODY = 1024 * 1024
const SWEEP_MS = Number(process.env.APEX_DAEMON_SWEEP_MS ?? 15_000)
const PROVIDERS: readonly WebhookProvider[] = ["github", "stripe", "slack", "hmac", "token"]

const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts)

// ============================================================================
// Proceso único
// ============================================================================

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function acquireLock(): boolean {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, "wx", 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const owner = Number(readFileSync(paths.lock, "utf8").trim())
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && alive(owner)) return false
      try {
        unlinkSync(paths.lock)
      } catch {
        // otro proceso ya lo limpió
      }
    }
  }
  return false
}

// ============================================================================
// Registro (0600, escritura atómica)
// ============================================================================

function writePrivate(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows: los permisos POSIX no aplican
  }
}

function loadRegistry(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(paths.registry, "utf8"))
    return { ...emptyRegistry(), ...parsed }
  } catch {
    return emptyRegistry()
  }
}

const registry = loadRegistry()
const save = () => writePrivate(paths.registry, JSON.stringify(registry, null, 2))

// ============================================================================
// Servidor de OpenCode por proyecto: el daemon llama a events.ingest en local
// ============================================================================

function readPassword(target: ServerTarget): string | null {
  const source = target.password
  if (!source) return null
  if (source.kind === "value") return source.value
  try {
    const record = JSON.parse(readFileSync(source.file, "utf8")) as Record<string, unknown>
    const value = record[source.field]
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

async function ingest(directory: string, input: unknown): Promise<{ ok: boolean; status?: number; error?: string }> {
  const target = registry.servers[directory]
  if (!target) return { ok: false, error: "no OpenCode server known for this project yet (open it in OpenCode once)" }
  const password = readPassword(target)
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  try {
    const response = await fetch(rpcUrl(target.baseUrl, "events.ingest", directory), {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) return { ok: true, status: response.status }
    return { ok: false, status: response.status, error: (await response.text()).slice(0, 300) }
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error) }
  }
}

// ============================================================================
// Túnel (OpenTunnel SDK, perfil default compartido con OpenCode)
// ============================================================================

type Connection = Awaited<ReturnType<Awaited<ReturnType<typeof loadClient>>["tunnel"]["connect"]>>

async function loadClient() {
  const { create } = await import("@opentunnel/client")
  return create()
}

const tunnel = {
  client: null as Awaited<ReturnType<typeof loadClient>> | null,
  connection: null as Connection | null,
  hostname: null as string | null,
  state: "idle" as "idle" | "provisioning" | "connecting" | "connected" | "reconnecting" | "error",
  lastError: null as string | null,
  connectedAt: null as number | null,
  queue: Promise.resolve() as Promise<void>,
  retry: null as ReturnType<typeof setTimeout> | null,
  failures: 0,
}

let hooksPort = 0
let controlPort = 0

function routeTable(): Record<string, string | { target: string; proxyProtocol: ProxyProtocol }> {
  const routes: Record<string, string | { target: string; proxyProtocol: ProxyProtocol }> = {}
  for (const entry of registry.tunnels)
    routes[entry.route] = entry.proxyProtocol ? { target: entry.target, proxyProtocol: entry.proxyProtocol } : entry.target
  // Todos los webhooks comparten el listener de webhooks; el Host elige cuál.
  for (const hook of registry.webhooks) routes[hook.route] = `127.0.0.1:${hooksPort}`
  return routes
}

/**
 * Hostname del túnel del dispositivo, leído del disco (`tunnel.json`, lo escribe el SDK cuando
 * el certificado está listo). No pasa por el SDK: mientras `connect` aprovisiona, sus
 * llamadas esperan y una petición de control se quedaría colgada.
 */
async function knownHostname(): Promise<string | null> {
  if (tunnel.hostname) return tunnel.hostname
  try {
    const stored = JSON.parse(readFileSync(join(tunnelDirectory(), "default", "tunnel.json"), "utf8")) as { hostname?: unknown }
    if (typeof stored.hostname === "string" && stored.hostname.length > 0) tunnel.hostname = stored.hostname
  } catch {
    // sin túnel todavía
  }
  return tunnel.hostname
}

function urlOf(route: string): string | null {
  return tunnel.hostname ? `https://${route}.${tunnel.hostname}` : null
}

/** Aplica el registro al túnel. Serializado: un connect/setRoutes cada vez. */
function syncRoutes(): Promise<void> {
  tunnel.queue = tunnel.queue.then(applyRoutes, applyRoutes)
  return tunnel.queue
}

async function applyRoutes(): Promise<void> {
  const routes = routeTable()
  const empty = Object.keys(routes).length === 0
  try {
    if (empty) {
      if (tunnel.connection) {
        const connection = tunnel.connection
        tunnel.connection = null
        await connection.close()
      }
      tunnel.state = "idle"
      return
    }
    if (tunnel.connection) {
      await tunnel.connection.setRoutes(routes)
      return
    }
    tunnel.client ??= await loadClient()
    // Sin identidad, connect crea el túnel del dispositivo (certificado: ~1 min).
    tunnel.state = (await knownHostname()) ? "connecting" : "provisioning"
    const connection = await tunnel.client.tunnel.connect({
      routes,
      onEvent: (event) => {
        if (event.type === "connected") {
          tunnel.state = "connected"
          tunnel.connectedAt = Date.now()
          tunnel.failures = 0
        } else if (event.type === "reconnecting" || event.type === "disconnected") {
          tunnel.state = "reconnecting"
          if (event.type === "disconnected") tunnel.lastError = event.reason
        } else if (event.type === "route-conflict") {
          tunnel.lastError = `route conflict: ${event.routes.join(", ")}`
        } else if (event.type === "stopped" && event.error) {
          tunnel.lastError = event.error
        }
      },
    })
    tunnel.connection = connection
    tunnel.hostname = connection.tunnel.hostname
    tunnel.state = "connected"
    tunnel.connectedAt = Date.now()
    tunnel.lastError = null
    void connection.closed.then(
      () => onTunnelStopped(connection, null),
      (error) => onTunnelStopped(connection, error),
    )
    // Rutas cambiadas mientras conectaba.
    const now = routeTable()
    if (JSON.stringify(now) !== JSON.stringify(routes)) await connection.setRoutes(now)
  } catch (error) {
    tunnel.state = "error"
    tunnel.lastError = String((error as Error).message ?? error)
    log("tunnel error:", tunnel.lastError)
    scheduleRetry()
  }
}

function onTunnelStopped(connection: Connection, error: unknown): void {
  if (tunnel.connection !== connection) return
  tunnel.connection = null
  tunnel.state = "error"
  tunnel.lastError = error ? String((error as Error).message ?? error) : "tunnel closed"
  log("tunnel stopped:", tunnel.lastError)
  scheduleRetry()
}

function scheduleRetry(): void {
  if (tunnel.retry || Object.keys(routeTable()).length === 0) return
  const delay = Math.min(1000 * 2 ** tunnel.failures, 60_000)
  tunnel.failures++
  tunnel.retry = setTimeout(() => {
    tunnel.retry = null
    void syncRoutes()
  }, delay)
}

// ============================================================================
// Altas, bajas y caducidad
// ============================================================================

function expiry(ttlMinutes: unknown): number | null {
  const ttl = Number(ttlMinutes)
  return Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 60_000 : null
}

function pickRoute(name: unknown): string {
  if (typeof name === "string" && name.length > 0) {
    const route = name.toLowerCase()
    if (!validRouteName(route)) throw new HttpError(400, `invalid route name "${name}" (lowercase letters, digits, dashes)`)
    if (route in routeTable()) throw new HttpError(409, `route "${route}" already in use`)
    return route
  }
  return randomRoute()
}

/** Nunca publicar el servidor de OpenCode: para eso está su acceso remoto (con password). */
function assertNotServerPort(host: string, port: number): void {
  for (const target of Object.values(registry.servers)) {
    try {
      const url = new URL(target.baseUrl)
      const local = ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"].includes(url.hostname)
      if (local && ["127.0.0.1", "localhost", "::1"].includes(host) && Number(url.port) === port)
        throw new HttpError(400, "that is the OpenCode server port: use OpenCode remote access (opencode service set remote true)")
    } catch (error) {
      if (error instanceof HttpError) throw error
    }
  }
}

function removeTunnel(id: string): boolean {
  const before = registry.tunnels.length
  registry.tunnels = registry.tunnels.filter((entry) => entry.id !== id && entry.route !== id)
  return registry.tunnels.length !== before
}

function removeWebhook(hook: WebhookEntry): void {
  registry.webhooks = registry.webhooks.filter((entry) => entry.id !== hook.id)
  try {
    unlinkSync(hook.secretFile)
  } catch {
    // ya no estaba
  }
}

let idleSince: number | null = null

function sweep(): void {
  const now = Date.now()
  let changed = false
  for (const entry of [...registry.tunnels]) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      log(`expired tunnel ${entry.route}`)
      changed = removeTunnel(entry.id) || changed
    }
  }
  for (const hook of [...registry.webhooks]) {
    if (hook.expiresAt !== null && hook.expiresAt <= now) {
      log(`expired webhook ${hook.name}`)
      removeWebhook(hook)
      changed = true
    }
  }
  if (changed) {
    save()
    void syncRoutes()
  }
  const empty = registry.tunnels.length === 0 && registry.webhooks.length === 0
  idleSince = empty ? (idleSince ?? now) : null
  if (idleSince !== null && now - idleSince >= IDLE_EXIT_MS) {
    log("idle: nothing to keep, exiting")
    void shutdown(0)
  }
}

// ============================================================================
// HTTP
// ============================================================================

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  if (response.headersSent) return
  const text = typeof body === "string" ? body : JSON.stringify(body)
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" })
  response.end(text)
}

function lowerHeaders(request: IncomingMessage): Headers {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(", ")
  }
  return out
}

/** Lo que ve el plugin de un webhook: nunca el secreto, solo su fichero. */
function publicHook(hook: WebhookEntry) {
  const { secret: _secret, ...rest } = hook
  return { ...rest, url: urlOf(hook.route) }
}

function publicTunnel(entry: TunnelEntry) {
  return { ...entry, url: urlOf(entry.route) }
}

function tunnelStatus() {
  return {
    state: tunnel.state,
    hostname: tunnel.hostname,
    lastError: tunnel.lastError,
    connectedAt: tunnel.connectedAt,
    routes: Object.keys(routeTable()).length,
  }
}

function owned(body: Record<string, unknown>) {
  const directory = typeof body.directory === "string" ? body.directory : ""
  if (!directory) throw new HttpError(400, "directory is required")
  return {
    directory,
    sessionID: typeof body.sessionID === "string" ? body.sessionID : null,
    createdAt: Date.now(),
    expiresAt: expiry(body.ttlMinutes),
  }
}

function newId(prefix: string): string {
  return `${prefix}_${randomToken(6)}`
}

async function control(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const method = request.method ?? "GET"
  const auth = request.headers.authorization ?? ""

  if (auth !== `Bearer ${token}`) return send(response, 401, { error: "unauthorized" })
  const body = method === "POST" ? (parseBody(await readBody(request), "application/json") as Record<string, unknown>) : {}
  const [, , kind, id] = url.pathname.split("/")

  if (url.pathname === "/v1/health") return send(response, 200, { ok: true, version: VERSION, pid: process.pid, startedAt: info.startedAt })

  if (url.pathname === "/v1/state") {
    await knownHostname()
    return send(response, 200, {
      version: VERSION,
      pid: process.pid,
      startedAt: info.startedAt,
      ports: { control: controlPort, hooks: hooksPort },
      tunnel: tunnelStatus(),
      tunnels: registry.tunnels.map(publicTunnel),
      webhooks: registry.webhooks.map(publicHook),
      servers: Object.keys(registry.servers),
    })
  }

  if (url.pathname === "/v1/server" && method === "POST") {
    const directory = String(body.directory ?? "")
    const target = body.target as ServerTarget | undefined
    if (!directory || !target?.baseUrl) throw new HttpError(400, "directory and target.baseUrl are required")
    registry.servers[directory] = { baseUrl: target.baseUrl, password: target.password ?? null, updatedAt: Date.now() }
    save()
    return send(response, 200, { ok: true })
  }

  if (url.pathname === "/v1/shutdown" && method === "POST") {
    send(response, 200, { ok: true })
    setTimeout(() => void shutdown(0), 50)
    return
  }

  if (kind === "tunnels") {
    if (method === "POST" && !id) {
      const port = Number(body.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new HttpError(400, "port must be 1-65535")
      if (port === controlPort) throw new HttpError(400, "that port is the apex daemon's control port")
      const host = typeof body.host === "string" && body.host.length > 0 ? body.host : "127.0.0.1"
      assertNotServerPort(host, port)
      const proxyProtocol = body.proxyProtocol === "v1" || body.proxyProtocol === "v2" ? body.proxyProtocol : undefined
      const entry: TunnelEntry = {
        kind: "tunnel",
        id: newId("tun"),
        ...owned(body),
        route: pickRoute(body.name),
        target: `${host}:${port}`,
        ...(proxyProtocol ? { proxyProtocol } : {}),
      }
      registry.tunnels.push(entry)
      save()
      void syncRoutes()
      await knownHostname()
      return send(response, 201, { ...publicTunnel(entry), tunnel: tunnelStatus() })
    }
    if (method === "DELETE" && id) {
      const removed = removeTunnel(id)
      save()
      void syncRoutes()
      return send(response, removed ? 200 : 404, { removed })
    }
  }

  if (kind === "webhooks") {
    if (method === "POST" && !id) {
      const provider = String(body.provider ?? "") as WebhookProvider
      if (!PROVIDERS.includes(provider)) throw new HttpError(400, `provider must be one of ${PROVIDERS.join(", ")}`)
      const name = String(body.name ?? "")
      if (!/^[\w.-]{1,64}$/.test(name)) throw new HttpError(400, "name: 1-64 letters, digits, dot, dash, underscore")
      if (registry.webhooks.some((hook) => hook.name === name)) throw new HttpError(409, `webhook "${name}" already exists`)
      const given = typeof body.secret === "string" && body.secret.length > 0 ? body.secret : null
      if (!given && (provider === "stripe" || provider === "slack"))
        throw new HttpError(400, `${provider} signs with a secret it gives you: pass it as secret`)
      const secret = given ?? randomToken(32)
      const hookId = newId("hook")
      mkdirSync(join(paths.home, "secrets"), { recursive: true, mode: 0o700 })
      const secretFile = join(paths.home, "secrets", `${hookId}.secret`)
      writePrivate(secretFile, secret)
      const route = pickRoute(undefined)
      const hook: WebhookEntry = {
        kind: "webhook",
        id: hookId,
        ...owned(body),
        name,
        provider,
        secret,
        secretFile,
        ...(typeof body.header === "string" ? { header: body.header.toLowerCase() } : {}),
        ...(body.encoding === "base64" ? { encoding: "base64" as const } : {}),
        source: typeof body.source === "string" && body.source.length > 0 ? body.source : provider,
        route,
        stats: { ok: 0, rejected: 0, failed: 0, lastAt: null, lastError: null },
      }
      registry.webhooks.push(hook)
      save()
      void syncRoutes()
      await knownHostname()
      return send(response, 201, { ...publicHook(hook), tunnel: tunnelStatus() })
    }
    if (method === "DELETE" && id) {
      const hook = registry.webhooks.find((entry) => entry.id === id || entry.name === id)
      if (!hook) return send(response, 404, { removed: false })
      removeWebhook(hook)
      save()
      void syncRoutes()
      return send(response, 200, { removed: true })
    }
  }

  return send(response, 404, { error: `no route ${method} ${url.pathname}` })
}

/** Webhooks: el Host (lo elige el visitante) solo SELECCIONA el webhook; la firma decide. */
async function hooks(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const route = (request.headers.host ?? "").split(":")[0]!.split(".")[0]!.toLowerCase()
  const hook = registry.webhooks.find((entry) => entry.route === route)
  if (!hook) return send(response, 404, { error: "unknown webhook" })
  if (request.method !== "POST") return send(response, 405, { error: "POST only" })
  const body = await readBody(request)
  const headers = lowerHeaders(request)
  const url = new URL(request.url ?? "/", "https://webhook.invalid")
  const verdict = verify(hook, headers, body, url)
  hook.stats.lastAt = Date.now()
  if (!verdict.ok) {
    hook.stats.rejected++
    hook.stats.lastError = verdict.reason ?? "rejected"
    save()
    return send(response, 401, { error: "invalid signature" })
  }
  const payload = parseBody(body, headers["content-type"])
  const challenge = slackChallenge(hook, payload)
  if (challenge !== null) return send(response, 200, challenge, "text/plain")
  const result = await ingest(hook.directory, toIngest(hook, headers, payload))
  if (result.ok) {
    hook.stats.ok++
    hook.stats.lastError = null
  } else {
    hook.stats.failed++
    hook.stats.lastError = result.error ?? `ingest ${result.status}`
  }
  save()
  // 503: el emisor reintenta (Stripe, Slack); el agente no se entera si OpenCode no está.
  return send(response, result.ok ? 202 : 503, result.ok ? { ok: true } : { ok: false })
}

function wrap(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  return (request: IncomingMessage, response: ServerResponse) => {
    handler(request, response).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) log("request error:", error)
      send(response, status, { error: String((error as Error).message ?? error) })
    })
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))
  })
}

// ============================================================================
// Arranque y parada
// ============================================================================

let info: DaemonInfo
let controlServer: Server
let hooksServer: Server
let sweeper: ReturnType<typeof setInterval>
let closing = false

async function shutdown(code: number): Promise<never> {
  if (!closing) {
    closing = true
    log("shutting down")
    clearInterval(sweeper)
    try {
      await tunnel.connection?.close()
      await tunnel.client?.dispose()
    } catch {
      // nada que hacer
    }
    controlServer?.close()
    hooksServer?.close()
    save()
    for (const file of [paths.info, paths.lock]) {
      try {
        if (file === paths.info && existsSync(file) && JSON.parse(readFileSync(file, "utf8")).pid !== process.pid) continue
        unlinkSync(file)
      } catch {
        // ya no estaba
      }
    }
  }
  process.exit(code)
}

async function main(): Promise<void> {
  if (!acquireLock()) {
    log("another apex daemon is running")
    process.exit(0)
  }
  const token = randomToken(24)
  controlServer = createServer(wrap((request, response) => control(request, response, token)))
  hooksServer = createServer(wrap(hooks))
  controlPort = await listen(controlServer)
  hooksPort = await listen(hooksServer)
  info = { pid: process.pid, port: controlPort, token, version: VERSION, startedAt: Date.now() }
  writePrivate(paths.info, JSON.stringify(info))
  save()
  log(`apex daemon ${VERSION} pid ${process.pid} · control 127.0.0.1:${controlPort} · hooks 127.0.0.1:${hooksPort}`)

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void shutdown(0))
  process.on("uncaughtException", (error) => log("uncaught:", error))
  process.on("unhandledRejection", (error) => log("unhandled:", error))

  // Carga el SDK ya: si apex se actualiza, su directorio viejo puede desaparecer.
  tunnel.client = await loadClient().catch((error) => {
    tunnel.lastError = `OpenTunnel SDK unavailable: ${String((error as Error).message ?? error)}`
    log(tunnel.lastError)
    return null
  })
  if (Object.keys(routeTable()).length > 0) void syncRoutes()
  sweeper = setInterval(sweep, SWEEP_MS)
}

void main()
