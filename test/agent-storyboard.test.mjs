import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { mergeStoryboardDrafts, storyboardDraftId } from '../public/features/drama/storyboard-drafts.js';
import { canvasGenerationPayload } from '../public/features/drama/canvas-generation.js';
import { normalizeDirectorWorkspace } from '../public/features/drama/director-actions.js';
import { storyboardNeedsApproval } from '../lib/agent/runtime.mjs';

const scope = { deviceId: 'd', workspaceId: 'w' };
const videoModes = [
  { generationType: 'TEXT', aspectRatios: ['9:16', '16:9'], durations: [5, 10, 15], qualityOptions: ['720p', '1080p'], maxImages: 0 },
  { generationType: 'REFERENCE', aspectRatios: ['9:16', '16:9'], durations: [5, 10, 15], qualityOptions: ['720p', '1080p'], maxImages: 4, referenceLimits: { image: 4, video: 0, audio: 0, total: 4 } },
];
const catalog = async () => [
  { id: 'img', label: 'Image', kind: 'image', qualities: ['low', 'medium', 'high'] },
  { id: 'vid', label: 'Video', kind: 'video', modes: videoModes },
];
const config = {
  imageModels: [{ id: 'img', label: 'Image' }],
  videoCapabilities: { models: [{ id: 'vid', label: 'Video', modes: videoModes }] },
};
const assets = [{ id: 'room-photo', name: '卧室', kind: 'image' }];
const tools = () => createAgentTools({ catalog, findAsset: (_user, id) => assets.find(item => item.id === id) });

const plan = (overrides = {}) => ({
  title: '苗疆蛊事 第一章',
  video: { modelId: 'vid', aspect: '9:16', quality: '720p' },
  image: { modelId: 'img', quality: 'medium' },
  references: [
    { key: 'grandma', name: '外婆', kind: 'character', prompt: '八十六岁苗族老人，白发，靛蓝土布衣' },
    { key: 'room', name: '卧室', kind: 'location', assetId: 'room-photo' },
  ],
  segments: [
    { key: 'ep1-s1', episode: '第1集', title: '初见外婆', duration: 10, prompt: '0-5秒：@外婆 卧床，@卧室 昏暗。5-10秒：近景，她睁眼。', references: ['grandma', 'room'] },
    { key: 'ep2-s1', episode: '第2集', title: '开坛', duration: 15, prompt: '0-15秒：@外婆 揭开油纸。', references: ['grandma'] },
  ],
  ...overrides,
});

test('storyboard_write saves a validated plan and revisions require the current version', async () => {
  const agent = tools();
  const session = { userId: 'u', scope, doc: { documents: [], generations: [] } };
  const saved = await agent.execute('storyboard_write', plan(), session, { id: 'call-1' });
  assert.deepEqual({ ...saved, note: undefined }, { id: 'sb-call-1', revision: 1, segmentCount: 2, referenceCount: 2, totalSeconds: 25, note: undefined });
  assert.equal((await agent.execute('storyboard_write', plan(), session, { id: 'call-1' })).revision, 1);
  await assert.rejects(agent.execute('storyboard_write', { ...plan(), id: saved.id, expectedRevision: 9 }, session, { id: 'call-2' }), /已更新/);
  const next = await agent.execute('storyboard_write', { ...plan({ title: '改' }), id: saved.id, expectedRevision: 1 }, session, { id: 'call-3' });
  assert.equal(next.revision, 2);
  assert.equal((await agent.execute('storyboard_read', { id: saved.id }, session)).title, '改');
  assert.equal((await agent.execute('workspace_read', {}, session)).storyboards[0].segmentCount, 2);
});

test('storyboard_write appends later episodes without repeating earlier content', async () => {
  const agent = tools();
  const session = { userId: 'u', scope, doc: { documents: [], generations: [] } };
  const first = plan({ segments: plan().segments.slice(0, 1) });
  const saved = await agent.execute('storyboard_write', first, session, { id: 'call-1' });
  await assert.rejects(agent.execute('storyboard_write', { ...plan({ segments: plan().segments.slice(0, 1) }), id: saved.id, expectedRevision: 1, append: true }, session, { id: 'dup' }), /标识重复/);
  const next = await agent.execute('storyboard_write', { title: first.title, video: first.video, id: saved.id, expectedRevision: 1, append: true,
    references: [{ key: 'luzuo', name: '陆左', kind: 'character', prompt: '二十一岁青年' }],
    segments: [{ key: 'ep2-s1', episode: '第2集', title: '开坛', duration: 15, prompt: '@外婆 指向 @陆左。', references: ['grandma', 'luzuo'] }] }, session, { id: 'call-2' });
  assert.deepEqual([next.revision, next.segmentCount, next.referenceCount], [2, 2, 3]);
});

