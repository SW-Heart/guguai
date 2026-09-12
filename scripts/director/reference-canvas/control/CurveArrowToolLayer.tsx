import type { CanvasApi, CanvasNode, NodeConfig } from '@8btc/whiteboard'
import { curveArrowToolActiveAtom } from '../atom'
import { useAtom } from 'jotai'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { flushSync } from 'react-dom'

type Point = {
  x: number
  y: number
}

type ArrowNodeConfig = NodeConfig & {
  $_type: 'arrow'
  points?: number[]
  x?: number
  y?: number
  stroke?: string
  fill?: string
  fillEnabled?: boolean
  hitStrokeWidth?: number
  strokeWidth?: number
  pointerLength?: number
  pointerWidth?: number
  pointerAtBeginning?: boolean
  pointerAtEnding?: boolean
  tension?: number
  lineCap?: string
  lineJoin?: string
  $_strokeColor?: string
  $_curveArrow?: boolean
  $_curveArrowDisplayStrokeWidth?: number
}

type ArrowElement = {
  points: {
    (): number[]
    (points: number[]): ArrowElement
  }
  x: () => number
  y: () => number
  tension?: () => number
  bezier?: () => boolean
  pointerLength?: () => number
  pointerWidth?: () => number
  pointerAtBeginning?: () => boolean
  pointerAtEnding?: () => boolean
  dashEnabled?: () => boolean
  attrs?: Record<string, unknown>
  getClassName?: () => string
  getLayer?: () => {
    batchDraw?: () => void
  } | null
  listening?: () => boolean
  clone?: (attrs?: Record<string, unknown>) => ArrowElement
  _sceneFunc?: (this: ArrowElement, context: ArrowRenderContext) => void
  [OPEN_ARROW_RENDERING_PATCH]?: boolean
}

type ArrowRenderContext = {
  beginPath: () => void
  moveTo: (x: number, y: number) => void
  lineTo: (x: number, y: number) => void
  bezierCurveTo: (
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number
  ) => void
  strokeShape: (shape: unknown) => void
  setLineDash?: (dash: number[]) => void
}

type MutableCanvasApi = CanvasApi & {
  _setCursor?: (cursor: string) => void
  setDraggable?: (draggable: boolean) => void
  _rebuildStateAfterNodeChange?: (
    nodes: CanvasNode | CanvasNode[],
    addToHistory: boolean
  ) => void
}

type DraftArrow = {
  points: Point[]
  previewPoint: Point | null
}

type ArrowHandle = {
  nodeId: string
  index: number
  screen: Point
  world: Point
  virtual: boolean
  role: 'point' | 'midpoint'
}

type ArrowSelection = {
  nodeId: string
  points: Point[]
  worldPoints: Point[]
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
  handles: ArrowHandle[]
}

type HandleDrag = {
  nodeId: string
  index: number
  points: Point[]
  elementX: number
  elementY: number
}

export const CURVE_ARROW_TOOL_META = {
  strokeWidth: 2.5,
  pointerLength: 22,
  pointerWidth: 18,
  pointerAtEnding: true,
  pointerAtBeginning: false,
  tension: 0.45,
  lineCap: 'round',
  lineJoin: 'round',
  hitStrokeWidth: 14,
} satisfies Partial<ArrowNodeConfig>

const MIN_POINT_DISTANCE = 4
const ARROW_STROKE_COLOR = '#ef4444'
const ARROW_STROKE_SCREEN_WIDTH = 2.5
const ARROW_HIT_STROKE_SCREEN_WIDTH = 14
const OPEN_ARROW_RENDERING_PATCH = Symbol('wj-open-arrow-rendering')
const SELECT_COLOR = '#6965db'
const SELECT_FILL = '#ffffff'
const SELECT_HALO = 'rgba(105, 101, 219, 0.22)'
const PATH_TENSION = 0.86
const POINT_HANDLE_RADIUS = 5.5
const MIDPOINT_HANDLE_RADIUS = 6.5
const MIDPOINT_HALO_RADIUS = 12
const ARROW_HEAD_SCREEN_LENGTH = 20
const ARROW_HEAD_SCREEN_WIDTH = 15

function createNodeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `curve_arrow_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function flattenPoints(points: Point[]) {
  return points.flatMap(point => [point.x, point.y])
}

function inflatePoints(points: number[] | undefined): Point[] {
  if (!points || points.length < 4) return []

  const result: Point[] = []
  for (let i = 0; i + 1 < points.length; i += 2) {
    result.push({ x: points[i], y: points[i + 1] })
  }
  return result
}

function getDistance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function dedupeNearbyPoints(points: Point[]) {
  return points.reduce<Point[]>((result, point) => {
    const last = result[result.length - 1]
    if (!last || getDistance(last, point) >= MIN_POINT_DISTANCE) {
      result.push(point)
    }
    return result
  }, [])
}

function getInterpolatedControlPoints(
  previous: Point,
  current: Point,
  next: Point,
  afterNext: Point
) {
  return {
    cp1: {
      x: current.x + ((next.x - previous.x) * PATH_TENSION) / 6,
      y: current.y + ((next.y - previous.y) * PATH_TENSION) / 6,
    },
    cp2: {
      x: next.x - ((afterNext.x - current.x) * PATH_TENSION) / 6,
      y: next.y - ((afterNext.y - current.y) * PATH_TENSION) / 6,
    },
  }
}

function buildSmoothSvgPath(points: Point[]) {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`
  }

  const [first] = points
  let path = `M ${first.x} ${first.y}`

  for (let i = 0; i < points.length - 1; i += 1) {
    const previous = points[i - 1] ?? points[i]
    const current = points[i]
    const next = points[i + 1]
    const afterNext = points[i + 2] ?? next
    const { cp1, cp2 } = getInterpolatedControlPoints(
      previous,
      current,
      next,
      afterNext
    )

    path += ` C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${next.x} ${next.y}`
  }

  return path
}

function getLastDistinctPoint(points: Point[], fromIndex: number) {
  const anchor = points[fromIndex]
  for (let i = fromIndex - 1; i >= 0; i -= 1) {
    if (getDistance(anchor, points[i]) > 0.01) return points[i]
  }
  return null
}

function getFirstDistinctPoint(points: Point[]) {
  const anchor = points[0]
  for (let i = 1; i < points.length; i += 1) {
    if (getDistance(anchor, points[i]) > 0.01) return points[i]
  }
  return null
}

function getArrowHeadAngle(length: number, width: number) {
  return Math.min(
    Math.PI / 4,
    Math.max(Math.PI / 8, Math.atan2(width / 2, length))
  )
}

function getArrowHeadSegments(
  points: Point[],
  length: number,
  width: number,
  atBeginning = false
) {
  if (points.length < 2) return []

  const tip = atBeginning ? points[0] : points[points.length - 1]
  const guide = atBeginning
    ? getFirstDistinctPoint(points)
    : getLastDistinctPoint(points, points.length - 1)
  if (!guide) return []

  const angle = Math.atan2(tip.y - guide.y, tip.x - guide.x)
  const headAngle = getArrowHeadAngle(length, width)
  const left = {
    x: tip.x - Math.cos(angle - headAngle) * length,
    y: tip.y - Math.sin(angle - headAngle) * length,
  }
  const right = {
    x: tip.x - Math.cos(angle + headAngle) * length,
    y: tip.y - Math.sin(angle + headAngle) * length,
  }

  return [
    [tip, left],
    [tip, right],
  ] as const
}

function getBounds(points: Point[]) {
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

function getMidpoint(a: Point, b: Point) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }
}

function isArrowConfig(node: NodeConfig | null): node is ArrowNodeConfig {
  return node?.$_type === 'arrow'
}

export function isCurveArrowConfig(
  node: NodeConfig | null
): node is ArrowNodeConfig {
  return isArrowConfig(node) && node.$_curveArrow === true
}

function getArrowNode(api: CanvasApi, nodeId: string) {
  const canvasNode = api.getCanvasNodeById(nodeId)
  if (!canvasNode) return null

  const config = canvasNode.getConfig()
  if (!isCurveArrowConfig(config)) return null
  const element = canvasNode.getElement() as unknown as ArrowElement
  ensureOpenArrowRendering(element)

  return {
    canvasNode,
    config,
    element,
  }
}

function isPointInsideRect(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  rect: DOMRect
) {
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  )
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

function shouldCaptureDrawingPointer(
  api: CanvasApi,
  host: SVGSVGElement | null,
  event: PointerEvent
) {
  if (event.button !== 0 || isInteractivePointerTarget(event.target)) {
    return false
  }

  const container = host?.parentElement
  if (
    container &&
    event.target instanceof Node &&
    !container.contains(event.target)
  ) {
    return false
  }

  return isPointInsideRect(
    event,
    api.getStage().getContent().getBoundingClientRect()
  )
}

