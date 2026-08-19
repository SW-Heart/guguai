import { assertProductionPlan, normalizeMotionPlan, normalizeProductionScenes, productionQualitySummary, storyboardGateReport, STORYBOARD_ENGINE_VERSION } from './storyboard-engine.mjs';

export const scriptAnalysisSystemPrompt = `你是短剧剧本分析师。把用户提供的单集剧本转成严格 JSON，不要输出 Markdown。
输出对象必须包含：
1. title：字符串；
2. logline：字符串；
3. scenes：数组，每项包含 sceneNumber、heading、location、timeOfDay、summary、dramaticFunction、characters；
4. assets：对象，包含 characters、locations、props、costumes 四个数组；每个资产至少包含 name 和 description。
不要补写不存在的关键剧情。相同实体需要去重。`;

export const storyboardSystemPrompt = `你是竖屏短剧分镜导演。根据原始剧本和已经确认的场次、资产，输出严格 JSON，不要输出 Markdown。
输出对象只包含 shots 数组。每个镜头必须包含：
- shotNumber：从 1 连续递增的整数；
- sceneNumber：对应场次编号；
- title：镜头短标题；
- narrativeFunction：这个镜头新增的信息或情绪变化；
- shotSize：景别，例如全景、中景、近景、特写；
- cameraMovement：运镜，例如固定、缓慢推进、跟拍；
- characters：出镜角色名数组；
- action：20 秒内可完成的清晰动作；
- dialogue：该镜头台词，没有则为空字符串；
- continuityNotes：服装、站位、道具、视线等连续性要求；
- keyframePrompt：用于生成竖屏 9:16 真人短剧关键帧的中文提示词，包含角色、场景、构图、光线、动作和必须保持项；
- videoPrompt：用于从关键帧生成 20 秒视频的中文提示词，描述动作顺序、表演、运镜、声音和禁止变化项。
按照戏剧信息变化切镜，不要机械地每句对白切一镜。单镜只安排一个主要动作，所有镜头固定按 20 秒制作。不要新增剧本中不存在的关键人物和剧情。`;

export const directorPackageSystemPrompt = `你是短剧智能导演。根据用户的一句话创意或已有剧本，以及制作参数，输出严格 JSON，不要输出 Markdown。
你的职责不是直接写图片或视频模型 Prompt，而是提交可被机器校验和编译的导演决策。必须遵循“剧本管戏，分镜管拍”：先把剧本拆成动作/台词节拍，再让镜头认领节拍。
输出对象必须包含：
- workflowVersion：固定为 3；
- title：项目标题；
- synopsis：一句话故事梗概；
- script：完整、可编辑的分场剧本；如果用户消息明确标记“完整剧本，系统保留原稿”，则必须省略 script，避免重复输出和截断；
- scenes：场次数组，每项包含 heading、location、timeOfDay、dramaticFunction、geography、lighting、continuityNotes、beats。beats 是严格按发生顺序排列的节拍数组；每拍包含 id、kind、text、speaker、delivery。id 使用 S01-B01 格式且全局唯一；kind 只能是 action 或 dialogue；一个动作节拍只写一个常见、可见、可生成的行为；台词单独成拍，绝不混在动作里；
- resources：后续图生图和图生视频需要保持一致的资源数组，每项包含 type（只能是 character、location、prop）、name、description、prompt、bible。bible 包含 identity、dramaticGoal、appearance、costume、canonicalViews、stateNotes；角色必须给出正面/侧面/全身标准视图要求，场景必须给出空间锚点和标准机位，物品必须给出材质、尺度和状态；
- shots：严格等于用户要求数量的分镜数组。每项包含 title、sourceBeatIds、script、duration、aspectRatio、resourceNames、sceneNumber、narrativeFunction、shotSize、cameraMovement、framing、startStateId、startState、action、endStateId、endState、continuityNotes、sound、negativePrompt、visualDirection、motionPlan。sourceBeatIds 必须认领同一场内连续节拍；所有节拍必须恰好被一个镜头认领，不重不漏；resourceNames 只能引用 resources 中的 name。
motionPlan 是逐秒运动时间轴，每段包含 startSecond、endSecond、subjectMotion、cameraMotion、amplitude、speed。时间必须从 0 连续覆盖到镜头 duration，每段不超过 2 秒；amplitude 只能是静止/微小/小/中/大，speed 只能是静止/极慢/慢/中/快。第一段先保持首帧构图，最后一段必须停住并定格在 endState；中间逐段写清身体哪一部分移动、方向、距离或角度、表情变化，以及摄影机位移方向和幅度。禁止使用“自然地、富有张力、电影感”等不可执行形容词代替动作。
硬规则：一次 shot 就是一次视频模型调用，只允许一个连续机位和一个主要动作，绝不能在 action/script/visualDirection 中写“切到、切回、再切、转场、蒙太奇”。台词和动作必须能装进单镜时长；相邻同场镜头用同一个状态编号衔接（上一镜 endStateId 必须等于下一镜 startStateId）。visualDirection 只补充构图和光线，不得复述整份角色设定，不得写模型参数，不得增加剧情。
总时长匹配用户要求，单镜时长使用用户指定值。不要新增用户创意之外的关键人物、动作或剧情。`;

