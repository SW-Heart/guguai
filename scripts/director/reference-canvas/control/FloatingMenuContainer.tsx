import { useAtomValue } from 'jotai'
import type { CanvasApi } from '@8btc/whiteboard'
import { whiteboardApiAtom } from '../atom'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { FloatingMenu } from './FloatingMenu'
import { ImageBrushMenu } from './ImageBrushMenu'
import { ImageCropOverlay } from './ImageCropOverlay'
import { ImageCropPanel, type CropBox } from './ImageCropPanel'
import { useViewerRuntimeDomId } from '@/components/preview/viewer/ViewerRuntimeContext'

type TransformerPosition = {
  x: number
  y: number
  width: number
  height: number
}

type ScreenRect = {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}

/**
 * 记录图片的原始信息。
 * key = 当前图片的 $_imageUrl
 * originalUrl 始终指向最源头的那张图，cropBoxInOriginal 记录本图在原图像素空间中的裁剪区域，
 * 使得多次裁剪时始终基于原图操作。
 */
interface OriginalImageInfo {
  originalUrl: string
  naturalWidth: number
  naturalHeight: number
  /** 本图在 originalUrl 像素空间中的裁剪框（产生本图时的 box） */
  cropBoxInOriginal?: { x: number; y: number; width: number; height: number }
}

function getCropOverlayViewportRect(params: {
  api: CanvasApi
  imageId: string
  container: HTMLElement | null
  originalSize?: { width: number; height: number }
  cropOffset?: { x: number; y: number }
}) {
  const { api, imageId, container, originalSize, cropOffset } = params
  const node = api.getCanvasNodeById(imageId)
  const containerRect = container?.getBoundingClientRect()
  if (!node || !containerRect) return null

  const rect = node.getElement().getClientRect()
  const el = node.getElement() as any
  const currentImage = el?.image?.() as HTMLImageElement | null
  const currentNatW = currentImage?.naturalWidth || 1
  const currentNatH = currentImage?.naturalHeight || 1
  const originalW = originalSize?.width || currentNatW
  const originalH = originalSize?.height || currentNatH
  const screenPerPixelX = rect.width / currentNatW
  const screenPerPixelY = rect.height / currentNatH
  const pixelScale = Math.min(screenPerPixelX, screenPerPixelY)

  const left = containerRect.left + rect.x - (cropOffset?.x ?? 0) * pixelScale
  const top = containerRect.top + rect.y - (cropOffset?.y ?? 0) * pixelScale
  const width = originalW * pixelScale
  const height = originalH * pixelScale

  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  } satisfies ScreenRect
}