function getStageMetrics(api: CanvasApi, host: SVGSVGElement | null) {
  const stage = api.getStage()
  const contentRect = stage.getContent().getBoundingClientRect()
  const hostRect = host?.getBoundingClientRect() ?? contentRect
  const scale = stage.scaleX() || 1

  return {
    stage,
    scale,
    offsetX: contentRect.left - hostRect.left,
    offsetY: contentRect.top - hostRect.top,
    contentLeft: contentRect.left,
    contentTop: contentRect.top,
  }
}

function clientToWorld(
  api: CanvasApi,
  host: SVGSVGElement | null,
  event: Pick<PointerEvent | ReactPointerEvent, 'clientX' | 'clientY'>
): Point | null {
  const metrics = getStageMetrics(api, host)
  if (!metrics) return null

  return {
    x:
      (event.clientX - metrics.contentLeft - metrics.stage.x()) / metrics.scale,
    y: (event.clientY - metrics.contentTop - metrics.stage.y()) / metrics.scale,
  }
}

function worldToScreen(
  api: CanvasApi,
  host: SVGSVGElement | null,
  point: Point
): Point | null {
  const metrics = getStageMetrics(api, host)
  if (!metrics) return null

  return {
    x: metrics.offsetX + point.x * metrics.scale + metrics.stage.x(),
    y: metrics.offsetY + point.y * metrics.scale + metrics.stage.y(),
  }
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return getDistance(point, start)

  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy))
  )
  return getDistance(point, {
    x: start.x + projection * dx,
    y: start.y + projection * dy,
  })
}

function findCurveArrowAtPoint(api: CanvasApi, point: Point) {
  const scale = api.getStage().scaleX() || 1
  const tolerance = Math.max(10 / scale, 7)
  const nodes = api.getState().nodes ?? []

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (!isCurveArrowConfig(node) || node.visible === false || node.$_listening === false) {
      continue
    }

    const arrow = getArrowNode(api, node.id)
    if (!arrow || !arrow.element.listening?.()) continue

    const points = getElementWorldPoints(arrow.element)
    for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
      if (distanceToSegment(point, points[pointIndex - 1], points[pointIndex]) <= tolerance) {
        return node.id
      }
    }
  }

  return null
}

function strokeShapeWithoutDash(
  context: ArrowRenderContext,
  shape: ArrowElement
) {
  const dashEnabled = shape.dashEnabled?.() ?? false
  const attrs = shape.attrs
  if (dashEnabled) {
    if (attrs) attrs.dashEnabled = false
    context.setLineDash?.([])
  }

  context.strokeShape(shape)

  if (dashEnabled) {
    if (attrs) attrs.dashEnabled = true
  }
}

function drawInterpolatedContextPath(
  context: ArrowRenderContext,
  points: Point[]
) {
  if (points.length === 0) return

  context.beginPath()
  context.moveTo(points[0].x, points[0].y)

  if (points.length === 1) return
  if (points.length === 2) {
    context.lineTo(points[1].x, points[1].y)
    return
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const previous = points[i - 1] ?? points[i]
    const current = points[i]
    const next = points[i + 1]
    const afterNext = points[i + 2] ?? next
    const { cp1, cp2 } = getInterpolatedControlPoints(
      previous,
      current,
      next,
      afterNext
    )

    context.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, next.x, next.y)
  }
}

function drawOpenArrowHead(
  context: ArrowRenderContext,
  shape: ArrowElement,
  points: Point[],
  atBeginning: boolean
) {
  const length = shape.pointerLength?.() ?? CURVE_ARROW_TOOL_META.pointerLength
  const width = shape.pointerWidth?.() ?? CURVE_ARROW_TOOL_META.pointerWidth
  const segments = getArrowHeadSegments(points, length, width, atBeginning)

  segments.forEach(([tip, wing]) => {
    context.beginPath()
    context.moveTo(tip.x, tip.y)
    context.lineTo(wing.x, wing.y)
    strokeShapeWithoutDash(context, shape)
  })
}

function ensureOpenArrowRendering(element: ArrowElement) {
  if (element[OPEN_ARROW_RENDERING_PATCH]) return false

  element._sceneFunc = function openArrowSceneFunc(
    this: ArrowElement,
    context: ArrowRenderContext
  ) {
    const points = inflatePoints(this.points())
    if (points.length < 2) return

    drawInterpolatedContextPath(context, points)
    strokeShapeWithoutDash(context, this)

    if (this.pointerAtEnding?.() ?? true) {
      drawOpenArrowHead(context, this, points, false)
    }
    if (this.pointerAtBeginning?.() ?? false) {
      drawOpenArrowHead(context, this, points, true)
    }
  }
  element[OPEN_ARROW_RENDERING_PATCH] = true
  return true
}

