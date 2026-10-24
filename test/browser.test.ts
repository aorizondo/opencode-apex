/**
 * El módulo browser contra un Chromium real.
 *
 * Reproduce el ciclo entero del protocolo sin el servidor: el harness implementa
 * los handlers de `connection.ts` con su semántica real (un attachment por
 * sesión, `replaced` al reenganchar, `command` encolado hasta que el cliente lo
 * pide). Es el equivalente in-process de lo que hacía oc-browser-bridge por
 * HTTP, pero sobre el mismo Chromium que ya está verificado.
 */
import { test, expect, beforeAll, afterAll } from "bun:test"
import { Effect, Exit, Queue, Scope as ScopeService, Stream } from "effect"
import { Browser } from "@opencode/plugin-browser/rpc"
import { CdpClient } from "../browser/cdp.js"
import { resolveEndpoint } from "../browser/endpoint.js"
import { createDefaultBrowserConfig, register } from "../browser.js"

/** Los schemas de Browser usan tipos branded; los tests los construyen a mano. */
const TabID = (value: string) => value as Browser.TabID

let cdp: CdpClient

beforeAll(async () => {
  const endpoint = await resolveEndpoint({ cdpUrl: process.env.TEST_CDP_URL ?? "auto" })
  const first = endpoint.candidates[0]
  if (!first) throw new Error("sin candidatos CDP")
  cdp = await CdpClient.connect({ cdpUrl: first.webSocketDebuggerUrl, timeoutMs: 30_000 })
})

afterAll(() => cdp?.close())

interface Attachment {
  connectionID: string
  state: Browser.State
  closed: (reason: "closed" | "replaced") => void
}

/**
 * Los handlers de connection.ts, sin el Effect del servidor pero con las misma
 * reglas: `attach` reemplaza al anterior, `state`/`command`/`result` exigen que
 * el connectionID coincida, y el comando vive encolado hasta que se pide.
 */
function makeHarness() {
  const browsers = new Map<string, Attachment>()
  const pending = new Map<string, { command: Browser.Command; reply: (o: Browser.Outcome) => void }>()
  // El plugin se suscribe con ctx.event.subscribe(); una Queue es el equivalente
  // más cercano al bus de eventos del host.
  const control = Effect.runSync(Queue.make<{ type: string; data: Browser.Control }>())
  let nextID = 0

  const emit = (data: Browser.Control) => {
    void Effect.runPromise(Queue.offer(control, { type: "rpc.experimental.browser.control", data }))
  }

  const controlStream = () => Stream.fromQueue(control)

  const client = {
    attach: (input: { sessionID: string; connectionID: string; version: number }) =>
      // Effect.callback y no Effect.promise porque da el AbortSignal, y hace
      // falta: connection.ts:76 mete el attachment en un scope, así que
      // interrumpir la llamada es lo que lo cierra. Sin esta pieza el harness
      // mentiría y un disconnect mal hecho pasaría el test.
      Effect.callback<"closed" | "replaced", Error>((resume, signal) => {
        browsers.get(input.sessionID)?.closed("replaced")
        browsers.set(input.sessionID, {
          connectionID: input.connectionID,
          state: { tabs: [], focusedTabID: null },
          closed: (reason) => {
            browsers.delete(input.sessionID)
            resume(Effect.succeed(reason))
          },
        })
        signal.addEventListener("abort", () => {
          browsers.delete(input.sessionID)
          resume(Effect.fail(new Error("aborted")))
        })
      }),
    state: (input: { sessionID: string; connectionID: string; state: Browser.State }) =>
      Effect.sync(() => {
        const browser = browsers.get(input.sessionID)
        if (!browser || browser.connectionID !== input.connectionID) throw new Error("unavailable")
        browser.state = input.state
      }),
    command: (input: { sessionID: string; connectionID: string; requestID: string }) =>
      Effect.sync(() => {
        const entry = pending.get(input.requestID)
        if (!entry) throw new Error("unavailable")
        return entry.command
      }),
    result: (input: { sessionID: string; connectionID: string; requestID: string; outcome: Browser.Outcome }) =>
      Effect.sync(() => {
        const browser = browsers.get(input.sessionID)
        if (!browser || browser.connectionID !== input.connectionID) throw new Error("unavailable")
        pending.get(input.requestID)?.reply(input.outcome)
      }),
    events: { subscribe: (_name: string) => Stream.make() as never },
  }

  /** Lo que hace connection.ts:173 request() al lanzar una tool. */
  const request = (sessionID: string, action: Browser.Action) => {
    const browser = browsers.get(sessionID)
    if (!browser) return Promise.reject(new Error("browser.disconnected"))
    const tab = "tabID" in action ? browser.state.tabs.find((t) => t.id === action.tabID) : undefined
    // El servidor valida el tabID contra SU inventario, igual que aquí.
    if ("tabID" in action && !tab) return Promise.reject(new Error(`browser.tab_unavailable ${action.tabID}`))
    const requestID = `req-${++nextID}`
    const result = new Promise<Browser.Result>((resolve, reject) => {
      pending.set(requestID, {
        command: { action, files: [], inspect: false, target: { resources: [], key: "" } } as Browser.Command,
        reply: (outcome) => {
          pending.delete(requestID)
          if (outcome.type === "failure") reject(new Error(`${outcome.code}: ${outcome.message}`))
          else resolve(outcome.result)
        },
      })
    })
    emit({ type: "command", connectionID: browser.connectionID, requestID })
    return result
  }

  return { browsers, client, request, emit, controlStream }
}

