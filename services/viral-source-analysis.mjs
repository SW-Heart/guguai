import { createHash } from 'node:crypto';

export const SOURCE_ANALYSIS_VERSION = '1.0.0';
export const SOURCE_ANALYSIS_SCHEMA_VERSION = 1;

const speakerModes = new Set(['in_frame_sync', 'voiceover', 'dialogue', 'music_only', 'silent', 'uncertain']);
const storyFunctions = new Set(['hook', 'problem', 'demonstration', 'proof', 'benefit', 'transition', 'cta', 'other']);

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function boundedText(value, max = 2_000) {
  return String(value ?? '').trim().slice(0, max);
}

export function sourceAnalysisFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeSourceObservation(candidate = {}, { sourceHash = '', durationSeconds = 0 } = {}) {
  candidate = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const rawTimeline = Array.isArray(candidate.timeline) ? candidate.timeline : [];
  const timeline = rawTimeline.map((rawItem, index) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const start = Math.max(0, number(item.start_seconds ?? item.startSeconds ?? item.start));
    const end = Math.max(start, number(item.end_seconds ?? item.endSeconds ?? item.end, start));
    return {
      id: boundedText(item.id || `beat-${String(index + 1).padStart(2, '0')}`, 80),
      startSeconds: start,
      endSeconds: end,
      shotType: boundedText(item.shot_type ?? item.shotType, 160),
      visualAction: boundedText(item.visual_action ?? item.visualAction, 2_000),
      visibleRoles: Array.isArray(item.visible_roles ?? item.visibleRoles) ? (item.visible_roles ?? item.visibleRoles).map(value => boundedText(value, 120)).filter(Boolean).slice(0, 12) : [],
      expressionAndGaze: boundedText(item.expression_and_gaze ?? item.expressionAndGaze, 500),
      spokenContent: boundedText(item.spoken_content ?? item.spokenContent, 1_000),
      speakerMode: speakerModes.has(item.speaker_mode ?? item.speakerMode) ? (item.speaker_mode ?? item.speakerMode) : 'uncertain',
      visibleText: Array.isArray(item.visible_text ?? item.visibleText) ? (item.visible_text ?? item.visibleText).map(value => boundedText(value, 240)).filter(Boolean).slice(0, 20) : [],
      storyFunction: storyFunctions.has(item.story_function ?? item.storyFunction) ? (item.story_function ?? item.storyFunction) : 'other',
      confidence: Math.min(1, Math.max(0, number(item.confidence, 0))),
      evidenceFrames: Array.isArray(item.evidence_frames ?? item.evidenceFrames) ? (item.evidence_frames ?? item.evidenceFrames).map(value => boundedText(value, 300)).filter(Boolean).slice(0, 8) : [],
    };
  }).filter(item => item.endSeconds > item.startSeconds || item.visualAction || item.spokenContent);
  timeline.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  const normalizedDuration = Math.max(number(durationSeconds), ...timeline.map(item => item.endSeconds), 0);
  const usedIds = new Set();
  for (const item of timeline) {
    const originalId = item.id;
    let id = originalId; let suffix = 2;
    while (usedIds.has(id)) id = `${originalId}-${suffix++}`;
    item.id = id; usedIds.add(id);
  }
  const coveredTimeline = [];
  let cursor = 0; let gapIndex = 1;
  for (const item of timeline) {
    if (item.startSeconds > cursor + 0.05) coveredTimeline.push({ id:`uncertain-gap-${gapIndex++}`, startSeconds:cursor, endSeconds:item.startSeconds, shotType:'uncertain', visualAction:'这段画面未能确认', visibleRoles:[], expressionAndGaze:'', spokenContent:'', speakerMode:'uncertain', visibleText:[], storyFunction:'other', confidence:0, evidenceFrames:[] });
    coveredTimeline.push(item);
    cursor = Math.max(cursor, item.endSeconds);
  }
  if (normalizedDuration > cursor + 0.05) coveredTimeline.push({ id:`uncertain-gap-${gapIndex}`, startSeconds:cursor, endSeconds:normalizedDuration, shotType:'uncertain', visualAction:'这段画面未能确认', visibleRoles:[], expressionAndGaze:'', spokenContent:'', speakerMode:'uncertain', visibleText:[], storyFunction:'other', confidence:0, evidenceFrames:[] });
  const hardCuts = (Array.isArray(candidate.hard_cuts ?? candidate.hardCuts) ? (candidate.hard_cuts ?? candidate.hardCuts) : [])
    .map(value => Math.max(0, number(value))).filter((value, index, all) => all.indexOf(value) === index).sort((a, b) => a - b);
  return {
    schemaVersion: SOURCE_ANALYSIS_SCHEMA_VERSION,
    analysisVersion: SOURCE_ANALYSIS_VERSION,
    sourceHash: boundedText(sourceHash, 128),
    durationSeconds: normalizedDuration,
    summary: boundedText(candidate.summary, 1_000),
    storyStructure: Array.isArray(candidate.story_structure ?? candidate.storyStructure) ? (candidate.story_structure ?? candidate.storyStructure).map(value => boundedText(value, 300)).filter(Boolean).slice(0, 30) : [],
    peopleMode: ['single_primary', 'multi_person', 'no_person', 'uncertain'].includes(candidate.people_mode ?? candidate.peopleMode) ? (candidate.people_mode ?? candidate.peopleMode) : 'uncertain',
    characters: Array.isArray(candidate.characters) ? candidate.characters.map(rawItem => { const item = rawItem && typeof rawItem === 'object' ? rawItem : {}; return { role:boundedText(item.role, 120), genderPresentation:boundedText(item.gender_presentation ?? item.genderPresentation, 40), appearance:boundedText(item.appearance, 500) }; }).filter(item => item.role).slice(0, 20) : [],
    productsAndProps: Array.isArray(candidate.products_and_props ?? candidate.productsAndProps) ? (candidate.products_and_props ?? candidate.productsAndProps).map(rawItem => { const item = rawItem && typeof rawItem === 'object' ? rawItem : {}; return { nameOrDescription:boundedText(item.name_or_description ?? item.nameOrDescription, 300), visibleText:Array.isArray(item.visible_text ?? item.visibleText) ? (item.visible_text ?? item.visibleText).map(value => boundedText(value, 160)).filter(Boolean).slice(0, 20) : [], usageActions:Array.isArray(item.usage_actions ?? item.usageActions) ? (item.usage_actions ?? item.usageActions).map(value => boundedText(value, 300)).filter(Boolean).slice(0, 20) : [] }; }).filter(item => item.nameOrDescription).slice(0, 30) : [],
    hardCuts,
    actionPeaks: Array.isArray(candidate.action_peaks ?? candidate.actionPeaks) ? (candidate.action_peaks ?? candidate.actionPeaks).map(rawItem => { const item = rawItem && typeof rawItem === 'object' ? rawItem : {}; return { timeSeconds:Math.max(0, number(item.time_seconds ?? item.timeSeconds)), description:boundedText(item.description, 500) }; }).filter(item => item.description).slice(0, 40) : [],
    audioSummary: { speechStyle:boundedText(candidate.audio_summary?.speech_style ?? candidate.audioSummary?.speechStyle, 600), musicAndSfx:boundedText(candidate.audio_summary?.music_and_sfx ?? candidate.audioSummary?.musicAndSfx, 600) },
    asrText: boundedText(candidate.asr_text ?? candidate.asrText, 20_000),
    uncertainties: Array.isArray(candidate.uncertainties) ? candidate.uncertainties.map(value => boundedText(value, 500)).filter(Boolean).slice(0, 40) : [],
    timeline:coveredTimeline,
  };
}

