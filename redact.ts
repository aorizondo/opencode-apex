/**
 * Apex Redact — módulo de redacción de secretos basada en cifrado.
 *
 * Flujo (crítico):
 *   ENTRADA al modelo → REDACTAR
 *     - session.hook("context")   ← único punto: system prompt + mensajes + tools
 *
 *   SALIDA hacia la herramienta → RESTAURAR
 *     - tool.hook("execute.before") ← único punto: argumentos de la tool
 *
 *   El resto de salidas (respuesta del modelo, razonamiento) NO se restauran:
 *   el usuario ve marcadores legibles `[SECRET:patrón:cifrado]` en lugar del
 *   secreto. El store de sesión conserva el texto original (solo se redacta
 *   de cara al modelo).
 *
 * El marcador es `${prefix}${patternName}:${base64url(iv||tag||ciphertext)}${suffix}`:
 * no hay mapping en memoria, la restauración descifra el propio marcador.
 */

import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { compilePatterns, DEFAULT_BUNDLES, type PatternDefinition } from "./core/patterns.js"
import { createRedactEngine, type RedactEngine } from "./core/redact.js"
import { resolveKey } from "./core/crypto.js"
import type { RedactConfig } from "./core/config.js"

export type { RedactConfig }

/** Findings del último proceso RPC (reutilizado para no asignar en cada llamada). */
const rpcFindings: Array<{ pattern: string }> = []

/** Handler del módulo, consumido por el RPC `redact.process` (set en register). */
export let redactHandler:
  | ((input: { text: string; mode?: "strict" | "warn" }) => { redacted: string; findings: unknown[] })
  | null = null

export function createDefaultRedactConfig(): RedactConfig & { enabled: boolean } {
  return {
    enabled: true,
    mode: "strict",
    patterns: [],
    bundles: [...DEFAULT_BUNDLES],
    minConfidence: "medium",
    allowlist: [],
    prefix: "[SECRET:",
    suffix: "]",
    key: "",
    restore: { toolInput: true },
  }
}

// ---------------------------------------------------------------------------
// Compilación de la configuración → motor
// ---------------------------------------------------------------------------

export interface CompiledRedact {
  readonly engine: RedactEngine
  readonly patterns: PatternDefinition[]
  readonly allowlist: RegExp[]
}

export function compileRedactConfig(config: RedactConfig): CompiledRedact {
  const patterns = compilePatterns(config.bundles ?? [], config.patterns ?? [], config.minConfidence ?? "medium")
  const allowlist = (config.allowlist ?? []).flatMap((source) => {
    try {
      return [new RegExp(source)]
    } catch (error) {
      console.warn(`[apex.redact] allowlist inválida (${source}): ${String(error)}`)
      return []
    }
  })

  const { key, source, fingerprint } = resolveKey(config.key)
  console.info(`[apex.redact] Clave cargada (source=${source}, fp=${fingerprint}), ${patterns.length} patrones activos`)

  const engine = createRedactEngine({
    patterns,
    allowlist,
    prefix: config.prefix,
    suffix: config.suffix,
    key,
    mode: config.mode,
    onFinding: ({ pattern, stage }) => {
      console.debug(`[apex.redact] secreto detectado (patrón=${pattern}, stage=${stage ?? "?"})`)
    },
  })

  return { engine, patterns, allowlist }
}

// ---------------------------------------------------------------------------
// Registro del módulo (Effect-native)
// ---------------------------------------------------------------------------

export function register(
  ctx: Plugin.Context,
  config: RedactConfig & { enabled?: boolean },
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (!config.enabled) return

    const { engine, patterns, allowlist } = compileRedactConfig(config)
    const key = resolveKey(config.key).key

    // Motores precompilados para el RPC (evita recompilar y re-resolver la clave
    // en cada llamada).
    const rpcEngines = {
      strict: createRedactEngine({
        patterns, allowlist, prefix: config.prefix, suffix: config.suffix,
        key, mode: "strict", onFinding: (f) => rpcFindings.push({ pattern: f.pattern }),
      }),
      warn: createRedactEngine({
        patterns, allowlist, prefix: config.prefix, suffix: config.suffix,
        key, mode: "warn", onFinding: (f) => rpcFindings.push({ pattern: f.pattern }),
      }),
    }
    const restoreCfg = config.restore ?? { toolInput: true }

    // Exponer la redacción por RPC (motores precompilados)
    redactHandler = (input) => {
      rpcFindings.length = 0
      const probe = (input.mode ?? config.mode) === "warn" ? rpcEngines.warn : rpcEngines.strict
      const redacted = probe.redactText(input.text, "rpc")
      return { redacted, findings: [...rpcFindings] }
    }

    // ------------------------------------------------------------------
    // ENTRADA al modelo → redactar
    // ------------------------------------------------------------------
    // Punto único: el hook `context` recibe system prompt + mensajes (incluye
    // prompt del usuario y resultados de tools) + definiciones de tools, justo
    // antes de enviarse al proveedor. Es transport-agnostic (HTTP, WS o ACP).
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        event.system = engine.redactValue(event.system, "system") as typeof event.system
        event.messages = engine.redactValue(event.messages, "messages") as typeof event.messages
        event.tools = engine.redactValue(event.tools, "tools") as typeof event.tools
      }),
    )

    // ------------------------------------------------------------------
    // SALIDA hacia la herramienta → restaurar
    // ------------------------------------------------------------------
    // El modelo solo vio marcadores; al invocar una tool, sus argumentos deben
    // volver a ser el secreto real para que la herramienta funcione.
    if (restoreCfg.toolInput) {
      yield* ctx.tool.hook("execute.before", (event) =>
        Effect.sync(() => {
          if (event.input !== undefined) {
            event.input = engine.restoreValue(event.input)
          }
        }),
      )
    }
  })
}
