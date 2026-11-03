/**
 * Contexto de procesos para el advisor — de quién es cada PID que se quiere matar.
 *
 * POR QUÉ EXISTE. El advisor solo veía el texto del comando. Ante `kill 705875`
 * no tenía forma de saber si ese PID era el servidor de pruebas que el propio
 * agente arrancó un minuto antes o el navegador del usuario, y con una regla del
 * tipo «deniega matar procesos ajenos» la única respuesta prudente era denegar.
 * Medido en las sesiones advisor: 7 de 7 `kill <PID>` denegados, mientras los
 * `pkill -f "n8n start"` — donde el nombre sí se ve — pasaban.
 *
 * QUÉ SE AVERIGUA, por cada proceso objetivo, leyendo `/proc` (solo Linux):
 *   - dueño (uid → usuario) y si es el mismo usuario que corre opencode;
 *   - comando completo;
 *   - quién lo lanzó: el tool `shell` de opencode exporta `OPENCODE_SESSION_ID`
 *     a cada hijo, así que `/proc/<pid>/environ` dice qué sesión lo creó. Se lee
 *     también el de los ancestros, porque un `setsid nohup bash -c …` deja el
 *     proceso final colgando de init pero heredando el entorno;
 *   - si es CRÍTICO: el propio servidor opencode, uno de sus ancestros (la
 *     terminal que lo sostiene) o el PID 1. Matar cualquiera de ellos corta la
 *     sesión que está pidiendo el permiso.
 *
 * Lo que NO hace: decidir. Solo describe; la decisión sigue siendo del advisor.
 * Y nunca lanza: un `/proc` ilegible (otro usuario, proceso ya muerto, macOS)
 * acaba en «desconocido», no en un fallo del hook de permisos.
 *
 * Fichero sin Effect ni dependencias del host, como `guard.ts`, para probarlo con
 * un `/proc` falso.
 */

import { readFileSync, readdirSync } from "node:fs"
import { userInfo } from "node:os"

// ---------------------------------------------------------------------------
// Objetivos: qué procesos nombra un comando
// ---------------------------------------------------------------------------

/** Un objetivo extraído de un comando de shell. */
export type KillTarget =
  | { readonly kind: "pid"; readonly pid: number }
  /** PID negativo o `0`: un grupo de procesos entero (`kill -- -1234`, `kill 0`). */
  | { readonly kind: "group"; readonly pgid: number }
  /** `kill -1`: todos los procesos del usuario. */
  | { readonly kind: "all" }
  /** `pkill -f patrón`, `pkill nombre`, `killall nombre`, `kill $(pgrep …)`. */
  | { readonly kind: "pattern"; readonly pattern: string; readonly full: boolean; readonly exact: boolean; readonly via: string }

/** Opciones de pkill/pgrep que llevan valor y por tanto consumen el siguiente token. */
const PGREP_VALUE_OPTS = new Set([
  "-s", "--signal", "-u", "--euid", "-U", "--uid", "-g", "--pgroup", "-G", "--group",
  "-P", "--parent", "-t", "--terminal", "--session", "--ns", "--nslist", "-d", "--delimiter",
  "-F", "--pidfile", "--cgroup", "--env",
])

/** Opciones de killall que llevan valor. */
const KILLALL_VALUE_OPTS = new Set(["-s", "--signal", "-u", "--user", "-o", "--older-than", "-y", "--younger-than", "-n", "--ns", "-Z", "--context"])

/**
 * Trocea una línea de comando en palabras, respetando comillas simples y dobles.
 * No pretende ser un parser de shell: basta para separar `pkill -f "n8n start"`
 * en tres palabras y para no partir un `$(pgrep -f "x y")`.
 */
