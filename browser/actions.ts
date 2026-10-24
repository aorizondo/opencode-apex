/**
 * Ejecutor de Browser.Action contra el Chromium externo.
 *
 * Cada handler devuelve un valor JSON-serializable que el servidor valida contra
 * el schema de salida de la operación. Cuando no sabemos hacerlo, fallamos con
 * `unsupported` en vez de colgar el comando: el plugin-browser tiene timeout de
 * 60s y una respuesta honesta es mejor que un silencio.
 */

import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Browser } from "@opencode/plugin-browser/rpc"
import { CdpClient, CdpError, EventCollector, TabRegistry, type LiveTab } from "./cdp.js"

const MAX_TEXT = 100_000

const unsupported = (op: string) =>
  new CdpError(
    `The external browser bridge does not implement browser.${op}. ` +
      `It drives a Chromium over CDP; this one needs a desktop Review pane or an analyzer runtime.`,
    { code: "unsupported" },
  )

export interface ActionContext {
  readonly cdp: CdpClient
  readonly tabs: TabRegistry
  readonly collectors: EventCollector
  readonly command: Browser.Command
}

/** El `__file` se extrae aparte: los bytes van en `files`, no en `value`. */
export interface FilePayload {
  readonly name: string
  readonly mime: string
  readonly data: Uint8Array
}

export type ActionResult = Record<string, unknown> & { __file?: FilePayload }

