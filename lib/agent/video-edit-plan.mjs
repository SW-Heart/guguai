// Declarative editing only: no commands, paths, filter expressions or executable code from the model.
const number = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
const string = (description, maxLength = 160) => ({ type: 'string', description, maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const point = object({
  seconds: number('成片秒数；与 phrase 二选一', 0, 300),
  phrase: string('目标成片已转录的准确词句；忽略大小写、空格和标点'),
  occurrence: { type: 'integer', minimum: 1, maximum: 100, description: '重复词句的第几次出现；有歧义时必须指定' },
  edge: { type: 'string', enum: ['start', 'end'], description: '词句起点或终点，默认 start' },
  offsetSeconds: number('相对词句的偏移秒数，默认 0', -30, 30),
});
export const videoEditSchema = object({
  baseAssetId: string('作为底片的当前工作空间视频 ID'),
  dryRun: { type: 'boolean', description: '只检查素材与时间，返回可执行时间表，不渲染；默认 false' },
  layers: { type: 'array', minItems: 1, maxItems: 24, description: '从底到顶的图层；修改时读取旧方案，沿用原底片并提交完整新图层列表', items: object({
    id: string('稳定图层名，便于以后修改', 64),
    kind: { type: 'string', enum: ['text', 'rectangle', 'image', 'video'] },
    start: point, end: point,
    x: number('左上角横向位置，相对画布宽度；0 为左边，允许画外进入', -1, 1),
    y: number('左上角纵向位置，相对画布高度；0 为上边，允许画外进入', -1, 1),
    width: number('图层框宽度，相对画布宽度', 0.02, 1),
    height: number('图层框高度，相对画布高度', 0.02, 1),
    moveTo: object({ x: number('结束时横向位置', -1, 1), y: number('结束时纵向位置', -1, 1) }, ['x', 'y']),
    opacity: number('不透明度，默认 1', 0, 1),
    scaleFrom: number('起始缩放，相对于图层框，默认 1', 0.2, 1.5),
    scaleTo: number('结束缩放，相对于图层框，默认 1', 0.2, 1.5),
    fadeInSeconds: number('淡入秒数，默认 0', 0, 10),
    fadeOutSeconds: number('淡出秒数，默认 0', 0, 10),
    text: string('文字图层的实际显示内容；换行用换行符', 300),
    fontSize: number('字号相对画布高度，文字图层默认 0.045', 0.015, 0.2),
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: '文字或色块颜色，例如 #FFFFFF' },
    assetId: string('图片或视频图层的素材 ID'),
    fit: { type: 'string', enum: ['contain', 'cover'], description: '完整显示或居中裁切，默认 contain' },
    sourceStartSeconds: number('视频图层源素材的裁剪起点，默认 0；视频图层不混入声音', 0, 3600),
  }, ['id', 'kind', 'start', 'end', 'x', 'y', 'width', 'height']) },
}, ['baseAssetId', 'layers']);

const normalized = text => String(text).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const validNumber = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

export function currentTranscriptWords(records, digest) {
  const words = [], covered = [];
  for (const record of records.filter(record => record.sourceSha256 === digest).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    for (const word of record.words || []) {
      const midpoint = (word.startSeconds + word.endSeconds) / 2;
      if (covered.some(range => midpoint >= range.startSeconds && midpoint < range.endSeconds)) continue;
      if (normalized(word.text) && validNumber(word.startSeconds, 0, 3600) && validNumber(word.endSeconds, word.startSeconds, 3600)) words.push(word);
    }
    covered.push(record);
  }
  return words.sort((a, b) => a.startSeconds - b.startSeconds);
}

function resolvePoint(point, words) {
  if (!point || (point.seconds !== undefined) === (point.phrase !== undefined)) throw new Error('每个时间点请指定秒数或台词，不能同时填写');
  if (point.seconds !== undefined) {
    if (!validNumber(point.seconds, 0, 300) || ['occurrence', 'edge', 'offsetSeconds'].some(key => point[key] !== undefined)) throw new Error('固定时间点只填写秒数');
    return point.seconds;
  }
  const phrase = normalized(point.phrase);
  if (!phrase || phrase.length > 160 || !words.length) throw new Error('请先转录目标成片，再使用其中的准确词句定位');
  const matches = [];
  for (let index = 0; index < words.length; index++) {
    let value = '';
    for (let end = index; end < words.length && end < index + 160; end++) {
      if (end > index && words[end].startSeconds - words[end - 1].endSeconds > 2) break;
      value += normalized(words[end].text);
      if (value === phrase) { matches.push({ start: words[index].startSeconds, end: words[end].endSeconds }); break; }
      if (!phrase.startsWith(value)) break;
    }
  }
  if (!matches.length) throw new Error(`未在目标成片台词中找到“${point.phrase}”，请核对转录或改用秒数`);
  if (matches.length > 1 && point.occurrence === undefined) throw new Error(`“${point.phrase}”出现多次，请指定第几次`);
  const occurrence = point.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1 || !matches[occurrence - 1]) throw new Error('指定的台词出现次数不存在');
  if (point.edge !== undefined && !['start', 'end'].includes(point.edge)) throw new Error('请选择词句起点或终点');
  if (!validNumber(point.offsetSeconds ?? 0, -30, 30)) throw new Error('台词时间偏移超出范围');
  return matches[occurrence - 1][point.edge || 'start'] + (point.offsetSeconds || 0);
}

