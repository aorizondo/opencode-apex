/**
 * Contexto de procesos del advisor: qué mata un comando y de quién es.
 *
 * El advisor deniega lo que no entiende. Si este módulo no reconoce un `kill`, el
 * advisor vuelve a ver un número pelado; si clasifica mal un proceso, aprueba matar
 * algo del usuario o deniega matar lo que el agente acaba de arrancar. De ahí la tabla.
 */

import { spawn } from "node:child_process"
import { userInfo } from "node:os"

const APEX = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

const { parseKillTargets, tokenize, describeTargets, formatProcessContext, classify, launchers, processTargetsFor, systemProcSource } =
  await import(`${APEX}/core/process-context.ts`)
const { renderAdvisorRequest, DEFAULT_ADVISOR_REQUEST_TEMPLATE } = await import(`${APEX}/core/advisor-session.ts`)

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

const show = (v: unknown) => JSON.stringify(v)

// ===========================================================================
console.log("\n1. Troceo de palabras")
// ===========================================================================

check("comillas dobles", show(tokenize('pkill -f "n8n start"')) === show(["pkill", "-f", "n8n start"]))
check("comillas simples", show(tokenize("pkill -f '[b]in/n8n start'")) === show(["pkill", "-f", "[b]in/n8n start"]))
check("$( … ) es una sola palabra", show(tokenize('kill $(pgrep -f "a b")')) === show(["kill", '$(pgrep -f "a b")']))

// ===========================================================================
console.log("\n2. Qué mata cada comando")
// ===========================================================================

const t = (cmd: string) => parseKillTargets(cmd)

check("sin kill → nada", t("ls -la && echo kill-switch").length === 0, show(t("ls -la && echo kill-switch")))
check("kill PID", show(t("kill 705875")) === show([{ kind: "pid", pid: 705875 }]))
check("kill varios PIDs", show(t("kill 705875 705876").map((x: { pid: number }) => x.pid)) === show([705875, 705876]))
check("kill -9 PID: la señal no es objetivo", show(t("kill -9 356762")) === show([{ kind: "pid", pid: 356762 }]))
check("kill -KILL / -s TERM", t("kill -KILL 5").length === 1 && t("kill -s TERM 5")[0]?.pid === 5)
check("kill -- -1 es «todos»", t("kill -- -1")[0]?.kind === "all", show(t("kill -- -1")))
check("kill -9 -1 es «todos»", t("kill -9 -1")[0]?.kind === "all", show(t("kill -9 -1")))
check("kill -- -1234 es un grupo", show(t("kill -- -1234")) === show([{ kind: "group", pgid: 1234 }]))
check("kill 0 es el grupo propio", show(t("kill 0")) === show([{ kind: "group", pgid: 0 }]))
check("kill -l no mata nada", t("kill -l").length === 0)
check("en una cadena con &&", t("sleep 1 && kill 42 2>&1")[0]?.pid === 42, show(t("sleep 1 && kill 42 2>&1")))
check("con 2>/dev/null y ;", t("kill 576730 2>/dev/null; sleep 1")[0]?.pid === 576730)
check("con prefijo sudo", t("sudo kill 7")[0]?.pid === 7)
check("ruta absoluta", t("/bin/kill 8")[0]?.pid === 8)
{
  const p = t('pkill -f "n8n start"')[0]
  check("pkill -f", p?.kind === "pattern" && p.pattern === "n8n start" && p.full === true, show(p))
}
{
  const p = t("pkill -9 node")[0]
  check("pkill -9 nombre: la señal no es el patrón", p?.pattern === "node" && p.full === false, show(p))
}
{
  const p = t("pkill -u antonio -f vite")[0]
  check("pkill -u usuario: el valor no es el patrón", p?.pattern === "vite", show(p))
}
{
  const p = t("killall -9 firefox")[0]
  check("killall", p?.kind === "pattern" && p.pattern === "firefox" && p.exact === true, show(p))
}
{
  const p = t('kill $(pgrep -f "drive.mjs")')[0]
  check("kill $(pgrep -f …)", p?.kind === "pattern" && p.pattern === "drive.mjs" && p.full, show(p))
}
{
  const p = t("kill `pidof bun`")[0]
  check("kill `pidof …`", p?.kind === "pattern" && p.pattern === "bun" && p.exact, show(p))
}
check("dentro de bash -c", t('bash -c "kill 99"')[0]?.pid === 99, show(t('bash -c "kill 99"')))
check("$PID sin resolver se ignora", t("kill $PID").length === 0)

// ===========================================================================
console.log("\n3. Descripción con un /proc falso")
// ===========================================================================