export async function executeAction(action: Browser.Action, ctx: ActionContext): Promise<ActionResult> {
  const { cdp, tabs, collectors, command } = ctx
  const tab = async (id: string) => publicTab((await tabs.list()).find((t) => t.id === id))

  switch (action.type) {
    // ---------------------------------------------------------------- tabs
    case "tabs.list": {
      const list = await tabs.list()
      return { tabs: list.map(publicTab), focusedTabID: list[0]?.id ?? null }
    }

    case "tabs.open": {
      const { id } = await tabs.createTarget(action.url ?? "about:blank")
      await waitForLoad(cdp, tabs, id)
      // Los colectores deben engancharse ANTES de que ocurra nada: console y
      // red son flujos y si nos suscribimos al leer, lo que pasó antes se perdió.
      await collectors.attach(await tabs.attach(id))
      return await tab(id)
    }

    case "tabs.focus": {
      const sessionId = await tabs.attach(action.tabID)
      await cdp.send("Page.bringToFront", {}, sessionId)
      return await tab(action.tabID)
    }

    case "tabs.close": {
      await tabs.closeTarget(action.tabID)
      const list = await tabs.list()
      return { tabs: list.map(publicTab), focusedTabID: list[0]?.id ?? null }
    }

    case "preview":
      // Requiere el panel de review de una app desktop; un cliente CDP sin
      // ventana no tiene a quién mostrárselo.
      throw unsupported("preview")

    // ----------------------------------------------------------- navegación
    case "navigate": {
      const sessionId = await tabs.attach(action.tabID)
      await collectors.attach(sessionId)
      await cdp.send("Page.navigate", { url: action.url }, sessionId)
      await waitForLoad(cdp, tabs, action.tabID)
      return await tab(action.tabID)
    }

    case "back":
    case "forward":
    case "reload":
    case "stop": {
      const sessionId = await tabs.attach(action.tabID)
      if (action.type === "back" || action.type === "forward") {
        const { entries, currentIndex } = await cdp.send("Page.getNavigationHistory", {}, sessionId)
        const entry = entries[action.type === "back" ? currentIndex - 1 : currentIndex + 1]
        if (entry) {
          await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId)
          await waitForLoad(cdp, tabs, action.tabID)
        }
      } else {
        await cdp.send(action.type === "reload" ? "Page.reload" : "Page.stopLoading", {}, sessionId)
      }
      return await tab(action.tabID)
    }

    case "frames": {
      const sessionId = await tabs.attach(action.tabID)
      const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId)
      const frames: Array<{ id: string; parentID?: string; url: string; name: string }> = []
      const walk = (node: any, parentID?: string) => {
        frames.push({ id: node.frame.id, parentID, url: node.frame.url, name: node.frame.name ?? "" })
        for (const child of node.childFrames ?? []) walk(child, node.frame.id)
      }
      walk(frameTree)
      return { tab: await tab(action.tabID), frames }
    }

    // ------------------------------------------------------------ inspección
    case "snapshot":
    case "find": {
      const sessionId = await tabs.attach(action.tabID)
      const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, sessionId)
      const needle = action.type === "find" ? action.text.toLowerCase() : undefined
      const maxDepth = action.type === "snapshot" ? (action.depth ?? 20) : 20
      // Los refs se renumeran en cada snapshot: son válidos hasta la siguiente
      // navegación o el siguiente snapshot, que es justo lo que promete el schema.
      refs.reset(action.tabID)
      const lines: string[] = []
      // getFullAXTree devuelve la lista plana; `depth` es distancia a la raíz,
      // así que hay que reconstruirla desde childIds en vez de contar líneas.
      const byID = new Map<string, { depth: number; node: any }>()
      const depthOf = (node: any, seen = new Set<string>()): number => {
        const cached = byID.get(node.nodeId)
        if (cached) return cached.depth
        if (!node.parentId || seen.has(node.nodeId)) return 0
        const parent = nodes.find((n: any) => n.nodeId === node.parentId)
        if (!parent) return 0
        seen.add(node.nodeId)
        const depth = depthOf(parent, seen) + 1
        byID.set(node.nodeId, { depth, node })
        return depth
      }

      for (const node of nodes as Array<any>) {
        const role = node.role?.value
        const name = node.name?.value ?? ""
        if (!role || role === "none" || role === "generic" || role === "presentation") continue
        if (!name) continue
        if (depthOf(node) > maxDepth) continue
        if (needle !== undefined && !name.toLowerCase().includes(needle)) continue
        lines.push(`${refs.mint(action.tabID, node.backendDOMNodeId)} ${role} "${name}"`)
      }

      const content = lines.join("\n")
      return {
        tab: await tab(action.tabID),
        content: content.slice(0, MAX_TEXT),
        truncated: content.length > MAX_TEXT,
      }
    }

    case "evaluate": {
      const sessionId = await tabs.attach(action.tabID)
      // Con `ref` el contrato pide una FUNCIÓN que recibe el elemento, no una
      // expresión: se ejecuta con callFunctionOn sobre el nodo resuelto.
      const result = action.ref
        ? await cdp.send(
            "Runtime.callFunctionOn",
            {
              objectId: (await cdp.send("DOM.resolveNode", { backendNodeId: refs.resolve(action.tabID, action.ref) }, sessionId))
                .object.objectId,
              functionDeclaration: action.script,
              returnByValue: true,
              awaitPromise: true,
            },
            sessionId,
          )
        : await cdp.send(
            "Runtime.evaluate",
            { expression: action.script, returnByValue: true, awaitPromise: true },
            sessionId,
          )
      if (result.exceptionDetails) {
        throw new CdpError(result.exceptionDetails.exception?.description ?? "evaluate threw", {
          code: "evaluate_failed",
        })
      }
      return { tab: await tab(action.tabID), value: result.result?.value ?? null }
    }

    // ------------------------------------------------------------ interacción
    case "click": {
      const sessionId = await tabs.attach(action.tabID)
      const box = await refBox(ctx, action.tabID, action.ref, sessionId)
      const common = {
        x: box.x,
        y: box.y,
        button: action.button ?? "left",
        clickCount: action.count ?? 1,
        modifiers: toModifiers(action.modifiers ?? []),
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common }, sessionId)
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common }, sessionId)
      await waitForLoad(cdp, tabs, action.tabID)
      return await tab(action.tabID)
    }

    case "hover": {
      const sessionId = await tabs.attach(action.tabID)
      const box = await refBox(ctx, action.tabID, action.ref, sessionId)
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, sessionId)
      return await tab(action.tabID)
    }

    case "drag": {
      const sessionId = await tabs.attach(action.tabID)
      const from = await refBox(ctx, action.tabID, action.from, sessionId)
      const to = await refBox(ctx, action.tabID, action.to, sessionId)
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 }, sessionId)
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left" }, sessionId)
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left" }, sessionId)
      return await tab(action.tabID)
    }

    case "fill": {
      const sessionId = await tabs.attach(action.tabID)
      await fillNode(ctx, action.tabID, action.ref, sessionId, action.text)
      return await tab(action.tabID)
    }

    case "fill_form": {
      const sessionId = await tabs.attach(action.tabID)
      for (const field of action.fields) {
        if (field.type === "text") await fillNode(ctx, action.tabID, field.ref, sessionId, field.value)
        if (field.type === "check") await checkNode(ctx, action.tabID, field.ref, sessionId, field.checked)
        if (field.type === "select") await selectNode(ctx, action.tabID, field.ref, sessionId, field.values)
      }
      return await tab(action.tabID)
    }

    case "select": {
      const sessionId = await tabs.attach(action.tabID)
      await selectNode(ctx, action.tabID, action.ref, sessionId, action.values)
      return await tab(action.tabID)
    }

    case "check": {
      const sessionId = await tabs.attach(action.tabID)
      await checkNode(ctx, action.tabID, action.ref, sessionId, action.checked)
      return await tab(action.tabID)
    }

    case "press": {
      const sessionId = await tabs.attach(action.tabID)
      await sendKey(cdp, action.key, sessionId)
      return await tab(action.tabID)
    }

    case "scroll": {
      const sessionId = await tabs.attach(action.tabID)
      await cdp.send(
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x: 100, y: 100, deltaX: action.deltaX ?? 0, deltaY: action.deltaY },
        sessionId,
      )
      return await tab(action.tabID)
    }

    case "wait": {
      const sessionId = await tabs.attach(action.tabID)
      if (action.condition === "load") {
        await waitForLoad(cdp, tabs, action.tabID)
        return await tab(action.tabID)
      }
      const deadline = Date.now() + (action.timeoutMs ?? 10_000)
      while (Date.now() < deadline) {
        const present = await textPresence(cdp, action.text, sessionId)
        if (action.condition === "text" && present) break
        if (action.condition === "textGone" && !present) break
        await sleep(150)
      }
      return await tab(action.tabID)
    }

    // -------------------------------------------------------------- capturas
    case "screenshot": {
      const sessionId = await tabs.attach(action.tabID)
      const format = action.format ?? "png"
      const params: Record<string, unknown> = { format }
      if (format !== "png" && action.quality !== undefined) params.quality = action.quality
      if (action.fullPage) params.captureBeyondViewport = true
      if (action.maxWidth !== undefined) params.clip = await fitClip(ctx, action.tabID, action.ref, sessionId, action.maxWidth)
      const { data } = await cdp.send("Page.captureScreenshot", params, sessionId)
      return {
        tab: await tab(action.tabID),
        files: [{ id: newFileID(), name: `screenshot.${format}`, mime: mimeFor(format), bytes: data.length * 3 / 4, path: "" }],
        __file: { name: `screenshot.${format}`, mime: mimeFor(format), data: base64ToBytes(data) },
      }
    }

    case "console": {
      const sessionId = await tabs.attach(action.tabID)
      await collectors.attach(sessionId)
      const all = collectors.consoleMessages(sessionId)
      const min = LEVEL_ORDER[action.level ?? "debug"] ?? 0
      const filtered = all.filter((m) => (LEVEL_ORDER[m.level] ?? 1) >= min)
      const shown = filtered.slice(-(action.limit ?? 100))
      return {
        tab: await tab(action.tabID),
        messages: shown,
        truncated: filtered.length > shown.length,
        dropped: Math.max(0, filtered.length - shown.length),
      }
    }

    case "network.list": {
      const sessionId = await tabs.attach(action.tabID)
      await collectors.attach(sessionId)
      let all = collectors.requests(sessionId)
      const needle = action.urlContains
      if (needle !== undefined) all = all.filter((r) => r.url.includes(needle))
      if (action.resourceType) all = all.filter((r) => r.resourceType === action.resourceType)
      const shown = all.slice(-(action.limit ?? 100))
      return {
        tab: await tab(action.tabID),
        requests: shown.map(publicRequest),
        truncated: all.length > shown.length,
        dropped: Math.max(0, all.length - shown.length),
      }
    }

    case "network.get": {
      const sessionId = await tabs.attach(action.tabID)
      await collectors.attach(sessionId)
      const request = collectors.requests(sessionId).find((r) => r.id === action.id)
      if (!request) {
        throw new CdpError(
          `Request ${action.id} is not in this capture. Call browser.network.list({ tabID }) for exact IDs; ` +
            `IDs expire on navigation or eviction.`,
          { code: "network_request_not_found" },
        )
      }
      const bodies = collectors.requestBody(sessionId, action.id)
      const maxChars = action.maxBodyChars ?? 2_000
      return {
        tab: await tab(action.tabID),
        request: publicRequest(request),
        requestHeaders: toHeaders(bodies?.request?.headers),
        responseHeaders: toHeaders(bodies?.response?.headers),
        headersTruncated: false,
        requestBody: bodyState(action.includeBody, bodies?.postData, maxChars),
        responseBody: bodyState(action.includeBody, bodies?.response?.bodyText, maxChars),
      }
    }

    // -------------------------------------------------------------- ficheros
    case "files.upload":
    case "files.drop": {
      const sessionId = await tabs.attach(action.tabID)
      const attached = await materialize(command.files)
      if (attached.length === 0) {
        throw new CdpError("No file bytes were attached to this command.", { code: "no_files" })
      }
      const nodeId = refs.resolve(action.tabID, action.ref)
      const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: nodeId }, sessionId)
      if (!object?.objectId) throw new CdpError(`Could not resolve ${action.ref}`, { code: "ref_unavailable" })
      // CDP solo acepta rutas locales: los bytes del RPC se materializan aquí.
      await cdp.send("DOM.setFileInputFiles", { files: [attached[0]!.path], objectId: object.objectId }, sessionId)
      return await tab(action.tabID)
    }

    case "files.list": {
      const sessionId = await tabs.attach(action.tabID)
      await collectors.attach(sessionId)
      return {
        tab: await tab(action.tabID),
        files: collectors.downloads(sessionId).map((f) => ({
          id: f.id,
          name: f.name,
          mime: f.mime,
          bytes: f.bytes ?? 0,
          state: f.state,
        })),
      }
    }

    case "files.get": {
      const sessionId = await tabs.attach(action.tabID)
      await collectors.attach(sessionId)
      const found = collectors.downloads(sessionId).find((f) => f.id === action.fileID)
      if (!found) {
        throw new CdpError(
          `File ${action.fileID} is not owned by this tab. Call browser.files.list({ tabID }) for exact IDs.`,
          { code: "file_not_found" },
        )
      }
      if (found.state !== "completed") {
        throw new CdpError(`File ${found.name} is ${found.state}, not completed.`, { code: "file_not_ready" })
      }
      return {
        tab: await tab(action.tabID),
        files: [{ id: found.id, name: found.name, mime: found.mime, bytes: found.bytes ?? 0, path: "" }],
        __file: { name: found.name, mime: found.mime, data: base64ToBytes(found.__data ?? "") },
      }
    }

    // -------------------------------------------------------------- diálogos
    case "dialog": {
      const sessionId = await tabs.attach(action.tabID)
      await collectors.attach(sessionId)
      if (action.action === "get") return { tab: await tab(action.tabID), dialog: collectors.dialog(sessionId) }
      if (!collectors.dialog(sessionId)) throw new CdpError("This tab has no open dialog.", { code: "no_dialog" })
      await cdp.send(
        "Page.handleJavaScriptDialog",
        { accept: action.action === "accept", promptText: action.promptText ?? "" },
        sessionId,
      )
      return { tab: await tab(action.tabID), dialog: null }
    }

    // ------------------------------------------------------------ performance
    case "trace.start": {
      await startTrace(cdp, action.tabID, action.durationMs ?? 10_000)
      return { tab: await tab(action.tabID), recording: true }
    }

    case "trace.stop": {
      const stopped = await stopTrace(cdp)
      const tabID = stopped.tabID ?? action.tabID
      return {
        tab: await tab(tabID),
        files: stopped.data
          ? [{ id: newFileID(), name: "trace.json.gz", mime: "application/gzip", bytes: stopped.bytes, path: "" }]
          : [],
        durationMs: stopped.durationMs,
        incomplete: stopped.incomplete,
        ...(stopped.data ? { __file: { name: "trace.json.gz", mime: "application/gzip", data: base64ToBytes(stopped.data) } } : {}),
      }
    }

    case "cpu.start": {
      const sessionId = await tabs.attach(action.tabID)
      await cdp.send("Profiler.enable", {}, sessionId)
      await cdp.send("Profiler.setSamplingInterval", { interval: 1_000 }, sessionId)
      await cdp.send("Profiler.start", {}, sessionId)
      cdp.traces.cpu.set(action.tabID, sessionId)
      return { tab: await tab(action.tabID), recording: true }
    }

    case "cpu.stop": {
      const sessionId = cdp.traces.cpu.get(action.tabID)
      if (!sessionId) throw new CdpError("No CPU recording is running for this tab.", { code: "not_recording" })
      const { profile } = await cdp.send("Profiler.stop", {}, sessionId)
      cdp.traces.cpu.delete(action.tabID)
      const json = JSON.stringify(profile ?? {})
      return {
        tab: await tab(action.tabID),
        files: [{ id: newFileID(), name: "cpu.cpuprofile", mime: "application/json", bytes: json.length, path: "" }],
        durationMs: profile?.endTime && profile?.startTime ? profile.endTime - profile.startTime : 0,
        __file: { name: "cpu.cpuprofile", mime: "application/json", data: new TextEncoder().encode(json) },
      }
    }

    // -------------------------------------------------------------- memoria
    case "heap.snapshot": {
      const sessionId = await tabs.attach(action.tabID)
      const chunks: string[] = []
      const off = cdp.on(`${sessionId}:HeapProfiler.addHeapSnapshotChunk`, (params: any) => {
        if (params.chunk) chunks.push(params.chunk)
      })
      await cdp.send("HeapProfiler.enable", {}, sessionId)
      await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }, sessionId)
      off()
      const data = new TextEncoder().encode(chunks.join(""))
      return {
        tab: await tab(action.tabID),
        files: [{ id: newFileID(), name: "heap.heapsnapshot", mime: "application/json", bytes: data.byteLength, path: "" }],
        __file: { name: "heap.heapsnapshot", mime: "application/json", data },
      }
    }

    // Las de abajo necesitan analizar el contenido de una captura, no solo
    // producirla. Preferimos un `unsupported` accionable a colgar el comando.
    case "heap.summary":
    case "heap.query":
    case "heap.object":
    case "heap.compare":
      throw unsupported(`${action.type} (parses heap snapshot contents; the bridge ships the file, not an analyzer)`)

    case "trace.analyze":
    case "cpu.analyze":
      throw unsupported(action.type)

    case "lighthouse":
      throw unsupported("lighthouse (requires a Lighthouse runtime, not just CDP)")

    default:
      throw unsupported((action as { type: string }).type)
  }
}