test('storyboard_write reports every unusable setting in one error', async () => {
  const session = { userId: 'u', scope, doc: { documents: [], generations: [] } };
  const bad = plan({
    video: { modelId: 'vid', aspect: '9:16', quality: '720p' },
    segments: [
      { key: 'a', episode: '第1集', title: '一', duration: 12, prompt: '外婆躺着', references: ['grandma'] },
      { key: 'a', episode: '第1集', title: '二', duration: 5, prompt: '@阿婆', references: ['missing'] },
    ],
  });
  await assert.rejects(tools().execute('storyboard_write', bad, session, { id: 'x' }), error => {
    assert.match(error.message, /12 秒不受支持；可选 5、10、15 秒/);
    assert.match(error.message, /需写 @外婆/);
    assert.match(error.message, /标识重复/);
    assert.match(error.message, /不存在的参考 missing/);
    return true;
  });
  await assert.rejects(tools().execute('storyboard_write', plan({ video: { modelId: 'vid', aspect: '1:1', quality: '720p' } }), session, { id: 'y' }), /不支持 1:1/);
  assert.equal(session.doc.storyboards?.length || 0, 0);
});

test('storyboard plan becomes editable canvas cards grouped by episode', async () => {
  const session = { userId: 'u', scope, doc: { documents: [], generations: [] } };
  await tools().execute('storyboard_write', plan(), session, { id: 'call-1' });
  const storyboard = { ...session.doc.storyboards[0], references: session.doc.storyboards[0].references.map(item => item.assetId ? { ...item, url: '/room.png' } : item) };
  const workspace = normalizeDirectorWorkspace({ positions: { other: { x: 100, y: 50, width: 200, height: 200 } } });
  const result = mergeStoryboardDrafts(workspace, [storyboard], { config });
  const segment = workspace.generationDrafts.find(item => item.id === storyboardDraftId('sb-call-1', 'segment', 'ep1-s1'));
  const reference = workspace.generationDrafts.find(item => item.id === storyboardDraftId('sb-call-1', 'reference', 'grandma'));
  assert.equal(result.added.length, 3, 'the existing room photo is attached instead of becoming a card');
  assert.equal(segment.title, '第1集 · 初见外婆');
  assert.equal(segment.duration, 10);
  assert.equal(segment.mode, 'REFERENCE');
  assert.deepEqual(segment.attachments.map(item => item.id), ['room-photo']);
  assert.equal(reference.type, 'image');
  assert.equal(reference.title, '角色 · 外婆');
  const rows = [reference, segment, workspace.generationDrafts.at(-1)].map(item => workspace.positions[item.id].y);
  assert.ok(rows[0] > 250 && rows[0] < rows[1] && rows[1] < rows[2], 'references, episode 1 and episode 2 sit on separate rows below existing content');

  // The plan survives the canvas save round trip and stays directly generatable.
  const restored = normalizeDirectorWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.generationDrafts.find(item => item.id === segment.id).source.key, 'ep1-s1');
  assert.equal(canvasGenerationPayload(restored.generationDrafts.find(item => item.id === segment.id), config).prompt, '0-5秒：@外婆 卧床，Image1 昏暗。5-10秒：近景，她睁眼。');
});

