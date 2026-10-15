import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

function fixture(save = async name => name) {
  const input = { value:'', focus(){}, select(){} };
  const buttons = [{}, {}];
  const form = { isConnected:true, querySelector:key=>key==='input'?input:buttons[1], querySelectorAll:()=>buttons };
  const heading = { textContent:'原名称', after(){}, setAttribute(){}, focus(){} };
  const calls = [], errors = [];
  const context = vm.createContext({ document:{createElement:()=>form} });
  vm.runInContext(read('features/agent/project-title-editor.js').replace('export function', 'function'), context);
  context.bindProjectTitleEditor(heading, {
    title:()=>heading.textContent,
    save:async name=>{calls.push(name); return save(name);},
    toast:message=>errors.push(message),
  });
  const event = key => ({key, preventDefault(){}, stopPropagation(){}});
  return {heading,form,input,buttons,calls,errors,event};
}

test('click and keyboard edit the title; Enter saves a trimmed name', async () => {
  const f=fixture();
  f.heading.onclick();
  assert.equal(f.input.value,'原名称');
  assert.equal(f.heading.hidden,true);
  f.input.value='  新名称  ';
  await f.form.onsubmit(f.event('Enter'));
  assert.deepEqual(f.calls,['新名称']);
  assert.equal(f.heading.textContent,'新名称');
  assert.equal(f.form.hidden,true);
  f.heading.onkeydown(f.event(' '));
  assert.equal(f.form.hidden,false);
});

test('cancel, Escape, unchanged names and empty names never send a rename', async () => {
  const f=fixture();
  f.heading.onclick();f.input.value='取消的名称';f.buttons[1].onclick();
  f.heading.onclick();f.input.value='放弃的名称';f.form.onkeydown(f.event('Escape'));
  assert.equal(f.heading.textContent,'原名称');
  f.heading.onclick();await f.form.onsubmit(f.event('Enter'));
  f.heading.onclick();f.input.value=' ';await f.form.onsubmit(f.event('Enter'));
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.errors,['请输入项目名称']);
  assert.equal(f.form.hidden,false);
});

test('failed saves retain the draft for retry and pending saves block duplicates', async () => {
  let reject;
  const f=fixture(()=>new Promise((_,fail)=>{reject=fail;}));
  f.heading.onclick();f.input.value='重试名称';
  const pending=f.form.onsubmit(f.event('Enter'));
  assert.equal(f.input.disabled,true);
  await f.form.onsubmit(f.event('Enter'));
  f.form.onkeydown(f.event('Escape'));
  assert.equal(f.form.hidden,false);
  reject(new Error('连接失败'));await pending;
  assert.deepEqual(f.calls,['重试名称']);
  assert.deepEqual(f.errors,['连接失败']);
  assert.equal(f.input.value,'重试名称');
  assert.equal(f.heading.textContent,'原名称');
  assert.equal(f.input.disabled,false);
});

test('a save completed after leaving the project does not update detached UI', async () => {
  let resolve;
  const f=fixture(()=>new Promise(done=>{resolve=done;}));
  f.heading.onclick();f.input.value='新名称';
  const pending=f.form.onsubmit(f.event('Enter'));
  f.form.isConnected=false;resolve('新名称');await pending;
  assert.equal(f.heading.textContent,'原名称');
});

function persistenceFixture() {
  const requests=[], updates=[];
  let complete;
  const context=vm.createContext({
    project:{id:'project-1'},navigationEpoch:1,accountSnapshot:()=>1,isAccountCurrent:()=>true,
    api:(url,options)=>{requests.push({url,options});return new Promise(resolve=>{complete=resolve;});},
    renameProject:(...args)=>updates.push(args),onProjectTitleChanged:(...args)=>updates.push(args),
  });
  const source=read('features/agent/workspace.js');
  const start=source.indexOf('      saveProjectTitle:');
  const end=source.indexOf('      sessionChanged:',start);
  vm.runInContext(`const bridge={${source.slice(start,end)}};globalThis.save=bridge.saveProjectTitle;`,context);
  return {context,requests,updates,complete:()=>complete({project:{title:'已保存名称'}})};
}

test('renaming persists through the project API and updates the heading and project list', async () => {
  const f=persistenceFixture(),pending=f.context.save('新名称');
  assert.equal(f.requests[0].url,'/api/agent/projects/project-1');
  assert.equal(f.requests[0].options.method,'PATCH');
  assert.deepEqual(JSON.parse(f.requests[0].options.body),{title:'新名称'});
  f.complete();assert.equal(await pending,'已保存名称');
  assert.deepEqual(f.updates,[['project-1','已保存名称'],['project-1','已保存名称']]);
});

test('late rename responses cannot update another project or account', async () => {
  for(const change of [f=>{f.context.navigationEpoch++;},f=>{f.context.project.id='project-2';},f=>{f.context.isAccountCurrent=()=>false;}]) {
    const f=persistenceFixture(),pending=f.context.save('新名称');
    change(f);f.complete();await pending;
    assert.deepEqual(f.updates,[]);
  }
});

test('desktop project names and their editor receive clicks outside native drag regions', () => {
  const css=read('styles.css');
  const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const titleRules=rules.filter(([,selector,body])=>selector.includes('.dw-agent-project-title')&&body.includes('-webkit-app-region'));
  assert.ok(titleRules.length,'the editable title needs a native drag exclusion');
  for(const [,selector,body] of titleRules) {
    assert.match(body,/-webkit-app-region:\s*no-drag\s*;/,selector);
  }
  const [,selector]=titleRules.at(-1);
  assert.ok(selector.includes('#appView.agent-project-open'),'exclude clicks in the full desktop project layout');
  assert.ok(selector.includes('.dw-project-title-editor'),'the input and save/cancel buttons need the same exclusion');
});

test('title editor and its entry points use current cache versions', () => {
  const entries=[
    ['index.html',['/app.js?v=575','/styles.css?v=416']],
    ['app.js',['./features/agent/workspace.js?v=158','./drama-studio.js?v=291']],
    ['drama-studio.js',['./features/drama/director-workspace.js?v=184']],
    ['features/agent/workspace.js',['../drama/director-workspace.js?v=184']],
    ['features/drama/director-workspace.js',['../agent/project-title-editor.js?v=1']],
  ];
  for(const [file,urls] of entries)for(const url of urls)assert.ok(read(file).includes(url),`${file}: ${url}`);
});
