import { ATTACHMENT_TYPE_MAP, AttachmentType } from '@/api/types'
import type { CanvasApi } from '@8btc/whiteboard'

const CANVAS_IMAGE_EXTENSIONS = new Set(
  ATTACHMENT_TYPE_MAP[AttachmentType.IMAGES].map(extension =>
    extension.toLowerCase()
  )
)

type CanvasDoubleClickEvent = {
  target: CanvasEventTarget
  evt: Event & { button?: number }
}

type CanvasStage = ReturnType<CanvasApi['getStage']>
type CanvasDoubleClickApi = Pick<
  CanvasApi,
  'getContainer' | 'getStage' | 'isEditingText' | 'setToolType'
>

type CanvasEventTarget = {
  getAttr?: (name: string) => unknown
  getClassName?: () => string
  getParent?: () => CanvasEventTarget | null
  nodes?: () => CanvasEventTarget[]
}

function isTextNode(target: CanvasEventTarget): boolean {
  const nodeType = target.getAttr?.('$_type')
  return nodeType === 'rich-text' || nodeType === 'text'
}

function isExistingTextTarget(
  target: CanvasEventTarget,
  stage: CanvasStage
): boolean {
  let current: CanvasEventTarget | null = target

  while (current && current !== stage) {
    if (isTextNode(current)) return true
    if (
      current.getClassName?.() === 'Transformer' &&
      current.nodes?.().some(isTextNode)
    ) {
      return true
    }
    current = current.getParent?.() ?? null
  }

  return false
}

function isRichTextEditorTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('#rich-text-html-element') !== null
  )
}

export function isCanvasImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (file.type.toLowerCase().startsWith('image/')) return true

  const extension = file.name.split('.').pop()?.toLowerCase()
  return Boolean(extension && CANVAS_IMAGE_EXTENSIONS.has(extension))
}

export function getDroppedCanvasImageFiles(
  dataTransfer: Pick<DataTransfer, 'files'>
): {
  imageFiles: File[]
  rejectedFileCount: number
} {
  const files = Array.from(dataTransfer.files)
  const imageFiles = files.filter(isCanvasImageFile)

  return {
    imageFiles,
    rejectedFileCount: files.length - imageFiles.length,
  }
}

export function hasCanvasImageDrag(
  dataTransfer: Pick<DataTransfer, 'items'>
): boolean {
  return Array.from(dataTransfer.items).some(
    item =>
      item.kind === 'file' &&
      (item.type === '' || item.type.toLowerCase().startsWith('image/'))
  )
}

export function getCanvasPointFromClient(
  api: Pick<CanvasApi, 'getContainer' | 'getState'>,
  clientPoint: { x: number; y: number }
): { x: number; y: number } {
  const rect = api.getContainer().getBoundingClientRect()
  const viewport = api.getState().viewport
  const scale = viewport.scale || 1

  return {
    x: (clientPoint.x - rect.left - viewport.x) / scale,
    y: (clientPoint.y - rect.top - viewport.y) / scale,
  }
}

/**
 * Konva 已经记录了双击位置。切到文本工具后重新派发一次按下/抬起，
 * 复用 whiteboard 自己的富文本创建和聚焦流程。
 */
export function startRichTextInputFromCanvasDoubleClick(
  api: Pick<CanvasApi, 'getStage' | 'isEditingText' | 'setToolType'>,
  event: CanvasDoubleClickEvent
): boolean {
  const stage: CanvasStage = api.getStage()
  if (event.evt.button !== undefined && event.evt.button !== 0) return false
  if (api.isEditingText) return false
  if (isExistingTextTarget(event.target, stage)) return false
  if (!stage.getRelativePointerPosition()) return false

  api.setToolType('rich-text')
  stage.fire('pointerdown', { evt: event.evt }, true)
  stage.fire('pointerup', { evt: event.evt }, true)
  return true
}

/**
 * Konva 的 pointerdblclick 在空白 Stage 上稳定触发，但图片或 Transformer
 * 命中时不一定冒泡到 Stage。改由画布 DOM 容器统一接收 dblclick，再反查
 * 当前 Konva 命中节点，确保图片区域与空白区域走同一条富文本创建路径。
 */
export function bindCanvasDoubleClickToRichText(
  api: CanvasDoubleClickApi
): () => void {
  const container = api.getContainer()
  const stage = api.getStage()
  const handleDoubleClick = (event: MouseEvent) => {
    // Konva emits pointerdblclick on the second pointerup, before the browser's
    // native dblclick reaches this fallback. Existing rich text has already
    // attached its HTML editor at that point, so never reinterpret it as blank.
    if (api.isEditingText || isRichTextEditorTarget(event.target)) return
    // Native DOM events do not always update Konva's cached pointer position.
    stage.setPointersPositions(event)
    const pointerPosition = stage.getPointerPosition()
    const target =
      (pointerPosition ? stage.getIntersection(pointerPosition) : null) ?? stage

    startRichTextInputFromCanvasDoubleClick(api, {
      target,
      evt: event,
    })
  }

  container.addEventListener('dblclick', handleDoubleClick)
  return () => container.removeEventListener('dblclick', handleDoubleClick)
}
