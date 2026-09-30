import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { currentTranscriptWords, resolveVideoEditPlan } from '../lib/agent/video-edit-plan.mjs';
import { editVideoLayers } from '../services/agent-video-edit.mjs';
import { probeVideo } from '../services/agent-video-analysis.mjs';

const layer = (changes = {}) => ({ id: 'card', kind: 'rectangle', start: { seconds: 0.5 }, end: { seconds: 1.5 }, x: 0, y: 0, width: 0.25, height: 0.5, color: '#FF0000', ...changes });
const digest = 'a'.repeat(64);
const words = [{ text: '新', startSeconds: 0.4, endSeconds: 0.6 }, { text: '产品', startSeconds: 0.6, endSeconds: 0.9 }, { text: '新', startSeconds: 1.2, endSeconds: 1.4 }, { text: '产品', startSeconds: 1.4, endSeconds: 1.6 }];

test('semantic events use current target speech, distinguish repeats, and move when the delivery changes', () => {
  const plan = { layers: [layer({ start: { phrase: '新产品', occurrence: 2 }, end: { phrase: '新产品', occurrence: 2, edge: 'end', offsetSeconds: 0.2 } })] };
  assert.equal(resolveVideoEditPlan(plan, { durationSeconds: 3 }, words)[0].startSeconds, 1.2);
  const shifted = words.map(word => ({ ...word, startSeconds: word.startSeconds + 0.4, endSeconds: word.endSeconds + 0.4 }));
  assert.equal(resolveVideoEditPlan(plan, { durationSeconds: 3 }, shifted)[0].startSeconds, 1.6);
  assert.throws(() => resolveVideoEditPlan({ layers: [layer({ start: { phrase: '新产品' } })] }, { durationSeconds: 3 }, words), /多次/);
  assert.throws(() => resolveVideoEditPlan(plan, { durationSeconds: 3 }, []), /转录/);
  assert.throws(() => resolveVideoEditPlan({ layers: [layer({ start: { seconds: 0, phrase: '新' } })] }, { durationSeconds: 3 }, words), /不能同时/);
  assert.throws(() => resolveVideoEditPlan({ layers: [layer({ color: 'red;movie=private' })] }, { durationSeconds: 3 }), /颜色/);
  assert.throws(() => resolveVideoEditPlan({ layers: [layer({ end: { seconds: 9 } })] }, { durationSeconds: 3 }), /范围/);
  assert.throws(() => resolveVideoEditPlan({ layers: [layer(), layer()] }, { durationSeconds: 3 }), /重复/);
  const current = currentTranscriptWords([
    { sourceSha256: digest, startSeconds: 0, endSeconds: 2, words, updatedAt: 1 },
    { sourceSha256: digest, startSeconds: 1, endSeconds: 2, words: [{ text: '改正', startSeconds: 1.2, endSeconds: 1.6 }], updatedAt: 2 },
    { sourceSha256: 'stale', startSeconds: 0, endSeconds: 3, words: [{ text: '错误' }], updatedAt: 3 },
  ], digest);
  assert.deepEqual(current.map(word => word.text), ['新', '产品', '改正']);
});

test('Agent editing tools enforce scope, support dry runs and persist an editable plan across sessions', async () => {
  const assets = new Map([
    ['base', { id: 'base', kind: 'video', sha256: digest }],
    ['photo', { id: 'photo', kind: 'image', sha256: 'b'.repeat(64) }],
  ]);
  let calls = 0;
  const tools = createAgentTools({
    findAsset: (userId, id, scope) => userId === 'owner' && scope.workspaceId === 'workspace' ? assets.get(id) : undefined,
    publicAsset: asset => ({ id: asset.id, kind: asset.kind }),
    inspectVideo: {
      probe: async () => ({ durationSeconds: 2, width: 160, height: 90 }),
      edit: async (_owner, _scope, _base, _layers, options) => { calls++; const result = { id: options.id, kind: 'video', duration: 2, editPlan: options.editPlan }; assets.set(result.id, result); return result; },
    },
  });
  const session = { userId: 'owner', scope: { workspaceId: 'workspace' }, doc: { sourceTranscripts: [{ assetId: 'base', sourceSha256: digest, words }] } };
  const args = { baseAssetId: 'base', layers: [layer({ start: { phrase: '新产品', occurrence: 1 } }), layer({ id: 'photo', kind: 'image', assetId: 'photo' })] };
  const checked = await tools.execute('video_edit', { ...args, dryRun: true }, session, { id: 'check' });
  assert.equal(checked.timing[0].startSeconds, 0.4);
  assert.equal(calls, 0);
  assert.equal(session.doc.compositions, undefined);
  const result = await tools.execute('video_edit', args, session, { id: 'render' });
  assert.equal(result.id, 'render');
  assert.equal(calls, 1);
  assert.equal(session.doc.compositions[0].editPlan.baseAssetId, 'base');
  await tools.execute('video_edit', args, session, { id: 'render' });
  assert.equal(calls, 1);
  const later = { ...session, doc: {} };
  const read = await tools.execute('video_edit_read', { assetId: 'render' }, later);
  assert.deepEqual(JSON.parse(read.text).layers, args.layers);
  await tools.execute('video_edit', args, later, { id: 'render' });
  assert.equal(later.doc.compositions[0].assetId, 'render', 'recover persisted output into the current session');
  await assert.rejects(tools.execute('video_edit', { ...args, layers: [layer({ kind: 'image', assetId: 'other-tenant' })] }, session, { id: 'bad' }), /工作空间/);
  await assert.rejects(tools.execute('video_edit_read', { assetId: 'render' }, { ...session, scope: { workspaceId: 'other' } }), /工作空间/);
  await assert.rejects(tools.execute('video_edit', { ...args, command: 'anything' }, session, { id: 'bad' }), /不支持/);
  assert.equal(calls, 1);
});