// Árbol: 1 init · 100 bash (terminal) · 200 opencode (selfPid) · 300 bash del agente
// · 301 vite lanzado por ses_root · 302 node lanzado por ses_child (subagente del mismo
// árbol) · 400 firefox del usuario · 500 servicio de root · 600 n8n lanzado por OTRA
// conversación · 700 hijo de nohup reparentado a init que hereda el entorno.
interface FakeProc {
  ppid: number
  uid: number
  name: string
  cmd: string
  env?: Record<string, string> | null
  pgid?: number
}
const FAKE: Record<number, FakeProc> = {
  1: { ppid: 0, uid: 0, name: "systemd", cmd: "/sbin/init", env: null },
  100: { ppid: 1, uid: 1000, name: "bash", cmd: "bash", env: {} },
  200: { ppid: 100, uid: 1000, name: "opencode", cmd: "opencode serve", env: {} },
  300: { ppid: 200, uid: 1000, name: "bash", cmd: "bash -c npm run dev", env: { OPENCODE_SESSION_ID: "ses_root" }, pgid: 300 },
  301: { ppid: 300, uid: 1000, name: "node", cmd: "node vite --port 5173", env: { OPENCODE_SESSION_ID: "ses_root" }, pgid: 300 },
  302: { ppid: 200, uid: 1000, name: "node", cmd: "node server.js", env: { OPENCODE_SESSION_ID: "ses_child" } },
  400: { ppid: 1, uid: 1000, name: "firefox", cmd: "/usr/lib/firefox/firefox", env: { HOME: "/home/ant" } },
  500: { ppid: 1, uid: 0, name: "sshd", cmd: "/usr/sbin/sshd -D", env: null },
  600: { ppid: 1, uid: 1000, name: "node", cmd: "node /usr/bin/n8n start", env: { OPENCODE_SESSION_ID: "ses_other" } },
  700: { ppid: 1, uid: 1000, name: "bun", cmd: "bun install -g x", env: { OPENCODE_SESSION_ID: "ses_child" } },
}

