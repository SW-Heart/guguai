import type { CanvasApi, CanvasSnapshot } from '@8btc/whiteboard'

import type { FileItem } from '@/api/types'
import { fileClient } from '@/api/fileClient'
import { normalizeClawMediaUrl } from '@/lib/claw'
import { FileTypeEnum } from '@/lib/constants'
import {
  arrayBufferToBase64,
  base64ToFile,
  escapeWindowsPath,
} from '@/lib/file'
import type { CanvasQuickEditReferenceMode } from './canvasQuickEdit'
import { exportCanvasSelectionAsImage } from './canvasSelectionExport'
import {
  CanvasImageCompressionLimitError,
  prepareCanvasImageFile,
} from './canvasImageCompression'

export interface CanvasQuickEditReference {
  file: FileItem
  referImage: string
}

export interface CanvasQuickEditAttachmentBundle {
  referenceMode: CanvasQuickEditReferenceMode
  references: CanvasQuickEditReference[]
}

export function getCanvasQuickEditImageSources(
  snapshot: Pick<CanvasSnapshot, 'nodes' | 'selectedNodeIds'>
): string[] | null {
  const nodesById = new Map((snapshot.nodes ?? []).map(node => [node.id, node]))
  const imageSources = (snapshot.selectedNodeIds ?? []).map(nodeId => {
    const node = nodesById.get(nodeId)
    return node?.$_type === 'image' ? node.$_imageUrl : undefined
  })
  return imageSources.length > 1 && imageSources.every(Boolean)
    ? (imageSources as string[])
    : null
}

export async function createCanvasQuickEditAttachment(params: {
  api: CanvasApi
  requestId: string
}): Promise<CanvasQuickEditReference | null> {
  const selectionFileUrl = await exportCanvasSelectionAsImage(params.api, {
    pixelRatio: 1,
    quality: 0.8,
    padding: 0,
    backgroundColor: '#ffffff',
  })
  if (!selectionFileUrl) return null

  return createCanvasQuickEditReference({
    source: selectionFileUrl,
    fileName: `canvas_selection_${Date.now()}.png`,
    requestId: params.requestId,
  })
}

export async function createCanvasQuickEditAttachments(params: {
  api: CanvasApi
  requestId: string
  snapshot: Pick<CanvasSnapshot, 'nodes' | 'selectedNodeIds'>
  referenceMode: CanvasQuickEditReferenceMode
}): Promise<CanvasQuickEditAttachmentBundle | null> {
  if (params.referenceMode === 'flattened_selection') {
    const reference = await createCanvasQuickEditAttachment(params)
    return reference
      ? { referenceMode: params.referenceMode, references: [reference] }
      : null
  }

  const imageSources = getCanvasQuickEditImageSources(params.snapshot)
  if (!imageSources) return null

  const createdAt = Date.now()
  const references: CanvasQuickEditReference[] = []
  // Large image preparation can decode full-resolution sources. Keep it
  // sequential, matching the Canvas upload path, to avoid memory spikes.
  for (const [index, source] of imageSources.entries()) {
    references.push(
      await createCanvasQuickEditReference({
        source,
        fileName: `canvas_image_${createdAt}_${index + 1}.${getImageExtension(source)}`,
        requestId: params.requestId,
      })
    )
  }

  return {
    referenceMode: params.referenceMode,
    references,
  }
}

async function createCanvasQuickEditReference(params: {
  source: string
  fileName: string
  requestId: string
}): Promise<CanvasQuickEditReference> {
  let attachmentFileName = params.fileName
  let filePath = params.source
  let fileSize: number | undefined

  const sourceFile = await materializeCanvasImageSource(params)
  if (sourceFile) {
    const prepared = await prepareCanvasImageFile(sourceFile)
    if (!prepared.ok) {
      throw new CanvasImageCompressionLimitError(params.fileName)
    }
    const base64 = arrayBufferToBase64(await prepared.file.arrayBuffer())
    filePath = await fileClient.saveTemp({
      base64,
      fileName: prepared.file.name,
    })
    attachmentFileName = prepared.file.name
    fileSize = prepared.file.size
  } else if (
    !params.source.startsWith('clawspace://') &&
    !params.source.startsWith('claw-media://') &&
    !params.source.startsWith('http://') &&
    !params.source.startsWith('https://')
  ) {
    filePath = escapeWindowsPath(params.source)
  }

  const workspaceUri = normalizeClawMediaUrl(filePath)
  return {
    referImage: filePath,
    file: {
      name: attachmentFileName,
      path: filePath,
      workspace_uri: workspaceUri,
      size: fileSize,
      type: FileTypeEnum.image,
      inputSource: 'canvas',
      inputSourceId: params.requestId,
    },
  }
}

/**
 * Canvas previews remain temporary until message dispatch. Persist local
 * references immediately before sending so tools never receive an OS temp path
 * that may disappear while the task is running.
 */
export async function persistCanvasQuickEditAttachment<
  T extends CanvasQuickEditReference,
>(attachment: T): Promise<T> {
  const sourcePath = attachment.file.path || attachment.referImage
  if (!isLocalCanvasAttachmentPath(sourcePath)) return attachment

  const bytes = await fileClient.readBinary(sourcePath)
  const copiedBytes = new Uint8Array(bytes.byteLength)
  copiedBytes.set(bytes)
  const filePath = await fileClient.saveUpload({
    base64: arrayBufferToBase64(copiedBytes.buffer),
    fileName: attachment.file.name,
  })

  return {
    ...attachment,
    referImage: filePath,
    file: {
      ...attachment.file,
      path: filePath,
      workspace_uri: normalizeClawMediaUrl(filePath),
    },
  }
}

export async function persistCanvasQuickEditAttachments<
  T extends CanvasQuickEditReference,
>(attachments: T[]): Promise<T[]> {
  const persisted: T[] = []
  for (const attachment of attachments) {
    persisted.push(await persistCanvasQuickEditAttachment(attachment))
  }
  return persisted
}

function isLocalCanvasAttachmentPath(path: string): boolean {
  const normalized = path.trim()
  if (!normalized) return false
  return !/^(?:https?:|data:|blob:|clawspace:|claw-media:)/i.test(normalized)
}

async function materializeCanvasImageSource(params: {
  source: string
  fileName: string
}): Promise<File | null> {
  if (params.source.startsWith('data:')) {
    return base64ToFile(params.source, params.fileName)
  }
  if (!params.source.startsWith('blob:')) return null

  const response = await fetch(params.source)
  if (!response.ok) {
    throw new Error(`Canvas image blob read failed: ${response.status}`)
  }
  const blob = await response.blob()
  return new File([blob], params.fileName, {
    type: blob.type || getImageMimeType(params.fileName),
  })
}

function getImageExtension(source: string): string {
  const dataMime = source.match(/^data:image\/([a-z0-9.+-]+);/i)?.[1]
  const urlExtension = source.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]
  const extension = (dataMime ?? urlExtension ?? 'png').toLowerCase()
  if (extension === 'jpeg') return 'jpg'
  return ['png', 'jpg', 'webp', 'gif', 'avif'].includes(extension)
    ? extension
    : 'png'
}

function getImageMimeType(fileName: string): string {
  const extension = getImageExtension(fileName)
  if (extension === 'jpg') return 'image/jpeg'
  return `image/${extension}`
}
