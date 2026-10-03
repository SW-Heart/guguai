import { replaceAssetMentions } from '../../public/video-prompt.js';

export function referenceLabel(value) {
  const label = String(value || '').replace(/^@/, '').trim();
  if (!label || label.length > 120 || /[@\r\n]/.test(label)) throw new Error('请使用清楚、不含 @ 或换行的素材名称');
  return label;
}

// Reference numbering must include unmentioned inputs and match upload order.
export function prepareAgentReferences(args, bindings = [], findAsset) {
  const explicit = (args.assetMentions || []).map(item => ({ id:item.id, label:referenceLabel(item.label) }));
  const candidates = new Map();
  for (const item of bindings) candidates.set(item.label, item);
  for (const item of explicit) {
    if (explicit.some(other => other.label === item.label && other.id !== item.id)) throw new Error(`“${item.label}”对应了多个素材，请分别命名`);
    candidates.set(item.label, item);
  }
  const ids = [...new Set(args.referenceAssetIds || [])];
  const tokens = [...candidates.keys()].sort((left,right)=>right.length-left.length).map(label=>`@${label}`.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const used = new Set(tokens.length ? String(args.prompt || '').match(new RegExp(tokens.join('|'),'g')) || [] : []);
  for (const item of candidates.values()) {
    if ((explicit.some(value => value.id === item.id) || used.has(`@${item.label}`)) && !ids.includes(item.id)) ids.push(item.id);
  }
  const assets = new Map(ids.map(id => {
    const asset = findAsset?.(id);
    if (findAsset && (!asset || !['image','video','audio'].includes(asset.kind))) throw new Error('参考素材不存在或不属于当前工作空间，请重新选择');
    return [id, asset];
  }));
  if (explicit.length && !findAsset) throw new Error('暂时无法读取参考素材');
  const aliases = [...candidates.values()].filter(item => ids.includes(item.id));
  for (const [id, asset] of assets) {
    if (!asset?.name || /[@\r\n]/.test(asset.name) || aliases.some(item => item.label === asset.name)) continue;
    const sameName = [...assets.values()].filter(item=>item?.name === asset.name);
    if (sameName.length > 1) {
      if (String(args.prompt || '').includes(`@${asset.name}`)) throw new Error(`“${asset.name}”对应了多个素材，请分别命名`);
      continue;
    }
    aliases.push({id,label:asset.name});
  }
  // Every reference gets a slot, even when only a later asset is named in text.
  const mentions = ids.flatMap(id => {
    const kind = assets.get(id)?.kind || 'image';
    const named = aliases.filter(item => item.id === id);
    return named.length ? named.map(item => ({...item,kind})) : [{id,label:`素材 ${id}`,kind}];
  });
  const counts = {image:0,video:0,audio:0};
  const references = ids.map(id => {
    const asset = assets.get(id), kind = asset?.kind || 'image';
    const label = aliases.find(item => item.id === id)?.label || asset?.name || '参考素材';
    return {id,label,kind,slot:`${({image:'Image',video:'Video',audio:'Audio'})[kind]}${++counts[kind]}`};
  });
  const {assetMentions, ...input} = args;
  input.prompt = replaceAssetMentions(args.prompt, mentions);
  if (ids.length || args.referenceAssetIds) input.referenceAssetIds = ids;
  return {input,displayPrompt:args.prompt,references,mentions};
}