test('segments link to their reference cards and revisions keep user edits', () => {
  const storyboard = { id: 'sb-1', revision: 1, title: 't', video: { modelId: 'vid', aspect: '9:16', quality: '720p' }, references: [{ key: 'grandma', name: '外婆', kind: 'character', prompt: '老人' }],
    segments: [{ key: 's1', episode: '第1集', title: '一', duration: 5, prompt: '@外婆 睁眼', references: ['grandma'] }, { key: 's2', episode: '第1集', title: '二', duration: 5, prompt: '@外婆 起身', references: ['grandma'] }] };
  const workspace = normalizeDirectorWorkspace({});
  mergeStoryboardDrafts(workspace, [storyboard], { config });
  const ref = workspace.generationDrafts.find(item => item.source.role === 'reference');
  const [first, second] = workspace.generationDrafts.filter(item => item.source.role === 'segment');
  assert.deepEqual(ref.entity, { kind: 'character', name: '外婆' }, 'the reference is a character card');
  assert.deepEqual(workspace.links.map(link => [link.from, link.to]), [[ref.id, first.id], [ref.id, second.id]]);
  assert.deepEqual(first.attachments, [], 'the picture is resolved from the card when generating');
  assert.equal(first.mode, 'REFERENCE');

  // The links survive saving, and a link the user removed is not restored.
  const restored = normalizeDirectorWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.links.length, 2);
  assert.equal(restored.generationDrafts.find(item => item.id === ref.id).entity.name, '外婆');
  workspace.links = workspace.links.filter(link => link.to !== first.id);
  assert.equal(mergeStoryboardDrafts(workspace, [storyboard], { config }).changed, false);
  assert.equal(workspace.links.length, 1);

  first.prompt = '用户改过的描述';
  // A segment that already has results is not rewritten either.
  workspace.generationDrafts.push({ ...second, id: 'canvas-gen-result', source: undefined, taskId: 'task-1', parentId: second.id });
  const revised = { ...storyboard, revision: 2, references: [{ ...storyboard.references[0], prompt: '白发老人' }], segments: storyboard.segments.map(item => ({ ...item, prompt: `${item.prompt}，新版`, duration: 10 })) };
  mergeStoryboardDrafts(workspace, [revised], { config });
  assert.equal(first.prompt, '用户改过的描述');
  assert.equal(second.prompt, '@外婆 起身');
  assert.equal(ref.prompt, '白发老人');
  assert.equal(workspace.generationDrafts.length, 4);
});

test('deleted storyboard cards are not recreated', () => {
  const storyboard = { id: 'sb-1', revision: 1, title: 't', video: { modelId: 'vid', aspect: '9:16', quality: '720p' }, references: [], segments: [{ key: 's1', episode: '第1集', title: '一', duration: 5, prompt: '画面' }] };
  const workspace = normalizeDirectorWorkspace({});
  mergeStoryboardDrafts(workspace, [storyboard], { config });
  workspace.hiddenIds = [workspace.generationDrafts[0].id];
  assert.equal(mergeStoryboardDrafts(workspace, [storyboard], { config }).changed, false);
  assert.equal(workspace.generationDrafts.length, 1);
});

test('adaptation requests are routed to the direct storyboard method', async () => {
  const instructions = await readFile(new URL('../agent-skills/agent.md', import.meta.url), 'utf8');
  const skill = await readFile(new URL('../agent-skills/short-drama/SKILL.md', import.meta.url), 'utf8');
  const method = await readFile(new URL('../agent-skills/short-drama/references/novel-to-storyboard.md', import.meta.url), 'utf8');
  assert.match(instructions, /## 小说、剧本改编为短剧分镜/);
  assert.match(instructions, /storyboard_write/);
  assert.match(instructions, /分两步/);
  assert.match(method, /## 计划回复/);
  assert.match(skill, /references\/novel-to-storyboard\.md/);
  assert.match(method, /storyboard_write/);
  assert.match(method, /0-4秒/);
});

test('a new storyboard waits until the user answers a shown plan', () => {
  const novel = `改编这一章为短剧，设计分镜：\n${'外婆躺在床上。'.repeat(200)}`;
  const request = [{ role: 'user', content: novel }];
  assert.equal(storyboardNeedsApproval(request), true, 'the request itself is not approval');
  const withTools = [...request, { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] }, { role: 'tool', tool_call_id: 'a', content: '{}' }];
  assert.equal(storyboardNeedsApproval(withTools), true, 'silent tool work is not a shown plan');
  const planned = [...request, { role: 'assistant', content: '分镜计划：三集 213 秒……确认后排到画布。' }];
  assert.equal(storyboardNeedsApproval([...planned, { role: 'user', content: '可以' }]), false);
  assert.equal(storyboardNeedsApproval([...planned, { role: 'user', content: '第二集压到 60 秒，其他按你的来' }]), false);
  assert.equal(storyboardNeedsApproval([...planned, { role: 'user', content: novel }]), true, 'a fresh chapter needs its own plan');
  assert.equal(storyboardNeedsApproval([...planned, { role: 'user', content: '再改编下一章\n\n附带文件：\n第二章.txt' }]), true);
  assert.equal(storyboardNeedsApproval([{ role: 'user', content: '把这段改编成分镜，不用确认，直接排到画布' }]), false);
  assert.equal(storyboardNeedsApproval([{ role: 'user', content: '第一集再加一段' }], { id: 'sb-1' }, [{ id: 'sb-1' }]), false, 'revising an approved storyboard');
});