export function exportSelectionWithCurveArrowRendering(
  api: CanvasApi,
  options?: Parameters<CanvasApi['exportSelectionAsImage']>[0]
): string | null {
  const restoreCloneFunctions: Array<() => void> = []
  const selectedNodeIds = api.getState().selectedNodeIds ?? []

  selectedNodeIds.forEach(nodeId => {
    const config = api.getNodeConfigById(nodeId)
    if (!isCurveArrowConfig(config)) return

    const canvasNode = api.getCanvasNodeById(nodeId)
    const element = canvasNode?.getElement() as ArrowElement | undefined
    const originalClone = element?.clone
    if (!element || typeof originalClone !== 'function') return

    const hadOwnClone = Object.prototype.hasOwnProperty.call(element, 'clone')
    element.clone = function cloneCurveArrow(attrs) {
      const clone = originalClone.call(this, attrs)
      ensureOpenArrowRendering(clone)
      return clone
    }
    restoreCloneFunctions.push(() => {
      if (hadOwnClone) {
        element.clone = originalClone
      } else {
        delete element.clone
      }
    })
  })

  try {
    return api.exportSelectionAsImage(options)
  } finally {
    restoreCloneFunctions.forEach(restore => restore())
  }
}

function patchArrowElementsInCanvas(api: CanvasApi) {
  const nodes = api.getState().nodes ?? []
  let patched = false

  nodes.forEach(node => {
    if (!isCurveArrowConfig(node)) return

    const canvasNode = api.getCanvasNodeById(node.id)
    const element = canvasNode?.getElement() as ArrowElement | undefined
    if (!element) return

    patched = ensureOpenArrowRendering(element) || patched
  })

  if (patched) {
    api.getStage().batchDraw()
  }
}

function detachNativeArrowAnchors(api: CanvasApi) {
  const selectedNodeIds = api.getState().selectedNodeIds ?? []
  const hasSelectedCurveArrow = selectedNodeIds.some(nodeId =>
    isCurveArrowConfig(api.getNodeConfigById(nodeId))
  )
  if (!hasSelectedCurveArrow) return

  const anchors = api.getStage().find('.arrow-anchor')
  if (anchors.length === 0) return

  anchors.forEach(anchor => anchor.remove())
  api.getStage().batchDraw()
}

function setNativeTransformerVisible(api: CanvasApi, visible: boolean) {
  const transformer = api.getTransformer()
  if (transformer.visible() === visible) return

  transformer.visible(visible)
  transformer.getLayer()?.batchDraw()
}

function getElementRelativePoints(element: ArrowElement) {
  return inflatePoints(element.points())
}

function getElementWorldPoints(element: ArrowElement) {
  const elementX = element.x()
  const elementY = element.y()

  return getElementRelativePoints(element).map(point => ({
    x: point.x + elementX,
    y: point.y + elementY,
  }))
}

function setLiveArrowPoints(
  api: CanvasApi,
  nodeId: string,
  relativePoints: Point[],
  addToHistory: boolean
) {
  const arrow = getArrowNode(api, nodeId)
  if (!arrow) return

  const flatPoints = flattenPoints(relativePoints)
  arrow.element.points(flatPoints)
  arrow.element.getLayer?.()?.batchDraw?.()

  if (!addToHistory) {
    return
  }

  arrow.canvasNode.syncConfigFromElement()
  api.getCanvasTransformer().emitPositionChange()
  api.getTransformer().forceUpdate()

  const mutableApi = api as MutableCanvasApi
  if (typeof mutableApi._rebuildStateAfterNodeChange === 'function') {
    mutableApi._rebuildStateAfterNodeChange(arrow.canvasNode, true)
  } else {
    api.updateNodes([nodeId], { points: flatPoints } as Partial<NodeConfig>)
  }
}