const newFileID = () => `file_${randomUUID()}` as Browser.FileID
const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 }

const base64ToBytes = (data: string) => new Uint8Array(Buffer.from(data, "base64"))

const publicRequest = (r: {
  id: string
  url: string
  method: string
  resourceType: string
  timestampMs: number
  statusCode?: number
  state: string
  durationMs?: number
  failure?: string
}) =>
  r.state === "completed"
    ? {
        id: r.id,
        url: r.url,
        method: r.method,
        resourceType: r.resourceType,
        timestampMs: r.timestampMs,
        statusCode: r.statusCode,
        state: "completed",
        durationMs: r.durationMs ?? 0,
      }
    : r.state === "failed"
      ? {
          id: r.id,
          url: r.url,
          method: r.method,
          resourceType: r.resourceType,
          timestampMs: r.timestampMs,
          statusCode: r.statusCode,
          state: "failed",
          durationMs: 0,
          failure: r.failure ?? "failed",
        }
      : {
          id: r.id,
          url: r.url,
          method: r.method,
          resourceType: r.resourceType,
          timestampMs: r.timestampMs,
          statusCode: r.statusCode,
          state: "pending",
        }

const toHeaders = (headers?: Record<string, unknown>) =>
  Object.entries(headers ?? {}).map(([name, value]) => ({
    name: String(name).slice(0, 2_048),
    value: String(value).slice(0, MAX_TEXT),
  }))

