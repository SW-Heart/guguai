import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConversationRail } from '../public/features/agent/conversation-rail.js';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

function fakeRail() {
  const list = { innerHTML:'', attributes:{}, setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll:() => [] };
  const root = { querySelector:() => list, addEventListener() {} };
  return { root, list };
}

test('sidebar conversation list renders escaped titles and marks the open conversation', async () => {
  const { root, list } = fakeRail();
  const account = { epoch:1, userId:'u1' };
  const rail = createConversationRail({
    root,
    api:async () => ({ projects:[{ id:'p1', title:'<b>短片</b>', updatedAt:'2026-09-28T00:00:00Z' }, { id:'p2', title:'第二个', updatedAt:'2026-09-27T00:00:00Z' }] }),
    accountSnapshot:() => account,
    isAccountCurrent:value => value === account,
  });
  rail.setActive('p2');
  await rail.refresh();
  assert.match(list.innerHTML, /&lt;b&gt;短片&lt;\/b&gt;/);
  assert.doesNotMatch(list.innerHTML, /<b>短片/);
  assert.match(list.innerHTML, /data-rail-project="p2"[^>]*aria-current="page"/);
  assert.doesNotMatch(list.innerHTML, /data-rail-project="p1"[^>]*aria-current/);
});

test('sidebar conversation list ignores results that arrive after an account switch', async () => {
  const { root, list } = fakeRail();
  let current = { epoch:1, userId:'u1' };
  let resolve;
  const rail = createConversationRail({
    root,
    api:() => new Promise(done => { resolve = done; }),
    accountSnapshot:() => current,
    isAccountCurrent:value => value === current,
  });
  const pending = rail.refresh();
  current = { epoch:2, userId:'u2' };
  rail.reset();
  resolve({ projects:[{ id:'old', title:'上一个账号的对话' }] });
  await pending;
  assert.equal(list.innerHTML, '');
});

test('sidebar hides empty history and keeps a retry visible on failure', async () => {
  const account = { epoch:1, userId:'u1' };
  const empty = fakeRail();
  const emptyVisibility = [];
  const emptyRail = createConversationRail({ root:empty.root, api:async () => ({ projects:[] }), accountSnapshot:() => account, isAccountCurrent:() => true, onVisibilityChange:visible => emptyVisibility.push(visible) });
  await emptyRail.refresh();
  assert.equal(empty.list.innerHTML, '');
  assert.equal(emptyRail.isVisible(), false);
  assert.ok(emptyVisibility.every(visible => visible === false));
  const failed = fakeRail();
  const failedRail = createConversationRail({ root:failed.root, api:async () => { throw new Error('network'); }, accountSnapshot:() => account, isAccountCurrent:() => true });
  await failedRail.refresh();
  assert.match(failed.list.innerHTML, /data-rail-retry/);
  assert.doesNotMatch(failed.list.innerHTML, /network/);
  assert.equal(failedRail.isVisible(), true);
});

test('sidebar visibility follows the first conversation, last deletion and account reset', async () => {
  const { root } = fakeRail();
  const visibility = [];
  let projects = [];
  const rail = createConversationRail({ root, api:async () => ({ projects }), accountSnapshot:() => ({ epoch:1, userId:'u1' }), isAccountCurrent:() => true, onVisibilityChange:visible => visibility.push(visible) });
  await rail.refresh();
  assert.equal(visibility.at(-1), false);
  projects = [{ id:'p1', title:'短片' }];
  await rail.refresh();
  assert.equal(visibility.at(-1), true);
  rail.remove('p1');
  assert.equal(visibility.at(-1), false);
  await rail.refresh();
  assert.equal(visibility.at(-1), true);
  rail.reset();
  assert.equal(visibility.at(-1), false);
});

test('sidebar replaces the project page and the agent is the default route', () => {
  const html = read('index.html');
  const app = read('app.js');
  const workspace = read('features/agent/workspace.js');
  assert.match(html, /id="appView" class="app-shell hidden"/);
  assert.match(html, /id="appRail" class="rail is-collapsed"/);
  assert.doesNotMatch(html, /railToggle|rail-expanded|railConversations/);
  const rail = html.slice(html.indexOf('<nav id="appRail"'), html.indexOf('</nav>', html.indexOf('<nav id="appRail"')));
  assert.doesNotMatch(rail, /data-rail-projects|对话与项目/);
  assert.match(html, /<aside id="agentHistory" class="agent-history hidden"[\s\S]*?<h3 id="agentHistoryListTitle" class="agent-history-label">对话与项目<\/h3>[\s\S]*?data-rail-projects/);
  assert.match(app, /root: document\.querySelector\('#agentHistory'\)/);
  assert.match(app, /toggleClass\(\$\('#agentHistory'\), 'hidden', !visible\)/);
  assert.match(app, /\['agent', 'project'\]\.includes\(route\) && conversationRail\.isVisible\(\)/);
  assert.match(app, /toggleClass\(\$\('#appView'\), 'agent-history-visible', visible\)/);
  assert.doesNotMatch(html, /GuGu Agent|data-rail-new|agent-history-new/);
  assert.match(html, /data-route="agent" data-rail-tip="Agent"/);
  assert.match(app, /agent:'Agent', project:'Agent'/);
  const css = read('styles.css');
  assert.match(css, /#appView\.agent-route:not\(\.agent-history-visible\):not\(\.agent-project-open\):not\(\.drama-director-open\) \{ grid-template-columns: var\(--rail-width\) minmax\(0, 1fr\);/);
  assert.doesNotMatch(app, /setRailExpanded|railToggle/);
  assert.doesNotMatch(html, /data-route="projects"/);
  assert.match(app, /routePaths\[route\]\|\|validProjectPath\)\?route:'agent'/);
  assert.match(app, /\?\.\[0\] \|\| 'agent';/);
  assert.doesNotMatch(workspace, /showProjects|我的项目/);
});

test('sidebar cache chain is connected through the HTML entry', () => {
  for (const [path, urls] of [
    ['index.html', ['/app.js?v=484', '/styles.css?v=361']],
    ['app.js', ['./features/agent/conversation-rail.js?v=5', './features/agent/workspace.js?v=89']],
    ['features/agent/workspace.js', ['./default-title.js?v=1']],
  ]) for (const url of urls) assert.ok(read(path).includes(url), `${path}: ${url}`);
});
