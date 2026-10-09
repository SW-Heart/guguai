import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { videoUpscaleBitRate, videoUpscaleLabel, videoUpscalePlan } from '../public/features/generation/upscale.js';
import { createAliyunVsrProvider, aliyunVsrFailureMessage } from '../providers/aliyun-vsr.mjs';
import { createVideoUpscaleService } from '../services/video-upscale.mjs';
import { createGenerationPresentation } from '../public/features/generation/presentation.js';
import { prepareGenerationRetry } from '../services/generation-retry.mjs';
import { repairGenerationPrompt } from '../services/generation-prompt-repair.mjs';
import { __test } from '../server.mjs';

test('upscale plan doubles sources up to 1080p and rejects everything else up front', () => {
  assert.deepEqual(videoUpscalePlan({ width:1280, height:720, duration:5.04 }), {
    eligible:true, sourceWidth:1280, sourceHeight:720, outputWidth:2560, outputHeight:1440, label:'2K', billedSeconds:5,
  });
  assert.equal(videoUpscalePlan({ width:854, height:480 }).label, '960p');
  assert.equal(videoUpscalePlan({ width:464, height:832 }).outputHeight, 1664);
  assert.equal(videoUpscalePlan({ width:1080, height:1920 }).label, '4K');
  assert.equal(videoUpscalePlan({ width:1920, height:1080 }).label, '4K');
  assert.equal(videoUpscalePlan({ width:2560, height:1440 }).reason, '这个视频已经是高清画质，无需再放大');
  assert.equal(videoUpscalePlan({ width:640, height:360 }).reason, '视频尺寸过小，暂不支持放大');
  assert.equal(videoUpscalePlan({ width:1280, height:720, duration:121 }).eligible, false);
  assert.equal(videoUpscalePlan({ width:0, height:720 }).eligible, false);
  assert.equal(videoUpscaleLabel(3840, 2160), '4K');
  assert.deepEqual([videoUpscaleBitRate(1708, 960), videoUpscaleBitRate(2560, 1440), videoUpscaleBitRate(3840, 2160)], [10, 12, 20]);
});

function fakeResponse(status, body, headers = {}) {
  return {
    ok:status >= 200 && status < 300,
    status,
    headers:{ get:name => headers[name.toLowerCase()] ?? null },
    json:async () => body,
    text:async () => String(body),
  };
}

function provider(fetchImpl, overrides = {}) {
  let clock = Date.parse('2026-10-07T12:00:00Z');
  return createAliyunVsrProvider({
    accessKeyId:'AK', accessKeySecret:'SECRET', bucket:'gugu-vsr-sh', prefix:'video-upscale',
    fetchImpl, sleep:async ms => { clock += ms; }, now:() => clock, ...overrides,
  });
}

test('OSS signed URLs follow the V1 signature contract for the temporary bucket', () => {
  const vsr = provider(async () => fakeResponse(200, {}));
  const key = vsr.sourceKey('user/1', 'task 1');
  assert.equal(key, 'video-upscale/user_1/task_1.mp4');
  const upload = vsr.uploadTarget(key);
  const url = new URL(upload.url);
  assert.equal(url.host, 'gugu-vsr-sh.oss-cn-shanghai.aliyuncs.com');
  assert.equal(upload.headers['Content-Type'], 'video/mp4');
  const expires = url.searchParams.get('Expires');
  const expected = createHmac('sha1', 'SECRET').update(`PUT\n\nvideo/mp4\n${expires}\n/gugu-vsr-sh/${key}`).digest('base64');
  assert.equal(url.searchParams.get('Signature'), expected);
  assert.equal(url.searchParams.get('OSSAccessKeyId'), 'AK');
});

test('submission sends a signed source URL and defers polling to durable jobs', async () => {
  const calls = [];
  const vsr = provider(async (url, options) => {
    calls.push({ url, body:new URLSearchParams(options.body) });
    return fakeResponse(200, { RequestId:'JOB-1' });
  });
  const submitted = [];
  const result = await vsr.submit({ id:'t1', upscale:{ sourceKey:'video-upscale/u/t1.mp4', bitRate:12 } }, { deferPolling:true, onSubmitted:value => submitted.push(value) });
  assert.deepEqual(result, { pending:true, provider:'aliyun-vsr', taskId:'JOB-1' });
  assert.deepEqual(submitted, [{ provider:'aliyun-vsr', taskId:'JOB-1' }]);
  const body = calls[0].body;
  assert.equal(body.get('Action'), 'SuperResolveVideo');
  assert.equal(body.get('BitRate'), '12');
  assert.match(body.get('VideoUrl'), /^https:\/\/gugu-vsr-sh\.oss-cn-shanghai\.aliyuncs\.com\/video-upscale\/u\/t1\.mp4\?OSSAccessKeyId=AK&Expires=\d+&Signature=/);
  assert.ok(body.get('Signature'));
});