export const sourceAnalysisSystemPrompt = `你是爆款视频复刻项目的原片理解器。只描述输入视频中实际看见或听见的内容，不补写不存在的台词、产品事实或动作。按真实硬切、动作和说话人变化拆分时间线，保留原话和声音模式。每个时间段写入能证明判断的帧时间或画面线索。只输出 JSON，不要 Markdown：{"summary":"","story_structure":[],"people_mode":"single_primary|multi_person|no_person|uncertain","timeline":[{"start_seconds":0,"end_seconds":1,"shot_type":"","visual_action":"","visible_roles":[],"expression_and_gaze":"","spoken_content":"","speaker_mode":"in_frame_sync|voiceover|dialogue|music_only|silent|uncertain","visible_text":[],"story_function":"hook|problem|demonstration|proof|benefit|transition|cta|other","confidence":0,"evidence_frames":[]}],"characters":[],"products_and_props":[],"hard_cuts":[],"action_peaks":[],"audio_summary":{"speech_style":"","music_and_sfx":""},"asr_text":"","uncertainties":[]}. timeline 必须从视频开头覆盖到结尾，时间递增；不确定内容写入 uncertainties。若未能听清台词，spoken_content 留空并标记 speaker_mode 为 uncertain，不要猜写。`;

export function buildSourceAnalysisPrompt({ productName = '', brief = '' } = {}) {
  const context = [productName && `当前商品：${boundedText(productName, 120)}`, brief && `用户要求：${boundedText(brief, 1_000)}`].filter(Boolean).join('\n');
  return `${context ? `${context}\n\n` : ''}请分析随请求附带的参考视频，输出完整原片观察结果。只保留源片事实，当前商品和用户要求仅作为后续复刻背景，不要把它们写进源片事实。`;
}