export function tokenize(command: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let depth = 0 // dentro de $( … )
  let has = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (depth > 0) {
      current += ch
      if (ch === "(") depth++
      else if (ch === ")") depth--
      continue
    }
    if (ch === "`") {
      // `…` es una sustitución como $( … ): se conserva entera, con las comillas.
      const end = command.indexOf("`", i + 1)
      const stop = end === -1 ? command.length : end + 1
      current += command.slice(i, stop)
      i = stop - 1
      has = true
      continue
    }
    if (ch === "$" && command[i + 1] === "(") {
      current += "$("
      i++
      depth = 1
      has = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      has = true
      continue
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[++i]
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has) out.push(current)
      current = ""
      has = false
      continue
    }
    current += ch
    has = true
  }
  if (has) out.push(current)
  return out
}

/**
 * Divide una línea en los comandos simples que la componen (`;`, `&&`, `||`, `|`, `&`).
 * El host ya entrega cada comando por separado como recurso, pero un `bash -c "…"`
 * o un `$(…)` llega entero, y ahí dentro también puede haber un kill.
 */
function splitCommands(line: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let depth = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === quote) quote = null
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === "(") depth++
    if (ch === ")") depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === ";" || ch === "|" || ch === "&" || ch === "\n")) {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** Quita prefijos que no cambian el comando real: `sudo`, `env A=b`, `nohup`, `timeout 5`, `VAR=x`. */
function stripPrefixes(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++
      continue
    }
    if (w === "sudo" || w === "nohup" || w === "setsid" || w === "exec" || w === "command" || w === "builtin") {
      i++
      while (i < words.length && words[i]!.startsWith("-")) i++
      continue
    }
    if (w === "env") {
      i++
      while (i < words.length && (words[i]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!))) i++
      continue
    }
    if (w === "timeout") {
      i++
      while (i < words.length && words[i]!.startsWith("-")) i++
      i++ // la duración
      continue
    }
    break
  }
  return words.slice(i)
}

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1)

/** Interpreta las opciones de pkill/pgrep y devuelve el patrón. */
function parsePgrep(args: string[], via: string): KillTarget | null {
  let full = false
  let exact = false
  let pattern: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--") {
      pattern = args[i + 1]
      break
    }
    if (PGREP_VALUE_OPTS.has(a)) {
      i++
      continue
    }
    if (a.startsWith("--")) {
      if (a === "--full") full = true
      else if (a === "--exact") exact = true
      continue
    }
    if (a.startsWith("-") && a.length > 1) {
      // `-9`, `-KILL`, `-SIGTERM` son señales; `-fx` son flags combinados.
      if (/^-(\d+|[A-Z]+|SIG[A-Z]+)$/.test(a)) continue
      if (a.includes("f")) full = true
      if (a.includes("x")) exact = true
      continue
    }
    pattern = a
    break
  }
  if (pattern === undefined || pattern === "") return null
  return { kind: "pattern", pattern, full, exact, via }
}

/** Interpreta `killall` y devuelve un objetivo por nombre. */
function parseKillall(args: string[]): KillTarget[] {
  const out: KillTarget[] = []
  let regex = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (KILLALL_VALUE_OPTS.has(a)) {
      i++
      continue
    }
    if (a === "-r" || a === "--regexp") {
      regex = true
      continue
    }
    if (a.startsWith("-")) continue
    out.push({ kind: "pattern", pattern: a, full: false, exact: !regex, via: "killall" })
  }
  return out
}