export const directorPackageRepairSystemPrompt = `你是短剧智能导演的完整方案重建器。上一轮完整导演方案未通过基础结构校验，服务器会提供原始导演请求和安全的确定性诊断。
你必须重新提交完整 workflow v3 导演包，包括 title、synopsis、按输入类型要求的 script、scenes、resources 和 shots。每个场次必须包含按叙事顺序排列的非空 action/dialogue beats，beat id 全局唯一；shots 数量严格等于制作参数并完整认领所有 beats。不得解释错误，只输出符合工具 Schema 的完整 JSON。`;

export const directorShotCompletionSystemPrompt = `你是短剧智能导演的分镜补全器。服务器会提供一份已校验的导演方案前缀和尚未认领的剧本节拍。
你只能返回缺失的新增 shots，不得改写、重复或重新输出已有分镜。严格按剩余节拍顺序补全，保持同场连续认领、状态衔接、单镜单动作和逐秒运动时间轴。只输出符合工具 Schema 的 JSON。`;

export const directorShotRepairSystemPrompt = `你是短剧智能导演的生产质量修复器。服务器会提供固定的剧本节拍、资源、候选分镜和确定性质量门报告。
你只能返回完整替换的 shots，不得改写 script、scenes 或 resources。必须逐项修复质量门问题，保持指定镜头总数，并让最终方案通过节拍覆盖、时长、单镜单动作、引用、连续性、顺序和运动时间轴校验。只输出符合工具 Schema 的 JSON。`;

const textField = { type:'string' };
const directorValidationError = (message, details = {}) => Object.assign(new Error(message), details);
const directorShotJsonSchema = () => ({
  type:'object',
  additionalProperties:false,
  required:['title','sourceBeatIds','script','duration','aspectRatio','resourceNames','sceneNumber','narrativeFunction','shotSize','cameraMovement','framing','startStateId','startState','action','endStateId','endState','continuityNotes','sound','negativePrompt','visualDirection','motionPlan'],
  properties:{
    title:textField,
    sourceBeatIds:{type:'array',items:textField},
    script:textField,
    duration:{type:'number'},
    aspectRatio:textField,
    resourceNames:{type:'array',items:textField},
    sceneNumber:{type:'number'},
    narrativeFunction:textField,
    shotSize:textField,
    cameraMovement:textField,
    framing:textField,
    startStateId:textField,
    startState:textField,
    action:textField,
    endStateId:textField,
    endState:textField,
    continuityNotes:textField,
    sound:textField,
    negativePrompt:textField,
    visualDirection:textField,
    motionPlan:{
      type:'array',
      items:{
        type:'object',
        additionalProperties:false,
        required:['startSecond','endSecond','subjectMotion','cameraMotion','amplitude','speed'],
        properties:{
          startSecond:{type:'number'},
          endSecond:{type:'number'},
          subjectMotion:textField,
          cameraMotion:textField,
          amplitude:{type:'string',enum:['静止','微小','小','中','大']},
          speed:{type:'string',enum:['静止','极慢','慢','中','快']},
        },
      },
    },
  },
});

export function buildDirectorPackageRepairPrompt(originalPrompt, settings = {}, feedback = null, { round = 1, requireScript = true } = {}) {
  const payload = {
    task:'上一轮完整导演包基础结构无效；请从原始请求重新构建完整 workflow v3 导演包',
    repairRound:Math.max(1,Number(round)||1),
    requireScript:Boolean(requireScript),
    requiredShotCount:normalizeDirectorShotCount(settings),
    settings:{ shotDuration:Number(settings.shotDuration)||20, aspectRatio:String(settings.aspectRatio||'9:16'), totalDuration:Number(settings.totalDuration)||0 },
    previousFailure:feedback && typeof feedback === 'object' ? feedback : null,
    rules:[
      '返回完整对象：workflowVersion、title、synopsis、scenes、resources、shots，以及 requireScript 为 true 时的 script',
      '每个 scene 必须包含非空 beats；每个 beat 的 kind 只能是 action 或 dialogue，id 使用 S01-B01 格式且全局唯一',
      'shots 数量严格等于 requiredShotCount，并按顺序恰好认领所有 beats，不重不漏',
      '每个 shot 必须包含 Schema 要求的全部字段，并通过时长、单镜单动作、连续性和 motionPlan 生产规则',
      '必须逐项修复 previousFailure，不得解释、不得返回 Markdown、不得只返回 shots',
    ],
    originalDirectorRequest:String(originalPrompt || '').slice(0, 140000),
  };
  return `请重新生成完整导演方案。只提交符合完整导演工具 Schema 的 JSON。\n${JSON.stringify(payload)}`;
}

