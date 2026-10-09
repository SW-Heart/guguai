import { normalizeDramaStyle, visibleGenerationPrompt } from '../lib/drama-style.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationRouteHandler } from '../server/routes/generations.mjs';
import { createPromptPrecheckRouteHandler } from '../server/routes/prompt-precheck.mjs';
import { scanPromptRisk } from '../lib/prompt-precheck.mjs';

function precheckFixture(mode = 'shadow') {
  const events = [];
  return { events, promptPrecheck:{ mode:() => mode, scan:(prompt, { modelId }) => scanPromptRisk(prompt, { modelId }), record:event => events.push(event) } };
}

function generationFixture({ mode = 'shadow', input, fingerprintInputs = [], project = null }) {
  const { events, promptPrecheck } = precheckFixture(mode);
  const records = new Map();
  let charges = 0, id = 0;
  const handler = createGenerationRouteHandler({
    bodyJson:async () => input,
    sendJson:(res, status, body) => { res.statusCode = status; res.body = body; },
    requireUser:() => ({ id:'user-1' }),
    requireDesktopWorkspaceScope:() => ({ deviceId:'device-1', workspaceId:'workspace-1' }),
    findGeneration:(_userId, generationId) => records.get(generationId) || null,
    safeId:value => String(value || ''), publicGeneration:task => ({id:task.id,prompt:visibleGenerationPrompt(task)}), publicDramaProject:project => project, loadDramaProject:async (_user,id) => project?.id===id?project:null,
    validateReferenceAssets:async (_user,ids) => ids || [], referenceAssetCounts:() => ({}), normalizeQuoteReferenceCounts:() => ({}),
    assertReferenceCountsWithinLimits:() => {}, selectModelRoute:() => null, publicRoutePriceVersion:() => '',
    currentPricing:() => ({ imagePerRequestMicro:3_000_000 }), pricingSnapshot:pricing => ({ version:'price-1', total:3, totalMicro:pricing.imagePerRequestMicro }),
    creditsToMicro:value => Number(value) * 1_000_000, charLength:value => Array.from(value).length,
    walletOf:() => ({ balance:100 }),
    chargeGenerationMicro:async (_userId, _id, _cost, metadata) => { charges++; metadata.onCharged(); return { balance:97 }; },
    createGenerationRequest:() => {}, findGenerationRequest:() => null,
    generationRequestFingerprint:value => { fingerprintInputs.push(value.input); return 'fingerprint'; },
    enqueueGenerationJob:() => {}, saveGeneration:(_userId, task) => { records.set(task.id, task); return task; },
    ensureUserDirs:async () => {}, randomId:() => `generated-${++id}`, now:() => '2026-10-08T00:00:00.000Z',
    isModelEnabled:() => true, fixedModels:{ image:'gpt-image-2' }, imageSizes:new Set(['1:1']), imageModelIds:new Set(['gpt-image-2']),
    tuziImageModelId:'gpt-image-2.5', tuziImageSizes:new Set(), tuziImageTiers:new Set(), tuziImageCredits:{},
    videoModelIds:{}, legacyVideoModelIds:{}, r2ReferenceConfigured:true, r2ReferencePublicBaseUrl:'https://reference.test',
    providerAvailability:{ duomi:true }, runtimeMetrics:{ idempotencyConflicts:0 }, activeGenerations:new Set(),
    promptPrecheck,
  });
  const submit = async () => { const res = {}; await handler({ method:'POST', headers:{} }, res, new URL('http://localhost/api/generations')); return res; };
  return { handler, submit, events, records, charges:() => charges };
}

const image = prompt => ({ type:'image', modelId:'gpt-image-2', prompt, size:'1:1', quality:'medium', referenceAssetIds:[], requestId:'request-abcdef12' });

test('shadow mode records matched prompts with their generation and never blocks', async () => {
  const fixture = generationFixture({ input:image('她一丝不挂地站在窗边') });
  const res = await fixture.submit();
  assert.equal(res.statusCode, 202);
  assert.equal(fixture.charges(), 1);
  assert.equal(fixture.events.length, 1);
  const [event] = fixture.events;
  assert.equal(event.outcome, 'shadow');
  assert.equal(event.source, 'image');
  assert.deepEqual(event.generationIds, [res.body.id]);
  assert.deepEqual(event.hits.map(hit => [hit.term, hit.level]), [['一丝不挂', 'suspect']]);
});