const fake = {
  read(pid: number, file: string): string | null {
    const p = FAKE[pid]
    if (!p) return null
    if (file === "status") return `Name:\t${p.name}\nPPid:\t${p.ppid}\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\n`
    if (file === "cmdline") return p.cmd.split(" ").join("\0") + "\0"
    if (file === "stat") return `${pid} (${p.name}) S ${p.ppid} ${p.pgid ?? pid} ${p.pgid ?? pid} 0`
    if (file === "environ") {
      if (p.env === null || p.env === undefined) return null
      return Object.entries(p.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\0")
    }
    return null
  },
  pids: () => Object.keys(FAKE).map(Number),
  userName: (uid: number) => (uid === 0 ? "root" : uid === 1000 ? "ant" : undefined),
}

const OPTS = { selfPid: 200 }
const FMT = { selfUid: 1000, treeSessions: new Set(["ses_root", "ses_child"]) }
const own = (pid: number) => {
  const d = describeTargets([{ kind: "pid", pid }], fake, OPTS)[0]
  return d.processes[0] ? classify(d.processes[0].info, FMT) : "none"
}

check("proceso del agente principal → este árbol", own(301) === "this-tree", own(301))
check("proceso de un subagente → este árbol", own(302) === "this-tree", own(302))
check("firefox del usuario → user", own(400) === "user", own(400))
check("servicio de root → other-user", own(500) === "other-user", own(500))
check("n8n de otra conversación → other-agent-session", own(600) === "other-agent-session", own(600))
check("reparentado a init conserva su lanzador", own(700) === "this-tree", own(700))
{
  const d = describeTargets([{ kind: "pid", pid: 200 }], fake, OPTS)[0]
  check("el propio opencode es crítico", /propio servidor/.test(d.processes[0]?.critical ?? ""), show(d.processes[0]))
}
{
  const d = describeTargets([{ kind: "pid", pid: 100 }], fake, OPTS)[0]
  check("la terminal que sostiene opencode es crítica", /ancestro/.test(d.processes[0]?.critical ?? ""))
}
{
  const d = describeTargets([{ kind: "pid", pid: 1 }], fake, OPTS)[0]
  check("init es crítico", /PID 1/.test(d.processes[0]?.critical ?? ""))
}
{
  const d = describeTargets([{ kind: "pid", pid: 99999 }], fake, OPTS)[0]
  check("PID inexistente lo dice", d.processes.length === 0 && /no existe/.test(d.note ?? ""))
}
{
  const d = describeTargets([{ kind: "pattern", pattern: "n8n start", full: true, exact: false, via: "pkill" }], fake, OPTS)[0]
  check("pkill -f encuentra por línea completa", d.total === 1 && d.processes[0]?.info.pid === 600, show(d.processes.map((p: { info: { pid: number } }) => p.info.pid)))
}
{
  const d = describeTargets([{ kind: "pattern", pattern: "node", full: false, exact: false, via: "pkill" }], fake, OPTS)[0]
  const pids = d.processes.map((p: { info: { pid: number } }) => p.info.pid).sort()
  check("pkill nombre encuentra por nombre", show(pids) === show([301, 302, 600]), show(pids))
}
{
  const d = describeTargets([{ kind: "pattern", pattern: "nada-de-esto", full: true, exact: false, via: "pkill" }], fake, OPTS)[0]
  check("patrón sin coincidencias lo dice", d.total === 0 && /ningún proceso/.test(d.note ?? ""))
}
{
  const d = describeTargets([{ kind: "pattern", pattern: "[", full: false, exact: false, via: "pkill" }], fake, OPTS)[0]
  check("regex inválida no lanza", d.total === 0)
}
{
  const d = describeTargets([{ kind: "group", pgid: 300 }], fake, OPTS)[0]
  check("grupo lista sus miembros", d.total === 2, show(d.total))
}
{
  const d = describeTargets([{ kind: "all" }], fake, OPTS)[0]
  check("kill -1 avisa", /TODOS/.test(d.note ?? ""))
}
{
  const targets = describeTargets([{ kind: "pid", pid: 301 }, { kind: "pid", pid: 600 }, { kind: "pid", pid: 400 }], fake, OPTS)
  check("launchers recoge las sesiones lanzadoras", show(launchers(targets).sort()) === show(["ses_other", "ses_root"]))
  const text = formatProcessContext(targets, FMT)
  check("formato: cabecera", text.startsWith("Procesos afectados"))
  check("formato: comando", text.includes("node vite --port 5173"))
  check("formato: dueño", text.includes("PID 400 · ant · del usuario"))
  check("formato: este árbol", /PID 301 .* ESTA conversación/.test(text), text)
  check("formato: otra conversación", /PID 600 .* OTRA conversación/.test(text))
}
{
  const text = formatProcessContext(describeTargets([{ kind: "pid", pid: 200 }], fake, OPTS), FMT)
  check("formato: marca lo crítico", text.includes("⚠ CRÍTICO"))
}
check("formato vacío sin objetivos", formatProcessContext([], FMT) === "")

// ===========================================================================
console.log("\n4. Punto de entrada")
// ===========================================================================

check("otra tool → null", processTargetsFor("write", ["kill 1"], OPTS, fake) === null)
check("shell sin kill → null", processTargetsFor("shell", ["ls", "echo hi"], OPTS, fake) === null)
check("shell con kill → descripción", processTargetsFor("shell", ["kill 301"], OPTS, fake)?.length === 1)
{
  const broken = { read: () => { throw new Error("boom") }, pids: () => [], userName: () => undefined }
  check("un /proc que lanza no rompe el hook", processTargetsFor("shell", ["kill 1"], OPTS, broken) === null)
}

// ===========================================================================
console.log("\n5. Plantilla del advisor")
// ===========================================================================

const base = { sessionID: "ses_x", action: "shell", resources: ["kill 1"], decisive: true, timeoutMs: 1, template: "" }
{
  const out = renderAdvisorRequest(DEFAULT_ADVISOR_REQUEST_TEMPLATE, { ...base, processes: "BLOQUE" }, "req_1")
  check("la plantilla por defecto incluye el bloque", out.includes("BLOQUE"))
}
{
  const out = renderAdvisorRequest("Solicitud {{requestID}}\nHerramienta: {{action}}", { ...base, processes: "BLOQUE" }, "req_1")
  check("una plantilla propia sin {{processes}} lo recibe al final", out.endsWith("BLOQUE"), out)
}
{
  const out = renderAdvisorRequest(DEFAULT_ADVISOR_REQUEST_TEMPLATE, base, "req_1")
  check("sin procesos no queda el placeholder", !out.includes("{{processes}}"))
}

// ===========================================================================
console.log("\n6. /proc real")
// ===========================================================================

if (process.platform !== "linux") {
  console.log("  (omitido: no es Linux)")
} else {
  // Un hijo con OPENCODE_SESSION_ID, como los que lanza el tool shell de opencode.
  const child = spawn("sleep", ["30"], { env: { ...process.env, OPENCODE_SESSION_ID: "ses_real_test" }, stdio: "ignore" })
  await new Promise((r) => setTimeout(r, 150))
  try {
    const src = systemProcSource()
    const d = processTargetsFor("shell", [`kill ${child.pid}`], { selfPid: process.pid }, src)?.[0]
    const info = d?.processes[0]?.info
    check("lee el comando", info?.command === "sleep 30", info?.command)
    check("lee el lanzador del entorno", info?.launchedBy === "ses_real_test", info?.launchedBy)
    check("lee el dueño", info?.uid === userInfo().uid)
    const fmt = { selfUid: userInfo().uid, treeSessions: new Set(["ses_real_test"]) }
    check("lo clasifica como de este árbol", info ? classify(info, fmt) === "this-tree" : false)
    const self = processTargetsFor("shell", [`kill ${process.pid}`], { selfPid: process.pid }, src)?.[0]
    check("matarse a sí mismo es crítico", Boolean(self?.processes[0]?.critical))
  } finally {
    child.kill()
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} pasan, ${failed} fallan`)
process.exit(failed === 0 ? 0 : 1)