export function FloatingMenuContainer({
  children,
}: PropsWithChildren<unknown>) {
  const api = useAtomValue(whiteboardApiAtom)
  const whiteboardContainerId = useViewerRuntimeDomId('whiteboardContainer')
  const [transformerPosition, setTransformerPosition] =
    useState<TransformerPosition | null>(null)
  const [brushImageId, setBrushImageId] = useState<string | null>(null)
  const [cropImageId, setCropImageId] = useState<string | null>(null)
  const [cropBox, setCropBox] = useState<CropBox>({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  })
  // 原图在屏幕上相对于当前节点的像素偏移（再次裁剪时使底图对齐）
  const [cropOffset, setCropOffset] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  })

  // 用原始 $_imageUrl 作为 key 存储原始图片信息
  // 这样即使节点被删除重建，只要 $_imageUrl 不变就能找到原始信息
  const originalInfoMapRef = useRef<Map<string, OriginalImageInfo>>(new Map())
  // 当前裁剪的图片的原始信息（在 handleActiveCrop 时设置）
  const currentCropInfoRef = useRef<OriginalImageInfo | null>(null)
  // 保存进入裁剪模式前的图片状态，用于取消时恢复
  const prevImageStateRef = useRef<{
    image: HTMLImageElement
    width: number
    height: number
    x: number
    y: number
  } | null>(null)

  const handleActiveBrush = (id: string) => {
    setBrushImageId(id)
  }

  const handleExitBrush = () => {
    setBrushImageId(null)
    api?.selectNodes([brushImageId!])
  }

  const handleActiveCrop = useCallback(
    (imageId: string) => {
      if (!api) return
      const node = api.getCanvasNodeById(imageId)
      if (!node) return
      const el = node.getElement() as any
      const image = el.image() as HTMLImageElement | null
      if (!image) return

      const config = api.getNodeConfigById(imageId) as any
      const imageUrl = config?.$_imageUrl || image.src

      const existingInfo = originalInfoMapRef.current.get(imageUrl)

      let info: OriginalImageInfo
      let initialCropBox: CropBox

      if (existingInfo?.cropBoxInOriginal) {
        // 再次裁剪：恢复原图链路，初始 cropBox 为上次裁剪区域，overlay 显示原图
        info = existingInfo
        initialCropBox = existingInfo.cropBoxInOriginal
        setCropOffset({
          x: existingInfo.cropBoxInOriginal.x,
          y: existingInfo.cropBoxInOriginal.y,
        })
      } else {
        // 首次裁剪：当前图片就是原始图片
        const currentNatW =
          image instanceof HTMLImageElement && image.naturalWidth > 0
            ? image.naturalWidth
            : (el?.width?.() ?? 100)
        const currentNatH =
          image instanceof HTMLImageElement && image.naturalHeight > 0
            ? image.naturalHeight
            : (el?.height?.() ?? 100)
        info = {
          originalUrl: imageUrl,
          naturalWidth: currentNatW,
          naturalHeight: currentNatH,
        }
        originalInfoMapRef.current.set(imageUrl, info)
        initialCropBox = {
          x: 0,
          y: 0,
          width: info.naturalWidth,
          height: info.naturalHeight,
        }
        setCropOffset({ x: 0, y: 0 })
      }

      currentCropInfoRef.current = info
      prevImageStateRef.current = null
      setCropBox(initialCropBox)
      setCropImageId(imageId)
      // 隐藏 transformer 选框
      api.selectNodes([])
    },
    [api]
  )

  const handleCropConfirm = useCallback(
    (box: CropBox) => {
      if (!api || !cropImageId) return

      const config = api.getNodeConfigById(cropImageId)
      if (!config || !(config as any).$_imageUrl) {
        setCropImageId(null)
        return
      }

      const node = api.getCanvasNodeById(cropImageId)
      const el = node?.getElement() as any

      // 当前节点在世界坐标中的位置与尺寸
      const origX: number = el?.x?.() ?? (config as any).x ?? 0
      const origY: number = el?.y?.() ?? (config as any).y ?? 0
      const displayW: number = el?.width?.() ?? (config as any).width ?? 1
      const displayH: number = el?.height?.() ?? (config as any).height ?? 1

      // 当前图片的实际像素宽高（= 上次裁剪框的 width/height）
      const currentImage = el?.image?.() as HTMLImageElement | null
      const currentNatW =
        currentImage instanceof HTMLImageElement &&
        currentImage.naturalWidth > 0
          ? currentImage.naturalWidth
          : displayW
      const currentNatH =
        currentImage instanceof HTMLImageElement &&
        currentImage.naturalHeight > 0
          ? currentImage.naturalHeight
          : displayH

      // 每个"原图像素"对应的世界坐标单位
      const scaleX = displayW / currentNatW
      const scaleY = displayH / currentNatH

      // 取原图链路信息（handleActiveCrop 中设置）
      const info = currentCropInfoRef.current
      // 上次裁剪框在原图中的偏移（首次裁剪时为 0）
      const prevCropX = info?.cropBoxInOriginal?.x ?? 0
      const prevCropY = info?.cropBoxInOriginal?.y ?? 0

      // 新节点世界坐标：box 在原图像素空间，需减去上次裁剪偏移后乘以 scale
      const newX = origX + (box.x - prevCropX) * scaleX
      const newY = origY + (box.y - prevCropY) * scaleY
      const newW = Math.max(1, box.width * scaleX)
      const newH = Math.max(1, box.height * scaleY)

      // 加载原图（再次裁剪时为原始图 a；首次裁剪时为当前图）
      const loadUrl =
        info?.originalUrl ?? ((config as any).$_imageUrl as string)

      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(box.width)
        canvas.height = Math.round(box.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          setCropImageId(null)
          return
        }
        ctx.drawImage(
          img,
          box.x,
          box.y,
          box.width,
          box.height,
          0,
          0,
          box.width,
          box.height
        )

        const croppedDataUrl = canvas.toDataURL('image/png')

        // 记录新图的原图链路，供下次再裁剪时使用
        const newInfo: OriginalImageInfo = {
          originalUrl: info?.originalUrl ?? (config as any).$_imageUrl,
          naturalWidth: info?.naturalWidth ?? currentNatW,
          naturalHeight: info?.naturalHeight ?? currentNatH,
          cropBoxInOriginal: box,
        }
        originalInfoMapRef.current.set(croppedDataUrl, newInfo)

        api.deleteNodes([cropImageId])
        api.createNodes(
          [
            {
              id: crypto.randomUUID(),
              $_type: 'image',
              x: newX,
              y: newY,
              width: newW,
              height: newH,
              $_imageUrl: croppedDataUrl,
            } as any,
          ],
          true
        )

        prevImageStateRef.current = null
        setCropImageId(null)
      }
      img.onerror = () => {
        console.error('Failed to load image for crop:', loadUrl)
        setCropImageId(null)
      }
      img.src = loadUrl
    },
    [api, cropImageId]
  )

  const handleCropCancel = useCallback(() => {
    prevImageStateRef.current = null
    setCropImageId(null)
  }, [])

  useEffect(() => {
    if (!api) return
    const handlePositionChange = (position: TransformerPosition | null) => {
      setTransformerPosition(position)
    }
    api.on('transformer:positionChange', handlePositionChange)
    return () => {
      api.off('transformer:positionChange', handlePositionChange)
    }
  }, [api])

  // 裁剪模式 — 面板跟随图片，用 state 追踪位置
  const [cropPanelPos, setCropPanelPos] = useState({
    x: 0,
    y: 0,
    side: 'right' as 'right' | 'left',
  })

  // 定时更新裁剪面板位置（跟随图片移动/缩放）
  useEffect(() => {
    if (!cropImageId || !api) return
    const update = () => {
      const container = document.getElementById(whiteboardContainerId)
      const cRect = container?.getBoundingClientRect()
      const panelW = 240
      const panelGap = 12
      const info = currentCropInfoRef.current
      const viewportRect =
        getCropOverlayViewportRect({
          api,
          imageId: cropImageId,
          container,
          originalSize: info
            ? { width: info.naturalWidth, height: info.naturalHeight }
            : undefined,
          cropOffset,
        }) ?? null
      if (!viewportRect) return

      let x = viewportRect.right + panelGap
      let side: 'right' | 'left' = 'right'

      // 如果右侧放不下，放左侧
      if (cRect && x + panelW > cRect.right - 8) {
        x = viewportRect.left - panelW - panelGap
        side = 'left'
      }
      // 如果左侧也放不下，贴右边界
      if (cRect && x < cRect.left + 8) {
        x = cRect.right - panelW - 8
      }

      let y = viewportRect.top
      // 限制不超出容器底部
      if (cRect) {
        y = Math.max(cRect.top + 8, Math.min(y, cRect.bottom - 400))
      }

      setCropPanelPos({ x, y, side })
    }
    update()
    const interval = setInterval(update, 50)
    return () => clearInterval(interval)
  }, [cropImageId, api, cropOffset, whiteboardContainerId])

  // 裁剪模式
  if (cropImageId && api) {
    const node = api.getCanvasNodeById(cropImageId)
    if (!node) {
      setCropImageId(null)
      return null
    }
    const info = currentCropInfoRef.current

    return (
      <>
        <ImageCropOverlay
          api={api}
          imageId={cropImageId}
          cropBox={cropBox}
          onCropBoxChange={setCropBox}
          originalSize={
            info
              ? { width: info.naturalWidth, height: info.naturalHeight }
              : undefined
          }
          originalUrl={info?.originalUrl}
          cropOffset={cropOffset}
        />
        {/* 裁剪面板 fixed 定位，跟随图片但不被容器裁切 */}
        <div
          style={{
            position: 'fixed',
            left: cropPanelPos.x,
            top: cropPanelPos.y,
            zIndex: 9999,
            maxHeight: 'calc(100vh - 80px)',
            overflowY: 'auto',
          }}
        >
          <ImageCropPanel
            api={api}
            imageId={cropImageId}
            cropBox={cropBox}
            onCropBoxChange={setCropBox}
            onConfirm={handleCropConfirm}
            onCancel={handleCropCancel}
            originalSize={
              info
                ? { width: info.naturalWidth, height: info.naturalHeight }
                : undefined
            }
          />
        </div>
      </>
    )
  }

  // 笔刷模式
  if (brushImageId) {
    return (
      <ImageBrushMenu
        api={api}
        activeImageId={brushImageId}
        onExit={handleExitBrush}
      />
    )
  }

  const displayPosition = transformerPosition
  if (!displayPosition) return null

  const posX = displayPosition.x + displayPosition.width / 2
  const posY = displayPosition.y + displayPosition.height + 10

  return (
    <div
      className="floating-menu-container absolute z-10 -translate-x-1/2"
      style={{ left: posX, top: posY }}
    >
      <FloatingMenu
        onBrushActivate={handleActiveBrush}
        onCropActivate={handleActiveCrop}
      />
      {children}
    </div>
  )
}
