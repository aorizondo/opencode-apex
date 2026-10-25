/**
 * Events 0.2.0: RPC por `id`, descubrimiento del servidor, tools.run y skills del paquete.
 *
 * Lo que se prueba aquí es lo que un proceso externo necesita para llegar al agente:
 * si el RPC se registra con otro nombre, o la URL sale mal, el callback se pierde en
 * silencio (`rpc.unavailable`, `delivered: []`).
 */

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const APEX = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

const endpointModule = await import(`${APEX}/core/server-endpoint.ts`)
const { parseServeArgv, findServiceRecord, resolveServerEndpoint, rpcUrl, curlExample, stateDirectory } = endpointModule
const { wildcard, checkTool, contentText } = await import(`${APEX}/core/tools-run.ts`)
const { parseSkillFile, loadPackagedSkills } = await import(`${APEX}/core/skills.ts`)
const { APEX_RPC_DEFINITION } = await import(`${APEX}/core/rpc.ts`)
const { apexConfigSchema, loadApexConfig } = await import(`${APEX}/core/config.ts`)
const { isPrimaryCandidate, resolveTargetSession, createEventsState } = await import(`${APEX}/events.ts`)

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

console.log("\nRPC")
{
  check("se registra por id 'apex' (V2 indexa por definition.id)", APEX_RPC_DEFINITION.id === "apex")
  check("sin el campo name del API antiguo", !("name" in APEX_RPC_DEFINITION))
  const methods = Object.keys(APEX_RPC_DEFINITION.methods)
  for (const m of ["ping", "status", "events.ingest", "tools.run", "server.info", "redact.process"])
    check(`publica ${m}`, methods.includes(m))
  check("los eventos declaran schema", Object.values(APEX_RPC_DEFINITION.events).every((e: any) => e.schema))
}

console.log("\nDescubrimiento del servidor")
{
  check("serve --port", JSON.stringify(parseServeArgv(["x", "serve", "--hostname", "127.0.0.1", "--port", "47125"])) ===
    JSON.stringify({ host: "127.0.0.1", port: 47125 }))
  check("serve --port=N y host por defecto", parseServeArgv(["serve", "--port=4096"])?.port === 4096 &&
    parseServeArgv(["serve", "--port=4096"])?.host === "127.0.0.1")
  check("0.0.0.0 se anuncia como loopback", parseServeArgv(["serve", "--hostname", "0.0.0.0", "--port", "1"])?.host === "127.0.0.1")
  check("serve --service sin puerto → null", parseServeArgv(["serve", "--service"]) === null)
  check("no es serve → null", parseServeArgv(["run", "--port", "1"]) === null)
  check("XDG_STATE_HOME", stateDirectory({ XDG_STATE_HOME: "/x" } as never, "/h") === "/x/opencode")
  check("~/.local/state por defecto", stateDirectory({} as never, "/h") === "/h/.local/state/opencode")

  const dir = mkdtempSync(join(tmpdir(), "apex-state-"))
  writeFileSync(join(dir, "service.json"), JSON.stringify({ url: "http://127.0.0.1:49374", pid: 111, password: "s3cr3t" }))
  writeFileSync(join(dir, "service-beta.json"), JSON.stringify({ url: "http://127.0.0.1:5000", pid: 222, password: "x" }))
  writeFileSync(join(dir, "service-broken.json"), "{not json")
  check("registro por pid", findServiceRecord(dir, 111)?.url === "http://127.0.0.1:49374")
  check("otro canal, otro pid", findServiceRecord(dir, 222)?.url === "http://127.0.0.1:5000")
  check("pid ajeno → null (otro servidor)", findServiceRecord(dir, 999) === null)
  check("directorio inexistente → null", findServiceRecord(join(dir, "nope"), 111) === null)

  const svc = resolveServerEndpoint({ directory: "/proy x", argv: ["serve", "--service"], pid: 111, stateDir: dir })
  check("servicio: baseUrl del registro", svc.baseUrl === "http://127.0.0.1:49374" && svc.source === "service")
  check("servicio: password por fichero, nunca en claro", svc.auth.password?.kind === "file" &&
    !JSON.stringify(svc).includes("s3cr3t"))
  check("Basic opencode", svc.auth.scheme === "basic" && svc.auth.username === "opencode")
  check("URL RPC con location[directory] codificado",
    svc.rpc.ingest === "http://127.0.0.1:49374/api/rpc/apex/events.ingest?location%5Bdirectory%5D=%2Fproy%20x")

  const pwCmd = svc.auth.password?.shell ?? ""
  const proc = Bun.spawnSync(["sh", "-c", pwCmd])
  check("password.shell lo imprime al ejecutarse", proc.stdout.toString().trim() === "s3cr3t", proc.stderr.toString())
  check("curl de ejemplo sin el password", !curlExample(svc, "ingest", { source: "x", payload: {} }).includes("s3cr3t"))

  const standalone = resolveServerEndpoint({ directory: "/p", argv: ["serve", "--port", "47125"], pid: 999, stateDir: dir })
  check("serve suelto: argv", standalone.baseUrl === "http://127.0.0.1:47125" && standalone.source === "argv" &&
    standalone.auth.password?.kind === "env")
  const configured = resolveServerEndpoint({ directory: "/p", configUrl: "https://oc.example.com/", pid: 111, stateDir: dir })
  check("config gana", configured.baseUrl === "https://oc.example.com/" && configured.source === "config")
  check("rpcUrl quita la barra final", rpcUrl("https://oc.example.com/", "ping", "/p").startsWith("https://oc.example.com/api/rpc/apex/ping"))
  const unknown = resolveServerEndpoint({ directory: "/p", argv: ["serve", "--service"], pid: 999, stateDir: dir })
  check("desconocido → null + pista", unknown.baseUrl === null && typeof unknown.hint === "string")
  check("publicUrl se recorta y vacía → null",
    resolveServerEndpoint({ directory: "/p", publicUrl: "  ", pid: 1, stateDir: dir }).publicUrl === null)
}

