import type { CanvasApi, CanvasSnapshot } from '@8btc/whiteboard'

export type CanvasHistorySnapshot = {
  past: CanvasSnapshot[]
  present: CanvasSnapshot
  future: CanvasSnapshot[]
}

type CanvasHistoryMutableApi = CanvasApi & {
  _updateState?: (
    partial: Partial<CanvasSnapshot>,
    addToHistory: boolean
  ) => void
}

export type CanvasHistoryCacheLimits = {
  maxSessions: number
  maxHistorySteps: number
  maxSessionBytes: number
  maxTotalBytes: number
}

export type CanvasHistoryCacheSaveResult = {
  cached: boolean
  sizeBytes: number
  reason?: 'missing_api' | 'present_too_large' | 'global_limit'
}

export type LimitedCanvasHistory = {
  history: CanvasHistorySnapshot | null
  sizeBytes: number
  truncated: boolean
  reason?: 'present_too_large'
}

type CanvasHistoryCacheEntry = {
  history: CanvasHistorySnapshot
  sizeBytes: number
}

const FALLBACK_SESSION_KEY = '__wujie_canvas_default_session__'
const HISTORY_CONTAINER_OVERHEAD_BYTES = 128
const HISTORY_ENTRY_OVERHEAD_BYTES = 32

export const MAX_CACHED_CANVAS_HISTORIES = 20
export const MAX_CANVAS_HISTORY_STEPS = 30
export const MAX_CACHED_CANVAS_HISTORY_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_CACHED_CANVAS_HISTORY_BYTES = 30 * 1024 * 1024
export const CANVAS_HISTORY_LIMIT_CHECK_DELAY_MS = 1000

export const DEFAULT_CANVAS_HISTORY_CACHE_LIMITS: CanvasHistoryCacheLimits = {
  maxSessions: MAX_CACHED_CANVAS_HISTORIES,
  maxHistorySteps: MAX_CANVAS_HISTORY_STEPS,
  maxSessionBytes: MAX_CACHED_CANVAS_HISTORY_BYTES,
  maxTotalBytes: MAX_TOTAL_CACHED_CANVAS_HISTORY_BYTES,
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

function normalizeCanvasHistoryCacheLimits(
  limits: Partial<CanvasHistoryCacheLimits> = {}
): CanvasHistoryCacheLimits {
  return {
    maxSessions: normalizePositiveInteger(
      limits.maxSessions ?? DEFAULT_CANVAS_HISTORY_CACHE_LIMITS.maxSessions,
      DEFAULT_CANVAS_HISTORY_CACHE_LIMITS.maxSessions
    ),
    maxHistorySteps: normalizePositiveInteger(
      limits.maxHistorySteps ??
        DEFAULT_CANVAS_HISTORY_CACHE_LIMITS.maxHistorySteps,
      DEFAULT_CANVAS_HISTORY_CACHE_LIMITS.maxHistorySteps
    ),
    maxSessionBytes: normalizePositiveInteger(
      limits.maxSessionBytes ??
        DEFAULT_CANVAS_HISTORY_CACHE_LIMITS.maxSessionBytes,
      DEFAULT_CANVAS_HISTORY_CACHE_LIMITS.maxSessionBytes
    ),
    maxTotalBytes: normalizePositiveInteger(
      limits.maxTotalBytes ?? DEFAULT_CANVAS_HISTORY_CACHE_LIMITS.maxTotalBytes,
      DEFAULT_CANVAS_HISTORY_CACHE_LIMITS.maxTotalBytes
    ),
  }
}

function estimateSerializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    return new TextEncoder().encode(serialized).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const canvasSnapshotSizeCache = new WeakMap<object, number>()

function estimateHistoryEntryBytes(snapshot: CanvasSnapshot): number {
  const cached = canvasSnapshotSizeCache.get(snapshot)
  if (cached !== undefined) return cached
  const sizeBytes =
    estimateSerializedBytes(snapshot) + HISTORY_ENTRY_OVERHEAD_BYTES
  canvasSnapshotSizeCache.set(snapshot, sizeBytes)
  return sizeBytes
}

export function createCanvasHistoryDraftKey(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `__wujie_canvas_draft__:${suffix}`
}

export function getCanvasHistorySessionKey(
  sessionKey: string | null | undefined,
  fallbackSessionKey = FALLBACK_SESSION_KEY
): string {
  const normalized = sessionKey?.trim()
  return normalized || fallbackSessionKey.trim() || FALLBACK_SESSION_KEY
}

export function cloneCanvasSnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  // @8btc/whiteboard can copy runtime-only Konva attributes such as an image
  // sceneFunc into a node config after transforms/cropping. Canvas snapshots
  // are a JSON data contract, so clone through JSON to strip those functions
  // and keep the cached object consistent with the byte-size calculation.
  return JSON.parse(JSON.stringify(snapshot)) as CanvasSnapshot
}

