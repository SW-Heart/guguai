import i18n from '@/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasApi } from '@8btc/whiteboard'
import { Button } from '@/components/ui/shad/button'
import { LinkIcon, UnlinkIcon } from 'lucide-react'

const PRESET_RATIOS = [
  { label: '1:1', w: 1, h: 1 },
  { label: '3:4', w: 3, h: 4 },
  { label: '2:3', w: 2, h: 3 },
  { label: '9:16', w: 9, h: 16 },
  { label: '4:3', w: 4, h: 3 },
  { label: '3:2', w: 3, h: 2 },
  { label: '16:9', w: 16, h: 9 },
]

interface ImageCropPanelProps {
  api: CanvasApi | null
  imageId: string
  onConfirm: (cropBox: CropBox) => void
  onCancel: () => void
  cropBox: CropBox
  onCropBoxChange: (box: CropBox) => void
  originalSize?: { width: number; height: number }
}

export interface CropBox {
  x: number
  y: number
  width: number
  height: number
}

/** 获取图片的原始完整尺寸（naturalWidth/naturalHeight） */
function getImageNaturalSize(api: CanvasApi, imageId: string) {
  const node = api.getCanvasNodeById(imageId)
  if (!node) return { width: 0, height: 0 }
  const el = node.getElement() as any
  const image = el.image() as HTMLImageElement | null
  if (!image) return { width: el.width(), height: el.height() }
  return { width: image.naturalWidth, height: image.naturalHeight }
}

export function ImageCropPanel({
  api,
  imageId,
  onConfirm,
  onCancel,
  cropBox,
  onCropBoxChange,
  originalSize,
}: ImageCropPanelProps) {
  const [locked, setLocked] = useState(false)
  const [activeRatio, setActiveRatio] = useState<string | null>(null)
  const imageSize =
    originalSize ||
    (api ? getImageNaturalSize(api, imageId) : { width: 0, height: 0 })
  const ratioRef = useRef(
    imageSize.width && imageSize.height ? imageSize.width / imageSize.height : 1
  )

  const handleWidthChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const w = Math.max(1, parseInt(e.target.value) || 0)
      const newBox = { ...cropBox, width: w }
      if (locked) {
        newBox.height = Math.round(w / ratioRef.current)
      }
      onCropBoxChange(newBox)
    },
    [cropBox, locked, onCropBoxChange]
  )

  const handleHeightChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const h = Math.max(1, parseInt(e.target.value) || 0)
      const newBox = { ...cropBox, height: h }
      if (locked) {
        newBox.width = Math.round(h * ratioRef.current)
      }
      onCropBoxChange(newBox)
    },
    [cropBox, locked, onCropBoxChange]
  )

  const handleToggleLock = useCallback(() => {
    if (!locked) {
      ratioRef.current = cropBox.width / cropBox.height
    }
    setLocked(!locked)
    setActiveRatio(null)
  }, [locked, cropBox])

  const handlePresetRatio = useCallback(
    (ratio: { label: string; w: number; h: number }) => {
      setActiveRatio(ratio.label)
      setLocked(true)
      ratioRef.current = ratio.w / ratio.h

      // 根据比例计算新的裁剪框，以图片中心为基准
      const imgW = imageSize.width
      const imgH = imageSize.height
      let newW: number, newH: number

      if (ratio.w / ratio.h > imgW / imgH) {
        // 宽度受限
        newW = imgW
        newH = Math.round((imgW * ratio.h) / ratio.w)
      } else {
        // 高度受限
        newH = imgH
        newW = Math.round((imgH * ratio.w) / ratio.h)
      }

      onCropBoxChange({
        x: Math.round((imgW - newW) / 2),
        y: Math.round((imgH - newH) / 2),
        width: newW,
        height: newH,
      })
    },
    [imageSize, onCropBoxChange]
  )

  // 比例图标的宽高比预览
  const RatioIcon = ({ w, h }: { w: number; h: number }) => {
    const maxSize = 16
    const scale = maxSize / Math.max(w, h)
    const rw = Math.round(w * scale)
    const rh = Math.round(h * scale)
    return (
      <span
        className="inline-block border border-gray-400 rounded-[2px]"
        style={{ width: rw, height: rh }}
      />
    )
  }

  return (
    <div className="w-56 px-3 py-3 bg-background shadow-xs border rounded-md text-sm">
      <div className="font-medium mb-3">{i18n.t('legacy:ui_f06f360f9706')}</div>

      {/* W / H 输入 */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center flex-1 bg-muted rounded-md px-2 py-1.5">
          <span className="text-muted-foreground text-xs mr-1.5">W</span>
          <input
            type="number"
            value={Math.round(cropBox.width)}
            onChange={handleWidthChange}
            className="w-full bg-transparent outline-none text-xs font-mono"
            min={1}
          />
        </div>
        <button
          onClick={handleToggleLock}
          className="text-muted-foreground hover:text-foreground p-1"
          title={locked ? '解锁比例' : '锁定比例'}
        >
          {locked ? <LinkIcon size={14} /> : <UnlinkIcon size={14} />}
        </button>
        <div className="flex items-center flex-1 bg-muted rounded-md px-2 py-1.5">
          <span className="text-muted-foreground text-xs mr-1.5">H</span>
          <input
            type="number"
            value={Math.round(cropBox.height)}
            onChange={handleHeightChange}
            className="w-full bg-transparent outline-none text-xs font-mono"
            min={1}
          />
        </div>
      </div>

      {/* 预设比例 */}
      <div className="mb-3">
        <div className="text-xs text-muted-foreground mb-2">
          {i18n.t('legacy:ui_9a0158b486f8')}
        </div>
        <div className="text-xs text-muted-foreground mb-1.5">
          {i18n.t('legacy:ui_f9311938cbdf')}
        </div>
        <div className="flex flex-col gap-0.5 pl-2">
          {PRESET_RATIOS.map(ratio => (
            <button
              key={ratio.label}
              onClick={() => handlePresetRatio(ratio)}
              className={`flex items-center gap-3 px-2 py-1.5 rounded-md text-sm transition-colors ${
                activeRatio === ratio.label
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted'
              }`}
            >
              <RatioIcon w={ratio.w} h={ratio.h} />
              <span>{ratio.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 确认/取消 */}
      <div className="flex gap-2">
        <Button
          className="flex-1"
          variant="outline"
          onClick={onCancel}
          size="sm"
        >
          {i18n.t('legacy:ui_4d0b4688c787')}
        </Button>
        <Button className="flex-1" onClick={() => onConfirm(cropBox)} size="sm">
          {i18n.t('legacy:ui_5ba2e65249b4')}
        </Button>
      </div>
    </div>
  )
}
