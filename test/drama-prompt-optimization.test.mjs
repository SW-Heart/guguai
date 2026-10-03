import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildPromptOptimizationInput, buildPromptOptimizationReferences, loadPromptOptimizationGuidance, validatePromptOptimization } from '../lib/prompt-optimization.mjs';
import { buildShotVideoPrompt, orderedShotReferenceMentions, videoPromptMaxLength } from '../public/video-prompt.js';
import { createProjectService } from '../services/projects.mjs';
import { createPromptOptimizationSession } from '../public/features/drama/prompt-optimization.js';
import { createDirectorService } from '../services/director.mjs';
import { createDramaRouteHandler } from '../server/routes/drama.mjs';

test('the optimization button precedes generation and every changed frontend entry uses a fresh cache key', () => {
  const read = file => readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8');
  const studio = read('drama-studio.js');
  assert.match(studio, /promptOptimizationButton\(shot,locked\)\}<button type="button" class="wb-generate-button"/);
  assert.ok(studio.includes('./features/drama/prompt-optimization.js?v=4'));
  assert.ok(read('features/drama/prompt-optimization.js').includes('./prompt-optimization-loading.js?v=1'));
  assert.ok(read('app.js').includes('./drama-studio.js?v=220'));
  assert.ok(read('index.html').includes('/app.js?v=479'));
  assert.ok(read('index.html').includes('/styles.css?v=360'));
  const css = read('styles.css');
  assert.match(css,/prompt-optimization-comparison\{[^}]*grid-template-columns:1fr 1fr/);
  assert.match(css,/@media\(max-width:640px\)[\s\S]*prompt-optimization-comparison\{grid-template-columns:1fr/);
});

test('optimization preserves exact material names and rejects incomplete or overlong results', () => {
  const input = buildPromptOptimizationInput({ originalPrompt:'@小美.png 走进房间', prompt:'@小美.png 走进房间', mentionLabels:['小美.png','小蓝'], maxLength:40 });
  assert.deepEqual(input.mentionTokens, ['@小美.png']);
  const valid = JSON.stringify({ prompt:'@小美.png 缓缓走进房间，镜头跟随。', suggestions:['补充动作节奏和镜头运动'] });
  assert.equal(validatePromptOptimization(valid, input).suggestions.length, 1);
  assert.throws(() => validatePromptOptimization(JSON.stringify({ prompt:'小美走进房间', suggestions:['补充动作'] }), input), /引用素材/);
  assert.throws(() => validatePromptOptimization(JSON.stringify({ prompt:'@小美.png'.repeat(10), suggestions:['补充动作'] }), input), /过长/);
  assert.throws(() => validatePromptOptimization(JSON.stringify({ prompt:'@小美.png 走进房间', suggestions:[] }), input), /改动建议/);
});

test('reoptimization uses the editable draft and optional direction without changing the original', async () => {
  const bodies = [];
  const session = createPromptOptimizationSession({ original:'原始分镜', request:async body => {
    bodies.push(body); return { prompt:`优化版本 ${bodies.length}`, suggestions:['明确动作'], balance:8 };
  } });
  assert.equal(session.canConfirm(), false);
  await session.optimize();
  assert.equal(session.canConfirm(), true);
  session.edit('用户手动编辑的版本');
  await session.optimize('突出紧张感');
  assert.deepEqual(bodies[1], { originalPrompt:'原始分镜', prompt:'用户手动编辑的版本', direction:'突出紧张感' });
  assert.equal(session.state.original, '原始分镜');
  session.edit('');
  assert.equal(session.canConfirm(), false);
  assert.equal(await session.optimize(), false);
  assert.equal(bodies.length, 2);
});

test('optimization failures keep the last editable version and allow retry', async () => {
  let count = 0;
  const session = createPromptOptimizationSession({ original:'原文', request:async () => {
    if (++count === 2) throw new Error('暂时不可用');
    return { prompt:'第一次优化', suggestions:['明确动作'] };
  } });
  await session.optimize(); session.edit('手动修改');
  await session.optimize();
  assert.equal(session.state.draft, '手动修改');
  assert.equal(session.state.error, '暂时不可用');
  assert.equal(session.canConfirm(), true);
  assert.equal(await session.optimize(), true);
});

