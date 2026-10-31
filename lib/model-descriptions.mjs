import { publicVideoCapabilities } from './video-capabilities.mjs';

export const MODEL_DESCRIPTION_MAX_LENGTH = 120;
export const IMAGE_MODEL_DESCRIPTIONS = Object.freeze({
  'seedream-5.0': '支持文字生图和参考图编辑，可选 2K、3K、4K 清晰度。',
  'gpt-image-2.5': '支持 1K、2K、4K 多画幅高清图像生成。',
  'gpt-image-2': '从文字或参考图快速探索画面。',
  'nano-banana-2.1': '支持文字生图和参考图编辑，可选 1K、2K、4K 清晰度。',
  midjourney: '通过 Midjourney 参数精细控制艺术风格。',
});

/**
 * Text written into a model's control row the first time it is seen. After
 * that the admin console owns it, so releases never overwrite it.
 */
export function initialModelDescription(modelId) {
  if (Object.hasOwn(IMAGE_MODEL_DESCRIPTIONS, modelId)) return IMAGE_MODEL_DESCRIPTIONS[modelId];
  return publicVideoCapabilities().models.find(model => model.id === modelId)?.description || '';
}