/** Interpreta los argumentos de `kill`: PIDs, grupos, `-1` y sustituciones `$(pgrep …)`. */
function parseKill(args: string[]): KillTarget[] {
  const out: KillTarget[] = []
  let operands = false // tras `--` todo es operando, incluso `-1234`
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!operands) {
      if (a === "--") {
        operands = true
        continue
      }
      if (a === "-s" || a === "-n" || a === "--signal") {
        i++
        operands = true
        continue
      }
      if (a === "-l" || a === "-L" || a === "--list" || a === "--table") return []
      // Señal: `-9`, `-KILL`, `-SIGTERM`. Solo hay una y va primero: lo que viene
      // detrás son objetivos, así que `kill -9 -1` es «todos» igual que `kill -- -1`.
      // `kill -1 PID` sí lee `-1` como señal (SIGHUP), que es lo que hace bash.
      if (/^-(\d+|[A-Za-z]+[A-Za-z0-9+-]*)$/.test(a)) {
        operands = true
        continue
      }
    }
    const sub = /^\$\((.*)\)$/s.exec(a) ?? /^`(.*)`$/s.exec(a)
    if (sub) {
      for (const inner of splitCommands(sub[1]!)) {
        const words = stripPrefixes(tokenize(inner))
        const head = words[0] ? basename(words[0]) : ""
        if (head === "pgrep" || head === "pidof") {
          const t = head === "pgrep" ? parsePgrep(words.slice(1), "kill $(pgrep)") : pidofTarget(words.slice(1))
          if (t) out.push(t)
        }
      }
      continue
    }
    if (/^-?\d+$/.test(a)) {
      const n = Number(a)
      if (n === -1) out.push({ kind: "all" })
      else if (n <= 0) out.push({ kind: "group", pgid: -n })
      else out.push({ kind: "pid", pid: n })
    }
    // `%1` (jobs), `$PID` (variables): no se pueden resolver sin el shell; se ignoran.
  }
  return out
}

function pidofTarget(args: string[]): KillTarget | null {
  const name = args.find((a) => !a.startsWith("-"))
  return name ? { kind: "pattern", pattern: name, full: false, exact: true, via: "kill $(pidof)" } : null
}

/**
 * Extrae los objetivos de kill de un recurso de `shell`.
 * Devuelve [] si el comando no mata nada — que es lo normal, y lo que hace barato
 * llamar a esto en cada permiso.
 */
