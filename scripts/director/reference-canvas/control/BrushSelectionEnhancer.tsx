import type { CanvasApi, NodeConfig } from '@8btc/whiteboard'
import { useEffect } from 'react'

type BrushNodeConfig = NodeConfig & {
  $_type: 'brush'
  points?: number[]
  x?: number
  y?: number
  strokeWidth?: number
  visible?: boolean
  $_listening?: boolean
}

type BrushElement = {
  points?: () => number[]
  x?: () => number
  y?: () => number
  strokeWidth?: () => number
  listening?: () => boolean
  setAttr?: (key: string, value: unknown) => void
  getLayer?: () => { batchDraw?: () => void } | null
}

type CanvasShapeTarget = {
  getAttr?: (key: string) => unknown
  getClassName?: () => string
  getParent?: () => CanvasShapeTarget | null
}

const BRUSH_HIT_PADDING_PX = 10

function isBrushNode(node: NodeConfig | null): node is BrushNodeConfig {
  return node?.$_type === 'brush'
}

function getStageScale(api: CanvasApi) {
  return api.getStage().scaleX() || 1
}

function getBrushElement(api: CanvasApi, node: BrushNodeConfig) {
  return api.getCanvasNodeById(node.id)?.getElement() as BrushElement | undefined
}

function getBrushHitStrokeWidth(node: BrushNodeConfig, scale: number) {
  const strokeWidth = Math.max(1, Number(node.strokeWidth) || 3)
  // hitStrokeWidth is measured in canvas coordinates. Keep the extra target
  // around 20 CSS px wide so zooming does not make a thin brush impossible to
  // select, while preserving the visible stroke width.
  return strokeWidth + (BRUSH_HIT_PADDING_PX * 2) / scale
}

function syncBrushHitAreas(api: CanvasApi) {
  const scale = getStageScale(api)
  let changed = false

  for (const rawNode of api.getState().nodes ?? []) {
    if (!isBrushNode(rawNode)) continue

    const element = getBrushElement(api, rawNode)
    if (!element?.setAttr) continue

    const hitStrokeWidth = getBrushHitStrokeWidth(rawNode, scale)
    element.setAttr('hitStrokeWidth', hitStrokeWidth)
    element.getLayer?.()?.batchDraw?.()
    changed = true
  }

  return changed
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number }
) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy)
    )
  )
  const closest = {
    x: start.x + projection * dx,
    y: start.y + projection * dy,
  }
  return Math.hypot(point.x - closest.x, point.y - closest.y)
}

function getWorldPoints(api: CanvasApi, node: BrushNodeConfig) {
  const element = getBrushElement(api, node)
  const points = element?.points?.() ?? node.points ?? []
  const x = element?.x?.() ?? node.x ?? 0
  const y = element?.y?.() ?? node.y ?? 0
  const worldPoints: Array<{ x: number; y: number }> = []

  for (let index = 0; index + 1 < points.length; index += 2) {
    worldPoints.push({ x: x + points[index], y: y + points[index + 1] })
  }

  return worldPoints
}

function isInteractivePointerTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false

  return Boolean(
    target.closest(
      [
        'button',
        'input',
        'textarea',
        'select',
        '[contenteditable="true"]',
        '[role="button"]',
        '[role="menu"]',
        '[role="dialog"]',
      ].join(',')
    )
  )
}

function getWorldPoint(api: CanvasApi, event: PointerEvent) {
  const stage = api.getStage()
  const rect = stage.getContent().getBoundingClientRect()
  const scale = getStageScale(api)

  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    return null
  }

  return {
    x: (event.clientX - rect.left - stage.x()) / scale,
    y: (event.clientY - rect.top - stage.y()) / scale,
  }
}

function hasNativeCanvasTarget(api: CanvasApi, event: PointerEvent) {
  const stage = api.getStage()
  stage.setPointersPositions(event)
  const pointer = stage.getPointerPosition()
  if (!pointer) return false

  let target = stage.getIntersection(pointer) as CanvasShapeTarget | null
  while (target && target !== stage) {
    if (
      target.getAttr?.('$_type') ||
      target.getClassName?.() === 'Transformer'
    ) {
      return true
    }
    target = target.getParent?.() ?? null
  }

  return false
}

function findBrushAtPoint(api: CanvasApi, point: { x: number; y: number }) {
  const scale = getStageScale(api)
  const nodes = api.getState().nodes ?? []

  // Canvas state follows the visual stacking order, so search from the top
  // down when strokes overlap.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const rawNode = nodes[index]
    if (
      !isBrushNode(rawNode) ||
      rawNode.visible === false ||
      rawNode.$_listening === false
    ) {
      continue
    }

    const element = getBrushElement(api, rawNode)
    if (!element || element.listening?.() === false) continue

    const points = getWorldPoints(api, rawNode)
    if (points.length === 0) continue

    const strokeWidth = Math.max(1, Number(rawNode.strokeWidth) || 3)
    const tolerance = strokeWidth / 2 + BRUSH_HIT_PADDING_PX / scale
    if (points.length === 1) {
      if (Math.hypot(point.x - points[0].x, point.y - points[0].y) <= tolerance) {
        return rawNode.id
      }
      continue
    }

    for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
      if (
        distanceToSegment(
          point,
          points[pointIndex - 1],
          points[pointIndex]
        ) <= tolerance
      ) {
        return rawNode.id
      }
    }
  }

  return null
}

export function BrushSelectionEnhancer({ api }: { api: CanvasApi | null }) {
  useEffect(() => {
    if (!api) return

    let syncFrame: number | null = null
    const scheduleHitAreaSync = () => {
      if (syncFrame !== null) return
      syncFrame = window.requestAnimationFrame(() => {
        syncFrame = null
        syncBrushHitAreas(api)
      })
    }

    syncBrushHitAreas(api)
    api.on('nodes:created', scheduleHitAreaSync)
    api.on('state:change', scheduleHitAreaSync)
    api.on('viewport:scale:change', scheduleHitAreaSync)

    const handleNativeSelectionFallback = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        event.defaultPrevented ||
        api.getToolType() !== 'select' ||
        isInteractivePointerTarget(event.target)
      ) {
        return
      }

      const point = getWorldPoint(api, event)
      if (!point) return

      // Let an actual image, shape, or transformer handle keep its normal
      // selection behavior. The fallback is only for a missed brush hit.
      if (hasNativeCanvasTarget(api, event)) return

      const nodeId = findBrushAtPoint(api, point)
      if (!nodeId) return

      const selectedBefore = api.getState().selectedNodeIds ?? []
      window.requestAnimationFrame(() => {
        const selected = api.getState().selectedNodeIds ?? []
        if (selected.length > 0) return

        if (event.shiftKey && selectedBefore.length > 0) {
          api.selectNodes([...selectedBefore, nodeId])
        } else {
          api.selectNodes([nodeId])
        }
      })
    }

    window.addEventListener('pointerdown', handleNativeSelectionFallback, true)
    return () => {
      api.off('nodes:created', scheduleHitAreaSync)
      api.off('state:change', scheduleHitAreaSync)
      api.off('viewport:scale:change', scheduleHitAreaSync)
      window.removeEventListener('pointerdown', handleNativeSelectionFallback, true)
      if (syncFrame !== null) window.cancelAnimationFrame(syncFrame)
    }
  }, [api])

  return null
}