console.log("\ntools.run")
{
  check("* casa todo", wildcard("*", "easypanel_execute_query"))
  check("prefijo", wildcard("apex_*", "apex_subscribe") && !wildcard("apex_*", "read"))
  check("los puntos son literales", !wildcard("a.b", "axb"))
  const cfg = { allow: ["*"], deny: ["question", "apex_*"] }
  check("allow", checkTool("read", cfg) === null)
  check("deny gana a allow", checkTool("question", cfg) !== null && checkTool("apex_subscribe", cfg) !== null)
  check("fuera de allow", checkTool("shell", { allow: ["read", "easypanel_*"], deny: [] }) !== null)
  check("content string", contentText("hola") === "hola")
  check("content partes", contentText([{ type: "text", text: "a" }, { type: "image" }]) === "a\n[image]")
  check("content ausente", contentText(undefined) === undefined)
}

console.log("\nSesión principal")
{
  check("el runner no es sesión principal", !isPrimaryCandidate({ agent: "apex-runner" }))
  check("el advisor tampoco", !isPrimaryCandidate({ agent: "apex-advisor" }))
  check("un subagente tampoco", !isPrimaryCandidate({ parentID: "ses_x", agent: "build" }))
  check("una raíz normal sí", isPrimaryCandidate({ agent: "build" }))
  const a = createEventsState()
  const b = createEventsState()
  a.autoBoundSessionID = "ses_a"
  check("estado por directorio (no compartido)", resolveTargetSession(b, {}) === null && resolveTargetSession(a, {}) === "ses_a")
  check("sessionID explícito gana", resolveTargetSession(a, { sessionID: "ses_x" }) === "ses_x")
  const { isForeignEvent } = await import(`${APEX}/events.ts`)
  check("evento de otro directorio se ignora (bus global)", isForeignEvent({ location: { directory: "/otro" } }, "/proy"))
  check("evento del propio directorio se procesa", !isForeignEvent({ location: { directory: "/proy/" } }, "/proy"))
  check("evento sin location se procesa", !isForeignEvent({}, "/proy"))
}