export function normalizeDirectorShotCount(settings = {}, fallbackCount = 1) {
  return Math.max(1, Math.min(120, Number(settings.shotCount) || Number(fallbackCount) || 1));
}

export function directorPackageJsonSchema({ requireScript = true, shotCount } = {}) {
  const required = ['workflowVersion','title','synopsis','scenes','resources','shots'];
  if (requireScript) required.splice(2,0,'script');
  const exactShotCount = Number.isInteger(Number(shotCount)) ? normalizeDirectorShotCount({ shotCount }) : null;
  return {
    type:'object', additionalProperties:false, required,
    properties:{
      workflowVersion:{type:'number'}, title:textField, synopsis:textField, script:textField,
      scenes:{ type:'array', items:{ type:'object', additionalProperties:false, required:['heading','location','timeOfDay','dramaticFunction','geography','lighting','continuityNotes','beats'], properties:{ heading:textField, location:textField, timeOfDay:textField, dramaticFunction:textField, geography:textField, lighting:textField, continuityNotes:textField, beats:{type:'array',items:{type:'object',additionalProperties:false,required:['id','kind','text','speaker','delivery'],properties:{id:textField,kind:{type:'string',enum:['action','dialogue']},text:textField,speaker:textField,delivery:textField}}} } } },
      resources:{ type:'array', items:{ type:'object', additionalProperties:false, required:['type','name','description','prompt','bible'], properties:{ type:{type:'string',enum:['character','location','prop']}, name:textField, description:textField, prompt:textField, bible:{ type:'object', additionalProperties:false, required:['identity','dramaticGoal','appearance','costume','canonicalViews','stateNotes'], properties:{ identity:textField, dramaticGoal:textField, appearance:textField, costume:textField, canonicalViews:textField, stateNotes:textField } } } } },
      shots:{ type:'array', ...(exactShotCount ? {minItems:exactShotCount,maxItems:exactShotCount} : {}), items:directorShotJsonSchema() },
    },
  };
}

export function directorShotCompletionJsonSchema(missingCount) {
  const count = Math.max(1, Math.min(120, Number(missingCount) || 1));
  return { type:'object', additionalProperties:false, required:['shots'], properties:{ shots:{type:'array',minItems:count,maxItems:count,items:directorShotJsonSchema()} } };
}

export function directorShotRepairJsonSchema(shotCount) {
  const count = normalizeDirectorShotCount({ shotCount });
  return { type:'object', additionalProperties:false, required:['shots'], properties:{ shots:{type:'array',minItems:count,maxItems:count,items:directorShotJsonSchema()} } };
}

function jsonErrorPosition(error) {
  const position = Number(String(error?.message || '').match(/\bposition (\d+)/i)?.[1]);
  return Number.isSafeInteger(position) ? position : -1;
}

function previousNonWhitespaceIndex(source, from) {
  for (let index = from; index >= 0; index--) if (!/\s/.test(source[index])) return index;
  return -1;
}

function nextNonWhitespaceIndex(source, from) {
  for (let index = from; index < source.length; index++) if (!/\s/.test(source[index])) return index;
  return -1;
}

function repairJsonSyntaxAtError(source, error) {
  const message = String(error?.message || '');
  const position = jsonErrorPosition(error);
  if (position <= 0 || position >= source.length) return '';
  const current = source[position];
  const previousIndex = previousNonWhitespaceIndex(source, position - 1);
  const nextIndex = nextNonWhitespaceIndex(source, position + 1);
  const previous = source[previousIndex];
  const next = source[nextIndex];

  if (/Expected ',' or '[}\]]' after (?:array element|property value)/i.test(message)) {
    return `${source.slice(0, position)},${source.slice(position)}`;
  }
  if (/Expected (?:double-quoted property name|property name or '}')/i.test(message)) {
    if (current === ',' && (previous === ',' || previous === '{')) return `${source.slice(0, position)}${source.slice(position + 1)}`;
    if (current === '}' && previous === ',') return `${source.slice(0, previousIndex)}${source.slice(previousIndex + 1)}`;
    if (/[$A-Z_a-z]/.test(current) && [',','{'].includes(previous)) {
      let end = position + 1;
      while (end < source.length && /[$0-9A-Z_a-z-]/.test(source[end])) end++;
      if (source[nextNonWhitespaceIndex(source, end)] === ':') return `${source.slice(0, position)}"${source.slice(position, end)}"${source.slice(end)}`;
    }
    if (current === ',' && next === '"') return `${source.slice(0, position)}${source.slice(position + 1)}`;
  }
  return '';
}

