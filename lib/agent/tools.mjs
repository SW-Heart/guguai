import { visibleGenerationPrompt } from '../drama-style.mjs';
import { registerVideoEditTools } from './video-edit-tools.mjs';
import { applyDirectorEdit } from '../../public/features/drama/director-actions.js';
import { assertPreferredModel } from './model-preferences.mjs';
import { prepareAgentReferences, referenceLabel } from './references.mjs';
import { generationFailureCode } from '../generation-failure-code.mjs';
import { scanPromptRisk } from '../prompt-precheck.mjs';

const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const strings = description => ({ type: 'array', description, items: { type: 'string' }, maxItems: 50 });
const number = (description, minimum = 0, maximum = 100000) => ({ type: 'number', description, minimum, maximum });
const assetMentions = { type:'array', description:'命名参考素材；在描述中自动写 @名称，平台按实际素材顺序转换编号。已绑定名称可直接复用，无需反复填写。', items:object({id:string('真实素材 ID'),label:string('用户可读名称，例如小雨或客厅',{maxLength:120})},['id','label']), maxItems:50 };
export function validateToolInput(value, schema, at = '参数') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}必须为对象`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${at}缺少 ${key}`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${at}不支持 ${key}`);
      validateToolInput(value[key], schema.properties[key], `${at}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems || 200)) throw new Error(`${at}数组无效`);
    value.forEach((item, i) => validateToolInput(item, schema.items, `${at}[${i}]`));
  } else if (schema.type === 'number') {
    if (!Number.isFinite(value) || value < schema.minimum || value > schema.maximum) throw new Error(`${at}超出允许范围`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength || 30000)) throw new Error(`${at}文本无效`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${at}必须为布尔值`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at}只能使用：${schema.enum.join('、')}`);
}

