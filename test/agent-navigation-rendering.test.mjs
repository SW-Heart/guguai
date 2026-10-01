import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read=file=>readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8');
const app=read('app.js'),agent=read('features/agent/workspace.js'),director=read('features/drama/director-workspace.js');

test('returning home disposes the project before any shell layout or scheduled paint',()=>{
  const events=[];
  const context=vm.createContext({
    state:{route:'project'},routePaths:{agent:'/agent',files:'/files'},
    window:{location:{pathname:'/agent',search:''},history:{pushState(){}}},document:{},
    agentController:{showHome(){events.push('home');},suspend(){events.push('dispose');}},
    $:()=>({classList:{},set textContent(value){events.push('title');}}),$$:()=>[],
    toggleClass(){events.push('layout');},syncAgentHistory(){events.push('rail');},
    cancelRouteContentRender(){},scheduleRouteContentRender(){events.push('schedule');},renderRouteLoadingShell(){},
  });
  vm.runInContext(app.slice(app.indexOf('function navigate('),app.indexOf("$$('.rail-button[data-route]').forEach(button => button.onclick")),context);
  for(let i=0;i<100;i++){
    context.state.route='project';events.length=0;context.navigate('agent',{historyMode:'none'});
    assert.equal(events[0],'home');assert.ok(events.indexOf('layout')>events.indexOf('home'));
    assert.equal(events.at(-1),'schedule');
  }
  context.state.route='agent';events.length=0;context.navigate('files',{historyMode:'none'});
  assert.equal(events[0],'dispose');
  context.state.route='agent';events.length=0;context.navigate('project',{historyMode:'none'});
  // An invalid project URL resolves back to home and does not unmount its composer.
  assert.equal(events.includes('dispose'),false);
  context.window.location.pathname='/projects/new-id';events.length=0;
  context.navigate('project',{historyMode:'none'});
  assert.equal(events.includes('dispose'),false,'a newly created project may already be mounted before its route event');
});

test('eager home rendering and deferred route loading preserve a single composer and its draft',()=>{
  let disposed=0,cleared=0,rendered=0,aborted=0;
  const entry={draft:'保留我的创作想法'};
  let mounted=null,currentAccount=1;
  const context=vm.createContext({
    navigationEpoch:1,homeActionsController:{abort(){aborted++;}},view:{dispose(){disposed++;}},sessionId:'session',
    project:{id:'project'},initialMessage:'',initialAttachments:[],initialDocuments:[],initialSkill:'',initialModelPreferences:undefined,
    account:null,screen:'workspace',normalizeDirectorWorkspace:()=>({}),accountSnapshot:()=>currentAccount,isAccountCurrent:account=>account===currentAccount,
    host:{replaceChildren(){mounted=null;cleared++;},querySelector:()=>mounted},renderEntry(){mounted=entry;rendered++;},
  });
  vm.runInContext(agent.slice(agent.indexOf('  function resetView('),agent.indexOf('  function renderEntry(')),context);
  context.showHome();
  for(let i=0;i<100;i++)context.showHome();
  assert.equal(disposed,1);assert.equal(aborted,1);assert.equal(cleared,1);assert.equal(rendered,1);
  assert.equal(mounted.draft,'保留我的创作想法');
  currentAccount=2;context.showHome();assert.equal(rendered,2,'a different account must get a fresh home');
});

function workspaceFixture(){
  const callbacks=new Map(),cancelled=[],events=[];
  let sequence=0;
  const context=vm.createContext({
    createStreamPacer:()=>({reset(){}}),clearTimeout(){},
    requestAnimationFrame:callback=>{const id=++sequence;callbacks.set(id,callback);return id;},
    cancelAnimationFrame:id=>cancelled.push(id),
  });
  const instrumented=director.slice(director.indexOf('export function createDirectorWorkspace('))
    .replace('export function','function')
    .replace('return {mount,refresh:drawPanels,dispose};',
      'return {dispose,queueWorkspaceFrame,releaseWorkspaceMedia,setMounted(scope,mount){mountedWorkspace=scope;canvasMount=mount;workspaceActive=true;},frameCount:()=>workspaceFrames.size};');
  vm.runInContext(instrumented,context);
  const workspace=context.createDirectorWorkspace({querySelector:()=>null},{});
  const media={attrs:new Set(['src','data-canvas-src']),pause(){events.push('pause');},removeAttribute:key=>media.attrs.delete(key),
    querySelectorAll:()=>[{removeAttribute(){events.push('source');}}],load(){events.push('unload');}};
  const surface={width:4096,height:2160};
  const scope={querySelectorAll:selector=>selector==='canvas'?[surface]:[media],remove(){events.push('remove');}};
  const mount={unmount(){events.push('unmount');assert.equal(surface.width,4096,'history is saved before backing stores are cleared');
    assert.equal(media.attrs.size,0);workspace.queueWorkspaceFrame(()=>events.push('teardown-frame'));}};
  return {workspace,callbacks,cancelled,events,media,surface,scope,mount};
}

