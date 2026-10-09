import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { mergeProjectThreeWay, projectConflictChoiceMap } from '../public/features/drama/merge.js';
import { mergeProjectResponseWithNewerKeys } from '../public/features/drama/pure.js';

const source = await readFile(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('empty storyboard state binds its create-shot action', () => {
  const start = source.indexOf('  function bindStoryboardWorkbench(');
  const end = source.indexOf('\n  function applyProjectAssetToShot', start);
  const binding = source.slice(start, end);
  assert.match(binding, /querySelector\('\.wb-empty-shot-action'\)/);
  assert.match(binding, /bindWorkbenchEmptyAction\(/);
  assert.match(source.slice(source.indexOf('  function bindWorkbenchEmptyAction('),start), /void addProfessionalShot\(\)/);
});

function conflictHarness() {
  const calls = [];
  const labels = [];
  let finishSave;
  let failSave;
  const base = { id:'project-a', revision:1, title:'原始标题', script:'原始剧本' };
  const context = {
    project:{ ...base, title:'本地标题' }, projects:[], projectEpoch:1,
    projectBaseSnapshot:{ ...base }, state:{},
    accountSnapshot:() => 'account-a', isAccountCurrent:() => true,
    pendingKeys:new Set(['title']), projectKeyVersions:new Map([['title',1]]),
    markProjectKeys:keys => keys.forEach(key => context.projectKeyVersions.set(key, (context.projectKeyVersions.get(key) || 0) + 1)),
    cloneProjectValue:structuredClone,
    mergeProjectThreeWay, projectConflictChoiceMap, mergeProjectResponseWithNewerKeys,
    projectAcknowledgedVersions:new Map(), clearTimeout, saveTimer:0,
    cacheProject:() => {},
    normalizeProjectData:value => value, restoreLocalProjectOutputs:value => value,
    mergeDramaProjectList:(_items, item) => [item],
    saveLabel:value => labels.push(value), toast:() => {}, render:() => {},
    projectMutationChain:Promise.resolve(),
    api:(url, options) => {
      const payload = JSON.parse(options.body);
      calls.push({ url, payload });
      if (calls.length === 1) return Promise.reject({ code:'PROJECT_VERSION_CONFLICT', project:{ ...base, revision:2, title:'远端标题' } });
      return new Promise((resolve, reject) => {
        finishSave = () => resolve({ project:{ ...payload, revision:3 } });
        failSave = reject;
      });
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function patch('), source.indexOf('  async function navigateStep(')), context);
  return { context, calls, labels, finish:() => finishSave(), fail:error => failSave(error) };
}

test('merged save keeps newer input and dirty keys while advancing the server baseline', async () => {
  const harness = conflictHarness();
  const { context } = harness;
  const saving = context.patch({ title:'本地标题' });
  await tick();
  context.project.script = '等待合并响应时的新剧本';
  context.project.title = '等待合并响应时的新标题';
  context.markProjectKeys(['script','title']);
  context.pendingKeys.add('script');
  context.pendingKeys.add('title');
  harness.finish();
  await saving;
  assert.equal(context.project.script, '等待合并响应时的新剧本');
  assert.equal(context.project.title, '等待合并响应时的新标题');
  assert.equal(context.project.revision, 3);
  assert.equal(context.projectBaseSnapshot.title, '本地标题');
  assert.equal(context.projectBaseSnapshot.script, '原始剧本');
  assert.deepEqual([...context.pendingKeys].sort(), ['script','title']);
  assert.equal(context.projectKeyVersions.get('title'), 3);
  assert.match(harness.labels.at(-1), /未保存/);
});

test('merged save clears only acknowledged dirty fields and retains version counters', async () => {
  const harness = conflictHarness();
  const { context } = harness;
  context.project.script = '待保存剧本';
  context.markProjectKeys(['script']);
  context.pendingKeys.add('script');
  const saving = context.patch({ title:'本地标题' });
  await tick();
  harness.finish();
  await saving;
  assert.equal(context.project.script, '待保存剧本');
  assert.equal(context.pendingKeys.size, 0);
  assert.equal(context.projectKeyVersions.get('script'), 1);
  assert.equal(harness.labels.at(-1), '已保存');
});

test('conflict merge includes submitted fields that were not first assigned to the local project', async () => {
  const harness = conflictHarness();
  harness.context.project.title = '原始标题';
  const saving = harness.context.patch({ title:'输入框提交的新标题' });
  await tick();
  assert.equal(harness.calls[1].payload.title, '输入框提交的新标题');
  harness.finish();
  await saving;
  assert.equal(harness.context.project.title, '输入框提交的新标题');
});

test('automatic retry resolved after project invalidation cannot alter new dirty state', async () => {
  const harness = conflictHarness();
  const { context } = harness;
  const saving = context.patch({ title:'本地标题' });
  await tick();
  context.projectEpoch += 1;
  context.project = { id:'project-b', revision:1, title:'新项目' };
  context.pendingKeys = new Set(['script']);
  harness.finish();
  await tick();
  assert.equal(harness.calls.length, 2);
  assert.equal(await saving, null);
  assert.deepEqual([...context.pendingKeys], ['script']);
});

test('failed merged submission preserves draft and reports a retryable save failure', async () => {
  const harness = conflictHarness();
  const { context } = harness;
  const saving = context.patch({ title:'本地标题' });
  await tick();
  harness.fail(new Error('网络中断'));
  await assert.rejects(saving, /网络中断/);
  assert.equal(context.project.title, '本地标题');
  assert.equal(context.projectBaseSnapshot.revision, 2);
  assert.equal(context.pendingKeys.has('title'), true);
  assert.equal(harness.labels.at(-1), '保存失败');
});

function saveHarness() {
  const harness=conflictHarness();
  const {context}=harness;
  context.project={id:'project-a',revision:1,title:'项目',shots:[{id:'shot-a',script:'原分镜',assetMentions:[],referenceAssetIds:[],videoVersions:[]}]};
  context.projectBaseSnapshot=structuredClone(context.project);
  context.projectKeyVersions.clear();context.pendingKeys.clear();
  vm.runInContext(source.slice(source.indexOf('  async function flushSave('),source.indexOf('  function normalizeProjectData(')),context);
  return harness;
}

function editMention(context,label='小美.png') {
  const shot=context.project.shots[0];
  shot.script=`@${label} 走进房间`;
  shot.assetMentions=[{id:'asset-a',label,kind:'image'}];
  shot.referenceAssetIds=['asset-a'];
  context.markProjectKeys(['shots']);context.pendingKeys.add('shots');
}

test('saving another field cannot acknowledge or erase pending storyboard mentions',async()=>{
  const {context}=saveHarness();
  editMention(context);
  const remote=structuredClone(context.projectBaseSnapshot);
  context.api=async(_url,{body})=>({project:{...remote,...JSON.parse(body),revision:2}});
  await context.patch({title:'新项目名'});
  assert.equal(context.project.shots[0].assetMentions[0].label,'小美.png');
  assert.equal(context.pendingKeys.has('shots'),true);
  assert.equal(context.projectAcknowledgedVersions.has('shots'),false);
  assert.equal(context.projectBaseSnapshot.shots[0].assetMentions.length,0);
  await context.flushSave();
  assert.equal(context.projectBaseSnapshot.shots[0].assetMentions[0].label,'小美.png');
  assert.equal(context.pendingKeys.size,0);
});

test('flush waits for input added during the in-flight save to be saved as well',async()=>{
  const {context}=saveHarness();
  let finish;const calls=[];let remote=structuredClone(context.projectBaseSnapshot);
  context.api=(_url,{body})=>{
    const payload=JSON.parse(body);calls.push(payload);
    const response=()=>{remote={...remote,...payload,revision:remote.revision+1};return {project:structuredClone(remote)};};
    return calls.length===1?new Promise(resolve=>{finish=()=>resolve(response());}):Promise.resolve(response());
  };
  editMention(context);
  const saving=context.flushSave();
  await tick();
  editMention(context,'小明.png');
  finish();await saving;
  assert.equal(calls.length,2);
  assert.equal(remote.shots[0].assetMentions[0].label,'小明.png');
  assert.equal(context.pendingKeys.size,0);
});

test('repeated background updates save the newest text and mentions without asking for choices',async()=>{
  const {context}=saveHarness();
  const calls=[];const reject=[];
  const remote=structuredClone(context.projectBaseSnapshot);
  context.api=(_url,{body})=>{
    const payload=JSON.parse(body);calls.push(payload);
    if(calls.length<3)return new Promise((_resolve,fail)=>{reject.push(fail);});
    return Promise.resolve({project:{...remote,...payload,revision:4}});
  };
  editMention(context);
  const saving=context.flushSave();
  await tick();editMention(context,'小明.png');
  reject[0]({code:'PROJECT_VERSION_CONFLICT',project:{...remote,revision:2}});
  await tick();
  assert.equal(calls[1].shots[0].assetMentions[0].label,'小明.png');
  editMention(context,'小红.png');
  const newer=structuredClone(remote);newer.revision=3;newer.shots[0].script='之前保存的内容';newer.shots[0].videoVersions=['task-a'];
  reject[1]({code:'PROJECT_VERSION_CONFLICT',project:newer});
  await saving;
  assert.equal(calls.length,3);
  assert.equal(calls[2].shots[0].script,'@小红.png 走进房间');
  assert.equal(context.project.shots[0].assetMentions[0].label,'小红.png');
  assert.deepEqual([...context.project.shots[0].videoVersions],['task-a']);
  assert.equal(context.pendingKeys.size,0);
  assert.equal(context.project.revision,4);
});

test('a full merged save supersedes queued snapshots instead of sending them again',async()=>{
  const {context}=saveHarness();
  const remote={...structuredClone(context.projectBaseSnapshot),revision:2,title:'另一份名称'};
  const calls=[];
  context.api=async(_url,{body})=>{
    const payload=JSON.parse(body);calls.push(payload);
    if(calls.length===1)throw {code:'PROJECT_VERSION_CONFLICT',project:remote};
    return {project:{...remote,...payload,revision:3}};
  };
  context.project.title='我的名称';
  const first=context.patch({title:'我的名称'});
  editMention(context);
  const queued=context.patch({shots:context.project.shots});
  await Promise.all([first,queued]);
  assert.equal(calls.length,2);
  assert.equal(context.project.shots[0].assetMentions[0].label,'小美.png');
  assert.equal(context.project.revision,3);
});

test('automatic reconciliation includes a newer direct field submission still queued behind it',async()=>{
  const {context}=saveHarness();
  const remote={...structuredClone(context.projectBaseSnapshot),revision:2,title:'之前保存的名称'};
  const calls=[];
  context.api=async(_url,{body})=>{
    const payload=JSON.parse(body);calls.push(payload);
    if(calls.length===1)throw {code:'PROJECT_VERSION_CONFLICT',project:remote};
    return {project:{...remote,...payload,revision:3}};
  };
  const first=context.patch({title:'第一次输入的名称'});
  const next=context.patch({title:'最新输入的名称'});
  await Promise.all([first,next]);
  assert.equal(calls.length,2);
  assert.equal(calls[1].title,'最新输入的名称');
  assert.equal(context.project.title,'最新输入的名称');
  assert.equal(context.projectBaseSnapshot.title,'最新输入的名称');
});

test('own generation responses preserve current mentions and advance the merge baseline',async()=>{
  const {context}=saveHarness();
  const base=structuredClone(context.projectBaseSnapshot);
  const remote=structuredClone(base);remote.revision=2;remote.shots[0].videoVersions=['task-a'];
  editMention(context);
  context.acceptProjectResponse(remote,{base});
  assert.equal(context.project.shots[0].assetMentions[0].label,'小美.png');
  assert.deepEqual([...context.project.shots[0].videoVersions],['task-a']);
  assert.equal(context.projectBaseSnapshot.revision,2);
  assert.equal(context.projectBaseSnapshot.shots[0].assetMentions.length,0);
  let calls=0;
  const latest=structuredClone(remote);latest.revision=3;latest.shots[0].videoVersions.push('task-b');
  context.api=async(_url,{body})=>{
    calls++;
    if(calls===1)throw {code:'PROJECT_VERSION_CONFLICT',project:latest};
    return {project:{...latest,...JSON.parse(body),revision:4}};
  };
  await context.flushSave();
  assert.equal(context.project.shots[0].assetMentions[0].label,'小美.png');
  assert.deepEqual([...context.project.shots[0].videoVersions],['task-a','task-b']);
});

test('the generation action retains edits made while the generation API is pending',async()=>{
  const {context}=saveHarness();
  let finish;
  context.project.shots[0].generation={modelId:'seedance-2.0',type:'REFERENCE',quality:'720p',count:1};
  context.projectBaseSnapshot=structuredClone(context.project);
  const remote=structuredClone(context.project);remote.revision=2;remote.shots[0].videoVersions=['task-a'];
  Object.assign(context,{
    currentProfessionalShot:()=>context.project.shots[0],professionalGenerationPending:new Set(),professionalPreviewTaskIds:new Map(),
    refreshProfessionalPrices:async()=>{},projectRequest:()=>({}),ensureProfessionalVideoSettings(){},professionalProductionWarning:()=>'',
    shotGenerationReady:()=>true,isProjectRequestCurrent:()=>true,shotGenerationAssetIds:()=>[],videoRequestShot:shot=>shot,shotVideoPrompt:shot=>shot.script,
    promptPrecheck:{check:async({prompts})=>({action:'submit',prompts,fields:{}})},ensureCloudReferenceIds:async()=>[],
    api:()=>new Promise(resolve=>{finish=()=>resolve({project:remote,tasks:[{id:'task-a'}]});}),
    setCreditBalance(){},scheduleTaskPoll(){},loadCredits:async()=>{},
  });
  context.state.tasks=[];
  vm.runInContext(source.slice(source.indexOf('  async function generateProfessionalVideo(){'),source.indexOf('  async function selectProfessionalVideo(')),context);
  const generating=context.generateProfessionalVideo();
  await tick();editMention(context);finish();await generating;
  assert.equal(context.project.shots[0].assetMentions[0].label,'小美.png');
  assert.equal(context.project.shots[0].script,'@小美.png 走进房间');
  assert.deepEqual([...context.project.shots[0].videoVersions],['task-a']);
  assert.equal(context.projectBaseSnapshot.revision,2);
});

test('project reads retain current edits even when an older saved field also changed',()=>{
  const {context}=saveHarness();
  editMention(context);
  const remote=structuredClone(context.projectBaseSnapshot);remote.revision=2;remote.title='改过的名称';
  context.acceptProjectResponse(remote);
  assert.equal(context.project.title,'改过的名称');
  assert.equal(context.project.shots[0].assetMentions[0].label,'小美.png');
  context.acceptProjectResponse({...remote,revision:1,title:'旧名称'});
  assert.equal(context.project.revision,2);
  const conflicting=structuredClone(remote);conflicting.revision=3;conflicting.shots[0].script='别处修改的分镜';
  context.acceptProjectResponse(conflicting);
  assert.equal(context.project.shots[0].script,'@小美.png 走进房间');
  assert.equal(context.projectBaseSnapshot.revision,3);
});

test('automatic reconciliation keeps both new video versions and respects explicit removals',()=>{
  const {context}=saveHarness();
  const base=structuredClone(context.projectBaseSnapshot);base.shots[0].videoVersions=['old'];
  const local=structuredClone(base);local.shots[0].videoVersions.push('local-task');
  const remote=structuredClone(base);remote.shots[0].videoVersions.push('remote-task');
  const merged=context.mergeProjectDraft(base,local,remote);
  assert.deepEqual([...merged.shots[0].videoVersions],['old','remote-task','local-task']);
  local.shots[0].videoVersions=[];
  assert.deepEqual([...context.mergeProjectDraft(base,local,remote).shots[0].videoVersions],[]);
});

test('editing text retains unchanged mentions when an older background save omits them',()=>{
  const {context}=saveHarness();
  editMention(context);
  const base=structuredClone(context.project);
  base.shots[0].generation={type:'REFERENCE',referenceAssetIds:['asset-a']};
  const local=structuredClone(base);local.shots[0].script+='，镜头跟随';local.shots[0].promptOverride=local.shots[0].script;
  const remote=structuredClone(base);remote.revision=2;
  remote.shots[0].assetMentions=[];remote.shots[0].referenceAssetIds=[];remote.shots[0].generation.referenceAssetIds=[];
  const merged=context.mergeProjectDraft(base,local,remote);
  assert.equal(merged.shots[0].script,local.shots[0].script);
  assert.equal(merged.shots[0].promptOverride,local.shots[0].promptOverride);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.shots[0].assetMentions)),local.shots[0].assetMentions);
  assert.deepEqual([...merged.shots[0].referenceAssetIds],['asset-a']);
  assert.deepEqual([...merged.shots[0].generation.referenceAssetIds],['asset-a']);
});

test('unloaded material previews keep mention identities through rendering and the next input',()=>{
  const context={asset:()=>undefined,esc:String};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function mentionKindLabel('),source.indexOf('  function serializeRichEditor(')),context);
  vm.runInContext(source.slice(source.indexOf('  function mentionsFromEditor('),source.indexOf('  function previousTextPosition(')),context);
  const mention={id:'asset-a',label:'小美.png',kind:'image'};
  const html=context.renderMentionEditorContent({script:'@小美.png 走进房间',assetMentions:[mention]});
  const dataset={};
  for(const [,key,value] of html.matchAll(/data-mention-(id|label|kind)="([^"]*)"/g))dataset[`mention${key[0].toUpperCase()}${key.slice(1)}`]=value;
  assert.deepEqual(dataset,{mentionId:'asset-a',mentionLabel:'小美.png',mentionKind:'image'});
  const mentions=context.mentionsFromEditor({querySelectorAll:()=>[{dataset}]});
  assert.deepEqual(JSON.parse(JSON.stringify(mentions)),[mention]);
  assert.match(html,/走进房间$/);
});

test('storyboard save changes refresh the complete frontend cache chain',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.ok(html.includes('/app.js?v=504'));
  assert.ok(app.includes('./drama-studio.js?v=239'));
  assert.ok(source.includes('./features/drama/pure.js?v=4'));
  assert.doesNotMatch(html,/projectConflictDialog|applyProjectConflict|cancelProjectConflict/);
  assert.doesNotMatch(source,/chooseProjectConflict|settleProjectConflict|存在冲突|已合并保存/);
});

test('project save does not retry a conflict after the project becomes stale', async () => {
  const calls = [];
  let rejectRequest;
  let currentEpoch = 1;
  const context = {
    project:{ id:'project-a', revision:1 },
    projectEpoch:1,
    accountSnapshot:() => 'account-a',
    isAccountCurrent:() => currentEpoch === 1,
    markProjectKeys:() => {},
    pendingKeys:new Set(),
    cloneProjectValue:value => JSON.parse(JSON.stringify(value)),
    projectKeyVersions:new Map(),
    projectBaseSnapshot:null,
    mergeProjectThreeWay,
    projectAcknowledgedVersions:new Map(), clearTimeout, saveTimer:0,
    normalizeProjectData:value => value,
    restoreLocalProjectOutputs:value => value,
    mergeProjectResponseWithNewerKeys:(serverProject) => serverProject,
    mergeDramaProjectList:(items, item) => items.map(value => value.id === item.id ? item : value),
    state:{},
    saveLabel:() => {},
    toast:() => {},
    projectMutationChain:Promise.resolve(),
    api:url => {
      calls.push(url);
      return new Promise((resolve, reject) => { rejectRequest = reject; });
    },
  };
  vm.createContext(context);
  const start = source.indexOf('  async function patch(');
  const end = source.indexOf('  async function navigateStep(', start);
  vm.runInContext(source.slice(start, end), context);

  const request = context.patch({ title:'旧账号草稿' });
  await tick();
  currentEpoch = 2;
  context.project = { id:'project-b', revision:1 };
  rejectRequest({ code:'PROJECT_VERSION_CONFLICT', project:{ revision:2 } });

  assert.equal(await request, null);
  assert.deepEqual(calls, ['/api/drama/projects/project-a']);
});

test('persistent background changes bound retries and keep the draft for the next save',async()=>{
  const {context,labels}=saveHarness();
  const calls=[];
  editMention(context);
  const remote=structuredClone(context.projectBaseSnapshot);
  context.api=async(_url,{body})=>{
    calls.push(JSON.parse(body));
    throw {code:'PROJECT_VERSION_CONFLICT',project:{...remote,revision:calls.length+1}};
  };
  await assert.rejects(context.flushSave(),/暂时未能保存，当前修改已保留/);
  assert.equal(calls.length,4);
  assert.equal(context.project.shots[0].script,'@小美.png 走进房间');
  assert.equal(context.project.shots[0].assetMentions[0].label,'小美.png');
  assert.equal(context.pendingKeys.has('shots'),true);
  assert.equal(labels.at(-1),'保存失败');
  context.api=async(_url,{body})=>({project:{...remote,...JSON.parse(body),revision:6}});
  await context.flushSave();
  assert.equal(context.projectBaseSnapshot.shots[0].assetMentions[0].label,'小美.png');
  assert.equal(context.pendingKeys.size,0);
});

test('stale step advancement does not clear the replacement project', async () => {
  let finishPatch;
  const context = {
    project:{ id:'project-a', maxStep:'script' },
    projectEpoch:1,
    accountSnapshot:() => 'account-a',
    isAccountCurrent:() => context.project?.id === 'project-a',
    projectRequest:() => ({ account:'account-a', epoch:1, projectId:'project-a' }),
    assertProjectRequest:request => {
      if (!context.isAccountCurrent(request)) throw Object.assign(new Error('stale'), { stale:true });
    },
    flushSave:async() => {},
    patch:() => new Promise(resolve => { finishPatch = resolve; }),
    professional:() => false,
    stepOrder:['script','resources','storyboard','video'],
    viewStep:null,
    assetPickerShotId:'',
    dropFocus:() => {},
    render:() => {},
    scroller:() => null,
  };
  vm.createContext(context);
  const start = source.indexOf('  async function advanceStep(');
  const end = source.indexOf('\n\n  function stepNav', start);
  vm.runInContext(source.slice(start, end), context);

  const request = context.advanceStep('resources');
  await tick();
  context.project = { id:'project-b', maxStep:'script' };
  finishPatch(null);

  assert.equal(await request, false);
  assert.deepEqual(context.project, { id:'project-b', maxStep:'script' });
  assert.equal(context.viewStep, null);
});

test('stale bulk storyboard save does not render or report success', async () => {
  let finishPatch;
  let renders = 0;
  const context = {
    project:{ id:'project-a', shots:[{ id:'shot-a' }] },
    projectEpoch:1,
    accountSnapshot:() => 'account-a',
    projectRequest:() => ({ account:'account-a', epoch:1, projectId:context.project?.id || '' }),
    isProjectRequestCurrent:request => request?.epoch === context.projectEpoch && request?.projectId === context.project?.id,
    assertProjectRequest:request => {
      if (!context.isProjectRequestCurrent(request)) throw Object.assign(new Error('stale'), { stale:true });
    },
    collectShot:() => {},
    patch:() => new Promise(resolve => { finishPatch = resolve; }),
    render:() => { renders += 1; },
    toast:() => {},
  };
  vm.createContext(context);
  const start = source.indexOf('  async function saveAllShots(');
  const end = source.indexOf('\n  async function addShot', start);
  vm.runInContext(source.slice(start, end), context);

  const request = context.saveAllShots(true);
  await tick();
  context.project = { id:'project-b', shots:[{ id:'shot-b' }] };
  finishPatch({ id:'project-a', shots:[] });

  assert.equal(await request, false);
  assert.equal(renders, 0);
  assert.deepEqual(context.project, { id:'project-b', shots:[{ id:'shot-b' }] });
});