export function splitSourceTimeline(observation, { modelId = 'seedance-2.5', materials = [] } = {}) {
  const duration = modelId === 'seedance-2.0' ? 15 : 30;
  const sourceTotal = Math.max(number(observation?.durationSeconds), ...((observation?.timeline || []).map(item => item.endSeconds)), 0);
  const total = Math.max(sourceTotal, duration);
  const count = Math.max(1, Math.ceil(total / duration));
  const defaultRefs = materials.filter(item => item.role !== 'audio').map(item => item.assetId);
  return Array.from({ length:count }, (_, index) => {
    const start = index * duration;
    const end = Math.min(sourceTotal || duration, (index + 1) * duration);
    const spans = (observation?.timeline || []).filter(item => item.endSeconds > start && item.startSeconds < end).map(item => item.id);
    return {
      id: `part-${String(index + 1).padStart(2, '0')}`,
      title: `第 ${index + 1} 段`,
      modelId,
      duration,
      aspectRatio: '9:16',
      quality: '720p',
      prompt: '',
      referenceAssetIds: [...defaultRefs],
      sourceRange: { startSeconds:start, endSeconds:end },
      timelineSpanIds: spans,
      promptHash: '',
    };
  });
}

function formatTime(value) { return Number(value).toFixed(3); }

