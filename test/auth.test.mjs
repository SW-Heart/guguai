import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, createCaptchaStore, createLoginAttemptLimiter, createSmsSendLimiter, normalizePhoneNumber } from '../lib/auth.mjs';
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

test('invite codes are normalized and no public codes are built in', () => {
  assert.equal(__test.normalizeInviteCode(' smoke-invite-a '), 'SMOKE-INVITE-A');
  assert.equal(__test.isKnownInviteCode('STUDIO-7K3M-P9QX'), false);
  assert.equal(__test.isKnownInviteCode('STUDIO-NOT-VALID'), false);
});

test('trusted proxy IP is accepted only from a loopback peer', () => {
  const request = (remoteAddress, realIp) => ({ socket: { remoteAddress }, headers: { 'x-real-ip': realIp } });
  assert.equal(clientIp(request('203.0.113.5', '198.51.100.7'), { TRUST_PROXY: 'loopback' }), '203.0.113.5');
  assert.equal(clientIp(request('127.0.0.1', '198.51.100.7'), { TRUST_PROXY: 'loopback' }), '198.51.100.7');
  assert.equal(clientIp(request('127.0.0.1', 'not-an-ip'), { TRUST_PROXY: 'loopback' }), '127.0.0.1');
  assert.equal(clientIp(request('127.0.0.1', '198.51.100.7'), {}), '127.0.0.1');
});

test('login limiter enforces thresholds and a hard entry bound', () => {
  const req = ip => ({ socket: { remoteAddress: ip }, headers: {} });
  const threshold = createLoginAttemptLimiter({ maxAttempts: 2, windowMs: 60_000, maxEntries: 10 });
  threshold.recordFailure(req('192.0.2.1'), 'alice', 1);
  assert.equal(threshold.isBlocked(req('192.0.2.1'), 'alice', 2), false);
  threshold.recordFailure(req('192.0.2.1'), 'alice', 3);
  assert.equal(threshold.isBlocked(req('192.0.2.1'), 'alice', 4), true);
  assert.equal(threshold.isBlocked(req('192.0.2.1'), 'bob', 4), false);

  const bounded = createLoginAttemptLimiter({ maxAttempts: 1, windowMs: 60_000, maxEntries: 2 });
  bounded.recordFailure(req('192.0.2.1'), 'a', 1);
  bounded.recordFailure(req('192.0.2.2'), 'b', 2);
  bounded.recordFailure(req('192.0.2.3'), 'c', 3);
  assert.equal(bounded.isBlocked(req('192.0.2.1'), 'a', 4), false);
  assert.equal(bounded.isBlocked(req('192.0.2.2'), 'b', 4), true);
  assert.equal(bounded.isBlocked(req('192.0.2.3'), 'c', 4), true);
});

