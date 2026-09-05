import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { mergeProjectThreeWay } from '../public/features/drama/merge.js';
import { mergeProjectResponseWithNewerKeys } from '../public/features/drama/pure.js';

const source = await readFile(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function conflictHarness({ choose = async () => ({ title:'local' }) } = {}) {
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
    mergeProjectThreeWay, mergeProjectResponseWithNewerKeys,
    chooseProjectConflict:choose,
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
  assert.equal(harness.labels.at(-1), '已合并保存');
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

test('conflict choice resolved after project invalidation cannot submit or alter new dirty state', async () => {
  let choose;
  const harness = conflictHarness({ choose:() => new Promise(resolve => { choose = resolve; }) });
  const { context } = harness;
  const saving = context.patch({ title:'本地标题' });
  await tick();
  context.projectEpoch += 1;
  context.project = { id:'project-b', revision:1, title:'新项目' };
  context.pendingKeys = new Set(['script']);
  choose({ title:'local' });
  await tick();
  assert.equal(harness.calls.length, 1);
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
  assert.equal(context.projectBaseSnapshot.revision, 1);
  assert.equal(context.pendingKeys.has('title'), true);
  assert.equal(harness.labels.at(-1), '保存失败');
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
    chooseProjectConflict:async() => null,
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

test('project save preserves a same-project draft when another editor wins the CAS race', async () => {
  const calls = [];
  const localProject = { id:'project-a', revision:1, title:'本地草稿' };
  const pendingKeys = new Set();
  const context = {
    project:localProject,
    projects:[localProject],
    projectEpoch:1,
    accountSnapshot:() => 'account-a',
    isAccountCurrent:() => true,
    markProjectKeys:() => {},
    pendingKeys,
    cloneProjectValue:value => JSON.parse(JSON.stringify(value)),
    projectKeyVersions:new Map(),
    projectBaseSnapshot:{ id:'project-a', revision:1, title:'原始内容' },
    mergeProjectThreeWay,
    chooseProjectConflict:async() => null,
    normalizeProjectData:value => value,
    restoreLocalProjectOutputs:value => value,
    mergeProjectResponseWithNewerKeys:(serverProject) => serverProject,
    mergeDramaProjectList:(items, item) => items.map(value => value.id === item.id ? item : value),
    state:{ dramaProject:localProject },
    saveLabel:() => {},
    toast:() => {},
    projectMutationChain:Promise.resolve(),
    api:(url, options) => {
      calls.push({ url, options });
      return Promise.reject({
        code:'PROJECT_VERSION_CONFLICT',
        project:{ id:'project-a', revision:2, title:'其他编辑内容' },
      });
    },
  };
  vm.createContext(context);
  const start = source.indexOf('  async function patch(');
  const end = source.indexOf('  async function navigateStep(', start);
  vm.runInContext(source.slice(start, end), context);

  await assert.rejects(context.patch({ title:'本地草稿' }), error => {
    assert.equal(error.code, 'PROJECT_VERSION_CONFLICT');
    assert.equal(error.serverProject.title, '其他编辑内容');
    assert.equal(error.localProject.title, '本地草稿');
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).revision, 1);
  assert.deepEqual(context.project, localProject);
  assert.equal(context.project.revision, 1);
  assert.equal(context.project.title, '本地草稿');
  assert.equal(pendingKeys.has('title'), true);
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