export function compileReplicaPrompt(project, observation, unit) {
  const range = unit.sourceRange || { startSeconds:0, endSeconds:observation.durationSeconds };
  const beats = (observation.timeline || []).filter(item => item.endSeconds > range.startSeconds && item.startSeconds < range.endSeconds);
  const materials = project.materials.filter(item => unit.referenceAssetIds.includes(item.assetId));
  const sourceDuty = project.sourceAssetId ? '@视频1负责原片的镜头顺序、节奏和动作参考，不复制原片中的商品身份。' : '';
  let imageIndex = 0; let audioIndex = 0;
  const duties = materials.map(item => {
    const mention = item.role === 'audio' ? `@音频${++audioIndex}` : `@图片${++imageIndex}`;
    return item.role === 'audio'
      ? `${mention}负责${item.label || '声音素材'}的声音节奏与音色参考。`
      : `${mention}负责${item.label || item.role || '当前素材'}的外观与身份，场景、镜头和动作以原片观察为准。`;
  }).join('\n');
  const events = beats.length ? beats.map((beat, index) => {
    const speech = beat.spokenContent ? ` ${beat.speakerMode === 'voiceover' ? '画外音' : '人物口播'}：{${beat.spokenContent}}` : '';
    return `阶段${index + 1}（${formatTime(Math.max(range.startSeconds, beat.startSeconds))}–${formatTime(Math.min(range.endSeconds, beat.endSeconds))}秒）：${beat.visualAction || '按原片保持画面与动作。'}${speech}`;
  }).join('\n') : `阶段一（${formatTime(range.startSeconds)}–${formatTime(range.endSeconds)}秒）：按参考视频保持原片节奏与镜头。`;
  const sourceSpan = Math.max(0, range.endSeconds - range.startSeconds);
  const tail = sourceSpan + 0.01 < unit.duration ? `\n输出补足：源片观察到 ${formatTime(sourceSpan)} 秒；剩余时间延续最后一个画面状态和声音落点，不新增台词或动作。` : '';
  if (unit.modelId === 'seedance-2.0') {
    return `【参考素材职责】\n${[sourceDuty, duties].filter(Boolean).join('\n') || '只使用已确认的项目素材。'}\n当前商品：${project.productName || '用户提供的商品'}。\n\n【时间与 Shot 执行块】\n${events}${tail}\n\n【保持一致】\n保持原片镜头顺序、场景、人物关系、动作阶段、硬切、声音模式和产品出现位置；仅替换用户明确指定的商品内容。`;
  }
  return `【生成目标】\n制作一段${unit.duration}秒的爆款视频复刻，保留参考片的镜头、节奏、动作和原话，仅将商品替换为当前已确认素材。\n\n【参考素材职责】\n${[sourceDuty, duties].filter(Boolean).join('\n') || '只使用已确认的项目素材。'}\n\n【主体与道具】\n保持原片人物数量、角色关系、产品出现次数和状态变化；当前商品名称为${project.productName || '用户提供的商品'}。\n\n【事件脚本】\n${events}${tail}\n\n【保持一致】\n保持原片镜头顺序、场景、机位、构图、动作落点、硬切、说话关系和声音节奏稳定。`;
}

export function normalizeReplicaPlan(project, observation, parsed = {}) {
  const candidateUnits = Array.isArray(parsed.units) && parsed.units.length ? parsed.units : splitSourceTimeline(observation, { modelId:project.units?.[0]?.modelId || 'seedance-2.5', materials:project.materials });
  return candidateUnits.map((candidate, index) => {
    const original = project.units?.[index] || splitSourceTimeline(observation, { modelId:project.units?.[0]?.modelId || 'seedance-2.5', materials:project.materials })[index];
    const unit = { ...original, ...candidate, id:original?.id || candidate.id || `part-${String(index + 1).padStart(2, '0')}` };
    unit.modelId = unit.modelId === 'seedance-2.0' ? 'seedance-2.0' : 'seedance-2.5';
    unit.duration = unit.modelId === 'seedance-2.0' ? 15 : 30;
    unit.aspectRatio = ['9:16', '16:9', '1:1'].includes(unit.aspectRatio) ? unit.aspectRatio : '9:16';
    unit.quality = unit.quality === '480p' ? '480p' : '720p';
    unit.sourceRange = unit.sourceRange || original?.sourceRange;
    unit.timelineSpanIds = Array.isArray(unit.timelineSpanIds) ? unit.timelineSpanIds : (original?.timelineSpanIds || []);
    unit.referenceAssetIds = Array.isArray(unit.referenceAssetIds) ? unit.referenceAssetIds.map(String).filter(id => project.materials.some(item => item.assetId === id)) : [...(original?.referenceAssetIds || [])];
    unit.prompt = boundedText(unit.prompt || compileReplicaPrompt(project, observation, unit), 30_000);
    unit.promptHash = unit.promptHash || sourceAnalysisFingerprint({ compiler:SOURCE_ANALYSIS_VERSION, prompt:unit.prompt, sourceRange:unit.sourceRange || null, timelineSpanIds:unit.timelineSpanIds || [] });
    return unit;
  });
}