const bodyState = (include: boolean | undefined, text: string | undefined, maxChars: number) => {
  if (!include) return { state: "notRequested" as const }
  if (text === undefined || text === null) return { state: "unavailable" as const, reason: "notCaptured" as const }
  if (text === "") return { state: "empty" as const }
  const value = String(text)
  return { state: "text" as const, text: value.slice(0, maxChars), truncated: value.length > maxChars }
}

const mimeFor = (format: string) =>
  format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png"

const publicTab = (found?: LiveTab) => ({
  id: found?.id ?? (`tab_${randomUUID()}` as Browser.TabID),
  url: found?.url ?? "about:blank",
  title: found?.title ?? "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: found?.generation ?? 0,
})

// --- refs -------------------------------------------------------------------

/** Tabla ref → backendDOMNodeId, por tab. Se invalida en cada snapshot. */
class RefTable {
  #perTab = new Map<string, Map<string, number>>()

  reset(tabID: string) {
    this.#perTab.set(tabID, new Map())
  }

  mint(tabID: string, backendDOMNodeId: number) {
    const table = this.#perTab.get(tabID) ?? new Map<string, number>()
    if (!this.#perTab.has(tabID)) this.#perTab.set(tabID, table)
    const ref = `@e${table.size + 1}`
    table.set(ref, backendDOMNodeId)
    return ref
  }

  resolve(tabID: string, ref: string) {
    const nodeId = this.#perTab.get(tabID)?.get(ref)
    if (nodeId === undefined) {
      throw new CdpError(
        `Ref ${ref} is unknown or expired for tab ${tabID}. Call browser.snapshot({ tabID }) for fresh refs.`,
        { code: "tab_unavailable" },
      )
    }
    return nodeId
  }
}

export const refs = new RefTable()

// --- helpers CDP ------------------------------------------------------------

async function refBox(ctx: ActionContext, tabID: string, ref: string, sessionId: string) {
  const { cdp } = ctx
  const nodeId = refs.resolve(tabID, ref)
  // Page.getBoxModel necesita el objectId resuelto; usamos DOM.resolveNode
  // para convertir backendDOMNodeId → objectId por sesión.
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: nodeId }, sessionId)
  if (!object?.objectId) throw new CdpError(`Could not resolve ${ref}`, { code: "ref_unavailable" })

  const { model } = await cdp.send("DOM.getBoxModel", { objectId: object.objectId }, sessionId)
  const quad = model?.content ?? model?.border
  if (!quad || quad.length < 8) throw new CdpError(`${ref} has no box model`, { code: "ref_unavailable" })

  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    width: Math.abs(quad[2] - quad[0]),
    height: Math.abs(quad[5] - quad[1]),
  }
}