test('cancel and account changes discard delayed results and duplicate requests are ignored', async () => {
  let complete, calls = 0, balances = [];
  const session = createPromptOptimizationSession({ original:'原文', onBalance:value => balances.push(value), request:() => { calls++; return new Promise(resolve => complete = resolve); } });
  const pending = session.optimize();
  assert.equal(await session.optimize(), false);
  session.close(); complete({ prompt:'延迟版本', suggestions:['明确动作'], balance:9 });
  assert.equal(await pending, false);
  assert.equal(session.state.draft, ''); assert.equal(calls, 1);
  assert.equal(session.canConfirm(), false);
  assert.deepEqual(balances, [9]);
  let current = true;
  const other = createPromptOptimizationSession({ original:'原文', isCurrent:() => current, onBalance:value => balances.push(value), request:() => new Promise(resolve => complete = resolve) });
  const oldAccount = other.optimize(); current = false;
  complete({ prompt:'旧账号版本', suggestions:['明确动作'], balance:2 });
  assert.equal(await oldAccount, false); assert.equal(other.state.draft, '');
  assert.deepEqual(balances, [9]);
});

test('draft character limits count Unicode characters and block invalid confirmation', async () => {
  const session = createPromptOptimizationSession({ original:'原文', maxLength:3, request:async () => ({ prompt:'😀😀😀', suggestions:['调整'] }) });
  await session.optimize(); assert.equal(session.canConfirm(), true);
  session.edit('😀😀😀😀'); assert.equal(session.canConfirm(), false);
  assert.equal(await session.optimize(), false);
});

function directorDeps(overrides = {}) {
  return { storyboardEngineVersion:3, llmConfig:{ model:'test-model' }, llmRates:{}, randomId:() => 'request',
    conservativeInputTokenUpperBound:() => 10, llmReservationMicro:() => 1,
    reserveLlmCredits:async () => ({}), settleLlmCredits:async () => ({ wallet:{balance:9} }),
    releaseLlmCredits:async () => {}, markLlmBillingReconcile:async () => {},
    callLlm:async () => ({text:JSON.stringify({prompt:'@小美.png 推门走进房间',suggestions:['明确进门动作']})}),
    skills:{read:async (name,resource) => ({text:`${name}/${resource}:实际创作资料`})},
    publicLlmUsage:value => value, publicDramaProject:value => value, normalizeDramaProject:value => value, ...overrides };
}
const serviceInput = { userId:'u', project:{id:'p'}, shot:{duration:15,generation:{modelId:'seedance-2.5',type:'REFERENCE'}}, originalPrompt:'@小美.png 进门', prompt:'@小美.png 进门', mentionLabels:['小美.png'], maxLength:4096 };
test('optimization uses the existing AI billing service and never persists unconfirmed content', async () => {
  let settled = 0;
  const service = createDirectorService(directorDeps({ callLlm:async options => {
    const body = JSON.parse(options.prompt);
    assert.equal(body.video.duration, 15); assert.equal(body.video.model, 'seedance-2.5');
    assert.deepEqual(body.mentionTokens, ['@小美.png']);
    assert.match(options.system, /short-drama\/references\/storyboard-handoff.md/);
    assert.match(options.system, /video-production\/references\/camera-and-blocking.md/);
    assert.match(options.system, /seedance-creation-bible\/references\/seedance-25-writing.md/);
    return {text:JSON.stringify({prompt:'@小美.png 推门走进房间',suggestions:['明确进门动作']})};
  }, settleLlmCredits:async () => { settled++; return {wallet:{balance:9}}; } }));
  const project = structuredClone(serviceInput.project);
  const result = await service.optimizeShotPrompt({...serviceInput,project});
  assert.equal(result.balance, 9); assert.equal(settled, 1);
  assert.deepEqual(project, serviceInput.project);
});

