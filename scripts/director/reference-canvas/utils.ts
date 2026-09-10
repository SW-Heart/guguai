import { type CanvasApi, type HtmlNodeConfig } from '@8btc/whiteboard'
import {
  calculateBottomLeftOfCanvasContent,
  insertImagesAtPosition,
} from '@8btc/whiteboard/adapter/maze'
import { v4 as uuid } from 'uuid'

const canvasImageSourceUrlMap = new Map<string, string>()

export function getOriginalCanvasImageUrl(url: string): string {
  return canvasImageSourceUrlMap.get(url) ?? url
}

export function clearCanvasImageRenderUrlCache(): void {
  canvasImageSourceUrlMap.clear()
}

function toCanvasRenderableUrl(url: string): string {
  canvasImageSourceUrlMap.set(url, url)
  return url
}

/**
 * 加载图片并获取其宽高
 */
async function loadImageSize(
  url: string
): Promise<{ width: number; height: number }> {
  // 检查是否是 SVG
  const isSvg = url.toLowerCase().endsWith('.svg')

  if (isSvg) {
    try {
      // 获取 SVG 内容
      const response = await fetch(url)
      const svgText = await response.text()

      // 解析 SVG
      const parser = new DOMParser()
      const svgDoc = parser.parseFromString(svgText, 'image/svg+xml')
      const svgElement = svgDoc.querySelector('svg')

      if (svgElement) {
        // 尝试从 viewBox 获取尺寸
        const viewBox = svgElement.getAttribute('viewBox')
        if (viewBox) {
          const [, , width, height] = viewBox.split(/\s+/).map(Number)
          if (width && height) {
            return { width: width / 0.3, height: height / 0.3 }
          }
        }

        // 如果没有 viewBox，尝试从 width 和 height 属性获取
        const widthAttr = svgElement.getAttribute('width')
        const heightAttr = svgElement.getAttribute('height')
        if (widthAttr && heightAttr) {
          return {
            width: parseFloat(widthAttr) / 0.3,
            height: parseFloat(heightAttr) / 0.3,
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse SVG, falling back to Image:', error)
    }
  }

  // 非 SVG 或 SVG 解析失败，使用 Image 加载
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      reject(new Error(`Failed to load image: ${url}`))
    }
    img.src = url
  })
}

export async function insertImageBesideCanvasContent(
  api: CanvasApi | undefined | null,
  imageUrls: string | string[]
): Promise<void> {
  if (!api) return

  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).map(
    toCanvasRenderableUrl
  )
  if (urls.length === 0 || urls.every(url => !url)) return

  const position = calculateBottomLeftOfCanvasContent(api as any)
  await insertImagesAtPosition(
    api as any,
    urls.filter(Boolean),
    {
      x: position.x,
      y: position.y + 20,
    },
    {
      reuseExisting: false,
    }
  )
}

export async function insertImagesAtCanvasPosition(
  api: CanvasApi | undefined | null,
  imageUrls: string | string[],
  position: { x: number; y: number }
): Promise<void> {
  if (!api) return

  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls])
    .filter(Boolean)
    .map(toCanvasRenderableUrl)
  if (urls.length === 0) return

  await insertImagesAtPosition(api as any, urls, position, {
    reuseExisting: false,
    scrollToView: false,
  })
}

export function getCanvasNodesRightInsertPosition(
  api: CanvasApi | undefined | null,
  nodeIds: string[],
  gap = 20
): { x: number; y: number } | null {
  if (!api || nodeIds.length === 0) return null

  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  const selectedIds = new Set(nodeIds)

  api.getMainLayer().children.forEach(node => {
    if (!node.visible() || !selectedIds.has(node.id())) return
    const attrs = node.getAttrs()
    const x = Number(attrs.x) || 0
    const y = Number(attrs.y) || 0
    const width = (Number(attrs.width) || 0) * (Number(attrs.scaleX) || 1)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + width)
  })

  if (!Number.isFinite(minY) || !Number.isFinite(maxX)) return null
  return { x: maxX + gap, y: minY }
}

// svg 可以正常绘制，不需要特殊处理了
async function insertSvgBesideContent(
  api: CanvasApi | null | undefined,
  imageUrl: string | string[]
): Promise<string[] | undefined> {
  if (!api) return
  if (Array.isArray(imageUrl) && imageUrl.length === 0) return
  if (!Array.isArray(imageUrl) && !imageUrl) return

  const position = calculateBottomLeftOfCanvasContent(api as any)
  return insertSvgAtPosition(api, imageUrl, {
    x: position.x,
    y: position.y + 20,
  })
}

async function insertSvgAtPosition(
  api: CanvasApi | null | undefined,
  imageUrls: string | string[],
  position: { x: number; y: number },
  options?: {
    spacing?: number // 图片间距，默认 20px
    scrollToView?: boolean // 是否滚动到视图，默认 true
    direction?: 'horizontal' | 'vertical' // 排列方向，默认 horizontal（横排）
    reuseExisting?: boolean // 是否复用已存在的相同URL图片节点，默认 true
  }
): Promise<string[] | undefined> {
  if (!api) return

  const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
  if (urls.length === 0) return

  const spacing = options?.spacing ?? 20
  const scrollToView = options?.scrollToView ?? true
  const direction = options?.direction ?? 'horizontal'
  const reuseExisting = options?.reuseExisting ?? true

  // 如果启用复用，查找已存在的图片节点
  const existingImageMap = new Map<string, string>()
  if (reuseExisting) {
    const nodes = api.getState().nodes || []
    nodes.forEach(node => {
      if (node.$_type === 'html' && node.$_imageUrl) {
        existingImageMap.set(node.$_imageUrl, node.id)
      }
    })
  }

  const imageSizes = await Promise.all(urls.map(url => loadImageSize(url)))

  // 创建所有图片节点
  const imageNodes: HtmlNodeConfig[] = []
  const imageIds: string[] = []
  let currentX = position.x
  let currentY = position.y

  urls.forEach((imageUrl, index) => {
    // 检查是否复用已存在的节点
    if (reuseExisting && existingImageMap.has(imageUrl)) {
      const existingId = existingImageMap.get(imageUrl)!
      imageIds.push(existingId)
      return
    }

    const { width, height } = imageSizes[index]
    const nodeId = uuid()

    imageNodes.push({
      id: nodeId,
      $_type: 'html',
      x: currentX,
      y: currentY,
      width,
      height,
      $_imageUrl: imageUrl,
      $_actualType: 'image',
      $_htmlContent: `<img src="${imageUrl}" style="width: 100%; height: 100%; object-fit: contain;" />`,
    })

    imageIds.push(nodeId)

    // 根据方向更新位置
    if (direction === 'horizontal') {
      currentX += width + spacing // 横向排列
    } else {
      currentY += height + spacing // 纵向排列
    }
  })

  if (imageNodes.length > 0) {
    api.createNodes(imageNodes, true)
  }

  if (scrollToView) {
    api.scrollToContent({ scale: false, nodeIds: imageIds })
  }

  return imageIds
}