test('captcha challenges are single-use and bound to the client IP', () => {
  const store = createCaptchaStore({ ttlMs: 1000 });
  const challenge = store.issue('192.0.2.10', 100);
  assert.match(challenge.image, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(challenge.image.split(',')[1], 'base64').toString('utf8');
  const answer = [...svg.matchAll(/<text[^>]*>([^<])<\/text>/g)].map(match => match[1]).join('');
  assert.equal(answer.length, 5);
  assert.equal(store.verify(challenge.challengeId, answer, '192.0.2.11', 100).ok, false);
  assert.equal(store.verify(challenge.challengeId, answer, '192.0.2.10', 100).ok, true);
  assert.equal(store.verify(challenge.challengeId, answer, '192.0.2.10', 100).ok, false);
  const expired = store.issue('192.0.2.10', 100);
  assert.equal(store.verify(expired.challengeId, answer, '192.0.2.10', 1101).ok, false);
});

test('phone normalization accepts mainland formats and SMS send limiter has a cooldown', () => {
  assert.equal(normalizePhoneNumber(' +86 138-0013-8000 '), '13800138000');
  assert.equal(normalizePhoneNumber('13800138000'), '13800138000');
  assert.equal(normalizePhoneNumber('12000138000'), '');
  const limiter = createSmsSendLimiter({ intervalMs: 1000 });
  const req = { socket: { remoteAddress: '192.0.2.20' }, headers: {} };
  assert.equal(limiter.remainingMs(req, '13800138000', 100), 0);
  limiter.record(req, '13800138000', 100);
  assert.equal(limiter.remainingMs(req, '13800138000', 500), 600);
  assert.equal(limiter.remainingMs(req, '13800138000', 1100), 0);
});

test('generation credits follow platform pricing', () => {
  assert.equal(__test.generationCost('image'), 1);
  assert.equal(__test.generationCost('video', 6), 6);
  assert.equal(__test.generationCost('video', 15), 15);
});

test('website auth and Alipay APIs remain available in desktop-only mode', () => {
  assert.equal(__test.websiteApiAllowed('/api/auth/me'), true);
  assert.equal(__test.websiteApiAllowed('/api/auth/sms/login'), true);
  assert.equal(__test.websiteApiAllowed('/api/credits'), true);
  assert.equal(__test.websiteApiAllowed('/api/payments/alipay/orders'), true);
  assert.equal(__test.websiteApiAllowed('/api/payments/alipay/orders/ORDER-1/query'), true);
  assert.equal(__test.websiteApiAllowed('/api/files'), false);
  assert.equal(__test.websiteApiAllowed('/api/admin/users'), false);
});

test('creator routes serve the workspace only to the desktop client', () => {
  assert.equal(__test.staticEntryFile('/login', { desktop:false, appOnly:true }), 'home.html');
  assert.equal(__test.staticEntryFile('/image', { desktop:false, appOnly:true }), 'home.html');
  assert.equal(__test.staticEntryFile('/login', { desktop:true, appOnly:true }), 'index.html');
  assert.equal(__test.staticEntryFile('/image', { desktop:true, appOnly:true }), 'index.html');
});

test('drama video generation preserves the submitted prompt and only falls back when absent', () => {
  assert.equal(__test.resolveVideoPrompt('用户最终 Prompt', '系统编译 Prompt'), '用户最终 Prompt');
  assert.equal(__test.resolveVideoPrompt('  ', '系统编译 Prompt'), '系统编译 Prompt');
});

test('nested provider errors are rendered as readable messages', () => {
  assert.equal(__test.errorMessage({ error: { code: 'invalid_request', message: 'fail_to_submit_task' } }), 'fail_to_submit_task');
  assert.equal(__test.errorMessage({ detail: [{ msg: '图片过大' }] }), '图片过大');
});

test('media object keys are scoped per user and prefix', () => {
  assert.match(__test.assetObjectKey('user-1', 'asset.png'), /user-1\/asset\.png$/);
});

test('generation option enums match provider contracts', () => {
  assert.deepEqual([...__test.imageSizes], ['1:1', '3:2', '2:3', '16:9', '9:16', '1:2', '2:1', '4:3', '3:4', '5:4', '4:5']);
  assert.deepEqual([...__test.videoAspectRatios], ['2:3', '3:2', '1:1', '9:16', '16:9']);
  assert.deepEqual([...__test.videoDurations], [8, 10, 15, 20, 30]);
});

test('models are fixed server-side and network errors retain their cause', () => {
  assert.deepEqual(__test.fixedModels, { image: 'gpt-image-2' });
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

test('professional project normalization preserves ten-second durations', () => {
  const project = __test.normalizeDramaProject({
    mode:'professional', settings:{shotDuration:10}, resources:[],
    shots:[{title:'十秒镜头',duration:10,resourceIds:[],referenceAssetIds:[],videoVersions:[]}],
  });
  assert.equal(project.settings.shotDuration, 10);
  assert.equal(project.shots[0].duration, 10);
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
