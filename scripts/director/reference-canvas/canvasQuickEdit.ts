import i18n from '@/i18n'
import type { CanvasSnapshot, NodeConfig } from '@8btc/whiteboard'

import {
  DRAW_MODEL_ID,
  type DrawModelId,
  type DrawModelParameterValue,
  type DrawModelParameterValues,
  type DrawModelPreference,
} from '@/api/types'
import {
  buildDrawToolArguments,
  getDefaultDrawModelId,
  getDefaultDrawModelParameters,
  getDrawModelOption,
  normalizeDrawModelPreference,
  type DrawModelOption,
  type DrawParameterControl,
} from '@/components/chat/draw/drawModelConfig'

export const CANVAS_ANNOTATION_EDIT_PROMPT_SUFFIX =
  '根据图中批注来进行精准编辑，只改变被批注部分，其他保持不变，最后输出结果去掉所有批注痕迹。'

export const CANVAS_ANNOTATION_EDIT_VISIBLE_PROMPT = '按图中标注改图'

const STRONG_ANNOTATION_NODE_TYPES = new Set<NodeConfig['$_type']>([
  'image-marker',
  'image-brush',
  'brush',
  'arrow',
])

const ASPECT_RATIO_PARAMETER_KEY = 'aspectRatio'

export type CanvasQuickEditMode =
  | 'reference_edit'
  | 'annotation_edit'
  | 'composition'

export type CanvasQuickEditReferenceMode =
  | 'flattened_selection'
  | 'separate_images'

export function isCanvasQuickEditMediaKindLocked(
  mode: CanvasQuickEditMode
): boolean {
  return mode === 'annotation_edit'
}

export function shouldAwaitCanvasQuickEditImageResult(
  preference: DrawModelPreference
): boolean {
  return normalizeDrawModelPreference(preference).mediaKind === 'image'
}

export function getCanvasQuickEditVisiblePromptPrefill(
  mode: CanvasQuickEditMode,
  currentInput: string
): string | undefined {
  if (mode !== 'annotation_edit' || currentInput.trim()) return undefined
  return CANVAS_ANNOTATION_EDIT_VISIBLE_PROMPT
}

export type CanvasQuickModelSource =
  | 'annotation_default'
  | 'canvas_manual'
  | 'main_inherited'
  | 'system_auto'

export interface CanvasQuickModelState {
  preference: DrawModelPreference
  source: CanvasQuickModelSource
  touchedParameterKeys: Partial<Record<DrawModelId, string[]>>
}

export interface CanvasQuickEditHiddenContext {
  type: 'wj_canvas_quick_edit'
  version: 2
  request_id: string
  edit_mode: CanvasQuickEditMode
  reference_mode: CanvasQuickEditReferenceMode
  model_source: CanvasQuickModelSource
  model_policy: 'auto' | 'manual'
  selected_model?: {
    id: DrawModelId
    display_name: string
    media_kind: 'image' | 'video'
    edit_tool?: string
    tool?: string
  }
  required_tool?: string
  required_prompt_suffix?: string
  required_tool_prompt: string
  refer_images: string[]
  model_parameters: DrawModelParameterValues
  tool_arguments: Record<string, string | number | boolean>
  rules: string[]
}

export function isCanvasQuickEditSelectionCandidate(
  snapshot: Pick<CanvasSnapshot, 'nodes' | 'selectedNodeIds'>
): boolean {
  const selectedIds = new Set(snapshot.selectedNodeIds ?? [])
  if (selectedIds.size === 0) return false

  return (snapshot.nodes ?? []).some(node => {
    if (!selectedIds.has(node.id) || node.visible === false) return false
    if (node.$_type === 'image') return true
    if (node.$_type === 'image-marker') {
      return (snapshot.nodes ?? []).some(
        candidate =>
          candidate.id === node.$_parentId && candidate.$_type === 'image'
      )
    }
    if (node.$_type === 'image-brush') {
      return (snapshot.nodes ?? []).some(
        candidate =>
          candidate.id === node.$_imageId && candidate.$_type === 'image'
      )
    }
    return false
  })
}

