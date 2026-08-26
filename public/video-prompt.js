const clean = value => String(value || '').trim();
const clip = (value, limit) => Array.from(clean(value)).slice(0, limit).join('');

const typeName = type => ({ character:'角色', location:'场景', prop:'物品' }[type] || '资源');

function normalizeVisualDetail(value, aspectRatio) {
  const ratio = clean(aspectRatio) || '9:16';
  let result = clean(value).replace(/\b(?:16:9|9:16|1:1|2:3|3:2)\b/g, ratio);
  if (ratio === '16:9') result = result.replace(/\b(?:vertical|portrait)\b/gi, 'horizontal widescreen').replace(/竖屏/g, '横屏');
  if (ratio === '9:16') result = result.replace(/\b(?:horizontal|landscape|widescreen)\b/gi, 'vertical portrait').replace(/横屏/g, '竖屏');
  return result;
}

function resourceLine(resource) {
  const bible = resource?.bible || {};
  return [
    `${typeName(resource?.type)}「${clean(resource?.name)}」`,
    clean(resource?.description),
    clean(bible.identity),
    clean(bible.appearance),
    clean(bible.costume),
    clean(bible.stateNotes),
  ].filter(Boolean).join('；');
}

function productionResourceLine(resource, mode) {
  const bible = resource?.bible || {};
  const identity = clean(bible.identity || resource?.description);
  const visible = [clean(bible.appearance), clean(bible.costume)].filter(Boolean).join('；');
  const state = clean(bible.stateNotes);
  if (mode === 'FIRST&LAST') return `${typeName(resource?.type)}「${clean(resource?.name)}」：身份与状态保持一致${state ? `；${state}` : ''}`;
  return [`${typeName(resource?.type)}「${clean(resource?.name)}」`, identity, visible, state].filter(Boolean).join('；');
}

function sourceBeatLines(scene, shot) {
  const wanted = new Set(Array.isArray(shot?.sourceBeatIds) ? shot.sourceBeatIds : []);
  return (scene?.beats || []).filter(beat => wanted.has(beat.id)).map(beat => {
    if (beat.kind === 'dialogue') return `[${beat.id}] ${clean(beat.speaker) || '角色'}${beat.delivery ? `（${clean(beat.delivery)}）` : ''}：「${clean(beat.text)}」`;
    return `[${beat.id}] 动作：${clean(beat.text)}`;
  });
}

function safeVisualDirection(shot, workflowVersion) {
  if (Number(workflowVersion) < 2) return '';
  const source = clean(shot?.visualDirection);
  return source.split(/[。；;\n]+/).map(clean).filter(part => part && !/(?:切到|切回|再切|转场|画面切|镜头切|cut\s+to|montage)/i.test(part)).join('；');
}

function scopedSceneDetail(value, project, resources) {
  const selected = new Set(resources.map(resource => clean(resource?.name)).filter(Boolean));
  const excludedNames = (project?.resources || []).map(resource => clean(resource?.name)).filter(name => name && !selected.has(name));
  return clean(value).split(/[；;\n]+/).map(clean).filter(part => part && !excludedNames.some(name => part.includes(name))).join('；');
}

const second = value => Number(value).toFixed(Number(value) % 1 ? 1 : 0);

