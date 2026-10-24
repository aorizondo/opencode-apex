/**
 * Core bus module for opencode-apex.
 * Provides an in-memory event buffer with optional persistence for inter-module communication.
 */

import type { EventDomain } from "@opencode/plugin/promise/event"
import type { StorageDomain } from "@opencode/plugin/promise/storage"

/**
 * Event envelope for the internal event bus.
 */
export interface BusEvent<T = unknown> {
  /** Unique event ID */
  id: string
  /** Event type/name (e.g., "profiles.changed", "redact.finding") */
  type: string
  /** Event payload */
  payload: T
  /** Timestamp of event creation */
  timestamp: number
  /** Source module that emitted the event */
  source: string
  /** Optional correlation ID for tracing */
  correlationId?: string
}

/** Event handler type */
export type BusHandler<T = unknown> = (event: BusEvent<T>) => Promise<void> | void

/** Subscription handle for cleanup */
export interface BusSubscription {
  /** Unsubscribe from events */
  unsubscribe: () => void
}

/** Configuration for the event bus */
export interface BusConfig {
  /** Máximo de eventos en el buffer en memoria */
  maxBufferSize: number
  /** Persistir eventos en storage */
  persist: boolean
  /** Prefijo de storage cuando persist=true */
  storagePrefix: string
}

/** Default bus configuration */
const DEFAULT_CONFIG: BusConfig = {
  maxBufferSize: 1000,
  persist: false,
  storagePrefix: "apex.bus.events.",
}

/** In-memory event buffer */
const eventBuffer: BusEvent[] = []

/** Event subscribers by type */
const subscribers: Map<string, Set<BusHandler>> = new Map()

/** Generate a unique event ID */
function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

/**
 * Emit an event to all subscribers and buffer it.
 */
export async function emit<T>(
  type: string,
  payload: T,
  source: string,
  options?: { correlationId?: string; persist?: boolean },
): Promise<string> {
  const event: BusEvent<T> = {
    id: generateEventId(),
    type,
    payload,
    timestamp: Date.now(),
    source,
    correlationId: options?.correlationId,
  }

  // Add to buffer
  eventBuffer.push(event)
  if (eventBuffer.length > DEFAULT_CONFIG.maxBufferSize) {
    eventBuffer.shift()
  }

  // Notify subscribers
  const handlers = subscribers.get(type)
  if (handlers) {
    await Promise.all(
      Array.from(handlers).map((handler) =>
        Promise.resolve(handler(event)).catch((err) => {
          console.error(`[apex.bus] Handler error for ${type}:`, err)
        }),
      ),
    )
  }

  // Also notify wildcard subscribers
  const wildcardHandlers = subscribers.get("*")
  if (wildcardHandlers) {
    await Promise.all(
      Array.from(wildcardHandlers).map((handler) =>
        Promise.resolve(handler(event)).catch((err) => {
          console.error(`[apex.bus] Wildcard handler error for ${type}:`, err)
        }),
      ),
    )
  }

  return event.id
}

/**
 * Subscribe to events of a specific type (or "*" for all).
 */
export function subscribe<T = unknown>(
  type: string,
  handler: BusHandler<T>,
): BusSubscription {
  if (!subscribers.has(type)) {
    subscribers.set(type, new Set())
  }
  subscribers.get(type)!.add(handler as BusHandler)

  return {
    unsubscribe: () => {
      const set = subscribers.get(type)
      if (set) {
        set.delete(handler as BusHandler)
        if (set.size === 0) {
          subscribers.delete(type)
        }
      }
    },
  }
}

/**
 * Get recent events from buffer (optionally filtered by type).
 */
export function getRecentEvents<T = unknown>(
  type?: string,
  limit = 100,
): BusEvent<T>[] {
  let events = eventBuffer
  if (type) {
    events = eventBuffer.filter((e) => e.type === type)
  }
  return events.slice(-limit) as BusEvent<T>[]
}

/**
 * Clear the event buffer.
 */
export function clearBuffer(): void {
  eventBuffer.length = 0
}

/**
 * Register bus module.
 * Sets up event subscription bridge to OpenCode's event system.
 * Returns cleanup function that clears subscriptions and buffer.
 */
export async function register(
  ctx: { event: EventDomain; storage: StorageDomain },
  config: { enabled: boolean },
): Promise<() => Promise<void>> {
  if (!config.enabled) {
    return async () => {}
  }

  // Bridge OpenCode events to internal bus (optional)
  // This allows modules to react to OpenCode events via the bus
  const controller = new AbortController()

  // Subscribe to all OpenCode events and re-emit on internal bus
  // (In practice, modules would subscribe directly to ctx.event)
  // This is a stub for the bridge pattern
  void (async () => {
    for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
      await emit(`opencode.${ev.type}`, ev, "opencode-bridge")
    }
  })().catch(() => undefined)

  return async () => {
    controller.abort()
    subscribers.clear()
    clearBuffer()
  }
}
