import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_SCHEMA_SQL, createAgentSessionRepository } from '../repositories/agent-sessions.mjs';
import { prepareCanvasEdit, applyCanvasOps, canvasRestoreFor, replayCanvasEdits, canReplay } from '../public/features/drama/canvas-ops.js';
import { normalizeDirectorWorkspace } from '../public/features/drama/director-actions.js';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { generationFrames } from '../public/features/agent/frames.js';

const scope = { deviceId: 'device-a', workspaceId: 'workspace-a' };
let counter = 0;
const uuid = () => `u${++counter}`;
const card = { id: 'canvas-gen-grandma', type: 'image', prompt: '白发老人', entity: { kind: 'character', name: '外婆' } };
const shot = { id: 'canvas-gen-shot', type: 'video', role: 'shot', title: '第一镜', prompt: '@外婆 睁眼' };
const baseCanvas = (extra = {}) => ({
  directorWorkspace: normalizeDirectorWorkspace({ generationDrafts: [card, shot], positions: { [card.id]: { x: 0, y: 0, width: 280, height: 373 }, [shot.id]: { x: 400, y: 0, width: 320, height: 180 } }, ...extra }),
  assetIds: [],
});

function repository() {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('user-a');");
  db.exec(AGENT_SCHEMA_SQL);
  const repo = createAgentSessionRepository({ sql: s => db.prepare(s), tx: fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } } });
  const project = repo.createProject('user-a', scope, '外婆的秘密');
  const session = repo.create('user-a', scope, '', { model: 'm' }, { agentProjectId: project.id });
  return { repo, session };
}

test('edits are checked before anything changes', () => {
  const canvas = baseCanvas({ lockedIds: [shot.id] });
  assert.throws(() => prepareCanvasEdit(canvas, [{ type: 'update_card', id: shot.id, prompt: 'x' }], { uuid }), /锁定/);
  assert.throws(() => prepareCanvasEdit(canvas, [{ type: 'update_card', id: 'canvas-gen-none', prompt: 'x' }], { uuid }), /canvas_read/);
  assert.throws(() => prepareCanvasEdit(baseCanvas(), [{ type: 'link', from: 'clip', to: card.id }], { uuid, lookup: () => ({ kind: 'video', asset: true }) }), /只能使用图片/);
  assert.throws(() => prepareCanvasEdit(baseCanvas(), [{ type: 'update_card', id: shot.id, name: '新名' }], { uuid }), /只有角色/);
  assert.throws(() => prepareCanvasEdit(baseCanvas(), [{ type: 'explode' }], { uuid }), /不支持/);
});

test('the assistant can create, rewrite, link, move and delete, and undo puts it all back', () => {
  const canvas = baseCanvas();
  const ops = prepareCanvasEdit(canvas, [
    { type: 'create_card', kind: 'character', name: '外婆', prompt: '年轻时的外婆', near: card.id },
    { type: 'create_text', role: 'script', title: '第一集', text: '雨夜' },
    { type: 'update_card', id: card.id, name: '阿婆', prompt: '八十六岁的阿婆', settings: { aspect: '1:1', duration: 99 } },
    { type: 'link', from: 'photo-1', to: shot.id },
    { type: 'move', id: shot.id, x: 900, y: 40 },
    { type: 'delete', ids: ['canvas-gen-gone'] },
  ], { uuid, lookup: id => id === 'photo-1' ? { kind: 'image', asset: true } : null });
  assert.equal(ops[0].name, '外婆 2', 'new card names stay unique');
  assert.ok(ops[0].position.x >= 280, 'placed beside the card it belongs to');
  assert.equal(ops[2].settings.duration, 60);
  const before = structuredClone(canvas);
  applyCanvasOps(canvas, ops);
  const workspace = canvas.directorWorkspace;
  assert.equal(workspace.generationDrafts.find(item => item.id === card.id).entity.name, '阿婆');
  assert.equal(workspace.generationDrafts.find(item => item.id === shot.id).prompt, '@外婆 睁眼', 'the shot is not linked from the card, so its text stays');
  assert.equal(workspace.notes[0].text, '雨夜');
  assert.deepEqual(canvas.assetIds, ['photo-1'], 'a linked file is placed on the canvas');
  assert.deepEqual(workspace.positions[shot.id], { x: 900, y: 40, width: 320, height: 180 });
  assert.ok(workspace.hiddenIds.includes('canvas-gen-gone'));

  applyCanvasOps(canvas, [canvasRestoreFor(before, canvas)]);
  assert.deepEqual(JSON.parse(JSON.stringify(canvas)), JSON.parse(JSON.stringify(before)));
});

test('undo only touches what the edit changed', () => {
  const canvas = baseCanvas();
  const before = structuredClone(canvas);
  applyCanvasOps(canvas, prepareCanvasEdit(canvas, [{ type: 'update_card', id: card.id, prompt: '改过' }], { uuid }));
  const undo = canvasRestoreFor(before, canvas);
  // Meanwhile the user edits another card.
  canvas.directorWorkspace.generationDrafts.find(item => item.id === shot.id).prompt = '用户自己写的';
  applyCanvasOps(canvas, [undo]);
  assert.equal(canvas.directorWorkspace.generationDrafts.find(item => item.id === card.id).prompt, '白发老人');
  assert.equal(canvas.directorWorkspace.generationDrafts.find(item => item.id === shot.id).prompt, '用户自己写的');
});

