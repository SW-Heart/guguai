type ImageResizeElement = {
  on?: (eventName: string, handler: () => void) => void
  off?: (eventName: string, handler: () => void) => void
  clearCache?: () => void
  cache?: () => void
  image?: () => unknown
  x?: () => number
  y?: () => number
  width?: () => number
  height?: () => number
  scaleX?: () => number
  scaleY?: () => number
  rotation?: () => number
  getLayer?: () => ImageResizeLayer | null | undefined
}

type ImageResizeLayer = {
  find?: (
    predicate: (node: ImageMarkerElement) => boolean
  ) => ImageMarkerElement[]
  batchDraw?: () => void
}

type ImageMarkerElement = {
  id?: () => string
  hasName?: (name: string) => boolean
  setAttrs?: (attrs: Record<string, number>) => void
  findOne?: (selector: string) => ImageMarkerShape | null | undefined
}

type ImageMarkerShape = {
  setAttrs?: (attrs: Record<string, number>) => void
  findOne?: (selector: string) => ImageMarkerShape | null | undefined
}

type ImageResizeNode = {
  getElement?: () => ImageResizeElement | null | undefined
  syncConfigFromElement?: () => void
}

type ImageResizeTransformer = {
  keepRatio: (keepRatio: boolean) => void
}

type NodesSelectedHandler = (selectedNodeIds?: string[]) => void
type VoidHandler = () => void

type RelativeBox = {
  start: { ratioX: number; ratioY: number }
  end: { ratioX: number; ratioY: number }
}