/** Registra el plugin y, salvo `attach: false`, pide el enganche como haría el agente. */
async function startPlugin(sessionID: string, options: { attach?: boolean } = {}) {
  const harness = makeHarness()
  const hooks: string[] = []
  const tools: string[] = []
  const commands: string[] = []
  // La tool browser.target y el comando browser-target, para poder invocarlos.
  const registered: Array<{ name: string; execute?: (input: any, context?: any) => Effect.Effect<any> }> = []

  const ctx = {
    rpc: () => harness.client,
    event: { subscribe: () => harness.controlStream() },
    tool: {
      // Solo anotamos el nombre: el plugin no debe enganchar en ningún hook, y
      // si vuelve a hacerlo el test lo ve aquí.
      hook: (name: string, _callback: unknown) =>
        Effect.sync(() => {
          hooks.push(name)
          return { dispose: Effect.void }
        }),
      transform: (callback: (editor: any) => void) =>
        Effect.sync(() => {
          callback({
            namespace: () => undefined,
            add: (tool: { name: string; execute?: (input: any, context?: any) => Effect.Effect<any> }) => {
              tools.push(tool.name)
              if (tool.name === "target") registered.push(tool)
            },
          })
          return { dispose: Effect.void }
        }),
    },
    command: {
      transform: (callback: (editor: any) => void) =>
        Effect.sync(() => {
          callback({
            add: (command: { name: string; execute?: (input: any) => Effect.Effect<any> }) => {
              commands.push(command.name)
              registered.push(command as never)
            },
          })
          return { dispose: Effect.void }
        }),
    },
  }

  // El scope del plugin tiene que VIVIR: es el que sostiene la suscripción al
  // bus de control y la fibra del attach (un long-poll). En el host dura lo que
  // el plugin; aquí se abre a mano y se cierra al final del test.
  const scope = Effect.runSync(ScopeService.make())
  const exit = await Effect.runPromiseExit(
    register(ctx as never, {
      ...createDefaultBrowserConfig(),
      mode: "external",
      cdpUrl: process.env.TEST_CDP_URL ?? "auto",
      profile: "",
      connectTimeoutMs: 20_000,
    }).pipe(Effect.provideService(ScopeService.Scope, scope)),
  )
  if (exit._tag === "Failure") throw new Error(`register falló: ${exit.cause}`)

  /** Invoca browser.target({ mode, cdpUrl, profile }); el host le pasa Tool.Context. */
  async function invokeTarget(input: Record<string, unknown>) {
    const tool = registered.find((entry) => entry.name === "target")
    if (!tool?.execute) throw new Error("browser.target no está registrada")
    const result = await Effect.runPromise(tool.execute(input, { sessionID }))
    return result.output
  }

  /** Invoca /browser-target con texto libre. */
  async function invokeCommand(prompt: string) {
    const command = registered.find((entry) => entry.name === "browser-target")
    if (!command?.execute) throw new Error("/browser-target no está registrado")
    await Effect.runPromise(command.execute({ sessionID, prompt, delivery: "queue" }))
  }

  // El enganche es a petición: aquí se pide como lo haría el agente
  // (browser.target), no con un hook. `attach: false` deja la sesión sin
  // navegador para probar que no se engancha sola.
  if (options.attach !== false) {
    await invokeTarget({ mode: "external" })
    // El attach es un long-poll: damos un turno al runtime para que se registre.
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  return {
    harness,
    hooks,
    tools,
    commands,
    /** Invoca browser.target({ mode, cdpUrl, profile }) y devuelve su describe(). */
    target: invokeTarget,
    /** Invoca /browser-target con texto libre. */
    command: invokeCommand,
    async stop() {
      await Effect.runPromise(ScopeService.close(scope, Exit.void))
    },
  }
}

test("registra la tool del agente y el comando del usuario", async () => {
  const { tools, commands } = await startPlugin("ses_test_tools")
  expect(tools).toContain("target")
  expect(commands).toContain("browser-target")
}, 60_000)

test("el enganche publica el estado y una tool browser.* encuentra sus pestañas", async () => {
  const { harness } = await startPlugin("ses_test_state")
  const browser = harness.browsers.get("ses_test_state")
  expect(browser).toBeDefined()
  // El estado se publica ANTES del attach, para que el servidor sepa validar tabID.
  expect(browser!.state.tabs.length).toBeGreaterThan(0)
  const tab = browser!.state.tabs[0]!
  expect(tab.id).toMatch(/^tab_/)
}, 60_000)

test("tabs.list devuelve el inventario real del Chromium", async () => {
  const { harness } = await startPlugin("ses_test_list")
  const result = await harness.request("ses_test_list", { type: "tabs.list" })
  const value = result.value as { tabs: unknown[]; focusedTabID: string | null }
  expect(Array.isArray(value.tabs)).toBe(true)
  expect(value.tabs.length).toBeGreaterThan(0)
}, 60_000)

test("abre una pestaña, la navega y lee su contenido", async () => {
  const sessionID = "ses_test_nav"
  const { harness } = await startPlugin(sessionID)

  const opened = await harness.request(sessionID, { type: "tabs.open", url: "https://example.com", focus: false })
  const tabID = TabID((opened.value as { id: string }).id)
  expect(tabID).toMatch(/^tab_/)

  // El servidor acaba de recibir el estado post-comando, así que ya valida este id.
  const found = await harness.request(sessionID, { type: "snapshot", tabID })
  expect((found.value as { content: string }).content).toContain("Example Domain")

  const evaluated = await harness.request(sessionID, {
    type: "evaluate",
    tabID,
    script: "document.title + '|' + location.host",
  })
  expect((evaluated.value as { value: string }).value).toBe("Example Domain|example.com")

  await harness.request(sessionID, { type: "tabs.close", tabID })
}, 90_000)

test("un comando fallido vuelve como failure, no como silencio", async () => {
  const sessionID = "ses_test_fail"
  const { harness } = await startPlugin(sessionID)
  const state = await harness.request(sessionID, { type: "tabs.list" })
  const tabID = TabID((state.value as { tabs: Array<{ id: string }> }).tabs[0]!.id)

  // trace.analyze no está implementado: debe fallar con `unsupported` y un texto
  // accionable, no colgarse hasta el timeout de 60s del servidor.
  await expect(
    harness.request(sessionID, { type: "trace.analyze", tabID, fileID: "file_x" as never }),
  ).rejects.toThrow(/does not implement/)
}, 30_000)

test("browser.target cambia el destino y suelta la conexión anterior", async () => {
  const sessionID = "ses_test_target"
  const { harness, target } = await startPlugin(sessionID)
  expect(harness.browsers.has(sessionID)).toBe(true)

  // Cambiar el destino tiene que cerrar el socket y soltar los attachments: si
  // no, el TabRegistry de la sesión seguiría hablando con un socket cerrado y el
  // siguiente comando fallaría. Este es el fallo que da la tool "correcta" pero
  // que no hace nada. 9444 y no 9222: al reconectar ya en la propia tool, un
  // 9222 con DevToolsActivePort stale acabaría enganchándose al Chrome real.
  const next = await target({ mode: "external", cdpUrl: "9444" })
  expect(next.target.cdpUrl).toBe("9444")
  expect(next.connected).toBeNull()
  expect(next.attached).toEqual([])
  expect(harness.browsers.has(sessionID)).toBe(false)
}, 60_000)

test("el destino por perfil gana sobre cdpUrl", async () => {
  const sessionID = "ses_test_profile"
  const { target } = await startPlugin(sessionID)

  const withProfile = await target({ mode: "external", profile: "/tmp/opencode/cdp-probe" })
  expect(withProfile.target.profile).toBe("/tmp/opencode/cdp-probe")

  // Perfil vacío = vuelta a descubrir por cdpUrl.
  const cleared = await target({ mode: "external", profile: "" })
  expect(cleared.target.profile).toBeNull()
  expect(cleared.target.cdpUrl).toBe(process.env.TEST_CDP_URL ?? "auto")
}, 60_000)

test("in-app no engancha y suelta el attachment; external sí", async () => {
  const sessionID = "ses_test_mode"
  const { harness, target } = await startPlugin(sessionID)
  expect(harness.browsers.has(sessionID)).toBe(true)

  const state = await target({ mode: "in-app" })
  expect(state.mode).toBe("in-app")
  expect(state.source).toBe("browser.target")
  // in-app deja el destino intacto: solo decide quién se engancha, y en este
  // caso además suelta el attachment de la sesión para la app de escritorio.
  expect(state.target.cdpUrl).toBe(process.env.TEST_CDP_URL ?? "auto")
  expect(harness.browsers.has(sessionID)).toBe(false)
  expect(state.attached).toEqual([])
}, 60_000)

test("no engancha en cada llamada: solo browser.target o el comando lo piden", async () => {
  const sessionID = "ses_test_explicit"
  const { harness, hooks, target } = await startPlugin(sessionID, { attach: false })

  // Registrado y sin petición → sin attachment. Un hook execute.before aquí
  // reintentaría el connect (hasta 90 s) en cada tool call del host.
  expect(hooks).not.toContain("execute.before")
  expect(harness.browsers.has(sessionID)).toBe(false)
  await expect(harness.request(sessionID, { type: "tabs.list" })).rejects.toThrow("browser.disconnected")

  await target({ mode: "external" })
  expect(harness.browsers.has(sessionID)).toBe(true)

  // Pedirlo otra vez NO reinicia la conexión: mismo attachment, mismo socket.
  const connectionID = harness.browsers.get(sessionID)!.connectionID
  await target({ mode: "external" })
  expect(harness.browsers.get(sessionID)!.connectionID).toBe(connectionID)
}, 60_000)

test("/browser-target acepta destino como texto libre", async () => {
  const sessionID = "ses_test_cmd"
  const { command, target } = await startPlugin(sessionID)

  await command("external 9444")
  let state = await target({})
  expect(state.mode).toBe("external")
  expect(state.target.cdpUrl).toBe("9444")

  // Un destino con / o ~ es un perfil, no un puerto.
  await command("external /tmp/opencode/cdp-probe")
  state = await target({})
  expect(state.target.profile).toBe("/tmp/opencode/cdp-probe")

  // Sin destino = no cambiar de destino.
  await command("in-app")
  state = await target({})
  expect(state.mode).toBe("in-app")
  expect(state.target.profile).toBe("/tmp/opencode/cdp-probe")
}, 60_000)

