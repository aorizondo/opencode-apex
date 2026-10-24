/**
 * Cliente CDP sobre WebSocket contra un Chromium externo.
 *
 * El plugin-browser del servidor solo conoce el contrato Browser.Action/Result;
 * este módulo traduce esas acciones al protocolo real. La equivalencia con la
 * app Electron es directa: allí es `contents.debugger.sendCommand`, aquí es un
 * mensaje por el socket.
 */

import { randomUUID } from "node:crypto"
import { WebSocket as NodeWebSocket } from "ws"
import { resolveEndpoint, type EndpointCandidate } from "./endpoint.js"

export const PROTOCOL_VERSION = "1.3"

export interface TlsOptions {
  readonly ca?: Buffer
  readonly rejectUnauthorized?: boolean
}

export class CdpError extends Error {
  readonly code: string
  constructor(message: string, { code = "cdp_error" }: { code?: string } = {}) {
    super(message)
    this.name = "CdpError"
    this.code = code
  }
}

export interface ConnectInput {
  readonly cdpUrl?: string
  readonly profileDir?: string
  readonly signal?: AbortSignal
  readonly onCandidate?: (candidate: EndpointCandidate) => void
  readonly timeoutMs?: number
  readonly headers?: Record<string, string>
  readonly tls?: TlsOptions
}

export class CdpClient {
  #socket: NodeWebSocket
  #nextId = 1
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  #listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>()
  #closed = false
  /** Cómo se resolvió el endpoint; útil para logs de diagnóstico. */
  endpoint: EndpointCandidate | undefined
  /** Grabaciones en curso, guardadas en el cliente para sobrevivir comandos. */
  readonly traces: TraceState