function parseJsonWithRepairs(source, firstError) {
  let candidate = source;
  let error = firstError;
  for (let attempt = 0; attempt < 200; attempt++) {
    const repaired = repairJsonSyntaxAtError(candidate, error);
    if (!repaired || repaired === candidate) throw error;
    candidate = repaired;
    try { return JSON.parse(candidate); }
    catch (nextError) { error = nextError; }
  }
  throw error;
}

export function parseJsonObject(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw directorValidationError('LLM 输出不是 JSON 对象', { code:'DIRECTOR_OUTPUT_PARSE_FAILED', failureKind:'parse' });
  const candidate = source.slice(start, end + 1);
  try { return JSON.parse(candidate); }
  catch (originalError) {
    const repaired = candidate
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/}\s*(?={)/g, '},')
      .replace(/]\s*(?={)/g, '],');
    try { return JSON.parse(repaired); }
    catch (repairError) {
      try { return parseJsonWithRepairs(repaired, repaired === candidate ? originalError : repairError); }
      catch { throw directorValidationError('LLM 输出 JSON 结构无效', { code:'DIRECTOR_OUTPUT_PARSE_FAILED', failureKind:'parse' }); }
    }
  }
}

export function validateScriptAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('剧本分析结果必须是对象');
  if (typeof value.title !== 'string' || !value.title.trim()) throw new Error('剧本分析缺少 title');
  if (typeof value.logline !== 'string') throw new Error('剧本分析缺少 logline');
  if (!Array.isArray(value.scenes)) throw new Error('剧本分析缺少 scenes');
  if (!value.assets || typeof value.assets !== 'object') throw new Error('剧本分析缺少 assets');
  for (const key of ['characters', 'locations', 'props', 'costumes']) if (!Array.isArray(value.assets[key])) throw new Error(`剧本分析 assets.${key} 必须是数组`);
  return value;
}

export function validateStoryboard(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.shots)) throw new Error('分镜结果缺少 shots');
  if (!value.shots.length) throw new Error('分镜结果没有镜头');
  if (value.shots.length > 120) throw new Error('单集分镜不能超过 120 个镜头');
  const shots = value.shots.map((shot, index) => {
    if (!shot || typeof shot !== 'object') throw new Error(`镜头 ${index + 1} 格式错误`);
    for (const key of ['title', 'narrativeFunction', 'shotSize', 'cameraMovement', 'action', 'keyframePrompt', 'videoPrompt']) {
      if (typeof shot[key] !== 'string' || !shot[key].trim()) throw new Error(`镜头 ${index + 1} 缺少 ${key}`);
    }
    return {
      shotNumber: index + 1,
      sceneNumber: Number.isFinite(Number(shot.sceneNumber)) ? Number(shot.sceneNumber) : 1,
      title: shot.title.trim(),
      narrativeFunction: shot.narrativeFunction.trim(),
      shotSize: shot.shotSize.trim(),
      cameraMovement: shot.cameraMovement.trim(),
      characters: Array.isArray(shot.characters) ? shot.characters.map(String) : [],
      action: shot.action.trim(),
      dialogue: String(shot.dialogue || '').trim(),
      continuityNotes: String(shot.continuityNotes || '').trim(),
      keyframePrompt: shot.keyframePrompt.trim(),
      videoPrompt: shot.videoPrompt.trim(),
      duration: 20,
    };
  });
  return { shots };
}