export function getCanvasQuickEditMode(
  snapshot: Pick<CanvasSnapshot, 'nodes' | 'selectedNodeIds'>
): CanvasQuickEditMode {
  const selectedIds = new Set(snapshot.selectedNodeIds ?? [])
  const selectedNodes = (snapshot.nodes ?? []).filter(
    node => selectedIds.has(node.id) && node.visible !== false
  )

  const selectedImageIds = new Set(
    selectedNodes.filter(node => node.$_type === 'image').map(node => node.id)
  )
  const hasBoundImage = selectedNodes.some(node => {
    if (node.$_type === 'image-marker') {
      return (snapshot.nodes ?? []).some(
        candidate =>
          candidate.id === node.$_parentId && candidate.$_type === 'image'
      )
    }
    if (node.$_type === 'image-brush') {
      return (snapshot.nodes ?? []).some(
        candidate =>
          candidate.id === node.$_imageId && candidate.$_type === 'image'
      )
    }
    return false
  })
  const hasImageContext = selectedImageIds.size > 0 || hasBoundImage
  const hasStrongAnnotation = selectedNodes.some(node =>
    STRONG_ANNOTATION_NODE_TYPES.has(node.$_type)
  )

  if (hasImageContext && hasStrongAnnotation) return 'annotation_edit'
  if (selectedNodes.length === 1 && selectedImageIds.size === 1) {
    return 'reference_edit'
  }
  return 'composition'
}

export function getCanvasQuickEditReferenceMode(
  snapshot: Pick<CanvasSnapshot, 'nodes' | 'selectedNodeIds'>
): CanvasQuickEditReferenceMode {
  const selectedIds = new Set(snapshot.selectedNodeIds ?? [])
  const selectedNodes = (snapshot.nodes ?? []).filter(
    node => selectedIds.has(node.id) && node.visible !== false
  )
  const imageNodes = selectedNodes.filter(node => node.$_type === 'image')

  return selectedNodes.length > 1 &&
    imageNodes.length === selectedNodes.length &&
    imageNodes.every(node => Boolean(node.$_imageUrl))
    ? 'separate_images'
    : 'flattened_selection'
}

export function deriveCanvasQuickModelState(
  mainPreference: DrawModelPreference,
  mode: CanvasQuickEditMode,
  sourceAspectRatio?: string
): CanvasQuickModelState {
  if (mode === 'annotation_edit') {
    const modelId = DRAW_MODEL_ID.VISION_ARC_V2
    const preference = sourceAspectRatio
      ? setCanvasModelParameter(
          createCanvasModelPreference(modelId),
          modelId,
          ASPECT_RATIO_PARAMETER_KEY,
          sourceAspectRatio
        )
      : createCanvasModelPreference(modelId)

    return {
      preference,
      source: 'annotation_default',
      touchedParameterKeys: sourceAspectRatio
        ? { [modelId]: [ASPECT_RATIO_PARAMETER_KEY] }
        : {},
    }
  }

  const normalized = normalizeDrawModelPreference(mainPreference)
  if (normalized.mode === 'auto') {
    return {
      preference: normalized,
      source: 'system_auto',
      touchedParameterKeys: {},
    }
  }

  const modelId = normalized.modelId
  if (!modelId) {
    return {
      preference: normalized,
      source: 'system_auto',
      touchedParameterKeys: {},
    }
  }

  const nonDefaultParameters = getNonDefaultModelParameters(normalized, modelId)
  const preference = withCanvasReferenceDefaults(normalized, modelId, {
    ...nonDefaultParameters,
  })

  return {
    preference,
    source: 'main_inherited',
    touchedParameterKeys: {
      [modelId]: Object.keys(nonDefaultParameters),
    },
  }
}

export function getCanvasQuickEditSourceAspectRatio(
  snapshot: Pick<CanvasSnapshot, 'nodes' | 'selectedNodeIds'>,
  modelId: DrawModelId = DRAW_MODEL_ID.VISION_ARC_V2
): string | undefined {
  const selectedIds = new Set(snapshot.selectedNodeIds ?? [])
  if (selectedIds.size === 0) return undefined

  const nodes = snapshot.nodes ?? []
  const imageIds = new Set<string>()
  for (const node of nodes) {
    if (!selectedIds.has(node.id) || node.visible === false) continue
    if (node.$_type === 'image') {
      imageIds.add(node.id)
    } else if (node.$_type === 'image-marker') {
      imageIds.add(node.$_parentId)
    } else if (node.$_type === 'image-brush') {
      imageIds.add(node.$_imageId)
    }
  }

  const supportedRatios = getModelAspectRatioOptions(modelId)
  if (imageIds.size === 0 || supportedRatios.length === 0) return undefined

  const matchedRatios = new Set<string>()
  for (const imageId of imageIds) {
    const imageNode = nodes.find(
      node =>
        node.id === imageId && node.$_type === 'image' && node.visible !== false
    )
    if (!imageNode) return undefined

    const width = getScaledDimension(imageNode.width, imageNode.scaleX)
    const height = getScaledDimension(imageNode.height, imageNode.scaleY)
    if (!width || !height) return undefined

    const closestRatio = findClosestAspectRatio(width / height, supportedRatios)
    if (!closestRatio) return undefined
    matchedRatios.add(closestRatio)
  }

  return matchedRatios.size === 1 ? Array.from(matchedRatios)[0] : undefined
}