  private constructor(socket: NodeWebSocket, traces: TraceState) {
    this.#socket = socket
    this.traces = traces
    socket.on("message", (data) => this.#onMessage(data.toString()))
    socket.on("close", () => {
      this.#closed = true
      for (const { reject } of this.#pending.values()) {
        reject(new CdpError("CDP socket closed", { code: "cdp_closed" }))
      }
      this.#pending.clear()
    })
    // Sin listener, un error de transporte tumba el proceso. Lo dejamos pasar:
    // quien reintenta decide qué hacer.
    socket.on("error", () => {})
  }

  /**
   * Conecta al Chromium externo.
   *
   * Cada conexión abre un popup "Allow remote debugging?" en el navegador: por
   * eso quien llama debe mantener ESTE objeto vivo y no reconectar por comando.
   */
  static async connect(input: ConnectInput): Promise<CdpClient> {
    const { signal, onCandidate, timeoutMs = 60_000, headers, tls } = input
    const endpoint = await resolveEndpoint({ cdpUrl: input.cdpUrl, profileDir: input.profileDir })
    const failures: string[] = []

    // Varios perfiles pueden declarar el mismo puerto (ficheros stale). Probamos
    // en orden y nos quedamos con el primero que de verdad responde.
    for (const candidate of endpoint.candidates) {
      if (signal?.aborted) throw new CdpError("aborted before connect", { code: "aborted" })
      onCandidate?.(candidate)

      const socket = createSocket(candidate.webSocketDebuggerUrl, { headers, tls })
      const opened = await new Promise<boolean>((resolve) => {
        // El modo toggle deja el handshake a medias hasta que alguien acepta el
        // popup "Allow remote debugging?". Sin este timeout el proceso se queda
        // colgado para siempre en silencio.
        const timer = setTimeout(() => finish(false), timeoutMs)
        const onAbort = () => {
          try {
            socket.close()
          } catch {
            // el socket puede estar ya cerrado
          }
          finish(false)
        }
        const finish = (value: boolean) => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", onAbort)
          resolve(value)
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        socket.once("open", () => finish(true))
        socket.once("error", () => finish(false))
      })

      if (!opened) {
        failures.push(`${candidate.profileDir ?? candidate.webSocketDebuggerUrl} (sin respuesta o popup sin aprobar)`)
        continue
      }

      const client = new CdpClient(socket, { trace: undefined, cpu: new Map() })
      client.endpoint = candidate
      return client
    }

    throw new CdpError(
      `No se pudo abrir CDP. Probados: ${failures.join(", ")}. ` +
        `Si el navegador usa el toggle de chrome://inspect/#remote-debugging, ` +
        `acepta el popup "Allow remote debugging?" de cada intento y reintenta.`,
      { code: "cdp_no_ws" },
    )
  }

  /** Envía un comando CDP y espera su respuesta. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.#closed) return Promise.reject(new CdpError("CDP socket closed", { code: "cdp_closed" }))

    const id = this.#nextId++
    const message: Record<string, unknown> = { id, method, params }
    if (sessionId) message.sessionId = sessionId

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        this.#socket.send(JSON.stringify(message))
      } catch (error) {
        this.#pending.delete(id)
        reject(new CdpError(`failed to send ${method}: ${(error as Error).message}`, { code: "cdp_send_failed" }))
      }
    })
  }

  on(method: string, handler: (params: any, sessionId?: string) => void): () => void {
    let set = this.#listeners.get(method)
    if (!set) {
      set = new Set()
      this.#listeners.set(method, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  close() {
    this.#closed = true
    try {
      this.#socket.close()
    } catch {
      // el socket puede estar ya cerrado
    }
  }

  #onMessage(raw: string) {
    let message: any
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id)
      if (!entry) return
      this.#pending.delete(message.id)
      if (message.error) {
        entry.reject(
          new CdpError(`${message.error.message ?? "CDP error"} (${message.error.code ?? "?"})`, {
            code: "cdp_command_failed",
          }),
        )
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }

    if (message.method) {
      // Un evento de sesión se entrega a los dos quenchados: el que incluye el
      // sessionId y el que no. Así los colectores pueden afinar por sesión sin
      // perder al resto de oyentes.
      const key = message.sessionId ? `${message.sessionId}:${message.method}` : message.method
      for (const handler of this.#listeners.get(key) ?? []) this.#fire(handler, message)
      for (const handler of this.#listeners.get(message.method) ?? []) this.#fire(handler, message)
    }
  }

  #fire(handler: (params: any, sessionId?: string) => void, message: any) {
    try {
      handler(message.params ?? {}, message.sessionId)
    } catch {
      // un handler roto no debe tumbar el stream de eventos
    }
  }
}

interface TraceState {
  trace: { tabID: string; startedAt: number; durationMs: number } | undefined
  cpu: Map<string, string>
}

export interface LiveTab {
  readonly id: string
  readonly targetId: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly generation: number
}

/**
 * Traduce una tab opencode (`tab_<uuid>`) al targetId de Chromium que realmente
 * existe en el navegador externo. Los IDs de opencode no coinciden con los de
 * CDP, así que mantenemos el mapeo ourselves.
 */
export class TabRegistry {
  readonly cdp: CdpClient
  #byTabID = new Map<string, { id: string; targetId: string }>()
  #generation = 0
  #sessions = new Map<string, string>() // tabID → sessionId (cacheado)
  #live = new Set<string>() // sessionIds que siguen vivos

  constructor(cdp: CdpClient) {
    this.cdp = cdp
    // Una sesión CDP muere con la navegación: hay que reengancharse y, sobre
    // todo, abrir de nuevo los dominios que tuviera activados.
    cdp.on("Target.detachedFromTarget", (params: any) => {
      if (params.sessionId) this.#live.delete(params.sessionId)
    })
    cdp.on("Target.detachedFromTarget", (params: any) => {
      if (!params.targetId) return
      for (const [id, entry] of this.#byTabID) {
        if (entry.targetId !== params.targetId) continue
        this.#sessions.delete(id)
        this.#byTabID.delete(id)
      }
    })
    cdp.on("Target.sessionDetached", (params: any) => {
      if (params.sessionId) this.#live.delete(params.sessionId)
    })
  }

  /** Marca una sesión como viva; lo llama attach al resolverla. */
  markLive(sessionId: string) {
    this.#live.add(sessionId)
  }

  get generation() {
    return this.#generation
  }

  bumpGeneration() {
    this.#generation += 1
  }

  async list(): Promise<LiveTab[]> {
    const { targetInfos } = await this.cdp.send("Target.getTargets")
    const tabs: LiveTab[] = []

    for (const target of targetInfos as Array<{ targetId: string; type: string; url: string; title?: string }>) {
      if (target.type !== "page") continue
      if (target.url.startsWith("devtools://")) continue

      const existing = this.#findByTarget(target.targetId)
      const id = existing ?? `tab_${randomUUID()}`
      const previous = existing ? this.#byTabID.get(existing) : undefined

      tabs.push({
        id,
        targetId: target.targetId,
        url: target.url,
        title: target.title ?? "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        generation: this.#generation,
      })
      this.#byTabID.set(id, { ...(previous ?? {}), id, targetId: target.targetId })
    }

    // Limpia entradas cuyo target ya no existe (el usuario cerró la pestaña).
    const live = new Set(tabs.map((tab) => tab.targetId))
    for (const [id, entry] of this.#byTabID) {
      if (!live.has(entry.targetId)) this.#byTabID.delete(id)
    }

    return tabs
  }

  resolve(tabID: string): string {
    const entry = this.#byTabID.get(tabID)
    if (!entry)
      throw new CdpError(`Unknown tabID ${tabID}. Call browser.tabs.list({}) for valid IDs.`, {
        code: "tab_unavailable",
      })
    return entry.targetId
  }

  attach(tabID: string): Promise<string> {
    const targetId = this.resolve(tabID)
    // Cacheamos el sessionId por tab: `Target.attachToTarget` devuelve uno NUEVO
    // en cada llamada, y los colectores de console/red se indexan por sessionId.
    // Sin cache, cada comando abría una sesión distinta y su buffer salía
    // siempre vacío (medido: 0 mensajes, 0 peticiones).
    const cached = this.#sessions.get(tabID)
    if (cached && this.#live.has(cached)) return Promise.resolve(cached)

    return this.cdp
      .send("Target.attachToTarget", { targetId, flatten: true })
      .then(({ sessionId }: { sessionId: string }) => {
        this.#sessions.set(tabID, sessionId)
        this.#live.add(sessionId)
        return sessionId
      })
  }

  async createTarget(url?: string): Promise<{ id: string; targetId: string }> {
    const { targetId } = await this.cdp.send("Target.createTarget", { url: url ?? "about:blank" })
    const id = `tab_${randomUUID()}`
    this.#byTabID.set(id, { id, targetId })
    return { id, targetId }
  }

  async closeTarget(tabID: string) {
    const targetId = this.resolve(tabID)
    await this.cdp.send("Target.closeTarget", { targetId })
    this.#byTabID.delete(tabID)
  }

  #findByTarget(targetId: string) {
    for (const [id, entry] of this.#byTabID) if (entry.targetId === targetId) return id
    return undefined
  }
}

export interface ConsoleMessage {
  id: string
  timestampMs: number
  level: string
  text: string
  textTruncated: boolean
  source?: { url: string; line: number; column: number }
}

export interface CapturedRequest {
  id: string
  url: string
  method: string
  resourceType: string
  timestampMs: number
  statusCode?: number
  state: string
  durationMs?: number
  failure?: string
}

export interface DownloadRecord {
  id: string
  name: string
  mime: string
  bytes: number
  state: string
  __url?: string
  __guid?: string
  __data?: string
}

/**
 * Colectores de eventos por sesión CDP.
 *
 * CDP no es consulta-por-consulta: console y red son flujos. Hay que suscribirse
 * ANTES de que ocurra y acumular en memoria, igual que hace la app Electron con
 * `Runtime.consoleAPICalled` / `Network.requestWillBeSent`.
 */
export class EventCollector {
  #cdp: CdpClient
  #unsub: Array<() => void> = []
  #console = new Map<string, ConsoleMessage[]>()
  #requests = new Map<string, CapturedRequest[]>()
  #bodies = new Map<string, { request: any; response: any; postData?: string }>()
  #dialogs = new Map<string, { type: string; message: string; defaultValue: string }>()
  #downloads = new Map<string, DownloadRecord[]>()
  #attached = new Set<string>()

  constructor(cdp: CdpClient) {
    this.#cdp = cdp
  }

  /** Activa los dominios de CDP para una sesión y empieza a acumular. */
  async attach(sessionId: string | undefined, { network = true, log = true } = {}): Promise<void> {
    const sid = sessionId ?? ""

    // Idempotente: executeAction llama a attach en CADA comando. Si reiniciáramos
    // los buffers aquí, cada lectura (console/network.list) borraría justo lo que
    // venía a leer — medido: 0 mensajes y 0 peticiones siempre.
    if (this.#attached.has(sid)) return
    this.#attached.add(sid)

    this.#console.set(sid, [])
    this.#requests.set(sid, [])
    this.#downloads.set(sid, [])

    if (log) {
      await this.#cdp.send("Log.enable", {}, sessionId).catch(() => undefined)
      this.#unsub.push(
        this.#cdp.on(`${sid}:Log.entryAdded`, (params: any) => {
          const entry = params.entry ?? {}
          this.#push(this.#console, sid, {
            id: String(
              entry.source === "network" && entry.networkRequestId
                ? entry.networkRequestId
                : (entry.timestamp ?? this.#console.get(sid)?.length ?? 0),
            ),
            timestampMs: Math.round(entry.timestamp ?? 0),
            level: entry.level ?? "info",
            text: entry.text ?? "",
            textTruncated: false,
            source: entry.url
              ? { url: entry.url, line: entry.lineNumber ?? 0, column: entry.columnNumber ?? 0 }
              : undefined,
          })
        }),
      )
    }

    this.#unsub.push(
      this.#cdp.on(`${sid}:Runtime.consoleAPICalled`, (params: any) => {
        const text = (params.args ?? [])
          .map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? "")
          .join(" ")
        this.#push(this.#console, sid, {
          id: `${params.timestamp ?? 0}-${this.#console.get(sid)?.length ?? 0}`,
          timestampMs: Math.round((params.timestamp ?? 0) * 1000),
          level: levelFromType(params.type),
          text: text.slice(0, 100_000),
          textTruncated: text.length > 100_000,
        })
      }),
    )

    this.#unsub.push(
      this.#cdp.on(`${sid}:Runtime.exceptionThrown`, (params: any) => {
        const d = params.exceptionDetails ?? {}
        this.#push(this.#console, sid, {
          id: `exc-${this.#console.get(sid)?.length ?? 0}`,
          timestampMs: Math.round((params.timestamp ?? 0) * 1000),
          level: "error",
          text: d.exception?.description ?? d.text ?? "Uncaught exception",
          textTruncated: false,
        })
      }),
    )

    this.#unsub.push(
      this.#cdp.on(`${sid}:Page.javascriptDialogOpening`, (params: any) => {
        this.#dialogs.set(sid, {
          type: params.type ?? "alert",
          message: params.message ?? "",
          defaultValue: params.defaultPrompt ?? "",
        })
      }),
    )

    this.#unsub.push(
      this.#cdp.on(`${sid}:Page.javascriptDialogClosed`, () => {
        this.#dialogs.delete(sid)
      }),
    )

    this.#unsub.push(
      this.#cdp.on(`${sid}:Page.downloadWillBegin`, (params: any) => {
        this.#push(this.#downloads, sid, {
          id: `file_${String(params.guid ?? this.#downloads.get(sid)?.length ?? 0).replace(/-/g, "")}`,
          name: params.suggestedFilename ?? "download",
          mime: params.mimeType ?? "application/octet-stream",
          bytes: 0,
          state: "pending",
          __url: params.url,
          __guid: params.guid,
        })
      }),
    )

    if (!network) return
    await this.#cdp.send("Network.enable", {}, sessionId).catch(() => undefined)
    this.#unsub.push(
      this.#cdp.on(`${sid}:Network.requestWillBeSent`, (params: any) => {
        const req = params.request ?? {}
        const entry: CapturedRequest = {
          id: String(params.requestId),
          url: req.url ?? "",
          method: req.method ?? "GET",
          resourceType: resourceFromType(params.type),
          timestampMs: Math.round((params.timestamp ?? 0) * 1000),
          state: "pending",
        }
        this.#push(this.#requests, sid, entry)
        this.#bodies.set(params.requestId, { request: req, response: undefined, postData: req.postData })
      }),
    )
    this.#unsub.push(
      this.#cdp.on(`${sid}:Network.responseReceived`, (params: any) => {
        const entry = (this.#requests.get(sid) ?? []).find((r) => r.id === String(params.requestId))
        if (!entry) return
        entry.statusCode = params.response?.status ?? 0
        entry.state = "completed"
        entry.durationMs = Math.round(((params.timestamp ?? 0) - entry.timestampMs / 1000) * 1000)
        const slot = this.#bodies.get(params.requestId)
        if (slot) slot.response = params.response
      }),
    )
    this.#unsub.push(
      this.#cdp.on(`${sid}:Network.loadingFailed`, (params: any) => {
        const entry = (this.#requests.get(sid) ?? []).find((r) => r.id === String(params.requestId))
        if (!entry) return
        entry.state = "failed"
        entry.failure = params.errorText ?? "failed"
      }),
    )
  }

  consoleMessages(sessionId: string | undefined): ConsoleMessage[] {
    return this.#console.get(sessionId ?? "") ?? []
  }

  requests(sessionId: string | undefined): CapturedRequest[] {
    return this.#requests.get(sessionId ?? "") ?? []
  }

  /** bodies se indexa por requestId (único), no por sesión — de ahí el _sessionId. */
  requestBody(_sessionId: string | undefined, requestID: string) {
    return this.#bodies.get(requestID)
  }

  dialog(sessionId: string | undefined) {
    return this.#dialogs.get(sessionId ?? "") ?? null
  }

  downloads(sessionId: string | undefined): DownloadRecord[] {
    return this.#downloads.get(sessionId ?? "") ?? []
  }

  dispose() {
    for (const off of this.#unsub) off()
    this.#unsub = []
  }

  #push<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const list = map.get(key) ?? []
    list.push(value)
    map.set(key, list)
  }
}

