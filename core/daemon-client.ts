/**
 * Lado plugin del daemon de apex: lo encuentra, lo lanza si hace falta y le habla por
 * su API de control (127.0.0.1 + token de daemon.json, 0600).
 *
 * Se lanza desacoplado con el binario que ejecuta este plugin: dentro de OpenCode es su
 * propio ejecutable, que con `BUN_BE_BUN=1` se comporta como bun (todas las plataformas).
 * Así sobrevive a que OpenCode descargue el plugin o se reinicie.
 */

import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { daemonPaths, type DaemonInfo, type DaemonPaths, type ServerTarget } from "../daemon/shared.js"
import type { ServerEndpoint } from "./server-endpoint.js"

export const DAEMON_SCRIPT = fileURLToPath(new URL("../daemon/main.ts", import.meta.url))

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** a > b en semver simple (x.y.z); lo demás cuenta como igual. */
export function newerVersion(a: string, b: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number(n))
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    const l = x[i] ?? 0
    const r = y[i] ?? 0
    if (!Number.isFinite(l) || !Number.isFinite(r)) return false
    if (l !== r) return l > r
  }
  return false
}

/** Cómo lanzar el daemon: el ejecutable actual en modo bun. */
export function daemonCommand(version: string, execPath = process.execPath, script = DAEMON_SCRIPT, home?: string) {
  const env: Record<string, string> = { BUN_BE_BUN: "1", APEX_DAEMON_VERSION: version }
  if (home) env.APEX_DAEMON_HOME = home
  return { command: execPath, args: [script], env }
}

/** Lanzador para el autoarranque (crontab @reboot / tarea de Windows), con las rutas de hoy. */
export function launcherText(version: string, paths: DaemonPaths, platform = process.platform, execPath = process.execPath): string {
  const { command, args, env } = daemonCommand(version, execPath, DAEMON_SCRIPT, paths.home)
  // La identidad de OpenTunnel vive en XDG_DATA_HOME: cron no la hereda.
  if (process.env.XDG_DATA_HOME) env.XDG_DATA_HOME = process.env.XDG_DATA_HOME
  if (platform === "win32") {
    const sets = Object.entries(env).map(([key, value]) => `set "${key}=${value}"`)
    return ["@echo off", ...sets, `"${command}" "${args[0]}" >> "${paths.log}" 2>&1`, ""].join("\r\n")
  }
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`)
  return ["#!/bin/sh", ...exports, `exec ${quote(command)} ${quote(args[0]!)} >> ${quote(paths.log)} 2>&1`, ""].join("\n")
}

function readInfo(paths: DaemonPaths): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(paths.info, "utf8")) as DaemonInfo
  } catch {
    return null
  }
}

async function call<T>(info: DaemonInfo, method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = { error: text }
  }
  if (!response.ok) throw new DaemonError((data as { error?: string }).error ?? `daemon ${response.status}`, response.status)
  return data as T
}

async function healthy(info: DaemonInfo | null): Promise<{ version: string } | null> {
  if (!info) return null
  try {
    return await call<{ version: string }>(info, "GET", "/v1/health", undefined, 1500)
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface DaemonClient {
  readonly info: DaemonInfo
  readonly request: <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<T>
}

export interface EnsureOptions {
  readonly version: string
  /** false: solo si ya corre (no lanzar). */
  readonly spawn: boolean
  readonly paths?: DaemonPaths
}

/** El daemon vivo, lanzándolo (o sustituyéndolo por uno más nuevo) si hace falta. */
export async function ensureDaemon(options: EnsureOptions): Promise<DaemonClient | null> {
  const paths = options.paths ?? daemonPaths()
  let info = readInfo(paths)
  let health = await healthy(info)
  if (health && info && newerVersion(options.version, health.version)) {
    // Plugin actualizado: el daemon viejo cede (los servicios siguen vivos y el nuevo los adopta).
    await call(info, "POST", "/v1/shutdown", {}).catch(() => undefined)
    for (let i = 0; i < 50 && (await healthy(info)); i++) await sleep(100)
    health = null
  }
  if (health && info) return client(info)
  if (!options.spawn) return null

  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  writeLauncher(options.version, paths)
  const { command, args, env } = daemonCommand(options.version, process.execPath, DAEMON_SCRIPT, paths.home)
  const fd = openSync(paths.log, "a", 0o600)
  try {
    const child = spawn(command, args, {
      cwd: paths.home,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    })
    child.on("error", () => {})
    child.unref()
  } finally {
    closeSync(fd)
  }
  for (let i = 0; i < 100; i++) {
    await sleep(100)
    info = readInfo(paths)
    if (info && (await healthy(info))) return client(info)
  }
  throw new DaemonError(`apex daemon did not start; see ${paths.log}`)
}

function client(info: DaemonInfo): DaemonClient {
  return { info, request: (method, path, body) => call(info, method, path, body) }
}

export function writeLauncher(version: string, paths: DaemonPaths = daemonPaths()): void {
  try {
    writeFileSync(paths.launcher, launcherText(version, paths), { mode: 0o700 })
  } catch {
    // best-effort: solo lo usa el autoarranque
  }
}

/** ¿Hay algo que mantener? (sin registro no se lanza nada al cargar el plugin). */
export function hasRegistryEntries(paths: DaemonPaths = daemonPaths()): boolean {
  if (!existsSync(paths.registry)) return false
  try {
    const registry = JSON.parse(readFileSync(paths.registry, "utf8")) as Record<string, unknown[] | undefined>
    return ["tunnels", "webhooks", "services"].some((key) => (registry[key]?.length ?? 0) > 0)
  } catch {
    return false
  }
}

/** Cómo llega el daemon al servidor de este proyecto, desde lo que ya resuelve events. */
export function serverTarget(endpoint: ServerEndpoint, env: NodeJS.ProcessEnv = process.env): ServerTarget | null {
  if (!endpoint.baseUrl) return null
  const source = endpoint.auth.password
  let password: ServerTarget["password"] = null
  if (source?.kind === "file" && source.file) password = { kind: "file", file: source.file, field: source.field ?? "password" }
  else if (source?.kind === "env" && source.env && env[source.env]) password = { kind: "value", value: env[source.env]! }
  return { baseUrl: endpoint.baseUrl, password, updatedAt: Date.now() }
}
