/**
 * apex-daemon — un proceso por usuario que mantiene lo que el plugin no puede mantener
 * (OpenCode descarga los plugins tras 60 min sin actividad):
 *
 * - rutas propias en el túnel OpenTunnel del perfil `default`, el mismo que usa el acceso
 *   remoto de OpenCode (cada uno reclama sus rutas), con caducidad;
 * - el receptor de webhooks: verifica la firma o el token de cada uno y solo entonces
 *   llama en local a `events.ingest` (el password del servidor no sale de la máquina);
 * - los microservicios del agente: arranque, reinicio con espera creciente, logs y TTL.
 *
 * Multiplataforma a propósito: sin systemd ni launchd. Lo lanza el plugin desacoplado con
 * el propio binario de OpenCode en modo bun (`BUN_BE_BUN=1`); un lockfile evita dos.
 *
 * Dos listeners en 127.0.0.1: control (token del daemon; nunca se publica) y webhooks
 * (lo único que apunta el túnel). Separarlos es lo que pide OpenTunnel: lo que solo debe
 * ser local, en un listener que nunca se enruta.
 */

import { spawn, type ChildProcess } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { uptime } from "node:os"
import { join } from "node:path"
import { rpcUrl } from "../core/server-endpoint.js"
import {
  bootStamp,
  daemonPaths,
  emptyRegistry,
  randomRoute,
  randomToken,
  validRouteName,
  type DaemonInfo,
  type ProxyProtocol,
  type Registry,
  type RestartPolicy,
  type ServerTarget,
  type ServiceEntry,
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

function loadRegistry(): Registry & { ports?: { control?: number; hooks?: number } } {
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
  for (const entry of registry.tunnels) {
    // Las rutas de webhooks apuntan al listener de webhooks, cuyo puerto puede cambiar.
    const target = registry.webhooks.some((hook) => hook.id === entry.ownerID) ? `127.0.0.1:${hooksPort}` : entry.target
    routes[entry.route] = entry.proxyProtocol ? { target, proxyProtocol: entry.proxyProtocol } : target
  }
  return routes
}

async function knownHostname(): Promise<string | null> {
  if (tunnel.hostname) return tunnel.hostname
  try {
    tunnel.client ??= await loadClient()
    const identity = await tunnel.client.tunnel.get()
    tunnel.hostname = identity?.hostname ?? null
  } catch (error) {
    tunnel.lastError = String((error as Error).message ?? error)
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
    const known = await tunnel.client.tunnel.get()
    // Sin identidad, connect crea el túnel del dispositivo (certificado: ~1 min).
    tunnel.state = known ? "connecting" : "provisioning"
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
  if (tunnel.retry || registry.tunnels.length === 0) return
  const delay = Math.min(1000 * 2 ** tunnel.failures, 60_000)
  tunnel.failures++
  tunnel.retry = setTimeout(() => {
    tunnel.retry = null
    void syncRoutes()
  }, delay)
}

// ============================================================================
// Microservicios
// ============================================================================

const children = new Map<string, ChildProcess>()
const stopping = new Set<string>()
const startedAt = new Map<string, number>()
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()
const currentBoot = () => bootStamp(Date.now(), uptime())

/** Entorno de un servicio: el del daemon menos credenciales de OpenCode, más lo suyo. */
function serviceEnv(service: ServiceEntry): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ["OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD", "BUN_BE_BUN", "APEX_DAEMON_VERSION"]) delete env[key]
  const route = registry.tunnels.find((entry) => entry.ownerID === service.id)
  return {
    ...env,
    ...service.env,
    ...(service.port ? { PORT: String(service.port) } : {}),
    ...(route && urlOf(route.route) ? { APEX_PUBLIC_URL: urlOf(route.route)! } : {}),
    APEX_SERVICE_NAME: service.name,
    APEX_INGEST_URL: `http://127.0.0.1:${controlPort}/v1/ingest`,
    APEX_INGEST_TOKEN: service.ingestToken,
  }
}

function rotate(file: string, max: number): void {
  try {
    if (statSync(file).size > max) renameSync(file, `${file}.1`)
  } catch {
    // no existe todavía
  }
}