function buildArrowSelectionFromWorldPoints(
  api: CanvasApi,
  host: SVGSVGElement | null,
  nodeId: string,
  worldPoints: Point[]
): ArrowSelection | null {
  if (worldPoints.length < 2) return null

  const screenPoints = worldPoints
    .map(point => worldToScreen(api, host, point))
    .filter((point): point is Point => point !== null)
  if (screenPoints.length < 2) return null

  const handles: ArrowHandle[] = worldPoints
    .map((point, index): ArrowHandle | null => {
      const screen = worldToScreen(api, host, point)
      if (!screen) return null
      return {
        nodeId,
        index,
        world: point,
        screen,
        virtual: false,
        role: 'point',
      }
    })
    .filter((handle): handle is ArrowHandle => handle !== null)

  if (worldPoints.length === 2) {
    const midpoint = getMidpoint(worldPoints[0], worldPoints[1])
    const screen = worldToScreen(api, host, midpoint)
    if (screen) {
      handles.splice(1, 0, {
        nodeId,
        index: 1,
        world: midpoint,
        screen,
        virtual: true,
        role: 'midpoint',
      })
    }
  }

  return {
    nodeId,
    points: screenPoints,
    worldPoints,
    bounds: getBounds(screenPoints),
    handles,
  }
}

function buildArrowSelection(
  api: CanvasApi,
  host: SVGSVGElement | null,
  nodeId: string,
  arrow: NonNullable<ReturnType<typeof getArrowNode>>
) {
  return buildArrowSelectionFromWorldPoints(
    api,
    host,
    nodeId,
    getElementWorldPoints(arrow.element)
  )
}

