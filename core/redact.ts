/**
 * Apex Redact — motor de redacción/restauración.
 *
 * Marcador (autocontenido y legible):
 *   `${prefix}${patternName}:${base64url(iv||tag||ciphertext)}${suffix}`
 *   p. ej. `[SECRET:github-pat:AbC123...]`
 *
 *  - `patternName` es el nombre del patrón que detectó el secreto → el usuario
 *    ve una referencia legible aunque no pueda ver el secreto.
 *  - El payload se descifra con la clave: no hay mapping en memoria.
 *
 * Redacción: hook `context` (entrada al modelo).
 * Restauración: hook `execute.before` (salida hacia la herramienta).
 */

import { decryptSecret, encryptSecret, escapeRegExp } from "./crypto.js"
import type { PatternDefinition } from "./patterns.js"

export type RedactMode = "strict" | "warn"

export interface RedactEngineOptions {
  readonly patterns: readonly PatternDefinition[]
  readonly allowlist: readonly RegExp[]
  readonly prefix: string
  readonly suffix: string
  readonly key: Buffer
  readonly mode: RedactMode
  /** Callback opcional de observabilidad (secreto nunca incluido). */
  readonly onFinding?: (finding: { pattern: string; stage?: string }) => void
}

export interface RedactEngine {
  readonly redactText: (text: string, stage?: string) => string
  readonly restoreText: (text: string) => string
  readonly redactValue: (value: unknown, stage?: string) => unknown
  readonly restoreValue: (value: unknown) => unknown
  /** Regex que reconoce los marcadores generados (con prefix/suffix actuales). */
  readonly markerRegex: RegExp
}

const MAX_DEPTH = 32

/** Caracteres admitidos en el nombre de patrón dentro del marcador. */
function sanitizeLabel(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "-")
  return safe.length > 0 ? safe : "secret"
}

/**
 * Crea el motor. Compila la regex de marcador a partir de prefix/suffix.
 */