function cloneCanvasHistory(
  history: CanvasHistorySnapshot
): CanvasHistorySnapshot {
  return {
    past: history.past.map(cloneCanvasSnapshot),
    present: cloneCanvasSnapshot(history.present),
    future: history.future.map(cloneCanvasSnapshot),
  }
}

function selectLimitedCanvasHistory(
  history: CanvasHistorySnapshot,
  rawLimits: Partial<CanvasHistoryCacheLimits> = {}
): LimitedCanvasHistory {
  const limits = normalizeCanvasHistoryCacheLimits(rawLimits)
  const presentBytes = estimateHistoryEntryBytes(history.present)
  if (
    !Number.isFinite(presentBytes) ||
    presentBytes + HISTORY_CONTAINER_OVERHEAD_BYTES > limits.maxSessionBytes
  ) {
    return {
      history: null,
      sizeBytes: presentBytes,
      truncated: true,
      reason: 'present_too_large',
    }
  }

  let sizeBytes = presentBytes + HISTORY_CONTAINER_OVERHEAD_BYTES
  const past: CanvasSnapshot[] = []
  const newestPast = history.past.slice(-limits.maxHistorySteps)
  for (let index = newestPast.length - 1; index >= 0; index -= 1) {
    const snapshot = newestPast[index]
    const snapshotBytes = estimateHistoryEntryBytes(snapshot)
    if (
      !Number.isFinite(snapshotBytes) ||
      sizeBytes + snapshotBytes > limits.maxSessionBytes
    ) {
      break
    }
    past.unshift(snapshot)
    sizeBytes += snapshotBytes
  }

  const future: CanvasSnapshot[] = []
  const nearestFuture = history.future.slice(0, limits.maxHistorySteps)
  for (const snapshot of nearestFuture) {
    const snapshotBytes = estimateHistoryEntryBytes(snapshot)
    if (
      !Number.isFinite(snapshotBytes) ||
      sizeBytes + snapshotBytes > limits.maxSessionBytes
    ) {
      break
    }
    future.push(snapshot)
    sizeBytes += snapshotBytes
  }

  return {
    history: { past, present: history.present, future },
    sizeBytes,
    truncated:
      past.length !== history.past.length ||
      future.length !== history.future.length,
  }
}

export function limitCanvasHistory(
  history: CanvasHistorySnapshot,
  rawLimits: Partial<CanvasHistoryCacheLimits> = {}
): LimitedCanvasHistory {
  const limited = selectLimitedCanvasHistory(history, rawLimits)
  return limited.history
    ? { ...limited, history: cloneCanvasHistory(limited.history) }
    : limited
}

export function createCanvasHistoryCache(
  rawLimits: Partial<CanvasHistoryCacheLimits> = {}
) {
  const limits = normalizeCanvasHistoryCacheLimits(rawLimits)
  const entries = new Map<string, CanvasHistoryCacheEntry>()
  let totalBytes = 0

  function remove(key: string): boolean {
    const entry = entries.get(key)
    if (!entry) return false
    entries.delete(key)
    totalBytes = Math.max(0, totalBytes - entry.sizeBytes)
    return true
  }

  function prune(): void {
    while (
      entries.size > limits.maxSessions ||
      totalBytes > limits.maxTotalBytes
    ) {
      const oldestKey = entries.keys().next().value
      if (!oldestKey) break
      remove(oldestKey)
    }
  }

  return {
    save(
      sessionKey: string | null | undefined,
      history: CanvasHistorySnapshot
    ): CanvasHistoryCacheSaveResult {
      const key = getCanvasHistorySessionKey(sessionKey)
      const limited = limitCanvasHistory(history, limits)
      remove(key)
      if (!limited.history) {
        return {
          cached: false,
          sizeBytes: limited.sizeBytes,
          reason: limited.reason,
        }
      }

      entries.set(key, {
        history: limited.history,
        sizeBytes: limited.sizeBytes,
      })
      totalBytes += limited.sizeBytes
      prune()
      return entries.has(key)
        ? { cached: true, sizeBytes: limited.sizeBytes }
        : {
            cached: false,
            sizeBytes: limited.sizeBytes,
            reason: 'global_limit',
          }
    },

    get(sessionKey: string | null | undefined): CanvasHistorySnapshot | null {
      const key = getCanvasHistorySessionKey(sessionKey)
      const entry = entries.get(key)
      if (!entry) return null

      entries.delete(key)
      entries.set(key, entry)
      return cloneCanvasHistory(entry.history)
    },

    rebind(
      previousSessionKey: string | null | undefined,
      nextSessionKey: string | null | undefined
    ): boolean {
      const previousKey = getCanvasHistorySessionKey(previousSessionKey)
      const nextKey = getCanvasHistorySessionKey(nextSessionKey)
      if (previousKey === nextKey) return entries.has(previousKey)

      const entry = entries.get(previousKey)
      if (!entry) return false
      remove(previousKey)
      remove(nextKey)
      entries.set(nextKey, entry)
      totalBytes += entry.sizeBytes
      prune()
      return entries.has(nextKey)
    },

    clear(sessionKey: string | null | undefined): void {
      remove(getCanvasHistorySessionKey(sessionKey))
    },

    clearAll(): void {
      entries.clear()
      totalBytes = 0
    },

    stats() {
      return {
        sessionCount: entries.size,
        totalBytes,
        sessionKeys: [...entries.keys()],
      }
    },
  }
}