test('AI failures release reservations and missing usage goes through reconciliation', async () => {
  for (const reconcile of [false,true]) {
    let released = 0, marked = 0;
    const service = createDirectorService(directorDeps({ callLlm:async () => { throw Object.assign(new Error('服务失败'), {billingReconcileRequired:reconcile}); },
      releaseLlmCredits:async () => released++, markLlmBillingReconcile:async () => marked++ }));
    await assert.rejects(service.optimizeShotPrompt(serviceInput), /服务失败/);
    assert.equal(released, reconcile ? 0 : 1); assert.equal(marked, reconcile ? 1 : 0);
  }
});

test('invalid paid AI results return the settled balance and do not refund consumed usage', async () => {
  let releases = 0;
  const service = createDirectorService(directorDeps({ callLlm:async () => ({text:'{"prompt":"遗漏素材","suggestions":["调整"]}'}), releaseLlmCredits:async () => releases++ }));
  await assert.rejects(service.optimizeShotPrompt(serviceInput), error => error.publicData.balance === 9 && /引用素材/.test(error.message));
  assert.equal(releases, 0);
});

test('optimization API requires the owned workspace and valid shot and limits before calling AI', async () => {
  let input = {prompt:'@小美.png 进门',originalPrompt:'原文',direction:'更自然'};
  let project = {id:'p',shots:[{id:'s',assetMentions:[{label:'小美.png'}],generation:{modelId:'seedance-2.5',type:'REFERENCE'}}]};
  let calls = 0, status, result;
  const scope = {deviceId:'d',workspaceId:'w'};
  const handler = createDramaRouteHandler({ requireUser:() => ({id:'u'}), requireDesktopWorkspaceScope:() => scope,
    bodyJson:async () => input, charLength:value => Array.from(value).length,
    loadDramaProject:async (owner,id,suppliedScope) => { assert.equal(owner,'u');assert.equal(id,'p');assert.equal(suppliedScope,scope);return project; },
    sendJson:(_res,code,body) => {status=code;result=body;}, isLlmConfigured:() => true,
    getVideoModels:() => [{id:'seedance-2.5',modes:[{generationType:'REFERENCE'}]}],
    optimizeShotPrompt:async value => { calls++;assert.equal(value.shot.id,'s');assert.deepEqual(value.mentionLabels,['小美.png']);return {prompt:'结果',suggestions:['建议']}; } });
  const req = {method:'POST'}, url = new URL('http://localhost/api/drama/projects/p/shots/s/optimize-prompt');
  assert.equal(await handler(req,{},url), true); assert.equal(status,200);assert.equal(result.prompt,'结果');
  input = {prompt:'字'.repeat(4097)}; await handler(req,{},url);assert.equal(status,400);
  input = {prompt:'有效',direction:'字'.repeat(1001)};await handler(req,{},url);assert.equal(status,400);
  project = null; await handler(req,{},url);assert.equal(status,404);assert.equal(calls,1);
});

