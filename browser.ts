/**
 * Módulo `browser` de opencode-apex.
 *
 * QUÉ HACE Y POR QUÉ NO SUSTITUYE NADA
 *
 * El plugin-browser del host publica el RPC `experimental.browser` y sus tools
 * `browser.*`; su `connection.ts` mantiene un `Map<sessionID, Attachment>` que
 * solo se llena con un `attach`. En un servidor sin la app de escritorio ese
 * mapa está vacío y todas las tools fallan con "browser is disconnected".
 *
 * Este módulo llena ese mapa. Es el mismo cliente CDP que `oc-browser-bridge`
 * hacía por HTTP, pero las cuatro llamadas que allí eran cable ahora son
 * funciones dentro del proceso:
 *
 *   POST /api/rpc/…/attach   →  ctx.rpc(Browser.Definition).attach(…)
 *   SSE /api/event           →  ctx.event.subscribe()
 *   POST …/command           →  ctx.rpc(…).command(…)
 *   POST …/result            →  ctx.rpc(…).result(…)
 *   WebSocket CDP            →  IGUAL (lo único que no cambia)
 *
 * No se sustituye el `execute` de las tools ni se pisa el RPC: los nombres,
 * schemas, permisos y descripciones siguen siendo los del host.
 *
 * EL LÍMITE DEL PROTOCOLO
 *
 * `connection.ts:59` hace `close(sessionID, "replaced")` en cada attach, así que
 * solo hay un attachment por sesión y el plugin y la app Electron nunca
 * coexisten en la misma. Por eso "elegir navegador" es elegir QUIÉN se engancha,
 * y de ahí los tres modos: `in-app` no se engancha (y suelta el que haya);
 * `external` y `auto` enganchan solo cuando alguien lo pide — `browser.target`
 * (agente) o `/browser-target` (usuario) —, nunca en cada tool call.
 */

import { Cause, Effect, Fiber, Result, Scope as ScopeService, Stream } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Browser } from "@opencode/plugin-browser/rpc"
import { readFileSync } from "node:fs"
import { CdpClient, CdpError, EventCollector, TabRegistry, type TlsOptions } from "./browser/cdp.js"
import { executeAction } from "./browser/actions.js"

const PROTOCOL_VERSION = 4
/** Mismo límite que browser-chromium.ts:451. */
const MAX_RESULT_CHARS = 512_000

type Scope = import("effect").Scope.Scope

export type BrowserMode = "in-app" | "external" | "auto"

export interface BrowserConfigShape {
  enabled: boolean
  mode: BrowserMode
  cdpUrl: string
  profile: string
  connectTimeoutMs: number
  reconnectSeconds: number
  headers: Record<string, string>
  caFile: string
  insecureSkipVerify: boolean
}

export function createDefaultBrowserConfig(): BrowserConfigShape {
  return {
    enabled: true,
    mode: "auto",
    cdpUrl: "auto",
    profile: "",
    connectTimeoutMs: 90_000,
    reconnectSeconds: 15,
    headers: {},
    caFile: "",
    insecureSkipVerify: false,
  }
}

/** El estado del enlace, en los cuatro modos. */
interface Link {
  cdp: CdpClient | undefined
  error: string | undefined
  pending: Promise<CdpClient> | undefined
}

interface Session {
  connectionID: string
  tabs: TabRegistry
  collectors: EventCollector
  /**
   * La fibra del `attach`. Hace falta para soltarla de verdad: el attachment del
   * servidor vive dentro del scope de esa llamada (connection.ts:76), así que
   * solo se cierra al INTERRUMPIRLA, no con un return.
   */
  fiber: import("effect").Fiber.Fiber<unknown, unknown> | undefined
}