async function fitClip(ctx: ActionContext, tabID: string, ref: string | undefined, sessionId: string, maxWidth: number) {
  const { cdp } = ctx
  const source: { x: number; y: number; width: number; height: number } = ref
    ? await refBox(ctx, tabID, ref, sessionId)
    : { x: 0, y: 0, ...viewportOf(await cdp.send("Page.getLayoutMetrics", {}, sessionId)) }
  const scale = source.width > maxWidth ? maxWidth / source.width : 1
  return { x: source.x, y: source.y, width: source.width * scale, height: source.height * scale, scale }
}

const viewportOf = (metrics: any) => {
  const box = metrics?.cssVisualViewport ?? metrics?.cssContentSize ?? {}
  return { width: box.clientWidth ?? box.width ?? 0, height: box.clientHeight ?? box.height ?? 0 }
}

async function fillNode(ctx: ActionContext, tabID: string, ref: string, sessionId: string, value: string) {
  const { object } = await ctx.cdp.send("DOM.resolveNode", { backendNodeId: refs.resolve(tabID, ref) }, sessionId)
  await ctx.cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId: object.objectId,
      functionDeclaration: `function(value) {
        const setter = Object.getOwnPropertyDescriptor(
          this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value"
        )?.set;
        setter ? setter.call(this, value) : (this.value = value);
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
      arguments: [{ value }],
    },
    sessionId,
  )
}

async function checkNode(ctx: ActionContext, tabID: string, ref: string, sessionId: string, checked: boolean) {
  const { object } = await ctx.cdp.send("DOM.resolveNode", { backendNodeId: refs.resolve(tabID, ref) }, sessionId)
  await ctx.cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId: object.objectId,
      functionDeclaration: `function(checked) {
        if (this.checked !== checked) this.click();
      }`,
      arguments: [{ value: checked }],
    },
    sessionId,
  )
}

async function selectNode(ctx: ActionContext, tabID: string, ref: string, sessionId: string, values: readonly string[]) {
  const { object } = await ctx.cdp.send("DOM.resolveNode", { backendNodeId: refs.resolve(tabID, ref) }, sessionId)
  await ctx.cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId: object.objectId,
      functionDeclaration: `function(values) {
        const wanted = new Set(values);
        for (const option of this.options ?? []) option.selected = wanted.has(option.value);
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
      arguments: [{ value: values }],
    },
    sessionId,
  )
}