export function resolveVideoEditPlan(plan, metadata, words = []) {
  if (!validNumber(metadata.durationSeconds, 0.01, 300)) throw new Error('画面编辑支持最多 300 秒的视频');
  if (!Array.isArray(plan.layers) || !plan.layers.length || plan.layers.length > 24) throw new Error('请选择 1 到 24 个画面元素');
  const ids = new Set();
  return plan.layers.map(layer => {
    if (typeof layer.id !== 'string' || !layer.id.trim() || layer.id.length > 64 || ids.has(layer.id)) throw new Error('画面元素名称不能为空或重复');
    ids.add(layer.id);
    if (!['text', 'rectangle', 'image', 'video'].includes(layer.kind)) throw new Error('不支持这个画面元素类型');
    const startSeconds = resolvePoint(layer.start, words), endSeconds = resolvePoint(layer.end, words);
    if (!validNumber(startSeconds, 0, metadata.durationSeconds) || !validNumber(endSeconds, startSeconds + 0.04, metadata.durationSeconds)) throw new Error('画面元素时间超出成片范围或过短');
    for (const point of [layer, ...(layer.moveTo ? [layer.moveTo] : [])]) {
      if (!validNumber(point.x, -1, 1) || !validNumber(point.y, -1, 1)) throw new Error('画面元素位置超出范围');
    }
    if (!validNumber(layer.width, 0.02, 1) || !validNumber(layer.height, 0.02, 1)) throw new Error('画面元素尺寸超出范围');
    if (layer.color !== undefined && !/^#[\da-f]{6}$/i.test(layer.color)) throw new Error('颜色请使用六位十六进制写法');
    if (!validNumber(layer.scaleFrom ?? 1, 0.2, 1.5) || !validNumber(layer.scaleTo ?? 1, 0.2, 1.5)) throw new Error('画面缩放超出范围');
    const opacity = layer.opacity ?? 1, fadeInSeconds = layer.fadeInSeconds ?? 0, fadeOutSeconds = layer.fadeOutSeconds ?? 0;
    if (!validNumber(opacity, 0, 1) || !validNumber(fadeInSeconds, 0, 10) || !validNumber(fadeOutSeconds, 0, 10) || fadeInSeconds + fadeOutSeconds > endSeconds - startSeconds) throw new Error('透明度或淡入淡出时长超出范围');
    if (layer.kind === 'text' && (typeof layer.text !== 'string' || !layer.text.trim() || layer.text.length > 300 || !validNumber(layer.fontSize ?? 0.045, 0.015, 0.2))) throw new Error('请填写有效文字与字号');
    if (['image', 'video'].includes(layer.kind) && (typeof layer.assetId !== 'string' || !layer.assetId)) throw new Error('请为画面元素选择真实素材');
    if (layer.fit !== undefined && !['contain', 'cover'].includes(layer.fit)) throw new Error('请选择完整显示或居中裁切');
    if (!validNumber(layer.sourceStartSeconds ?? 0, 0, 3600)) throw new Error('源视频起点超出范围');
    return { ...layer, startSeconds, endSeconds, opacity, fadeInSeconds, fadeOutSeconds };
  });
}