test('replay brings a canvas up to date and knows when the log is too short', () => {
  const canvas = baseCanvas();
  const edits = [{ seq: 1, ops: prepareCanvasEdit(canvas, [{ type: 'update_card', id: card.id, prompt: '一' }], { uuid }) }, { seq: 2, ops: [{ type: 'move', id: card.id, x: 5, y: 6 }] }];
  assert.deepEqual(replayCanvasEdits(canvas, edits), { applied: 2, touched: [card.id] });
  assert.equal(canvas.directorWorkspace.editSeq, 2);
  assert.equal(replayCanvasEdits(canvas, edits).applied, 0);
  assert.equal(canReplay([{ seq: 7 }, { seq: 8 }], 6), true);
  assert.equal(canReplay([{ seq: 7 }, { seq: 8 }], 5), false);
});

test('a stale client save keeps the assistant edit instead of overwriting it', () => {
  const { repo, session } = repository();
  repo.saveCanvas(session, baseCanvas());
  const clientCopy = structuredClone(repo.canvas(session));
  const { edit } = repo.editCanvas(session, data => ({ ops: prepareCanvasEdit(data, [{ type: 'update_card', id: card.id, prompt: '助手改的描述' }], { uuid }), summary: '修改外婆的描述' }));
  assert.equal(edit.seq, 1);
  // The client has not seen the edit yet and saves its own change.
  clientCopy.directorWorkspace.generationDrafts.find(item => item.id === shot.id).prompt = '用户改的分镜';
  const saved = repo.saveCanvas(session, clientCopy);
  const drafts = saved.directorWorkspace.generationDrafts;
  assert.equal(drafts.find(item => item.id === card.id).prompt, '助手改的描述');
  assert.equal(drafts.find(item => item.id === shot.id).prompt, '用户改的分镜');
  assert.equal(saved.directorWorkspace.editSeq, 1);
  assert.equal(saved.canvasEdits.length, 1);
});

test('the assistant edits, undoes and attaches generated results through its tools', async () => {
  const { repo, session } = repository();
  repo.saveCanvas(session, baseCanvas());
  const store = { read: s => repo.canvas(s), edit: (s, build) => repo.editCanvas(s, build) };
  let task = 0;
  const tools = createAgentTools({
    canvasStore: store,
    findAsset: (_user, id) => id === 'photo-1' ? { id, kind: 'image', name: '老宅' } : null,
    findGeneration: () => null,
    catalog: async () => [{ id: 'img', kind: 'image' }],
    generate: async ({ previewOnly }) => previewOnly ? { status: 200, data: { credits: 1, costMicro: 1, quantity: 1 } } : { status: 200, data: { tasks: [{ id: `task-${++task}`, status: 'queued' }] } },
  });
  const agentSession = { ...session, userId: 'user-a', scope, doc: { documents: [], generations: [] } };

  const created = await tools.execute('canvas_edit', { summary: '新建场景卡并连到分镜', operations: [{ type: 'create_card', kind: 'location', name: '老宅', prompt: '雨夜的老宅' }] }, agentSession);
  assert.equal(created.created[0].name, '老宅');
  await tools.execute('canvas_edit', { summary: '连接', operations: [{ type: 'link', from: created.created[0].id, to: shot.id }] }, agentSession);
  const read = await tools.execute('canvas_read', {}, agentSession);
  assert.deepEqual(read.shots[0].inputs, ['老宅']);

  const undone = await tools.execute('canvas_undo', {}, agentSession);
  assert.equal(undone.summary, '撤销：连接');
  assert.deepEqual((await tools.execute('canvas_read', {}, agentSession)).shots[0].inputs, []);
  await assert.rejects(tools.execute('canvas_undo', { editId: undone.undone }, agentSession), /已经撤销/);

  // Generating for a card puts the result beside that card, not as a separate work.
  const prepared = await tools.execute('media_prepare', { type: 'image', modelId: 'img', prompt: '外婆三视图', canvasNodeId: card.id }, agentSession, { id: 'p1' });
  assert.equal(generationFrames(agentSession.doc)[0].attachedTo, card.id);
  await tools.execute('media_submit', { preparedRequestId: prepared.preparedRequestId }, agentSession, { id: 's1' });
  assert.equal(agentSession.doc.generations[0].attachedTo, card.id);
  const drafts = repo.canvas(session).directorWorkspace.generationDrafts;
  const result = drafts.find(item => item.parentId === card.id);
  assert.equal(result.taskId, 'task-1');
  assert.equal(drafts.find(item => item.id === card.id).primaryId, result.id);
  await assert.rejects(tools.execute('media_prepare', { type: 'video', modelId: 'img', prompt: 'x', canvasNodeId: card.id }, agentSession, { id: 'p2' }), /图像生成/);
  // Starting a generation is not what "undo" refers to.
  const last = await tools.execute('canvas_undo', {}, agentSession);
  assert.equal(last.summary, '撤销：新建场景卡并连到分镜');
});
