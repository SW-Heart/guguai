import { generationFrames } from '../public/features/agent/frames.js';
import { defaultTitleFromMessage } from '../public/features/agent/default-title.js';
import { normalizeDirectorWorkspace } from '../public/features/drama/director-actions.js';
import { randomUUID } from 'node:crypto';

export const AGENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '',
 agent_project_id TEXT NOT NULL DEFAULT '',
 settings_json TEXT NOT NULL, doc_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle',
 wake_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 interrupted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_scope ON agent_sessions(user_id, device_id, workspace_id, project_id);
CREATE TABLE IF NOT EXISTS agent_inputs (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
 client_id TEXT NOT NULL, text TEXT NOT NULL, selection_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(session_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_inputs_session ON agent_inputs(session_id, seq);
CREATE TABLE IF NOT EXISTS agent_canvases (
 session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
 data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_projects (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_projects_scope ON agent_projects(user_id,device_id,workspace_id,updated_at);
CREATE TABLE IF NOT EXISTS agent_project_canvases (
 project_id TEXT PRIMARY KEY REFERENCES agent_projects(id) ON DELETE CASCADE,
 data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_source_observations (
 project_id TEXT NOT NULL REFERENCES agent_projects(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL, source_sha256 TEXT NOT NULL,
 revision INTEGER NOT NULL, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,asset_id)
);
CREATE TABLE IF NOT EXISTS agent_source_transcripts (
 project_id TEXT NOT NULL REFERENCES agent_projects(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL, range_start_ms INTEGER NOT NULL, range_end_ms INTEGER NOT NULL,
 source_sha256 TEXT NOT NULL, model_id TEXT NOT NULL, language TEXT NOT NULL,
 data_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,asset_id,range_start_ms,range_end_ms,language)
);
CREATE INDEX IF NOT EXISTS idx_agent_source_transcripts_asset ON agent_source_transcripts(project_id,asset_id,range_start_ms);
`;

export function createAgentSessionRepository({ sql, tx }) {
  const messageTitle = value => {
    const text = String(value ?? '');
    return defaultTitleFromMessage(text.split(/\n\n(?:附件|附带文件)：\n/)[0]) || defaultTitleFromMessage(text);
  };
  const parse = row => row ? { id: row.id, userId: row.user_id, scope: { deviceId: row.device_id, workspaceId: row.workspace_id }, projectId: row.project_id, agentProjectId: row.agent_project_id || '', settings: JSON.parse(row.settings_json), doc: JSON.parse(row.doc_json), state: row.state, interrupted: Boolean(row.interrupted), token: row.lease_token, leaseUntil: row.lease_until } : null;
  const projectRow = row => row ? {id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,sessionId:row.session_id||''} : null;
  function getProject(id,userId,scope){return projectRow(sql('SELECT * FROM agent_projects WHERE id=:id AND user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId').get({id,userId,deviceId:scope.deviceId,workspaceId:scope.workspaceId}));}
  function createProject(userId,scope,title='新项目'){
    const id=randomUUID(),now=Date.now();
    sql('INSERT INTO agent_projects(id,user_id,device_id,workspace_id,title,created_at,updated_at) VALUES(:id,:userId,:deviceId,:workspaceId,:title,:now,:now)').run({id,userId,deviceId:scope.deviceId,workspaceId:scope.workspaceId,title:String(title||'新项目').trim().slice(0,80)||'新项目',now});
    return getProject(id,userId,scope);
  }
  function renameProject(id,userId,scope,title){
    // Keep updated_at unchanged so renaming does not reorder the sidebar list.
    const result=sql('UPDATE agent_projects SET title=:title WHERE id=:id AND user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId').run({id,userId,deviceId:scope.deviceId,workspaceId:scope.workspaceId,title});
    return result.changes?getProject(id,userId,scope):null;
  }
  function deleteProject(id,userId,scope){
    return tx(()=>{
      if(!getProject(id,userId,scope))return null;
      const params={id,userId,deviceId:scope.deviceId,workspaceId:scope.workspaceId};
      // agent_sessions has no FK to agent_projects; deleting sessions cascades their inputs and canvases,
      // deleting the project cascades its canvas, observations and transcripts.
      const sessionIds=sql('SELECT id FROM agent_sessions WHERE agent_project_id=:id AND user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId').all(params).map(row=>row.id);
      sql('DELETE FROM agent_sessions WHERE agent_project_id=:id AND user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId').run(params);
      sql('DELETE FROM agent_projects WHERE id=:id AND user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId').run(params);
      return {id,sessionIds};
    });
  }
  function listProjects(userId,scope){
    // Earlier standalone conversations become projects on first visit.
    tx(()=>{
      const legacy=sql("SELECT s.id,(SELECT text FROM agent_inputs WHERE session_id=s.id ORDER BY seq LIMIT 1) AS title FROM agent_sessions s WHERE s.user_id=:userId AND s.device_id=:deviceId AND s.workspace_id=:workspaceId AND s.project_id='' AND s.agent_project_id='' AND (EXISTS(SELECT 1 FROM agent_inputs WHERE session_id=s.id) OR EXISTS(SELECT 1 FROM agent_canvases WHERE session_id=s.id))").all({userId,deviceId:scope.deviceId,workspaceId:scope.workspaceId});
      for(const item of legacy){const project=createProject(userId,scope,messageTitle(item.title)||'旧对话');sql('UPDATE agent_sessions SET agent_project_id=:projectId WHERE id=:id').run({projectId:project.id,id:item.id});sql('INSERT INTO agent_project_canvases(project_id,data_json,revision,updated_at) SELECT :projectId,data_json,revision,updated_at FROM agent_canvases WHERE session_id=:id').run({projectId:project.id,id:item.id});}
    });
    return sql("SELECT p.*, (SELECT s.id FROM agent_sessions s WHERE s.agent_project_id=p.id ORDER BY s.updated_at DESC LIMIT 1) AS session_id, (SELECT text FROM agent_inputs i JOIN agent_sessions s ON s.id=i.session_id WHERE s.agent_project_id=p.id ORDER BY i.seq LIMIT 1) AS first_text, COALESCE((SELECT MAX(s.updated_at) FROM agent_sessions s WHERE s.agent_project_id=p.id),p.updated_at) AS activity_at FROM agent_projects p WHERE p.user_id=:userId AND p.device_id=:deviceId AND p.workspace_id=:workspaceId ORDER BY activity_at DESC,p.id DESC").all({userId,deviceId:scope.deviceId,workspaceId:scope.workspaceId}).map(row=>({...projectRow(row),title:row.title==='新项目'&&row.first_text?messageTitle(row.first_text)||row.title:row.title,updatedAt:row.activity_at}));
  }
  function get(id, userId, scope) {
    return parse(sql('SELECT * FROM agent_sessions WHERE id=:id AND user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId').get({ id, userId, deviceId: scope.deviceId, workspaceId: scope.workspaceId }));
  }
  function getForUser(id,userId){return parse(sql('SELECT * FROM agent_sessions WHERE id=:id AND user_id=:userId').get({id,userId}));}
  function create(userId, scope, projectId, settings, { fresh = false, agentProjectId = '' } = {}) {
    return tx(() => {
      if ((projectId||agentProjectId) && !fresh) {
        const existing = sql('SELECT * FROM agent_sessions WHERE user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId AND project_id=:projectId AND agent_project_id=:agentProjectId ORDER BY updated_at DESC LIMIT 1').get({ userId, deviceId: scope.deviceId, workspaceId: scope.workspaceId, projectId,agentProjectId });
        if (existing) return parse(existing);
      }
      const id = randomUUID();
      sql('INSERT INTO agent_sessions(id,user_id,device_id,workspace_id,project_id,agent_project_id,settings_json,doc_json,updated_at) VALUES(:id,:userId,:deviceId,:workspaceId,:projectId,:agentProjectId,:settings,:doc,:now)').run({ id, userId, deviceId: scope.deviceId, workspaceId: scope.workspaceId, projectId,agentProjectId, settings: JSON.stringify(settings), doc: JSON.stringify({ messages: [], documents: [], generations: [], lastInput: 0, activity: '', version: 0 }), now: Date.now() });
      return get(id, userId, scope);
    });
  }
  function list(userId, scope, projectId) {
    return sql('SELECT id,state,updated_at,(SELECT text FROM agent_inputs WHERE session_id=agent_sessions.id ORDER BY seq LIMIT 1) AS title FROM agent_sessions WHERE user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId AND project_id=:projectId AND EXISTS (SELECT 1 FROM agent_inputs WHERE session_id=agent_sessions.id) ORDER BY updated_at DESC,id DESC LIMIT 100').all({userId, deviceId:scope.deviceId, workspaceId:scope.workspaceId, projectId}).map(row => ({id:row.id, title:messageTitle(row.title) || '新对话', state:row.state, updatedAt:row.updated_at}));
  }
  function listProjectSessions(userId,scope,agentProjectId){return sql("SELECT s.id,s.state,s.updated_at,(SELECT text FROM agent_inputs WHERE session_id=s.id ORDER BY seq LIMIT 1) AS title FROM agent_sessions s WHERE s.user_id=:userId AND s.device_id=:deviceId AND s.workspace_id=:workspaceId AND s.agent_project_id=:agentProjectId AND EXISTS(SELECT 1 FROM agent_inputs WHERE session_id=s.id) ORDER BY s.updated_at DESC LIMIT 100").all({userId,deviceId:scope.deviceId,workspaceId:scope.workspaceId,agentProjectId}).map(row=>({id:row.id,title:messageTitle(row.title)||'新对话',state:row.state,updatedAt:row.updated_at}));}
  function artifacts(session) {
    const rows = sql('SELECT id,doc_json FROM agent_sessions WHERE user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId AND project_id=:projectId AND agent_project_id=:agentProjectId ORDER BY updated_at').all({userId:session.userId, deviceId:session.scope.deviceId, workspaceId:session.scope.workspaceId, projectId:session.projectId,agentProjectId:session.agentProjectId});
    const documents=[], generations=[], compositions=[];
    for(const row of rows){ const doc=JSON.parse(row.doc_json); documents.push(...doc.documents.map(d=>({...d,conversationId:row.id}))); generations.push(...generationFrames(doc)); compositions.push(...(doc.compositions||[])); }
    return {documents,generations,compositions};
  }
  function enqueue(session, input) {
    return tx(() => {
      const incomingDocuments=Array.isArray(input.documents)?input.documents.slice(0,10).map((item,index)=>({
        id:`upload-${input.clientId}-${index+1}`,
        title:String(item?.title||'附带文件').replace(/[\r\n\u0000-\u001f]/g,' ').trim().slice(0,160)||'附带文件',
        text:String(item?.text||''),
        source:'attachment',
      })).filter(item=>item.text):[];
      if(incomingDocuments.reduce((total,item)=>total+item.text.length,0)>1_000_000)throw Object.assign(new Error('附带文件内容过多，请减少文件数量或选择较小的文件'),{statusCode:413});
      const existing = sql('SELECT * FROM agent_inputs WHERE session_id=:id AND client_id=:clientId').get({ id: session.id, clientId: input.clientId });
      if (existing) {
        if (existing.text !== input.text || existing.selection_json !== JSON.stringify(input.selection || [])) throw Object.assign(new Error('同一消息不能使用不同内容重试'), { statusCode: 409 });
        const savedDocuments=session.doc.documents.filter(item=>item.source==='attachment'&&item.id.startsWith(`upload-${input.clientId}-`));
        if(savedDocuments.length!==incomingDocuments.length)throw Object.assign(new Error('同一消息不能使用不同文件重试'),{statusCode:409});
        for(const document of incomingDocuments){const saved=session.doc.documents.find(item=>item.id===document.id);if(!saved||saved.text!==document.text||saved.title!==document.title)throw Object.assign(new Error('同一消息不能使用不同文件重试'),{statusCode:409});}
        return;
      }
      let documentsChanged=false;
      for(const document of incomingDocuments){
        const saved=session.doc.documents.find(item=>item.id===document.id);
        if(saved){if(saved.text!==document.text||saved.title!==document.title)throw Object.assign(new Error('附带文件标识冲突，请重新添加'),{statusCode:409});continue;}
        session.doc.documents.push({...document,revision:1,versions:[]});documentsChanged=true;
      }
      if(JSON.stringify(session.doc.documents).length>3_000_000)throw Object.assign(new Error('附带文件内容过多，请减少文件数量或选择较小的文件'),{statusCode:413});
      sql('INSERT INTO agent_inputs(session_id,client_id,text,selection_json,created_at) VALUES(:id,:clientId,:text,:selection,:now)').run({ id: session.id, clientId: input.clientId, text: input.text, selection: JSON.stringify(input.selection || []), now: Date.now() });
      if(session.agentProjectId){
        const title=messageTitle(input.text);
        if(title)sql("UPDATE agent_projects SET title=:title WHERE id=:projectId AND user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId AND title='新项目' AND (SELECT COUNT(*) FROM agent_inputs i JOIN agent_sessions s ON s.id=i.session_id WHERE s.agent_project_id=:projectId)=1").run({title,projectId:session.agentProjectId,userId:session.userId,deviceId:session.scope.deviceId,workspaceId:session.scope.workspaceId});
      }
      if(documentsChanged)sql('UPDATE agent_sessions SET doc_json=:doc WHERE id=:id').run({id:session.id,doc:JSON.stringify(session.doc)});
      sql("UPDATE agent_sessions SET interrupted=0,state=CASE WHEN lease_until>:now THEN state ELSE 'queued' END,wake_at=0,updated_at=:now WHERE id=:id").run({ id: session.id, now: Date.now() });
    });
  }
  const inputs = session => sql('SELECT * FROM agent_inputs WHERE session_id=:id AND seq>:seq ORDER BY seq LIMIT 20').all({ id: session.id, seq: session.doc.lastInput || 0 });
  const messageInputs = session => sql('SELECT seq,client_id,text FROM agent_inputs WHERE session_id=:id AND seq<=:seq ORDER BY seq').all({ id: session.id, seq: session.doc.lastInput || 0 });
  function canvas(session) {
    const row = session.agentProjectId
      ? sql('SELECT data_json,revision FROM agent_project_canvases WHERE project_id=:id').get({id:session.agentProjectId})
      : sql('SELECT data_json,revision FROM agent_canvases WHERE session_id=:id').get({id:session.id});
    return row ? {...JSON.parse(row.data_json),revision:row.revision} : {directorWorkspace:null,assetIds:[],revision:0};
  }
  function saveCanvas(session, value) {
    const data = {directorWorkspace:normalizeDirectorWorkspace(value.directorWorkspace),assetIds:Array.isArray(value.assetIds)?[...new Set(value.assetIds.map(String).filter(id=>id.length>0&&id.length<=200))].slice(0,200):[]};
    if(session.agentProjectId)sql('INSERT INTO agent_project_canvases(project_id,data_json,revision,updated_at) VALUES(:id,:data,1,:now) ON CONFLICT(project_id) DO UPDATE SET data_json=:data,revision=revision+1,updated_at=:now').run({id:session.agentProjectId,data:JSON.stringify(data),now:Date.now()});
    else sql('INSERT INTO agent_canvases(session_id,data_json,revision,updated_at) VALUES(:id,:data,1,:now) ON CONFLICT(session_id) DO UPDATE SET data_json=:data,revision=revision+1,updated_at=:now').run({id:session.id,data:JSON.stringify(data),now:Date.now()});
    return canvas(session);
  }
  function readObservation(session,assetId){
    if(!session.agentProjectId||!getProject(session.agentProjectId,session.userId,session.scope))return null;
    const row=sql('SELECT data_json FROM agent_source_observations WHERE project_id=:projectId AND asset_id=:assetId').get({projectId:session.agentProjectId,assetId});
    return row?JSON.parse(row.data_json):null;
  }
  function listObservations(session){
    if(!session.agentProjectId||!getProject(session.agentProjectId,session.userId,session.scope))return [];
    return sql('SELECT data_json FROM agent_source_observations WHERE project_id=:projectId ORDER BY updated_at DESC LIMIT 20').all({projectId:session.agentProjectId}).map(row=>JSON.parse(row.data_json));
  }
  function saveObservation(session,record,expectedRevision,invocationId){
    if(!session.agentProjectId)throw new Error('当前对话未关联 Agent 项目');
    return tx(()=>{
      if(!getProject(session.agentProjectId,session.userId,session.scope))throw new Error('项目不存在');
      const row=sql('SELECT data_json FROM agent_source_observations WHERE project_id=:projectId AND asset_id=:assetId').get({projectId:session.agentProjectId,assetId:record.assetId});
      const current=row?JSON.parse(row.data_json):null;
      if(current?.lastInvocation===invocationId)return current;
      if(current&&current.sourceSha256!==record.sourceSha256)throw new Error('原片内容已改变，请重新分析');
      if((current?.revision||0)!==expectedRevision)throw new Error('原片分析已更新，请读取最新版本再修改');
      const saved={...record,revision:expectedRevision+1,lastInvocation:invocationId,updatedAt:Date.now()};
      sql('INSERT INTO agent_source_observations(project_id,asset_id,source_sha256,revision,data_json,updated_at) VALUES(:projectId,:assetId,:sha,:revision,:data,:now) ON CONFLICT(project_id,asset_id) DO UPDATE SET source_sha256=:sha,revision=:revision,data_json=:data,updated_at=:now').run({projectId:session.agentProjectId,assetId:record.assetId,sha:record.sourceSha256,revision:saved.revision,data:JSON.stringify(saved),now:saved.updatedAt});
      return saved;
    });
  }
  function listTranscripts(session,assetId=''){
    if(!session.agentProjectId||!getProject(session.agentProjectId,session.userId,session.scope))return [];
    const rows=assetId
      ?sql('SELECT data_json FROM agent_source_transcripts WHERE project_id=:projectId AND asset_id=:assetId ORDER BY range_start_ms LIMIT 100').all({projectId:session.agentProjectId,assetId})
      :sql('SELECT data_json FROM agent_source_transcripts WHERE project_id=:projectId ORDER BY updated_at DESC LIMIT 100').all({projectId:session.agentProjectId});
    return rows.map(row=>JSON.parse(row.data_json));
  }
  function saveTranscript(session,record){
    if(!session.agentProjectId)throw new Error('当前对话未关联 Agent 项目');
    if(!/^[a-f0-9]{64}$/.test(record.sourceSha256||''))throw new Error('无法确认素材内容，请重新添加素材');
    return tx(()=>{
      if(!getProject(session.agentProjectId,session.userId,session.scope))throw new Error('项目不存在');
      const params={projectId:session.agentProjectId,assetId:record.assetId,start:Math.round(record.startSeconds*1000),end:Math.round(record.endSeconds*1000),sha:record.sourceSha256,modelId:record.modelId,language:record.language,data:JSON.stringify(record),now:Date.now()};
      sql('INSERT INTO agent_source_transcripts(project_id,asset_id,range_start_ms,range_end_ms,source_sha256,model_id,language,data_json,updated_at) VALUES(:projectId,:assetId,:start,:end,:sha,:modelId,:language,:data,:now) ON CONFLICT(project_id,asset_id,range_start_ms,range_end_ms,language) DO UPDATE SET source_sha256=:sha,model_id=:modelId,data_json=:data,updated_at=:now').run(params);
      return record;
    });
  }
  function settings(session, value) { sql('UPDATE agent_sessions SET settings_json=:settings WHERE id=:id').run({ id: session.id, settings: JSON.stringify(value) }); }
  function control(session, action) {
    if (action === 'resume') {
      tx(() => {
        const current = get(session.id, session.userId, session.scope);
        if (current.leaseUntil > Date.now()) return;
        current.doc.steps = 0;
        current.doc.resumingInvalidOutput = (current.doc.invalidReplyRetries || 0) > 0;
        current.doc.invalidReplyRetries = 0;
        sql('UPDATE agent_sessions SET doc_json=:doc WHERE id=:id').run({ id: session.id, doc: JSON.stringify(current.doc) });
      });
    }
    sql("UPDATE agent_sessions SET interrupted=:interrupted,state=CASE WHEN lease_until>:now THEN state ELSE :state END,wake_at=0 WHERE id=:id").run({ id: session.id, interrupted: action === 'interrupt' ? 1 : 0, state: action === 'interrupt' ? 'paused' : 'queued', now: Date.now() });
  }
  function claim(id = null) {
    return tx(() => {
      const row = sql("SELECT * FROM agent_sessions WHERE (:id IS NULL OR id=:id) AND state IN ('queued','running','waiting_job') AND wake_at<=:now AND lease_until<=:now ORDER BY updated_at LIMIT 1").get({ id, now: Date.now() });
      if (!row) return null;
      const token = randomUUID(), until = Date.now() + 240000;
      sql("UPDATE agent_sessions SET lease_token=:token,lease_until=:until,state='running' WHERE id=:id").run({ id: row.id, token, until });
      return parse({ ...row, lease_token: token, lease_until: until, state: 'running' });
    });
  }
  function save(session, state = 'running', wakeAt = 0) {
    session.doc.version = (session.doc.version || 0) + 1;
    const result = sql('UPDATE agent_sessions SET doc_json=:doc,state=:state,wake_at=:wakeAt,updated_at=:now WHERE id=:id AND lease_token=:token AND lease_until>:now').run({ id: session.id, token: session.token, doc: JSON.stringify(session.doc), state, wakeAt, now: Date.now() });
    if (!result.changes) throw new Error('任务执行权已变更');
    session.state = state;
  }
  function release(session) { sql('UPDATE agent_sessions SET lease_until=0,lease_token=NULL WHERE id=:id AND lease_token=:token').run({ id: session.id, token: session.token }); }
  function renew(session) { return sql('UPDATE agent_sessions SET lease_until=:until WHERE id=:id AND lease_token=:token AND lease_until>:now').run({ id: session.id, token: session.token, until: Date.now() + 240000, now: Date.now() }).changes > 0; }
  function approve(session, approvalId, accepted) {
    return tx(() => {
      const current = get(session.id, session.userId, session.scope);
      if (current.leaseUntil > Date.now()) throw Object.assign(new Error('任务正在更新，请稍后重试'), { statusCode: 409 });
      if (!current.doc.approval || current.doc.approval.id !== approvalId) throw Object.assign(new Error('这项确认已失效，请刷新对话'), { statusCode: 409 });
      current.doc.approval.decision = accepted ? 'accepted' : 'declined';
      sql("UPDATE agent_sessions SET doc_json=:doc,state='queued',wake_at=0,interrupted=0 WHERE id=:id").run({ id: session.id, doc: JSON.stringify(current.doc) });
    });
  }
  return { get, getForUser, create, list, listProjectSessions, getProject, createProject, renameProject, deleteProject, listProjects, artifacts, enqueue, inputs, messageInputs, canvas, saveCanvas, readObservation, listObservations, saveObservation, listTranscripts, saveTranscript, settings, control, claim, save, release, renew, approve };
}