function startService(service: ServiceEntry): void {
  if (children.has(service.id)) return
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  rotate(service.logFile, 10 * 1024 * 1024)
  const fd = openSync(service.logFile, "a", 0o600)
  writeSync(fd, `\n--- ${new Date().toISOString()} start: ${service.command}\n`)
  let child: ChildProcess
  try {
    // detached: grupo propio (se para entero) y sobrevive a un reinicio del daemon,
    // que lo adopta por pid. La salida va directa al fichero, sin pasar por el daemon.
    child = spawn(service.command, {
      cwd: service.cwd,
      env: serviceEnv(service),
      shell: true,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    })
  } catch (error) {
    closeSync(fd)
    service.status = "failed"
    service.lastExit = { code: null, signal: String((error as Error).message), at: Date.now() }
    save()
    return
  }
  closeSync(fd)
  children.set(service.id, child)
  startedAt.set(service.id, Date.now())
  service.pid = child.pid ?? null
  service.bootAt = currentBoot()
  service.status = "running"
  save()
  child.on("exit", (code, signal) => {
    children.delete(service.id)
    onServiceExit(service.id, code, signal)
  })
  child.on("error", (error) => {
    log(`service ${service.name}:`, error.message)
    // Sin proceso (no hubo spawn): no llegará exit.
    if (child.pid === undefined) {
      children.delete(service.id)
      service.pid = null
      service.status = "failed"
      service.lastExit = { code: null, signal: error.message, at: Date.now() }
      save()
    }
  })
  child.unref()
}

function onServiceExit(id: string, code: number | null, signal: string | null): void {
  const service = registry.services.find((entry) => entry.id === id)
  if (!service) return
  service.pid = null
  service.lastExit = { code, signal, at: Date.now() }
  if (stopping.has(id)) {
    stopping.delete(id)
    service.status = "stopped"
    save()
    return
  }
  // Estable más de un minuto: el contador de reinicios vuelve a cero.
  if (Date.now() - (startedAt.get(id) ?? 0) > 60_000) service.restarts = 0
  const again = service.restart === "always" || (service.restart === "on-failure" && code !== 0)
  if (!again) {
    service.status = code === 0 ? "stopped" : "failed"
    save()
    return
  }
  const delay = Math.min(1000 * 2 ** service.restarts, 60_000)
  service.restarts++
  service.status = "backoff"
  save()
  restartTimers.set(
    id,
    setTimeout(() => {
      restartTimers.delete(id)
      const current = registry.services.find((entry) => entry.id === id)
      if (current && current.status === "backoff") startService(current)
    }, delay),
  )
}

/** Mata el grupo del servicio: SIGTERM y, a los 5 s, SIGKILL (Windows: taskkill /T /F). */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {})
    return
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        // ya no existe
      }
    }
  }
  signal("SIGTERM")
  setTimeout(() => {
    if (alive(pid)) signal("SIGKILL")
  }, 5000).unref()
}

function stopService(service: ServiceEntry): void {
  const timer = restartTimers.get(service.id)
  if (timer) {
    clearTimeout(timer)
    restartTimers.delete(service.id)
  }
  if (service.pid && alive(service.pid)) {
    stopping.add(service.id)
    killTree(service.pid)
    // Adoptado (sin ChildProcess): no habrá evento exit.
    if (!children.has(service.id)) {
      stopping.delete(service.id)
      service.pid = null
      service.status = "stopped"
    }
  } else {
    service.pid = null
    service.status = "stopped"
  }
  save()
}

/** Al arrancar: adopta los servicios vivos del daemon anterior; arranca el resto. */
function resumeServices(restartAll: boolean): void {
  const boot = currentBoot()
  for (const service of registry.services) {
    if (service.status === "stopped" || service.status === "failed") continue
    const sameBoot = service.bootAt !== null && Math.abs(boot - service.bootAt) <= 20_000
    if (service.pid && sameBoot && alive(service.pid)) {
      if (restartAll) {
        // El puerto de control cambió: APEX_INGEST_URL del servicio ya no vale.
        killTree(service.pid)
        service.pid = null
        setTimeout(() => startService(service), 1500)
        continue
      }
      service.status = "running"
      log(`adopted service ${service.name} (pid ${service.pid})`)
      continue
    }
    service.pid = null
    startService(service)
  }
  save()
}

/** Vigila los adoptados (sin evento exit): cuando mueren, se tratan como una salida. */
function watchAdopted(): void {
  for (const service of registry.services) {
    if (service.status === "running" && service.pid && !children.has(service.id) && !alive(service.pid)) {
      onServiceExit(service.id, null, null)
    }
  }
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
    if (registry.tunnels.some((entry) => entry.route === route)) throw new HttpError(409, `route "${route}" already in use`)
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
  registry.tunnels = registry.tunnels.filter((entry) => entry.id !== id && entry.ownerID !== id)
  return registry.tunnels.length !== before
}