function fallbackMotionPlan(shot) {
  const duration = Math.max(1, Number(shot?.duration) || 6);
  const hold = Math.min(0.5, duration / 6);
  const actionStart = hold;
  const actionEnd = duration - hold;
  const span = Math.max(0, actionEnd - actionStart);
  const count = Math.max(1, Math.ceil(span / 1.5));
  const action = clean(shot?.action || shot?.script) || '主体完成当前动作';
  const actionParts = action.split(/[，,；;。]+/).map(clean).filter(Boolean);
  const cameraParts = clean(shot?.cameraMovement).split(/[，,；;。]+/).map(clean).filter(Boolean);
  const cameraDestination = (cameraParts.at(-1)||'当前构图').replace(/^从.+?(?:推至|移至|摇至|跟至|到)/, '');
  const stages = [];
  for (let index = 0; index < count; index++) {
    const startSecond = actionStart + span * index / count;
    const endSecond = actionStart + span * (index + 1) / count;
    const subjectMotion = index < actionParts.length ? actionParts[index] : `完成${actionParts.at(-1)||action}，身体逐渐减速`;
    const cameraMotion = index === 0
      ? `开始${cameraParts[0]||'固定镜头'}`
      : index === count - 1
        ? `减速并停在${cameraDestination}`
        : `持续同方向${cameraParts[0]||'保持固定'}，不复位`;
    stages.push({startSecond,endSecond,subjectMotion,cameraMotion,amplitude:index < actionParts.length ? '中' : '小',speed:index === count - 1 ? '慢' : '中'});
  }
  return [
    {startSecond:0,endSecond:hold,subjectMotion:`保持首帧：${clean(shot?.startState)||'保持初始姿态'}`,cameraMotion:'摄影机静止',amplitude:'静止',speed:'静止'},
    ...stages,
    {startSecond:actionEnd,endSecond:duration,subjectMotion:`动作停住，定格尾帧：${clean(shot?.endState)||'保持结束姿态'}`,cameraMotion:'摄影机停止并锁定构图',amplitude:'静止',speed:'静止'},
  ].filter(item => item.endSecond - item.startSecond > 0.01);
}

function promptMotionPlan(shot, workflowVersion) {
  const supplied = Number(workflowVersion) >= 3 && Array.isArray(shot?.motionPlan) && shot.motionPlan.length ? shot.motionPlan : null;
  return supplied || fallbackMotionPlan(shot);
}

function dialogueLines(scene, shot) {
  const wanted = new Set(Array.isArray(shot?.sourceBeatIds) ? shot.sourceBeatIds : []);
  const structured = (scene?.beats || []).filter(beat => wanted.has(beat.id) && beat.kind === 'dialogue').map(beat => `${clean(beat.speaker)||'角色'}${beat.delivery?`（${clean(beat.delivery)}）`:''}：“${clean(beat.text)}”`);
  if (structured.length) return structured;
  const legacy = clean(shot?.script).match(/(?:道|说|喊|问|答|自语)[：:]\s*([^\n]+)/);
  return legacy ? [`“${legacy[1].trim()}”`] : [];
}

function compactResource(resource, mode) {
  const bible = resource?.bible || {};
  if (mode !== 'TEXT') return `${typeName(resource?.type)}「${clean(resource?.name)}」`;
  return [`${typeName(resource?.type)}「${clean(resource?.name)}」`,clean(bible.appearance||resource?.description),clean(bible.costume),clean(bible.stateNotes)].filter(Boolean).join('；');
}

const mentionToken = mention => `@${String(mention?.label || '').replace(/^@/, '').trim()}`;
const mentionPrefix = kind => ({ image:'Image', video:'Video', audio:'Audio' }[kind] || 'Image');

