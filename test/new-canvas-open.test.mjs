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
    mountWorkspace() { mounted.push(context.initialCanvasOpen); },
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