export function register(ctx: Plugin.Context, config: BrowserConfigShape): Effect.Effect<void, never, Scope> {
  return Effect.gen(function* () {
    const rpc = ctx.rpc(Browser.Definition)
    // El scope del plugin, no el de quien llame: la fibra que sostiene el
    // `attach` (un long-poll) debe sobrevivir al comando que la dispara y
    // morir solo cuando el plugin se descarga.
    const pluginScope = yield* Effect.scope

    // El modo efectivo lo cambia el comando del usuario o la tool del agente;
    // la config es solo el punto de partida.
    const modeState: { current: BrowserMode; source: string } = { current: config.mode, source: "config" }

    // El destino CDP arranca en la config y lo puede cambiar browser.target en
    // caliente. Se guarda aparte de `config` porque reconectar exige cerrar el
    // socket viejo: si leyéramos `config` en cada intento, un destino distinto
    // no se notaría y seguiríamos hablando con el navegador anterior.
    const target: { cdpUrl: string; profile: string } = { cdpUrl: config.cdpUrl, profile: config.profile }

    // El CDP se conecta UNA vez y se mantiene vivo. En el modo toggle de Chrome
    // cada conexión abre un popup "Allow remote debugging?", así que reconectar
    // por comando es exactamente lo que hay que evitar.
    const link: Link = { cdp: undefined, error: undefined, pending: undefined }

    // sessionID → recursos vivos. El TabRegistry mantiene el cache de sessionId
    // por tab y los colectores los buffers de console/red: si se recrearan por
    // comando, cada lectura perdería justo lo que venía a leer.
    const sessions = new Map<string, Session>()

    const connect: Effect.Effect<CdpClient, Error> = Effect.gen(function* () {
      if (link.cdp) return link.cdp
      // Dos llamadas concurrentes comparten el mismo intento: sin esto, el hook
      // y un comando simultáneo abrirían dos sockets y dos popups.
      if (link.pending) return yield* Effect.promise(() => link.pending as Promise<CdpClient>)

      const attempt = CdpClient.connect({
        cdpUrl: target.cdpUrl,
        profileDir: target.profile || undefined,
        headers: config.headers,
        tls: tlsOptions(target.cdpUrl, config),
        timeoutMs: config.connectTimeoutMs,
      }).then(
        (client) => {
          link.cdp = client
          link.error = undefined
          link.pending = undefined
          return client
        },
        (error: Error) => {
          link.error = error.message
          link.pending = undefined
          throw error
        },
      )
      link.pending = attempt
      return yield* Effect.promise(() => attempt)
    })

    /**
     * Suelta el navegador: cierra los attachments y el socket CDP.
     *
     * Necesario al cambiar de destino. Los recursos de cada sesión están atados
     * al socket viejo (TabRegistry con sus sessionIds, colectores con sus
     * buffers), así que reconectar sin tirarlos dejaría un TabRegistry hablando
     * con un socket que ya no existe.
     *
     * Va al final porque se llama desde el `hold`, que se reencamina a sí mismo
     * al reconectar; cerrarlo antes dejaría al `hold` viejo reconectando.
     */
    const disconnect = (sessionID?: string) =>
      Effect.gen(function* () {
        // Hay que interrumpir la fibra del attach, no solo olvidarla: el
        // attachment del servidor se cierra con el scope de esa llamada
        // (connection.ts:76), y sin interrupción el servidor seguiría creyendo
        // que tenemos el navegador —y cualquier tool browser.* seguiría yendo a
        // un Chromium que ya no controlamos.
        const drop = function* (session: Session) {
          session.collectors.dispose()
          if (session.fiber) yield* Fiber.interrupt(session.fiber)
        }
        if (sessionID) {
          const session = sessions.get(sessionID)
          if (!session) return
          yield* drop(session)
          sessions.delete(sessionID)
          return
        }
        for (const session of sessions.values()) yield* drop(session)
        sessions.clear()
        link.cdp?.close()
        link.cdp = undefined
        link.pending = undefined
        link.error = undefined
      })

    const describe = () => ({
      mode: modeState.current,
      source: modeState.source,
      target: { cdpUrl: target.cdpUrl, profile: target.profile || null },
      connected: link.cdp
        ? {
            profile: link.cdp.endpoint?.profileDir ?? null,
            cdp: link.cdp.endpoint?.webSocketDebuggerUrl ?? null,
            how: link.cdp.endpoint?.how ?? null,
          }
        : null,
      attached: [...sessions.keys()],
      error: link.error ?? null,
    })

    const stateOf = (tabs: Awaited<ReturnType<TabRegistry["list"]>>): Browser.State => ({
      tabs: tabs.map((t) => ({
        id: t.id as Browser.TabID,
        url: t.url,
        title: t.title,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        generation: t.generation,
      })),
      focusedTabID: (tabs[0]?.id ?? null) as Browser.TabID | null,
    })

    const runCommand = Effect.fn("apex.browser.command")(function* (
      sessionID: string,
      connectionID: string,
      requestID: string,
    ) {
      const cdp = yield* connect
      // Reutilizamos los recursos del attachment: un TabRegistry nuevo perdería
      // el cache de sessionId por tab y los colectores recargarían sus buffers.
      const live = sessions.get(sessionID)
      const tabs = live?.tabs ?? new TabRegistry(cdp)
      const collectors = live?.collectors ?? new EventCollector(cdp)

      // Effect.result y no try/catch: un DEFECTO (un throw de JS dentro de
      // Effect.promise) no lo captura el try/catch del generador, se propaga y
      // aquí se lo tragaría la fibra. Con result todo vuelve por el mismo
      // camino y siempre se responde, que es lo que espera el servidor.
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          const command = yield* rpc.command({ sessionID: sessionID as never, connectionID, requestID })
          const { __file, ...value } = yield* Effect.promise(() =>
            executeAction(command.action, { cdp, tabs, collectors, command }),
          )
          if (JSON.stringify(value).length > MAX_RESULT_CHARS) {
            throw new CdpError(
              `Browser result exceeds ${MAX_RESULT_CHARS} JSON characters. ` +
                `Ask for fewer items, a shallower snapshot, or only the fields you need.`,
              { code: "result_too_large" },
            )
          }
          // El estado se publica ANTES de responder: el servidor acaba de validar
          // el tabID contra su copia del inventario, y abrir una pestaña la
          // devuelve con un id que todavía no conoce. El cliente Electron hace
          // lo mismo (browser-pane.ts:161-173).
          yield* publishState(sessionID, connectionID)
          return {
            type: "success" as const,
            result: {
              value: value as never,
              // `data` entra como base64: Schema.Uint8ArrayFromBase64 lo
              // decodifica al pasar por el RPC, así que aquí van los bytes en b64.
              files: __file
                ? [
                    {
                      id: `file_${crypto.randomUUID()}` as Browser.FileID,
                      name: __file.name,
                      mime: __file.mime,
                      data: Buffer.from(__file.data).toString("base64"),
                    },
                  ]
                : [],
            },
          }
        }).pipe(Effect.catchDefect((defect) => Effect.fail(causeOf(defect)))),
      )

      const failure = Result.isSuccess(outcome)
        ? outcome.success
        : {
            type: "failure" as const,
            code: outcome.failure instanceof CdpError ? outcome.failure.code : "bridge_error",
            message: outcome.failure.message,
          }

      if (failure.type === "failure") {
        yield* Effect.logWarning(`[apex.browser] comando fallido ${requestID}: ${failure.code} ${failure.message}`)
      }
      yield* rpc
        .result({ sessionID: sessionID as never, connectionID, requestID, outcome: failure as never })
        .pipe(Effect.catch(() => Effect.void))
    })

    /**
     * Publica el inventario hasta que el servidor lo acepte.
     *
     * `state` exige que el attachment ya exista (connection.ts:80), y el
     * attachment solo se crea dentro de `attach`, que además no retorna hasta
     * que se cierre. Como `attach` va en background, el primer `state` siempre
     * llega antes: hay que reintentarlo hasta que cuaje.
     */
    const publishState = Effect.fn("apex.browser.state")(function* (
      sessionID: string,
      connectionID: string,
      attempts = 5,
    ) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        // El TabRegistry de la sesión, NUNCA uno nuevo: los tabID opencode los
        // genera él y se los recuerda. Un registro distinto inventaría ids
        // distintos para la misma pestaña y el servidor no coincidiría.
        const tabs = sessions.get(sessionID)?.tabs
        if (!tabs) return false
        const list = yield* Effect.promise(() => tabs.list())
        const ok = yield* Effect.result(
          rpc.state({ sessionID: sessionID as never, connectionID, state: stateOf(list) }),
        ).pipe(Effect.map((result) => result._tag === "Success"), Effect.catch(() => Effect.succeed(false)))
        if (ok) return true
        yield* Effect.sleep(`${Math.min(2_000, 100 * 2 ** attempt)} millis`)
      }
      return false
    })

    // `attach` es un long-poll: no retorna hasta "closed"/"replaced". Se declara
    // aparte de attachSession porque se llama a sí misma al reconectar, y una
    // función recursiva necesita su tipo anotado.
    const hold = (sessionID: string, connectionID: string): Effect.Effect<void, never, Scope> =>
      Effect.gen(function* () {
        const outcome = yield* rpc
          .attach({ sessionID: sessionID as never, connectionID, version: PROTOCOL_VERSION })
          .pipe(Effect.catch((error) => Effect.succeed(`error: ${error.message}`)))
        yield* Effect.logInfo(`[apex.browser] ${sessionID} desenganchado (${outcome})`)
        // Si `disconnect` ya se llevó esta sesión (destino cambiado), sus
        // recursos ya no sirven: no hay nada que reconectar.
        if (sessions.get(sessionID)?.connectionID !== connectionID) return
        // El `replaced` de connection.ts:59 dejó fuera a la app Electron, así
        // que reconectar nosotros es lo que restaura el navegador de la sesión.
        if (modeState.current === "in-app") return
        if (config.reconnectSeconds > 0) yield* Effect.sleep(`${config.reconnectSeconds} second`)
        yield* attachSession(sessionID).pipe(Effect.catch(() => Effect.void))
      })

    const attachSession = Effect.fn("apex.browser.attach")(function* (sessionID: string) {
      if (modeState.current === "in-app" || sessions.has(sessionID)) return
      const cdp = yield* connect
      const tabs = new TabRegistry(cdp)
      const collectors = new EventCollector(cdp)
      const connectionID = crypto.randomUUID()

      const session: Session = { connectionID, tabs, collectors, fiber: undefined }
      sessions.set(sessionID, session)
      // El attach va primero (registra el attachment) y el estado detrás, con
      // reintentos hasta que el servidor lo acepte: al revés, `state` siempre
      // fallaría con "unavailable" porque el mapa todavía no tiene la sesión.
      session.fiber = yield* Effect.forkScoped(hold(sessionID, connectionID), { startImmediately: true })
      const ok = yield* publishState(sessionID, connectionID)
      yield* Effect.logInfo(
        `[apex.browser] ${sessionID} ${ok ? "enganchado" : "enganchado sin inventario"} a ${cdp.endpoint?.profileDir ?? cdp.endpoint?.how}`,
      )
    })

    /**
     * Enganche a petición: solo lo llaman `browser.target` (el agente) y
     * `/browser-target` (el usuario). Antes iba en un hook `execute.before`,
     * que reintentaba el connect en CADA tool call: con el destino caído eran
     * hasta 90 s de bloqueo por invocación, y con el toggle de Chrome un popup
     * en la primera tool que no era ni del navegador.
     */
    const attachFor = Effect.fn("apex.browser.attachFor")(function* (sessionID: string | undefined) {
      if (!sessionID) return
      // in-app no solo no engancha: suelta lo que esta sesión tuviera para que
      // la app de escritorio pueda servirla.
      if (modeState.current === "in-app") {
        yield* disconnect(sessionID)
        return
      }
      // Ya enganchada → nada que hacer: pedirla otra vez NO reinicia el socket.
      if (sessions.has(sessionID)) return
      // Se provee el scope del plugin para que la fibra del `attach` no muera
      // con la llamada que la disparó. El connect falla como DEFECTO (un throw
      // dentro de Effect.promise), así que hacen falta las dos capturas: sin
      // catchDefect el destino caído mata la tool en vez de dejar el error en
      // describe().
      yield* attachSession(sessionID).pipe(
        Effect.provideService(ScopeService.Scope, pluginScope),
        Effect.catch((error: Error) =>
          Effect.logWarning(`[apex.browser] no se pudo conectar al CDP: ${error.message}`).pipe(
            Effect.andThen(Effect.void),
          ),
        ),
        Effect.catchDefect((defect) =>
          Effect.logWarning(`[apex.browser] no se pudo conectar al CDP: ${causeOf(defect).message}`).pipe(
            Effect.andThen(Effect.void),
          ),
        ),
      )
    })

    // --- control: aquí llegan los comandos -----------------------------------
    yield* ctx.event
      .subscribe()
      .pipe(
        Stream.filter((event) => event.type === "rpc.experimental.browser.control"),
        // El comando se lanza en su propia fibra y el effect del stream termina
        // al instante. Con un mapEffect normal (que espera a que el efecto
        // termine), el segundo comando se queda en el buffer hasta que el
        // primero acaba: el stream es secuencial.
        Stream.mapEffect((event) =>
          Effect.gen(function* () {
            const control = event.data as Browser.Control
            if (control.type !== "command") return
            // El evento `command` no lleva sessionID, solo connectionID: por eso
            // el índice es sobre connectionID.
            const owner = [...sessions].find(([, session]) => session.connectionID === control.connectionID)
            if (!owner) return
            yield* Effect.forkDetach(runCommand(owner[0], control.connectionID, control.requestID))
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )

    // --- tool para que el AGENTE elija ---------------------------------------
    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "browser",
          description: "Browser control. browser.target chooses between an external Chromium over CDP and the desktop app.",
        })
        editor.add({
          name: "target",
          description:
            "Choose which browser serves this session's browser.* tools, and optionally where to reach it. " +
            "`mode: external` drives a Chromium over CDP and takes the session's attachment, so an opencode desktop " +
            "app on the same session steps aside. `in-app` releases it and lets the desktop app serve. `external` " +
            "and `auto` attach only when asked — by this tool or /browser-target — never on their own. Only one " +
            "client can hold a session's browser at a time; the other has no browser until this changes.\n\n" +
            "Destination (`cdpUrl`, `profile`) is optional and only applies to `external`. Changing it closes the " +
            "current CDP connection and reconnects this session to the new destination; sessions that were " +
            "attached drop and must ask again with this tool. Calling it is also what attaches: a session's " +
            "browser.* only work after this tool or /browser-target has asked for a browser. " +
            "`cdpUrl` is `auto` (read DevToolsActivePort from known profiles), a port like `9222`, or a full " +
            "`ws://`/`wss://` websocket URL for a remote browser behind a tunnel. `profile` is a Chromium user-data " +
            "directory (`~/` allowed); it wins over `cdpUrl` and reads that profile's DevToolsActivePort, so remote " +
            "debugging must be enabled in it (chrome://inspect/#remote-debugging). Using `external` may raise " +
            "an \"Allow remote debugging?\" prompt in the browser: approve it once, the connection is then kept open.",
          input: {
            mode: {
              type: "string",
              enum: ["external", "in-app", "auto"],
              description: "Which browser should serve browser.* for this session.",
            },
            cdpUrl: {
              type: "string",
              description:
                "Where to reach the external Chromium: `auto`, a port (`9222`), or a full `ws://host:port/path` / " +
                "`wss://…` URL. Omit to keep the current one.",
            },
            profile: {
              type: "string",
              description:
                "Chromium user-data directory to control, e.g. `~/.config/google-chrome`. Wins over cdpUrl. Omit to " +
                "keep the current one; pass an empty string to go back to cdpUrl discovery.",
            },
          },
          options: { namespace: "browser", permission: "browser", codemode: true },
          execute: (input, context) =>
            Effect.gen(function* () {
              const { mode: requestedMode, cdpUrl, profile } = input as {
                mode?: unknown
                cdpUrl?: unknown
                profile?: unknown
              }
              if (requestedMode === "external" || requestedMode === "in-app" || requestedMode === "auto") {
                modeState.current = requestedMode
                modeState.source = "browser.target"
              }

              // Destino explícito → cerrar y reencolar. Sin esto seguiríamos
              // hablando con el navegador anterior, que es lo confuso: la tool
              // aceptaría el cambio y no cambiaría nada.
              if (typeof cdpUrl === "string" || typeof profile === "string") {
                const nextUrl = typeof cdpUrl === "string" ? cdpUrl : target.cdpUrl
                const nextProfile = typeof profile === "string" ? profile : target.profile
                if (nextUrl !== target.cdpUrl || nextProfile !== target.profile) {
                  yield* disconnect()
                  target.cdpUrl = nextUrl || "auto"
                  target.profile = nextProfile
                  yield* Effect.logInfo(
                    `[apex.browser] destino → ${target.profile || target.cdpUrl} · esta sesión se reengancha`,
                  )
                }
              }

              // El enganche ocurre AQUÍ y solo aquí: pedir navegador para esta
              // sesión. Un hook execute.before lo hacía en cada tool call y con
              // el destino caído eso eran hasta 90 s de bloqueo por invocación.
              yield* attachFor(context.sessionID)

              return { output: describe() }
            }),
        })
      })
      .pipe(Effect.orDie)

    // --- comando para que lo elija el USUARIO --------------------------------
    yield* ctx.command
      .transform((editor) => {
        editor.add({
          name: "browser-target",
          description:
            "Choose the browser that serves browser.*: external (CDP), in-app (desktop app), or auto. Optional " +
            "destination: `/browser-target external 9333`, `/browser-target external ws://host:port/path`, or " +
            "`/browser-target external ~/.config/google-chrome`.",
          execute: (input) =>
            Effect.gen(function* () {
              // El prompt llega como texto libre: `external 9333`, o solo
              // `external` para no cambiar el destino.
              const [arg, destination] = String(input.prompt ?? "").trim().split(/\s+/)
              if (arg !== "external" && arg !== "in-app" && arg !== "auto") return
              modeState.current = arg
              modeState.source = "/browser-target"
              if (destination) {
                // Un destino que empieza por / o ~ es un perfil; el resto, una
                // URL o un puerto. Igual que la tool: si cambia, cerrar el
                // socket; si no, tocar nada (reconectar contra un destino
                // caído es un popup perdido o 90 s de bloqueo).
                const isProfile = destination.startsWith("/") || destination.startsWith("~")
                const nextProfile = isProfile ? destination : ""
                const nextUrl = isProfile ? target.cdpUrl : destination
                if (nextUrl !== target.cdpUrl || nextProfile !== target.profile) {
                  yield* disconnect()
                  target.cdpUrl = nextUrl || "auto"
                  target.profile = nextProfile
                  yield* Effect.logInfo(
                    `[apex.browser] destino → ${target.profile || target.cdpUrl} · esta sesión se reengancha`,
                  )
                }
              }
              // El usuario lo pide aquí: engancha (o suelta, en in-app) la
              // sesión que ejecuta el comando.
              yield* attachFor(input.sessionID)
            }),
        })
      })
      .pipe(Effect.orDie)

    yield* Effect.logInfo(
      `[apex.browser] listo · modo=${modeState.current} (${modeState.source}) · destino=${target.profile || target.cdpUrl}`,
    )
  })
}

/** Cause de Effect a Error legible: los defectos llegan envueltos. */
const causeOf = (defect: unknown) =>
  Cause.isCause(defect) ? new Error(Cause.pretty(defect)) : defect instanceof Error ? defect : new Error(String(defect))

/** Opciones TLS para un endpoint wss:// remoto (detrás de un proxy inverso). */
function tlsOptions(cdpUrl: string, config: BrowserConfigShape): TlsOptions | undefined {
  if (!cdpUrl.startsWith("wss://")) return undefined
  const tls: { ca?: Buffer; rejectUnauthorized?: boolean } = {}
  if (config.caFile) tls.ca = readFileSync(config.caFile)
  if (config.insecureSkipVerify) tls.rejectUnauthorized = false
  return Object.keys(tls).length > 0 ? tls : { rejectUnauthorized: true }
}
