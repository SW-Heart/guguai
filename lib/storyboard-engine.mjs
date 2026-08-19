const clean = value => String(value ?? '').trim();
const cjkLength = value => Array.from(clean(value).replace(/\s+/g, '')).length;

export const STORYBOARD_ENGINE_VERSION = 3;
export const DEFAULT_STORYBOARD_RULES = Object.freeze({
  charsPerSecond: 4.5,
  actionSeconds: 2.5,
  durationTolerance: 0.35,
  maxOnScreen: 3,
});

const CUT_WORDS = /(?:切到|切回|再切|转场|画面切|镜头切|cut\s+to|cuts?\s+back|montage)/i;
const ABSTRACT_ACTION = /(?:气氛|命运|宿命|内心翻涌|充满张力|电影感|史诗感|震撼|高级感)$/;
const MOTION_AMPLITUDES = new Set(['静止','微小','小','中','大']);
const MOTION_SPEEDS = new Set(['静止','极慢','慢','中','快']);

export function estimateBeatSeconds(beat, rules = {}) {
  const policy = { ...DEFAULT_STORYBOARD_RULES, ...rules };
  if (beat?.kind === 'dialogue') return Math.max(0.5, Math.round(cjkLength(beat.text) / policy.charsPerSecond * 10) / 10);
  return policy.actionSeconds;
}

export function normalizeProductionScenes(scenes = [], rules = {}) {
  return scenes.map((scene, sceneIndex) => ({
    ...scene,
    sceneNumber: sceneIndex + 1,
    beats: (Array.isArray(scene?.beats) ? scene.beats : []).map((beat, beatIndex) => {
      const kind = beat?.kind === 'dialogue' ? 'dialogue' : 'action';
      const text = clean(beat?.text || beat?.action || beat?.line);
      return {
        id: clean(beat?.id) || `S${String(sceneIndex + 1).padStart(2, '0')}-B${String(beatIndex + 1).padStart(2, '0')}`,
        kind,
        text,
        speaker: kind === 'dialogue' ? clean(beat?.speaker) : '',
        delivery: kind === 'dialogue' ? clean(beat?.delivery) : '',
        estimatedSeconds: estimateBeatSeconds({ kind, text }, rules),
      };
    }),
  }));
}

export function normalizeMotionPlan(value = []) {
  return (Array.isArray(value) ? value : []).map(item => ({
    startSecond:Number(item?.startSecond),
    endSecond:Number(item?.endSecond),
    subjectMotion:clean(item?.subjectMotion),
    cameraMotion:clean(item?.cameraMotion),
    amplitude:MOTION_AMPLITUDES.has(clean(item?.amplitude)) ? clean(item.amplitude) : '小',
    speed:MOTION_SPEEDS.has(clean(item?.speed)) ? clean(item.speed) : '慢',
  }));
}

