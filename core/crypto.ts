/**
 * Apex Redact — criptografía del marcador de secretos.
 *
 * Cada secreto se cifra con AES-256-GCM y se sustituye por:
 *   `${prefix}${base64url(iv || tag || ciphertext)}${suffix}`
 *
 * No hay mapping interno: la restauración descifra el propio marcador.
 * La clave se resuelve desde la configuración del plugin (material directo,
 * `env:VAR`, `file:/ruta`, `hex:...` o `base64:...`).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const TAG_LENGTH = 16

/** Fuente de la que se obtuvo el material de clave. */
export type KeySource = "config" | "env" | "file" | "generated"

export interface ResolvedKey {
  readonly key: Buffer
  readonly source: KeySource
  readonly fingerprint: string
}

/**
 * Deriva 32 bytes de clave a partir del material (determinista).
 * El mismo material produce siempre la misma clave → descifrable entre sesiones.
 */
export function deriveKey(material: string): Buffer {
  return createHash("sha256").update(material, "utf8").digest()
}

/** Fingerprint corto (no reversible) para logs y diagnóstico. */
export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8)
}

const DEFAULT_KEY_FILE = join(homedir(), ".config", "opencode", "apex.key")

/**
 * Resuelve el material de clave desde la especificación de configuración.
 *
 * Formatos aceptados:
 *  - `env:NOMBRE`      → variable de entorno
 *  - `file:/ruta`      → contenido del fichero (trim)
 *  - `hex:0102...`     → bytes hexadecimales (usados como material)
 *  - `base64:...`      → bytes base64 (usados como material)
 *  - cualquier otro    → el propio literal como material
 *
 * Si no hay material disponible se genera una clave aleatoria y se persiste
 * en `~/.config/opencode/apex.key` (0600), avisando por consola: la clave debe
 * fijarse en la configuración para que sea estable entre equipos/sesiones.
 */
export function resolveKey(spec: string | undefined): ResolvedKey {
  const material = resolveKeyMaterial(spec)
  if (material) {
    const key = deriveKey(material.value)
    return { key, source: material.source, fingerprint: keyFingerprint(key) }
  }

  // Sin material en config/env: reutilizar la clave persistida de una
  // ejecución anterior antes de generar una nueva (si no, los marcadores
  // emitidos previamente quedarían huérfanos e irrestaurables).
  const persisted = readPersistedKey()
  if (persisted) {
    return { key: persisted, source: "generated", fingerprint: keyFingerprint(persisted) }
  }

  // Fallback: clave aleatoria persistida
  const key = generatePersistedKey()
  return { key, source: "generated", fingerprint: keyFingerprint(key) }
}

/**
 * Lee la clave persistida por una ejecución anterior (`apex.key` = 32 bytes
 * en base64). Devuelve null si no existe, está vacía o no es válida — en ese
 * caso el llamador genera (y persiste) una nueva.
 */
function readPersistedKey(): Buffer | null {
  try {
    if (!existsSync(DEFAULT_KEY_FILE)) return null
    const raw = readFileSync(DEFAULT_KEY_FILE, "utf8").trim()
    if (!raw) return null
    const key = Buffer.from(raw, "base64")
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

function resolveKeyMaterial(
  spec: string | undefined,
): { value: string; source: KeySource } | null {
  const raw = (spec ?? "").trim()

  if (raw.startsWith("env:")) {
    const name = raw.slice(4).trim()
    const value = process.env[name]
    if (value) return { value, source: "env" }
    return null
  }

  if (raw.startsWith("file:")) {
    const spec = raw.slice(5).trim()
    const path = spec === "~" || spec.startsWith("~/") ? join(homedir(), spec.slice(1)) : spec
    try {
      if (existsSync(path)) {
        const value = readFileSync(path, "utf8").trim()
        if (value) return { value, source: "file" }
      }
    } catch {
      // fichero ilegible → siguiente fuente
    }
    return null
  }

  if (raw.startsWith("hex:")) {
    const hex = raw.slice(4).trim()
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length > 0) return { value: hex, source: "config" }
    return null
  }

  if (raw.startsWith("base64:")) {
    const b64 = raw.slice(7).trim()
    if (b64.length > 0) return { value: b64, source: "config" }
    return null
  }

  if (raw.length > 0) return { value: raw, source: "config" }

  // Sin config: env por defecto
  const envValue = process.env.APEX_REDACT_KEY
  if (envValue) return { value: envValue, source: "env" }

  return null
}

function generatePersistedKey(): Buffer {
  const key = randomBytes(32)
  try {
    mkdirSync(dirname(DEFAULT_KEY_FILE), { recursive: true })
    writeFileSync(DEFAULT_KEY_FILE, key.toString("base64"), { mode: 0o600 })
    chmodSync(DEFAULT_KEY_FILE, 0o600)
    console.warn(
      `[apex.redact] No hay clave configurada. Generada clave aleatoria en ${DEFAULT_KEY_FILE}. ` +
        `Fija "redact.key" en la config (o la env APEX_REDACT_KEY) para una clave estable.`,
    )
  } catch (error) {
    console.warn(`[apex.redact] No se pudo persistir la clave generada: ${String(error)}`)
  }
  return key
}

/** Cifra un secreto y devuelve el payload base64url (iv || tag || ciphertext). */
export function encryptSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url")
}

/**
 * Descifra un payload de marcador. Devuelve `null` si el payload no es válido
 * o la autenticación GCM falla (p. ej. un texto con forma de marcador que no
 * fue generado por nosotros) — en ese caso el llamador deja el texto intacto.
 */
export function decryptSecret(payload: string, key: Buffer): string | null {
  try {
    const buffer = Buffer.from(payload, "base64url")
    if (buffer.length < IV_LENGTH + TAG_LENGTH + 1) return null

    const iv = buffer.subarray(0, IV_LENGTH)
    const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH)

    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString("utf8")
  } catch {
    return null
  }
}

/** Escapa una cadena para usarla como literal dentro de una RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