export function createCanvasModelPreference(
  modelId: DrawModelId
): DrawModelPreference {
  const model = getDrawModelOption(modelId)
  const mediaKind = model?.mediaKind ?? 'image'
  return withCanvasReferenceDefaults(
    {
      mode: 'manual',
      mediaKind,
      modelId,
      parameters: {},
    },
    modelId
  )
}

export function withCanvasReferenceDefaults(
  preference: DrawModelPreference,
  modelId = preference.modelId,
  overrides: DrawModelParameterValues = {}
): DrawModelPreference {
  if (!modelId) return normalizeDrawModelPreference(preference)
  const model = getDrawModelOption(modelId)
  if (!model) return normalizeDrawModelPreference(preference)

  const referenceDefaults: DrawModelParameterValues =
    model.mediaKind === 'image'
      ? {
          ...(model.parameterControls.some(
            control => control.key === 'resolution'
          )
            ? { resolution: 'auto' }
            : {}),
          ...(model.parameterControls.some(
            control => control.key === 'aspectRatio'
          )
            ? { aspectRatio: 'auto' }
            : {}),
        }
      : {}

  return normalizeDrawModelPreference({
    ...preference,
    mediaKind: model.mediaKind,
    modelId,
    parameters: {
      ...(preference.parameters ?? {}),
      [modelId]: {
        ...referenceDefaults,
        ...overrides,
      },
    },
  })
}

export function getCanvasDrawModelOption(
  modelId: DrawModelId | undefined
): DrawModelOption | undefined {
  const model = getDrawModelOption(modelId)
  if (!model || model.mediaKind !== 'image') return model

  return {
    ...model,
    parameterControls: model.parameterControls.map(
      toCanvasReferenceParameterControl
    ),
  }
}

export function setCanvasModelParameter(
  preference: DrawModelPreference,
  modelId: DrawModelId,
  key: string,
  value: DrawModelParameterValue
): DrawModelPreference {
  return normalizeDrawModelPreference({
    ...preference,
    parameters: {
      ...(preference.parameters ?? {}),
      [modelId]: {
        ...(preference.parameters?.[modelId] ?? {}),
        [key]: value,
      },
    },
  })
}

export function buildCanvasQuickEditPrompt(params: {
  requestId: string
  visiblePrompt: string
  mode: CanvasQuickEditMode
  referenceMode: CanvasQuickEditReferenceMode
  modelState: CanvasQuickModelState
  referImages: string[]
}): string {
  const hiddenContext = createCanvasQuickEditHiddenContext(params)
  return `<user_input_hidden_content>${JSON.stringify(hiddenContext)}</user_input_hidden_content> ${params.visiblePrompt.trim()}`
}

