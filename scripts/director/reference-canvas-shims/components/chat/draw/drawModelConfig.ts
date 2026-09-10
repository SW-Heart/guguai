import type { DrawModelId, DrawModelParameterValues, DrawModelPreference } from '@/api/types'

export const DRAW_MODEL_ID = {
  VISION_ARC_V2: 'vision-arc-v2',
  VISION_ARC_PRO: 'vision-arc-pro',
  SEEDREAM_5_LITE: 'seedream-5-lite',
  SEEDREAM_5_PRO: 'seedream-5-pro',
  MIDJOURNEY_V8_1: 'midjourney-v8-1',
} as const

const imageModel = (id: string, displayName: string) => ({
  id,
  displayName,
  mediaKind: 'image' as const,
  editTool: 'image.edit',
  tool: 'image.generate',
  parameterControls: [
    { key: 'aspectRatio', type: 'select', defaultValue: 'auto', options: [{ value: 'auto', label: '自动' }, { value: '1:1', label: '1:1' }, { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }] },
    { key: 'resolution', type: 'select', defaultValue: 'auto', options: [{ value: 'auto', label: '自动' }] },
  ],
})

const models = [imageModel(DRAW_MODEL_ID.VISION_ARC_V2, 'Vision Arc V2'), imageModel(DRAW_MODEL_ID.VISION_ARC_PRO, 'Vision Arc Pro'), imageModel(DRAW_MODEL_ID.SEEDREAM_5_LITE, 'Seedream 5 Lite'), imageModel(DRAW_MODEL_ID.SEEDREAM_5_PRO, 'Seedream 5 Pro'), imageModel(DRAW_MODEL_ID.MIDJOURNEY_V8_1, 'Midjourney V8.1')]

export function getDrawModelOption(id?: DrawModelId) { return models.find(model => model.id === id) }
export function getDefaultDrawModelId(mediaKind: 'image' | 'video' = 'image') { return mediaKind === 'video' ? 'video-default' : DRAW_MODEL_ID.VISION_ARC_V2 }
export function getDefaultDrawModelParameters(id?: DrawModelId): DrawModelParameterValues { return id ? { aspectRatio: 'auto', resolution: 'auto' } : {} }
export function normalizeDrawModelPreference(value: DrawModelPreference): DrawModelPreference {
  const input = value || {}
  return { mode: input.mode === 'manual' ? 'manual' : 'auto', mediaKind: input.mediaKind || 'image', modelId: input.modelId, parameters: input.parameters || {} }
}
export function buildDrawToolArguments(model: any, parameters: DrawModelParameterValues) { return { ...parameters, aspect_ratio: parameters.aspectRatio, image_size: parameters.resolution } }
export type DrawModelOption = ReturnType<typeof imageModel>
export type DrawParameterControl = any
