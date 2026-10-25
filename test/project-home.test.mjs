import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createProjectListRouteHandler, projectSummaries } from '../server/routes/projects.mjs';
import { createProjectLibrary, filterProjects, projectCardMarkup, projectTypeLabels } from '../public/features/projects/library.js';
import { staticEntryFile } from '../server/static.mjs';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

test('both kinds of projects merge into one recent-first list', () => {
  const list = projectSummaries({
    canvasProjects:[{ id:'c1', title:'画布', updatedAt:3000 }, { id:'c2', title:'', updatedAt:1000 }],
    dramaProjects:[
      { id:'d1', mode:'professional', title:'校园', updatedAt:new Date(4000).toISOString() },
      { id:'d2', mode:'smart', title:'旧画布短剧', updatedAt:new Date(2000).toISOString() },
    ],
  });
  assert.deepEqual(list.map(item => [item.id, item.type, item.source]), [['d1', 'drama', 'drama'], ['c1', 'canvas', 'canvas'], ['d2', 'canvas', 'drama'], ['c2', 'canvas', 'canvas']]);
  assert.equal(list[3].title, '新项目');
  assert.deepEqual(projectSummaries({ canvasProjects:[{ id:'a', updatedAt:1 }, { id:'b', updatedAt:2 }], limit:1 }).map(item => item.id), ['b']);
});

test('the project list route is scoped to the workspace and validates its limit', async () => {
  const calls = [];
  const handler = createProjectListRouteHandler({
    sendJson:(res, status, body) => Object.assign(res, { status, body }),
    requireUser:() => ({ id:'u1' }),
    requireDesktopWorkspaceScope:() => ({ deviceId:'dev', workspaceId:'ws' }),
    listCanvasProjects:(userId, scope) => { calls.push(['canvas', userId, scope.workspaceId]); return [{ id:'c', updatedAt:2 }]; },
    listDramaProjects:(userId, options) => { calls.push(['drama', userId, options.workspaceId]); return { items:[{ id:'d', mode:'professional', updatedAt:new Date(1).toISOString() }] }; },
  });
  const res = {};
  assert.equal(await handler({ method:'GET' }, res, new URL('http://x/api/projects?limit=1')), true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.projects.map(item => item.id), ['c']);
  assert.deepEqual(calls, [['drama', 'u1', 'ws'], ['canvas', 'u1', 'ws']]);
  const bad = {};
  await handler({ method:'GET' }, bad, new URL('http://x/api/projects?limit=0'));
  assert.equal(bad.status, 400);
  assert.equal(await handler({ method:'GET' }, {}, new URL('http://x/api/agent/projects')), false);
});

test('project cards name their type in user language and filter by type and title', () => {
  const items = [
    { id:'c', source:'canvas', type:'canvas', title:'雨夜<海报>', updatedAt:Date.UTC(2026, 9, 1) },
    { id:'d', source:'drama', type:'drama', title:'校园告白', updatedAt:Date.UTC(2026, 9, 2) },
  ];
  assert.deepEqual(filterProjects(items, { type:'drama' }).map(item => item.id), ['d']);
  assert.deepEqual(filterProjects(items, { query:'雨夜' }).map(item => item.id), ['c']);
  assert.deepEqual(filterProjects(items, { query:'短剧工作台' }).map(item => item.id), ['d']);
  const card = projectCardMarkup(items[0]);
  assert.match(card, new RegExp(`<span>${projectTypeLabels.canvas}</span>`));
  assert.match(card, /雨夜&lt;海报&gt;/);
  assert.match(card, /data-project-open="canvas:c"/);
  assert.match(card, /data-project-rename="canvas:c"/);
  const recent = projectCardMarkup(items[1], { menu:false });
  assert.match(recent, /data-project-mode="professional"/);
  assert.doesNotMatch(recent, /project-card-menu/);
});

test('new and older addresses resolve to the 创作 home and the 项目 page', () => {
  const app = read('app.js');
  const start = app.indexOf('const routePaths = Object.freeze(');
  const context = vm.createContext({ window:{ location:{ pathname:'/' } } });
  vm.runInContext(`${app.slice(start, app.indexOf('const taskSignatureFields', start))}\nglobalThis.routeFromPath = routeFromPath; globalThis.dramaProjectIdFromPath = dramaProjectIdFromPath;`, context);
  for (const [path, route] of [['/create', 'agent'], ['/agent', 'agent'], ['/lab', 'agent'], ['/', 'agent'], ['/projects', 'drama'], ['/drama', 'drama'],
    ['/projects/drama/d-1', 'drama'], ['/projects/drama', 'drama'], ['/projects/abc-1', 'project'], ['/image', 'image'], ['/files', 'files']]) {
    assert.equal(context.routeFromPath(path), route, path);
  }
  assert.equal(context.dramaProjectIdFromPath('/projects/drama/d-1'), 'd-1');
  assert.equal(context.dramaProjectIdFromPath('/projects/abc-1'), '');
  for (const path of ['/create', '/projects', '/projects/drama/d-1', '/projects/abc-1']) assert.equal(staticEntryFile(path, { desktop:true }), 'index.html', path);
});

test('the sidebar lists 创作, 项目 and 文件库, with 图像 and 视频 under 快速创作', () => {
  const html = read('index.html');
  const rail = html.slice(html.indexOf('<div class="rail-nav">'), html.indexOf('<div class="rail-footer">'));
  const routes = [...rail.matchAll(/data-route="(\w+)" data-rail-tip="([^"]+)"/g)].map(match => `${match[1]}:${match[2]}`);
  assert.deepEqual(routes, ['agent:创作', 'drama:项目', 'files:文件库', 'image:图像', 'video:视频']);
  const group = rail.slice(rail.indexOf('class="rail-group"'));
  assert.match(group, /<span id="railQuickTitle" class="rail-group-title">快速创作<\/span>/);
  assert.ok(group.includes('data-route="image"') && group.includes('data-route="video"'));
  assert.doesNotMatch(html, /agentHistory|对话与项目|>Agent</);
});