export function createRedactEngine(options: RedactEngineOptions): RedactEngine {
  const { patterns, allowlist, prefix, suffix, key, mode, onFinding } = options

  // `prefix`/`suffix` pueden contener metacaracteres regex → se escapan.
  // Grupo 1: nombre del patrón · Grupo 2: payload cifrado.
  const markerRegex = new RegExp(
    `${escapeRegExp(prefix)}([A-Za-z0-9_.-]+):([A-Za-z0-9_-]+)${escapeRegExp(suffix)}`,
    "g",
  )

  const isAllowed = (match: string): boolean => allowlist.some((re) => re.test(match))

  /**
   * Redacta un texto en UNA sola pasada sobre el original:
   *  1. se recogen todas las coincidencias de todos los patrones,
   *  2. se descartan solapes (gana la más larga / más temprana),
   *  3. se construye la salida insertando un marcador por coincidencia.
   *
   * Pasada única ⇒ un patrón nunca puede volver a coincidir con un marcador
   * ya generado (evita el doble cifrado en cascada).
   */
  const redactText = (text: string, stage?: string): string => {
    if (!text) return text

    interface Hit {
      start: number
      end: number
      value: string
      pattern: string
    }

    const hits: Hit[] = []

    // Los marcadores ya presentes son regiones protegidas: ninguna coincidencia
    // puede solaparlos. Esto hace la redacción IDEMPOTENTE: el hook `context`
    // re-redacta el histórico completo en cada petición sin doble cifrado.
    const protectedSpans: Array<{ start: number; end: number }> = []
    markerRegex.lastIndex = 0
    for (;;) {
      const marker = markerRegex.exec(text)
      if (marker === null) break
      const markerText = marker[0]
      if (markerText.length === 0) {
        markerRegex.lastIndex++
        continue
      }
      protectedSpans.push({ start: marker.index, end: marker.index + markerText.length })
    }
    const overlapsProtected = (start: number, end: number): boolean =>
      protectedSpans.some((span) => start < span.end && end > span.start)

    for (const pattern of patterns) {
      // Copia con flag global para no mutar el estado compartido entre llamadas.
      const flags = pattern.regex.flags.includes("g")
        ? pattern.regex.flags
        : `${pattern.regex.flags}g`
      const regex = new RegExp(pattern.regex.source, flags)
      for (;;) {
        const match = regex.exec(text)
        if (match === null) break
        const value = match[0]
        if (value.length === 0) {
          regex.lastIndex++
          continue
        }
        if (overlapsProtected(match.index, match.index + value.length)) continue
        // Validación extra por patrón (p. ej. Luhn para tarjetas, IPs privadas)
        if (pattern.validate && !pattern.validate(value)) continue
        hits.push({
          start: match.index,
          end: match.index + value.length,
          value,
          pattern: pattern.name,
        })
      }
    }

    if (hits.length === 0) return text

    // Orden por posición; a igual inicio, la coincidencia más larga primero.
    hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))

    // Resolución de solapes: se conserva la primera (más larga) y se salta el resto.
    const chosen: Hit[] = []
    let lastEnd = -1
    for (const hit of hits) {
      if (hit.start >= lastEnd) {
        chosen.push(hit)
        lastEnd = hit.end
      }
    }

    let out = ""
    let cursor = 0
    for (const hit of chosen) {
      out += text.slice(cursor, hit.start)
      if (isAllowed(hit.value)) {
        out += hit.value
      } else {
        onFinding?.({ pattern: hit.pattern, stage })
        out +=
          mode === "warn"
            ? hit.value
            : `${prefix}${sanitizeLabel(hit.pattern)}:${encryptSecret(hit.value, key)}${suffix}`
      }
      cursor = hit.end
    }
    out += text.slice(cursor)

    return out
  }

  /**
   * Restaura un texto: descifra cada marcador. Si un marcador no se puede
   * descifrar (forma coincidente pero no generado por nosotros) se deja intacto.
   */
  const restoreText = (text: string): string => {
    if (!text) return text
    markerRegex.lastIndex = 0
    return text.replace(markerRegex, (marker, _label: string, payload: string) => {
      const secret = decryptSecret(payload, key)
      return secret === null ? marker : secret
    })
  }

  /**
   * ¿Es un objeto que NO debemos transformar? (estructuras especiales)
   * Todo lo demás —incluidas instancias de clase— SÍ se recorre: un
   * `Schema.Class` o cualquier objeto con datos debe redactarse igualmente.
   */
  const shouldSkipObject = (value: object): boolean => {
    const candidate = value as Record<string | symbol, unknown>
    // Streams
    if (typeof candidate.getReader === "function") return true
    if (typeof candidate.pipeThrough === "function") return true
    if (typeof candidate.pipeTo === "function") return true
    // Request / Response / Blob
    if (typeof candidate.arrayBuffer === "function") return true
    // Thenables / promesas
    if (typeof candidate.then === "function") return true
    // Iterables: Map, Set, Buffer/TypedArray, Headers…
    if (Symbol.iterator in value || Symbol.asyncIterator in value) return true

    const ctor = candidate.constructor
    if (typeof ctor === "function") {
      const skip: ReadonlyArray<unknown> = [
        Date, RegExp, Error, Promise, URL, URLSearchParams, AbortController, AbortSignal,
        ArrayBuffer, SharedArrayBuffer, DataView, WeakMap, WeakSet,
      ]
      if (skip.includes(ctor)) return true
      const name = ctor.name
      if (name === "Date" || name === "RegExp" || name === "Error" || name === "Buffer") return true
    }
    return false
  }

  /** Recorre recursivamente strings dentro de objetos/arrays. */
  const transformValue = (
    value: unknown,
    transform: (text: string) => string,
    depth: number,
  ): unknown => {
    if (depth > MAX_DEPTH) return value

    if (typeof value === "string") return transform(value)

    if (Array.isArray(value)) {
      let changed = false
      const next = value.map((item) => {
        const out = transformValue(item, transform, depth + 1)
        if (out !== item) changed = true
        return out
      })
      return changed ? next : value
    }

    if (value !== null && typeof value === "object") {
      // Estructuras especiales (streams, Request/Response, Date, Map…) intactas.
      if (shouldSkipObject(value)) return value

      let changed = false
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const out = transformValue(v, transform, depth + 1)
        if (out !== v) changed = true
        next[k] = out
      }
      if (!changed) return value

      // Preservar el prototipo: una instancia de clase sigue siéndolo
      // (no rompemos métodos/getters) pero con los strings ya transformados.
      const proto = Object.getPrototypeOf(value)
      return Object.assign(Object.create(proto ?? Object.prototype), next)
    }

    return value
  }

  const redactValue = (value: unknown, stage?: string): unknown =>
    transformValue(value, (text) => redactText(text, stage), 0)

  const restoreValue = (value: unknown): unknown => transformValue(value, restoreText, 0)

  return { redactText, restoreText, redactValue, restoreValue, markerRegex }
}