export function parseKillTargets(command: string): KillTarget[] {
  // Filtro barato antes de trocear: la inmensa mayoría de comandos no matan nada.
  if (!/\b(kill|pkill|killall)\b/.test(command)) return []
  const out: KillTarget[] = []
  for (const part of splitCommands(command)) {
    const words = stripPrefixes(tokenize(part))
    if (words.length === 0) continue
    const head = basename(words[0]!)
    if (head === "kill") out.push(...parseKill(words.slice(1)))
    else if (head === "pkill") {
      const t = parsePgrep(words.slice(1), "pkill")
      if (t) out.push(t)
    } else if (head === "killall") out.push(...parseKillall(words.slice(1)))
    else if ((head === "bash" || head === "sh" || head === "zsh") && words[1] === "-c" && words[2]) {
      out.push(...parseKillTargets(words[2]))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// /proc: qué es cada proceso
// ---------------------------------------------------------------------------

/** Acceso al sistema de ficheros de procesos; inyectable para los tests. */
export interface ProcSource {
  /** Contenido de `/proc/<pid>/<file>`, o null si no existe o no se puede leer. */
  read(pid: number, file: "status" | "cmdline" | "environ" | "stat"): string | null
  /** PIDs vivos. */
  pids(): number[]
  /** uid → nombre de usuario. */
  userName(uid: number): string | undefined
}

export function systemProcSource(root = "/proc"): ProcSource {
  let passwd: Map<number, string> | undefined
  return {
    read(pid, file) {
      try {
        return readFileSync(`${root}/${pid}/${file}`, "latin1")
      } catch {
        return null
      }
    },
    pids() {
      try {
        return readdirSync(root)
          .filter((name) => /^\d+$/.test(name))
          .map(Number)
      } catch {
        return []
      }
    },
    userName(uid) {
      if (!passwd) {
        passwd = new Map()
        try {
          for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
            const [name, , id] = line.split(":")
            if (name && id && /^\d+$/.test(id)) passwd.set(Number(id), name)
          }
        } catch {
          // sin /etc/passwd se muestra el uid
        }
      }
      return passwd.get(uid)
    },
  }
}

export interface ProcInfo {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly uid: number
  readonly user: string
  readonly command: string
  /** `OPENCODE_SESSION_ID` del proceso o de un ancestro; undefined si no se pudo leer. */
  readonly launchedBy?: string
  /** El entorno era legible (si no, `launchedBy` no dice nada). */
  readonly environReadable: boolean
}

function parseStatus(text: string): { ppid: number; uid: number; name: string } | null {
  const ppid = /^PPid:\s+(\d+)/m.exec(text)
  const uid = /^Uid:\s+(\d+)/m.exec(text)
  const name = /^Name:\s+(.*)$/m.exec(text)
  if (!ppid || !uid) return null
  return { ppid: Number(ppid[1]), uid: Number(uid[1]), name: name?.[1]?.trim() ?? "?" }
}

/** pgid sale de `/proc/<pid>/stat`, campo 5; el nombre va entre paréntesis y puede tener espacios. */
function parsePgid(stat: string | null): number {
  if (!stat) return 0
  const close = stat.lastIndexOf(")")
  const fields = stat.slice(close + 2).split(" ")
  return Number(fields[2] ?? 0)
}

function sessionFromEnviron(environ: string): string | undefined {
  for (const entry of environ.split("\0")) {
    if (entry.startsWith("OPENCODE_SESSION_ID=")) return entry.slice("OPENCODE_SESSION_ID=".length)
  }
  return undefined
}

export function readProc(src: ProcSource, pid: number): ProcInfo | null {
  const status = src.read(pid, "status")
  if (!status) return null
  const parsed = parseStatus(status)
  if (!parsed) return null
  const cmdline = (src.read(pid, "cmdline") ?? "").split("\0").filter(Boolean).join(" ")
  const environ = src.read(pid, "environ")

  // Quién lo lanzó: su propio entorno y, si no lo trae, el de sus ancestros
  // (cortando en el servidor opencode, que no lleva la variable pero sí es padre
  // de todo lo que lanza). Hasta 8 niveles: shell → subshell → nohup → …
  let launchedBy = environ ? sessionFromEnviron(environ) : undefined
  let parent = parsed.ppid
  for (let depth = 0; launchedBy === undefined && environ !== null && parent > 1 && depth < 8; depth++) {
    const env = src.read(parent, "environ")
    if (!env) break
    launchedBy = sessionFromEnviron(env)
    const st = src.read(parent, "status")
    parent = st ? (parseStatus(st)?.ppid ?? 0) : 0
  }

  return {
    pid,
    ppid: parsed.ppid,
    pgid: parsePgid(src.read(pid, "stat")),
    uid: parsed.uid,
    user: src.userName(parsed.uid) ?? String(parsed.uid),
    command: cmdline || `[${parsed.name}]`,
    launchedBy,
    environReadable: environ !== null,
  }
}

/** Ancestros de un PID (padre, abuelo, …), sin incluirlo. */
export function ancestors(src: ProcSource, pid: number): Set<number> {
  const out = new Set<number>()
  let current = pid
  for (let depth = 0; depth < 64; depth++) {
    const status = src.read(current, "status")
    const ppid = status ? parseStatus(status)?.ppid : undefined
    if (!ppid || out.has(ppid)) break
    out.add(ppid)
    current = ppid
  }
  return out
}

/**
 * Coincidencia como la hace pgrep: el patrón es una regex extendida que se busca
 * en el nombre del proceso (o en la línea completa con `-f`). Si la regex no
 * compila se trata como texto literal.
 */
function pgrepMatch(target: Extract<KillTarget, { kind: "pattern" }>, info: ProcInfo, name: string): boolean {
  const subject = target.full ? info.command : name
  let re: RegExp
  try {
    re = new RegExp(target.exact ? `^(?:${target.pattern})$` : target.pattern)
  } catch {
    return target.exact ? subject === target.pattern : subject.includes(target.pattern)
  }
  return re.test(subject)
}

// ---------------------------------------------------------------------------
// Descripción para el advisor
// ---------------------------------------------------------------------------

export interface DescribeOptions {
  /** PID del servidor opencode (process.pid). */
  readonly selfPid: number
  /** Tope de procesos descritos por patrón o grupo. */
  readonly maxMatches?: number
}

export interface DescribedProcess {
  readonly info: ProcInfo
  readonly critical?: string
}

export interface TargetDescription {
  readonly target: KillTarget
  readonly processes: readonly DescribedProcess[]
  /** Coincidencias totales (puede superar a `processes.length` si se recortó). */
  readonly total: number
  readonly note?: string
}

function criticalReason(info: ProcInfo, selfPid: number, selfAncestors: Set<number>): string | undefined {
  if (info.pid === 1) return "es init (PID 1)"
  if (info.pid === selfPid) return "es el propio servidor de opencode"
  if (selfAncestors.has(info.pid)) return "es un ancestro del servidor de opencode (la terminal o shell que lo sostiene)"
  return undefined
}

export function describeTargets(
  targets: readonly KillTarget[],
  src: ProcSource,
  opts: DescribeOptions,
): TargetDescription[] {
  const max = opts.maxMatches ?? 8
  const selfAncestors = ancestors(src, opts.selfPid)
  const describe = (info: ProcInfo): DescribedProcess => ({
    info,
    critical: criticalReason(info, opts.selfPid, selfAncestors),
  })

  // Lista de procesos, solo si algún objetivo la necesita (patrón o grupo).
  let all: { info: ProcInfo; name: string }[] | undefined
  const listAll = () => {
    if (all) return all
    all = []
    for (const pid of src.pids()) {
      const info = readProc(src, pid)
      if (!info) continue
      const status = src.read(pid, "status")
      all.push({ info, name: (status && parseStatus(status)?.name) ?? "" })
    }
    return all
  }

  return targets.map((target): TargetDescription => {
    switch (target.kind) {
      case "pid": {
        const info = readProc(src, target.pid)
        if (!info) return { target, processes: [], total: 0, note: "no existe ningún proceso con ese PID (o ya terminó)" }
        return { target, processes: [describe(info)], total: 1 }
      }
      case "all":
        return {
          target,
          processes: [],
          total: 0,
          note: "kill -1 envía la señal a TODOS los procesos del usuario, incluido opencode y la sesión gráfica",
        }
      case "group": {
        if (target.pgid === 0)
          return { target, processes: [], total: 0, note: "kill 0 mata el grupo de procesos del propio shell que ejecuta el comando" }
        const members = listAll().filter((p) => p.info.pgid === target.pgid).map((p) => describe(p.info))
        return { target, processes: members.slice(0, max), total: members.length }
      }
      case "pattern": {
        const matched = listAll()
          .filter((p) => p.info.pid !== opts.selfPid && pgrepMatch(target, p.info, p.name))
          // El shell que va a ejecutar el pkill lleva el patrón en su cmdline y
          // coincidiría consigo mismo con -f; pkill real nunca se cuenta a sí mismo.
          .filter((p) => !(target.full && /\b(pkill|pgrep|killall)\b/.test(p.info.command)))
          .map((p) => describe(p.info))
        // Lo crítico y lo no lanzado por un agente primero: es lo que cambia la decisión.
        const rank = (d: DescribedProcess) => (d.critical ? 0 : d.info.launchedBy ? 2 : 1)
        matched.sort((a, b) => rank(a) - rank(b))
        return {
          target,
          processes: matched.slice(0, max),
          total: matched.length,
          note: matched.length === 0 ? "ningún proceso coincide ahora mismo (el comando no mataría nada)" : undefined,
        }
      }
    }
  })
}

/** Sesiones de opencode que lanzaron alguno de los procesos descritos. */
export function launchers(descriptions: readonly TargetDescription[]): string[] {
  const out = new Set<string>()
  for (const d of descriptions) for (const p of d.processes) if (p.info.launchedBy) out.add(p.info.launchedBy)
  return [...out]
}

export type Ownership = "this-tree" | "other-agent-session" | "user" | "other-user" | "unknown"

export interface FormatOptions {
  /** uid del servidor opencode. */
  readonly selfUid: number
  /** Sesiones del árbol que pide el permiso (la raíz y sus subagentes). */
  readonly treeSessions: ReadonlySet<string>
}

export function classify(info: ProcInfo, opts: FormatOptions): Ownership {
  if (info.uid !== opts.selfUid) return "other-user"
  if (info.launchedBy && opts.treeSessions.has(info.launchedBy)) return "this-tree"
  if (info.launchedBy) return "other-agent-session"
  return info.environReadable ? "user" : "unknown"
}

const OWNERSHIP_LABEL: Record<Ownership, string> = {
  "this-tree": "lanzado por un agente de ESTA conversación (o uno de sus subagentes)",
  "other-agent-session": "lanzado por un agente de OTRA conversación de opencode",
  user: "del usuario, no lanzado por opencode",
  "other-user": "de OTRO usuario del sistema",
  unknown: "origen desconocido (entorno ilegible)",
}

function targetLabel(target: KillTarget): string {
  switch (target.kind) {
    case "pid":
      return `PID ${target.pid}`
    case "group":
      return target.pgid === 0 ? "grupo del propio shell (kill 0)" : `grupo de procesos ${target.pgid}`
    case "all":
      return "todos los procesos (kill -1)"
    case "pattern":
      return `${target.via} "${target.pattern}"${target.full ? " (línea completa, -f)" : ""}${target.exact ? " (exacto)" : ""}`
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Bloque de texto para el advisor. Vacío si no hay objetivos.
 * Va en texto plano y corto: el advisor es un modelo barato y cada línea le cuesta latencia.
 */
export function formatProcessContext(descriptions: readonly TargetDescription[], opts: FormatOptions): string {
  if (descriptions.length === 0) return ""
  const lines = ["Procesos afectados (leído de /proc por apex, no lo afirma el agente):"]
  for (const d of descriptions) {
    // Un `kill PID` encontrado no necesita cabecera: la línea del proceso ya dice el PID.
    const headed = d.target.kind !== "pid" || d.processes.length === 0
    if (headed) lines.push(`- ${targetLabel(d.target)}${d.note ? `: ${d.note}` : ""}`)
    const [bullet, indent] = headed ? ["    ", "      "] : ["- ", "    "]
    for (const p of d.processes) {
      const flag = p.critical ? ` · ⚠ CRÍTICO: ${p.critical}` : ""
      lines.push(
        `${bullet}PID ${p.info.pid} · ${p.info.user} · ${OWNERSHIP_LABEL[classify(p.info, opts)]}${flag}\n${indent}${truncate(p.info.command, 160)}`,
      )
    }
    if (d.total > d.processes.length) lines.push(`    … y ${d.total - d.processes.length} más`)
  }
  return lines.join("\n")
}

/**
 * Punto de entrada: objetivos de kill de un permiso de `shell`, ya descritos.
 * Devuelve null si el permiso no mata nada. Nunca lanza: un fallo leyendo /proc
 * deja la petición al advisor como estaba antes de este módulo.
 */
export function processTargetsFor(
  action: string,
  resources: readonly string[],
  opts: Partial<DescribeOptions> = {},
  src: ProcSource = systemProcSource(),
): TargetDescription[] | null {
  if (action !== "shell" && action !== "bash") return null
  try {
    const targets = resources.flatMap((r) => parseKillTargets(r))
    if (targets.length === 0) return null
    return describeTargets(targets, src, { ...opts, selfPid: opts.selfPid ?? process.pid })
  } catch {
    return null
  }
}

export function currentUid(): number {
  try {
    return userInfo().uid
  } catch {
    return -1
  }
}