test('accepted edited content updates the correct shot, retains mention chips and is saved', async () => {
  const source = readFileSync(new URL('../public/drama-studio.js',import.meta.url),'utf8');
  const code = source.slice(source.indexOf('  function openShotPromptOptimization('),source.indexOf('  function optimizedShotEditorMarkup('));
  const editor = {innerHTML:''};
  let options, saved = 0;
  const shot = {id:'s',script:'@小美.png 原始动作',assetMentions:[{id:'asset',label:'小美.png'}],generation:{modelId:'seedance-2.5'}};
  const context = { project:{id:'p',shots:[shot]}, state:{route:'drama'}, MINIMAX_H3_15S_MODEL_ID:'minimax-h3-15s',
    resolveRichEditor:() => editor, updateShotScriptFromEditor:(_id,target) => {if(target.innerHTML){shot.script=target.innerHTML;shot.promptOverride=shot.script;}},
    videoPromptMaxLength,shotGenerationAssetIds:() => [],asset:() => null,
    projectRequest:() => ({}), isProjectRequestCurrent:() => true, assertProjectRequest(){},closeMentionPicker(){},closeWorkbenchDropdowns(){},
    promptOptimization:{open:value => options=value},releaseWorkbenchVideos(){},workbenchReferenceRow:() => '',
    renderMentionEditorContent:value => {assert.deepEqual(value.assetMentions,shot.assetMentions);return value.script;},
    optimizedShotEditorMarkup:(item,value) => {assert.deepEqual(item.assetMentions,shot.assetMentions);return value;},
    bindMentionChipInteractions(){},hydrateWorkbenchVideos(){},flushSave:async () => {saved++;},toast(){} };
  vm.createContext(context);vm.runInContext(code,context);context.openShotPromptOptimization('s');
  assert.equal(shot.script,'@小美.png 原始动作');assert.equal(saved,0);
  await options.apply('@小美.png 用户编辑后的动作');
  assert.equal(shot.promptOverride,'@小美.png 用户编辑后的动作');assert.equal(saved,1);
  assert.equal(shot.assetMentions[0].id,'asset');
  shot.script='其他用户的修改';await assert.rejects(options.apply('覆盖'),/已有变化/);
});

test('reference identities, kinds, aliases and slots include unnamed inputs in upload order', () => {
  const shot = {id:'s',referenceAssetIds:['background','girl','voice'],assetMentions:[{id:'girl',label:'小美.png',kind:'image'},{id:'voice',label:'对白',kind:'audio'}],generation:{type:'REFERENCE',modelId:'seedance-2.5'}};
  const files = [{id:'background',name:'房间',kind:'image'},{id:'girl',name:'小美.png',kind:'image'},{id:'voice',name:'对白.wav',kind:'audio'}];
  const references = buildPromptOptimizationReferences(shot,files);
  assert.deepEqual(references.map(item => item.slot),['Image1','Image2','Audio1']);
  const input = buildPromptOptimizationInput({shot,references,originalPrompt:'@小美.png 听 @对白',prompt:'@小美.png 听 @对白'});
  assert.deepEqual(input.mentionBindings.map(item => [item.token,item.id,item.kind]),[['@小美.png','girl','image'],['@对白','voice','audio']]);
  const ordered = orderedShotReferenceMentions(shot,files);
  const prompt = buildShotVideoPrompt({shot:{...shot,assetMentions:ordered,promptOverride:'@小美.png 听 @对白'},project:{}});
  assert.equal(prompt,'Image2 听 Audio1');
  assert.equal(references[1].visualContentVerified,false);
  assert.equal(shot.assetMentions.length,2,'numbering does not change project bindings');
});

test('first and last frames remain in role order including last-frame-only input', () => {
  const shot = {generation:{type:'FIRST&LAST',firstFrameAssetId:'first',lastFrameAssetId:'last'},referenceAssetIds:['other']};
  const references = buildPromptOptimizationReferences(shot);
  assert.deepEqual(references.map(item => [item.id,item.role]),[['first','first-frame'],['last','last-frame']]);
  assert.equal(buildPromptOptimizationReferences({generation:{type:'FIRST&LAST',lastFrameAssetId:'last'}})[0].role,'last-frame');
});

