// Public model catalog for the OpenAI-compatible API. Everything here is
// derived from the same live model controls, routes and prices the desktop
// client uses, so a channel or parameter change in the admin console is
// reflected in /v1/models and the API documentation without code changes.

export const API_MODEL_CREATED = 1767225600; // 2026-01-01T00:00:00Z, stable for /v1/models

const GPT_IMAGE_2 = 'gpt-image-2';
const GPT_IMAGE_25 = 'gpt-image-2.5';
const MIDJOURNEY = 'midjourney';

export const GPT_IMAGE_25_DIMENSIONS = Object.freeze({
  '1:1': Object.freeze({ '1k':'1024x1024', '2k':'2048x2048', '4k':'2880x2880' }),
  '2:3': Object.freeze({ '1k':'816x1232', '2k':'1360x2048', '4k':'2352x3520' }),
  '3:2': Object.freeze({ '1k':'1232x816', '2k':'2048x1360', '4k':'3520x2352' }),
  '3:4': Object.freeze({ '1k':'880x1184', '2k':'1552x2080', '4k':'2336x3120' }),
  '4:3': Object.freeze({ '1k':'1184x880', '2k':'2080x1552', '4k':'3120x2336' }),
  '16:9': Object.freeze({ '1k':'1360x768', '2k':'2048x1152', '4k':'3536x1984' }),
  '9:16': Object.freeze({ '1k':'768x1360', '2k':'1152x2048', '4k':'1984x3536' }),
  '1:2': Object.freeze({ '1k':'720x1440', '2k':'1024x2048', '4k':'1920x3840' }),
  '2:1': Object.freeze({ '1k':'1440x720', '2k':'2048x1024', '4k':'3840x1920' }),
  '5:4': Object.freeze({ '1k':'1120x896', '2k':'1920x1536', '4k':'3200x2560' }),
  '4:5': Object.freeze({ '1k':'896x1120', '2k':'1536x1920', '4k':'2560x3200' }),
});

// Common OpenAI image sizes map onto the aspect ratios GPT-Image-2 accepts.
const OPENAI_IMAGE_SIZE_RATIOS = Object.freeze({ '1024x1024':'1:1', '1536x1024':'3:2', '1024x1536':'2:3', auto:'1:1' });

const VIDEO_SHORT_SIDE = Object.freeze({ '480p':480, '720p':720, '768p':768, '1080p':1080, '4k':2160 });
const MODE_NAMES = Object.freeze({ TEXT:'text', REFERENCE:'reference', 'FIRST&LAST':'first_last' });
const MODE_LABELS = Object.freeze({ text:'文生视频', reference:'参考素材生成', first_last:'首尾帧生成' });
const MIDJOURNEY_VERSIONS = Object.freeze(['6', '6.1', '7', '8', '8.1', '8.2']);
const MIDJOURNEY_QUALITIES = Object.freeze(['0.25', '0.5', '1', '2', '4']);
const IMAGE_REFERENCE_LIMIT = 7;

export function apiParamError(message, param = null, statusCode = 400, code = 'invalid_parameter') {
  return Object.assign(new Error(message), { statusCode, apiParam:param, apiCode:code, publicMessage:message });
}

const evenRound = value => Math.round(value / 2) * 2;

export function videoDimensions(aspectRatio, quality) {
  const shortSide = VIDEO_SHORT_SIDE[quality];
  const match = /^(\d+):(\d+)$/.exec(String(aspectRatio));
  if (!shortSide || !match) return '';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return '';
  if (width === height) return `${shortSide}x${shortSide}`;
  const longSide = evenRound(shortSide * Math.max(width, height) / Math.min(width, height));
  return width > height ? `${longSide}x${shortSide}` : `${shortSide}x${longSide}`;
}

const uniqueSorted = values => [...new Set(values)].sort((a, b) => a - b);
const unique = values => [...new Set(values)];

