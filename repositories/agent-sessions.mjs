import { generationFrames } from '../public/features/agent/frames.js';
import { randomUUID } from 'node:crypto';

export const AGENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '',
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
`;

export function createAgentSessionRepository({ sql, tx }) {
  const parse = row => row ? { id: row.id, userId: row.user_id, scope: { deviceId: row.device_id, workspaceId: row.workspace_id }, projectId: row.project_id, settings: JSON.parse(row.settings_json), doc: JSON.parse(row.doc_json), state: row.state, interrupted: Boolean(row.interrupted), token: row.lease_token, leaseUntil: row.lease_until } : null;
  function get(id, userId, scope) {
    return parse(sql('SELECT * FROM agent_sessions WHERE id=:id AND user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId').get({ id, userId, deviceId: scope.deviceId, workspaceId: scope.workspaceId }));
  }
  function create(userId, scope, projectId, settings, { fresh = false } = {}) {
    return tx(() => {
      if (projectId && !fresh) {
        const existing = sql('SELECT * FROM agent_sessions WHERE user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId AND project_id=:projectId ORDER BY updated_at DESC LIMIT 1').get({ userId, deviceId: scope.deviceId, workspaceId: scope.workspaceId, projectId });
        if (existing) return parse(existing);
      }
      const id = randomUUID();
      sql('INSERT INTO agent_sessions(id,user_id,device_id,workspace_id,project_id,settings_json,doc_json,updated_at) VALUES(:id,:userId,:deviceId,:workspaceId,:projectId,:settings,:doc,:now)').run({ id, userId, deviceId: scope.deviceId, workspaceId: scope.workspaceId, projectId, settings: JSON.stringify(settings), doc: JSON.stringify({ messages: [], documents: [], generations: [], lastInput: 0, activity: '', version: 0 }), now: Date.now() });
      return get(id, userId, scope);
    });
  }
  function list(userId, scope, projectId) {
    return sql('SELECT id,state,updated_at,(SELECT text FROM agent_inputs WHERE session_id=agent_sessions.id ORDER BY seq LIMIT 1) AS title FROM agent_sessions WHERE user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId AND project_id=:projectId AND EXISTS (SELECT 1 FROM agent_inputs WHERE session_id=agent_sessions.id) ORDER BY updated_at DESC,id DESC LIMIT 100').all({userId, deviceId:scope.deviceId, workspaceId:scope.workspaceId, projectId}).map(row => ({id:row.id, title:row.title?.slice(0,60) || '新对话', state:row.state, updatedAt:row.updated_at}));
  }
  function artifacts(session) {
    const rows = sql('SELECT id,doc_json FROM agent_sessions WHERE user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId AND project_id=:projectId ORDER BY updated_at').all({userId:session.userId, deviceId:session.scope.deviceId, workspaceId:session.scope.workspaceId, projectId:session.projectId});
    const documents=[], generations=[];
    for(const row of rows){ const doc=JSON.parse(row.doc_json); documents.push(...doc.documents.map(d=>({...d,conversationId:row.id}))); generations.push(...generationFrames(doc)); }
    return {documents,generations};
  }
  function enqueue(session, input) {
    return tx(() => {
      const existing = sql('SELECT * FROM agent_inputs WHERE session_id=:id AND client_id=:clientId').get({ id: session.id, clientId: input.clientId });
      if (existing) {
        if (existing.text !== input.text || existing.selection_json !== JSON.stringify(input.selection || [])) throw Object.assign(new Error('同一消息不能使用不同内容重试'), { statusCode: 409 });
        return;
      }
      sql('INSERT INTO agent_inputs(session_id,client_id,text,selection_json,created_at) VALUES(:id,:clientId,:text,:selection,:now)').run({ id: session.id, clientId: input.clientId, text: input.text, selection: JSON.stringify(input.selection || []), now: Date.now() });
      sql("UPDATE agent_sessions SET interrupted=0,state=CASE WHEN lease_until>:now THEN state ELSE 'queued' END,wake_at=0,updated_at=:now WHERE id=:id").run({ id: session.id, now: Date.now() });
    });
  }
  const inputs = session => sql('SELECT * FROM agent_inputs WHERE session_id=:id AND seq>:seq ORDER BY seq LIMIT 20').all({ id: session.id, seq: session.doc.lastInput || 0 });
  function settings(session, value) { sql('UPDATE agent_sessions SET settings_json=:settings WHERE id=:id').run({ id: session.id, settings: JSON.stringify(value) }); }
  function control(session, action) {
    if (action === 'resume') {
      tx(() => {
        const current = get(session.id, session.userId, session.scope);
        if (current.leaseUntil > Date.now()) return;
        current.doc.steps = 0;
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
  return { get, create, list, artifacts, enqueue, inputs, settings, control, claim, save, release, renew, approve };
}