test('clean prompts leave no record', async () => {
  const fixture = generationFixture({ input:image('夜晚的城市街头') });
  assert.equal((await fixture.submit()).statusCode, 202);
  assert.equal(fixture.events.length, 0);
});

test('enforce mode asks for confirmation on red marks before any charge', async () => {
  const input = { ...image('习近平出席会议'), precheckSource:'image' };
  const fingerprintInputs = [];
  const fixture = generationFixture({ mode:'enforce', input, fingerprintInputs });
  const blocked = await fixture.submit();
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.code, 'PROMPT_PRECHECK_REQUIRED');
  assert.deepEqual(blocked.body.precheck.hits, [{ start:0, end:3, level:'banned', label:'涉及国家领导人' }]);
  assert.equal(fixture.charges(), 0);
  assert.equal(fixture.records.size, 0);
  assert.equal(fixture.events.at(-1).outcome, 'blocked');

  // Confirming reuses the same idempotency key: the confirmation flags are not part of the request fingerprint.
  Object.assign(input, { precheckConfirmed:true, precheckOutcome:'confirmed_banned' });
  const accepted = await fixture.submit();
  assert.equal(accepted.statusCode, 202);
  assert.equal(fixture.events.at(-1).outcome, 'confirmed_banned');
  assert.deepEqual(fingerprintInputs[0], fingerprintInputs[1]);
  assert.ok(!('precheckConfirmed' in fingerprintInputs[1]));
});

test('enforce mode lets yellow marks through and records them', async () => {
  const fixture = generationFixture({ mode:'enforce', input:image('李强推开办公室的门') });
  assert.equal((await fixture.submit()).statusCode, 202);
  assert.equal(fixture.events[0].outcome, 'not_prompted');
});

test('agent submissions and direct service calls are never checked', async () => {
  const fixture = generationFixture({ mode:'enforce', input:{ ...image('习近平出席会议'), precheckSource:'agent' } });
  assert.equal((await fixture.submit()).statusCode, 202);
  const direct = await fixture.handler.submit({ user:{ id:'user-1' }, scope:{ deviceId:'device-1', workspaceId:'workspace-1' }, input:{ ...image('习近平出席会议'), requestId:'request-direct01' } });
  assert.equal(direct.status, 202);
  assert.equal(fixture.events.length, 0);
});

test('off mode skips scanning entirely', async () => {
  const fixture = generationFixture({ mode:'off', input:image('习近平出席会议') });
  assert.equal((await fixture.submit()).statusCode, 202);
  assert.equal(fixture.events.length, 0);
});

test('a failing event store never fails a paid submission', async () => {
  const fixture = generationFixture({ input:image('一丝不挂') });
  fixture.events.push = () => { throw new Error('disk full'); };
  const errors = [];
  const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  try { assert.equal((await fixture.submit()).statusCode, 202); } finally { console.error = original; }
  assert.match(errors[0], /record failed/);
});

function routeFixture({ body, mode = 'shadow', limit } = {}) {
  const { events, promptPrecheck } = precheckFixture(mode);
  const route = createPromptPrecheckRouteHandler({
    bodyJson:async () => body, sendJson:(res, status, value) => { res.statusCode = status; res.body = value; },
    requireUser:() => ({ id:'user-1' }), promptPrecheck, ...(limit ? { limit } : {}),
  });
  const call = async (path = '/api/prompt-precheck') => { const res = {}; const handled = await route({ method:'POST' }, res, new URL(`http://localhost${path}`)); return { handled, ...res }; };
  return { call, events };
}

test('the check endpoint returns marks without internal lexicon details', async () => {
  const { call } = routeFixture({ body:{ modelId:'seedance-2.0', prompts:['小学生穿着比基尼摆拍', '夜晚街头'] } });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'shadow');
  assert.match(res.body.lexiconVersion, /^[0-9a-f]{12}$/);
  assert.deepEqual(res.body.results[0].hits, [
    { start:0, end:3, level:'banned', label:'未成年人与性暗示' },
    { start:5, end:8, level:'banned', label:'未成年人与性暗示' },
  ]);
  assert.deepEqual(res.body.results[1], { counts:{ banned:0, suspect:0 }, hits:[] });
  assert.doesNotMatch(JSON.stringify(res.body), /groupId|review|sourceIds|minor-sexual/);
});