export function createAgentTools({ skills, catalog, generate, loadProject, saveProject, publicProject, findAsset, publicAsset, listAssets, findGeneration, publicGeneration, listGenerations, modelExperienceStore, inspectImage, inspectVideo, observationStore, transcriptStore, compositionStore }) {
  const registry = new Map();
  const sourceObservationsFor=session=>session.agentProjectId&&observationStore?observationStore.list(session):Object.values(session.doc.sourceObservations||{});
  const sourceObservationFor=(session,assetId)=>session.agentProjectId&&observationStore?observationStore.read(session,assetId):session.doc.sourceObservations?.[assetId];
  const sourceTranscriptsFor=(session,assetId='')=>session.agentProjectId&&transcriptStore?transcriptStore.list(session,assetId):(session.doc.sourceTranscripts||[]).filter(item=>!assetId||item.assetId===assetId);
  const compositionsFor=session=>session.agentProjectId&&compositionStore?compositionStore.list(session):session.doc.compositions||[];
  const transcriptSummary=({assetId,assetName,sourceSha256,startSeconds,endSeconds,language,modelId,hasSpeech,words,cues,updatedAt})=>({assetId,assetName,sourceSha256,startSeconds,endSeconds,language,modelId,hasSpeech,wordCount:words.length,captionCount:cues.length,updatedAt});
  function add(name, description, parameters, execute, options = {}) {
    registry.set(name, { definition: { type: 'function', function: { name, description, parameters } }, execute, ...options });
  }
  const jobSummary = task => {
    const value = publicGeneration?.(task);
    const failure = task.status === 'failed' ? value?.failure || {code:generationFailureCode(task),message:'生成失败，具体原因尚未确定'} : null;
    return {id:task.id,status:task.status,assetId:task.assetId,error:failure ? value?.error || failure.message : '',failure};
  };
  add('jobs_read', '读取已有生成任务的原描述、素材和公开失败原因，供分析与局部改写；不会重新生成。通用审核拒绝不代表已定位具体违禁词。', object({jobId:string('真实生成任务 ID')},['jobId']), async (a,s) => {
    const task = findGeneration(s.userId,a.jobId,s.scope);
    if (!task) throw new Error('任务不存在或不属于当前工作空间');
    const prepared = Object.values(s.doc.prepared || {}).find(item => item.result?.jobIds?.includes(task.id));
    return {...jobSummary(task),prompt:prepared?.displayPrompt ?? visibleGenerationPrompt(task) ?? '',referenceAssetIds:task.referenceAssetIds || [],references:prepared?.references || []};
  });
  add('references_bind', '记住角色、场景或道具与真实素材的对应关系，供后续分镜复用。先查看素材并依据用户指定或明确匹配建立；同名或造型不确定时询问，不猜。后续描述主动写 @名称，无需让用户重复绑定。', object({references:assetMentions},['references']), async (a,s) => {
    const next = new Map((s.doc.referenceBindings || []).map(item => [item.label,item]));
    for (const item of a.references) {
      const label = referenceLabel(item.label), asset = findAsset(s.userId,item.id,s.scope);
      if (!asset || !['image','video','audio'].includes(asset.kind)) throw new Error('参考素材不存在或不属于当前工作空间');
      if (a.references.some(other => referenceLabel(other.label) === label && other.id !== item.id)) throw new Error(`“${label}”对应了多个素材，请分别命名`);
      next.set(label,{id:asset.id,label,kind:asset.kind});
    }
    if (next.size > 100) throw new Error('当前对话的素材名称过多，请先完成现有分镜');
    s.doc.referenceBindings = [...next.values()];
    return {references:s.doc.referenceBindings};
  });
  add('skills_search', '寻找适合当前任务的创作方法；没有相关技能也可以直接对话或组合工具。', object({ query: string('创作需求') }), async a => skills.search(a.query));
  add('skills_read', '按当前任务读取技能说明或参考资料。返回 nextOffset 时对同一 resource 继续传入 offset，直至读完。', object({ name: string('技能名称'), resource: string('默认为 SKILL.md；也可读取 references/ 或 assets/ 下的文件'), offset: number('续读字符位置，默认 0；使用上一页 nextOffset', 0, 60000) }, ['name']), async a => skills.read(a.name, a.resource, a.offset));
  add('prompt_risk_scan', '扫描图像或视频描述中可能导致平台拒绝的词句，返回位置、级别（banned 大概率被拒、suspect 取决于上下文、off 仅供细读）与核对要点。只是定位线索，不代表审核结论；扫描为空也不代表安全。', object({ prompt: string('要检查的完整描述'), modelId: string('目标模型 ID，可留空') }, ['prompt']), async a => {
    const { hits, counts } = scanPromptRisk(a.prompt, { modelId:a.modelId || '', includeOff:true });
    return { counts, hits:hits.slice(0, 100).map(({ start, end, term, level, category, combo, review }) => ({ start, end, term, level, category, combo, review })) };
  });
  add('tool_result_read', '分段读取本次对话中较大的工具结果。使用预览给出的 toolCallId 和 offset。', object({ toolCallId: string('工具调用 ID'), offset: number('起始字符位置', 0, 2000000) }, ['toolCallId']), async (a, s) => {
    const result = s.doc.messages.findLast(message => message.role === 'tool' && message.tool_call_id === a.toolCallId);
    if (!result || typeof result.content !== 'string') throw new Error('工具结果不存在');
    const offset = Math.floor(a.offset || 0);
    return { toolCallId: a.toolCallId, text: result.content.slice(offset, offset + 6000), nextOffset: offset + 6000 < result.content.length ? offset + 6000 : null, totalCharacters: result.content.length };
  });
  add('models_list', '只读查询当前启用的图像、视频模型，不提交媒体生成。正式制作方案阶段就先发现模型，再读具体参数，不等到提交时才选模型。', object({ kind: string('可选筛选', { enum: ['image', 'video'] }) }), async a => (await catalog()).filter(m => !a.kind || m.kind === a.kind).map(({ id, label, kind, description }) => ({ id, label, kind, description })));
  add('models_describe', '只读获取当前模型真实模式、时长、比例、画质、参考素材限制及已提供价格，供规划与生成使用。正式方案中交代所选值及理由；核对同一模式/画质/比例/时长组合，不凭名称猜参数或质量排名。', object({ modelId: string('models_list 返回的 ID') }, ['modelId']), async (a, s) => {
    const model = (await catalog()).find(m => m.id === a.modelId);
    if (!model) throw new Error('这个模型当前不可用，请重新查询模型列表');
    if (!listGenerations || !s) return model;
    const page = listGenerations(s.userId, { ...s.scope, modelId: a.modelId, limit: 1, includeTotal: true });
    return { ...model, workspaceExperience: { generationCount: page.total ?? 0, detailTool: 'models_experience', note: '此处只计当前工作区的真实生成记录；作品质量需读取逐条观察。' } };
  });
  if (listGenerations && modelExperienceStore) {
    const scopedGeneration = (session, generationId) => {
      const task = findGeneration(session.userId, generationId, session.scope);
      if (!task) throw new Error('生成记录不存在或不属于当前工作空间');
      return task;
    };
    const observationFor = (session, task) => {
      const note = modelExperienceStore.read(session.userId, task.id, session.scope);
      if (!note) return null;
      const asset = task.assetId && findAsset(session.userId, task.assetId, session.scope);
      const stale = asset?.sha256 !== note.assetSha256 || task.assetId !== note.assetId;
      return { revision: note.revision, findings: stale ? [] : note.findings, updatedAt: note.updatedAt, stale };
    };
    add('models_experience', '读取当前工作空间真实生成记录和逐条作品观察；样本数量及观察来源必须明确，不能据此宣称模型总体质量排名。', object({ modelId: string('模型 ID') }, ['modelId']), async (a, s) => {
      const model = (await catalog()).find(item => item.id === a.modelId);
      if (!model) throw new Error('这个模型当前不可用，请重新查询模型列表');
      const page = listGenerations(s.userId, { ...s.scope, modelId: a.modelId, limit: 20, includeTotal: true });
      const tasks = page.items || [];
      const samples = tasks.map(task => {
        const note = observationFor(s, task);
        return {
          generationId: task.id, status: task.status, createdAt: task.createdAt, finishedAt: task.finishedAt || null,
          prompt: String(visibleGenerationPrompt(task) || '').slice(0, 400), generationType: task.generationType || 'TEXT',
          quality: task.quality || '', duration: task.duration || null, size: task.size || task.aspectRatio || '',
          referenceCount: task.referenceAssetIds?.length || 0, recordedCostCredits: Number.isSafeInteger(task.creditCostMicro) ? task.creditCostMicro / 1_000_000 : null,
          assetId: task.assetId || '',
          observation: note && !note.stale ? { revision:note.revision, findingCount:note.findings.length, findings:note.findings.slice(0,3), updatedAt:note.updatedAt } : null,
        };
      });
      return {
        modelId: a.modelId, scope: 'current_workspace', totalRecords: page.total ?? null, returned: samples.length,
        completed: samples.filter(item => item.status === 'completed').length,
        failed: samples.filter(item => item.status === 'failed').length,
        observed: samples.filter(item => item.observation).length,
        limitation: '状态和记录费用来自真实生成任务，费用不是扣除退款后的净支出；画面、动作、声音等质量仅以逐条已保存观察为依据。仅返回最近 20 条，不能当作模型总体排名。',
        samples,
      };
    });
    add('model_experience_read', '读取一条真实生成记录的作品观察和当前版本。', object({ generationId: string('生成任务 ID') }, ['generationId']), async (a, s) => {
      const task = scopedGeneration(s, a.generationId);
      return { generationId: task.id, modelId: task.videoModelId || task.modelId, status: task.status, assetId: task.assetId || '', observation: observationFor(s, task) };
    });
    const findingSchema = object({
      aspect: string('观察方面', { enum: ['prompt_following', 'identity', 'motion', 'audio', 'typography', 'composition', 'technical'] }),
      verdict: string('观察结果', { enum: ['works', 'issue', 'uncertain'] }),
      note: string('具体事实或问题，不能写未经观察的结论', { maxLength: 500 }),
      source: string('依据来源', { enum: ['image', 'frame', 'technical', 'user'] }),
      evidenceTimes: { type: 'array', items: number('视频帧秒数', 0, 3600), maxItems: 8 },
    }, ['aspect', 'verdict', 'note', 'source']);
    add('model_experience_note', '保存一条生成作品的可追溯观察；画面观察须先读取图片或视频帧，技术信息须先探测，用户反馈标为待核对。', object({ generationId: string('生成任务 ID'), expectedRevision: number('当前观察版本；首次为 0', 0, 100000), findings: { type: 'array', items: findingSchema, maxItems: 8 } }, ['generationId', 'expectedRevision', 'findings']), async (a, s, invocation) => {
      const task = scopedGeneration(s, a.generationId);
      if (task.status !== 'completed' || !task.assetId) throw new Error('作品尚未生成完成，无法记录画面观察');
      const asset = findAsset(s.userId, task.assetId, s.scope);
      if (!asset || !asset.sha256) throw new Error('作品素材尚不可用，请稍后再试');
      const findings = a.findings.map(item => ({ ...item, note: item.note.trim(), evidenceTimes: item.evidenceTimes || [] }));
      for (const item of findings) {
        if (!item.note) throw new Error('观察内容不能为空');
        if (item.source === 'image' && (asset.kind !== 'image' || !s.doc.imageIds?.includes(asset.id))) throw new Error('请先读取这张生成图片');
        if (item.source === 'frame' && (asset.kind !== 'video' || !item.evidenceTimes.length || item.evidenceTimes.some(time => !s.doc.frameEvidence?.some(frame => frame.assetId === asset.id && Math.abs(frame.timeSeconds - time) < 0.002)))) throw new Error('请先读取引用的视频帧');
        if (item.source === 'image' && ['motion', 'audio', 'technical'].includes(item.aspect)) throw new Error('单张图片不能证明动作、声音或视频技术状态');
        if (item.source === 'frame' && ['audio', 'technical'].includes(item.aspect)) throw new Error('抽样画面不能证明声音或视频技术状态');
        if (item.source === 'frame' && item.aspect === 'motion' && item.evidenceTimes.length < 2) throw new Error('动作观察至少需要两个已读取的时间点');
        if (item.source === 'technical' && (item.aspect !== 'technical' || !s.doc.videoProbes?.[asset.id])) throw new Error('请先探测视频，再记录技术信息');
        if (item.source === 'user' && item.verdict !== 'uncertain') throw new Error('用户描述的效果需要标为待核对');
        if (item.source !== 'frame' && item.evidenceTimes.length) throw new Error('只有视频帧观察可以引用帧时间');
      }
      const saved = modelExperienceStore.save(s.userId, task.id, s.scope, { modelId: task.videoModelId || task.modelId, assetId: asset.id, assetSha256: asset.sha256, findings }, a.expectedRevision, invocation.id);
      return { generationId: task.id, revision: saved.revision, findingCount: saved.findings.length };
    });
  }
  add('workspace_read', '读取当前作品和文档目录。用户附带文件也会出现在文档目录；编辑前读取最新 revision，正文用 documents_read。', object({}), async (_a, s) => {
    const p = s.projectId ? await loadProject(s.userId, s.projectId, s.scope) : null;
    return { project: p ? { id:p.id,revision:p.revision,script:p.script,resources:p.resources,shots:p.shots,lockedIds:p.directorWorkspace?.lockedIds } : null, documents: s.doc.documents.map(({id,title,revision,source})=>({id,title,revision,...(source==='attachment'?{source}: {})})), sourceObservations:sourceObservationsFor(s).map(({assetId,assetName,revision,events})=>({assetId,assetName,revision,eventCount:events.length})), sourceTranscripts:sourceTranscriptsFor(s).filter(item=>findAsset(s.userId,item.assetId,s.scope)?.sha256===item.sourceSha256).map(transcriptSummary), generations: s.doc.generations.slice(-60), compositions:compositionsFor(s).slice(-20).map(({editPlan,...item})=>({...item,...(editPlan?{editable:true,layerCount:editPlan.layers.length}:{})})), selectedIds: s.doc.selection || [] };
  });
  add('documents_read', '读取文字作品或用户附带文件的正文和当前版本。长文可按 offset 分段读取。', object({ id:string('文档 ID'), offset:number('起始字符位置',0,1000000) }, ['id']), async (a,s) => {
    const d=s.doc.documents.find(item=>item.id===a.id);if(!d)throw new Error('文档不存在');
    const offset=Math.floor(a.offset||0);return {id:d.id,title:d.title,revision:d.revision,text:d.text.slice(offset,offset+20000),nextOffset:offset+20000<d.text.length?offset+20000:null};
  });
  add('assets_search', '查询当前工作空间可用素材。只能使用工具返回的真实素材 ID。', object({ query: string('按素材名称筛选') }), async (a, s) => {
    const page = listAssets(s.userId, { ...s.scope, limit: 100 });
    return page.items.filter(item => !a.query || String(item.name || '').includes(a.query)).slice(0, 40).map(publicAsset);
  });
  add('assets_inspect', '读取素材信息。每轮最多读取 30 张图片，图片会作为视觉输入提供给下一次模型调用；视频细节请使用 video_probe 和 video_frames。', object({ assetId: string('素材 ID') }, ['assetId']), async (a, s) => {
    const asset = findAsset(s.userId, a.assetId, s.scope);
    if (!asset) throw new Error('素材不存在或不属于当前工作空间');
    if (asset.kind === 'image') {
      const imageIds = [...new Set([...(s.doc.imageIds || []), asset.id])];
      if (imageIds.length > 30) throw new Error('本轮最多查看 30 张图片，请发送下一条消息后继续查看。');
      if (!await inspectImage(asset, s.userId)) throw new Error('这张图片暂时无法读取，请稍后重试或重新添加图片。');
      s.doc.imageIds = imageIds;
    }
    return publicAsset(asset);
  });
  if(inspectVideo){
    add('video_probe','读取当前工作空间视频的时长、尺寸、帧率和音轨状态。',object({assetId:string('视频素材 ID')},['assetId']),async(a,s)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='video')throw new Error('视频素材不存在或不属于当前工作空间');
      const result=await inspectVideo.probe(s.userId,asset);
      s.doc.videoProbes ||= {};
      s.doc.videoProbes[asset.id]=result;
      return {assetId:asset.id,...result};
    });
    if(inspectVideo.audioInfo)add('audio_probe','读取音频素材的时长与声音轨道状态；添加独立配音、音乐或音效前先确认可用范围。',object({assetId:string('音频素材 ID')},['assetId']),async(a,s)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='audio')throw new Error('音频素材不存在或不属于当前工作空间');
      return {assetId:asset.id,...await inspectVideo.audioInfo(s.userId,asset)};
    });
    add('video_frames','按指定时间点读取视频画面，下一次模型调用会收到这些帧。一次最多 6 帧；可多轮加密查看，不能凭抽样帧推断未看到的片段。',object({assetId:string('视频素材 ID'),times:{type:'array',description:'视频中的秒数，最多 6 个',items:number('秒数',0,3600),maxItems:6}},['assetId','times']),async(a,s)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='video')throw new Error('视频素材不存在或不属于当前工作空间');
      const result=await inspectVideo.frames(s.userId,asset,a.times);
      s.doc.frameImages=result.frames.map(frame=>({assetId:asset.id,timeSeconds:frame.timeSeconds,imageUrl:frame.imageUrl}));
      s.doc.frameEvidence=[...new Map([...(s.doc.frameEvidence||[]),...result.frames.map(frame=>({assetId:asset.id,timeSeconds:frame.timeSeconds}))].map(frame=>[`${frame.assetId}:${frame.timeSeconds}`,frame])).values()].slice(-240);
      return {assetId:asset.id,metadata:result.metadata,frames:result.frames.map(({timeSeconds})=>({timeSeconds})),note:'这些画面会在下一次模型调用中提供。原片语音尚未读取。'};
    });
    if(inspectVideo.boundaries)add('video_boundaries','检测物理画面切换候选时间；结果不是语义镜头结论，需用 video_frames 回看。',object({assetId:string('视频素材 ID'),threshold:number('灵敏度 0.1 到 0.9，默认 0.35',0.1,0.9),maxSeconds:number('最多扫描秒数，默认 300',1,600)},['assetId']),async(a,s)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='video')throw new Error('视频素材不存在或不属于当前工作空间');
      const result=await inspectVideo.boundaries(s.userId,asset,{threshold:a.threshold,maxSeconds:a.maxSeconds});
      s.doc.videoBoundaries ||= {};
      s.doc.videoBoundaries[asset.id]=result.boundaries;
      return {assetId:asset.id,...result};
    });
    if(inspectVideo.extract)add('audio_extract','从视频提取原有混合音轨，存为可播放的音频素材。只分离音轨，不会把人声和背景音乐拆开。',object({assetId:string('视频素材 ID'),startSeconds:number('起点秒数，默认 0',0,3600),endSeconds:number('终点秒数；单次最长 300 秒',0,3600)},['assetId']),async(a,s)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='video')throw new Error('视频素材不存在或不属于当前工作空间');
      const start=a.startSeconds||0,end=a.endSeconds;
      const key=`${asset.id}:${start}:${end??'end'}`;
      const cached=s.doc.audioExtractions?.[key];
      if(cached){const existing=findAsset(s.userId,cached,s.scope);if(existing)return publicAsset(existing);}
      const output=await inspectVideo.extract(s.userId,s.scope,asset,{startSeconds:start,endSeconds:end});
      s.doc.audioExtractions ||= {};
      s.doc.audioExtractions[key]=output.id;
      return publicAsset(output);
    });
    if(inspectVideo.audioCheck)add('video_audio_check','检查视频是否有音轨、整体音量与静音区间；不能据此判断台词或音乐是否正确。原片和生成视频均可检查。',object({assetId:string('视频素材 ID'),startSeconds:number('起点秒数，默认 0',0,3600),endSeconds:number('终点秒数；单次最长 120 秒',0,3600)},['assetId']),async(a,s)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='video')throw new Error('视频素材不存在或不属于当前工作空间');
      return {assetId:asset.id,...await inspectVideo.audioCheck(s.userId,asset,{startSeconds:a.startSeconds||0,endSeconds:a.endSeconds})};
    });
    if(inspectVideo.transcribe&&inspectVideo.audioInfo){
      add('audio_transcribe','识别视频或音频中的台词，保存逐词时间、字幕建议和说话人标记；每次最多 300 秒。转录可能有错，专名和数字需要核对。',object({assetId:string('视频或音频素材 ID'),startSeconds:number('起点秒数，默认 0',0,3600),endSeconds:number('终点秒数；单次最多 300 秒',0,3600),language:string('主要语言，默认普通话',{enum:['zh-CN','zh-TW','zh-HK','en','ja']})},['assetId']),async(a,s)=>{
        const asset=findAsset(s.userId,a.assetId,s.scope);
        if(!asset||!['video','audio'].includes(asset.kind))throw new Error('声音素材不存在或不属于当前工作空间');
        if(!/^[a-f0-9]{64}$/.test(asset.sha256||'')){
          if(!inspectVideo.ensureDigest)throw new Error('无法确认素材内容，请重新添加素材');
          const digest=await inspectVideo.ensureDigest(s.userId,asset);
          if(!/^[a-f0-9]{64}$/.test(digest||''))throw new Error('无法确认素材内容，请重新添加素材');
          asset.sha256=digest;
        }
        const metadata=await inspectVideo.audioInfo(s.userId,asset);
        if(!metadata.hasAudio)throw new Error('这份素材没有可识别的声音');
        if(metadata.durationSeconds===null)throw new Error('无法确认声音时长，请换一份素材');
        const startSeconds=Math.round((a.startSeconds||0)*1000)/1000;
        const endSeconds=Math.round((a.endSeconds??Math.min(metadata.durationSeconds,startSeconds+300))*1000)/1000;
        if(!Number.isFinite(endSeconds)||endSeconds<=startSeconds||endSeconds-startSeconds>300||(metadata.durationSeconds!==null&&endSeconds>metadata.durationSeconds+0.05))throw new Error('请选择素材范围内最多 300 秒的声音');
        const language=a.language||'zh-CN';
        const cached=sourceTranscriptsFor(s,asset.id).find(item=>item.sourceSha256===asset.sha256&&item.modelId==='nova-3'&&item.language===language&&Math.abs(item.startSeconds-startSeconds)<0.002&&Math.abs(item.endSeconds-endSeconds)<0.002);
        if(cached)return {...transcriptSummary(cached),textPreview:cached.text.slice(0,600),cached:true};
        if(sourceTranscriptsFor(s).length>=100)throw new Error('当前项目保存的台词记录过多，请先整理已有内容');
        const result=await inspectVideo.transcribe(s.userId,asset,{startSeconds,endSeconds,language});
        const record={...result,assetId:asset.id,assetName:asset.name,sourceSha256:asset.sha256,updatedAt:Date.now()};
        if(s.agentProjectId&&transcriptStore)transcriptStore.write(s,record);
        else{s.doc.sourceTranscripts ||= [];s.doc.sourceTranscripts=[...s.doc.sourceTranscripts.filter(item=>!(item.assetId===asset.id&&item.language===language&&item.startSeconds===startSeconds&&item.endSeconds===endSeconds)),record].slice(-100);}
        return {...transcriptSummary(record),textPreview:record.text.slice(0,600),cached:false};
      });
      add('source_transcript_read','按原片时间读取已保存的台词、逐词起止、置信度、说话人和字幕建议。没有记录时先使用 audio_transcribe。',object({assetId:string('视频或音频素材 ID'),startSeconds:number('读取起点秒数，默认 0',0,3600),endSeconds:number('读取终点秒数；单次最多 90 秒',0,3600)},['assetId']),async(a,s)=>{
        const asset=findAsset(s.userId,a.assetId,s.scope);
        if(!asset||!['video','audio'].includes(asset.kind))throw new Error('声音素材不存在或不属于当前工作空间');
        const startSeconds=a.startSeconds||0,endSeconds=a.endSeconds??startSeconds+60;
        if(endSeconds<=startSeconds||endSeconds-startSeconds>90)throw new Error('每次读取的台词范围最多 90 秒');
        const stored=sourceTranscriptsFor(s,asset.id).filter(item=>item.sourceSha256===asset.sha256&&item.endSeconds>startSeconds&&item.startSeconds<endSeconds);
        const ranges=new Map();
        for(const item of stored){const key=`${item.startSeconds}:${item.endSeconds}`;if(!ranges.has(key)||(ranges.get(key).updatedAt||0)<(item.updatedAt||0))ranges.set(key,item);}
        const records=[...ranges.values()].sort((left,right)=>(right.updatedAt||0)-(left.updatedAt||0));
        if(!records.length)return {assetId:asset.id,availableRanges:[],words:[],cues:[],note:'这段声音尚未转录'};
        const distinct=items=>[...new Map(items.map(item=>[`${item.startSeconds}:${item.endSeconds}:${item.text}`,item])).values()].sort((left,right)=>left.startSeconds-right.startSeconds);
        const current=[],newerRanges=[];
        for(const record of records){
          const visible=item=>{
            const midpoint=(item.startSeconds+item.endSeconds)/2;
            return item.endSeconds>startSeconds&&item.startSeconds<endSeconds&&!newerRanges.some(range=>midpoint>=range.startSeconds&&midpoint<range.endSeconds);
          };
          current.push({words:(record.words||[]).filter(visible),cues:(record.cues||[]).filter(visible)});
          newerRanges.push({startSeconds:record.startSeconds,endSeconds:record.endSeconds});
        }
        const words=distinct(current.flatMap(item=>item.words));
        const cues=distinct(current.flatMap(item=>item.cues));
        return {assetId:asset.id,startSeconds,endSeconds,availableRanges:records.map(item=>({startSeconds:item.startSeconds,endSeconds:item.endSeconds,language:item.language})),words:words.slice(0,300),cues:cues.slice(0,80),truncated:words.length>300||cues.length>80,note:'这是语音识别结果。专名、数字和说话人仍需结合原片核对。'};
      });
    }
    if(inspectVideo.compose)add('video_compose','用户已授权制作且视频片段准备好后，按顺序合成成片。只有方案需要时才混合已有的独立配音、音乐或音效；可逐段调整或关闭视频原声。最多 20 段、300 秒、8 条独立音轨。',object({clips:{type:'array',description:'按播放顺序排列的视频片段',maxItems:20,items:object({assetId:string('视频素材 ID'),startSeconds:number('源视频起点秒数，默认 0',0,3600),endSeconds:number('源视频终点秒数',0,3600),sourceAudioGainDb:number('原声音量 dB，默认 0',-60,12),muteSourceAudio:{type:'boolean',description:'是否关闭该片段原声，默认否'}},['assetId'])},aspectRatio:string('成片画幅',{enum:['9:16','16:9','1:1']}),audioTracks:{type:'array',description:'独立音轨，最多 8 条；所有位置使用成片时间轴',maxItems:8,items:object({assetId:string('音频素材 ID'),role:string('声音用途',{enum:['voice','music','effect','ambience']}),atSeconds:number('在成片中开始的秒数',0,300),sourceStartSeconds:number('音频素材起点秒数，默认 0',0,3600),sourceEndSeconds:number('音频素材终点秒数',0,3600),gainDb:number('音量 dB，默认 0',-60,12),fadeInSeconds:number('淡入秒数，默认 0',0,30),fadeOutSeconds:number('淡出秒数，默认 0',0,30)},['assetId','role','atSeconds','sourceEndSeconds'])}},['clips','aspectRatio']),async(a,s,invocation)=>{
      if(!a.clips.length)throw new Error('请至少选择一段视频');
      const cached=(s.doc.compositions||[]).find(item=>item.invocationId===invocation.id);
      if(cached){const existing=findAsset(s.userId,cached.assetId,s.scope);if(existing)return publicAsset(existing);}
      const clips=a.clips.map(clip=>{
        const asset=findAsset(s.userId,clip.assetId,s.scope);
        if(!asset||asset.kind!=='video')throw new Error('视频片段不存在或不属于当前工作空间');
        return {asset,startSeconds:clip.startSeconds,endSeconds:clip.endSeconds,sourceAudioGainDb:clip.sourceAudioGainDb??0,muteSourceAudio:clip.muteSourceAudio||false};
      });
      const audioTracks=(a.audioTracks||[]).map(track=>{
        const asset=findAsset(s.userId,track.assetId,s.scope);
        if(!asset||asset.kind!=='audio')throw new Error('独立音轨需要使用当前工作空间的音频素材');
        return {asset,role:track.role,atSeconds:track.atSeconds,sourceStartSeconds:track.sourceStartSeconds??0,sourceEndSeconds:track.sourceEndSeconds,gainDb:track.gainDb??0,fadeInSeconds:track.fadeInSeconds??0,fadeOutSeconds:track.fadeOutSeconds??0};
      });
      const output=await inspectVideo.compose(s.userId,s.scope,clips,{aspectRatio:a.aspectRatio,audioTracks,id:invocation.id});
      s.doc.compositions ||= [];
      if(!s.doc.compositions.some(item=>item.assetId===output.id))s.doc.compositions.push({assetId:output.id,invocationId:invocation.id,sourceAssetIds:[...clips.map(item=>item.asset.id),...audioTracks.map(item=>item.asset.id)],clips:clips.map(({asset,...fields})=>({assetId:asset.id,...fields})),audioTracks:audioTracks.map(({asset,...fields})=>({assetId:asset.id,...fields})),durationSeconds:output.duration,aspectRatio:a.aspectRatio,createdAt:Date.now()});
      s.doc.compositions=s.doc.compositions.slice(-20);
      return publicAsset(output);
    });
    if(inspectVideo.caption)add('video_caption_burn','仅在用户选择目标片字幕后使用。将完成混音的视频逐段转录并核对，再按真实语音时间烧录普通或逐词字幕；识别错误可用 corrections 修正。',object({assetId:string('完成混音的视频素材 ID'),style:string('字幕样式',{enum:['plain','karaoke']}),corrections:{type:'array',description:'按原字幕起止时间修正专名、数字或断句；最多 100 条',maxItems:100,items:object({startSeconds:number('原字幕起点秒数',0,3600),endSeconds:number('原字幕终点秒数',0,3600),text:string('修正后的字幕文字',{maxLength:160})},['startSeconds','endSeconds','text'])}},['assetId']),async(a,s,invocation)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='video')throw new Error('成片视频不存在或不属于当前工作空间');
      const cached=(s.doc.compositions||[]).find(item=>item.invocationId===invocation.id);
      if(cached){const existing=findAsset(s.userId,cached.assetId,s.scope);if(existing)return publicAsset(existing);}
      const metadata=await inspectVideo.probe(s.userId,asset);
      if(metadata.durationSeconds===null||metadata.durationSeconds>300)throw new Error('字幕成片最多支持 300 秒');
      const stored=sourceTranscriptsFor(s,asset.id).filter(item=>item.sourceSha256===asset.sha256);
      const ranges=new Map();
      for(const record of stored){const key=`${record.startSeconds}:${record.endSeconds}`;if(!ranges.has(key)||(ranges.get(key).updatedAt||0)<(record.updatedAt||0))ranges.set(key,record);}
      const records=[...ranges.values()].sort((left,right)=>left.startSeconds-right.startSeconds);
      let covered=0;
      for(const record of records){if(record.startSeconds>covered+0.25)break;covered=Math.max(covered,record.endSeconds);}
      if(!records.length||covered<metadata.durationSeconds-0.25)throw new Error('请先把成片的声音完整转录，再烧录字幕');
      const cues=[],newerRanges=[];
      for(const record of [...records].sort((left,right)=>(right.updatedAt||0)-(left.updatedAt||0))){
        for(const cue of record.cues||[]){
          const midpoint=(cue.startSeconds+cue.endSeconds)/2;
          if(newerRanges.some(range=>midpoint>=range.startSeconds&&midpoint<range.endSeconds))continue;
          cues.push({...cue,words:(record.words||[]).filter(word=>word.startSeconds>=cue.startSeconds-0.05&&word.startSeconds<cue.endSeconds)});
        }
        newerRanges.push({startSeconds:record.startSeconds,endSeconds:record.endSeconds});
      }
      cues.sort((left,right)=>left.startSeconds-right.startSeconds);
      if(!cues.length)throw new Error('这段成片没有识别到可以烧录的台词');
      const corrected=new Set();
      for(const correction of a.corrections||[]){
        const cue=cues.find(item=>Math.abs(item.startSeconds-correction.startSeconds)<0.05&&Math.abs(item.endSeconds-correction.endSeconds)<0.05);
        if(!cue||corrected.has(cue))throw new Error('需要修正的字幕时间不存在或重复');
        const text=correction.text.trim();
        if(!text)throw new Error('修正后的字幕不能为空');
        cue.text=text;
        cue.words=[];
        corrected.add(cue);
      }
      const output=await inspectVideo.caption(s.userId,s.scope,asset,cues,{style:a.style||'plain',id:invocation.id});
      s.doc.compositions ||= [];
      if(!s.doc.compositions.some(item=>item.assetId===output.id))s.doc.compositions.push({assetId:output.id,invocationId:invocation.id,sourceAssetIds:[asset.id],captionSourceAssetId:asset.id,captionStyle:a.style||'plain',captionCorrections:a.corrections||[],captionCount:cues.length,durationSeconds:output.duration,createdAt:Date.now()});
      s.doc.compositions=s.doc.compositions.slice(-20);
      return {...publicAsset(output),captionCount:cues.length};
    });
    const observationEvent=object({
      startSeconds:number('原片起点秒数',0,3600),endSeconds:number('原片终点秒数',0,3600),
      category:string('观察类型',{enum:['visual','technical','speech','sound']}),
      fact:string('可核对的原片事实',{maxLength:500}),
      interpretation:string('这一细节对视频的作用，可留空',{maxLength:500}),
      source:string('依据来源',{enum:['frame','boundary','probe','transcript','user']}),
      evidenceTimes:{type:'array',items:number('原片证据秒数',0,3600),maxItems:8},
      confidence:string('判断把握',{enum:['high','medium','unverified']}),
    },['startSeconds','endSeconds','category','fact','source','confidence']);
    add('source_observation_read','读取当前项目对一条参考视频保存的原片观察、证据与版本。修改前先读取。',object({assetId:string('参考视频素材 ID')},['assetId']),async(a,s)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='video')throw new Error('视频素材不存在或不属于当前工作空间');
      const current=sourceObservationFor(s,asset.id);
      if(current&&current.sourceSha256!==asset.sha256)throw new Error('原片内容已改变，请重新分析');
      if(!current)return {assetId:asset.id,assetName:asset.name,sourceSha256:asset.sha256,revision:0,overview:'',events:[]};
      const {lastInvocation,...visible}=current;
      return visible;
    });
    add('source_observation_write','保存可校正的原片事实与时间证据。画面引用已读取的帧，台词引用已转录的时间点；不能从画面猜原片声音。',object({assetId:string('参考视频素材 ID'),expectedRevision:number('当前观察版本；首次为 0',0,100000),overview:string('全片概览',{maxLength:4000}),events:{type:'array',description:'时间化原片事实，最多 40 条',items:observationEvent,maxItems:40}},['assetId','expectedRevision','overview','events']),async(a,s,invocation)=>{
      const asset=findAsset(s.userId,a.assetId,s.scope);
      if(!asset||asset.kind!=='video')throw new Error('视频素材不存在或不属于当前工作空间');
      const current=sourceObservationFor(s,asset.id);
      if(current?.lastInvocation===invocation.id)return {assetId:asset.id,revision:current.revision,eventCount:current.events.length,overview:current.overview};
      if(current&&current.sourceSha256!==asset.sha256)throw new Error('原片内容已改变，请重新分析');
      if((current?.revision||0)!==a.expectedRevision)throw new Error('原片分析已更新，请读取最新版本再修改');
      const metadata=s.doc.videoProbes?.[asset.id]||await inspectVideo.probe(s.userId,asset);
      const duration=metadata.durationSeconds;
      const evidence=s.doc.frameEvidence||[];
      for(const event of a.events){
        const retained=current?.events?.some(previous=>JSON.stringify(previous)===JSON.stringify({...event,interpretation:event.interpretation||'',evidenceTimes:event.evidenceTimes||[]}));
        if(event.endSeconds<event.startSeconds||(duration!==null&&event.endSeconds>duration+0.05))throw new Error('观察时间超出原片范围');
        if(!event.fact.trim())throw new Error('原片事实不能为空');
        if(retained)continue;
        if(event.category==='sound'&&event.source!=='user')throw new Error('转录不能确认音效或音乐，请标为用户描述');
        if(event.category==='speech'&&!['user','transcript'].includes(event.source))throw new Error('原片台词需要引用转录结果或用户描述');
        if(event.source==='transcript'){
          const words=sourceTranscriptsFor(s,asset.id).filter(item=>item.sourceSha256===asset.sha256).flatMap(item=>item.words);
          if(event.category!=='speech'||!event.evidenceTimes?.length||event.evidenceTimes.some(time=>time<event.startSeconds-0.05||time>event.endSeconds+0.05||!words.some(word=>Math.abs(word.startSeconds-time)<0.05)))throw new Error('台词观察需要引用已转录的词句时间点');
        }
        if(event.source==='frame'){
          if(!event.evidenceTimes?.length||event.evidenceTimes.some(time=>time<event.startSeconds-0.05||time>event.endSeconds+0.05||!evidence.some(frame=>frame.assetId===asset.id&&Math.abs(frame.timeSeconds-time)<0.002)))throw new Error('画面观察需要引用已经读取的原片时间点');
        }
        if(event.source==='boundary'){
          if(event.category!=='technical'||!event.evidenceTimes?.length||event.evidenceTimes.some(time=>time<event.startSeconds-0.05||time>event.endSeconds+0.05||!s.doc.videoBoundaries?.[asset.id]?.some(value=>Math.abs(value-time)<0.002)))throw new Error('画面切换候选只能记录为已检测到的技术信息');
        }
        if(event.source==='probe'&&(event.category!=='technical'||!s.doc.videoProbes?.[asset.id]))throw new Error('请先读取原片信息，再记录技术信息');
        if(event.source==='user'&&event.confidence!=='unverified')throw new Error('用户描述需要标为待核对');
      }
      const record={assetId:asset.id,assetName:asset.name,sourceSha256:asset.sha256,revision:a.expectedRevision+1,overview:a.overview.trim(),events:a.events.map(event=>({...event,fact:event.fact.trim(),interpretation:event.interpretation?.trim()||'',evidenceTimes:event.evidenceTimes||[]})).sort((left,right)=>left.startSeconds-right.startSeconds),updatedAt:Date.now()};
      if(s.agentProjectId&&observationStore){
        if(!current&&sourceObservationsFor(s).length>=20)throw new Error('当前项目保存的参考视频过多');
        const saved=observationStore.write(s,record,a.expectedRevision,invocation.id);
        return {assetId:asset.id,revision:saved.revision,eventCount:saved.events.length,overview:saved.overview};
      }
      s.doc.sourceObservations ||= {};
      if(!current&&Object.keys(s.doc.sourceObservations).length>=20)throw new Error('当前对话保存的参考视频过多');
      s.doc.sourceObservations[asset.id]={...record,lastInvocation:invocation.id};
      return {assetId:asset.id,revision:record.revision,eventCount:record.events.length,overview:record.overview};
    });
  }
  registerVideoEditTools({ add, inspectVideo, findAsset, publicAsset, sourceTranscriptsFor, compositionsFor });
  add('documents_write', '创建或修改文字作品，例如剧本、分镜表、方案、小说、提示词。修改需要当前文档 revision，原版本保留。普通聊天无需保存为文档。', object({ id: string('留空创建'), title: string('作品标题', { maxLength: 160 }), text: string('完整正文', { maxLength: 60000 }), expectedRevision: number('修改时的当前版本', 1) }, ['title', 'text']), async (a, s, invocation) => {
    const id = a.id || `doc-${invocation.id}`;
    let doc = s.doc.documents.find(d => d.id === id);
    const project = s.projectId ? await loadProject(s.userId, s.projectId, s.scope) : null;
    if (project?.directorWorkspace?.lockedIds?.includes(id)) throw new Error('该作品已锁定');
    if (doc?.lastInvocation === invocation.id) return { id, revision: doc.revision, title: doc.title };
    if (a.id && !doc) throw new Error('文档不存在');
    if (doc && doc.revision !== a.expectedRevision) throw new Error('文档已更新，请读取最新版本再修改');
    if (JSON.stringify(s.doc.documents).length + a.text.length > 3000000) throw new Error('当前对话文稿容量已满，请下载保存后开始新的创作');
    if (!doc) { if (s.doc.documents.length >= 100) throw new Error('当前对话作品数量已达上限'); doc = { id, revision: 0, versions: [] }; s.doc.documents.push(doc); }
    if (doc.revision) doc.versions = [...doc.versions, { revision: doc.revision, title: doc.title, text: doc.text }].slice(-20);
    Object.assign(doc, { title: a.title, text: a.text, revision: doc.revision + 1, lastInvocation: invocation.id });
    return { id, revision: doc.revision, title: doc.title };
  });
  const dataFields = { name: string('资源名称'), type: string('资源类别', { enum: ['character', 'location', 'prop'] }), description: string('资源说明'), title: string('镜头标题'), script: string('剧本/台词'), prompt: string('生成描述'), duration: number('时长', 1, 60), resourceIds: strings('关联资源 ID'), referenceAssetIds: strings('参考素材 ID'), assetMentions, startState:string('本镜起始状态'), endState:string('本镜结束状态'), continuityNotes:string('承接上一镜的人物、空间、道具与动作要求') };
  add('project_edit', '修改当前剧本，或创建/修改角色资源、分镜节点。仅改动指定字段；先读取最新项目版本，不重建整个项目。', object({ expectedRevision: number('当前项目 revision', 1), operation: string('编辑类型', { enum: ['write_script', 'add_resource', 'update_resource', 'add_shot', 'update_shot'] }), targetId: string('更新对象 ID'), data: object(dataFields) }, ['expectedRevision', 'operation', 'data']), async (a, s, invocation) => {
    if (!s.projectId) throw new Error('当前对话未绑定画布项目；可以使用 documents_write');
    const p = await loadProject(s.userId, s.projectId, s.scope);
    if (!p) throw new Error('项目不存在');
    if (p.agentAppliedOperations?.includes(invocation.id)) return { project: publicProject(p) };
    if (p.revision !== a.expectedRevision) throw new Error('项目已发生修改，请读取最新版本');
    if (a.operation === 'write_script') {
      if (p.directorWorkspace?.lockedIds?.includes('story')) throw new Error('剧本已锁定');
      if (typeof a.data.script !== 'string') throw new Error('需要 script 正文');
      p.script = a.data.script;
    } else {
      if (a.operation.endsWith('shot') && (a.data.prompt !== undefined || a.data.assetMentions)) {
        const refs = prepareAgentReferences({...a.data,prompt:a.data.prompt || ''},s.doc.referenceBindings,id=>findAsset(s.userId,id,s.scope));
        if (refs.references.length) Object.assign(a.data,{referenceAssetIds:refs.input.referenceAssetIds,assetMentions:refs.mentions});
      }
      applyDirectorEdit(p, { type: a.operation, targetId: a.targetId, data: a.data }, () => `node-${invocation.id}`);
    }
    p.agentAppliedOperations = [...(p.agentAppliedOperations || []), invocation.id].slice(-200);
    await saveProject(s.userId, p);
    return { project: publicProject(p) };
  });
  const midjourney = object({ aspectRatio: string('比例'), version: string('版本'), quality: string('质量'), stylize: number('风格化', 0, 1000), chaos: number('变化', 0, 100), weird: number('奇异', 0, 3000), seed: number('种子', 0, 4294967295), imageWeight: number('参考权重', 0, 3), negativePrompt: string('排除内容'), tile: { type: 'boolean' }, raw: { type: 'boolean' }, draft: { type: 'boolean' } });
  add('media_prepare', '预检图像/视频请求并返回准确报价，不扣费。先查 models_describe，使用其支持的参数。描述主动用 @名称 指定素材职责，通过 assetMentions 或 references_bind 绑定，平台转换为与实际上传顺序一致的编号。生成结果自动成为画布作品。', object({ type: string('媒体类型', { enum: ['image', 'video'] }), modelId: string('平台模型 ID'), prompt: string('提示词', { maxLength: 10000 }), size: string('图片尺寸或比例，按模型说明'), quality: string('按模型说明填写'), duration: number('视频秒数', 1, 60), aspectRatio: string('视频比例'), generationType: string('视频模式', { enum: ['TEXT', 'REFERENCE', 'FIRST&LAST'] }), referenceAssetIds: strings('有序参考素材 ID；首尾帧模式先首帧后尾帧'), assetMentions, quantity: number('数量；Midjourney 为4或8', 1, 10), midjourneyOptions: midjourney }, ['type', 'modelId', 'prompt']), async (a, s, invocation) => {
    assertPreferredModel(s, a);
    const references = prepareAgentReferences(a,s.doc.referenceBindings,findAsset ? id=>findAsset(s.userId,id,s.scope) : undefined);
    const project = s.projectId ? await loadProject(s.userId,s.projectId,s.scope) : null;
    if (s.projectId && !project) throw new Error('短剧项目不存在');
    const input = { ...references.input, ...(project ? {dramaProjectId:project.id,dramaStyleRevision:project.style?.revision || 0}:{}), requestId: `ag-${invocation.id}` };
    const result = await generate({ user: { id: s.userId }, scope: s.scope, input, previewOnly: true });
    if (result.status >= 400) throw new Error(result.data.error);
    const id = `prepared-${invocation.id}`;
    s.doc.prepared ||= {};
    if (Object.keys(s.doc.prepared).length > 100) throw new Error('准备的生成请求过多，请完成现有请求');
    s.doc.prepared[id] ||= { input, displayPrompt:references.displayPrompt, references:references.references, quote: result.data, createdAt: Date.now() };
    return { preparedRequestId: id, ...result.data, prompt:references.displayPrompt, references:references.references };
  });
  add('media_submit', '提交已预检的生成请求，会消耗所报价积分。同一条 assistant 正文先向用户说明分析结论或已确认要求、本次具体生成内容及用途，再调用；只有工具调用而没有正文时不会提交或弹出确认。需要时系统自动请求用户确认。返回任务 ID 后使用 jobs_wait 等待。', object({ preparedRequestId: string('media_prepare 返回的 ID') }, ['preparedRequestId']), async (a, s) => {
    const prepared = s.doc.prepared?.[a.preparedRequestId];
    if (!prepared) throw new Error('准备请求不存在');
    if (prepared.result) return prepared.result;
    assertPreferredModel(s, prepared.input);
    const result = await generate({ user: { id: s.userId }, scope: s.scope, input: prepared.input, maxCostMicro: prepared.quote.costMicro });
    if (result.status >= 400) throw new Error(result.data.error);
    const tasks = result.data.tasks || [result.data];
    for (const [index,task] of tasks.entries()) if (!s.doc.generations.some(g => g.id === task.id)) s.doc.generations.push({ id: task.id, canvasId:`${a.preparedRequestId}-${index}`,batchId:a.preparedRequestId,index,createdAt:prepared.createdAt,aspectRatio:prepared.input.midjourneyOptions?.aspectRatio||prepared.input.aspectRatio||prepared.input.size||prepared.quote.size,title: prepared.input.prompt.slice(0, 100), type: prepared.input.type, modelId: prepared.input.modelId });
    s.doc.mediaSpentMicro = (s.doc.mediaSpentMicro || 0) + prepared.quote.costMicro;
    prepared.result = { jobIds: tasks.map(t => t.id), credits: prepared.quote.credits, status: 'queued' };
    return prepared.result;
  }, { paid: true });
  add('jobs_wait', '等待当前工作空间的媒体任务完成。后台会保存并恢复对话，无需反复查询。完成后返回真实 assetId；失败不会自动再次生成。', object({ jobIds: strings('要等待的任务 ID') }, ['jobIds']), async (a, s) => {
    if (!a.jobIds.length) throw new Error('请选择要等待的任务');
    const tasks = a.jobIds.map(id => findGeneration(s.userId, id, s.scope));
    if (tasks.some(t => !t)) throw new Error('任务不存在或不属于当前工作空间');
    if (tasks.some(t => ['queued', 'running'].includes(t.status))) return { wait: true };
    return tasks.map(jobSummary);
  }, { waits: true });
  return {
    definitions: () => [...registry.values()].map(t => t.definition),
    async execute(name, args, session, invocation) {
      const tool = registry.get(name);
      if (!tool) throw new Error('工具不存在，请使用已提供的工具');
      validateToolInput(args, tool.definition.function.parameters);
      return tool.execute(args, session, invocation);
    },
    get: name => registry.get(name),
    async images(session) {
      const images = [];
      for (const id of session.doc.imageIds || []) {
        const asset = findAsset(session.userId, id, session.scope);
        if (asset?.kind === 'image') {
          const url = await inspectImage(asset, session.userId);
          if (!url) throw new Error('这张图片暂时无法读取，请稍后重试或重新添加图片。');
          images.push({ type: 'text', text: `图片素材 ${asset.id}` });
          images.push({ type: 'image_url', image_url: { url, detail: 'low' } });
        }
      }
      for(const frame of session.doc.frameImages||[]){
        images.push({type:'text',text:`视频素材 ${frame.assetId} 在 ${frame.timeSeconds} 秒处的画面`});
        images.push({type:'image_url',image_url:{url:frame.imageUrl,detail:'low'}});
      }
      return images;
    },
  };
}