function prepareDirectorShots(value, resources, workflowVersion, settings) {
  const resourceNames = new Set(resources.map(item => item.name));
  const duration = Number(settings.shotDuration) || 6;
  const aspectRatio = String(settings.aspectRatio || '9:16');
  return value.shots.map((shot, index) => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) throw directorValidationError(`分镜 ${index + 1} 格式错误`, { code:'DIRECTOR_SHOT_INVALID', failureKind:'structure', shotNumber:index + 1 });
    const required = workflowVersion >= STORYBOARD_ENGINE_VERSION ? ['title','script','narrativeFunction','action','startState','endState','visualDirection'] : ['title','script','prompt'];
    for (const key of required) if (typeof shot[key] !== 'string' || !shot[key].trim()) throw directorValidationError(`分镜 ${index + 1} 缺少 ${key}`, { code:'DIRECTOR_SHOT_FIELD_MISSING', failureKind:'structure', shotNumber:index + 1, field:key });
    const requestedResources = Array.isArray(shot.resourceNames) ? shot.resourceNames.map(String) : [];
    const unknownResources = requestedResources.filter(name => !resourceNames.has(name));
    if (workflowVersion >= STORYBOARD_ENGINE_VERSION && unknownResources.length) throw directorValidationError(`分镜 ${index + 1} 引用了不存在的资源：${unknownResources.join('、')}`, { code:'DIRECTOR_SHOT_UNKNOWN_RESOURCE', failureKind:'structure', shotNumber:index + 1, field:'resourceNames', unknownResources:unknownResources.slice(0, 8) });
    const visualDirection = String(shot.visualDirection || shot.prompt || '').trim();
    return { shotNumber:index + 1, sceneNumber:Math.max(1,Number(shot.sceneNumber)||1), title:shot.title.trim(), sourceBeatIds:Array.isArray(shot.sourceBeatIds) ? shot.sourceBeatIds.map(String) : [], script:shot.script.trim(), prompt:visualDirection, visualDirection, narrativeFunction:String(shot.narrativeFunction || '').trim(), shotSize:String(shot.shotSize || '中景').trim(), cameraMovement:String(shot.cameraMovement || '固定').trim(), framing:String(shot.framing || '').trim(), startStateId:String(shot.startStateId || '').trim(), startState:String(shot.startState || '').trim(), action:String(shot.action || shot.script).trim(), endStateId:String(shot.endStateId || '').trim(), endState:String(shot.endState || '').trim(), continuityNotes:String(shot.continuityNotes || '').trim(), sound:String(shot.sound || '').trim(), negativePrompt:String(shot.negativePrompt || '禁止人物变脸、服装变化、道具消失、空间轴线跳变').trim(), motionPlan:normalizeMotionPlan(shot.motionPlan), duration, aspectRatio, resourceNames:requestedResources.filter(name => resourceNames.has(name)) };
  });
}

export function prepareDirectorPackage(value, settings = {}, fallbackScript = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw directorValidationError('智能导演结果必须是对象', { code:'DIRECTOR_PACKAGE_INVALID', failureKind:'structure', field:'package' });
  const workflowVersion = Number(value.workflowVersion) || 1;
  const title = String(value.title || value.projectTitle || '').trim();
  const synopsis = String(value.synopsis || value.logline || value.summary || '').trim();
  const script = String(value.script || value.screenplay || value.fullScript || value.storyScript || fallbackScript || '').trim();
  for (const [key,field] of Object.entries({title,synopsis,script})) if (!field) throw directorValidationError(`智能导演结果缺少 ${key}`, { code:'DIRECTOR_PACKAGE_FIELD_MISSING', failureKind:'structure', field:key });
  if (!Array.isArray(value.resources)) throw directorValidationError('智能导演结果缺少 resources', { code:'DIRECTOR_PACKAGE_FIELD_MISSING', failureKind:'structure', field:'resources' });
  if (!Array.isArray(value.shots) || !value.shots.length) throw directorValidationError('智能导演结果缺少 shots', { code:'DIRECTOR_PACKAGE_FIELD_MISSING', failureKind:'structure', field:'shots' });
  if (value.shots.length > 120) throw directorValidationError('智能导演分镜不能超过 120 个', { code:'DIRECTOR_PACKAGE_LIMIT', failureKind:'structure', field:'shots' });
  const allowedTypes = new Set(['character', 'location', 'prop']);
  const resources = value.resources.slice(0, 60).map((resource, index) => {
    if (!resource || !allowedTypes.has(resource.type)) throw directorValidationError(`资源 ${index + 1} 类型错误`, { code:'DIRECTOR_RESOURCE_INVALID', failureKind:'structure', field:`resources.${index}.type` });
    for (const key of ['name', 'description', 'prompt']) if (typeof resource[key] !== 'string' || !resource[key].trim()) throw directorValidationError(`资源 ${index + 1} 缺少 ${key}`, { code:'DIRECTOR_RESOURCE_FIELD_MISSING', failureKind:'structure', field:`resources.${index}.${key}` });
    const bible = resource.bible && typeof resource.bible === 'object' ? resource.bible : {};
    return { type:resource.type, name:resource.name.trim(), description:resource.description.trim(), prompt:resource.prompt.trim(), bible:{ identity:String(bible.identity || resource.description).trim(), dramaticGoal:String(bible.dramaticGoal || '').trim(), appearance:String(bible.appearance || '').trim(), costume:String(bible.costume || '').trim(), canonicalViews:String(bible.canonicalViews || '').trim(), stateNotes:String(bible.stateNotes || '').trim() } };
  });
  const rawScenes = Array.isArray(value.scenes) && value.scenes.length ? value.scenes : [{ heading:'场次 1', location:'', timeOfDay:'日', beats:[] }];
  const scenes = normalizeProductionScenes(rawScenes.slice(0, 60).map((scene,index)=>({ sceneNumber:index+1, heading:String(scene?.heading || `场次 ${index+1}`).trim(), location:String(scene?.location || '').trim(), timeOfDay:String(scene?.timeOfDay || '日').trim(), dramaticFunction:String(scene?.dramaticFunction || '').trim(), geography:String(scene?.geography || '').trim(), lighting:String(scene?.lighting || '').trim(), continuityNotes:String(scene?.continuityNotes || '').trim(), beats:Array.isArray(scene?.beats) ? scene.beats : [] })), settings);
  if (workflowVersion >= STORYBOARD_ENGINE_VERSION) {
    const emptySceneIndex = scenes.findIndex(scene => !scene.beats.length);
    if (emptySceneIndex >= 0) throw directorValidationError('智能导演必须把每个场次拆成动作/台词节拍', { code:'DIRECTOR_SCENE_BEATS_MISSING', failureKind:'structure', field:'scenes.beats', sceneNumber:emptySceneIndex + 1 });
    const ids = scenes.flatMap(scene => scene.beats.map(beat => beat.id));
    if (new Set(ids).size !== ids.length) throw directorValidationError('智能导演返回了重复的剧本节拍 id', { code:'DIRECTOR_BEAT_ID_DUPLICATE', failureKind:'structure', field:'scenes.beats.id' });
  }
  const shots = prepareDirectorShots(value, resources, workflowVersion, settings);
  return { workflowVersion, title, synopsis, script, scenes, resources, shots };
}

