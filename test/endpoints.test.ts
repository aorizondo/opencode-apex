/**
 * Endpoints: verificación de webhooks (puro) y el daemon de verdad en un directorio
 * temporal, con un servidor de OpenCode falso. El túnel apunta a una API inalcanzable
 * (OPENTUNNEL_API) y a un XDG_DATA_HOME vacío: nunca toca el túnel real del equipo.
 */

import { createHmac } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

const APEX = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const { verify, toIngest, forwardedHeaders, parseBody, slackChallenge } = await import(`${APEX}/daemon/webhooks.ts`)
const { daemonPaths, validRouteName, randomRoute } = await import(`${APEX}/daemon/shared.ts`)
const { ensureDaemon, newerVersion, serverTarget, hasRegistryEntries } = await import(`${APEX}/core/daemon-client.ts`)

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const sign = (secret: string, data: string, enc: "hex" | "base64" = "hex") => createHmac("sha256", secret).update(data).digest(enc)
const url = new URL("https://x.invalid/")

console.log("webhooks: verificación")
{
  const body = Buffer.from('{"action":"opened","number":1}')
  const gh = { provider: "github", secret: "s3cret" }
  check("github firma buena", verify(gh, { "x-hub-signature-256": `sha256=${sign("s3cret", body.toString())}` }, body, url).ok)
  check("github firma mala", !verify(gh, { "x-hub-signature-256": `sha256=${sign("otro", body.toString())}` }, body, url).ok)
  check("github sin firma", !verify(gh, {}, body, url).ok)

  const now = 1_700_000_000
  const stripe = { provider: "stripe", secret: "whsec_x" }
  const sig = (t: number) => `t=${t},v1=${sign("whsec_x", `${t}.${body.toString()}`)}`
  check("stripe firma buena", verify(stripe, { "stripe-signature": sig(now) }, body, url, now).ok)
  check("stripe timestamp viejo (replay)", !verify(stripe, { "stripe-signature": sig(now - 1000) }, body, url, now).ok)

  const slack = { provider: "slack", secret: "sl" }
  const slackSig = `v0=${sign("sl", `v0:${now}:${body.toString()}`)}`
  check("slack firma buena", verify(slack, { "x-slack-signature": slackSig, "x-slack-request-timestamp": String(now) }, body, url, now).ok)
  check("slack sin timestamp", !verify(slack, { "x-slack-signature": slackSig }, body, url, now).ok)

  check("hmac hex con prefijo sha256=", verify({ provider: "hmac", secret: "h" }, { "x-signature": `sha256=${sign("h", body.toString())}` }, body, url).ok)
  check(
    "hmac base64 en cabecera propia",
    verify({ provider: "hmac", secret: "h", header: "x-hook-sig", encoding: "base64" }, { "x-hook-sig": sign("h", body.toString(), "base64") }, body, url).ok,
  )
  const tok = { provider: "token", secret: "tkn" }
  check("token por Bearer", verify(tok, { authorization: "Bearer tkn" }, body, url).ok)
  check("token por X-Apex-Token", verify(tok, { "x-apex-token": "tkn" }, body, url).ok)
  check("token por ?token=", verify(tok, {}, body, new URL("https://x.invalid/?token=tkn")).ok)
  check("token malo", !verify(tok, { authorization: "Bearer nope" }, body, url).ok)

  const call = toIngest(
    { provider: "github", source: "github", name: "repo" },
    { "x-github-event": "pull_request", "x-github-delivery": "d-1", "x-hub-signature-256": "sha256=zz", "user-agent": "GitHub-Hookshot" },
    { action: "opened" },
  )
  check("github → type evento.acción", call.type === "pull_request.opened", call)
  check("github → eventID con prefijo del webhook", call.eventID === "repo:d-1", call)
  check("la firma no llega al agente", !JSON.stringify(call.payload).includes("zz") && call.payload._webhook.headers["user-agent"] === "GitHub-Hookshot")
  check("cabeceras: fuera tokens", Object.keys(forwardedHeaders({ "x-github-token": "t", "x-github-event": "push" })).join() === "x-github-event")
  check("form de Slack con payload JSON", parseBody(Buffer.from("payload=%7B%22type%22%3A%22block_actions%22%7D"), "application/x-www-form-urlencoded").type === "block_actions")
  check("cuerpo no JSON → {body}", parseBody(Buffer.from("hola"), "text/plain").body === "hola")
  check("slack url_verification", slackChallenge({ provider: "slack" }, { type: "url_verification", challenge: "abc" }) === "abc")
}

console.log("piezas")
{
  check("newerVersion", newerVersion("0.4.1", "0.4.0") && !newerVersion("0.4.0", "0.4.0") && !newerVersion("0.3.9", "0.4.0") && newerVersion("1.0.0", "0.9.9"))
  check("rutas aleatorias válidas", validRouteName(randomRoute()) && randomRoute().length === 16)
  check("ruta inválida", !validRouteName("Con_Mayus") && !validRouteName("-x") && validRouteName("hooks"))
  const target = serverTarget(
    { baseUrl: "http://127.0.0.1:4096", auth: { password: { kind: "env", env: "PW_TEST", shell: "" } } } as never,
    { PW_TEST: "x" },
  )
  check("serverTarget: password de variable → valor", target?.password?.kind === "value" && target.baseUrl === "http://127.0.0.1:4096")
}

console.log("daemon (proceso real)")
const home = mkdtempSync(join(tmpdir(), "apex-daemon-test-"))
process.env.XDG_DATA_HOME = join(home, "xdg-data")
process.env.OPENTUNNEL_API = "http://127.0.0.1:9"
process.env.APEX_DAEMON_SWEEP_MS = "300"
const paths = daemonPaths(join(home, "state"))