function priceRows(prices, modelId) {
  return prices.filter(item => item.modelId === modelId && item.available !== false && Number.isFinite(Number(item.credits)))
    .map(item => ({
      quality:item.quality || '标准',
      seconds:Number.isFinite(Number(item.duration)) && item.duration !== null ? Number(item.duration) : null,
      unit:item.unit === 'second' ? 'second' : 'request',
      credits:Number(item.credits),
      yuan:Number(Number(item.yuan).toFixed(4)),
    }));
}

function imageModelEntry(model, prices, imageAspectRatios) {
  const base = {
    id:model.id,
    object:'model',
    created:API_MODEL_CREATED,
    owned_by:'gugu-ai',
    type:'image',
    name:model.id === GPT_IMAGE_2 ? 'GPT-Image-2' : model.label,
    description:model.description || '',
    endpoints:['/v1/images/generations', '/v1/images/edits'],
    pricing:priceRows(prices, model.id),
    limits:{ reference_images:IMAGE_REFERENCE_LIMIT },
  };
  const prompt = { name:'prompt', type:'string', required:true, description:'画面描述，最多 5000 个字符。' };
  const image = { name:'image', type:'file | string | array', required:false, endpoints:['/v1/images/edits'], description:`参考图，最多 ${IMAGE_REFERENCE_LIMIT} 张。支持文件上传、https 图片链接或 data URL；支持 PNG、JPEG、WebP，单张不超过 20 MB。` };
  if (model.id === GPT_IMAGE_25) {
    const sizes = Object.values(GPT_IMAGE_25_DIMENSIONS).flatMap(tiers => Object.values(tiers));
    return { ...base, parameters:[
      prompt,
      { name:'size', type:'string', required:false, default:'1024x1024', values:['auto', ...sizes], description:'输出尺寸。也可以传画幅比例（如 16:9）并配合 quality 选择清晰度。尺寸决定清晰度档位和价格。' },
      { name:'quality', type:'string', required:false, default:'1k', values:['1k', '2k', '4k'], description:'清晰度档位。传入具体尺寸时以尺寸为准；size 为 auto 或画幅比例时使用此参数。' },
      { name:'n', type:'integer', required:false, default:1, min:1, max:10, description:'生成张数，每张单独计费。' },
      image,
    ], aspect_ratios:Object.keys(GPT_IMAGE_25_DIMENSIONS) };
  }
  if (model.id === MIDJOURNEY) {
    return { ...base, parameters:[
      prompt,
      { name:'size', type:'string', required:false, default:'1:1', values:imageAspectRatios, description:'画幅比例。' },
      { name:'n', type:'integer', required:false, default:4, values:[4, 8], description:'生成张数，需为 4 的倍数。每 4 张为一组，按组计费。' },
      { name:'version', type:'string', required:false, default:'8.2', values:MIDJOURNEY_VERSIONS, description:'Midjourney 版本。' },
      { name:'quality', type:'string', required:false, default:'1', values:MIDJOURNEY_QUALITIES, description:'Midjourney 质量参数。' },
      { name:'stylize', type:'integer', required:false, default:100, min:0, max:1000, description:'风格化程度。' },
      { name:'chaos', type:'integer', required:false, default:0, min:0, max:100, description:'多样性。' },
      { name:'weird', type:'integer', required:false, default:0, min:0, max:3000, description:'奇异度。' },
      { name:'seed', type:'integer', required:false, min:0, max:4294967295, description:'随机种子。' },
      { name:'negative_prompt', type:'string', required:false, description:'不希望出现的内容，最多 500 个字符。' },
      { name:'image_weight', type:'number', required:false, default:1, min:0, max:3, description:'参考图权重，仅在提供参考图时生效。' },
      { name:'tile', type:'boolean', required:false, default:false, description:'生成可平铺图案。' },
      { name:'raw', type:'boolean', required:false, default:false, description:'使用 Raw 风格。' },
      { name:'draft', type:'boolean', required:false, default:false, description:'草稿模式。' },
      image,
    ] };
  }
  return { ...base, parameters:[
    prompt,
    { name:'size', type:'string', required:false, default:'1:1', values:[...imageAspectRatios, ...Object.keys(OPENAI_IMAGE_SIZE_RATIOS)], description:'画幅比例；也接受 1024x1024、1536x1024、1024x1536 和 auto。' },
    { name:'quality', type:'string', required:false, default:'medium', values:['low', 'medium', 'high'], description:'画面质量。' },
    { name:'n', type:'integer', required:false, default:1, min:1, max:10, description:'生成张数，每张单独计费。' },
    image,
  ] };
}

