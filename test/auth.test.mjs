import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../server.mjs';

test('password hashes are salted and verifiable', async () => {
  const first = await __test.hashPassword('correct horse battery staple');
  const second = await __test.hashPassword('correct horse battery staple');
  assert.notEqual(first, second);
  assert.equal(await __test.verifyPassword('correct horse battery staple', first), true);
  assert.equal(await __test.verifyPassword('wrong password', first), false);
});

test('session tokens are stored as irreversible hashes', () => {
  const token = 'secret-session-token';
  const hash = __test.tokenHash(token);
  assert.notEqual(hash, token);
  assert.equal(hash.length, 64);
});

test('cookie parser extracts session safely', () => {
  assert.deepEqual(__test.parseCookies('a=1; studio_session=abc%20123'), { a: '1', studio_session: 'abc 123' });
});

test('unicode prompt length counts characters rather than UTF-16 units', () => {
  assert.equal(__test.charLength('图片🎬'), 3);
});

test('invite codes are normalized and unknown codes are rejected', () => {
  assert.equal(__test.normalizeInviteCode(' studio-7k3m-p9qx '), 'STUDIO-7K3M-P9QX');
  assert.equal(__test.isKnownInviteCode('studio-7k3m-p9qx'), true);
  assert.equal(__test.isKnownInviteCode('STUDIO-NOT-VALID'), false);
});

test('generation credits follow platform pricing', () => {
  assert.equal(__test.generationCost('image'), 1);
  assert.equal(__test.generationCost('video', 6), 6);
  assert.equal(__test.generationCost('video', 15), 15);
});

test('nested provider errors are rendered as readable messages', () => {
  assert.equal(__test.errorMessage({ error: { code: 'invalid_request', message: 'fail_to_submit_task' } }), 'fail_to_submit_task');
  assert.equal(__test.errorMessage({ detail: [{ msg: '图片过大' }] }), '图片过大');
});

test('OSS object keys are scoped per user and prefix', () => {
  assert.match(__test.ossObjectKey('user-1', 'asset.png'), /user-1\/asset\.png$/);
});

test('generation option enums match provider contracts', () => {
  assert.deepEqual([...__test.imageSizes], ['1:1', '3:2', '2:3', '16:9', '9:16', '1:2', '2:1', '4:3', '3:4', '5:4', '4:5']);
  assert.deepEqual([...__test.videoAspectRatios], ['2:3', '3:2', '1:1', '9:16', '16:9']);
  assert.deepEqual([...__test.videoDurations], [6, 8, 10, 15, 20, 25, 30]);
});

test('models are fixed server-side and network errors retain their cause', () => {
  assert.deepEqual(__test.fixedModels, { image: 'gpt-image-2', video: 'grok-video-1.5' });
  assert.equal(__test.downloadErrorDetail({ message: 'fetch failed', cause: { code: 'ETIMEDOUT', message: 'connect timed out' } }), 'ETIMEDOUT · connect timed out');
});

test('legacy projects recover their furthest completed drama step', () => {
  const project = __test.normalizeDramaProject({
    step:'script', mode:'smart', settings:{}, resources:[{ name:'角色', selectedTaskId:'image-task', lifecycle:{ revision:2 } }],
    shots:[{ title:'镜头', lifecycle:{ status:'reviewed', revision:2 }, resourceIds:[], referenceAssetIds:[], videoVersions:[] }],
  });
  assert.equal(project.maxStep, 'storyboard');
  assert.equal(project.step, 'storyboard');
});

test('manual video prompt overrides survive project normalization', () => {
  const project = __test.normalizeDramaProject({settings:{},resources:[],shots:[{title:'镜头',promptOverride:'用户手动修改后的逐秒分镜',resourceIds:[],referenceAssetIds:[],videoVersions:[]}]});
  assert.equal(project.shots[0].promptOverride, '用户手动修改后的逐秒分镜');
});