export function replaceAssetMentions(text, mentions = []) {
  const source = clean(text);
  const list = (Array.isArray(mentions) ? mentions : [])
    .map(item => ({ id:String(item?.id || ''), label:String(item?.label || '').replace(/^@/, '').trim(), kind:['image','video','audio'].includes(item?.kind) ? item.kind : 'image' }))
    .filter(item => item.id && item.label);
  if (!source || !list.length) return source;
  const counters = { image:0, video:0, audio:0 };
  const replacements = new Map();
  list.forEach(mention => { if (!replacements.has(mention.id)) { counters[mention.kind] += 1; replacements.set(mention.id, `${mentionPrefix(mention.kind)}${counters[mention.kind]}`); } });
  const pattern = new RegExp([...list].sort((a,b) => mentionToken(b).length - mentionToken(a).length).map(item => mentionToken(item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return source.replace(pattern, token => {
    const mention = list.find(item => mentionToken(item) === token);
    if (!mention) return token;
    return replacements.get(mention.id);
  });
}

function compileShotText(shot) {
  const compiled = { ...(shot || {}) };
  for (const key of ['script','prompt','visualDirection','action','startState','endState','framing','continuityNotes','sound','negativePrompt']) {
    if (typeof compiled[key] === 'string') compiled[key] = replaceAssetMentions(compiled[key], shot?.assetMentions);
  }
  return compiled;
}

export function buildShotVideoPrompt({ project, shot, scene, resources = [] }) {
  const manualOverride = clean(shot?.promptOverride);
  if (manualOverride) return clip(replaceAssetMentions(manualOverride, shot?.assetMentions), 4000);
  const compiledShot = compileShotText(shot);
  const hasAssetReferences = Array.isArray(shot?.assetMentions) && shot.assetMentions.some(item => item?.id);
  const mode = compiledShot?.generation?.type === 'TEXT' && hasAssetReferences ? 'REFERENCE' : (compiledShot?.generation?.type || 'TEXT');
  const duration = Number(compiledShot?.duration) || 6;
  const timeline = promptMotionPlan(compiledShot, project?.workflowVersion);
  const dialogue = dialogueLines(scene, compiledShot);
  const visualDirection = safeVisualDirection(compiledShot, project?.workflowVersion);
  const modeLine = {
    TEXT:'文本控制；按时间轴执行，不得自由改编。',
    REFERENCE:'参考图只锁定人物、场景、物品身份；动作严格按时间轴执行。',
    'FIRST&LAST':'首帧为唯一动作起点，尾帧为唯一动作终点；只生成两帧之间的连续运动。',
  }[mode];
  const timelineLines = timeline.map(item =>
    `${second(item.startSecond)}–${second(item.endSecond)}s｜主体：${clean(item.subjectMotion)}｜幅度：${clean(item.amplitude)}｜速度：${clean(item.speed)}｜摄影机：${clean(item.cameraMotion)}`
  );
  const sceneLine = [clean(scene?.location),clean(scene?.timeOfDay),clean(scene?.lighting)].filter(Boolean).join('；');
  const sections = [
    `连续单镜头｜${duration}s｜${clean(compiledShot?.aspectRatio)||'9:16'}｜${clean(compiledShot?.shotSize)||'中景'}`,
    modeLine,
    `首帧 0.0s：${clean(compiledShot?.startState)||'保持输入首帧姿态'}${clean(compiledShot?.framing)?`；构图：${clean(compiledShot.framing)}`:''}。`,
    `运动时间轴：\n${timelineLines.join('\n')}`,
    `尾帧 ${duration.toFixed(1)}s：${clean(compiledShot?.endState)||'动作完全停止并保持结束姿态'}；最后定格，不追加动作。`,
    dialogue.length ? `对白（逐字，不增删）：\n${dialogue.join('\n')}` : '',
    visualDirection ? `必要画面约束：${normalizeVisualDetail(visualDirection,compiledShot?.aspectRatio)}` : '',
    sceneLine ? `环境锁定：${sceneLine}` : '',
    resources.length ? (mode === 'TEXT' ? `可见对象：\n${resources.map(resource=>`- ${compactResource(resource,mode)}`).join('\n')}` : `参考图锁定：${resources.map(resource=>clean(resource.name)).filter(Boolean).join('、')}；仅锁定外观身份，不引用其他场次状态。`) : '',
    clean(compiledShot?.continuityNotes) ? `本镜连续性：${clean(compiledShot.continuityNotes)}` : '',
    clean(compiledShot?.sound) ? `同步声音：${clean(compiledShot.sound)}` : '',
    Array.isArray(shot?.assetMentions)&&shot.assetMentions.length ? `素材引用已替换为模型输入占位符：${shot.assetMentions.map((item,index)=>`${mentionPrefix(item.kind)}${(shot.assetMentions.slice(0,index+1).filter(other=>other.kind===item.kind).length)}（${String(item.label||'').replace(/^@/,'')}）`).join('、')}` : '',
    `禁止：中途切镜、转场、蒙太奇、插入空镜或反应镜头；禁止新增动作和角色；禁止改写台词；${clean(compiledShot?.negativePrompt)||'禁止人物变脸、服装变化、道具消失、轴线跳变'}。`,
  ].filter(Boolean);
  return clip(sections.join('\n'), 4000);
}
