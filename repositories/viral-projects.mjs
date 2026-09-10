import { randomUUID } from 'node:crypto';
import { sql } from '../lib/db.mjs';
import { VIRAL_WORKFLOW_VERSION, normalizeViralInput, viralError } from '../lib/viral-lab.mjs';

const params = (userId, scope) => ({ userId, deviceId: scope.deviceId || '', workspaceId: scope.workspaceId || '' });
const where = 'user_id=:userId AND device_id=:deviceId AND workspace_id=:workspaceId';
export function listViralProjects(userId, scope) {
  return sql(`SELECT doc_json FROM viral_projects WHERE ${where} ORDER BY updated_at DESC, id LIMIT 200`).all(params(userId, scope)).map(row => JSON.parse(row.doc_json));
}
export function findViralProject(userId, id, scope) {
  const row = sql(`SELECT doc_json FROM viral_projects WHERE ${where} AND id=:id`).get({ ...params(userId, scope), id });
  return row ? JSON.parse(row.doc_json) : null;
}
export function createViralProject(userId, scope, input) {
  const project = { ...normalizeViralInput(input, { allowDraft: true }), id: randomUUID(), revision: 1, workflowVersion: VIRAL_WORKFLOW_VERSION, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), assetApproval: null, planApproval: null, sourceObservation: null, sourceAnalysis: null, sourceAnalysisState: null, sourceAnalysisError: '' };
  sql('INSERT INTO viral_projects(id,user_id,device_id,workspace_id,revision,updated_at,doc_json) VALUES(:id,:userId,:deviceId,:workspaceId,:revision,:updatedAt,:doc)').run({ ...params(userId, scope), id: project.id, revision: 1, updatedAt: project.updatedAt, doc: JSON.stringify(project) });
  return project;
}
export function saveViralProject(userId, scope, project, expectedRevision) {
  const next = { ...project, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
  const result = sql(`UPDATE viral_projects SET revision=:revision,updated_at=:updatedAt,doc_json=:doc WHERE ${where} AND id=:id AND revision=:expected`).run({ ...params(userId, scope), id: project.id, revision: next.revision, updatedAt: next.updatedAt, doc: JSON.stringify(next), expected: expectedRevision });
  if (!result.changes) throw viralError('项目已更新，请重新打开项目后再编辑；当前输入尚未覆盖服务器版本', 409);
  return next;
}
export function viralGenerationRecords(userId, projectId, scope) {
  return sql(`SELECT doc_json FROM generations WHERE user_id=:userId AND json_extract(doc_json,'$.viralProjectId')=:projectId AND COALESCE(json_extract(doc_json,'$.originDeviceId'),'')=:deviceId AND COALESCE(json_extract(doc_json,'$.originWorkspaceId'),'')=:workspaceId ORDER BY created_at DESC LIMIT 200`).all({ ...params(userId, scope), projectId }).map(row => JSON.parse(row.doc_json));
}