const canvasHistoryCache = createCanvasHistoryCache()

export function getCanvasHistoryInitialState(
  history: CanvasHistorySnapshot | null | undefined
): CanvasSnapshot | undefined {
  if (!history) return undefined
  return cloneCanvasSnapshot(history.past[0] ?? history.present)
}

export function saveCanvasHistoryForSession(
  sessionKey: string | null | undefined,
  api: CanvasApi | null | undefined
): CanvasHistoryCacheSaveResult {
  if (!api) return { cached: false, sizeBytes: 0, reason: 'missing_api' }
  return canvasHistoryCache.save(sessionKey, api.getHistory())
}

export function getCanvasHistoryForSession(
  sessionKey: string | null | undefined
): CanvasHistorySnapshot | null {
  return canvasHistoryCache.get(sessionKey)
}

export function rebindCanvasHistorySession(
  previousSessionKey: string | null | undefined,
  nextSessionKey: string | null | undefined
): boolean {
  return canvasHistoryCache.rebind(previousSessionKey, nextSessionKey)
}

export function clearCanvasHistoryForSession(
  sessionKey: string | null | undefined
): void {
  canvasHistoryCache.clear(sessionKey)
}

export function clearAllCanvasHistories(): void {
  canvasHistoryCache.clearAll()
}

export function enforceActiveCanvasHistoryLimit(
  api: CanvasApi,
  limits: Partial<CanvasHistoryCacheLimits> = {}
): { reset: boolean; reason?: 'history_limit' | 'present_too_large' } {
  const history = api.getHistory()
  if (history.past.length === 0 && history.future.length === 0) {
    return { reset: false }
  }

  const normalizedLimits = normalizeCanvasHistoryCacheLimits(limits)
  if (
    history.past.length > normalizedLimits.maxHistorySteps ||
    history.future.length > normalizedLimits.maxHistorySteps
  ) {
    api.resetHistory()
    return { reset: true, reason: 'history_limit' }
  }

  const limited = selectLimitedCanvasHistory(history, normalizedLimits)
  if (!limited.history || limited.truncated) {
    api.resetHistory()
    return {
      reset: true,
      reason: limited.reason ?? 'history_limit',
    }
  }
  return { reset: false }
}

export function restoreCanvasHistory(
  api: CanvasApi,
  history: CanvasHistorySnapshot | null | undefined
): boolean {
  if (!history) return false

  const updateState = (api as CanvasHistoryMutableApi)._updateState
  if (typeof updateState !== 'function') {
    api.restore(cloneCanvasSnapshot(history.present))
    return false
  }

  const replayStates =
    history.past.length > 0 ? [...history.past.slice(1), history.present] : []
  replayStates.forEach(state => {
    updateState.call(api, cloneCanvasSnapshot(state), true)
  })

  history.future.forEach(state => {
    updateState.call(api, cloneCanvasSnapshot(state), true)
  })

  for (let i = 0; i < history.future.length; i += 1) {
    api.undo()
  }

  if (history.future.length === 0) {
    api.restore(cloneCanvasSnapshot(history.present))
  }

  return true
}
