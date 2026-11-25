/**
 * Verificación de webhooks y traducción a `events.ingest`. Puro (sin red ni disco) para
 * poder probarlo.
 *
 * Nada se fía de la petición: por el túnel todo llega desde 127.0.0.1 con el `Host` que
 * eligió el visitante (docs/trust-boundary.md de OpenTunnel). Solo vale la firma o el
 * token del webhook, comparados en tiempo constante.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookEntry } from "./shared.js"

export type Headers = Readonly<Record<string, string | undefined>>

export interface Verdict {
  readonly ok: boolean
  readonly reason?: string
}

/** Ventana de reloj para Stripe y Slack (anti-replay), como sus SDKs. */
export const TOLERANCE_SECONDS = 300

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function hmac(secret: string, data: Buffer | string, encoding: "hex" | "base64" = "hex"): string {
  return createHmac("sha256", secret).update(data).digest(encoding)
}

function fresh(timestamp: string | undefined, nowSeconds: number): boolean {
  const t = Number(timestamp)
  return Number.isFinite(t) && Math.abs(nowSeconds - t) <= TOLERANCE_SECONDS
}

export function verify(
  hook: Pick<WebhookEntry, "provider" | "secret" | "header" | "encoding">,
  headers: Headers,
  body: Buffer,
  url: URL,
  nowSeconds = Math.floor(Date.now() / 1000),
): Verdict {
  switch (hook.provider) {
    case "github": {
      const signature = headers["x-hub-signature-256"]
      if (!signature) return { ok: false, reason: "missing x-hub-signature-256" }
      return safeEqual(signature, `sha256=${hmac(hook.secret, body)}`) ? { ok: true } : { ok: false, reason: "bad signature" }
    }
    case "stripe": {
      const header = headers["stripe-signature"]
      if (!header) return { ok: false, reason: "missing stripe-signature" }
      const parts = header.split(",").map((part) => part.trim().split("=") as [string, string | undefined])
      const t = parts.find(([key]) => key === "t")?.[1]
      if (!fresh(t, nowSeconds)) return { ok: false, reason: "stale or missing timestamp" }
      const expected = hmac(hook.secret, `${t}.${body.toString("utf8")}`)
      const match = parts.some(([key, value]) => key === "v1" && value !== undefined && safeEqual(value, expected))
      return match ? { ok: true } : { ok: false, reason: "bad signature" }
    }
    case "slack": {
      const timestamp = headers["x-slack-request-timestamp"]
      const signature = headers["x-slack-signature"]
      if (!signature) return { ok: false, reason: "missing x-slack-signature" }
      if (!fresh(timestamp, nowSeconds)) return { ok: false, reason: "stale or missing timestamp" }
      const expected = `v0=${hmac(hook.secret, `v0:${timestamp}:${body.toString("utf8")}`)}`
      return safeEqual(signature, expected) ? { ok: true } : { ok: false, reason: "bad signature" }
    }
    case "hmac": {
      const name = (hook.header ?? "x-signature").toLowerCase()
      const raw = headers[name]
      if (!raw) return { ok: false, reason: `missing ${name}` }
      // Algunos emisores anteponen el algoritmo (`sha256=...`).
      const signature = raw.replace(/^sha256=/i, "")
      return safeEqual(signature, hmac(hook.secret, body, hook.encoding ?? "hex"))
        ? { ok: true }
        : { ok: false, reason: "bad signature" }
    }
    case "token": {
      const bearer = headers.authorization?.replace(/^Bearer\s+/i, "")
      const candidate = headers["x-apex-token"] ?? bearer ?? url.searchParams.get("token") ?? undefined
      if (!candidate) return { ok: false, reason: "missing token" }
      return safeEqual(candidate, hook.secret) ? { ok: true } : { ok: false, reason: "bad token" }
    }
  }
}

/** Cuerpo → objeto: JSON, formulario (Slack manda `payload=<json>`) o texto. */
export function parseBody(body: Buffer, contentType: string | undefined): Record<string, unknown> {
  const text = body.toString("utf8")
  const type = (contentType ?? "").toLowerCase()
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = Object.fromEntries(new URLSearchParams(text))
    if (typeof form.payload === "string") {
      try {
        const inner = JSON.parse(form.payload)
        if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>
      } catch {
        // payload que no es JSON: se queda como campo
      }
    }
    return form
  }
  if (text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { body: parsed }
  } catch {
    return { body: text }
  }
}

/** Cabeceras que llegan al agente: las del proveedor, nunca firmas ni credenciales. */
const FORWARDED = /^(x-github-|x-gitlab-event|x-event-|x-request-id|user-agent$|content-type$)/
const HIDDEN = /signature|token|authorization|cookie|secret/

export function forwardedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && FORWARDED.test(key) && !HIDDEN.test(key)) out[key] = value
  }
  return out
}

export interface IngestCall {
  readonly source: string
  readonly type?: string
  readonly eventID?: string
  readonly payload: Record<string, unknown>
}

/** Tipo e id del evento según el proveedor (el id deduplica reintentos en apex). */
export function toIngest(hook: Pick<WebhookEntry, "provider" | "source" | "name">, headers: Headers, payload: Record<string, unknown>): IngestCall {
  let type: string | undefined
  let eventID: string | undefined
  if (hook.provider === "github") {
    const event = headers["x-github-event"]
    const action = typeof payload.action === "string" ? payload.action : undefined
    type = event ? (action ? `${event}.${action}` : event) : undefined
    eventID = headers["x-github-delivery"]
  } else if (hook.provider === "stripe") {
    type = typeof payload.type === "string" ? payload.type : undefined
    eventID = typeof payload.id === "string" ? payload.id : undefined
  } else if (hook.provider === "slack") {
    const inner = payload.event as { type?: unknown } | undefined
    type = typeof inner?.type === "string" ? inner.type : typeof payload.type === "string" ? payload.type : undefined
    eventID = typeof payload.event_id === "string" ? payload.event_id : undefined
  } else {
    type = headers["x-event-type"] ?? (typeof payload.type === "string" ? payload.type : undefined)
    eventID = headers["x-event-id"] ?? headers["x-request-id"]
  }
  return {
    source: hook.source,
    ...(type ? { type } : {}),
    ...(eventID ? { eventID: `${hook.name}:${eventID}` } : {}),
    payload: { ...payload, _webhook: { name: hook.name, provider: hook.provider, headers: forwardedHeaders(headers) } },
  }
}

/** Slack verifica la URL con un `url_verification` que hay que contestar con el challenge. */
export function slackChallenge(hook: Pick<WebhookEntry, "provider">, payload: Record<string, unknown>): string | null {
  return hook.provider === "slack" && payload.type === "url_verification" && typeof payload.challenge === "string"
    ? payload.challenge
    : null
}
