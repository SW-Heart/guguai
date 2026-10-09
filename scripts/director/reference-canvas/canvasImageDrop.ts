import type { CanvasApi } from '@8btc/whiteboard'
import { importedImageBounds } from '../../../public/features/agent/image-bounds.js'

// Size the canvas node independently of the source file so large photos keep
// their detail without overwhelming the other canvas content.
export async function insertDroppedImagesAtCanvasPosition(
  api: CanvasApi | undefined | null,
  imageUrls: string[],
  position: { x: number; y: number }
): Promise<void> {
  if (!api) return
  const urls = imageUrls.filter(Boolean)
  if (!urls.length) return

  const sizes = await Promise.all(urls.map(url => new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) {
        reject(new Error('Image has no dimensions'))
        return
      }
      resolve(importedImageBounds({ width: image.naturalWidth, height: image.naturalHeight }))
    }
    image.onerror = () => reject(new Error('Failed to load dropped image'))
    image.src = url
  })))

  let x = position.x
  const nodes = urls.map((url, index) => {
    const size = sizes[index]
    const node = {
      id: crypto.randomUUID(),
      $_type: 'image' as const,
      $_imageUrl: url,
      x,
      y: position.y,
      ...size,
    }
    x += size.width + 20
    return node
  })
  api.createNodes(nodes, true)
}
