import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createConfigSync } from '../public/state/config-sync.js';
import { createAccountScope } from '../public/state/account-scope.js';

test('an open page receives changed durations and unchanged checks do not repaint', async () => {
  let config = { durations:[15] };
  let remote = config;
  let paints = 0;
  const refresh = createConfigSync({ fetchConfig:async () => structuredClone(remote), getConfig:() => config, applyConfig:value => { config = value; paints++; }, accountScope:createAccountScope() });
  await refresh();
  assert.equal(paints, 0);
  remote = { durations:[5,10,15] };
  await refresh();
  assert.deepEqual(config.durations, [5,10,15]);
  assert.equal(paints, 1);
  await refresh();
  assert.equal(paints, 1);
  remote = { durations:[30] };
  await refresh();
  assert.deepEqual(config.durations, [30]);
});

test('overlapping refreshes share a request and failures retain the current configuration', async () => {
  let resolve;
  let reject;
  let calls = 0;
  let config = { durations:[15] };
  const refresh = createConfigSync({ fetchConfig:() => { calls++; return new Promise((yes,no) => { resolve=yes; reject=no; }); }, getConfig:() => config, applyConfig:value => { config=value; }, accountScope:createAccountScope() });
  const a=refresh(); const b=refresh();
  assert.equal(calls,1);
  resolve({ durations:[5,10,15] });
  await Promise.all([a,b]);
  const failure=refresh();
  reject(new Error('offline'));
  await assert.rejects(failure,/offline/);
  assert.deepEqual(config.durations,[5,10,15]);
  const retry=refresh();
  resolve({ durations:[30] });
  await retry;
  assert.deepEqual(config.durations,[30]);
});

test('a delayed response cannot overwrite configuration after an account switch', async () => {
  const scope=createAccountScope();
  const resolvers=[];
  let config={};
  const refresh=createConfigSync({ fetchConfig:() => new Promise(resolve => resolvers.push(resolve)), getConfig:() => config, applyConfig:value => { config=value; }, accountScope:scope });
  const old=refresh();
  scope.advance();
  const current=refresh();
  resolvers[1]({ durations:[5,10,15] });
  await current;
  resolvers[0]({ durations:[15] });
  assert.equal(await old,null);
  assert.deepEqual(config.durations,[5,10,15]);
});

test('live configuration and its app entry have matching cache versions', async () => {
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.ok(app.includes("'./state/config-sync.js?v=1'"));
  assert.ok(html.includes('/app.js?v=456'));
});