test('longest aliases are protected independently, repeated tokens cannot disappear and invented refs are rejected', () => {
  const source = '@小美丽 走向 @小美，@小美 转身。';
  const input = buildPromptOptimizationInput({prompt:source,originalPrompt:source,mentionLabels:['小美','小美丽']});
  assert.deepEqual(input.mentionBindings.map(item => [item.token,item.count]),[['@小美丽',1],['@小美',2]]);
  const output = prompt => JSON.stringify({prompt,suggestions:['明确动作']});
  assert.throws(() => validatePromptOptimization(output('@小美丽 走向 @小美。'),input),/缺少引用素材/);
  assert.throws(() => validatePromptOptimization(output(`${source} @新人物 推门。`),input),/新的素材引用/);
  assert.equal(validatePromptOptimization(output(source),input).prompt,source);
  const shorter = buildPromptOptimizationInput({prompt:'@小美 进门',originalPrompt:'@小美 进门',mentionLabels:['小美','小美丽']});
  assert.throws(() => validatePromptOptimization(output('@小美丽 进门'),shorter),/缺少引用素材/);
  const email = buildPromptOptimizationInput({prompt:'邮件发给 artist@example.com',originalPrompt:'邮件发给 artist@example.com',mentionLabels:['example.com']});
  assert.deepEqual(email.mentionTokens,[]);
  const ambiguous = {assetMentions:[{id:'a',label:'小美'},{id:'b',label:'小美'}]};
  assert.throws(() => buildPromptOptimizationInput({shot:ambiguous,prompt:'@小美 走进房间'}),/同名项/);
});

test('optimization repairs selected material filenames and model slots to the original ID-bound alias', () => {
  const shot = {assetMentions:[{id:'girl',label:'小美',kind:'image'},{id:'voice',label:'对白',kind:'audio'}],generation:{type:'REFERENCE'}};
  const references = buildPromptOptimizationReferences(shot,[{id:'girl',name:'girl portrait.png',kind:'image'},{id:'voice',name:'line.wav',kind:'audio'}]);
  const source = '@小美 看向窗外，@小美 听到 @对白。';
  const input = buildPromptOptimizationInput({shot,references,prompt:source,originalPrompt:source});
  for (const [girl,voice] of [['@girl portrait.png','@line.wav'],['@Image1','@Audio1'],['@图片1','@音频1']]) {
    const result = validatePromptOptimization(JSON.stringify({prompt:`${girl} 缓缓看向窗外，${girl} 听到 ${voice}。`,suggestions:['明确动作节奏']}),input);
    assert.equal(result.prompt,'@小美 缓缓看向窗外，@小美 听到 @对白。');
  }
  assert.equal(input.prompt,source); assert.equal(shot.assetMentions[0].label,'小美');
});

test('optimization removes an added @ only from selected material names already written as plain text', () => {
  const source = '小美走进客厅。';
  const input = buildPromptOptimizationInput({prompt:source,originalPrompt:source,references:[{id:'girl',label:'小美',aliases:[],slot:'Image1'},{id:'room',label:'客厅',aliases:[],slot:'Image2'}]});
  const result = validatePromptOptimization(JSON.stringify({prompt:'@小美 缓缓走进 @客厅。',suggestions:['明确动作节奏']}),input);
  assert.equal(result.prompt,'小美 缓缓走进 客厅。');
  const unknown = JSON.stringify({prompt:'@陌生人 走进客厅。',suggestions:['调整']});
  assert.throws(() => validatePromptOptimization(unknown,input),error => error.code === 'PROMPT_OPTIMIZATION_NEW_REFERENCE');
});

test('normalization still rejects unused selected references and filename prefixes from different materials', () => {
  const input = buildPromptOptimizationInput({prompt:'@小美 进门。',originalPrompt:'@小美 进门。',shot:{assetMentions:[{id:'girl',label:'小美',kind:'image'}]},references:[{id:'girl',label:'girl.png',aliases:['小美'],slot:'Image1'},{id:'room',label:'客厅',aliases:[],slot:'Image2'}]});
  for (const prompt of ['@小美 进门 @客厅。','@小美 进门 @Image2。','@小美 进门 @girl.png.backup。']) {
    assert.throws(() => validatePromptOptimization(JSON.stringify({prompt,suggestions:['调整']}),input),error => error.code === 'PROMPT_OPTIMIZATION_NEW_REFERENCE');
  }
});