export function directorRecoveryDiagnostic(error, { requestedShotCount, returnedShotCount } = {}) {
  const expected = Number(requestedShotCount);
  const returned = Number(returnedShotCount);
  if (error?.code === 'STORYBOARD_QUALITY_GATE') {
    const failedGates = (Array.isArray(error.gates) ? error.gates : []).filter(gate => !gate.ok).slice(0, 7);
    return {
      kind:'quality',
      code:error.code,
      gateIds:failedGates.map(gate => gate.id),
      problems:failedGates.flatMap(gate => (gate.problems || []).slice(0, 6).map(message => ({ gateId:gate.id, message:String(message).slice(0, 240) }))).slice(0, 24),
    };
  }
  if (error?.failureKind === 'parse' || error?.code === 'DIRECTOR_OUTPUT_PARSE_FAILED' || error instanceof SyntaxError) {
    return { kind:'parse', code:'DIRECTOR_OUTPUT_PARSE_FAILED', problems:[{ message:'输出不是可解析的完整 JSON 对象；请重新提交完整 shots 对象' }] };
  }
  if (Number.isFinite(expected) && Number.isFinite(returned) && expected !== returned) {
    return { kind:'count', code:'DIRECTOR_SHOT_COUNT_MISMATCH', expectedShotCount:expected, returnedShotCount:returned, problems:[{ message:`必须返回 ${expected} 个分镜，实际返回 ${returned} 个` }] };
  }
  const problem = { message:String(error?.message || '导演输出结构不符合生产协议').slice(0, 240) };
  if (Number.isInteger(error?.sceneNumber)) problem.sceneNumber = error.sceneNumber;
  if (Number.isInteger(error?.shotNumber)) problem.shotNumber = error.shotNumber;
  if (typeof error?.field === 'string' && error.field) problem.field = error.field;
  if (Array.isArray(error?.unknownResources)) problem.unknownResources = error.unknownResources.slice(0, 8);
  return { kind:'structure', code:String(error?.code || 'DIRECTOR_OUTPUT_STRUCTURE_INVALID'), problems:[problem] };
}

