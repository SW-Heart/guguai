import type { CanvasApi } from '@8btc/whiteboard'

import { exportSelectionWithCurveArrowRendering } from './control/CurveArrowToolLayer'

export interface CanvasSelectionExportOptions {
  pixelRatio?: number
  mimeType?: string
  quality?: number
  padding?: number
  backgroundColor?: string
}

export async function exportCanvasSelectionAsImage(
  api: CanvasApi,
  options: CanvasSelectionExportOptions = {}
): Promise<string | null> {
  const dataUrl = exportSelectionWithCurveArrowRendering(api, options)
  if (!dataUrl) return null

  return addRasterBackground(
    dataUrl,
    options.backgroundColor ?? '#ffffff',
    options.mimeType ?? 'image/png',
    options.quality ?? 1
  )
}

async function addRasterBackground(
  dataUrl: string,
  backgroundColor: string,
  mimeType: string,
  quality: number
): Promise<string> {
  try {
    const image = await loadImage(dataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || image.width
    canvas.height = image.naturalHeight || image.height
    const context = canvas.getContext('2d')
    if (!context || canvas.width === 0 || canvas.height === 0) return dataUrl

    context.fillStyle = backgroundColor
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0)
    return canvas.toDataURL(mimeType, quality)
  } catch (error) {
    console.warn('Failed to add Canvas selection background:', error)
    return dataUrl
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () =>
      reject(new Error('Canvas selection image decode failed'))
    image.src = src
  })
}