const levelFromType = (type: string) =>
  type === "error" || type === "assert" ? "error" : type === "warning" ? "warning" : type === "debug" ? "debug" : "info"

const RESOURCE_BY_TYPE: Record<string, string> = {
  Document: "document",
  Stylesheet: "stylesheet",
  Image: "image",
  Media: "media",
  Font: "font",
  Script: "script",
  XHR: "xhr",
  Fetch: "fetch",
  EventSource: "eventsource",
  WebSocket: "websocket",
  Manifest: "manifest",
}

const resourceFromType = (type: string) => RESOURCE_BY_TYPE[type] ?? "other"

/**
 * Opciones del WebSocket para conexiones remotas.
 *
 * El cliente CDP nativo de Chrome NO habla TLS ni pide cabeceras: expone un
 * websocket en claro y sin auth. Por eso, para un navegador en otra máquina lo
 * normal es interponer un túnel/proxy inverso (ssh -L, tailscale, cloudflared,
 * stunnel, nginx) y apuntar aquí al `wss://` que publica ese proxy. De ahí que
 * soportemos cabeceras y un CA propio.
 */
function createSocket(url: string, { headers, tls }: { headers?: Record<string, string>; tls?: TlsOptions } = {}) {
  const options: Record<string, unknown> = {}
  if (headers && Object.keys(headers).length > 0) options.headers = headers
  if (tls?.ca) options.ca = tls.ca
  if (tls?.rejectUnauthorized !== undefined) options.rejectUnauthorized = tls.rejectUnauthorized
  return new NodeWebSocket(url, options)
}
