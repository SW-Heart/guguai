import { canvasGenerationOptions } from './canvas-generation.js?v=15';


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

// Saved storyboard references can predate the local delivery of their images.
export function hydrateGenerationReferences(draft,findFile){
  let changed=false;
  for(const reference of draft?.attachments||[]){
    const file=findFile(reference.id);
    const url=file?.previewUrl||file?.url;
    if(url&&url!==reference.url){reference.url=url;changed=true;}
  }
  return changed;
}

// A canvas link adds one more reference of `kind`. Validate it against the
// model with the references already present and switch a text-only video to a
// mode that accepts references.
export function admitLinkedReference(draft, kind, linkedKinds, config) {
  const probe = {...draft, attachments:[...draft.attachments, ...linkedKinds.map((item, index) => ({id:`linked-${index}`, kind:item, name:''}))]};
  addGenerationReference(probe, {id:'linked-new', kind, name:''}, config);
  draft.mode = probe.mode;
}
