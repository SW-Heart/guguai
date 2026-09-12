import { applyDirectorEdit } from '../../public/features/drama/director-actions.js';

const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const strings = description => ({ type: 'array', description, items: { type: 'string' }, maxItems: 50 });
const number = (description, minimum = 0, maximum = 100000) => ({ type: 'number', description, minimum, maximum });
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

export function createAgentTools({ skills, catalog, generate, loadProject, saveProject, publicProject, findAsset, publicAsset, listAssets, findGeneration, inspectImage }) {
  const registry = new Map();
  function add(name, description, parameters, execute, options = {}) {
    registry.set(name, { definition: { type: 'function', function: { name, description, parameters } }, execute, ...options });
  }
  add('skills_search', '寻找适合当前任务的创作方法；没有相关技能也可以直接对话或组合工具。', object({ query: string('创作需求') }), async a => skills.search(a.query));
  add('skills_read', '读取已发现技能的完整说明或参考资料。', object({ name: string('技能名称'), resource: string('默认为 SKILL.md；也可读取 references/ 或 assets/ 下的文件') }, ['name']), async (a, s) => {
    const result = await skills.read(a.name, a.resource);
    s.doc.loadedSkills ||= {};
    s.doc.loadedSkills[`${a.name}/${a.resource || 'SKILL.md'}`] = result.text;
    return result;
  });
  add('models_list', '列出平台当前启用的图像、视频模型。生成前先发现模型，再读取模型参数。', object({ kind: string('可选筛选', { enum: ['image', 'video'] }) }), async a => (await catalog()).filter(m => !a.kind || m.kind === a.kind).map(({ id, label, kind, description }) => ({ id, label, kind, description })));
  add('models_describe', '读取模型的真实模式、时长、尺寸、质量及参考素材限制。不得根据名称猜参数。', object({ modelId: string('models_list 返回的 ID') }, ['modelId']), async a => {
    const model = (await catalog()).find(m => m.id === a.modelId);
    if (!model) throw new Error('这个模型当前不可用，请重新查询模型列表');
    return model;
  });
  add('workspace_read', '读取当前作品和文档目录。编辑前读取最新 revision，文档正文用 documents_read。', object({}), async (_a, s) => {
    const p = s.projectId ? await loadProject(s.userId, s.projectId, s.scope) : null;
    return { project: p ? { id:p.id,revision:p.revision,script:p.script,resources:p.resources,shots:p.shots,lockedIds:p.directorWorkspace?.lockedIds } : null, documents: s.doc.documents.map(({id,title,revision})=>({id,title,revision})), generations: s.doc.generations.slice(-60), selectedIds: s.doc.selection || [] };
  });
  add('documents_read', '读取文字作品正文和当前版本。长文可按 offset 分段读取。', object({ id:string('文档 ID'), offset:number('起始字符位置',0,60000) }, ['id']), async (a,s) => {
    const d=s.doc.documents.find(item=>item.id===a.id);if(!d)throw new Error('文档不存在');
    const offset=Math.floor(a.offset||0);return {id:d.id,title:d.title,revision:d.revision,text:d.text.slice(offset,offset+20000),nextOffset:offset+20000<d.text.length?offset+20000:null};
  });
  add('assets_search', '查询当前工作空间可用素材。只能使用工具返回的真实素材 ID。', object({ query: string('按素材名称筛选') }), async (a, s) => {
    const page = listAssets(s.userId, { ...s.scope, limit: 100 });
    return page.items.filter(item => !a.query || String(item.name || '').includes(a.query)).slice(0, 40).map(publicAsset);
  });
  add('assets_inspect', '读取素材信息。图片会作为视觉输入提供给下一次模型调用；视频这里只能读取元信息，不能宣称已观看。', object({ assetId: string('素材 ID') }, ['assetId']), async (a, s) => {
    const asset = findAsset(s.userId, a.assetId, s.scope);
    if (!asset) throw new Error('素材不存在或不属于当前工作空间');
    if (asset.kind === 'image') {
      if (!await inspectImage(asset)) throw new Error('这张图片尚未上传，暂时无法读取视觉内容');
      s.doc.imageIds = [...new Set([...(s.doc.imageIds || []), asset.id])].slice(-4);
    }
    return publicAsset(asset);
  });
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
  const dataFields = { name: string('资源名称'), type: string('资源类别', { enum: ['character', 'location', 'prop'] }), description: string('资源说明'), title: string('镜头标题'), script: string('剧本/台词'), prompt: string('生成描述'), duration: number('时长', 1, 60), resourceIds: strings('关联资源 ID'), referenceAssetIds: strings('参考素材 ID') };
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
      applyDirectorEdit(p, { type: a.operation, targetId: a.targetId, data: a.data }, () => `node-${invocation.id}`);
    }
    p.agentAppliedOperations = [...(p.agentAppliedOperations || []), invocation.id].slice(-200);
    await saveProject(s.userId, p);
    return { project: publicProject(p) };
  });
  const midjourney = object({ aspectRatio: string('比例'), version: string('版本'), quality: string('质量'), stylize: number('风格化', 0, 1000), chaos: number('变化', 0, 100), weird: number('奇异', 0, 3000), seed: number('种子', 0, 4294967295), imageWeight: number('参考权重', 0, 3), negativePrompt: string('排除内容'), tile: { type: 'boolean' }, raw: { type: 'boolean' }, draft: { type: 'boolean' } });
  add('media_prepare', '预检图像/视频请求并返回准确报价，不扣费。先查 models_describe，使用其支持的参数。生成结果自动成为画布作品。', object({ type: string('媒体类型', { enum: ['image', 'video'] }), modelId: string('平台模型 ID'), prompt: string('提示词', { maxLength: 10000 }), size: string('图片尺寸或比例，按模型说明'), quality: string('按模型说明填写'), duration: number('视频秒数', 1, 60), aspectRatio: string('视频比例'), generationType: string('视频模式', { enum: ['TEXT', 'REFERENCE', 'FIRST&LAST'] }), referenceAssetIds: strings('有序参考素材 ID；首尾帧模式先首帧后尾帧'), quantity: number('数量；Midjourney 为4或8', 1, 10), midjourneyOptions: midjourney }, ['type', 'modelId', 'prompt']), async (a, s, invocation) => {
    const input = { ...a, requestId: `ag-${invocation.id}` };
    const result = await generate({ user: { id: s.userId }, scope: s.scope, input, previewOnly: true });
    if (result.status >= 400) throw new Error(result.data.error);
    const id = `prepared-${invocation.id}`;
    s.doc.prepared ||= {};
    if (Object.keys(s.doc.prepared).length > 100) throw new Error('准备的生成请求过多，请完成现有请求');
    s.doc.prepared[id] ||= { input, quote: result.data, createdAt: Date.now() };
    return { preparedRequestId: id, ...result.data };
  });
  add('media_submit', '提交已预检的生成请求，会消耗所报价积分。需要时系统自动请求用户确认。返回任务 ID 后使用 jobs_wait 等待。', object({ preparedRequestId: string('media_prepare 返回的 ID') }, ['preparedRequestId']), async (a, s) => {
    const prepared = s.doc.prepared?.[a.preparedRequestId];
    if (!prepared) throw new Error('准备请求不存在');
    if (prepared.result) return prepared.result;
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
    return tasks.map(t => ({ id: t.id, status: t.status, assetId: t.assetId, error: t.error ? '生成失败，请检查参数或稍后重试' : '' }));
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
        if (asset?.kind === 'image') { const url = await inspectImage(asset); if (url) images.push({ type: 'image_url', image_url: { url, detail: 'low' } }); }
      }
      return images;
    },
  };
}