function removeWebhook(hook: WebhookEntry): void {
  registry.webhooks = registry.webhooks.filter((entry) => entry.id !== hook.id)
  removeTunnel(hook.id)
  try {
    unlinkSync(hook.secretFile)
  } catch {
    // ya no estaba
  }
}

function removeService(service: ServiceEntry): void {
  stopService(service)
  registry.services = registry.services.filter((entry) => entry.id !== service.id)
  removeTunnel(service.id)
}

let idleSince: number | null = null

function sweep(): void {
  const now = Date.now()
  let changed = false
  for (const entry of [...registry.tunnels]) {
    if (!entry.ownerID && entry.expiresAt !== null && entry.expiresAt <= now) {
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
  for (const service of [...registry.services]) {
    if (service.expiresAt !== null && service.expiresAt <= now) {
      log(`expired service ${service.name}`)
      removeService(service)
      changed = true
    }
  }
  watchAdopted()
  if (changed) {
    save()
    void syncRoutes()
  }
  const empty = registry.tunnels.length === 0 && registry.webhooks.length === 0 && registry.services.length === 0
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
  const route = registry.tunnels.find((entry) => entry.ownerID === hook.id)
  return { ...rest, url: route ? urlOf(route.route) : null }
}

function publicService(service: ServiceEntry) {
  const { ingestToken: _token, env, ...rest } = service
  const route = registry.tunnels.find((entry) => entry.ownerID === service.id)
  return { ...rest, envKeys: Object.keys(env), url: route ? urlOf(route.route) : null }
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

  // Ingest de los servicios: su propio token, no el del daemon.
  if (url.pathname === "/v1/ingest" && method === "POST") {
    const service = registry.services.find((entry) => auth === `Bearer ${entry.ingestToken}`)
    if (!service) return send(response, 401, { error: "unauthorized" })
    const body = parseBody(await readBody(request), "application/json")
    const payload = (body.payload && typeof body.payload === "object" ? body.payload : body) as Record<string, unknown>
    const result = await ingest(service.directory, {
      source: typeof body.source === "string" ? body.source : `service:${service.name}`,
      ...(typeof body.type === "string" ? { type: body.type } : {}),
      ...(typeof body.eventID === "string" ? { eventID: body.eventID } : {}),
      payload,
    })
    return send(response, result.ok ? 202 : 502, result)
  }

  if (auth !== `Bearer ${token}`) return send(response, 401, { error: "unauthorized" })
  const body = method === "POST" ? (parseBody(await readBody(request), "application/json") as Record<string, unknown>) : {}
  const [, , kind, id, action] = url.pathname.split("/")

  if (url.pathname === "/v1/health") return send(response, 200, { ok: true, version: VERSION, pid: process.pid, startedAt: info.startedAt })

  if (url.pathname === "/v1/state") {
    await knownHostname()
    return send(response, 200, {
      version: VERSION,
      pid: process.pid,
      startedAt: info.startedAt,
      ports: { control: controlPort, hooks: hooksPort },
      tunnel: tunnelStatus(),
      tunnels: registry.tunnels.filter((entry) => !entry.ownerID).map(publicTunnel),
      webhooks: registry.webhooks.map(publicHook),
      services: registry.services.map(publicService),
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
      const removed = removeTunnel(id) || removeTunnel(registry.tunnels.find((entry) => entry.route === id)?.id ?? "")
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
      registry.tunnels.push({
        kind: "tunnel",
        id: newId("tun"),
        directory: hook.directory,
        sessionID: hook.sessionID,
        createdAt: hook.createdAt,
        expiresAt: hook.expiresAt,
        route,
        target: `127.0.0.1:${hooksPort}`,
        ownerID: hook.id,
      })
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

  if (kind === "services") {
    const service = id ? registry.services.find((entry) => entry.id === id || entry.name === id) : undefined
    if (method === "POST" && !id) {
      const name = String(body.name ?? "")
      if (!/^[\w.-]{1,64}$/.test(name)) throw new HttpError(400, "name: 1-64 letters, digits, dot, dash, underscore")
      if (registry.services.some((entry) => entry.name === name)) throw new HttpError(409, `service "${name}" already exists (down it first)`)
      const command = String(body.command ?? "")
      if (!command.trim()) throw new HttpError(400, "command is required")
      const port = body.port === undefined || body.port === null ? null : Number(body.port)
      if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) throw new HttpError(400, "port must be 1-65535")
      if (body.public === true && port === null) throw new HttpError(400, "a public service needs its port")
      if (body.public === true && port !== null) assertNotServerPort("127.0.0.1", port)
      const restart: RestartPolicy = body.restart === "never" || body.restart === "on-failure" ? body.restart : "always"
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries((body.env ?? {}) as Record<string, unknown>)) env[key] = String(value)
      const base = owned(body)
      const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : base.directory
      if (!existsSync(cwd)) throw new HttpError(400, `cwd does not exist: ${cwd}`)
      const serviceId = newId("svc")
      const entry: ServiceEntry = {
        kind: "service",
        id: serviceId,
        ...base,
        name,
        command,
        cwd,
        env,
        port,
        restart,
        ingestToken: randomToken(24),
        logFile: join(paths.logs, `${name}.log`),
        pid: null,
        bootAt: null,
        status: "starting",
        restarts: 0,
        lastExit: null,
      }
      registry.services.push(entry)
      if (body.public === true && port !== null) {
        registry.tunnels.push({
          kind: "tunnel",
          id: newId("tun"),
          directory: base.directory,
          sessionID: base.sessionID,
          createdAt: base.createdAt,
          expiresAt: base.expiresAt,
          route: pickRoute(body.route),
          target: `127.0.0.1:${port}`,
          ...(body.proxyProtocol === "v1" || body.proxyProtocol === "v2" ? { proxyProtocol: body.proxyProtocol } : {}),
          ownerID: serviceId,
        })
        await knownHostname()
        void syncRoutes()
      }
      save()
      startService(entry)
      return send(response, 201, { ...publicService(entry), tunnel: tunnelStatus() })
    }
    if (!service) return send(response, 404, { error: "no such service" })
    if (method === "DELETE") {
      removeService(service)
      save()
      void syncRoutes()
      return send(response, 200, { removed: true })
    }
    if (method === "POST" && action === "restart") {
      stopService(service)
      service.restarts = 0
      service.status = "starting"
      setTimeout(() => startService(service), 1000)
      return send(response, 200, { restarting: true })
    }
    if (method === "GET" && action === "logs") {
      const lines = Math.min(Math.max(Number(url.searchParams.get("lines") ?? 100) || 100, 1), 2000)
      let text = ""
      try {
        const data = readFileSync(service.logFile, "utf8")
        text = data.split("\n").slice(-lines - 1).join("\n")
      } catch {
        text = ""
      }
      return send(response, 200, { file: service.logFile, status: service.status, text })
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

function listen(server: Server, preferred: number | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (port !== 0 && error.code === "EADDRINUSE") attempt(0)
        else reject(error)
      })
      server.listen(port, "127.0.0.1", () => {
        const address = server.address()
        resolve(typeof address === "object" && address ? address.port : port)
      })
    }
    attempt(preferred ?? 0)
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
    // Los servicios siguen vivos (desacoplados): el próximo daemon los adopta.
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
  const previous = registry.ports ?? {}
  controlServer = createServer(wrap((request, response) => control(request, response, token)))
  hooksServer = createServer(wrap(hooks))
  controlPort = await listen(controlServer, previous.control)
  hooksPort = await listen(hooksServer, previous.hooks)
  const portsChanged = previous.control !== undefined && previous.control !== controlPort
  registry.ports = { control: controlPort, hooks: hooksPort }
  info = { pid: process.pid, port: controlPort, token, version: VERSION, startedAt: Date.now() }
  writePrivate(paths.info, JSON.stringify(info))
  save()
  log(`apex daemon ${VERSION} pid ${process.pid} · control 127.0.0.1:${controlPort} · hooks 127.0.0.1:${hooksPort}`)

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void shutdown(0))
  process.on("uncaughtException", (error) => log("uncaught:", error))
  process.on("unhandledRejection", (error) => log("unhandled:", error))

  resumeServices(portsChanged)
  // Carga el SDK ya: si apex se actualiza, su directorio viejo puede desaparecer.
  tunnel.client = await loadClient().catch((error) => {
    tunnel.lastError = `OpenTunnel SDK unavailable: ${String((error as Error).message ?? error)}`
    log(tunnel.lastError)
    return null
  })
  if (registry.tunnels.length > 0) void syncRoutes()
  sweeper = setInterval(sweep, SWEEP_MS)
}

void main()
