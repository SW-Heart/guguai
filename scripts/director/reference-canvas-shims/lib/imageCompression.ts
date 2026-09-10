export type ImageEncoder = any
export type ImagePreparationResult =
  | { ok: true; file: File }
  | { ok: false; originalFileName: string; reason?: string }

export async function prepareImageFileForMaxBytes(file: File, options: { maxBytes: number; outputMimeType?: string; outputExtension?: string; backgroundColor?: string; createEncoder?: (file: File) => Promise<ImageEncoder> }): Promise<ImagePreparationResult> {
  if (file.size <= options.maxBytes) return { ok: true, file }
  if (typeof createImageBitmap === 'undefined' || !file.type.startsWith('image/')) return { ok: false, originalFileName: file.name, reason: 'too_large' }
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, Math.sqrt(options.maxBytes / file.size) * 1.4)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return { ok: false, originalFileName: file.name, reason: 'canvas' }
    context.fillStyle = options.backgroundColor || '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, options.outputMimeType || file.type, 0.86))
    bitmap.close?.()
    if (!blob || blob.size > options.maxBytes) return { ok: false, originalFileName: file.name, reason: 'too_large' }
    const extension = options.outputExtension || file.name.split('.').pop() || 'bin'
    return { ok: true, file: new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.${extension}`, { type: blob.type }) }
  } catch {
    return { ok: false, originalFileName: file.name, reason: 'decode' }
  }
}