async function sendKey(cdp: CdpClient, key: string, sessionId: string) {
  const parts = key.split("+")
  const keyName = parts.pop() ?? key
  const common = { modifiers: parts.length, key: keyName, code: keyName, windowsVirtualKeyCode: vkFor(keyName) }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...common }, sessionId)
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, sessionId)
}

const VK: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  a: 65,
}

const vkFor = (name: string) => VK[name] ?? name.toUpperCase().charCodeAt(0)

const toModifiers = (mods: readonly string[]) => {
  let value = 0
  if (mods.includes("Alt")) value |= 1
  if (mods.includes("Control")) value |= 2
  if (mods.includes("Meta")) value |= 4
  if (mods.includes("Shift")) value |= 8
  return value
}

async function textPresence(cdp: CdpClient, text: string | undefined, sessionId: string) {
  if (!text) return false
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `document.body && document.body.innerText.includes(${JSON.stringify(text)})`,
      returnByValue: true,
    },
    sessionId,
  )
  return result.result?.value === true
}

async function waitForLoad(cdp: CdpClient, tabs: TabRegistry, tabID: string) {
  const targetId = tabs.resolve(tabID)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send("Target.getTargets")
    if (!targetInfos.some((info: { targetId: string }) => info.targetId === targetId)) return
    break
  }
}