test('ambiguous selected aliases and repeated-reference loss are never silently repaired', () => {
  const source = '@小美 走向 @小蓝，@小美 停下。';
  const shot = {assetMentions:[{id:'girl',label:'小美'},{id:'other',label:'小蓝'}]};
  const references = [{id:'girl',label:'portrait.png',aliases:['小美'],slot:'Image1'},{id:'other',label:'portrait.png',aliases:['小蓝'],slot:'Image2'}];
  const input = buildPromptOptimizationInput({shot,references,prompt:source,originalPrompt:source});
  for (const prompt of ['@portrait.png 走向 @小蓝，@小美 停下。','@Image1 走向 @小蓝。']) {
    assert.throws(() => validatePromptOptimization(JSON.stringify({prompt,suggestions:['调整']}),input),error => error.code === 'PROMPT_OPTIMIZATION_MISSING_REFERENCE');
  }
});

test('email addresses, original unknown @ text, and similarly prefixed known aliases survive normalization', () => {
  const source = '@小美 进门，请联系 artist@girl.png，保留 @原文标记。';
  const input = buildPromptOptimizationInput({prompt:source,originalPrompt:source,shot:{assetMentions:[{id:'girl',label:'小美'}]},references:[{id:'girl',label:'girl.png',aliases:['小美'],slot:'Image1'}],mentionLabels:['girl.png.extra']});
  const output = prompt => JSON.stringify({prompt,suggestions:['明确动作']});
  assert.equal(validatePromptOptimization(output(source),input).prompt,source);
  assert.throws(() => validatePromptOptimization(output(`${source} @girl.png.extra`),input),error => error.code === 'PROMPT_OPTIMIZATION_NEW_REFERENCE');
});

test('same-material name correction settles the original call once without extra AI requests', async () => {
  let calls = 0, settled = 0;
  const service = createDirectorService(directorDeps({callLlm:async () => { calls++; return {text:'{"prompt":"@Image1 缓缓进门","suggestions":["明确动作节奏"]}'};},settleLlmCredits:async () => {settled++; return {wallet:{balance:9}};}}));
  const result = await service.optimizeShotPrompt({...serviceInput,shot:{...serviceInput.shot,assetMentions:[{id:'girl',label:'小美.png',kind:'image'}]},references:[{id:'girl',label:'portrait.png',aliases:['小美.png'],slot:'Image1'}]});
  assert.equal(result.prompt,'@小美.png 缓缓进门'); assert.equal(calls,1); assert.equal(settled,1); assert.equal(result.balance,9);
});

test('optimization includes current shot sources, selected characters, neighbors and actual model capabilities', () => {
  const shot = {id:'s',sceneId:'scene',sourceBeatIds:['line'],resourceIds:['r'],generation:{modelId:'seedance-2.5',type:'REFERENCE',quality:'480p'},duration:15,aspectRatio:'16:9',startState:'钥匙在右手',endState:'钥匙落桌'};
  const project = {shots:[{id:'before',endState:'走到桌前'},shot,{id:'after',startState:'钥匙在桌上'}],scenes:[{id:'scene',location:'客厅',beats:[{id:'line',kind:'dialogue',speaker:'小美',text:'水还没开。'},{id:'unrelated',text:'其他场次'}]}],resources:[{id:'r',name:'小美',bible:{costume:'白色外套'}},{id:'other',name:'不出场的人'}]};
  const model = {label:'Seedance 2.5',modes:[{generationType:'REFERENCE',durations:[15],aspectRatios:['16:9'],qualityOptions:['480p'],referenceLimits:{image:3,audio:0,video:0,total:3}}]};
  const input = buildPromptOptimizationInput({project,shot,model,prompt:'小美放下钥匙',originalPrompt:'小美放下钥匙'});
  assert.equal(input.projectContext.scene.beats.length,1);assert.equal(input.projectContext.scene.beats[0].text,'水还没开。');
  assert.equal(input.projectContext.resources.length,1);assert.equal(input.projectContext.resources[0].bible.costume,'白色外套');
  assert.equal(input.projectContext.previousShot.endState,'走到桌前');assert.equal(input.projectContext.nextShot.startState,'钥匙在桌上');
  assert.equal(input.video.capabilities.referenceLimits.image,3);assert.equal(input.video.quality,'480p');
});