export function analyzeDirectorShotShortage(pack, settings = {}) {
  const requestedShotCount = normalizeDirectorShotCount(settings, pack?.shots?.length);
  const initialShotCount = Array.isArray(pack?.shots) ? pack.shots.length : 0;
  const missingShotCount = requestedShotCount - initialShotCount;
  if (pack?.workflowVersion < STORYBOARD_ENGINE_VERSION) return { recoverable:false, reason:'仅工作流 v3 支持自动补全', requestedShotCount, initialShotCount, missingShotCount };
  if (initialShotCount <= 0 || missingShotCount <= 0) return { recoverable:false, reason:missingShotCount < 0 ? '返回分镜数量超过请求数量' : '没有可补全的分镜缺口', requestedShotCount, initialShotCount, missingShotCount };

  const gates = storyboardGateReport({ scenes:pack.scenes, shots:pack.shots }, settings);
  const blockingProblems = gates.flatMap(gate => gate.problems).filter(problem => !/^剧本节拍 .+ 没有镜头认领$/.test(problem));
  if (blockingProblems.length) return { recoverable:false, reason:blockingProblems[0], requestedShotCount, initialShotCount, missingShotCount };

  const orderedBeatIds = pack.scenes.flatMap(scene => scene.beats.map(beat => beat.id));
  const claimedBeatIds = pack.shots.flatMap(shot => shot.sourceBeatIds);
  if (new Set(claimedBeatIds).size !== claimedBeatIds.length || claimedBeatIds.some((id,index) => id !== orderedBeatIds[index])) {
    return { recoverable:false, reason:'已有分镜必须按剧本顺序认领开头的连续节拍，才能安全追加补全', requestedShotCount, initialShotCount, missingShotCount };
  }
  const unclaimedBeatIds = orderedBeatIds.slice(claimedBeatIds.length);
  if (unclaimedBeatIds.length < missingShotCount) return { recoverable:false, reason:`剩余 ${unclaimedBeatIds.length} 个节拍不足以生成 ${missingShotCount} 个非空分镜`, requestedShotCount, initialShotCount, missingShotCount, unclaimedBeatIds };
  return { recoverable:true, reason:'', requestedShotCount, initialShotCount, missingShotCount, unclaimedBeatIds };
}

export function analyzeDirectorPlanRecovery(pack, settings = {}) {
  const requestedShotCount = normalizeDirectorShotCount(settings, pack?.shots?.length);
  const initialShotCount = Array.isArray(pack?.shots) ? pack.shots.length : 0;
  const shortage = analyzeDirectorShotShortage(pack, settings);
  if (shortage.recoverable) return { mode:'append', requestedShotCount, initialShotCount, gates:storyboardGateReport({scenes:pack.scenes,shots:pack.shots},settings), shortage };
  if (pack?.workflowVersion < STORYBOARD_ENGINE_VERSION || !initialShotCount || initialShotCount > 120) return { mode:'none', requestedShotCount, initialShotCount, reason:'导演方案基础结构不足，无法安全自动修复', gates:[] };
  const gates = storyboardGateReport({ scenes:pack.scenes, shots:pack.shots }, settings);
  const failedGates = gates.filter(gate => !gate.ok);
  if (initialShotCount !== requestedShotCount || failedGates.length) return { mode:'replace', requestedShotCount, initialShotCount, gates, failedGates };
  return { mode:'none', requestedShotCount, initialShotCount, reason:'导演方案不需要自动修复', gates };
}

export function buildDirectorShotRepairPrompt(pack, settings = {}, recovery = analyzeDirectorPlanRecovery(pack, settings), options = {}) {
  if (recovery.mode !== 'replace') throw new Error('当前导演方案不需要全量分镜质量修复');
  const feedback = options.feedback && typeof options.feedback === 'object' ? options.feedback : null;
  const payload = {
    task:'保留剧本、场次和资源，只返回完整替换的 shots，逐项修复生产质量门和上一轮输出结构问题',
    repairRound:Math.max(1,Number(options.round)||1),
    requiredShotCount:recovery.requestedShotCount,
    settings:{ shotDuration:Number(settings.shotDuration)||20, aspectRatio:String(settings.aspectRatio||'9:16') },
    failedGates:(recovery.failedGates || recovery.gates?.filter(gate=>!gate.ok) || []).map(gate=>({id:gate.id,label:gate.label,problems:gate.problems})),
    previousFailure:feedback,
    rules:[
      '返回对象只能包含 shots，且数量严格等于 requiredShotCount；不得解释或输出其他字段',
      '必须逐项修复 previousFailure 和 failedGates 中列出的全部问题；每个 required 字段都必须存在且为非空字符串',
      '所有 scenes.beats 必须按叙事顺序恰好被一个镜头认领，不重不漏；每镜只认领同场连续区间且至少一个节拍',
      '每镜认领的台词与动作估算时长必须不超过 settings.shotDuration；必要时重新分配节拍，但不得改写或遗漏节拍',
      '一次镜头只允许一个连续机位和一个主要动作，不得出现切到、切回、转场或蒙太奇',
      '相邻同场镜头的上一镜 endStateId 必须等于下一镜 startStateId',
      '每个 motionPlan 从 0 秒连续覆盖完整时长，每段不超过 2 秒；首段 subjectMotion 明确保持首帧，末段明确停住并定格尾帧',
    ],
    scenes:pack.scenes,
    resources:pack.resources,
    candidateShots:Array.isArray(options.candidateShots) ? options.candidateShots : pack.shots,
  };
  return `请修复以下导演方案的分镜生产质量。只提交完整替换的 shots。\n${JSON.stringify(payload)}`;
}