export function CurveArrowToolLayer({ api }: { api: CanvasApi | null }) {
  const [active, setActive] = useAtom(curveArrowToolActiveAtom)
  const [draft, setDraft] = useState<DraftArrow | null>(null)
  const [selection, setSelection] = useState<ArrowSelection | null>(null)
  const overlayRef = useRef<SVGSVGElement | null>(null)
  const activeRef = useRef(active)
  const draftRef = useRef(draft)
  const dragRef = useRef<HandleDrag | null>(null)
  const dragFrameRef = useRef<number | null>(null)
  const pendingDragPointRef = useRef<Point | null>(null)
  const drawingPointerIdRef = useRef<number | null>(null)
  const draftPreviewFrameRef = useRef<number | null>(null)
  const pendingDraftPreviewRef = useRef<Point | null>(null)
  const selectionFrameRef = useRef<number | null>(null)

  activeRef.current = active
  draftRef.current = draft

  useEffect(() => {
    if (!api) return

    patchArrowElementsInCanvas(api)
    detachNativeArrowAnchors(api)

    const handleToolTypeChange = (event: { type: string }) => {
      if (event.type === 'arrow') {
        setActive(true)
        return
      }

      if (event.type !== 'hand') {
        setActive(false)
      }
    }
    const handleNodesCreated = (nodes: NodeConfig[]) => {
      let patched = false
      let hasArrow = false

      nodes.forEach(node => {
        if (!isCurveArrowConfig(node)) return
        hasArrow = true

        const canvasNode = api.getCanvasNodeById(node.id)
        const element = canvasNode?.getElement() as ArrowElement | undefined
        if (element) {
          patched = ensureOpenArrowRendering(element) || patched
        }
      })

      if (hasArrow) detachNativeArrowAnchors(api)
      if (patched) api.getStage().batchDraw()
    }

    api.on('toolType:change', handleToolTypeChange)
    api.on('nodes:created', handleNodesCreated)
    return () => {
      api.off('toolType:change', handleToolTypeChange)
      api.off('nodes:created', handleNodesCreated)
    }
  }, [api, setActive])

  useLayoutEffect(() => {
    if (!api || !active) return

    const mutableApi = api as MutableCanvasApi
    if (api.getToolType() !== 'hand') {
      api.setToolType('hand')
    } else {
      api.selectNodes()
    }
    mutableApi.setDraggable?.(false)
    mutableApi._setCursor?.('crosshair')
  }, [active, api])

  const startDraft = useCallback(
    (point: Point) => {
      const nextDraft: DraftArrow = {
        points: [point],
        previewPoint: point,
      }
      draftRef.current = nextDraft
      setDraft(nextDraft)
    },
    [setDraft]
  )

  const updateDraftPreview = useCallback(
    (point: Point) => {
      const current = draftRef.current
      if (!current) return

      const nextDraft = {
        ...current,
        previewPoint: point,
      }
      draftRef.current = nextDraft
      setDraft(nextDraft)
    },
    [setDraft]
  )

  const clearPendingDraftPreview = useCallback(() => {
    if (draftPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(draftPreviewFrameRef.current)
      draftPreviewFrameRef.current = null
    }
    pendingDraftPreviewRef.current = null
  }, [])

  useEffect(() => {
    if (active || !draftRef.current) return

    draftRef.current = null
    clearPendingDraftPreview()
    setDraft(null)
  }, [active, clearPendingDraftPreview])

  const finishDraft = useCallback((endPoint?: Point) => {
    if (!api) return

    const current = draftRef.current
    const startPoint = current?.points[0]
    const points = startPoint
      ? dedupeNearbyPoints([
          startPoint,
          endPoint ?? current.previewPoint ?? startPoint,
        ])
      : []
    let createdNodeId: string | null = null
    if (points.length >= 2) {
      const stageScale = api.getStage().scaleX() || 1
      const node: ArrowNodeConfig = {
        ...CURVE_ARROW_TOOL_META,
        id: createNodeId(),
        $_type: 'arrow',
        x: 0,
        y: 0,
        visible: true,
        $_strokeColor: ARROW_STROKE_COLOR,
        stroke: ARROW_STROKE_COLOR,
        fill: ARROW_STROKE_COLOR,
        fillEnabled: false,
        $_curveArrow: true,
        $_curveArrowDisplayStrokeWidth: ARROW_STROKE_SCREEN_WIDTH,
        strokeWidth: ARROW_STROKE_SCREEN_WIDTH / stageScale,
        hitStrokeWidth: ARROW_HIT_STROKE_SCREEN_WIDTH / stageScale,
        pointerLength: ARROW_HEAD_SCREEN_LENGTH / stageScale,
        pointerWidth: ARROW_HEAD_SCREEN_WIDTH / stageScale,
        points: flattenPoints(points),
      } as ArrowNodeConfig

      api.createNodes([node], true)
      createdNodeId = node.id
      const arrow = getArrowNode(api, createdNodeId)
      arrow?.element.getLayer?.()?.batchDraw?.()
    }

    draftRef.current = null
    activeRef.current = false
    drawingPointerIdRef.current = null
    clearPendingDraftPreview()
    setDraft(null)
    setActive(false)
    api.setToolType('select')
    if (createdNodeId) {
      api.selectNodes([createdNodeId])
    }
  }, [api, clearPendingDraftPreview, setActive])

  const cancelDraft = useCallback(() => {
    if (!api) return

    draftRef.current = null
    activeRef.current = false
    drawingPointerIdRef.current = null
    clearPendingDraftPreview()
    setDraft(null)
    setActive(false)
    api.setToolType('select')
  }, [api, clearPendingDraftPreview, setActive])

  useEffect(() => {
    if (!api) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current && !draftRef.current) return

      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        finishDraft()
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelDraft()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [api, cancelDraft, finishDraft])

  useEffect(() => {
    if (!api) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!activeRef.current || event.defaultPrevented) return
      if (!shouldCaptureDrawingPointer(api, overlayRef.current, event)) return

      const point = clientToWorld(api, overlayRef.current, event)
      if (!point) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      drawingPointerIdRef.current = event.pointerId
      flushSync(() => startDraft(point))
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (
        drawingPointerIdRef.current !== event.pointerId ||
        !draftRef.current
      ) {
        return
      }

      const point = clientToWorld(api, overlayRef.current, event)
      if (!point) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      pendingDraftPreviewRef.current = point
      if (draftPreviewFrameRef.current !== null) return

      draftPreviewFrameRef.current = window.requestAnimationFrame(() => {
        draftPreviewFrameRef.current = null
        const previewPoint = pendingDraftPreviewRef.current
        pendingDraftPreviewRef.current = null
        if (previewPoint) updateDraftPreview(previewPoint)
      })
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (
        drawingPointerIdRef.current !== event.pointerId ||
        !draftRef.current
      ) {
        return
      }

      const point = clientToWorld(api, overlayRef.current, event)
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      finishDraft(point ?? undefined)
    }

    const handlePointerCancel = (event: PointerEvent) => {
      if (drawingPointerIdRef.current !== event.pointerId) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      cancelDraft()
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerCancel, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerCancel, true)
    }
  }, [api, cancelDraft, finishDraft, startDraft, updateDraftPreview])

  useEffect(() => {
    if (!api) return

    const handleNativeSelectionFallback = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        activeRef.current ||
        api.getToolType() !== 'select' ||
        isInteractivePointerTarget(event.target)
      ) {
        return
      }

      const point = clientToWorld(api, overlayRef.current, event)
      if (!point) return
      const nodeId = findCurveArrowAtPoint(api, point)
      if (!nodeId) return

      window.requestAnimationFrame(() => {
        const selected = api.getState().selectedNodeIds ?? []
        if (selected.length === 0) {
          api.selectNodes([nodeId], event.shiftKey)
        }
      })
    }

    window.addEventListener('pointerdown', handleNativeSelectionFallback, true)
    return () => window.removeEventListener('pointerdown', handleNativeSelectionFallback, true)
  }, [api])

  const refreshSelection = useCallback(() => {
    if (!api || activeRef.current) {
      if (api) setNativeTransformerVisible(api, true)
      setSelection(null)
      return
    }

    const selectedNodeIds = api.getState().selectedNodeIds ?? []
    if (selectedNodeIds.length !== 1) {
      setNativeTransformerVisible(api, true)
      setSelection(null)
      return
    }

    const nodeId = selectedNodeIds[0]
    const arrow = getArrowNode(api, nodeId)
    if (!arrow) {
      setNativeTransformerVisible(api, true)
      setSelection(null)
      return
    }

    detachNativeArrowAnchors(api)
    setNativeTransformerVisible(api, false)
    setSelection(buildArrowSelection(api, overlayRef.current, nodeId, arrow))
  }, [api])

  const scheduleSelectionRefresh = useCallback(() => {
    if (selectionFrameRef.current !== null) return

    selectionFrameRef.current = window.requestAnimationFrame(() => {
      selectionFrameRef.current = null
      refreshSelection()
    })
  }, [refreshSelection])

  useEffect(() => {
    if (!api) return

    refreshSelection()

    api.on('nodes:selected', scheduleSelectionRefresh)
    api.on('state:change', scheduleSelectionRefresh)
    api.on('viewport:change', scheduleSelectionRefresh)
    api.on('transformer:positionChange', scheduleSelectionRefresh)
    window.addEventListener('resize', scheduleSelectionRefresh)

    return () => {
      api.off('nodes:selected', scheduleSelectionRefresh)
      api.off('state:change', scheduleSelectionRefresh)
      api.off('viewport:change', scheduleSelectionRefresh)
      api.off('transformer:positionChange', scheduleSelectionRefresh)
      window.removeEventListener('resize', scheduleSelectionRefresh)
      if (selectionFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionFrameRef.current)
        selectionFrameRef.current = null
      }
      setNativeTransformerVisible(api, true)
    }
  }, [api, refreshSelection, scheduleSelectionRefresh])

  const handleHandlePointerDown = (
    event: ReactPointerEvent<SVGElement>,
    handle: ArrowHandle
  ) => {
    if (!api || event.button !== 0) return

    const arrow = getArrowNode(api, handle.nodeId)
    if (!arrow) return

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.nativeEvent.stopImmediatePropagation()

    let relativePoints = getElementRelativePoints(arrow.element)
    const elementX = arrow.element.x()
    const elementY = arrow.element.y()

    if (
      handle.virtual &&
      handle.role === 'midpoint' &&
      relativePoints.length === 2
    ) {
      relativePoints = [
        relativePoints[0],
        {
          x: handle.world.x - elementX,
          y: handle.world.y - elementY,
        },
        relativePoints[1],
      ]
      setLiveArrowPoints(api, handle.nodeId, relativePoints, false)
      window.requestAnimationFrame(refreshSelection)
    }

    dragRef.current = {
      nodeId: handle.nodeId,
      index: handle.index,
      points: relativePoints,
      elementX,
      elementY,
    }

    setNativeTransformerVisible(api, false)
  }

  useEffect(() => {
    if (!api) return

    const applyDragPoint = (worldPoint: Point) => {
      const drag = dragRef.current
      if (!drag) return

      const nextPoints = drag.points.map((point, index) =>
        index === drag.index
          ? {
              x: worldPoint.x - drag.elementX,
              y: worldPoint.y - drag.elementY,
            }
          : point
      )

      dragRef.current = {
        ...drag,
        points: nextPoints,
      }
      setLiveArrowPoints(api, drag.nodeId, nextPoints, false)
      const worldPoints = nextPoints.map(point => ({
        x: point.x + drag.elementX,
        y: point.y + drag.elementY,
      }))
      const nextSelection = buildArrowSelectionFromWorldPoints(
        api,
        overlayRef.current,
        drag.nodeId,
        worldPoints
      )
      if (nextSelection) setSelection(nextSelection)
    }

    const flushPendingDragPoint = () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current)
        dragFrameRef.current = null
      }

      const point = pendingDragPointRef.current
      pendingDragPointRef.current = null
      if (point) applyDragPoint(point)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragRef.current) return

      const worldPoint = clientToWorld(api, overlayRef.current, event)
      if (!worldPoint) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      pendingDragPointRef.current = worldPoint
      if (dragFrameRef.current !== null) return

      dragFrameRef.current = window.requestAnimationFrame(() => {
        dragFrameRef.current = null
        const point = pendingDragPointRef.current
        pendingDragPointRef.current = null
        if (point) applyDragPoint(point)
      })
    }

    const handlePointerUp = () => {
      if (!dragRef.current) return

      flushPendingDragPoint()
      const latestDrag = dragRef.current
      if (!latestDrag) return

      setLiveArrowPoints(api, latestDrag.nodeId, latestDrag.points, true)
      dragRef.current = null
      refreshSelection()
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current)
        dragFrameRef.current = null
      }
      pendingDragPointRef.current = null
    }
  }, [api, refreshSelection])

  useEffect(() => clearPendingDraftPreview, [clearPendingDraftPreview])

  const draftScreenPoints = useMemo(() => {
    if (!api || !draft) return []

    const points =
      draft.previewPoint && draft.points.length > 0
        ? [...draft.points, draft.previewPoint]
        : draft.points

    return points
      .map(point => worldToScreen(api, overlayRef.current, point))
      .filter((point): point is Point => point !== null)
  }, [api, draft])

  const draftPath = buildSmoothSvgPath(draftScreenPoints)
  const draftStrokeWidth = ARROW_STROKE_SCREEN_WIDTH
  const draftArrowHeadSegments = getArrowHeadSegments(
    draftScreenPoints,
    ARROW_HEAD_SCREEN_LENGTH,
    ARROW_HEAD_SCREEN_WIDTH
  )
  return (
    <svg
      ref={overlayRef}
      className="absolute inset-0 z-10"
      style={{
        overflow: 'visible',
        pointerEvents: 'none',
      }}
      aria-hidden="true"
    >
      {active && (
        <rect
          width="100%"
          height="100%"
          fill="transparent"
          style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
        />
      )}

      {draftPath && (
        <path
          d={draftPath}
          fill="none"
          stroke={ARROW_STROKE_COLOR}
          strokeWidth={draftStrokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.95}
          pointerEvents="none"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {draftArrowHeadSegments.map(([tip, wing], index) => (
        <line
          key={`draft-head-${index}`}
          x1={tip.x}
          y1={tip.y}
          x2={wing.x}
          y2={wing.y}
          stroke={ARROW_STROKE_COLOR}
          strokeWidth={draftStrokeWidth}
          strokeLinecap="round"
          pointerEvents="none"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {draftScreenPoints.map((point, index) => (
        <circle
          key={`${point.x}-${point.y}-${index}`}
          cx={point.x}
          cy={point.y}
          r={POINT_HANDLE_RADIUS}
          fill="#ffffff"
          stroke={SELECT_COLOR}
          strokeWidth={2}
          pointerEvents="none"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {!active && selection && (
        <g pointerEvents="none">
          <rect
            x={selection.bounds.x}
            y={selection.bounds.y}
            width={selection.bounds.width}
            height={selection.bounds.height}
            fill="none"
            stroke={SELECT_COLOR}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}

      {!active &&
        selection?.handles.map(handle => {
          const isEndpoint =
            handle.role === 'point' &&
            (handle.index === 0 || handle.index === selection.points.length - 1)
          const radius = isEndpoint
            ? POINT_HANDLE_RADIUS
            : MIDPOINT_HANDLE_RADIUS

          return (
            <g
              key={`${handle.nodeId}-${handle.index}-${handle.role}-${handle.virtual}`}
              className="cursor-grab active:cursor-grabbing"
              style={{ pointerEvents: 'auto' }}
              onPointerDown={event => handleHandlePointerDown(event, handle)}
            >
              {!isEndpoint && (
                <circle
                  cx={handle.screen.x}
                  cy={handle.screen.y}
                  r={MIDPOINT_HALO_RADIUS}
                  fill={SELECT_HALO}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <circle
                cx={handle.screen.x}
                cy={handle.screen.y}
                r={radius}
                fill={SELECT_FILL}
                stroke={SELECT_COLOR}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )
        })}
    </svg>
  )
}