type ImageResizeNodeConfig = {
  id?: string
  $_type?: string
  $_parentId?: string
  $_relativeBox?: RelativeBox
  $_bounds?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type ImageResizeCanvasApi = {
  getTransformer: () => ImageResizeTransformer
  getStageScale?: () => number
  getState: () => {
    selectedNodeIds?: string[]
    nodes?: ImageResizeNodeConfig[]
  }
  getNodeConfigById: (
    nodeId: string
  ) => ImageResizeNodeConfig | null | undefined
  getCanvasNodeById: (nodeId: string) => ImageResizeNode | null | undefined
  on: (eventName: 'nodes:selected', handler: NodesSelectedHandler) => void
  off: (eventName: 'nodes:selected', handler: NodesSelectedHandler) => void
}

const MARKER_FRAME_STROKE_WIDTH = 2
const MARKER_FRAME_CORNER_RADIUS = 6
const MARKER_BADGE_RADIUS = 14
const MARKER_BADGE_STROKE_WIDTH = 3
const MARKER_BADGE_FONT_SIZE = 16
const MIN_MARKER_VISUAL_SCALE = 0.25

export function configureImageResizeBehavior(
  api: ImageResizeCanvasApi
): () => void {
  const transformer = api.getTransformer()
  const detachResizeSyncByNodeId = new Map<string, () => void>()

  const getStageScale = () => api.getStageScale?.() || 1

  const scheduleMarkerVisualSync = () => {
    queueMicrotask(() => syncAllImageMarkerVisuals())
  }

  const refreshImageRenderCache = (
    element: ImageResizeElement,
    recache: boolean
  ) => {
    element.clearCache?.()
    if (recache && element.image?.()) {
      element.cache?.()
    }
    element.getLayer?.()?.batchDraw?.()
  }

  const getImageBounds = (element: ImageResizeElement) => {
    const x = element.x?.() ?? 0
    const y = element.y?.() ?? 0
    const width = Math.max(
      0,
      (element.width?.() ?? 0) * (element.scaleX?.() ?? 1)
    )
    const height = Math.max(
      0,
      (element.height?.() ?? 0) * (element.scaleY?.() ?? 1)
    )
    const rotation = element.rotation?.() ?? 0

    return { x, y, width, height, rotation }
  }

  const rotateImageLocalPoint = (
    imageBounds: ReturnType<typeof getImageBounds>,
    localX: number,
    localY: number
  ) => {
    const angle = (imageBounds.rotation * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    return {
      x: imageBounds.x + localX * cos - localY * sin,
      y: imageBounds.y + localX * sin + localY * cos,
    }
  }

  const getMarkerVisualScale = (
    imageBounds: ReturnType<typeof getImageBounds>,
    markerConfig: ImageResizeNodeConfig
  ) => {
    const markerBaseBounds = markerConfig.$_bounds
    if (!markerBaseBounds?.width || !markerBaseBounds?.height) return 1

    const imageScale = Math.min(
      imageBounds.width / markerBaseBounds.width,
      imageBounds.height / markerBaseBounds.height
    )

    return Math.max(MIN_MARKER_VISUAL_SCALE, imageScale)
  }

  const syncImageMarkerElement = (
    markerElement: ImageMarkerElement,
    markerConfig: ImageResizeNodeConfig,
    imageBounds: ReturnType<typeof getImageBounds>
  ) => {
    const relativeBox = markerConfig.$_relativeBox
    if (!relativeBox) return

    const startX = relativeBox.start.ratioX * imageBounds.width
    const startY = relativeBox.start.ratioY * imageBounds.height
    const endX = relativeBox.end.ratioX * imageBounds.width
    const endY = relativeBox.end.ratioY * imageBounds.height
    const localX = Math.min(startX, endX)
    const localY = Math.min(startY, endY)
    const width = Math.abs(endX - startX)
    const height = Math.abs(endY - startY)
    const { x, y } = rotateImageLocalPoint(imageBounds, localX, localY)
    const visualScale = getMarkerVisualScale(imageBounds, markerConfig)
    const scaled = (value: number) => (value * visualScale) / getStageScale()

    markerElement.setAttrs?.({
      x,
      y,
      width,
      height,
      rotation: imageBounds.rotation,
    })

    markerElement.findOne?.('.rect')?.setAttrs?.({
      width,
      height,
      strokeWidth: scaled(MARKER_FRAME_STROKE_WIDTH),
      cornerRadius: scaled(MARKER_FRAME_CORNER_RADIUS),
    })

    const markerGroup = markerElement.findOne?.('.marker-group')
    markerGroup?.setAttrs?.({ x: width, y: height })

    const badgeRadius = scaled(MARKER_BADGE_RADIUS)
    markerGroup?.findOne?.('Circle')?.setAttrs?.({
      radius: badgeRadius,
      strokeWidth: scaled(MARKER_BADGE_STROKE_WIDTH),
    })
    markerGroup?.findOne?.('Text')?.setAttrs?.({
      x: -badgeRadius,
      y: -badgeRadius,
      width: badgeRadius * 2,
      height: badgeRadius * 2,
      fontSize: scaled(MARKER_BADGE_FONT_SIZE),
    })
  }

  const syncImageMarkersForImage = (
    nodeId: string,
    element: ImageResizeElement
  ) => {
    const layer = element.getLayer?.()
    const imageBounds = getImageBounds(element)
    const markerElements =
      layer?.find?.(node => Boolean(node.hasName?.(nodeId))) ?? []

    markerElements.forEach(markerElement => {
      const markerId = markerElement.id?.()
      if (!markerId) return

      const markerConfig = api.getNodeConfigById(markerId)
      if (markerConfig?.$_type !== 'image-marker') return

      syncImageMarkerElement(markerElement, markerConfig, imageBounds)
      api.getCanvasNodeById(markerId)?.syncConfigFromElement?.()
    })

    if (markerElements.length > 0) {
      layer?.batchDraw?.()
    }
  }

  const syncAllImageMarkerVisuals = () => {
    const imageNodeIds =
      api
        .getState()
        .nodes?.filter(node => node.$_type === 'image')
        .map(node => node.id)
        .filter((nodeId): nodeId is string => Boolean(nodeId)) ?? []

    imageNodeIds.forEach(nodeId => {
      const element = api.getCanvasNodeById(nodeId)?.getElement?.()
      if (element) {
        syncImageMarkersForImage(nodeId, element)
      }
    })
  }

  const attachImageResizeSync = (nodeId: string) => {
    if (detachResizeSyncByNodeId.has(nodeId)) return

    const element = api.getCanvasNodeById(nodeId)?.getElement?.()
    if (!element?.on || !element?.off) return

    const handleTransformStart = () => {
      refreshImageRenderCache(element, false)
      syncImageMarkersForImage(nodeId, element)
    }
    const handleTransform = () => {
      refreshImageRenderCache(element, false)
      syncImageMarkersForImage(nodeId, element)
    }
    const handleTransformEnd = () => {
      refreshImageRenderCache(element, true)
      syncImageMarkersForImage(nodeId, element)
    }
    const handleDragMove = () => {
      syncImageMarkersForImage(nodeId, element)
    }
    const handleDragEnd = () => {
      syncImageMarkersForImage(nodeId, element)
    }

    element.on('transformstart', handleTransformStart)
    element.on('transform', handleTransform)
    element.on('transformend', handleTransformEnd)
    element.on('dragmove', handleDragMove)
    element.on('dragend', handleDragEnd)

    detachResizeSyncByNodeId.set(nodeId, () => {
      element.off?.('transformstart', handleTransformStart)
      element.off?.('transform', handleTransform)
      element.off?.('transformend', handleTransformEnd)
      element.off?.('dragmove', handleDragMove)
      element.off?.('dragend', handleDragEnd)
    })
  }

  const detachStaleImageResizeSync = (selectedNodeIds: string[]) => {
    for (const [nodeId, detach] of detachResizeSyncByNodeId) {
      if (!selectedNodeIds.includes(nodeId)) {
        detach()
        detachResizeSyncByNodeId.delete(nodeId)
      }
    }
  }

  const syncImageResizeBehavior = (
    selectedNodeIds = api.getState().selectedNodeIds ?? []
  ) => {
    detachStaleImageResizeSync(selectedNodeIds)

    let hasSelectedImage = false
    selectedNodeIds.forEach(nodeId => {
      if (api.getNodeConfigById(nodeId)?.$_type === 'image') {
        hasSelectedImage = true
        attachImageResizeSync(nodeId)
      }
    })

    transformer.keepRatio(hasSelectedImage)
    scheduleMarkerVisualSync()
  }

  syncImageResizeBehavior()
  api.on('nodes:selected', syncImageResizeBehavior)

  const apiWithViewportEvents = api as ImageResizeCanvasApi & {
    on?: (eventName: 'viewport:scale:change', handler: VoidHandler) => void
    off?: (eventName: 'viewport:scale:change', handler: VoidHandler) => void
  }
  apiWithViewportEvents.on?.('viewport:scale:change', scheduleMarkerVisualSync)

  return () => {
    api.off('nodes:selected', syncImageResizeBehavior)
    apiWithViewportEvents.off?.(
      'viewport:scale:change',
      scheduleMarkerVisualSync
    )
    for (const detach of detachResizeSyncByNodeId.values()) {
      detach()
    }
    detachResizeSyncByNodeId.clear()
    transformer.keepRatio(false)
  }
}
