import type { ChatMessage } from '@/api/types'

export type CanvasQuickEditResult =
  | { status: 'pending'; imageUrls: [] }
  | { status: 'failed'; imageUrls: [] }
  | { status: 'ready'; imageUrls: string[] }

export function findCanvasQuickEditResult(
  messages: ChatMessage[],
  requestId: string
): CanvasQuickEditResult {
  const requestMessageIndex = messages.findIndex(
    message =>
      message.role === 'user' &&
      message.content.includes(requestId) &&
      (message.content.includes('wj_canvas_quick_edit') ||
        message.content.includes('wj_canvas_quick_result_target'))
  )
  if (requestMessageIndex < 0) {
    return { status: 'pending', imageUrls: [] }
  }

  const imageUrls: string[] = []
  for (
    let index = requestMessageIndex + 1;
    index < messages.length;
    index += 1
  ) {
    const message = messages[index]
    if (message.role === 'user') break
    if (message.isError) return { status: 'failed', imageUrls: [] }

    message.images?.forEach(image => {
      if (image.urls?.length) {
        image.urls.forEach(url => imageUrls.push(url))
      } else if (image.filepath) {
        imageUrls.push(image.filepath)
      }
    })
  }

  const uniqueImageUrls = Array.from(new Set(imageUrls.filter(Boolean)))
  return uniqueImageUrls.length > 0
    ? { status: 'ready', imageUrls: uniqueImageUrls }
    : { status: 'pending', imageUrls: [] }
}
