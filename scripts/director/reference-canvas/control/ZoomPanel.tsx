import i18n from '@/i18n'
import { Minus, Plus } from 'lucide-react'
import type { CanvasApi } from '@8btc/whiteboard'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/shad/button'
import { ButtonGroup } from '@/components/ui/shad/button-group'

interface ZoomPanelProps {
  api: CanvasApi
}

export function ZoomPanel({ api }: ZoomPanelProps) {
  const [viewport, setViewport] = useState(api.getState().viewport)

  useEffect(() => {
    const handler = (newViewport: any) => {
      setViewport(newViewport)
    }
    api.on('viewport:change', handler)
    return () => {
      api.off('viewport:change', handler)
    }
  }, [api])

  const updateScale = (scale: number) => {
    const halfWidth = api.getStage().width() / 2
    const halfHeight = api.getStage().height() / 2
    const worldCenterX = (halfWidth - viewport.x) / viewport.scale
    const worldCenterY = (halfHeight - viewport.y) / viewport.scale
    const x = halfWidth - worldCenterX * scale
    const y = halfHeight - worldCenterY * scale
    api.updateViewport({ x, y, scale })
  }

  const handleZoomIn = () => {
    const scale = Math.min(viewport.scale * 1.2, 5)
    updateScale(scale)
  }

  const handleZoomOut = () => {
    const scale = Math.max(viewport.scale / 1.2, 0.1)
    updateScale(scale)
  }

  const handleReset = () => {
    updateScale(1)
  }

  const percent = Math.round(viewport.scale * 100)

  return (
    <ButtonGroup className="zoom-panel flex items-center">
      <Button
        size={'icon'}
        variant="outline"
        onClick={handleZoomOut}
        title={i18n.t('legacy:ui_11f8516f82b1')}
      >
        <Minus />
      </Button>
      <Button
        size={'icon'}
        variant="outline"
        onClick={handleReset}
        title={`${percent}%`}
        className="min-w-16 text-sm"
      >
        {percent}%
      </Button>
      <Button
        size={'icon'}
        variant="outline"
        onClick={handleZoomIn}
        title={i18n.t('legacy:ui_d7f48a059cf3')}
      >
        <Plus />
      </Button>
    </ButtonGroup>
  )
}
