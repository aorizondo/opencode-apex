/**
 * Resolución del endpoint CDP.
 *
 * Desde Chrome 144 hay dos rutas incompatibles y no se pueden sondear igual:
 *
 *   A) --remote-debugging-port (flag)
 *      → GET /json/version devuelve el webSocketDebuggerUrl
 *      → INERTE sobre el user-data-dir por defecto desde Chrome 136
 *
 *   B) chrome://inspect/#remote-debugging (toggle)
 *      → /json/version responde 404 POR DISEÑO
 *      → el WS sale del fichero DevToolsActivePort
 *      → exige un popup de consentimiento POR CONEXIÓN
 *
 * Por eso el orden es: DevToolsActivePort primero, discovery HTTP como
 * respaldo. Un 404 en /json/version no es un error, es la ruta B.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** Perfiles donde Chrome deja DevToolsActivePort. */
export const CANDIDATE_PROFILES = [
  "google-chrome",
  "google-chrome-beta",
  "google-chrome-unstable",
  "google-chrome-dev",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "brave",
  "browser-os",
  "ai.opencode.desktop",
].map((name) => join(homedir(), ".config", name))

export interface ActivePort {
  readonly port: number
  readonly path: string
  readonly source: string
}

export interface EndpointCandidate {
  readonly webSocketDebuggerUrl: string
  readonly profileDir?: string
  readonly how: string
}

export interface Endpoint {
  readonly candidates: readonly EndpointCandidate[]
  readonly how: string
  readonly profileDir?: string
  readonly secure: boolean
}

/**
 * Lee DevToolsActivePort de un perfil. El fichero tiene dos líneas: puerto y
 * ruta del websocket.
 */
export async function readActivePort(profileDir: string): Promise<ActivePort | null> {
  // El perfil pone el fichero en la raíz; algunos builds lo dejan en Default/.
  for (const candidate of [profileDir, join(profileDir, "Default")]) {
    try {
      const raw = await readFile(join(candidate, "DevToolsActivePort"), "utf8")
      const [port, path] = raw.trim().split("\n")
      if (!port || !path?.startsWith("/devtools/browser/")) continue
      return { port: Number(port), path: path.trim(), source: join(candidate, "DevToolsActivePort") }
    } catch {
      // siguiente candidato
    }
  }
  return null
}

/**
 * Todos los perfiles con un DevToolsActivePort que declara `port`.
 *
 * OJO: varios perfiles pueden declarar el MISMO puerto. Medido en esta máquina:
 * google-chrome, chromium y browser-os declaran los tres 9222, pero solo un
 * proceso escucha de verdad (los ficheros de los otros dos están "stale": Chrome
 * los dejó al cerrarse). Por esto devuelve una LISTA y quien conecta prueba en
 * orden — elegir el primero a ciegas puede acabar en un perfil muerto o, peor,
 * en el navegador que el usuario no quiere.
 */
export async function profilesForPort(
  port: number,
  candidates: readonly string[] = CANDIDATE_PROFILES,
): Promise<Array<ActivePort & { profileDir: string }>> {
  const found: Array<ActivePort & { profileDir: string }> = []
  for (const dir of candidates) {
    const active = await readActivePort(dir)
    if (active && active.port === port) found.push({ profileDir: dir, ...active })
  }
  return found
}

/** Todos los perfiles con debugging declarado (pueden incluir stale). */
export async function listActive(
  candidates: readonly string[] = CANDIDATE_PROFILES,
): Promise<Array<ActivePort & { profileDir: string }>> {
  const found: Array<ActivePort & { profileDir: string }> = []
  for (const dir of candidates) {
    const active = await readActivePort(dir)
    if (active) found.push({ profileDir: dir, ...active })
  }
  return found
}

export interface ResolveInput {
  readonly cdpUrl?: string
  readonly profileDir?: string
}

/**
 * Resuelve el webSocketDebuggerUrl.
 *
 * Modos, en orden de precedencia:
 *   1. ws:// o wss:// explícito  → navegador remoto. Se usa tal cual: no hay
 *      DevToolsActivePort ni /json/version que consultar a distancia, así que el
 *      cliente tiene que poder hablar el websocket directamente (típicamente a
 *      través de un túnel/proxy inverso).
 *   2. perfil explícito           → DevToolsActivePort local.
 *   3. "auto"                     → DevToolsActivePort local, 9222 preferido.
 *   4. http://host:puerto         → derivar perfil local, luego /json/version.
 */