test('the check endpoint validates input and limits request rate', async () => {
  for (const body of [{ prompts:[] }, { prompts:'x' }, { prompts:[1] }, { prompts:Array(21).fill('x') }, { modelId:1, prompts:['x'] }])
    assert.equal((await routeFixture({ body }).call()).statusCode, 400);
  const { call } = routeFixture({ body:{ prompts:['x'] }, limit:2 });
  assert.equal((await call()).statusCode, 200);
  assert.equal((await call()).statusCode, 200);
  assert.equal((await call()).statusCode, 429);
});

test('cancelled dialogs are recorded only when the prompt matched', async () => {
  const matched = routeFixture({ body:{ outcome:'cancelled', source:'video', modelId:'seedance-2.0', prompt:'斩首的画面' } });
  assert.equal((await matched.call('/api/prompt-precheck/events')).statusCode, 200);
  assert.deepEqual(matched.events.map(event => [event.outcome, event.source, event.hits[0].term]), [['cancelled', 'video', '斩首']]);
  const clean = routeFixture({ body:{ outcome:'cancelled', source:'video', prompt:'街头' } });
  await clean.call('/api/prompt-precheck/events');
  assert.equal(clean.events.length, 0);
  assert.equal((await routeFixture({ body:{ outcome:'submitted', source:'video', prompt:'x' } }).call('/api/prompt-precheck/events')).statusCode, 400);
  assert.equal((await routeFixture({ body:{} }).call('/api/other')).handled, false);
});

test('precheck events persist matched terms and generation links', async () => {
  const { openDatabase, closeDatabase, sql } = await import('../lib/db.mjs');
  const { listPromptPrecheckEvents, recordPromptPrecheckEvent } = await import('../repositories/prompt-precheck.mjs');
  openDatabase({ file:':memory:' });
  try {
    sql(`INSERT INTO users(id, username, password_hash, created_at, doc_json) VALUES('u', 'precheck-user', 'hash', 'now', '{}')`).run();
    const { hits, lexiconVersion } = scanPromptRisk('习近平和李强出席', { modelId:'seedance-2.0' });
    recordPromptPrecheckEvent({ userId:'u', source:'video', modelId:'seedance-2.0', lexiconVersion, mode:'shadow', outcome:'shadow', hits, generationIds:['g-1'] });
    const [event] = listPromptPrecheckEvents();
    assert.equal(event.banned, 1);
    assert.equal(event.suspect, 1);
    assert.deepEqual(event.generationIds, ['g-1']);
    assert.deepEqual(event.hits.map(hit => [hit.groupId, hit.term]), [['political-figures', '习近平'], ['political-figures', '李强']]);
    assert.equal(listPromptPrecheckEvents({ since:'2999-01-01' }).length, 0);
  } finally { closeDatabase({ checkpoint:false }); }
});

test('admin stats link each dialog choice to how the work came out', async () => {
  const { aggregatePrecheckStats, generationResult } = await import('../lib/prompt-precheck-stats.mjs');
  assert.equal(generationResult({ status:'completed' }), 'success');
  assert.equal(generationResult({ status:'failed', error:'返回错误码 710082022，疑似包含侵权/违规内容' }), 'rejected');
  assert.equal(generationResult({ status:'failed', error:'503 service unavailable' }), 'other_failure');
  const hit = (term, level) => ({ groupId:'g', term, level });
  const events = [
    ...['a', 'b', 'c'].map(id => ({ outcome:'submitted_as_is', banned:0, hits:[hit('性感', 'suspect')], generationIds:[id] })),
    { outcome:'confirmed_banned', banned:1, hits:[hit('斩首', 'banned')], generationIds:['d'] },
    { outcome:'edited', banned:1, hits:[hit('斩首', 'banned')], generationIds:['e'] },
    { outcome:'cancelled', banned:1, hits:[hit('斩首', 'banned')], generationIds:[] },
    { outcome:'blocked', banned:1, hits:[hit('斩首', 'banned')], generationIds:[] },
  ];
  const results = new Map([['a', 'success'], ['b', 'success'], ['c', 'success'], ['d', 'rejected'], ['e', 'success']]);
  const stats = aggregatePrecheckStats({ events, results, generationTotal:40, misses:[{ id:'x' }] });
  assert.deepEqual(stats.summary, { checks:7, shown:6, blocked:1, edited:1, kept:4, confirmedRed:1, cancelled:1, generationTotal:40, shownRate:15 });
  assert.deepEqual(stats.accuracy, { redKept:1, redRejected:1, redRejectedRate:100, keptFinished:4, keptSuccessRate:75 });
  assert.deepEqual(stats.falsePositives.map(row => [row.term, row.kept, row.keptSuccess]), [['性感', 3, 3]]);
  assert.deepEqual(stats.terms.map(row => [row.term, row.triggers]), [['斩首', 4], ['性感', 3]]);
  assert.equal(stats.misses.length, 1);
});