test('a successful poll returns the upstream video URL and deletes the temporary source', async () => {
  const methods = [];
  const vsr = provider(async (url, options) => {
    methods.push(options.method);
    if (options.method === 'DELETE') return fakeResponse(204, '');
    return fakeResponse(200, { Data:{ Status:'PROCESS_SUCCESS', Result:JSON.stringify({ VideoUrl:'https://vigen-invi.oss-cn-shanghai.aliyuncs.com/out.mp4' }) } });
  });
  const result = await vsr.poll({ id:'t1', providerTaskId:'JOB-1', upscale:{ sourceKey:'video-upscale/u/t1.mp4' } }, {}, { pollOnce:true });
  assert.deepEqual(result, { provider:'aliyun-vsr', taskId:'JOB-1', url:'https://vigen-invi.oss-cn-shanghai.aliyuncs.com/out.mp4' });
  assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('pending polls stay pending and oversized sources fail without automatic retry', async () => {
  let status = 'PROCESSING';
  const vsr = provider(async () => fakeResponse(200, { Data:{ Status:status, ErrorMessage:'文件内容不合法，请检查文件内容 - 输入视频的分辨率超出范围' } }));
  const task = { id:'t1', providerTaskId:'JOB-1', submittedAt:'2026-10-07T12:00:00Z', upscale:{} };
  assert.deepEqual(await vsr.poll(task, {}, { pollOnce:true }), { pending:true, provider:'aliyun-vsr', taskId:'JOB-1' });
  status = 'PROCESS_FAILED';
  await assert.rejects(vsr.poll(task, {}, { pollOnce:true }), error => {
    assert.equal(error.message, '视频分辨率超出可放大范围');
    assert.equal(error.upstreamTerminal, true);
    assert.equal(error.retryable, false);
    assert.equal(prepareGenerationRetry({ type:'video' }, error), false);
    return true;
  });
  assert.equal(aliyunVsrFailureMessage('unexpected'), '高清放大失败，请稍后重试');
});

test('throttled RPC calls retry and stay spaced within the account rate limit', async () => {
  const times = [];
  let clock = 0;
  let attempts = 0;
  const vsr = createAliyunVsrProvider({
    accessKeyId:'AK', accessKeySecret:'SECRET', bucket:'b',
    now:() => clock, sleep:async ms => { clock += ms; },
    fetchImpl:async () => {
      times.push(clock);
      attempts++;
      return attempts === 1 ? fakeResponse(400, { Code:'Throttling.User', Message:'busy' }) : fakeResponse(200, { Data:{ Status:'QUEUING' } });
    },
  });
  await vsr.rpc('GetAsyncJobResult', { JobId:'a' });
  await vsr.rpc('GetAsyncJobResult', { JobId:'b' });
  assert.equal(attempts, 3);
  for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= 550);
});

test('the source sweeper deletes only objects older than the retention window', async () => {
  const deleted = [];
  const vsr = provider(async (url, options) => {
    if (options.method === 'DELETE') { deleted.push(new URL(url).pathname); return fakeResponse(204, ''); }
    return fakeResponse(200, `<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>video-upscale/u/old.mp4</Key><LastModified>2026-10-07T04:00:00.000Z</LastModified></Contents>
      <Contents><Key>video-upscale/u/new.mp4</Key><LastModified>2026-10-07T11:00:00.000Z</LastModified></Contents></ListBucketResult>`);
  });
  assert.deepEqual(await vsr.sweepExpiredSources({ maxAgeMs:6 * 3600_000 }), { deleted:1 });
  assert.deepEqual(deleted, ['/video-upscale/u/old.mp4']);
});

function serviceHarness({ source = {}, head = { size:2_000_000 }, balance = 100 } = {}) {
  const tasks = new Map([['src-1', { id:'src-1', type:'video', status:'completed', assetId:'asset-1', prompt:'城市夜景', aspectRatio:'16:9', duration:5, ...source }]]);
  const charges = [];
  const jobs = [];
  const failures = [];
  const service = createVideoUpscaleService({
    provider:{
      configured:true,
      sourceKey:(userId, taskId) => `video-upscale/${userId}/${taskId}.mp4`,
      uploadTarget:key => ({ url:`https://upload/${key}`, method:'PUT', headers:{ 'Content-Type':'video/mp4' } }),
      headSource:async () => head,
      deleteSource:async () => {},
    },
    findGeneration:(_userId, id) => tasks.get(id) || null,
    saveGeneration:(_userId, task) => { tasks.set(task.id, task); },
    enqueueGenerationJob:job => jobs.push(job),
    failGeneration:async (_userId, task, error) => { task.status = 'failed'; task.error = error.message; failures.push(error.message); },
    chargeGenerationMicro:async (_userId, id, costMicro, metadata) => {
      if (costMicro > balance * 1_000_000) return { status:402, error:'积分不足' };
      charges.push({ id, costMicro });
      metadata.onCharged();
      return { balance:balance - costMicro / 1_000_000 };
    },
    walletOf:() => ({ balance }),
    currentPricing:() => ({ version:7, modelPrices:{} }),
    pricingSnapshot:(pricing, _type, quantity) => ({ version:pricing.version, totalMicro:pricing.videoPerSecondMicro * quantity, total:pricing.videoPerSecondMicro * quantity / 1_000_000 }),
    creditsToMicro:value => Math.round(value * 1_000_000),
    modelPrice:(pricing, modelId, quality, fallback) => pricing.modelPrices[`${modelId}:${quality}`] ?? fallback,
    publicGeneration:task => ({ id:task.id, status:task.status, awaitingReferences:task.awaitingReferences, creditCost:task.creditCost, upscale:task.upscale }),
    safeId:value => String(value || '').replace(/[^\w-]/g, ''),
    now:() => '2026-10-07T12:00:00.000Z',
  });
  return { service, tasks, charges, jobs, failures };
}

const user = { id:'user-1' };
const scope = { deviceId:'d', workspaceId:'w' };
const input = { sourceGenerationId:'src-1', width:1280, height:720, duration:5.02, size:3_000_000 };

test('upscale quotes and charges by the recorded duration with client measurements only raising it', async () => {
  const { service, charges, tasks } = serviceHarness();
  const quote = service.quote({ user, scope, input });
  assert.deepEqual({ credits:quote.credits, billedSeconds:quote.billedSeconds, label:quote.label, outputWidth:quote.outputWidth }, { credits:5, billedSeconds:5, label:'2K', outputWidth:2560 });
  assert.equal(service.quote({ user, scope, input:{ ...input, duration:1 } }).credits, 5);
  assert.equal(service.quote({ user, scope, input:{ ...input, duration:6.6 } }).credits, 7);
  const created = await service.create({ user, scope, input:{ ...input, requestId:'req-upscale-1', expectedCredits:5 } });
  assert.deepEqual(charges, [{ id:'req-upscale-1', costMicro:5_000_000 }]);
  assert.equal(created.upload.url, 'https://upload/video-upscale/user-1/req-upscale-1.mp4');
  const task = tasks.get('req-upscale-1');
  assert.equal(task.awaitingReferences, true);
  assert.equal(task.provider, 'aliyun-vsr');
  assert.equal(task.upscale.bitRate, 12);
  assert.equal(task.prompt, '城市夜景');
});

test('upscale rejects stale prices, oversized sources and mismatched durations before charging', async () => {
  const { service, charges } = serviceHarness();
  await assert.rejects(service.create({ user, scope, input:{ ...input, requestId:'req-upscale-2', expectedCredits:3 } }), error => error.code === 'PRICE_CHANGED' && error.quote.credits === 5);
  assert.throws(() => service.quote({ user, scope, input:{ ...input, width:2560, height:1440 } }), /已经是高清画质/);
  assert.throws(() => service.quote({ user, scope, input:{ ...input, duration:9 } }), /时长与作品记录不一致/);
  assert.throws(() => service.quote({ user, scope, input:{ ...input, sourceGenerationId:'missing' } }), /不存在/);
  assert.equal(charges.length, 0);
  const pending = serviceHarness({ source:{ status:'running' } });
  assert.throws(() => pending.service.quote({ user, scope, input }), /只能放大已完成的视频/);
});

test('replaying a request returns a fresh upload target without charging twice', async () => {
  const { service, charges } = serviceHarness();
  await service.create({ user, scope, input:{ ...input, requestId:'req-upscale-3' } });
  const replay = await service.create({ user, scope, input:{ sourceGenerationId:'src-1', requestId:'req-upscale-3' } });
  assert.equal(charges.length, 1);
  assert.equal(replay.upload.url, 'https://upload/video-upscale/user-1/req-upscale-3.mp4');
  await assert.rejects(service.create({ user, scope, input:{ sourceGenerationId:'other', requestId:'req-upscale-3' } }), /不能用于不同操作/);
});

test('completing an upload checks the stored object before starting the job', async () => {
  const missing = serviceHarness({ head:null });
  await missing.service.create({ user, scope, input:{ ...input, requestId:'req-upscale-4' } });
  await assert.rejects(missing.service.complete({ user, scope, input:{ taskId:'req-upscale-4' } }), /还没有上传完成/);
  assert.equal(missing.jobs.length, 0);

  const ready = serviceHarness();
  await ready.service.create({ user, scope, input:{ ...input, requestId:'req-upscale-5' } });
  const result = await ready.service.complete({ user, scope, input:{ taskId:'req-upscale-5' } });
  assert.equal(result.task.awaitingReferences, false);
  assert.deepEqual(ready.jobs, [{ userId:'user-1', generationId:'req-upscale-5' }]);
  assert.equal(ready.tasks.get('req-upscale-5').upscale.sourceBytes, 2_000_000);
});

test('abandoned uploads expire and are refunded through the shared failure path', async () => {
  const { service, tasks, failures } = serviceHarness();
  await service.create({ user, scope, input:{ ...input, requestId:'req-upscale-6' } });
  const task = tasks.get('req-upscale-6');
  assert.equal(service.uploadExpired(task, Date.parse(task.createdAt) + 60_000), false);
  assert.equal(service.uploadExpired(task, Date.parse(task.createdAt) + 3 * 3600_000), true);
  await service.expireUpload('user-1', task);
  assert.deepEqual(failures, ['视频上传未完成，请重新发起高清放大']);
  assert.equal(task.awaitingReferences, false);
});

test('upscale cards show upload progress and an upscale-specific processing label', () => {
  const presentation = createGenerationPresentation({});
  const uploading = presentation.generationPreparationMarkup({ modelId:'video-upscale', awaitingReferences:true }, 42);
  assert.match(uploading, /正在上传视频/);
  assert.match(uploading, /42%/);
  assert.match(presentation.videoProgressMarkup({ type:'video', status:'running', modelId:'video-upscale', progressStage:'provider_processing' }), /正在放大视频/);
  assert.equal(presentation.videoProgressMarkup({ type:'video', status:'running', progressStage:'provider_processing' }), '');
});

test('upscale failures use upscale wording and never trigger prompt repair', async () => {
  const failure = __test.generationFailure({ modelId:'video-upscale', error:'视频分辨率超出可放大范围' });
  assert.equal(failure.message, '这个视频的分辨率无法放大');
  assert.equal(__test.generationFailure({ modelId:'video-upscale', error:'视频上传未完成：网络连接中断' }).code, 'UPSCALE_UPLOAD_FAILED');
  const publicTask = __test.publicGeneration({ id:'t', type:'video', status:'running', modelId:'video-upscale', upscale:{ sourceGenerationId:'s', sourceWidth:1, sourceHeight:2, outputWidth:2, outputHeight:4, sourceKey:'secret/key.mp4', bitRate:10 } });
  assert.deepEqual(publicTask.upscale, { sourceGenerationId:'s', sourceWidth:1, sourceHeight:2, outputWidth:2, outputHeight:4 });
  let called = false;
  const repaired = await repairGenerationPrompt({ type:'video', prompt:'城市夜景', upscale:{} }, Object.assign(new Error('content policy violation'), { upstreamTerminal:true }), { callLlm:async () => { called = true; }, config:{}, save:async () => {} });
  assert.equal(repaired, false);
  assert.equal(called, false);
});

test('changed frontend modules are reachable through current cache keys', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const controller = readFileSync(new URL('../public/features/generation/upscale-controller.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(app, /features\/generation\/presentation\.js\?v=5'/);
  assert.match(app, /features\/generation\/upscale-controller\.js\?v=2'/);
  assert.match(app, /features\/credits\/presentation\.js\?v=6'/);
  assert.match(app, /features\/credits\/presentation\.js\?v=6'/);
  assert.match(controller, /'\.\/upscale\.js\?v=1'/);
  assert.match(html, /\/app\.js\?v=492"/);
  assert.match(html, /\/styles\.css\?v=367"/);
  assert.match(html, /id="videoUpscaleDialog"/);
});

test('local media can be read by fetch from the web-origin workbench', () => {
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /scheme: 'gugu-media', privileges: \{[^}]*supportFetchAPI: true[^}]*corsEnabled: true/);
});

test('a source the client cannot read points users to a client update', () => {
  const failure = __test.generationFailure({ modelId:'video-upscale', error:'视频上传未完成：读取本地视频失败' });
  assert.equal(failure.message, '无法读取本地视频');
  assert.match(failure.suggestion, /更新到最新版本/);
  assert.equal(__test.generationFailure({ modelId:'video-upscale', error:'视频文件无法读取，请确认文件完整后重试' }).message, '视频文件无法处理');
});


test('upscaling styled video stores only visible content and never exposes its private recipe',async()=>{
  const {service,tasks}=serviceHarness({source:{prompt:'PRIVATE_STYLE_RECIPE\n城市夜景',userPrompt:'城市夜景',dramaStyleSnapshot:{instruction:'PRIVATE_STYLE_RECIPE'}}});
  const result=await service.create({user,scope,input:{...input,requestId:'req-upscale-style'}});
  const task=tasks.get('req-upscale-style');
  assert.equal(task.prompt,'城市夜景');
  assert.equal(__test.publicGeneration(task).prompt,'城市夜景');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_STYLE_RECIPE'));
});
