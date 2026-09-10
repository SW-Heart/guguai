import type { CanvasApi } from '@8btc/whiteboard'
import { atom } from 'jotai'
import type { DrawModelId, DrawModelPreference } from '@/api/types'
import type {
  CanvasQuickEditMode,
  CanvasQuickModelSource,
  CanvasQuickEditReferenceMode,
} from './canvasQuickEdit'
import type { CanvasQuickEditReference } from './canvasQuickEditAttachment'

export const whiteboardApiAtom = atom<CanvasApi | null>(null)
export const curveArrowToolActiveAtom = atom(false)

export type CanvasInsertRequest = {
  id: string
  imageUrls: string | string[]
  sessionKey?: string | null
}

export function createCanvasInsertRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function enqueueCanvasInsertRequest(
  requests: CanvasInsertRequest[],
  request: CanvasInsertRequest
): CanvasInsertRequest[] {
  return [...requests, request]
}

export function removeCanvasInsertRequest(
  requests: CanvasInsertRequest[],
  requestId: string
): CanvasInsertRequest[] {
  return requests.filter(request => request.id !== requestId)
}

export function isCanvasInsertRequestForSession(
  requestSessionKey: string | null | undefined,
  activeSessionKey: string | null | undefined
): boolean {
  if (!requestSessionKey) {
    return !activeSessionKey
  }

  return requestSessionKey === activeSessionKey
}

export function findCanvasInsertRequestForSession(
  requests: CanvasInsertRequest[],
  activeSessionKey: string | null | undefined
): CanvasInsertRequest | undefined {
  return requests.find(request =>
    isCanvasInsertRequestForSession(request.sessionKey, activeSessionKey)
  )
}

export const canvasInsertRequestsAtom = atom<CanvasInsertRequest[]>([])

export type CanvasQuickEditDraft = {
  requestId: string
  sessionKey?: string | null
  mode: CanvasQuickEditMode
  modelSource: CanvasQuickModelSource
  baselinePreference: DrawModelPreference
  initialTouchedParameterKeys: Partial<Record<DrawModelId, string[]>>
  selectedNodeIds: string[]
  referenceMode: CanvasQuickEditReferenceMode
  references: CanvasQuickEditReference[]
  insertPosition: { x: number; y: number }
}

export const canvasQuickEditDraftAtom = atom<CanvasQuickEditDraft | null>(null)

export const canvasQuickEditPendingAtom = atom<CanvasQuickEditDraft[]>([])

export function rebindCanvasQuickEditPendingSession(
  pending: CanvasQuickEditDraft[],
  previousSessionKey: string | null | undefined,
  nextSessionKey: string | null | undefined
): CanvasQuickEditDraft[] {
  const previous = previousSessionKey?.trim()
  const next = nextSessionKey?.trim()
  if (!previous || !next || previous === next) return pending

  let changed = false
  const rebound = pending.map(item => {
    if (item.sessionKey !== previous) return item
    changed = true
    return { ...item, sessionKey: next }
  })
  return changed ? rebound : pending
}

/**
 * 追踪 image marker 原图 -> 标注图，用于组装 canvasInfo 消息内容
 */
export const imageMarkerTrackerAtom = atom(new Map())
