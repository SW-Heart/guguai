import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as generation from '../public/features/drama/canvas-generation.js';

const source = await readFile(new URL('../public/features/drama/director-workspace.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const fileMenuCloseListener = appSource.split('\n').find(line=>line.startsWith("document.addEventListener('click', () => $$(")&&line.includes("menu.classList.add('hidden')"));
const functions = source.slice(source.indexOf('  function generationQualityChoice('), source.indexOf('  function fitGenerationAttachments('));
const config = {
  imageModels: [{id:'gpt-image-2.5',label:'GPT Image 2.5'}, {id:'gpt-image-2',label:'GPT Image 2'}],
  videoCapabilities: {models:[{id:'veo-31',label:'Veo 3.1',modes:[
    {generationType:'TEXT',aspectRatios:['16:9'],durations:[8],qualityOptions:['720p'],referenceLimits:{total:0}},
    {generationType:'FIRST&LAST',aspectRatios:['16:9','9:16'],durations:[8],qualityOptions:['720p','1080p'],referenceLimits:{image:2,total:2}},
  ]}]},
};

function classList(...initial) {
  const classes=new Set(initial);
  return {add:value=>classes.add(value),contains:value=>classes.has(value),toggle(value,force){const enabled=force??!classes.has(value);if(enabled)classes.add(value);else classes.delete(value);return enabled;}};
}

function fixture(type, anchor = {left:250,top:450,bottom:486}, viewport = {width:900,height:700}) {
  const draft = {id:'draft',type,modelId:type==='image'?'gpt-image-2.5':'veo-31',mode:'TEXT',aspect:type==='image'?'1:1':'16:9',quality:type==='image'?'1k':'720p',quantity:1,duration:8,midjourney:{},attachments:[]};
  generation.reconcileCanvasGenerationDraft(draft, config);
  const triggers = Object.fromEntries(['model','mode','params'].map(name => [name, {
    dataset:{genMenu:name}, attributes:{},
    getBoundingClientRect:()=>anchor,
    setAttribute(key,value){this.attributes[key]=value;},
    focus(){this.focused=true;},
  }]));
  const selected = {focus(){this.focused=true;}};
  // Deliberately no native Popover API: visibility must be controlled by the menu.
  const menu = {classList:classList('dw-gen-menu'),hidden:true,style:{},dataset:{},scrollHeight:220,scrollTop:0,innerHTML:'',
    attributes:{},setAttribute(key,value){this.attributes[key]=value;},
    contains:target=>target===selected,querySelector:selector=>selector.includes('aria-selected')?selected:null,
    querySelectorAll:()=>[],
  };
  const panel = {hidden:false,querySelectorAll:()=>Object.values(triggers),querySelector:selector=>triggers[selector.match(/data-gen-menu="([^"]+)"/)?.[1]]};
  const context = vm.createContext({...generation,console,
    activeGenerationId:'draft',generationMenu:'',generationMenuElement:menu,
    generationDraft:()=>draft,generationConfig:()=>config,
    host:{querySelector:selector=>selector==='.dw-generation-composer'?panel:panel.querySelector(selector)},
    document:{activeElement:null,documentElement:{clientWidth:viewport.width}},
    window:{innerWidth:viewport.width,innerHeight:viewport.height},
    escape:value=>String(value??''),genIcons:new Proxy({}, {get:()=>'<svg></svg>'}),
    genModelIcon:()=>'<i></i>',genRatioIcon:()=>'<i></i>',bindGenModelIcons:()=>{},
  });
  vm.runInContext(functions, context);
  const run = expression=>vm.runInContext(expression, context);
  const clickBody = source.slice(source.indexOf('      const menuTrigger=event.target.closest'),source.indexOf('      const remove=event.target.closest'));
  vm.runInContext(`function clickTrigger(event){${clickBody}}`, context);
  const click = name=>context.clickTrigger({target:{closest:()=>triggers[name]}});
  const outsideStart=source.indexOf("    document.addEventListener('pointerdown',event=>{\n      if(!generationMenu)return;");
  const outsideBody=source.slice(outsideStart,source.indexOf("    host.addEventListener('scroll'",outsideStart));
  const listeners={};
  context.document.addEventListener=(name,handler)=>{listeners[name]=handler;};
  context.popoverEvents={signal:{}};
  vm.runInContext(outsideBody,context);
  const fileMenu={dataset:{menu:'file-1'},classList:classList('file-menu'),inFileCard:true};
  const foreignMenu={dataset:{menu:'unrelated'},classList:classList()};
  context.$$=selector=>[menu,fileMenu,foreignMenu].filter(element=>{
    const parts=selector.trim().split(/\s+/);
    if(parts.length>1&&!element.inFileCard)return false;
    const target=parts.at(-1);
    return [...target.matchAll(/\.([\w-]+)|\[data-([\w-]+)\]/g)].every(([,cls,attr])=>cls?element.classList.contains(cls):Object.hasOwn(element.dataset,attr.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())));
  });
  vm.runInContext(fileMenuCloseListener,context);
  const bindStart=appSource.indexOf('function bindFileActions(root) {');
  vm.runInContext(appSource.slice(bindStart,appSource.indexOf('\ndocument.addEventListener',bindStart)),context);
  let openFileMenu;
  context.bindFileActions({querySelector:selector=>selector==='.more-button'?{addEventListener:(_,handler)=>{openFileMenu=handler;}}:null});
  return {run,click,menu,panel,triggers,selected,fileMenu,foreignMenu,openFileMenu:()=>openFileMenu({stopPropagation(){},currentTarget:{dataset:{id:'file-1'}}}),bubbleClick:()=>listeners.click(),outside:target=>listeners.pointerdown({target})};
}

for (const type of ['image','video']) {
  test(`${type} model and parameters open from the real click handler without native popovers`, () => {
    const {click,menu,triggers,selected} = fixture(type);
    click('model');
    assert.equal(menu.hidden,false);
    assert.match(menu.innerHTML,type==='image'?/GPT Image 2.5/:/Veo 3.1/);
    assert.equal(triggers.model.attributes['aria-expanded'],'true');
    assert.equal(selected.focused,true);
    click('params');
    assert.equal(menu.hidden,false);
    assert.match(menu.innerHTML,/data-gen-set="aspect"/);
    assert.match(menu.innerHTML,type==='image'?/data-gen-step/:/data-gen-set="duration"/);
    assert.equal(triggers.model.attributes['aria-expanded'],'false');
    assert.equal(triggers.params.attributes['aria-expanded'],'true');
    click('params');
    assert.equal(menu.hidden,true);
    assert.equal(menu.innerHTML,'');
    assert.equal(triggers.params.attributes['aria-expanded'],'false');
  });
}

test('video modes open and close with focus returned to the trigger', () => {
  const {click,run,menu,triggers} = fixture('video');
  click('mode');
  assert.match(menu.innerHTML,/data-gen-set="mode"/);
  assert.match(menu.innerHTML,/FIRST&LAST/);
  run('closeGenerationMenu(true)');
  assert.equal(menu.hidden,true);
  assert.equal(triggers.mode.focused,true);
});

test('menu fits above a low trigger and stays inside the right viewport edge', () => {
  const {click,menu} = fixture('image',{left:800,top:600,bottom:636});
  click('model');
  assert.equal(menu.dataset.placement,'top');
  assert.ok(Number.parseFloat(menu.style.left)+Number.parseFloat(menu.style.width)<=900-12);
  assert.ok(Number.parseFloat(menu.style.top)>=8);
});

test('menu closes when its composer is hidden', () => {
  const {click,run,menu,panel,triggers} = fixture('image');
  click('model');
  panel.hidden=true;
  run('renderGenerationMenu()');
  assert.equal(menu.hidden,true);
  assert.equal(triggers.model.attributes['aria-expanded'],'false');
});

test('outside click closes the menu while menu and trigger clicks keep it open', () => {
  const {click,outside,menu,selected} = fixture('image');
  click('model');
  outside(selected);
  assert.equal(menu.hidden,false);
  outside({closest:()=>true});
  assert.equal(menu.hidden,false);
  outside({closest:()=>null});
  assert.equal(menu.hidden,true);
});

test('workspace disposal removes the independent menu layer', () => {
  let removed=false;
  const cleanup=source.slice(source.indexOf('function dispose(){')+'function dispose(){'.length,source.indexOf('clearEmptyEntry();',source.indexOf('function dispose(){')));
  const context=vm.createContext({generationApproval:null,epoch:1,workspaceActive:true,workspaceFrames:new Set(),mountedWorkspace:null,releaseWorkspaceMedia(){},canvasFocusFrame:0,seenCanvasNodeIds:new Set(),pendingCanvasFocus:new Set(),automaticImageSizing:new Set(),generationMenuLayer:{remove(){removed=true;}},generationMenuElement:{}});
  vm.runInContext(cleanup,context);
  assert.equal(removed,true);
  assert.equal(context.generationMenuLayer,null);
  assert.equal(context.generationMenuElement,null);
});

for (const type of ['image','video']) {
  test(`${type} menus remain visible after the opening click bubbles to the app file-menu listener`, () => {
    const {click,bubbleClick,menu,fileMenu}=fixture(type);
    for(const name of type==='video'?['model','mode','params']:['model','params']) {
      click(name);
      bubbleClick();
      assert.equal(menu.hidden,false);
      assert.equal(menu.classList.contains('hidden'),false,`${name} was hidden by the app click handler`);
      assert.equal(fileMenu.classList.contains('hidden'),true,'file menus still close on outside clicks');
    }
  });
}

test('file menu opening and document clicks never hide unrelated menus', () => {
  const {click,menu,fileMenu,foreignMenu,openFileMenu,bubbleClick}=fixture('image');
  click('model');
  fileMenu.classList.add('hidden');
  openFileMenu();
  assert.equal(fileMenu.classList.contains('hidden'),false);
  assert.equal(menu.classList.contains('hidden'),false);
  assert.equal(foreignMenu.classList.contains('hidden'),false);
  bubbleClick();
  assert.equal(fileMenu.classList.contains('hidden'),true);
  assert.equal(menu.classList.contains('hidden'),false);
  assert.equal(foreignMenu.classList.contains('hidden'),false);
});