// --- trazas -----------------------------------------------------------------

async function startTrace(cdp: CdpClient, tabID: string, durationMs: number) {
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: { includedCategories: ["devtools.timeline"] },
  })
  cdp.traces.trace = { tabID, startedAt: Date.now(), durationMs }
  const timer = setTimeout(() => void stopTrace(cdp).catch(() => undefined), durationMs + 1_000)
  timer.unref?.()
}

async function stopTrace(cdp: CdpClient) {
  const trace = cdp.traces.trace
  if (!trace) throw new CdpError("No trace is running.", { code: "not_recording" })
  cdp.traces.trace = undefined
  const complete = new Promise<{ stream?: string }>((resolve) => {
    const off = cdp.on("Tracing.tracingComplete", (params: any) => {
      off()
      resolve(params)
    })
    const timer = setTimeout(() => resolve({}), 10_000)
    timer.unref?.()
  })
  await cdp.send("Tracing.end")
  const result = await complete
  if (!result.stream) {
    return { tabID: trace.tabID, data: undefined, bytes: 0, durationMs: Date.now() - trace.startedAt, incomplete: true }
  }
  const { data, base64Encoded } = await cdp.send("IO.read", { handle: result.stream })
  await cdp.send("IO.close", { handle: result.stream }).catch(() => undefined)
  return {
    tabID: trace.tabID,
    data: base64Encoded ? (data as string) : Buffer.from(data as string).toString("base64"),
    bytes: (data as string).length,
    durationMs: Date.now() - trace.startedAt,
    incomplete: false,
  }
}

/** Los adjuntos del comando se materializan en disco: CDP solo acepta rutas. */
async function materialize(files: readonly Browser.File[]) {
  if (files.length === 0) return []
  const dir = await mkdtemp(join(tmpdir(), "apex-browser-files-"))
  return Promise.all(
    files.map(async (file) => {
      const path = join(dir, file.name)
      await writeFile(path, file.data)
      return { path, name: file.name }
    }),
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