export function replaceDirectorShots(pack, repair, settings = {}, fallbackScript = pack?.script || '') {
  const requestedShotCount = normalizeDirectorShotCount(settings, pack?.shots?.length);
  if (!repair || typeof repair !== 'object' || !Array.isArray(repair.shots)) throw new Error('自动质量修复结果缺少 shots');
  if (repair.shots.length !== requestedShotCount) throw new Error(`自动质量修复应返回 ${requestedShotCount} 个分镜，实际返回 ${repair.shots.length} 个`);
  return validateDirectorPackage({ ...pack, shots:repair.shots }, settings, fallbackScript);
}

export function buildDirectorShotCompletionPrompt(pack, settings = {}, shortage = analyzeDirectorShotShortage(pack, settings)) {
  if (!shortage.recoverable) throw new Error(`当前导演方案不能自动补全：${shortage.reason}`);
  const previous = pack.shots.at(-1);
  const payload = {
    task:'只追加缺失分镜，不得改写、重复或重新输出已有分镜',
    requiredNewShotCount:shortage.missingShotCount,
    settings:{ shotDuration:Number(settings.shotDuration)||20, aspectRatio:String(settings.aspectRatio||'9:16') },
    rules:[
      '返回对象只能包含 shots，且 shots 数量必须严格等于 requiredNewShotCount',
      '每个新分镜至少认领一个 remainingBeat；全部 remainingBeat 必须恰好认领一次，保持原顺序且每镜只认领同场连续区间',
      '第一个新分镜必须从 previousShot.endStateId/endState 连续衔接；一次分镜只允许一个连续机位和一个主要动作',
      'motionPlan 从 0 秒连续覆盖完整时长，每段不超过 2 秒，首段保持首帧，末段停住定格',
    ],
    scenes:pack.scenes,
    resources:pack.resources,
    existingShots:pack.shots,
    remainingBeats:pack.scenes.flatMap(scene => scene.beats.map(beat => ({...beat,sceneNumber:scene.sceneNumber}))).filter(beat => shortage.unclaimedBeatIds.includes(beat.id)),
    previousShot:previous ? { shotNumber:previous.shotNumber, sceneNumber:previous.sceneNumber, endStateId:previous.endStateId, endState:previous.endState } : null,
  };
  return `请根据以下已校验上下文完成导演方案。只输出指定的新增分镜，不要输出解释。\n${JSON.stringify(payload)}`;
}

export function mergeDirectorShotCompletion(pack, completion, settings = {}, fallbackScript = pack?.script || '') {
  const shortage = analyzeDirectorShotShortage(pack, settings);
  if (!shortage.recoverable) throw new Error(`当前导演方案不能自动补全：${shortage.reason}`);
  if (!completion || typeof completion !== 'object' || !Array.isArray(completion.shots)) throw new Error('自动补全结果缺少 shots');
  if (completion.shots.length !== shortage.missingShotCount) throw new Error(`自动补全应生成 ${shortage.missingShotCount} 个分镜，实际返回 ${completion.shots.length} 个`);
  const merged = { ...pack, shots:[...pack.shots, ...completion.shots] };
  return validateDirectorPackage(merged, settings, fallbackScript);
}

export function validateDirectorPackage(value, settings = {}, fallbackScript = '') {
  const pack = prepareDirectorPackage(value, settings, fallbackScript);
  const shotCount = normalizeDirectorShotCount(settings, pack.shots.length);
  if (pack.shots.length !== shotCount) throw new Error(`智能导演应生成 ${shotCount} 个分镜，实际返回 ${pack.shots.length} 个`);
  const plan = { scenes:pack.scenes, shots:pack.shots };
  const productionQuality = pack.workflowVersion >= STORYBOARD_ENGINE_VERSION ? { version:STORYBOARD_ENGINE_VERSION, passed:true, gates:assertProductionPlan(plan, settings) } : productionQualitySummary(plan, settings);
  return { ...pack, productionQuality };
}
