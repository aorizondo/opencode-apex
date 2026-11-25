/**
 * Lo que comparten el daemon de apex y el plugin: rutas en disco y forma del registro.
 *
 * El daemon es UN proceso por usuario (no por proyecto): mantiene las rutas de
 * OpenTunnel y recibe webhooks. Vive fuera del
 * plugin porque OpenCode descarga los plugins tras 60 min sin actividad.
 */

import { homedir } from "node:os"
import { join } from "node:path"

/** `<XDG_STATE_HOME|~/.local/state>/opencode-apex` (también en Windows, como OpenCode). */
export function daemonHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.APEX_DAEMON_HOME && env.APEX_DAEMON_HOME.length > 0) return env.APEX_DAEMON_HOME
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0 ? env.XDG_STATE_HOME : join(home, ".local", "state")
  return join(base, "opencode-apex")
}

export interface DaemonPaths {
  readonly home: string
  /** { pid, port, token, version, startedAt } — 0600. */
  readonly info: string
  readonly lock: string
  /** Rutas, webhooks y servidores — 0600 (lleva secretos de webhooks). */
  readonly registry: string
  readonly log: string
}

export function daemonPaths(home = daemonHome()): DaemonPaths {
  return {
    home,
    info: join(home, "daemon.json"),
    lock: join(home, "daemon.lock"),
    registry: join(home, "registry.json"),
    log: join(home, "daemon.log"),
  }
}

export interface DaemonInfo {
  readonly pid: number
  /** Puerto de control (solo 127.0.0.1, nunca se publica por el túnel). */
  readonly port: number
  readonly token: string
  readonly version: string
  readonly startedAt: number
}

/** Cómo llama el daemon al RPC `events.ingest` de un proyecto (el password nunca sale de la máquina). */
export interface ServerTarget {
  readonly baseUrl: string
  /** file: se lee en cada llamada (el servicio lo reescribe al reiniciar) · value: `opencode serve` con variable. */
  readonly password: { readonly kind: "file"; readonly file: string; readonly field: string } | { readonly kind: "value"; readonly value: string } | null
  readonly updatedAt: number
}

export type ProxyProtocol = "v1" | "v2"

interface Owned {
  readonly id: string
  /** Proyecto que lo creó (las llamadas a events.ingest van a este directorio). */
  readonly directory: string
  readonly sessionID: string | null
  readonly createdAt: number
  /** null = permanente. */
  readonly expiresAt: number | null
}

/** Puerto local publicado en una ruta del túnel. */
export interface TunnelEntry extends Owned {
  readonly kind: "tunnel"
  readonly route: string
  readonly target: string
  readonly proxyProtocol?: ProxyProtocol
}

export type WebhookProvider = "github" | "stripe" | "slack" | "hmac" | "token"

export interface WebhookEntry extends Owned {
  readonly kind: "webhook"
  readonly name: string
  readonly provider: WebhookProvider
  readonly secret: string
  /** Fichero 0600 con el secreto, para configurarlo en el emisor sin pasarlo por la conversación. */
  readonly secretFile: string
  /** hmac: cabecera con la firma (por defecto x-signature) y codificación. */
  readonly header?: string
  readonly encoding?: "hex" | "base64"
  /** `source` de events.ingest (por defecto el proveedor). */
  readonly source: string
  readonly route: string
  readonly stats: { ok: number; rejected: number; failed: number; lastAt: number | null; lastError: string | null }
}

export interface Registry {
  version: 1
  tunnels: TunnelEntry[]
  webhooks: WebhookEntry[]
  /** directorio → cómo llegar a su servidor. */
  servers: Record<string, ServerTarget>
}

export function emptyRegistry(): Registry {
  return { version: 1, tunnels: [], webhooks: [], servers: {} }
}

/** Nombre de ruta aleatorio: 16 hex, como los del CLI de OpenTunnel (no aparecen en los logs de certificados). */
export function randomRoute(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Etiqueta DNS válida para una ruta elegida a mano. */
export function validRouteName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
}

export function randomToken(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("")
}