test('disposing releases decoders and canvas buffers and blocks queued or teardown frames',()=>{
  const f=workspaceFixture();f.workspace.setMounted(f.scope,f.mount);
  const frame=f.workspace.queueWorkspaceFrame(()=>f.events.push('stale-frame'));
  f.workspace.dispose();
  assert.ok(f.cancelled.includes(frame));assert.equal(f.workspace.frameCount(),0);
  assert.equal(f.surface.width,0);assert.equal(f.surface.height,0);
  assert.ok(f.events.indexOf('unload')<f.events.indexOf('unmount'));
  assert.ok(f.events.indexOf('unmount')<f.events.indexOf('remove'));
  f.callbacks.get(frame)(16);
  assert.equal(f.events.includes('stale-frame'),false);assert.equal(f.events.includes('teardown-frame'),false);
  f.workspace.dispose();assert.equal(f.events.filter(event=>event==='unmount').length,1,'dispose is idempotent');
});

test('repeated workspace replacement cannot retain frames or backing stores',()=>{
  const f=workspaceFixture();let draws=0;
  for(let i=0;i<100;i++){
    f.surface.width=4096;f.surface.height=2160;f.workspace.setMounted(f.scope,f.mount);
    const stale=f.workspace.queueWorkspaceFrame(()=>draws++);
    f.workspace.dispose();
    f.workspace.setMounted(f.scope,f.mount);
    f.callbacks.get(stale)(16);
    assert.equal(draws,0);assert.equal(f.workspace.frameCount(),0);assert.equal(f.surface.width,0);
  }
  const live=f.workspace.queueWorkspaceFrame(()=>draws++);f.callbacks.get(live)(16);
  assert.equal(draws,1);assert.equal(f.workspace.frameCount(),0);
});

test('late media observer deliveries cannot revive a disposed canvas',()=>{
  let delivery,loads=0;
  const target={isConnected:true,dataset:{canvasSrc:'/video.mp4'},tagName:'VIDEO',set src(value){loads++;}};
  const context=vm.createContext({mountEpoch:1,epoch:1,host:{querySelector:()=>({})},
    IntersectionObserver:class {constructor(callback){delivery=callback;}unobserve(){}},mediaLoadObserver:null});
  const start=director.indexOf("    if(typeof IntersectionObserver==='function')mediaLoadObserver=");
  vm.runInContext(director.slice(start,director.indexOf('    const bindCanvas=',start)),context);
  target.isConnected=false;delivery([{target,isIntersecting:true}]);assert.equal(loads,0);
  target.isConnected=true;context.epoch=2;delivery([{target,isIntersecting:true}]);assert.equal(loads,0);
  context.epoch=1;delivery([{target,isIntersecting:true}]);assert.equal(loads,1);
});

test('late canvas initialization cannot replace the canvas of a newer navigation',()=>{
  let disposed=0;
  const nextCanvas={};
  const context=vm.createContext({mountEpoch:1,epoch:2,canvas:nextCanvas});
  const start=director.indexOf('    const bindCanvas=api=>{');
  vm.runInContext(director.slice(start,director.indexOf("      canvas.on('nodes:created'",start))+'};\nglobalThis.bindCanvas=bindCanvas;',context);
  context.bindCanvas({dispose(){disposed++;}});
  assert.equal(disposed,1);assert.equal(context.canvas,nextCanvas);
});

test('loading a project after returning home cannot remount its canvas',async()=>{
  let finishProject,mounts=0,homeRenders=0;
  const host={replaceChildren(){},querySelector:()=>null,innerHTML:''};
  const context=vm.createContext({host,navigationEpoch:0,homeActionsController:null,view:null,sessionId:'',project:{},
    initialMessage:'',initialAttachments:[],initialDocuments:[],initialSkill:'',initialModelPreferences:undefined,
    account:null,screen:'',normalizeDirectorWorkspace:()=>({}),accountSnapshot:()=>1,isAccountCurrent:()=>true,
    renderEntry(){homeRenders++;},projectLoadingMarkup:'正在打开项目',api:()=>new Promise(resolve=>{finishProject=resolve;}),
    mountWorkspace(){mounts++;},toast(){assert.fail('stale navigation must not notify');}});
  vm.runInContext(agent.slice(agent.indexOf('  function resetView('),agent.indexOf('  function renderEntry('))+
    agent.slice(agent.indexOf('  async function openProject('),agent.indexOf('  const asset=')),context);
  const pending=context.openProject('project');
  context.showHome();finishProject({project:{id:'project',title:'旧项目'}});await pending;
  assert.equal(mounts,0);assert.equal(homeRenders,1);assert.equal(context.screen,'home');assert.equal(context.project.id,'');
});

test('navigation fixes reach both workspace imports and the versioned HTML entry',()=>{
  const html=read('index.html');
  assert.ok(html.includes('/app.js?v=471'));assert.ok(html.includes('/styles.css?v=352'));
  assert.ok(app.includes('./features/agent/workspace.js?v=82'));assert.ok(app.includes('./drama-studio.js?v=212'));
  assert.ok(agent.includes('../drama/director-workspace.js?v=118'));
  assert.ok(read('drama-studio.js').includes('./features/drama/director-workspace.js?v=118'));
});