export function storyboardGateReport({ scenes = [], shots = [] }, settings = {}) {
  const rules = { ...DEFAULT_STORYBOARD_RULES, ...settings };
  const gates = [];
  const add = (id, label, problems) => gates.push({ id, label, ok: problems.length === 0, problems });
  const beatMap = new Map();
  const sceneBeatIds = new Map();
  for (const scene of scenes) {
    const ids = [];
    for (const beat of scene.beats || []) {
      if (beatMap.has(beat.id)) continue;
      beatMap.set(beat.id, { beat, sceneNumber:scene.sceneNumber });
      ids.push(beat.id);
    }
    sceneBeatIds.set(scene.sceneNumber, ids);
  }

  const coverage = [];
  const claims = new Map([...beatMap.keys()].map(id => [id, []]));
  const durations = [];
  const execution = [];
  const references = [];
  const continuity = [];
  const ordering = [];
  const motion = [];

  shots.forEach((shot, index) => {
    const label = `分镜 ${index + 1}`;
    const ids = Array.isArray(shot.sourceBeatIds) ? shot.sourceBeatIds.map(clean).filter(Boolean) : [];
    if (!ids.length) coverage.push(`${label} 没有认领任何剧本节拍`);
    const expected = sceneBeatIds.get(Number(shot.sceneNumber)) || [];
    const positions = ids.map(id => expected.indexOf(id));
    if (ids.some(id => !beatMap.has(id))) references.push(`${label} 引用了不存在的节拍`);
    if (ids.some(id => beatMap.get(id)?.sceneNumber !== Number(shot.sceneNumber))) references.push(`${label} 跨场认领节拍`);
    if (positions.some(pos => pos < 0) || positions.some((pos, i) => i > 0 && pos !== positions[i - 1] + 1)) coverage.push(`${label} 认领的节拍不是同场连续区间`);
    ids.forEach(id => claims.get(id)?.push(label));

    const requiredSeconds = ids.reduce((sum, id) => sum + (beatMap.get(id)?.beat.estimatedSeconds || 0), 0);
    const available = Number(shot.duration) || Number(settings.shotDuration) || 20;
    if (requiredSeconds > available + rules.durationTolerance) durations.push(`${label} 需要约 ${requiredSeconds.toFixed(1)} 秒，超过 ${available} 秒`);
    if (!clean(shot.action)) execution.push(`${label} 缺少可执行动作`);
    if (CUT_WORDS.test([shot.action, shot.script, shot.visualDirection, shot.prompt].map(clean).join(' '))) execution.push(`${label} 内含切镜/转场指令；一次视频生成只能对应一个连续镜头`);
    if (ABSTRACT_ACTION.test(clean(shot.action))) execution.push(`${label} 的动作是抽象氛围，不是可拍行为`);
    if (!clean(shot.narrativeFunction)) execution.push(`${label} 缺少观众新增信息`);
    if (!clean(shot.startState) || !clean(shot.endState)) continuity.push(`${label} 缺少明确的起始或结束状态`);
    if ((shot.resourceNames || []).length > 0 && !Array.isArray(shot.resourceNames)) references.push(`${label} 的资源引用格式错误`);

    const previous = shots[index - 1];
    if (previous && Number(previous.sceneNumber) > Number(shot.sceneNumber)) ordering.push(`${label} 的场次顺序倒退`);
    if (previous && Number(previous.sceneNumber) === Number(shot.sceneNumber)) {
      const outToken = clean(previous.endStateId);
      const inToken = clean(shot.startStateId);
      if (outToken && inToken && outToken !== inToken) continuity.push(`${label} 的起始状态编号 ${inToken} 与上一镜结束状态编号 ${outToken} 不一致`);
    }

    const timeline = normalizeMotionPlan(shot.motionPlan);
    if (!timeline.length) motion.push(`${label} 缺少逐秒运动时间轴`);
    else {
      if (Math.abs(timeline[0].startSecond) > 0.01) motion.push(`${label} 的时间轴必须从 0 秒开始`);
      if (Math.abs(timeline.at(-1).endSecond - available) > 0.01) motion.push(`${label} 的时间轴必须结束在 ${available} 秒`);
      timeline.forEach((item, motionIndex) => {
        const motionLabel = `${label} 时间段 ${motionIndex + 1}`;
        if (!Number.isFinite(item.startSecond) || !Number.isFinite(item.endSecond) || item.endSecond <= item.startSecond) motion.push(`${motionLabel} 时间范围无效`);
        if (item.endSecond - item.startSecond > 2.01) motion.push(`${motionLabel} 超过 2 秒，动作控制过于粗糙`);
        if (!item.subjectMotion) motion.push(`${motionLabel} 缺少人物/主体动作`);
        if (!item.cameraMotion) motion.push(`${motionLabel} 缺少摄影机动作`);
        if (CUT_WORDS.test(`${item.subjectMotion} ${item.cameraMotion}`)) motion.push(`${motionLabel} 包含切镜或转场`);
        if (motionIndex > 0 && Math.abs(item.startSecond - timeline[motionIndex - 1].endSecond) > 0.01) motion.push(`${motionLabel} 与上一段不连续`);
      });
      if (!/(?:保持|静止|定格|不动)/.test(timeline[0].subjectMotion)) motion.push(`${label} 的第一段必须先保持首帧`);
      if (!/(?:保持|静止|定格|停住)/.test(timeline.at(-1).subjectMotion)) motion.push(`${label} 的最后一段必须落到尾帧定格`);
    }
  });

  for (const [id, owners] of claims) {
    if (!owners.length) coverage.push(`剧本节拍 ${id} 没有镜头认领`);
    if (owners.length > 1) coverage.push(`剧本节拍 ${id} 被重复认领：${owners.join('、')}`);
  }

  add('source-coverage', '所有剧本节拍恰好被一个镜头连续认领', coverage);
  add('duration-fit', '台词与动作预算装得进镜头时长', durations);
  add('single-take', '一次生成只包含一个连续镜头和可执行动作', execution);
  add('source-refs', '镜头只引用同场存在的节拍与资源', references);
  add('continuity', '相邻镜头的起止状态可衔接', continuity);
  add('ordering', '镜头和场次顺序不倒退', ordering);
  add('motion-timeline', '运动时间轴逐段覆盖全时长，并明确幅度、速度和首尾定格', motion);
  return gates;
}

export function assertProductionPlan(plan, settings = {}) {
  const gates = storyboardGateReport(plan, settings);
  const failed = gates.filter(gate => !gate.ok);
  if (failed.length) {
    const error = new Error(`导演方案未通过生产质量门：${failed.flatMap(gate => gate.problems).slice(0, 8).join('；')}`);
    error.code = 'STORYBOARD_QUALITY_GATE';
    error.gates = gates;
    throw error;
  }
  return gates;
}

export function productionQualitySummary(plan, settings = {}) {
  const gates = storyboardGateReport(plan, settings);
  return { version:STORYBOARD_ENGINE_VERSION, passed:gates.every(gate => gate.ok), gates };
}
