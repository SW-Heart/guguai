import {
  type ImageEncoder,
  type ImagePreparationResult,
  prepareImageFileForMaxBytes,
} from '@/lib/imageCompression'
import {
  OPENCLAW_IMAGE_MAX_BYTES,
  OPENCLAW_IMAGE_MAX_SIZE_LABEL,
} from '@/lib/openclawAttachmentLimits'

const CANVAS_OUTPUT_MIME_TYPE = 'image/jpeg'
const CANVAS_OUTPUT_EXTENSION = 'jpg'
const CANVAS_OUTPUT_BACKGROUND = '#ffffff'

export type CanvasImageEncoder = ImageEncoder
export type CanvasImagePreparationResult = ImagePreparationResult

export interface PrepareCanvasImageFileOptions {
  maxBytes?: number
  createEncoder?: (file: File) => Promise<CanvasImageEncoder>
}

export class CanvasImageCompressionLimitError extends Error {
  constructor(public readonly fileName: string) {
    super(getCanvasImageCompressionFailureMessage(fileName))
    this.name = 'CanvasImageCompressionLimitError'
  }
}

export function prepareCanvasImageFile(
  file: File,
  options: PrepareCanvasImageFileOptions = {}
): Promise<CanvasImagePreparationResult> {
  return prepareImageFileForMaxBytes(file, {
    maxBytes: options.maxBytes ?? OPENCLAW_IMAGE_MAX_BYTES,
    outputMimeType: CANVAS_OUTPUT_MIME_TYPE,
    outputExtension: CANVAS_OUTPUT_EXTENSION,
    backgroundColor: CANVAS_OUTPUT_BACKGROUND,
    createEncoder: options.createEncoder,
  })
}

export async function prepareCanvasImageFiles(
  files: File[],
  options: PrepareCanvasImageFileOptions = {}
): Promise<{
  files: File[]
  failures: Extract<CanvasImagePreparationResult, { ok: false }>[]
}> {
  const preparedFiles: File[] = []
  const failures: Extract<CanvasImagePreparationResult, { ok: false }>[] = []

  // Large images can consume significant memory while decoding. Keep Canvas
  // preparation sequential instead of decoding every dropped image at once.
  for (const file of files) {
    const result = await prepareCanvasImageFile(file, options)
    if (result.ok) preparedFiles.push(result.file)
    else failures.push(result)
  }

  return { files: preparedFiles, failures }
}

export function getCanvasImageCompressionFailureMessage(
  fileName: string
): string {
  return `${fileName} 压缩后仍超过图片大小限制（最大 ${OPENCLAW_IMAGE_MAX_SIZE_LABEL}）`
}

export function pickCanvasImageFiles(params: {
  accept: string
  multiple?: boolean
}): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = params.accept
    input.multiple = params.multiple ?? false
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.oncancel = () => resolve([])
    input.click()
  })
}
