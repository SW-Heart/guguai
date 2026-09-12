import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasApi } from '@8btc/whiteboard'
import type { CropBox } from './ImageCropPanel'

interface ImageCropOverlayProps {
  api: CanvasApi
  imageId: string
  cropBox: CropBox
  onCropBoxChange: (box: CropBox) => void
  originalSize?: { width: number; height: number }
  originalUrl?: string
  /** 原图在当前节点像素空间中的偏移（再次裁剪时需将底图向左/上偏移） */
  cropOffset?: { x: number; y: number }
}

type DragMode =
  | 'move'
  | 'nw'
  | 'ne'
  | 'sw'
  | 'se'
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | null

/**
 * 裁剪覆盖层：用 HTML <img> 直接显示原始完整图片，
 * 不依赖 Konva 节点的渲染。裁剪框外半透明遮罩，框内完全可见。
 */
export function ImageCropOverlay({
  api,
  imageId,
  cropBox,
  onCropBoxChange,
  originalSize,
  originalUrl,
  cropOffset,
}: ImageCropOverlayProps) {
  const [dragMode, setDragMode] = useState<DragMode>(null)
  const dragStartRef = useRef({ mx: 0, my: 0, box: cropBox })
  const [imgRect, setImgRect] = useState({ x: 0, y: 0, w: 0, h: 0 })

  const imgW = originalSize?.width || 1
  const imgH = originalSize?.height || 1

  // 跟踪图片节点在屏幕上的位置
  useEffect(() => {
    const update = () => {
      const node = api.getCanvasNodeById(imageId)
      if (!node) return
      const rect = node.getElement().getClientRect()
      setImgRect({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
    }
    update()
    api.on('viewport:change', update)
    api.on('transformer:positionChange', update)
    api.on('state:change', update)
    const interval = setInterval(update, 50)
    return () => {
      api.off('viewport:change', update)
      api.off('transformer:positionChange', update)
      api.off('state:change', update)
      clearInterval(interval)
    }
  }, [api, imageId])

  // 原始图片像素 → 屏幕像素的比例
  // 用统一比例，避免图片被拉伸压缩
  // 基于当前节点的宽度来计算（因为节点可能是裁剪后的，宽高比和原图不同）
  const node = api.getCanvasNodeById(imageId)
  const el = node?.getElement() as any
  const currentImage = el?.image() as HTMLImageElement | null
  const currentNatW = currentImage?.naturalWidth || 1
  const currentNatH = currentImage?.naturalHeight || 1

  // 当前节点每个像素对应的屏幕像素
  const screenPerPixelX = imgRect.w / currentNatW
  const screenPerPixelY = imgRect.h / currentNatH
  // 用统一比例（取较小值保持比例一致）
  const pxPerScreen = Math.min(screenPerPixelX, screenPerPixelY)
  const pxPerScreenX = pxPerScreen
  const pxPerScreenY = pxPerScreen

  // 原始图片在屏幕上的完整区域
  // 再次裁剪时，原图的 (0,0) 比当前节点左上角偏左/上 cropOffset 个原图像素
  const fullImgScreenW = imgW * pxPerScreenX
  const fullImgScreenH = imgH * pxPerScreenY
  const fullImgScreenX = imgRect.x - (cropOffset?.x ?? 0) * pxPerScreenX
  const fullImgScreenY = imgRect.y - (cropOffset?.y ?? 0) * pxPerScreenY

  // 裁剪框在屏幕上的位置
  const cropScreenX = fullImgScreenX + cropBox.x * pxPerScreenX
  const cropScreenY = fullImgScreenY + cropBox.y * pxPerScreenY
  const cropScreenW = cropBox.width * pxPerScreenX
  const cropScreenH = cropBox.height * pxPerScreenY

  // 拖拽
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, mode: DragMode) => {
      e.preventDefault()
      e.stopPropagation()
      setDragMode(mode)
      dragStartRef.current = {
        mx: e.clientX,
        my: e.clientY,
        box: { ...cropBox },
      }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [cropBox]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragMode) return
      e.preventDefault()
      e.stopPropagation()
      const dx = (e.clientX - dragStartRef.current.mx) / pxPerScreenX
      const dy = (e.clientY - dragStartRef.current.my) / pxPerScreenY
      const orig = dragStartRef.current.box
      let { x, y, width, height } = orig

      if (dragMode === 'move') {
        x = Math.max(0, Math.min(imgW - width, orig.x + dx))
        y = Math.max(0, Math.min(imgH - height, orig.y + dy))
      } else {
        if (dragMode.includes('w')) {
          const nx = Math.max(
            0,
            Math.min(orig.x + orig.width - 10, orig.x + dx)
          )
          width = orig.width - (nx - orig.x)
          x = nx
        }
        if (dragMode.includes('e')) {
          width = Math.max(10, Math.min(imgW - orig.x, orig.width + dx))
        }
        if (dragMode.includes('n')) {
          const ny = Math.max(
            0,
            Math.min(orig.y + orig.height - 10, orig.y + dy)
          )
          height = orig.height - (ny - orig.y)
          y = ny
        }
        if (dragMode.includes('s')) {
          height = Math.max(10, Math.min(imgH - orig.y, orig.height + dy))
        }
      }
      onCropBoxChange({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      })
    },
    [dragMode, pxPerScreenX, pxPerScreenY, imgW, imgH, onCropBoxChange]
  )

  const handlePointerUp = useCallback(() => {
    setDragMode(null)
  }, [])

  const hs = 8
  const handles: Array<{
    mode: DragMode
    style: React.CSSProperties
    cursor: string
  }> = [
    {
      mode: 'nw',
      style: { top: -hs / 2, left: -hs / 2 },
      cursor: 'nwse-resize',
    },
    {
      mode: 'ne',
      style: { top: -hs / 2, right: -hs / 2 },
      cursor: 'nesw-resize',
    },
    {
      mode: 'sw',
      style: { bottom: -hs / 2, left: -hs / 2 },
      cursor: 'nesw-resize',
    },
    {
      mode: 'se',
      style: { bottom: -hs / 2, right: -hs / 2 },
      cursor: 'nwse-resize',
    },
    {
      mode: 'n',
      style: { top: -hs / 2, left: '50%', marginLeft: -hs / 2 },
      cursor: 'ns-resize',
    },
    {
      mode: 's',
      style: { bottom: -hs / 2, left: '50%', marginLeft: -hs / 2 },
      cursor: 'ns-resize',
    },
    {
      mode: 'w',
      style: { top: '50%', left: -hs / 2, marginTop: -hs / 2 },
      cursor: 'ew-resize',
    },
    {
      mode: 'e',
      style: { top: '50%', right: -hs / 2, marginTop: -hs / 2 },
      cursor: 'ew-resize',
    },
  ]

  return (
    <div
      className="absolute inset-0 z-20 pointer-events-none"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ pointerEvents: dragMode ? 'auto' : 'none' }}
    >
      {/* 原始完整图片作为背景（HTML img，不依赖 Konva） */}
      {originalUrl && (
        <img
          src={originalUrl}
          alt=""
          style={{
            position: 'absolute',
            left: fullImgScreenX,
            top: fullImgScreenY,
            width: fullImgScreenW,
            height: fullImgScreenH,
            maxWidth: 'none',
            maxHeight: 'none',
            pointerEvents: 'none',
            opacity: 0.4,
            objectFit: 'fill',
          }}
        />
      )}

      {/* 暗色遮罩 — 裁剪框外 */}
      <svg
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: 'none' }}
      >
        <defs>
          <mask id="crop-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={cropScreenX}
              y={cropScreenY}
              width={cropScreenW}
              height={cropScreenH}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.4)"
          mask="url(#crop-mask)"
        />
      </svg>

      {/* 裁剪框内：用 clip 显示原图的对应区域（完全不透明） */}
      {originalUrl && (
        <div
          style={{
            position: 'absolute',
            left: cropScreenX,
            top: cropScreenY,
            width: cropScreenW,
            height: cropScreenH,
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          <img
            src={originalUrl}
            alt=""
            style={{
              position: 'absolute',
              left: -(cropBox.x * pxPerScreenX),
              top: -(cropBox.y * pxPerScreenY),
              width: fullImgScreenW,
              height: fullImgScreenH,
              maxWidth: 'none',
              maxHeight: 'none',
              pointerEvents: 'none',
              objectFit: 'fill',
            }}
          />
        </div>
      )}

      {/* 裁剪框边框 + 手柄 */}
      <div
        className="absolute border-2 border-white"
        style={{
          left: cropScreenX,
          top: cropScreenY,
          width: cropScreenW,
          height: cropScreenH,
          pointerEvents: 'auto',
          cursor: dragMode === 'move' ? 'grabbing' : 'move',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.3)',
        }}
        onPointerDown={e => handlePointerDown(e, 'move')}
      >
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/40" />
          <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/40" />
          <div className="absolute top-1/3 left-0 right-0 h-px bg-white/40" />
          <div className="absolute top-2/3 left-0 right-0 h-px bg-white/40" />
        </div>
        {handles.map(({ mode, style, cursor }) => (
          <div
            key={mode}
            className="absolute bg-white border border-gray-400 rounded-sm"
            style={{
              width: hs,
              height: hs,
              cursor,
              pointerEvents: 'auto',
              ...style,
            }}
            onPointerDown={e => handlePointerDown(e, mode)}
          />
        ))}
      </div>
    </div>
  )
}