test('skill loading chooses model-specific references and reads every page without truncation', async () => {
  const calls = [];
  const skills = {read:async (name,resource,offset) => { calls.push([name,resource,offset]);return offset === 0 ? {text:'第一页',nextOffset:3} : {text:'最后一页',nextOffset:null}; }};
  const guidance = await loadPromptOptimizationGuidance({modelId:'seedance-2.0-fast',mode:'REFERENCE',skills});
  assert.ok(guidance.every(item => item.text === '第一页最后一页'));
  assert.ok(guidance.some(item => item.resource === 'references/seedance-20-writing.md'));
  assert.ok(!guidance.some(item => item.resource === 'references/seedance-25-writing.md'));
  assert.equal(calls.length,guidance.length*2);
  const minimax = await loadPromptOptimizationGuidance({modelId:'minimax-h3-15s',mode:'REFERENCE',dialogue:true,skills});
  assert.ok(minimax.some(item => item.resource === 'references/platform-and-sources.md'));
  assert.ok(minimax.some(item => item.resource === 'references/full-reference.md'));
  assert.ok(minimax.some(item => item.name === 'script-writing'));
  assert.ok(!minimax.some(item => item.name === 'seedance-creation-bible'));
});

test('the installed creative guidance resolves for each model family', async () => {
  for (const modelId of ['seedance-2.0','seedance-2.5','minimax-h3-15s','veo-31']) {
    const guidance = await loadPromptOptimizationGuidance({modelId,mode:'REFERENCE'});
    assert.ok(guidance.every(item => item.text.length > 100));
    assert.ok(guidance.some(item => item.resource === 'references/storyboard-handoff.md'));
    if (modelId === 'seedance-2.5') assert.ok(guidance.find(item => item.resource === 'references/seedance-25-writing.md').text.includes('整数秒'));
  }
});

test('optimized manual prompts retain model-specific length through project save and submission', () => {
  const service = createProjectService({videoAspectRatios:new Set(['16:9']),dramaVideoDurations:new Set([15]),dramaStepOrder:['script'],canonicalVideoModelId:value => value,publicLlmUsage:value => value});
  for (const modelId of ['minimax-h3-15s','seedance-2.5']) {
    const limit = videoPromptMaxLength(modelId);
    const prompt = '😀'.repeat(limit);
    const project = service.normalizeDramaProject({mode:'professional',settings:{},resources:[],shots:[{id:'s',script:prompt,promptOverride:prompt,duration:15,aspectRatio:'16:9',generation:{modelId,type:'TEXT'}}]});
    assert.equal(Array.from(project.shots[0].promptOverride).length,limit);
    assert.equal(buildShotVideoPrompt({project,shot:project.shots[0]}),prompt);
  }
});

test('API uses scoped reference metadata and rejects unavailable, changed or unsupported model settings', async () => {
  let calls = 0, status, input = {prompt:'@小美.png 进门',referenceFiles:[{id:'local',name:'本地场景',kind:'image',url:'secret'},{id:'foreign',name:'其他文件',kind:'image'}]};
  const shot = {id:'s',referenceAssetIds:['local','girl'],assetMentions:[{id:'girl',label:'小美.png',kind:'image'}],duration:15,aspectRatio:'16:9',generation:{modelId:'seedance-2.5',type:'REFERENCE',quality:'480p'}};
  let model = {id:'seedance-2.5',modes:[{generationType:'REFERENCE',aspectRatios:['16:9'],durationsByQuality:{'480p':{'16:9':[15]}},qualityOptions:['480p']}]};
  const scope = {deviceId:'d',workspaceId:'w'};
  const handler = createDramaRouteHandler({requireUser:() => ({id:'u'}),requireDesktopWorkspaceScope:() => scope,loadDramaProject:async () => ({id:'p',shots:[shot]}),bodyJson:async () => input,
    getVideoModels:() => [model],isLlmConfigured:() => true,charLength:value => Array.from(value).length,sendJson:(_res,code) => status=code,
    findAsset:(user,id,suppliedScope) => {assert.equal(user,'u');assert.equal(suppliedScope,scope);assert.ok(['local','girl'].includes(id));return id === 'girl' ? {id,name:'云端人物',kind:'image'} : null;},
    optimizeShotPrompt:async args => {calls++;assert.deepEqual(args.references.map(item => item.id),['local','girl']);assert.equal(args.references[0].label,'本地场景');assert.equal(args.references[1].label,'云端人物');assert.equal(JSON.stringify(args.references).includes('secret'),false);return {};}});
  const run = () => handler({method:'POST'},{},new URL('http://localhost/api/drama/projects/p/shots/s/optimize-prompt'));
  await run();assert.equal(status,200);assert.equal(calls,1);
  input.modelId='seedance-2.0';await run();assert.equal(status,409);delete input.modelId;
  model.enabled=false;await run();assert.equal(status,400);model.enabled=true;
  shot.duration=30;await run();assert.equal(status,400);assert.equal(calls,1);
});

