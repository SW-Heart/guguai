export enum AttachmentType {
  IMAGES = 'images',
  VIDEOS = 'videos',
  AUDIO = 'audio',
  FILES = 'files',
}

export const ATTACHMENT_TYPE_MAP: Record<string, string[]> = {
  [AttachmentType.IMAGES]: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'],
  [AttachmentType.VIDEOS]: ['mp4', 'webm', 'mov'],
  [AttachmentType.AUDIO]: ['mp3', 'wav', 'm4a'],
  [AttachmentType.FILES]: ['txt', 'pdf'],
}

export enum FileTypeEnum {
  image = 'image',
  video = 'video',
  audio = 'audio',
  file = 'file',
}

export type DrawModelId = string
export type DrawModelParameterValue = string | number | boolean
export type DrawModelParameterValues = Record<string, DrawModelParameterValue>
export type DrawModelPreference = any
export type FileItem = any
export type ChatMessage = any
export const DRAW_MODEL_ID = {
  VISION_ARC_V2: 'vision-arc-v2',
  VISION_ARC_PRO: 'vision-arc-pro',
  SEEDREAM_5_LITE: 'seedream-5-lite',
  SEEDREAM_5_PRO: 'seedream-5-pro',
  MIDJOURNEY_V8_1: 'midjourney-v8-1',
} as const