// Servidor de OpenCode falso: comprueba Basic auth y apunta cada events.ingest.
const PASSWORD = "pw-test"
const passwordFile = join(home, "service.json")
writeFileSync(passwordFile, JSON.stringify({ password: PASSWORD }))
const ingests: { directory: string | null; input: Record<string, unknown> }[] = []
const fake = createServer((request: IncomingMessage, response) => {
  const chunks: Buffer[] = []
  request.on("data", (c) => chunks.push(c))
  request.on("end", () => {
    const auth = request.headers.authorization ?? ""
    if (auth !== `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`) {
      response.writeHead(401).end()
      return
    }
    const u = new URL(request.url ?? "/", "http://x")
    ingests.push({ directory: u.searchParams.get("location[directory]"), input: JSON.parse(Buffer.concat(chunks).toString()).input })
    response.writeHead(200, { "content-type": "application/json" }).end('{"accepted":true}')
  })
})
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve))
const fakePort = (fake.address() as { port: number }).port
const DIR = "/proyecto/demo"

const freePort = async () => {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))
  const port = (s.address() as { port: number }).port
  await new Promise((resolve) => s.close(resolve))
  return port
}

type Client = { info: { pid: number }; request: <T = any>(method: string, path: string, body?: unknown) => Promise<T> }
const ensure = ensureDaemon as (options: unknown) => Promise<Client | null>
let daemon: Client | null = null
try {
  check("sin registro no hay nada que mantener", !hasRegistryEntries(paths))
  check("sin spawn no lanza", (await ensure({ version: "0.4.0", spawn: false, paths })) === null)
  daemon = await ensure({ version: "0.4.0", spawn: true, paths })
  check("el daemon arranca y responde", daemon !== null)
  const again = await ensure({ version: "0.4.0", spawn: true, paths })
  check("uno solo: el segundo ensure reutiliza el mismo", again?.info.pid === daemon!.info.pid)

  await daemon!.request("POST", "/v1/server", {
    directory: DIR,
    target: { baseUrl: `http://127.0.0.1:${fakePort}`, password: { kind: "file", file: passwordFile, field: "password" } },
  })

  const hook = await daemon!.request<{ id: string; route: string; secretFile: string; secret?: string; url: string | null }>("POST", "/v1/webhooks", {
    directory: DIR,
    name: "repo",
    provider: "github",
  })
  check("webhook: no devuelve el secreto", hook.secret === undefined && hook.secretFile.length > 0)
  const secret = readFileSync(hook.secretFile, "utf8")
  check("webhook: secreto en fichero", secret.length === 64)
  const state = await daemon!.request<{ ports: { hooks: number }; tunnel: { state: string } }>("GET", "/v1/state")
  const body = JSON.stringify({ action: "opened", number: 7 })
  const post = (sig: string, route = hook.route) =>
    fetch(`http://127.0.0.1:${state.ports.hooks}/`, {
      method: "POST",
      headers: {
        host: `${route}.abc.opentunnel.xyz`,
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "del-1",
        "x-hub-signature-256": sig,
      },
      body,
    })
  const good = await post(`sha256=${sign(secret, body)}`)
  check("webhook firmado → 202", good.status === 202, good.status)
  const delivered = ingests.at(-1)
  check(
    "→ events.ingest en local, con auth y al directorio del webhook",
    delivered?.directory === DIR && delivered.input.type === "pull_request.opened" && (delivered.input.payload as { number: number }).number === 7,
    delivered,
  )
  const bad = await post("sha256=00")
  check("firma mala → 401 y no llega", bad.status === 401 && ingests.length === 1)
  const other = await post(`sha256=${sign(secret, body)}`, "noexiste")
  check("ruta desconocida → 404", other.status === 404)

  // TTL
  const temp = await daemon!.request<{ id: string }>("POST", "/v1/tunnels", { directory: DIR, port: await freePort(), ttlMinutes: 0.01 })
  check("túnel temporal registrado", typeof temp.id === "string")
  await sleep(1500)
  const after = await daemon!.request<{ tunnels: unknown[] }>("GET", "/v1/state")
  check("caduca solo (TTL)", after.tunnels.length === 0, after.tunnels)
  const blocked = await daemon!.request("POST", "/v1/tunnels", { directory: DIR, port: fakePort }).then(() => false, () => true)
  check("no deja publicar el puerto del servidor de OpenCode", blocked)

  const newer = await ensure({ version: "0.4.1", spawn: true, paths })
  check("versión más nueva sustituye al daemon", newer !== null && newer.info.pid !== daemon!.info.pid)
  daemon = newer
  const kept = await daemon!.request<{ webhooks: { name: string }[] }>("GET", "/v1/state")
  check("el nuevo daemon conserva el webhook", kept.webhooks[0]?.name === "repo")
  await daemon!.request("DELETE", `/v1/webhooks/repo`)
  const gone = await daemon!.request<{ webhooks: unknown[] }>("GET", "/v1/state")
  check("borrar webhook", gone.webhooks.length === 0)
} catch (error) {
  check(`sin excepciones: ${String((error as Error).message)} ${String((error as Error).stack ?? error)}`, false)
} finally {
  await daemon?.request("POST", "/v1/shutdown", {}).catch(() => undefined)
  fake.close()
}

console.log(`\n${passed} ok, ${failed} fallos`)
if (failed) {
  console.log(`daemon log: ${paths.log}`)
  try {
    console.log(readFileSync(paths.log, "utf8").split("\n").slice(-30).join("\n"))
  } catch {}
  process.exit(1)
}
process.exit(0)