test('the 创作 home offers project creation, a quiet one-line start and a sideways skill row', () => {
  const agent = read('features/agent/workspace.js');
  const home = agent.slice(agent.indexOf('  function renderHome('), agent.indexOf('  async function createProject('));
  assert.match(home, /data-home-create/);
  assert.match(home, /data-home-idea/);
  assert.match(home, /createProject\(text\)/);
  assert.match(home, /layout:'row'/);
  assert.match(home, /onChoose:name=>void createProject\('',\[\],\[\],name\)/);
  assert.doesNotMatch(home, /textarea|mountModelPreferencePicker/);
  const gallery = read('features/agent/skill-gallery.js');
  assert.match(gallery, /data-skill-scroll="-1"/);
  assert.match(gallery, /gugu-lucide-chevron-right/);
});

test('changed frontend modules are reachable through current cache keys', () => {
  for (const [file, urls] of [
    ['index.html', ['/app.js?v=605', '/styles.css?v=432']],
    ['app.js', ['./features/projects/library.js?v=5', './features/agent/workspace.js?v=179', './drama-studio.js?v=313']],
    ['features/agent/workspace.js', ['./skill-gallery.js?v=8', '../../vendor/ui/create-project.js?v=5']],
    ['features/projects/library.js', ['../../vendor/ui/create-project.js?v=5']],
  ]) {
    const source = read(file);
    for (const url of urls) assert.ok(source.includes(url), `${file} → ${url}`);
  }
  assert.doesNotMatch(read('app.js'), /conversation-rail\.js/);
});

test('the website leads with 智能画布 and 短剧工作台 and shows the real skills', () => {
  const home = read('home.html');
  const tabs = [...home.matchAll(/data-preview-tab="(\w+)">([^<]+)</g)].map(match => `${match[1]}:${match[2]}`);
  assert.deepEqual(tabs, ['canvas:智能画布', 'drama:短剧工作台', 'image:图像生成', 'video:视频生成']);
  assert.match(home, /id="preview-canvas" role="tabpanel"[^>]*><div class="preview-caption">[\s\S]*?class="canvas-mock" role="img"/);
  assert.match(home, /module-canvas is-primary[\s\S]*module-drama is-primary/);
  const skills = [...home.matchAll(/<li class="skill-card"><img src="(\/images\/skills\/[\w-]+-thumb-v1\.webp)"/g)];
  assert.equal(skills.length, 10);
  for (const [, src] of skills) assert.ok(readFileSync(new URL(`../public${src}`, import.meta.url)).length > 0, src);
  const features = read('features.html');
  assert.deepEqual([...features.matchAll(/<section class="feature-story[^"]*" id="(\w+)"/g)].map(match => match[1]), ['canvas', 'skills', 'drama', 'image', 'video', 'files']);
  for (const page of [home, features]) {
    assert.doesNotMatch(page, /创作助手|<h2>短剧创作<\/h2>|<\/span><h3>短剧创作</);
    assert.match(page, /\/marketing\.css\?v=16/);
  }
});

test('showing the project list again refreshes its cards without clearing the search box', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const node = () => ({ attributes:{}, innerHTML:'', textContent:'', classList:{ add() {}, remove() {} }, setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll:() => [] });
    const parts = {};
    let rebuilds = 0, html = '';
    const root = {
      isConnected:true,
      get innerHTML() { return html; },
      set innerHTML(value) { html = value; rebuilds++; for (const key of Object.keys(parts)) delete parts[key]; },
      querySelector(selector) { if (!html) return null; return parts[selector] ||= node(); },
      querySelectorAll:() => [],
    };
    let requests = 0;
    const library = createProjectLibrary({ api:async () => { requests++; return { projects:[{ source:'canvas', id:'a', type:'canvas', title:'海报', updatedAt:1 }] }; }, accountSnapshot:() => ({ epoch:1, userId:'u' }), isAccountCurrent:() => true });
    library.renderPage(root);
    await new Promise(resolve => setImmediate(resolve));
    const search = root.querySelector('[data-project-search]');
    search.value = '海';
    library.renderPage(root);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rebuilds, 1, 'the toolbar is built once');
    assert.equal(root.querySelector('[data-project-search]'), search);
    assert.equal(search.value, '海');
    assert.equal(requests, 2, 'the cards still refresh from the server');
    assert.match(root.querySelector('.project-library-grid').innerHTML, /海报/);
  } finally { globalThis.document = previousDocument; }
});

test('the project page draws its list before the module for opened projects loads', () => {
  const app = read('app.js'), drama = read('drama-studio.js');
  assert.match(app, /if \(!dramaController && !dramaProjectIdFromPath\(\) && projectsRoot\) projectLibrary\.renderPage\(projectsRoot\);\n        void ensureDramaController\(\)/);
  assert.match(app, /dramaControllerPromise = importDramaStudio\(\)\.then/, 'the project page does not wait for canvas styles');
  assert.doesNotMatch(drama, /^import[^;]*director-workspace\.js/m, 'only smart projects load the canvas engine');
  assert.match(drama, /import\('\.\/features\/drama\/director-workspace\.js\?v=\d+'\)/);
  assert.match(drama, /function renderDirectorWorkspace\(\)\{\n    if\(!createDirectorWorkspace\)\{/);
});