function videoModeEntry(mode) {
  const name = MODE_NAMES[mode.generationType] || String(mode.generationType || '').toLowerCase();
  const qualities = mode.qualityOptions || [];
  const aspectRatios = mode.aspectRatios || [];
  const sizes = qualities.flatMap(quality => aspectRatios.map(aspectRatio => ({ size:videoDimensions(aspectRatio, quality), aspect_ratio:aspectRatio, resolution:quality }))).filter(item => item.size);
  const limits = mode.referenceLimits || { image:mode.maxImages || 0, video:0, audio:0, total:mode.maxImages || 0 };
  const durationsByResolution = mode.durationsByQuality
    ? Object.fromEntries(Object.entries(mode.durationsByQuality).filter(([quality]) => qualities.includes(quality))
      .map(([quality, byRatio]) => [quality, uniqueSorted(Object.values(byRatio || {}).flat())]))
    : null;
  return {
    mode:name,
    label:MODE_LABELS[name] || name,
    seconds:uniqueSorted(mode.durations || []),
    ...(durationsByResolution ? { seconds_by_resolution:durationsByResolution } : {}),
    aspect_ratios:aspectRatios,
    resolutions:qualities,
    sizes,
    references:name === 'text' ? { image:0, video:0, audio:0, total:0, min:0 }
      : name === 'first_last' ? { image:Math.min(2, mode.maxImages || 2), video:0, audio:0, total:Math.min(2, mode.maxImages || 2), min:1 }
        : { image:Number(limits.image || 0), video:Number(limits.video || 0), audio:Number(limits.audio || 0), total:Number(limits.total || 0), min:Math.max(1, Number(mode.minImages || 1)) },
  };
}

function videoModelEntry(model, prices) {
  const modes = (model.modes || []).map(videoModeEntry).filter(mode => mode.seconds.length && mode.resolutions.length && mode.aspect_ratios.length);
  if (!modes.length) return null;
  const allSizes = unique(modes.flatMap(mode => mode.sizes.map(item => item.size)));
  const allSeconds = uniqueSorted(modes.flatMap(mode => mode.seconds));
  const textMode = modes.find(mode => mode.mode === 'text') || modes[0];
  const defaultSize = textMode.sizes.find(item => item.aspect_ratio === '16:9' && item.resolution === '720p')?.size
    || textMode.sizes.find(item => item.aspect_ratio === '16:9')?.size || textMode.sizes[0]?.size || '';
  return {
    id:model.id,
    object:'model',
    created:API_MODEL_CREATED,
    owned_by:'gugu-ai',
    type:'video',
    name:model.label,
    description:model.description || '',
    endpoints:['/v1/videos'],
    modes,
    pricing:priceRows(prices, model.id),
    parameters:[
      { name:'prompt', type:'string', required:true, description:'视频画面描述。' },
      { name:'seconds', type:'string | integer', required:false, default:String(textMode.seconds[0]), values:allSeconds.map(String), description:'视频时长（秒），可选值以所选模式和清晰度为准。' },
      { name:'size', type:'string', required:false, default:defaultSize, values:allSizes, description:'输出尺寸，决定画幅比例和清晰度。也可以改用 aspect_ratio 和 resolution 两个参数。' },
      { name:'aspect_ratio', type:'string', required:false, values:unique(modes.flatMap(mode => mode.aspect_ratios)), description:'画幅比例，与 size 二选一。' },
      { name:'resolution', type:'string', required:false, values:unique(modes.flatMap(mode => mode.resolutions)), description:'清晰度，与 size 二选一。' },
      { name:'mode', type:'string', required:false, values:modes.map(mode => mode.mode), description:'生成方式。不传时：没有参考素材为 text，有参考素材为 reference。' },
      { name:'input_reference', type:'file | string | array', required:false, description:'参考图片。支持文件上传、https 链接或 data URL；首尾帧模式下按顺序作为首帧和尾帧。' },
      ...(modes.some(mode => mode.references.video) ? [{ name:'reference_videos', type:'array', required:false, description:'参考视频链接（https 或 data URL），MP4、WebM 或 MOV，单个不超过 25 MB。' }] : []),
      ...(modes.some(mode => mode.references.audio) ? [{ name:'reference_audios', type:'array', required:false, description:'参考音频链接（https 或 data URL），MP3、WAV、M4A 等，单个不超过 25 MB。' }] : []),
    ],
  };
}