test('manually added @ references are considered without persisting the draft and foreign IDs are rejected', async () => {
  const shot = {id:'s',assetMentions:[],referenceAssetIds:[],generation:{modelId:'seedance-2.5',type:'TEXT'},duration:15,aspectRatio:'16:9'};
  const project = {id:'p',projectAssetIds:['girl'],shots:[shot]};
  let input = {prompt:'@小美.png 进门',assetMentions:[{id:'girl',label:'小美.png',kind:'image'}]}, status, calls = 0;
  const handler = createDramaRouteHandler({requireUser:() => ({id:'u'}),requireDesktopWorkspaceScope:() => ({}),loadDramaProject:async () => project,
    getVideoModels:() => [{id:'seedance-2.5',modes:[{generationType:'TEXT'},{generationType:'REFERENCE'}]}],isLlmConfigured:() => true,charLength:value => Array.from(value).length,
    bodyJson:async () => input,sendJson:(_res,code) => status=code,
    optimizeShotPrompt:async args => {calls++;assert.equal(args.shot.generation.type,'REFERENCE');assert.equal(args.references[0].id,'girl');assert.equal(args.shot.assetMentions[0].label,'小美.png');return {};}});
  const run = () => handler({method:'POST'},{},new URL('http://localhost/api/drama/projects/p/shots/s/optimize-prompt'));
  await run();assert.equal(status,200);assert.equal(shot.generation.type,'TEXT');assert.deepEqual(shot.assetMentions,[]);
  input.assetMentions[0].id='foreign';await run();assert.equal(status,400);assert.equal(calls,1);
});

test('confirming a draft keeps existing chips and resolves newly typed names with the regular @ matcher', () => {
  const source = readFileSync(new URL('../public/drama-studio.js',import.meta.url),'utf8');
  const code = source.slice(source.indexOf('  function optimizedShotEditorMarkup('),source.indexOf('  function workbenchReferenceRow('));
  let replaced, originalCalled = 0;
  const protectedChip = {nodeType:1,classList:{contains:() => true},childNodes:[{nodeType:3,nodeValue:'@小美'}],id:'existing-asset'};
  const typedName = {nodeType:3,nodeValue:'在 @客厅 说话',replaceWith:fragment => replaced=fragment};
  const holder = {childNodes:[protectedChip,typedName],innerHTML:''};
  const context = {Node:{TEXT_NODE:3,ELEMENT_NODE:1},document:{createElement:() => holder},
    renderMentionEditorContent:item => {originalCalled++;assert.equal(item.assetMentions[0].id,'existing-asset');return 'markup';},
    autoMentionFragment:text => {assert.equal(text,'在 @客厅 说话');return {fragment:{id:'new-room'}};}};
  vm.createContext(context);vm.runInContext(code,context);
  context.optimizedShotEditorMarkup({assetMentions:[{id:'existing-asset'}]},'当前编辑');
  assert.equal(originalCalled,1);assert.equal(protectedChip.id,'existing-asset');assert.equal(replaced.id,'new-room');
});
