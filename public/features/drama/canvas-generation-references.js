import { canvasGenerationOptions } from './canvas-generation.js?v=13';


export function addGenerationReference(draft, file, config) {
  if (!file?.id) throw new Error('素材尚未就绪，请重新选择');
  if (draft.attachments.some(item => item.id === file.id)) return;
  let mode = draft.mode;
  if (draft.type === 'image') {
    if (file.kind !== 'image') throw new Error('图像生成只能添加图片参考');
    if (draft.attachments.length >= 7) throw new Error('参考图片最多添加 7 张');
  } else {
    if (mode === 'TEXT') {
      const modes = canvasGenerationOptions(draft, config).modes;
      mode = modes.some(item => item.generationType === 'REFERENCE') ? 'REFERENCE'
        : file.kind === 'image' && modes.some(item => item.generationType === 'FIRST&LAST') ? 'FIRST&LAST' : '';
      if (!mode) throw new Error('当前模型不支持这种参考素材');
    }
    if (mode === 'FIRST&LAST') {
      if (file.kind !== 'image') throw new Error('首尾帧只能添加图片');
      if (draft.attachments.length >= 2) throw new Error('首尾帧最多添加两张图片');
    }
    const {parameters} = canvasGenerationOptions({...draft, mode}, config);
    const limits = parameters?.referenceLimits || {};
    const maximum = Number(limits[file.kind] ?? (file.kind === 'image' ? parameters?.maxImages : 0)) || 0;
    if (draft.attachments.filter(item => item.kind === file.kind).length >= maximum ||
        draft.attachments.length >= Number(limits.total ?? parameters?.maxImages ?? 0)) {
      throw new Error('参考素材数量超过模型支持范围');
    }
  }
  draft.mode = mode;
  draft.attachments.push({id:file.id,name:file.name,kind:file.kind,url:file.previewUrl || file.url || ''});
}