/**
 * Builds the public catalog from live configuration.
 * @param {{ imageModels:Array, videoModels:Array, prices:Array, imageAspectRatios:string[] }} source
 */
export function buildApiModelCatalog({ imageModels = [], videoModels = [], prices = [], imageAspectRatios = [] } = {}) {
  const images = imageModels.map(model => imageModelEntry(model, prices, imageAspectRatios));
  const videos = videoModels.filter(model => model.enabled !== false && model.availability !== 'coming-soon')
    .map(model => videoModelEntry(model, prices)).filter(Boolean);
  return [...images, ...videos];
}

export function publicModelObject(model) {
  return { id:model.id, object:'model', created:model.created, owned_by:model.owned_by, type:model.type, name:model.name };
}

const hasValue = value => value !== undefined && value !== null && String(value).trim() !== '';

function integerParam(body, name, { fallback, min, max }) {
  if (!hasValue(body[name])) return fallback;
  const value = Number(body[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw apiParamError(`${name} 需为 ${min}–${max} 的整数`, name);
  return value;
}

function booleanParam(body, name) {
  const value = body[name];
  if (!hasValue(value)) return false;
  if (typeof value === 'boolean') return value;
  if (['true', '1'].includes(String(value).toLowerCase())) return true;
  if (['false', '0'].includes(String(value).toLowerCase())) return false;
  throw apiParamError(`${name} 需为 true 或 false`, name);
}

function promptParam(body, maxLength) {
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) throw apiParamError('请提供 prompt', 'prompt');
  if (Array.from(prompt).length > maxLength) throw apiParamError(`prompt 不能超过 ${maxLength} 个字符`, 'prompt');
  return prompt;
}

/** Maps an images request onto the internal generation input (without references). */
export function normalizeImageRequest(model, body, { referenceCount = 0 } = {}) {
  const prompt = promptParam(body, 5000);
  if (referenceCount > IMAGE_REFERENCE_LIMIT) throw apiParamError(`参考图最多 ${IMAGE_REFERENCE_LIMIT} 张`, 'image');
  if (model.id === GPT_IMAGE_25) {
    const rawSize = hasValue(body.size) ? String(body.size).trim().toLowerCase() : '';
    const rawQuality = hasValue(body.quality) ? String(body.quality).trim().toLowerCase() : '';
    if (rawQuality && !['1k', '2k', '4k'].includes(rawQuality)) throw apiParamError('quality 可选 1k、2k、4k', 'quality');
    let size = '1024x1024';
    let quality = rawQuality || '1k';
    if (rawSize === 'auto') size = 'auto';
    else if (GPT_IMAGE_25_DIMENSIONS[rawSize]) size = GPT_IMAGE_25_DIMENSIONS[rawSize][quality];
    else if (rawSize) {
      const match = Object.values(GPT_IMAGE_25_DIMENSIONS).flatMap(tiers => Object.entries(tiers)).find(([, value]) => value === rawSize);
      if (!match) throw apiParamError('不支持的 size，请在模型参数说明中选择可用尺寸', 'size');
      if (rawQuality && rawQuality !== match[0]) throw apiParamError(`size ${rawSize} 对应 ${match[0]} 清晰度，与 quality 不一致`, 'quality');
      size = rawSize;
      quality = match[0];
    } else size = GPT_IMAGE_25_DIMENSIONS['1:1'][quality];
    const quantity = integerParam(body, 'n', { fallback:1, min:1, max:10 });
    return { input:{ type:'image', modelId:model.id, prompt, size, quality, quantity }, params:{ size, quality, n:quantity } };
  }
  if (model.id === MIDJOURNEY) {
    const aspectRatio = hasValue(body.size) ? String(body.size).trim() : '1:1';
    const ratios = model.parameters.find(item => item.name === 'size')?.values || [];
    if (!ratios.includes(aspectRatio)) throw apiParamError('不支持的 size，请传入画幅比例，如 1:1、16:9', 'size');
    const quantity = integerParam(body, 'n', { fallback:4, min:4, max:8 });
    if (quantity % 4 !== 0) throw apiParamError('Midjourney 的 n 需为 4 或 8', 'n');
    const version = hasValue(body.version) ? String(body.version).trim() : '8.2';
    if (!MIDJOURNEY_VERSIONS.includes(version)) throw apiParamError(`version 可选 ${MIDJOURNEY_VERSIONS.join('、')}`, 'version');
    const quality = hasValue(body.quality) ? String(body.quality).trim() : '1';
    if (!MIDJOURNEY_QUALITIES.includes(quality)) throw apiParamError(`quality 可选 ${MIDJOURNEY_QUALITIES.join('、')}`, 'quality');
    const negativePrompt = hasValue(body.negative_prompt) ? String(body.negative_prompt) : '';
    if (Array.from(negativePrompt).length > 500) throw apiParamError('negative_prompt 不能超过 500 个字符', 'negative_prompt');
    const imageWeight = hasValue(body.image_weight) ? Number(body.image_weight) : 1;
    if (!Number.isFinite(imageWeight) || imageWeight < 0 || imageWeight > 3) throw apiParamError('image_weight 需为 0–3 的数字', 'image_weight');
    const midjourneyOptions = {
      aspectRatio, version, quality,
      stylize:integerParam(body, 'stylize', { fallback:100, min:0, max:1000 }),
      chaos:integerParam(body, 'chaos', { fallback:0, min:0, max:100 }),
      weird:integerParam(body, 'weird', { fallback:0, min:0, max:3000 }),
      seed:integerParam(body, 'seed', { fallback:'', min:0, max:4_294_967_295 }),
      negativePrompt, imageWeight,
      tile:booleanParam(body, 'tile'), raw:booleanParam(body, 'raw'), draft:booleanParam(body, 'draft'),
    };
    return { input:{ type:'image', modelId:model.id, prompt, quantity, midjourneyOptions }, params:{ size:aspectRatio, n:quantity, version, quality } };
  }
  const rawSize = hasValue(body.size) ? String(body.size).trim().toLowerCase() : '1:1';
  const ratios = model.parameters.find(item => item.name === 'size')?.values || [];
  if (!ratios.includes(rawSize)) throw apiParamError('不支持的 size，请传入画幅比例，如 1:1、16:9', 'size');
  const size = OPENAI_IMAGE_SIZE_RATIOS[rawSize] || rawSize;
  const quality = hasValue(body.quality) ? String(body.quality).trim().toLowerCase() : 'medium';
  if (!['low', 'medium', 'high'].includes(quality)) throw apiParamError('quality 可选 low、medium、high', 'quality');
  const quantity = integerParam(body, 'n', { fallback:1, min:1, max:10 });
  return { input:{ type:'image', modelId:model.id, prompt, size, quality, quantity }, params:{ size, quality, n:quantity } };
}

/** Maps a videos request onto the internal generation input (without references). */
export function normalizeVideoRequest(model, body, { referenceCounts = { image:0, video:0, audio:0 } } = {}) {
  const prompt = promptParam(body, 10000);
  const referenceTotal = referenceCounts.image + referenceCounts.video + referenceCounts.audio;
  const requestedMode = hasValue(body.mode) ? String(body.mode).trim().toLowerCase() : (referenceTotal ? 'reference' : 'text');
  const mode = model.modes.find(item => item.mode === requestedMode);
  if (!mode) throw apiParamError(`${model.name} 支持的 mode：${model.modes.map(item => item.mode).join('、')}`, 'mode');
  if (mode.mode === 'text' && referenceTotal) throw apiParamError('text 模式不能添加参考素材，请设置 mode 为 reference', 'mode');
  if (mode.mode !== 'text' && referenceTotal < mode.references.min) throw apiParamError(`${mode.label}至少需要 ${mode.references.min} 个参考素材`, 'input_reference');
  for (const kind of ['image', 'video', 'audio']) {
    if (referenceCounts[kind] > mode.references[kind]) {
      const param = kind === 'image' ? 'input_reference' : `reference_${kind}s`;
      throw apiParamError(`${mode.label}最多支持 ${mode.references[kind]} 个参考${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}`, param);
    }
  }
  if (mode.mode !== 'text' && referenceTotal > mode.references.total) throw apiParamError(`${mode.label}最多支持 ${mode.references.total} 个参考素材`, 'input_reference');

  let aspectRatio = hasValue(body.aspect_ratio) ? String(body.aspect_ratio).trim() : '';
  let resolution = hasValue(body.resolution) ? String(body.resolution).trim().toLowerCase() : '';
  if (hasValue(body.size)) {
    const size = String(body.size).trim().toLowerCase();
    const match = mode.sizes.find(item => item.size === size);
    if (!match) throw apiParamError(`不支持的 size，${mode.label}可选：${mode.sizes.map(item => item.size).join('、')}`, 'size');
    if (aspectRatio && aspectRatio !== match.aspect_ratio) throw apiParamError('size 与 aspect_ratio 不一致', 'aspect_ratio');
    if (resolution && resolution !== match.resolution) throw apiParamError('size 与 resolution 不一致', 'resolution');
    aspectRatio = match.aspect_ratio;
    resolution = match.resolution;
  }
  if (!aspectRatio) aspectRatio = mode.aspect_ratios.includes('16:9') ? '16:9' : mode.aspect_ratios[0];
  if (!resolution) resolution = mode.resolutions.includes('720p') ? '720p' : mode.resolutions[0];
  if (!mode.aspect_ratios.includes(aspectRatio)) throw apiParamError(`aspect_ratio 可选：${mode.aspect_ratios.join('、')}`, 'aspect_ratio');
  if (!mode.resolutions.includes(resolution)) throw apiParamError(`resolution 可选：${mode.resolutions.join('、')}`, 'resolution');
  const allowedSeconds = mode.seconds_by_resolution?.[resolution]?.length ? mode.seconds_by_resolution[resolution] : mode.seconds;
  const seconds = hasValue(body.seconds) ? Number(body.seconds) : allowedSeconds[0];
  if (!Number.isSafeInteger(seconds) || !allowedSeconds.includes(seconds)) throw apiParamError(`seconds 可选：${allowedSeconds.join('、')}`, 'seconds');
  const generationType = Object.entries(MODE_NAMES).find(([, value]) => value === mode.mode)?.[0] || 'TEXT';
  return {
    input:{ type:'video', modelId:model.id, prompt, duration:seconds, aspectRatio, quality:resolution, generationType },
    params:{ seconds:String(seconds), size:videoDimensions(aspectRatio, resolution), aspect_ratio:aspectRatio, resolution, mode:mode.mode },
  };
}