test('ordered video reference selections survive project normalization', () => {
  const ordered = ['prop-image', 'character-image', 'location-image'];
  const project = __test.normalizeDramaProject({settings:{},resources:[],shots:[{title:'镜头',resourceIds:[],referenceAssetIds:[],generation:{type:'REFERENCE',referenceAssetIds:ordered},videoVersions:[]}]});
  assert.deepEqual(project.shots[0].generation.referenceAssetIds, ordered);
});

test('professional shot asset categories survive project normalization', () => {
  const project = __test.normalizeDramaProject({
    mode:'professional', settings:{}, resources:[],
    shots:[{title:'手写镜头',script:'角色推门进入。',promptOverride:'角色推门进入。',professionalAssets:{characters:['character-a','character-b'],locations:['location-a']},resourceIds:[],referenceAssetIds:[],generation:{type:'REFERENCE'},videoVersions:[]}],
  });
  assert.deepEqual(project.shots[0].professionalAssets, {characters:['character-a','character-b'],locations:['location-a']});
  assert.deepEqual(project.shots[0].referenceAssetIds, ['character-a','character-b','location-a']);
  assert.deepEqual(project.shots[0].generation.referenceAssetIds, ['character-a','character-b','location-a']);
  assert.equal(project.shots[0].promptOverride, '角色推门进入。');
});

test('professional reference normalization removes duplicate asset ids and keeps category order', () => {
  const project = __test.normalizeDramaProject({
    mode:'professional', settings:{}, resources:[],
    shots:[{title:'镜头',professionalAssets:{characters:['shared','character','shared'],locations:['shared','location']},resourceIds:[],referenceAssetIds:['legacy','shared'],videoVersions:[]}],
  });
  assert.deepEqual(project.shots[0].professionalAssets.characters, ['shared','character']);
  assert.deepEqual(project.shots[0].professionalAssets.locations, ['shared','location']);
  assert.deepEqual(project.shots[0].referenceAssetIds, ['legacy','shared','character','location']);
});

test('professional generation modes keep image references isolated', () => {
  const project = __test.normalizeDramaProject({
    mode:'professional', settings:{}, resources:[],
    shots:[
      {title:'文本',professionalAssets:{characters:['character'],locations:[]},referenceAssetIds:['legacy'],generation:{type:'TEXT',referenceAssetIds:['legacy']},videoVersions:[]},
      {title:'参考图',professionalAssets:{characters:['character'],locations:['location']},generation:{type:'REFERENCE'},videoVersions:[]},
      {title:'首尾帧',professionalAssets:{characters:['character'],locations:['location']},referenceAssetIds:['legacy'],generation:{type:'FIRST&LAST',firstFrameAssetId:'',lastFrameAssetId:''},videoVersions:[]},
      {title:'显式首尾帧',referenceAssetIds:['legacy'],generation:{type:'FIRST&LAST',firstFrameAssetId:'first',lastFrameAssetId:'last',referenceAssetIds:['legacy']},videoVersions:[]},
    ],
  });
  assert.deepEqual(project.shots[0].generation.referenceAssetIds, []);
  assert.deepEqual(project.shots[1].generation.referenceAssetIds, ['character','location']);
  assert.equal(project.shots[2].generation.firstFrameAssetId, '');
  assert.deepEqual(project.shots[2].generation.referenceAssetIds, []);
  assert.deepEqual(project.shots[3].generation.referenceAssetIds, ['first','last']);
});

test('professional pending image generations survive normalization', () => {
  const project = __test.normalizeDramaProject({
    mode:'professional', settings:{}, resources:[],
    shots:[{title:'镜头',generation:{type:'REFERENCE'},videoVersions:[],pendingImageGenerations:[{taskId:'task-1',targetType:'category',kind:'locations',label:'场景',prompt:'夜晚街道',size:'3:4',quality:'high',referenceAssetIds:['ref-1']}]}],
  });
  assert.deepEqual(project.shots[0].pendingImageGenerations[0], {
    id:'task-1', taskId:'task-1', targetType:'category', kind:'locations', frameField:'firstFrameAssetId', label:'场景', prompt:'夜晚街道', size:'3:4', quality:'high', referenceAssetIds:['ref-1'],
  });
});
