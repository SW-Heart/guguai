import i18n from '@/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/shad/button'
import { ButtonGroup } from '@/components/ui/shad/button-group'
import { Redo2Icon, Undo2Icon } from 'lucide-react'
import type { CanvasApi } from '@8btc/whiteboard'

interface UndoRedoButtonProps {
  api: CanvasApi
}

export function UndoRedoButton({ api }: UndoRedoButtonProps) {
  const [canUndo, setCanUndo] = useState(api.canUndo())
  const [canRedo, setCanRedo] = useState(api.canRedo())

  useEffect(() => {
    if (!api) {
      return
    }
    // 监听状态变化
    const handleStateChange = () => {
      setCanUndo(api.canUndo())
      setCanRedo(api.canRedo())
    }

    handleStateChange()
    api.on('state:change', handleStateChange)

    return () => {
      api.off('state:change', handleStateChange)
    }
  }, [api])

  return (
    <ButtonGroup className="zoom-panel flex items-center">
      <Button
        size={'icon'}
        variant="outline"
        onClick={() => api.undo()}
        title={i18n.t('legacy:ui_9fcefd8dc81e')}
        disabled={!canUndo}
      >
        <Undo2Icon />
      </Button>

      <Button
        size={'icon'}
        variant="outline"
        onClick={() => api.redo()}
        title={i18n.t('legacy:ui_1238f0d36361')}
        disabled={!canRedo}
      >
        <Redo2Icon />
      </Button>
    </ButtonGroup>
  )
}
