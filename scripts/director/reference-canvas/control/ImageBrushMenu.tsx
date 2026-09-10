import i18n from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import type { CanvasApi } from '@8btc/whiteboard'
import { Button } from '@/components/ui/shad/button'
import { Slider } from '@/components/ui/shad/slider'
import { RotateCcwIcon } from 'lucide-react'
import { useUploadFn } from '@/hooks/useUploadFn'
import { base64ToFile } from '@/lib/file'
import { FileTypeEnum } from '@/lib/constants'
import { useAtomValue } from 'jotai'
import { currentClawSessionKeyAtom } from '@/store/atoms'
import { sendClawChatMessage } from '@/hooks/useClawChatController'
import { toast } from 'sonner'
import {
  getCanvasImageCompressionFailureMessage,
  prepareCanvasImageFiles,
} from '../canvasImageCompression'

const BRUSH_MIN = 30
const BRUSH_MAX = 200
const BRUSH_DEFAULT = 100

interface ImageBrushMenuProps {
  api: CanvasApi | null
  activeImageId?: string | null
  onExit: () => void
}

export function ImageBrushMenu({
  api,
  activeImageId,
  onExit,
}: ImageBrushMenuProps) {
  const sessionKey = useAtomValue(currentClawSessionKeyAtom)
  const uploadFn = useUploadFn()
  const [brushSize, setBrushSize] = useState(BRUSH_DEFAULT)
  const getImageNodePosition = (
    nodeId: string | null
  ): { x: number; y: number; width: number; height: number } | null => {
    if (!nodeId) return null
    const canvasNode = api?.getCanvasNodeById(nodeId)
    if (!canvasNode) return null
    const rect = canvasNode.getElement().getClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
  const initialPosition = getImageNodePosition(activeImageId || null)
  const isImageBrushActiveRef = useRef(false)
  const [position, setPosition] = useState<{
    x: number
    y: number
    width: number
    height: number
  } | null>(initialPosition)

  const updatePositionFromNode = () => {
    if (!activeImageId) {
      setPosition(null)
      return
    }
    const pos = getImageNodePosition(activeImageId)
    setPosition(pos)
  }

  const handleToolTypeChange = () => {
    if (!api || !activeImageId) return
    api.clearImageBrushNodes(activeImageId)
    onExit()
  }

  // 响应来自 FloatingMenu 的笔刷激活请求（通过 prop 直接传入，无需 atom）
  useEffect(() => {
    if (!api || !activeImageId) return
    // 先设置 ref/state，防止 setToolType 触发 nodes:selected(空) 时误清除 currentImageId
    isImageBrushActiveRef.current = true
    api.setToolType('image-brush', {
      $_imageId: activeImageId,
      $_strokeColor: 'rgba(33, 150, 243, 0.5)',
      strokeWidth: brushSize,
    })
    // brushSize 仅作初始值，后续由 handleBrushSizeChange 直接更新，无需监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeImageId, api])

  useEffect(() => {
    if (!api) return

    api.on('viewport:change', updatePositionFromNode)
    api.on('toolType:change', handleToolTypeChange)

    return () => {
      api.off('viewport:change', updatePositionFromNode)
      api.off('toolType:change', handleToolTypeChange)
    }
  }, [api])

  const handleBrushSizeChange = (value: number[]) => {
    const size = value[0]
    setBrushSize(size)
    if (!api || !activeImageId) return
    api.setToolType('image-brush', {
      $_imageId: activeImageId,
      $_strokeColor: 'rgba(33, 150, 243, 0.5)',
      strokeWidth: size,
    })
  }

  const handleClear = () => {
    if (!api || !activeImageId) return
    api.clearImageBrushNodes(activeImageId)
  }

  const handleExitImageBrush = () => {
    if (!api || !activeImageId) return
    api.clearImageBrushNodes(activeImageId)
    api.setToolType('select')
    onExit()
  }

  const handleExportAndExit = async () => {
    if (!api || !activeImageId || !sessionKey) return

    let result
    try {
      result = api.exportImageWithBrush(activeImageId)
    } catch (error) {
      console.error('Failed to export image brush result:', error)
    }
    api.clearImageBrushNodes(activeImageId)
    api.setToolType('select')
    onExit()
    if (!result) return
    try {
      const { brushOnly, composite } = result
      const timestamp = Date.now()
      const prepared = await prepareCanvasImageFiles([
        base64ToFile(composite, `image_brush_composite_${timestamp}.png`),
        base64ToFile(brushOnly, `image_brush_only_${timestamp}.png`),
      ])
      prepared.failures.forEach(failure => {
        toast.error(
          getCanvasImageCompressionFailureMessage(failure.originalFileName)
        )
      })
      if (prepared.files.length !== 2) return
      const [compositeFile, brushOnlyFile] = prepared.files

      const [compositeUrl, brushOnlyUrl] = await Promise.all([
        uploadFn({
          task_id: sessionKey,
          fileName: compositeFile.name,
          file: compositeFile,
        }),
        uploadFn({
          task_id: sessionKey,
          fileName: brushOnlyFile.name,
          file: brushOnlyFile,
        }),
      ])
      sendClawChatMessage(sessionKey, 'imageBrush', [
        {
          name: compositeFile.name,
          path: compositeUrl,
          size: compositeFile.size,
          type: FileTypeEnum.image,
          workspace_uri: compositeUrl,
        },
        {
          name: brushOnlyFile.name,
          path: brushOnlyUrl,
          size: brushOnlyFile.size,
          type: FileTypeEnum.image,
          workspace_uri: brushOnlyUrl,
        },
      ])
    } catch (error) {
      console.error('Failed to upload image brush result:', error)
    }
  }

  console.log(position, 'position')

  if (!position) {
    return null
  }

  // 计算浮动菜单位置：选区下方中间
  const posX = position.x + position.width / 2
  const posY = position.y + position.height + 10

  return (
    <div
      className="floating-menu-container absolute z-10 -translate-x-1/2"
      style={{
        left: posX,
        top: posY,
      }}
    >
      <div className="floating-menu w-52 px-3 py-2 bg-background shadow-xs border rounded-md text-sm font-medium">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">
            {i18n.t('legacy:ui_a94d61004d05')}
          </span>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={handleClear}
          >
            <RotateCcwIcon size={14} />
          </button>
        </div>
        <Slider
          min={BRUSH_MIN}
          max={BRUSH_MAX}
          step={1}
          value={[brushSize]}
          onValueChange={handleBrushSizeChange}
          className="mb-3"
        />
        <div className="flex gap-2">
          <Button
            className="flex-1"
            variant="outline"
            onClick={handleExitImageBrush}
            size={'sm'}
          >
            {i18n.t('legacy:ui_4d0b4688c787')}
          </Button>
          <Button
            className="flex-1"
            onClick={handleExportAndExit}
            disabled={!sessionKey}
            size={'sm'}
          >
            {i18n.t('legacy:ui_4c2c4a4a6bbd')}
          </Button>
        </div>
      </div>
    </div>
  )
}
