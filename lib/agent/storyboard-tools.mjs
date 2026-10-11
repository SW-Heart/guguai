// A storyboard plan is the agent's proposal of generation cards. The canvas turns
// each segment into an editable video card and each reference into an image
// card; nothing here submits or prices a generation.
const MAX_STORYBOARDS = 20;
const MAX_SEGMENTS = 60;
const MAX_REFERENCES = 20;
const KEY = /^[A-Za-z0-9_-]{1,24}$/;
const RATIO = /^\d{1,2}:\d{1,2}$/;

const text = (description, maxLength = 2000) => ({ type: 'string', description, maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const list = (description, items, maxItems) => ({ type: 'array', description, items, maxItems });

export const storyboardWriteSchema = object({
  id: text('修改已有分镜时填写；新建留空', 80),
  expectedRevision: { type: 'number', description: '修改时的当前版本', minimum: 1, maximum: 100000 },
  append: { type: 'boolean', description: '为 true 时把本次的生成段和新参考追加到已有分镜（需 id 与 revision），用于按集分批写入；否则整体替换' },
  title: text('分镜标题，例如作品名与章节', 160),
  video: object({
    modelId: text('视频模型 ID，来自 models_list', 100),
    aspect: text('画面比例，例如 9:16', 10),
    quality: text('画质，必须是该模型支持的选项', 20),
  }, ['modelId', 'aspect', 'quality']),
  image: object({
    modelId: text('角色与场景参考图的图像模型 ID；留空使用默认图像模型', 100),
    quality: text('图像画质，按模型说明填写', 20),
  }),
  references: list('需要保持一致的角色、场景、道具。每项生成一张参考图卡片；已有真实素材时填写 assetId，不再生成。', object({
    key: text('稳定标识，字母数字短横线，例如 grandma', 24),
    name: text('用户可读名称，视频描述中用 @名称 引用', 40),
    kind: { type: 'string', enum: ['character', 'location', 'prop'], description: '角色、场景或道具' },
    prompt: text('参考图画面描述：外貌、服装、空间结构、材质等稳定特征', 5000),
    aspect: text('参考图比例，角色常用 3:4，场景常用 16:9', 10),
    assetId: text('已有真实素材 ID；填写后不生成新参考图', 200),
  }, ['key', 'name', 'kind']), MAX_REFERENCES),
  segments: list('按生成顺序排列的视频生成段。一段对应一次视频生成，可包含多个按时间写清的镜头。', object({
    key: text('稳定标识，例如 ep1-s2', 24),
    episode: text('所属集，例如 第1集', 40),
    title: text('段落短标题', 60),
    duration: { type: 'number', description: '生成时长（秒），必须是模型支持的时长', minimum: 1, maximum: 60 },
    shots: text('本段包含的镜头摘要，例如 镜1 车厢中景 / 镜2 出站跟拍', 1000),
    prompt: text('可直接生成的完整视频描述，段内按时间写镜头，例如 0-4秒：…；角色、场景用 @名称', 10000),
    references: list('本段引用的参考 key', { type: 'string', maxLength: 24 }, 12),
  }, ['key', 'episode', 'title', 'duration', 'prompt']), MAX_SEGMENTS),
}, ['title', 'video', 'segments']);

function modeOptions(mode, quality, aspect) {
  return mode.durationsByQuality?.[quality]?.[aspect] || mode.durations || [];
}

export function validateStoryboard(input, catalog) {
  const problems = [];
  const video = catalog.find(model => model.kind === 'video' && model.id === input.video.modelId);
  if (!video) problems.push(`视频模型 ${input.video.modelId} 当前不可用，请用 models_list 重新选择`);
  const modes = (video?.modes || []).filter(mode => ['TEXT', 'REFERENCE'].includes(mode.generationType));
  const usable = modes.filter(mode => mode.aspectRatios?.includes(input.video.aspect) && mode.qualityOptions?.includes(input.video.quality));
  if (video && !usable.length) {
    const aspects = [...new Set(modes.flatMap(mode => mode.aspectRatios || []))].join('、');
    const qualities = [...new Set(modes.flatMap(mode => mode.qualityOptions || []))].join('、');
    problems.push(`${video.label || video.id} 不支持 ${input.video.aspect} + ${input.video.quality}；可用比例 ${aspects}，画质 ${qualities}`);
  }
  const durations = [...new Set(usable.flatMap(mode => modeOptions(mode, input.video.quality, input.video.aspect)))].sort((a, b) => a - b);
  const image = input.image?.modelId ? catalog.find(model => model.kind === 'image' && model.id === input.image.modelId) : null;
  if (input.image?.modelId && !image) problems.push(`图像模型 ${input.image.modelId} 当前不可用`);
  if (image && input.image.quality && image.qualities && !image.qualities.includes(input.image.quality)) problems.push(`${image.label || image.id} 的画质只能是 ${image.qualities.join('、')}`);

  const references = input.references || [];
  const referenceKeys = new Set();
  const referenceNames = new Set();
  for (const reference of references) {
    if (!KEY.test(reference.key)) problems.push(`参考标识 ${reference.key} 只能使用字母、数字、短横线`);
    if (referenceKeys.has(reference.key)) problems.push(`参考标识 ${reference.key} 重复`);
    if (!reference.name.trim() || /[@\s]/.test(reference.name)) problems.push(`参考名称「${reference.name}」不能为空或包含空格、@`);
    if (referenceNames.has(reference.name)) problems.push(`参考名称「${reference.name}」重复`);
    if (!reference.assetId && !reference.prompt?.trim()) problems.push(`参考「${reference.name}」需要画面描述或已有素材`);
    if (reference.aspect && !RATIO.test(reference.aspect)) problems.push(`参考「${reference.name}」的比例格式无效`);
    referenceKeys.add(reference.key); referenceNames.add(reference.name);
  }
  const byKey = new Map(references.map(reference => [reference.key, reference]));
  const segmentKeys = new Set();
  const promptLimit = input.video.modelId === 'minimax-h3-15s' ? 10000 : 4096;
  for (const segment of input.segments) {
    const label = `生成段 ${segment.key}`;
    if (!KEY.test(segment.key)) problems.push(`${label} 的标识只能使用字母、数字、短横线`);
    if (segmentKeys.has(segment.key)) problems.push(`${label} 标识重复`);
    segmentKeys.add(segment.key);
    if (!segment.prompt.trim()) problems.push(`${label} 缺少视频描述`);
    if (Array.from(segment.prompt).length > promptLimit) problems.push(`${label} 的描述超过 ${promptLimit} 字`);
    if (durations.length && !durations.includes(segment.duration)) problems.push(`${label} 时长 ${segment.duration} 秒不受支持；可选 ${durations.join('、')} 秒`);
    for (const key of segment.references || []) {
      const reference = byKey.get(key);
      if (!reference) problems.push(`${label} 引用了不存在的参考 ${key}`);
      else if (!segment.prompt.includes(`@${reference.name}`)) problems.push(`${label} 引用了「${reference.name}」，描述中需写 @${reference.name}`);
    }
  }
  if (problems.length) throw new Error(`分镜未保存：${problems.slice(0, 12).join('；')}`);
}

export function publicStoryboard(item, resolveAsset = () => null) {
  return {
    id: item.id, revision: item.revision, title: item.title, video: item.video, image: item.image || null,
    references: item.references.map(reference => {
      const asset = reference.assetId ? resolveAsset(reference.assetId) : null;
      return { ...reference, ...(asset ? { url: asset.previewUrl || asset.url || '', assetKind: asset.kind } : {}) };
    }),
    segments: item.segments,
    ...(item.conversationId ? { conversationId: item.conversationId } : {}),
  };
}

export function registerStoryboardTools({ add, catalog, findAsset }) {
  add('storyboard_write', '把改编或分镜结果直接排到画布（内容多时先写第一集，再用 append 逐集追加）：每个生成段成为一张可编辑、可直接生成的视频卡片，每个角色/场景/道具成为一张参考图卡片。不提交生成、不扣费。修改需要当前 id 与 revision，并提交完整内容。', storyboardWriteSchema, async (args, session, invocation) => {
    session.doc.storyboards ||= [];
    const existing = args.id ? session.doc.storyboards.find(item => item.id === args.id) : null;
    if (existing?.lastInvocation === invocation.id) return { id: existing.id, revision: existing.revision };
    if (args.id && !existing) throw new Error('分镜不存在，请先读取当前分镜');
    if (existing && existing.revision !== args.expectedRevision) throw new Error('分镜已更新，请读取最新版本后再修改');
    if (!existing && session.doc.storyboards.length >= MAX_STORYBOARDS) throw new Error('当前对话的分镜数量已达上限');
    if (args.append && !existing) throw new Error('追加需要已有分镜的 id');
    if (args.append) {
      const keys = new Set(existing.references.map(item => item.key));
      args = { ...args, references: [...existing.references.map(({ key, name, kind, prompt, aspect, assetId }) => ({ key, name, kind, ...(prompt ? { prompt } : {}), ...(aspect ? { aspect } : {}), ...(assetId ? { assetId } : {}) })), ...(args.references || []).filter(item => !keys.has(item.key))],
        segments: [...existing.segments, ...args.segments] };
      if (args.references.length > MAX_REFERENCES || args.segments.length > MAX_SEGMENTS) throw new Error(`单个分镜最多 ${MAX_SEGMENTS} 段、${MAX_REFERENCES} 个参考`);
    }
    validateStoryboard(args, await catalog());
    for (const reference of args.references || []) {
      if (!reference.assetId) continue;
      const asset = findAsset?.(session.userId, reference.assetId, session.scope);
      if (!asset || asset.kind !== 'image') throw new Error(`参考「${reference.name}」的素材不存在或不是图片`);
    }
    const id = existing?.id || `sb-${String(invocation.id).replace(/[^\w-]/g, '').slice(-16) || Date.now().toString(36)}`;
    const record = {
      id, revision: (existing?.revision || 0) + 1, title: args.title.trim(),
      video: { ...args.video }, image: args.image?.modelId ? { ...args.image } : null,
      references: (args.references || []).map(({ key, name, kind, prompt = '', aspect = '', assetId = '' }) => ({ key, name: name.trim(), kind, prompt: prompt.trim(), aspect, assetId })),
      segments: args.segments.map(({ key, episode, title, duration, shots = '', prompt, references = [] }) => ({ key, episode: episode.trim(), title: title.trim(), duration, shots: shots.trim(), prompt: prompt.trim(), references })),
      lastInvocation: invocation.id, updatedAt: Date.now(),
    };
    if (existing) Object.assign(existing, record); else session.doc.storyboards.push(record);
    const totalSeconds = record.segments.reduce((sum, segment) => sum + segment.duration, 0);
    return { id, revision: record.revision, segmentCount: record.segments.length, referenceCount: record.references.length, totalSeconds,
      note: '画布会出现对应卡片；用户可修改描述、模型和参数后直接生成。参考图生成完成后会自动关联到引用它的视频卡片。' };
  });
  add('storyboard_read', '读取已排到画布的分镜计划（生成段与参考），用于局部修改。用户在画布上直接改过的卡片以画布为准。', object({ id: text('分镜 ID', 80) }, ['id']), async (args, session) => {
    const item = (session.doc.storyboards || []).find(entry => entry.id === args.id);
    if (!item) throw new Error('分镜不存在');
    return publicStoryboard(item);
  });
}
