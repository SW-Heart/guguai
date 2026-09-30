import { videoEditSchema, currentTranscriptWords, resolveVideoEditPlan } from './video-edit-plan.mjs';

export function registerVideoEditTools({ add, inspectVideo, findAsset, publicAsset, sourceTranscriptsFor, compositionsFor }) {
  if (!inspectVideo?.edit) return;
  const scopedVideo = (session, id) => {
    const asset = findAsset(session.userId, id, session.scope);
    if (!asset || asset.kind !== 'video') throw new Error('视频不存在或不属于当前工作空间');
    return asset;
  };
  add('video_edit_read', '读取已编辑成片的原底片和完整图层方案。局部修改时使用原底片重新渲染，避免重复叠字；长方案按 nextOffset 续读。', {
    type: 'object', additionalProperties: false, required: ['assetId'], properties: {
      assetId: { type: 'string', description: '之前 video_edit 返回的成片 ID' },
      offset: { type: 'number', minimum: 0, maximum: 100000, description: '读取字符位置，默认 0' },
    },
  }, async (args, session) => {
    const asset = scopedVideo(session, args.assetId);
    const plan = asset.editPlan || compositionsFor(session).find(item => item.assetId === asset.id)?.editPlan;
    if (!plan) throw new Error('这份视频没有可继续修改的画面方案');
    const text = JSON.stringify(plan);
    const offset = args.offset ?? 0;
    if (!Number.isInteger(offset) || offset > text.length) throw new Error('读取位置无效');
    return { assetId: asset.id, text: text.slice(offset, offset + 2200), nextOffset: offset + 2200 < text.length ? offset + 2200 : null };
  });
  add('video_edit', '为已有视频添加文字、色块、图片和无声视频图层，可做画中画、分屏、排名卡片、移动与淡入淡出；按秒数或目标成片的实际转录词句定位。dryRun 只验证，正式渲染需用户已要求制作。修改用原底片和完整图层列表。', videoEditSchema, async (args, session, invocation) => {
    const base = scopedVideo(session, args.baseAssetId);
    const existing = !args.dryRun && findAsset(session.userId, invocation.id, session.scope);
    if (existing?.editPlan) {
      remember(existing, existing.editPlan);
      return publicAsset(existing);
    }
    const metadata = await inspectVideo.probe(session.userId, base);
    const records = sourceTranscriptsFor(session, base.id);
    const words = /^[a-f0-9]{64}$/.test(base.sha256 || '') ? currentTranscriptWords(records, base.sha256) : [];
    const resolved = resolveVideoEditPlan(args, metadata, words);
    const layers = [];
    for (const layer of resolved) {
      let asset;
      if (['image', 'video'].includes(layer.kind)) {
        asset = findAsset(session.userId, layer.assetId, session.scope);
        if (!asset || asset.kind !== layer.kind) throw new Error('画面素材不存在、类型不符或不属于当前工作空间');
        if (layer.kind === 'video') {
          const info = await inspectVideo.probe(session.userId, asset);
          if (info.durationSeconds === null || (layer.sourceStartSeconds || 0) + layer.endSeconds - layer.startSeconds > info.durationSeconds + 0.01) throw new Error('叠加视频长度不足，请缩短展示时间或换一段素材');
        }
      }
      layers.push({ ...layer, ...(asset ? { asset } : {}) });
    }
    const timing = resolved.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds }));
    if (args.dryRun) return { baseAssetId: base.id, durationSeconds: metadata.durationSeconds, timing, ready: true };
    const plan = {
      baseAssetId: base.id,
      layers: args.layers,
      sourceDigests: Object.fromEntries([base, ...layers.flatMap(layer => layer.asset ? [layer.asset] : [])].map(asset => [asset.id, asset.sha256 || ''])),
      resolvedTiming: timing,
    };
    const output = await inspectVideo.edit(session.userId, session.scope, base, layers, { id: invocation.id, editPlan: plan });
    remember(output, plan);
    return { ...publicAsset(output), layerCount: layers.length, editable: true };

    function remember(output, editPlan) {
      session.doc.compositions ||= [];
      if (!session.doc.compositions.some(item => item.assetId === output.id)) session.doc.compositions.push({
        assetId: output.id, invocationId: invocation.id, sourceAssetIds: Object.keys(editPlan.sourceDigests), editPlan,
        durationSeconds: output.duration, createdAt: Date.now(),
      });
      session.doc.compositions = session.doc.compositions.slice(-20);
    }
  });
}