function run(args) {
  const result = spawnSync(ffmpeg, ['-loglevel', 'error', ...args], { maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
function pixel(file, seconds, x, y) {
  const data = run(['-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'rawvideo', '-']);
  return [...data.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
}
const isRed = ([r, g, b]) => r > 180 && g < 70 && b < 70;
const isBlue = ([r, g, b]) => b > 180 && r < 70 && g < 70;
const isGreen = ([r, g, b]) => g > 100 && r < 70 && b < 70;

test('actual FFmpeg output places, animates and removes layers while preserving base audio', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gugu-edit-test-'));
  try {
    const base = path.join(directory, 'base.mp4'), image = path.join(directory, 'green.png'), inset = path.join(directory, 'inset.mp4');
    run(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-t', '2', '-y', base]);
    run(['-f', 'lavfi', '-i', 'color=c=green:s=40x40', '-frames:v', '1', '-y', image]);
    run(['-f', 'lavfi', '-i', 'color=c=yellow:s=40x40:r=30:d=2', '-c:v', 'libx264', '-y', inset]);
    const resolved = resolveVideoEditPlan({ layers: [
      layer({ moveTo: { x: 0.4, y: 0 }, fadeInSeconds: 0.1, fadeOutSeconds: 0.1 }),
      layer({ id: 'image', kind: 'image', assetId: 'image', file: image, x: 0.7, y: 0.05, width: 0.25, height: 0.4, fit: 'cover' }),
      layer({ id: 'video', kind: 'video', assetId: 'inset', file: inset, x: 0.7, y: 0.55, width: 0.25, height: 0.4, fit: 'contain', scaleFrom: 0.5, scaleTo: 1 }),
      layer({ id: 'label', kind: 'text', text: '新品', color: '#FFFFFF', x: 0.1, y: 0.6, width: 0.5, height: 0.35, fontSize: 0.14 }),
    ] }, { durationSeconds: 2 });
    const result = await editVideoLayers(base, resolved);
    const output = path.join(directory, 'edited.mp4');
    await writeFile(output, result.data);
    assert.equal((await probeVideo(output)).hasAudio, true);
    assert.ok(isBlue(pixel(output, 0.2, 25, 20)), 'before event');
    assert.ok(isRed(pixel(output, 0.8, 25, 20)), 'card has entered');
    assert.ok(isBlue(pixel(output, 1.3, 10, 20)), 'card has moved');
    assert.ok(isRed(pixel(output, 1.3, 65, 20)), 'card at its later location');
    assert.ok(isGreen(pixel(output, 1, 125, 15)), 'image overlay is visible');
    const [vr, vg, vb] = pixel(output, 1, 125, 62);
    assert.ok(vr > 140 && vg > 140 && vb < 70, 'scaled inset video is visible');
    assert.ok(isBlue(pixel(output, 1.8, 125, 15)), 'overlay removed after end');
    const textFrame = run(['-ss', '1', '-i', output, '-frames:v', '1', '-vf', 'crop=80:26:16:54,format=rgb24', '-f', 'rawvideo', '-']);
    assert.ok(Array.from({ length: textFrame.length / 3 }, (_, index) => textFrame.subarray(index * 3, index * 3 + 3)).some(([r, g, b]) => r > 160 && g > 160 && b > 160), 'Chinese text rendered');
    await assert.rejects(editVideoLayers(base, resolveVideoEditPlan({ layers: [layer({ kind: 'text', text: '文字过长'.repeat(50), width: 0.1, height: 0.1, fontSize: 0.1 })] }, { durationSeconds: 2 })), /文字区域不足/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
