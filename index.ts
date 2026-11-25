/**
 * opencode-apex — Modular monolithic plugin for OpenCode V2 (Effect-native API).
 *
 * Modules:
 * - redact: Secret detection (regex), encryption-based redaction, restore on tool input
 * - events: RPC event ingestion (callbacks/webhooks), subscriptions, delivery, tools.run
 * - advisor: allow/deny permission decisions via a dedicated agent + side session
 * - guard: meta-permissions per agent/tool/path (opt-in)
 * - browser: (deprecated, off by default; OpenCode's browse replaces it) browser.* tools
 *   against a headless or remote Chromium over CDP (attach on request)
 * - tempAccess: external_directory without prompts in OpenCode's temp directory
 * - endpoints: OpenTunnel routes, verified webhooks and supervised microservices, kept
 *   by a per-user apex daemon that outlives the plugin (daemon/main.ts)
 *
 * Built on the official Effect plugin API: https://opencode.ai/v2/docs/build/plugins/effect/
 */

import { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { homedir } from "node:os"
import { loadApexConfig, loadConfig, type ApexConfig } from "./core/config.js"
import { emit as busEmit } from "./core/bus.js"
import { register as registerRedact, createDefaultRedactConfig, type RedactConfig } from "./redact.js"
import { register as registerEvents, createDefaultEventsConfig, type EventsConfig } from "./events.js"
import { register as registerAdvisor, createDefaultAdvisorConfig, type AdvisorConfig } from "./advisor.js"
import { register as registerGuard, createDefaultGuardConfig, type GuardConfigShape } from "./guard.js"
import { register as registerBrowser, createDefaultBrowserConfig, type BrowserConfigShape } from "./browser.js"
import { registerCentralRpc } from "./core/rpc.js"
import { registerSkills } from "./core/skills.js"
import { compatibilityWarnings } from "./core/compat.js"
import { registerTempAccess } from "./core/temp-access.js"
import { register as registerEndpoints } from "./endpoints.js"

// Plugin version
const VERSION = "0.4.0"

interface ModuleConfigs {
  redact: RedactConfig & { enabled: boolean }
  events: EventsConfig & { enabled: boolean }
  advisor: AdvisorConfig & { enabled: boolean }
  guard: GuardConfigShape & { enabled: boolean }
  browser: BrowserConfigShape
}

/**
 * Merge user config with defaults for each module.
 */
function getModuleConfigs(userConfig: ApexConfig): ModuleConfigs {
  return {
    redact: { ...createDefaultRedactConfig(), ...userConfig.redact, enabled: userConfig.modules?.redact ?? true },
    events: { ...createDefaultEventsConfig(), ...userConfig.events, enabled: userConfig.modules?.events ?? true } as ModuleConfigs["events"],
    advisor: { ...createDefaultAdvisorConfig(), ...userConfig.advisor, enabled: userConfig.modules?.advisor ?? true },
    // Opt-in: sin reglas no hace nada útil, y con reglas mal puestas bloquea al
    // agente, así que se activa a mano.
    // `agents` se mezcla por agente: la config validada siempre trae `agents: {}` y,
    // con un spread plano, borraba las reglas por defecto de apex-advisor.
    guard: {
      ...createDefaultGuardConfig(),
      ...userConfig.guard,
      agents: { ...createDefaultGuardConfig().agents, ...userConfig.guard?.agents },
      enabled: userConfig.modules?.guard ?? false,
    },
    // Obsoleto desde 0.3.0, desactivado por defecto: para usar tu navegador está `browse`
    // de OpenCode (https://opencode.ai/product/browse). Queda para Chromium headless o
    // remoto por CDP y para las capturas de rendimiento de `browser.*`.
    browser: {
      ...createDefaultBrowserConfig(),
      ...userConfig.browser,
      enabled: userConfig.modules?.browser ?? false,
    },
  }
}

/**
 * Main plugin definition (Effect-native).
 */
export default Plugin.define({
  id: "apex",
  effect: (ctx) =>
    Effect.gen(function* () {
      // Versiones desalineadas con OpenCode: avisar con la solución antes de fallar críptico.
      for (const warning of compatibilityWarnings(ctx.app?.version)) {
        console.warn(`[apex] ${warning}`)
        yield* Effect.logWarning(`[apex] ${warning}`)
      }

      // Configuración con JERARQUÍA y dos canales.
      //   precedencia (menor → mayor): fichero global
      //   (<config>/opencode/opencode-apex.jsonc) → opciones inline del plugin
      //   (opencode.json, ya mergeadas local>global por el host) → fichero local
      //   (<proyecto>/.opencode/opencode-apex.jsonc). Ver docs/CONFIG.md.
      const home = homedir()
      const projectDir = ctx.location.directory
      const loaded = yield* Effect.tryPromise(() =>
        loadApexConfig({
          projectDir,
          home,
          options: ctx.options as Record<string, unknown> | undefined,
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`[apex] configuración inválida, usando defaults: ${String(error)}`).pipe(
            Effect.andThen(
              Effect.promise(() =>
                loadApexConfig({ projectDir, home, options: undefined }).catch(() => ({
                  config: undefined as unknown as ApexConfig,
                  sources: { inline: false, global: false, local: false },
                  paths: { global: "", local: "" },
                })),
              ),
            ),
          ),
        ),
      )
      const validatedConfig = loaded.config ?? (yield* Effect.promise(() => loadConfig(`${projectDir}/__apex_defaults__.jsonc`)))
      yield* Effect.logInfo(
        `[apex] config: inline=${loaded.sources.inline} global=${loaded.sources.global} local=${loaded.sources.local} · global=${loaded.paths.global} · local=${loaded.paths.local}`,
      )

      // Get module configs with defaults
      const moduleConfigs = getModuleConfigs(validatedConfig)

      // --- Bus: feed OpenCode events into the apex event buffer ---
      yield* ctx.event.subscribe().pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            busEmit(event.type, (event.data ?? {}) as Record<string, unknown>, "opencode")
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )

      // --- Feature modules (conditionally enabled) ---
      if (moduleConfigs.redact.enabled) {
        yield* registerRedact(ctx, moduleConfigs.redact)
      }

      const events = moduleConfigs.events.enabled ? yield* registerEvents(ctx, validatedConfig) : null

      // ANTES del advisor, y el orden es funcional, no estético: el host recorre
      // los hooks de `permission.evaluate` en orden de registro sobre el mismo
      // evento, y el advisor solo juzga lo que siga en "ask". Con el guard
      // delante, lo que él resuelve no llega al advisor; al revés, el advisor
      // aprobaría cosas que el guard iba a prohibir.
      if (moduleConfigs.guard.enabled) {
        yield* registerGuard(ctx, moduleConfigs.guard)
      }

      // Después del guard (sus deny se respetan) y antes del advisor (no ve lo ya resuelto).
      if (validatedConfig.modules?.tempAccess ?? true) {
        yield* registerTempAccess(ctx)
      }

      if (moduleConfigs.advisor.enabled) {
        yield* registerAdvisor(ctx, moduleConfigs.advisor)
      }

      // Túneles, webhooks verificados y microservicios, vía el daemon de apex.
      if (validatedConfig.modules?.endpoints ?? true) {
        yield* registerEndpoints(ctx, { version: VERSION, endpoint: events?.endpoint ?? null })
      }

      if (moduleConfigs.browser.enabled) {
        yield* Effect.logWarning(
          "[apex.browser] deprecated: use OpenCode's browse (https://opencode.ai/product/browse) to drive your browser; keep this module only for a headless or remote Chromium over CDP",
        )
        yield* registerBrowser(ctx, moduleConfigs.browser)
      }

      // --- Central RPC registration (the "apex" namespace) ---
      yield* registerCentralRpc(ctx, {
        version: VERSION,
        modules: moduleConfigs as unknown as Record<string, { enabled: boolean }>,
        events,
      })

      // --- Skills que viajan con el paquete (callbacks, webhooks, tools.run) ---
      if (events) yield* registerSkills(ctx)

    }),
})

// Re-export types for external use
export type { ApexConfig }