export function createCanvasQuickEditHiddenContext(params: {
  requestId: string
  visiblePrompt: string
  mode: CanvasQuickEditMode
  referenceMode: CanvasQuickEditReferenceMode
  modelState: CanvasQuickModelState
  referImages: string[]
}): CanvasQuickEditHiddenContext {
  const visiblePrompt = params.visiblePrompt.trim()
  const normalized = normalizeDrawModelPreference(params.modelState.preference)
  const model =
    normalized.mode === 'manual'
      ? getDrawModelOption(normalized.modelId)
      : undefined
  const requiredTool =
    model?.mediaKind === 'video' ? model.tool : model?.editTool
  const prompt =
    params.mode === 'annotation_edit'
      ? appendPromptSuffix(visiblePrompt, CANVAS_ANNOTATION_EDIT_PROMPT_SUFFIX)
      : visiblePrompt
  const explicitKeys = new Set(
    model ? (params.modelState.touchedParameterKeys[model.id] ?? []) : []
  )
  const modelParameters = model
    ? getExplicitModelParameters(normalized, model.id, explicitKeys)
    : {}
  const toolArguments = model
    ? getExplicitToolArguments(model, modelParameters, explicitKeys)
    : {}

  return {
    type: 'wj_canvas_quick_edit',
    version: 2,
    request_id: params.requestId,
    edit_mode: params.mode,
    reference_mode: params.referenceMode,
    model_source: params.modelState.source,
    model_policy: normalized.mode,
    ...(model
      ? {
          selected_model: {
            id: model.id,
            display_name: model.displayName,
            media_kind: model.mediaKind,
            edit_tool: model.editTool,
            tool: model.tool,
          },
        }
      : {}),
    ...(requiredTool ? { required_tool: requiredTool } : {}),
    ...(params.mode === 'annotation_edit'
      ? {
          required_prompt_suffix: CANVAS_ANNOTATION_EDIT_PROMPT_SUFFIX,
        }
      : {}),
    required_tool_prompt: prompt,
    refer_images: [...params.referImages],
    model_parameters: modelParameters,
    tool_arguments: {
      prompt,
      save_output: true,
      ...toolArguments,
    },
    rules: [
      params.referenceMode === 'separate_images'
        ? 'refer_images 是 Canvas 选中的多个独立图片图层，按界面附件顺序直接作为多张参考图使用；不要将它们重新拼成一张图。'
        : 'refer_images 是 Canvas 当前选区导出的完整扁平图片，直接作为本轮参考图使用；不要尝试拆分、重建或识别原始图层。',
      requiredTool
        ? `本轮界面已显示并选定模型，必须调用 required_tool=${requiredTool}，不要静默切换其他模型。`
        : '本轮模型为自动模式；根据用户可见需求和参考图选择最直接的可用图片编辑或图生视频工具。',
      '调用工具时 prompt 必须逐字使用 required_tool_prompt，不要翻译、扩写或改写。',
      'tool_arguments 只包含 Canvas 界面已明确展示的系统推导参数或用户实际修改的参数；不得自行补入默认画幅、分辨率、尺寸或质量。',
      '用户未显式修改画幅或分辨率时，保持参考图比例并让编辑工具自动决定输出清晰度。',
      ...(params.mode === 'annotation_edit'
        ? [
            '本轮由 Canvas 批注图层触发批注改图；严格执行 required_prompt_suffix，并在结果中去除批注痕迹。',
            ...(typeof modelParameters.aspectRatio === 'string'
              ? [
                  'aspect_ratio 由 Canvas 中的原始图片图层比例推导，用于避免画外批注扩大扁平参考图后改变输出比例。',
                ]
              : []),
          ]
        : []),
      ...(model?.mediaKind === 'video'
        ? [
            '本轮界面已切换为视频模型；将 refer_images 作为图生视频参考图使用，不要改用图片生成或图片编辑工具。',
            '视频结果只在对话中展示，不需要生成额外静态图片来回填 Canvas。',
          ]
        : []),
    ],
  }
}

export function resolveCanvasQuickModelStateForSend(params: {
  currentPreference: DrawModelPreference
  baselinePreference: DrawModelPreference
  initialTouchedParameterKeys?: Partial<Record<DrawModelId, string[]>>
  source: CanvasQuickModelSource
}): CanvasQuickModelState {
  const current = normalizeDrawModelPreference(params.currentPreference)
  const baseline = normalizeDrawModelPreference(params.baselinePreference)
  const modelId = current.modelId
  if (!modelId || current.mode === 'auto') {
    return {
      preference: current,
      source:
        current.mode !== baseline.mode || current.modelId !== baseline.modelId
          ? 'canvas_manual'
          : params.source,
      touchedParameterKeys: {},
    }
  }

  const currentParameters = current.parameters?.[modelId] ?? {}
  const baselineParameters =
    baseline.modelId === modelId
      ? (baseline.parameters?.[modelId] ?? {})
      : getDefaultDrawModelParameters(modelId)
  const touchedKeys = new Set(
    params.initialTouchedParameterKeys?.[modelId] ?? []
  )
  const changedKeys = new Set<string>()
  for (const key of new Set([
    ...Object.keys(currentParameters),
    ...Object.keys(baselineParameters),
  ])) {
    if (currentParameters[key] !== baselineParameters[key]) {
      touchedKeys.add(key)
      changedKeys.add(key)
    }
  }

  const modelChanged =
    current.mode !== baseline.mode || current.modelId !== baseline.modelId
  return {
    preference: current,
    source:
      modelChanged || changedKeys.size > 0 ? 'canvas_manual' : params.source,
    touchedParameterKeys: {
      [modelId]: Array.from(touchedKeys),
    },
  }
}

export function getCanvasModelIdForMediaKind(
  mediaKind: DrawModelPreference['mediaKind'],
  currentModelId?: DrawModelId
): DrawModelId {
  const currentModel = getDrawModelOption(currentModelId)
  return currentModel?.mediaKind === mediaKind
    ? currentModel.id
    : getDefaultDrawModelId(mediaKind)
}