test('admin stats read events and generations from the database', async () => {
  const { openDatabase, closeDatabase, sql } = await import('../lib/db.mjs');
  const { recordPromptPrecheckEvent } = await import('../repositories/prompt-precheck.mjs');
  const { promptPrecheckStats } = await import('../lib/prompt-precheck-stats.mjs');
  openDatabase({ file:':memory:' });
  try {
    sql(`INSERT INTO users(id, username, password_hash, created_at, doc_json) VALUES('u', 'stats-user', 'hash', 'now', '{}')`).run();
    const insert = (id, doc) => sql(`INSERT INTO generations(id,user_id,type,status,created_at,updated_at,doc_json) VALUES(?,?,?,?,?,?,?)`).run(id, 'u', 'video', doc.status, new Date().toISOString(), new Date().toISOString(), JSON.stringify(doc));
    insert('g-ok', { status:'completed', prompt:'斩首' });
    insert('g-miss', { status:'failed', prompt:'普通描述', error:'返回错误码 710082022，疑似包含侵权/违规内容' });
    const { hits, lexiconVersion } = scanPromptRisk('斩首', {});
    recordPromptPrecheckEvent({ userId:'u', source:'video', modelId:'', lexiconVersion, mode:'enforce', outcome:'confirmed_banned', hits, generationIds:['g-ok'] });
    const stats = promptPrecheckStats({ days:7 });
    assert.equal(stats.summary.generationTotal, 2);
    assert.deepEqual(stats.accuracy.redRejectedRate, 0);
    assert.deepEqual(stats.misses.map(item => [item.id, item.prompt]), [['g-miss', '普通描述']]);
  } finally { closeDatabase({ checkpoint:false }); }
});


test('project style reaches the provider prompt without adding cover references or exposing its recipe', async () => {
  const project={id:'drama-1',style:normalizeDramaStyle({id:'youth-anime'})};
  const input={...image('一名黑发女生拿着白色杯子，办公室窗边'),dramaProjectId:project.id,dramaStyleRevision:1,referenceAssetIds:['actual-character']};
  const fixture=generationFixture({input,project});
  const response=await fixture.submit();
  assert.equal(response.statusCode,202);
  assert.equal(response.body.prompt,input.prompt);
  const record=fixture.records.get(response.body.id);
  assert.match(record.prompt,/二维赛璐璐动画/);
  assert.ok(record.prompt.endsWith(input.prompt));
  assert.deepEqual(record.referenceAssetIds,['actual-character']);
  assert.equal(record.dramaStyleSnapshot.revision,1);
  assert.equal(record.stylePromptMaxLength,5000);
  assert.ok(!JSON.stringify(response.body).includes(record.dramaStyleSnapshot.instruction));
  project.style=normalizeDramaStyle({id:'live-action'},{previous:project.style,update:true});
  assert.match(record.prompt,/二维赛璐璐动画/);
  assert.equal(record.dramaStyleSnapshot.revision,1);
});

test('stale project style is rejected before billing and project ownership is required', async () => {
  const project={id:'drama-1',style:normalizeDramaStyle({id:'live-action',revision:2})};
  const input={...image('一间办公室'),dramaProjectId:project.id,dramaStyleRevision:1};
  const fixture=generationFixture({input,project});
  assert.equal((await fixture.submit()).body.code,'DRAMA_STYLE_CHANGED');
  assert.equal(fixture.charges(),0);
  input.dramaProjectId='another-owner';
  assert.equal((await fixture.submit()).statusCode,404);
  assert.equal(fixture.charges(),0);
});

test('style application keeps precheck hit positions relative to visible content', async () => {
  const project={id:'drama-1',style:normalizeDramaStyle({id:'live-action'})};
  const fixture=generationFixture({mode:'enforce',project,input:{...image('习近平出席会议'),dramaProjectId:project.id}});
  const response=await fixture.submit();
  assert.equal(response.body.code,'PROMPT_PRECHECK_REQUIRED');
  assert.deepEqual(response.body.precheck.hits,[{start:0,end:3,level:'banned',label:'涉及国家领导人'}]);
});
