import { useEffect, useState } from 'react'
import type { CanvasApi, CanvasNode, NodeConfig } from '@8btc/whiteboard'
import './ColorAndStrokeWidthPanel.css'
import { StrokeControls, type RgbaColor } from './StrokeControls'

interface ColorAndStrokeWidthPanelProps {
  api: CanvasApi | null
}

export type StrokeEditableConfig = NodeConfig & {
  strokeWidth?: number
  $_strokeColor?: string
  width?: number
  height?: number
  radiusX?: number
  radiusY?: number
  $_curveArrow?: boolean
  $_curveArrowDisplayStrokeWidth?: number
}

type TransformerPosition = {
  x: number
  y: number
  width: number
  height: number
}

type MutableCanvasApi = CanvasApi & {
  _rebuildStateAfterNodeChange?: (
    nodes: CanvasNode | CanvasNode[],
    addToHistory: boolean
  ) => void
}

function roundStrokeWidth(value: number) {
  return Math.round(value * 10) / 10
}

function getDisplayStrokeWidth(api: CanvasApi, config: StrokeEditableConfig) {
  const storedWidth = config.strokeWidth ?? 4
  if (config.$_type !== 'arrow' || config.$_curveArrow !== true) {
    return roundStrokeWidth(storedWidth)
  }

  const stageScale = api.getStage().scaleX() || 1
  return roundStrokeWidth(storedWidth * stageScale)
}

export function createStableStrokePatch(
  api: CanvasApi,
  current: StrokeEditableConfig,
  patch: Partial<NodeConfig>
): Partial<NodeConfig> {
  const stablePatch: Partial<StrokeEditableConfig> = { ...patch }

  if (
    current.$_type === 'arrow' &&
    current.$_curveArrow === true &&
    typeof stablePatch.strokeWidth === 'number'
  ) {
    const stageScale = api.getStage().scaleX() || 1
    stablePatch.strokeWidth = stablePatch.strokeWidth / stageScale
    stablePatch.$_curveArrowDisplayStrokeWidth = patch.strokeWidth
  }

  if (current.$_type === 'ellipse') {
    const width = current.width ?? current.radiusX
    const height = current.height ?? current.radiusY

    if (typeof width === 'number' && width > 0) {
      stablePatch.width = width
    }
    if (typeof height === 'number' && height > 0) {
      stablePatch.height = height
    }
  }

  return stablePatch as Partial<NodeConfig>
}

export function ColorAndStrokeWidthPanel({
  api,
}: ColorAndStrokeWidthPanelProps) {
  const [transformerPosition, setTransformerPosition] =
    useState<TransformerPosition | null>(null)
  const [selectedBrushIds, setSelectedBrushIds] = useState<string[]>([])
  const [strokeWidth, setStrokeWidth] = useState<number>(4)
  const [strokeColor, setStrokeColor] = useState<string>('#000000')
  const [customColor, setCustomColor] = useState<RgbaColor>({
    r: 59,
    g: 130,
    b: 246,
    a: 1,
  })

  useEffect(() => {
    setTransformerPosition(null)
    setSelectedBrushIds([])
    if (!api) return

    const handlePositionChange = (position: TransformerPosition | null) => {
      setTransformerPosition(position)
    }

    const handleNodesSelected = (ids: string[]) => {
      if (ids.length === 0) {
        setSelectedBrushIds([])
        return
      }
      const brushIds = ids.filter(id => {
        const config = api.getNodeConfigById(id)
        return [
          'brush',
          'rectangle',
          'ellipse',
          'arrow',
          'line',
          'polygon',
          'star',
        ].includes(config?.$_type ?? '')
      })
      if (brushIds.length === ids.length && brushIds.length > 0) {
        setSelectedBrushIds(brushIds)
        const first = api.getNodeConfigById(
          brushIds[0]
        ) as StrokeEditableConfig | null
        if (first) {
          setStrokeWidth(getDisplayStrokeWidth(api, first))
          setStrokeColor(first.$_strokeColor ?? '#000000')
        }
      } else {
        setSelectedBrushIds([])
      }
    }

    api.on('transformer:positionChange', handlePositionChange)
    api.on('nodes:selected', handleNodesSelected)

    return () => {
      api.off('transformer:positionChange', handlePositionChange)
      api.off('nodes:selected', handleNodesSelected)
    }
  }, [api])

  const updateSelectedStrokeNodes = (patch: Partial<NodeConfig>) => {
    if (!api) return

    const updates = selectedBrushIds
      .map(id => {
        const node = api.getCanvasNodeById(id)
        const current = node?.getConfig() as StrokeEditableConfig | undefined
        if (!node || !current) return null

        const stablePatch = createStableStrokePatch(api, current, patch)

        return {
          id,
          node,
          patch: stablePatch,
        }
      })
      .filter(
        (
          update
        ): update is {
          id: string
          node: CanvasNode
          patch: Partial<NodeConfig>
        } => update !== null
      )

    if (updates.length === 0) return

    const mutableApi = api as MutableCanvasApi
    if (typeof mutableApi._rebuildStateAfterNodeChange === 'function') {
      updates.forEach(update => update.node.update(update.patch))
      mutableApi._rebuildStateAfterNodeChange(
        updates.map(update => update.node),
        true
      )
      return
    }

    updates.forEach(update => api.updateNodes([update.id], update.patch))
  }

  const applyStrokeWidth = (w: number) => {
    setStrokeWidth(w)
    updateSelectedStrokeNodes({
      strokeWidth: w,
    })
  }

  const applyStrokeColor = (color: string) => {
    setStrokeColor(color)
    updateSelectedStrokeNodes({
      $_strokeColor: color,
    })
  }

  if (!transformerPosition || selectedBrushIds.length === 0) {
    return null
  }

  const panelX = transformerPosition.x + transformerPosition.width / 2
  const panelY = transformerPosition.y - 10

  return (
    <div
      className="absolute bg-popover rounded-lg shadow-lg px-3 py-2 flex items-center gap-3 -translate-x-1/2 -translate-y-full z-50 pointer-events-auto"
      style={{ left: `${panelX}px`, top: `${panelY}px` }}
    >
      <StrokeControls
        layout="horizontal"
        strokeWidth={strokeWidth}
        strokeColor={strokeColor}
        customColor={customColor}
        onStrokeWidthChange={applyStrokeWidth}
        onStrokeColorChange={applyStrokeColor}
        onCustomColorChange={setCustomColor}
      />
    </div>
  )
}
