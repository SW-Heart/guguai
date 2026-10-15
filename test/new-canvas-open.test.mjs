import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/features/agent/workspace.js', import.meta.url), 'utf8');
function setup() {
  const mounted = [], errors = [];
  const context = vm.createContext({
    creating: false, navigationEpoch: 0, screen: 'home', view: null,
    project: {}, initialCanvasOpen: false, initialMessage: '', initialAttachments: [], initialDocuments: [], initialSkill: '', initialModelPreferences: undefined,
    api: async () => ({ project: { id: 'new-canvas', title: '新项目' } }),
    defaultTitleFromMessage: () => '', changeLocation() {}, dispatchRoute() {},
    resetView() { context.navigationEpoch++; context.initialCanvasOpen = false; },
    host: { innerHTML: '' }, projectLoadingMarkup: '', toast: message => errors.push(message),
    mountWorkspace(create) { assert.equal(typeof create, 'function'); mounted.push(context.initialCanvasOpen); },
    loadCanvas: async () => ({ createDirectorWorkspace() {} }), warmCanvas() {},
  });
  vm.runInContext(source.slice(source.indexOf('  async function createProject('), source.indexOf('  const asset=id=>')), context);
  return { context, mounted, errors };
}

test('new canvas projects show the canvas immediately, including starts with a message', async () => {
  for (const message of ['', '画一只猫']) {
    const { context, mounted, errors } = setup();
    await context.createProject(message);
    assert.deepEqual(mounted, [true]);
    assert.equal(context.initialMessage, message);
    assert.deepEqual(errors, []);
  }
});

test('opening an existing project also shows the canvas', async () => {
  const { context, mounted } = setup();
  await context.createProject();
  await context.openProject('existing-canvas');
  assert.deepEqual(mounted, [true, true]);
});

test('opening an existing project directly starts with its canvas visible', async () => {
  const { context, mounted, errors } = setup();
  await context.openProject('existing-canvas');
  assert.deepEqual(mounted, [true]);
  assert.deepEqual(errors, []);
});

test('a project waits for its canvas code alongside its data, and a failed download returns home with a plain message', async () => {
  const { context, mounted, errors } = setup();
  let finishCanvas, finishProject;
  context.loadCanvas = () => new Promise(resolve => { finishCanvas = resolve; });
  context.api = () => new Promise(resolve => { finishProject = resolve; });
  const opening = context.openProject('existing-canvas');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishCanvas, 'function', 'canvas code starts downloading with the project request');
  finishProject({ project: { id: 'existing-canvas', title: '项目' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(mounted, [], 'the canvas mounts only when its code is ready');
  finishCanvas({ createDirectorWorkspace() {} });
  await opening;
  assert.deepEqual(mounted, [true]);

  const failed = setup();
  const locations = [];
  failed.context.changeLocation = view => locations.push(view);
  failed.context.loadCanvas = async () => { throw new Error('画布加载失败，请检查网络后重试'); };
  await failed.context.openProject('existing-canvas');
  assert.deepEqual(failed.mounted, []);
  assert.deepEqual(failed.errors, ['画布加载失败，请检查网络后重试']);
  assert.deepEqual(locations, ['home']);
});

test('the creation home does not import the canvas engine up front', () => {
  assert.doesNotMatch(source, /^import[^;]*director-workspace\.js/m);
  assert.match(source, /import\('\.\.\/drama\/director-workspace\.js\?v=\d+'\)/);
});