function toCanvasReferenceParameterControl(
  control: DrawParameterControl
): DrawParameterControl {
  if (control.type !== 'select') return control
  if (control.key === 'resolution') {
    return {
      ...control,
      defaultValue: 'auto',
      options: [
        { value: 'auto', label: i18n.t('legacy:ui_4afad877551a') },
        ...control.options.filter(option => option.value !== 'auto'),
      ],
    }
  }
  if (control.key === 'aspectRatio') {
    return {
      ...control,
      defaultValue: 'auto',
      options: control.options.map(option =>
        option.value === 'auto'
          ? { ...option, label: i18n.t('legacy:ui_4afad877551a') }
          : option
      ),
    }
  }
  return control
}

function getModelAspectRatioOptions(modelId: DrawModelId): string[] {
  const control = getDrawModelOption(modelId)?.parameterControls.find(
    candidate =>
      candidate.type === 'select' &&
      candidate.key === ASPECT_RATIO_PARAMETER_KEY
  )
  if (!control || control.type !== 'select') return []
  return control.options
    .map(option => option.value)
    .filter(value => value !== 'auto' && parseAspectRatio(value) !== undefined)
}

function getScaledDimension(
  dimension: number | undefined,
  scale: number | undefined
): number | undefined {
  const resolvedDimension = Number(dimension)
  const resolvedScale = scale === undefined ? 1 : Math.abs(Number(scale))
  const value = resolvedDimension * resolvedScale
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function findClosestAspectRatio(
  sourceRatio: number,
  candidates: string[]
): string | undefined {
  if (!Number.isFinite(sourceRatio) || sourceRatio <= 0) return undefined

  let closest: { value: string; distance: number } | undefined
  for (const value of candidates) {
    const candidateRatio = parseAspectRatio(value)
    if (!candidateRatio) continue
    const distance = Math.abs(Math.log(sourceRatio / candidateRatio))
    if (!closest || distance < closest.distance) {
      closest = { value, distance }
    }
  }
  return closest?.value
}

function parseAspectRatio(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  const ratio = width / height
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined
}

function getNonDefaultModelParameters(
  preference: DrawModelPreference,
  modelId: DrawModelId
): DrawModelParameterValues {
  const stored = preference.parameters?.[modelId] ?? {}
  const defaults = getDefaultDrawModelParameters(modelId)
  return Object.fromEntries(
    Object.entries(stored).filter(
      ([key, value]) => value !== undefined && value !== defaults[key]
    )
  )
}

function getExplicitModelParameters(
  preference: DrawModelPreference,
  modelId: DrawModelId,
  explicitKeys: ReadonlySet<string>
): DrawModelParameterValues {
  const stored = preference.parameters?.[modelId] ?? {}
  return Object.fromEntries(
    Array.from(explicitKeys)
      .map(key => [key, stored[key]] as const)
      .filter(([, value]) => value !== undefined && value !== 'auto')
  )
}

function getExplicitToolArguments(
  model: DrawModelOption,
  parameters: DrawModelParameterValues,
  explicitKeys: ReadonlySet<string>
): Record<string, string | number | boolean> {
  if (Object.keys(parameters).length === 0) return {}
  const allArguments = buildDrawToolArguments(model, parameters)
  const allowedArgumentKeys = new Set(
    Array.from(explicitKeys).flatMap(key =>
      getToolArgumentKeysForParameter(model, key)
    )
  )

  return Object.fromEntries(
    Object.entries(allArguments).filter(([key]) => allowedArgumentKeys.has(key))
  )
}

function getToolArgumentKeysForParameter(
  model: DrawModelOption,
  parameterKey: string
): string[] {
  switch (parameterKey) {
    case 'aspectRatio':
      return [model.mediaKind === 'video' ? 'ratio' : 'aspect_ratio']
    case 'resolution':
      if (model.id === DRAW_MODEL_ID.SEEDREAM_5_LITE) return ['size']
      if (model.id === DRAW_MODEL_ID.SEEDREAM_5_PRO) return ['size']
      if (model.id === DRAW_MODEL_ID.VISION_ARC_V2) return ['image_size']
      if (model.id === DRAW_MODEL_ID.VISION_ARC_PRO) return ['image_size']
      if (model.id === DRAW_MODEL_ID.MIDJOURNEY_V8_1) return ['hd']
      return ['resolution']
    case 'quality':
      return ['quality']
    case 'stylize':
      return ['stylize']
    case 'generateMethod':
      return ['image_role_mode']
    case 'duration':
      return ['duration']
    case 'generate_audio':
      return ['generate_audio']
    default:
      return []
  }
}

function appendPromptSuffix(prompt: string, suffix: string): string {
  if (!prompt) return suffix
  if (prompt.includes(suffix)) return prompt
  const separator = /[。！？.!?]$/.test(prompt) ? '' : '。'
  return `${prompt}${separator}${suffix}`
}