export async function resolveEndpoint({ cdpUrl = "auto", profileDir: rawProfileDir }: ResolveInput = {}): Promise<Endpoint> {
  // `~/…` en la config: el shell no está para expandirlo.
  const profileDir =
    rawProfileDir === "~" || rawProfileDir?.startsWith("~/") ? join(homedir(), rawProfileDir.slice(1)) : rawProfileDir
  // 0. Endpoint remoto explícito: ws:// o wss://. Sin discovery posible.
  if (/^wss?:\/\//i.test(cdpUrl)) {
    let parsed: URL
    try {
      parsed = new URL(cdpUrl)
    } catch {
      throw new Error(`browser.cdpUrl no es un websocket válido: ${cdpUrl}`)
    }
    return one({
      webSocketDebuggerUrl: parsed.toString(),
      how: parsed.protocol === "wss:" ? "remote-wss" : "remote-ws",
      secure: parsed.protocol === "wss:",
    })
  }

  // 1. Perfil explícito: lee su DevToolsActivePort y ya está.
  if (profileDir) {
    const active = await readActivePort(profileDir)
    if (!active) {
      throw new Error(
        `No hay DevToolsActivePort en ${profileDir}. Activa el debugging remoto en ` +
          `chrome://inspect/#remote-debugging de ese perfil.`,
      )
    }
    return one({
      webSocketDebuggerUrl: `ws://127.0.0.1:${active.port}${active.path}`,
      profileDir,
      how: "devtools-active-port",
    })
  }

  // 2. Modo auto: preferimos 9222, si no el primer candidato vivo.
  if (cdpUrl === "auto" || cdpUrl === "") {
    const actives = await listActive()
    if (actives.length === 0) {
      throw new Error(
        "Ningún perfil tiene DevToolsActivePort. Activa el debugging remoto en " +
          "chrome://inspect/#remote-debugging del Chrome que quieras usar.",
      )
    }
    const ordered = [...actives.filter((a) => a.port === 9222), ...actives.filter((a) => a.port !== 9222)]
    const first = ordered[0]
    if (!first) throw new Error("Ningún perfil tiene DevToolsActivePort.")
    return one({
      candidates: ordered.map((a) => ({
        webSocketDebuggerUrl: `ws://127.0.0.1:${a.port}${a.path}`,
        profileDir: a.profileDir,
        how: "devtools-active-port",
      })),
      how: "devtools-active-port",
      profileDir: first.profileDir,
    })
  }

  // 3. Puerto explícito → derivamos el perfil, o caemos al discovery HTTP.
  const port = extractPort(cdpUrl)
  const host = extractHost(cdpUrl)

  if (port !== undefined) {
    const matches = await profilesForPort(port)
    const first = matches[0]
    if (first) {
      return one({
        candidates: matches.map((m) => ({
          webSocketDebuggerUrl: `ws://${host}:${m.port}${m.path}`,
          profileDir: m.profileDir,
          how: "port-to-profile",
        })),
        how: "port-to-profile",
        profileDir: first.profileDir,
      })
    }
  }

  // 4. Ruta del flag clásico: /json/version.
  const base = `http://${host}:${port ?? 9222}`
  const version = (await fetch(`${base}/json/version`)
    .then((r) => (r.ok ? (r.json() as Promise<{ webSocketDebuggerUrl?: string }>) : null))
    .catch(() => null)) as { webSocketDebuggerUrl?: string } | null
  if (!version?.webSocketDebuggerUrl) {
    throw new Error(
      `No hay CDP en ${base}. Si el navegador usa el toggle de ` +
        `chrome://inspect/#remote-debugging, /json/version da 404 por diseño: ` +
        `pasa browser.profile o deja browser.cdpUrl en "auto".`,
    )
  }
  return one({
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    how: "http-discovery",
    secure: false,
  })
}

/** Lo mínimo para describir un endpoint; `one` completa los campos ausentes. */
type EndpointSeed = EndpointCandidate & { secure?: boolean }

const one = (seed: EndpointSeed | { candidates: readonly EndpointCandidate[]; how: string; profileDir?: string }): Endpoint => {
  const fallback: EndpointCandidate = "webSocketDebuggerUrl" in seed ? seed : (seed.candidates[0] as EndpointCandidate)
  return {
    how: "how" in seed ? seed.how : fallback.how,
    profileDir: "profileDir" in seed ? seed.profileDir : fallback.profileDir,
    secure: "secure" in seed ? (seed.secure ?? false) : fallback.webSocketDebuggerUrl.startsWith("wss://"),
    candidates: "candidates" in seed && seed.candidates.length > 0 ? seed.candidates : [fallback],
  }
}

const extractPort = (value: string) => {
  const match = /:(\d{2,5})\b/.exec(value)
  if (match) return Number(match[1])
  if (/^\d{2,5}$/.test(value.trim())) return Number(value.trim())
  return undefined
}

const extractHost = (value: string) => {
  const match = /^[a-z]+:\/\/([^/:]+)/.exec(value)
  return match && match[1] ? match[1] : "127.0.0.1"
}