console.log("\nSkills del paquete")
{
  const parsed = parseSkillFile("demo", "/x/demo/SKILL.md", "---\nname: demo\ndescription: \"hace cosas\"\n---\n# Cuerpo\n")
  check("frontmatter", parsed.name === "demo" && parsed.description === "hace cosas")
  check("contenido sin frontmatter", parsed.content === "# Cuerpo\n")
  check("sin frontmatter: id como nombre", parseSkillFile("x", "/p", "solo cuerpo").name === "x")
  const skills = loadPackagedSkills()
  const callbacks = skills.find((s: any) => s.id === "apex-callbacks")
  check("apex-callbacks viaja con el paquete", !!callbacks && (callbacks.description ?? "").length > 50)
  check("habla de tools.run y del endpoint", !!callbacks && callbacks.content.includes("tools.run") &&
    callbacks.content.includes("apex_callback_endpoint"))
  check("sin listener HTTP", !!callbacks && !callbacks.content.includes("4599"))
  // El agente abre las referencias por ruta relativa a SKILL.md: si una falta, la guía queda rota.
  const referenced = [...new Set((callbacks?.content ?? "").match(/references\/[\w-]+\.md/g) ?? [])]
  const base = callbacks ? callbacks.path.replace(/SKILL\.md$/, "") : ""
  check("referencias de la skill existen", referenced.length >= 4 && referenced.every((file) => existsSync(base + file)))
}

console.log("\nConfig")
{
  const parsed = apexConfigSchema.parse({})
  check("events.tools por defecto", parsed.events.tools.enabled === true && parsed.events.tools.agent === "build" &&
    parsed.events.tools.deny.includes("question"))
  check("events.server por defecto vacío", JSON.stringify(parsed.events.server) === "{}")
  const legacy = apexConfigSchema.parse({ events: { listener: { enabled: true, port: 4599 } } })
  check("listener antiguo se descarta sin romper", !("listener" in legacy.events))

  const home = mkdtempSync(join(tmpdir(), "apex-home-"))
  const project = join(home, "proy")
  mkdirSync(join(project, ".opencode"), { recursive: true })
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
  try {
    await loadApexConfig({ projectDir: project, home, options: { events: { listener: { enabled: true } } } })
  } finally {
    console.warn = warn
  }
  check("avisa del listener obsoleto", warnings.some((w) => w.includes("events.listener")))
}

console.log("\nPlantillas de prompt")
{
  const { renderPromptTemplate, DEFAULT_EVENT_PROMPT_TEMPLATE } = await import(`${APEX}/events.ts`)
  const event = { eventID: "e1", source: "s", type: "t", payload: { host: "x", n: 2 }, location: "/p", timestamp: 0 }
  const out = renderPromptTemplate(DEFAULT_EVENT_PROMPT_TEMPLATE, event)
  check("{{payload}} se sustituye por el JSON del payload", out.includes('{"host":"x","n":2}') && !out.includes("{{payload}}"))
  check("{{payload.x}} sigue funcionando", renderPromptTemplate("h={{payload.host}} n={{payload.n}}", event) === "h=x n=2")
}

console.log("\nCompatibilidad con OpenCode")
{
  const { compatibilityWarnings, newerMinor } = await import(`${APEX}/core/compat.ts`)
  check("2.10 > 2.9 (numérico, no lexicográfico)", newerMinor("2.10.0", "2.9.4"))
  check("mismo minor no avisa", !newerMinor("2.1.9", "2.1.4"))
  check("major nuevo avisa", newerMinor("3.0.0", "2.9.0"))
  check("versión ilegible no avisa", !newerMinor(undefined, "2.1.4"))

  const pkg = (dir: string, name: string, version: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }))
  }
  const single = mkdtempSync(join(tmpdir(), "apex-compat-"))
  pkg(join(single, "node_modules/@opencode/plugin"), "@opencode/plugin", "2.1.4")
  pkg(join(single, "node_modules/effect"), "effect", "4.0.1")
  mkdirSync(join(single, "node_modules/opencode-apex"), { recursive: true })
  const apexDir = join(single, "node_modules/opencode-apex")
  check("una copia de effect + mismo minor → sin avisos", compatibilityWarnings("2.1.1", apexDir).length === 0)
  check("OpenCode más nuevo que @opencode/plugin → aviso", compatibilityWarnings("2.3.0", apexDir).length === 1)

  pkg(join(single, "node_modules/@opencode/plugin/node_modules/effect"), "effect", "4.1.0")
  const dup = compatibilityWarnings("2.1.1", apexDir)
  check("dos copias de effect → aviso con versiones", dup.length === 1 && dup[0]!.includes("4.0.1") && dup[0]!.includes("4.1.0"))
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} pasan, ${failed} fallan`)
process.exit(failed === 0 ? 0 : 1)
