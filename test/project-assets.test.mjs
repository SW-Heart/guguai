import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeProjectAssets,projectAssetGroups} from '../public/features/drama/project-assets.js';
import {normalizeDirectorWorkspace} from '../public/features/drama/director-actions.js';

test('project asset categories, custom names and collapsed sections survive a workspace round trip',()=>{
  const projectAssets={names:{portrait:'主角定妆照'},types:[{id:'asset-type-costumes',name:'服装'}],categories:{portrait:'character',dress:'asset-type-costumes',song:'audio'},collapsed:['prop','asset-type-costumes']};
  const saved=normalizeDirectorWorkspace({projectAssets});
  assert.deepEqual(normalizeDirectorWorkspace(JSON.parse(JSON.stringify(saved))).projectAssets,projectAssets);
  assert.deepEqual(normalizeDirectorWorkspace().projectAssets,{types:[],names:{},categories:{},collapsed:[]});
});

test('invalid or duplicate custom types and assignments cannot replace the five built-in categories',()=>{
  const state=normalizeProjectAssets({types:[{id:'character',name:'覆盖'},{id:'asset-type-dupe',name:'角色'},{id:'bad',name:'非法'},{id:'asset-type-1',name:'  服装  '},{id:'asset-type-2',name:'服装'}],categories:{valid:'asset-type-1',invalid:'missing'},collapsed:['missing','character','character']});
  assert.deepEqual(state,{names:{},types:[{id:'asset-type-1',name:'服装'}],categories:{valid:'asset-type-1'},collapsed:['character']});
  assert.equal(projectAssetGroups([],state).length,6);
});

test('assets use entity categories, audio fallback and saved file assignments without duplicates',()=>{
  const groups=projectAssetGroups([{id:'hero',category:'character'},{id:'set',category:'location'},{id:'prop',category:'prop'},{id:'song',kind:'audio'},{id:'video',kind:'video'},{id:'dress',assetId:'dress-file',category:'character'},{id:'hero',category:'other'}],{types:[{id:'asset-type-costumes',name:'服装'}],categories:{'dress-file':'asset-type-costumes'}});
  assert.deepEqual(groups.map(group=>group.name),['角色','场景','物品','音频','其他','服装']);
  assert.deepEqual(groups.map(group=>group.items.map(item=>item.id)),[['hero'],['set'],['prop'],['song'],['video'],['dress']]);
});

test('asset drawer dismisses outside presses while preserving inside, trigger and nested dialog interactions',()=>{
  class Element extends EventTarget {
    hidden=false;
    attributes=new Map();
    children=new Set();
    setAttribute(name,value){this.attributes.set(name,value);}
    removeAttribute(name){this.attributes.delete(name);}
    contains(target){return target===this||this.children.has(target);}
    closest(){return null;}
    focus(){this.focused=true;}
    querySelectorAll(){return [];}
    remove(){this.removed=true;}
  }
  const drawer=new Element(),trigger=new Element(),body=new Element(),form=new Element(),closeButton=new Element();
  drawer.children.add(closeButton);
  drawer.querySelector=selector=>selector==='form'?form:selector==='[data-assets-close]'?closeButton:body;
  const document=new EventTarget();document.createElement=()=>drawer;
  const context=vm.createContext({document,AbortController,crypto});
  const source=readFileSync(new URL('../public/features/drama/project-assets.js',import.meta.url),'utf8');
  vm.runInContext(source.replaceAll('export function','function'),context);
  const mounted=context.mountProjectAssetsDrawer({board:{append(){}},trigger,items:()=>[],getState:()=>({}),setState:async()=>{},icon:()=>''});
  const open=()=>{trigger.dispatchEvent(new Event('click'));assert.equal(drawer.hidden,false);};
  const press=target=>{
    const event=new Event('pointerdown',{cancelable:true});Object.defineProperty(event,'target',{value:target});
    document.dispatchEvent(event);assert.equal(event.defaultPrevented,false,'outside dismissal must preserve the original pointer action');
  };
  open();press(closeButton);assert.equal(drawer.hidden,false);
  press(drawer);assert.equal(drawer.hidden,false);
  press(trigger);assert.equal(drawer.hidden,false);
  trigger.dispatchEvent(new Event('click'));assert.equal(drawer.hidden,true,'trigger toggles closed without reopening');
  open();press({closest:()=>({open:true})});assert.equal(drawer.hidden,false);
  press(new Element());assert.equal(drawer.hidden,true);assert.equal(trigger.attributes.get('aria-expanded'),'false');
  assert.equal(trigger.focused,undefined,'outside dismissal must not move focus back to the trigger');
  open();mounted.destroy();drawer.hidden=false;press(new Element());
  assert.equal(drawer.hidden,false,'destroy removes the outside listener');
});

test('drawer drag moves preserve asset aliases and state, accept collapsed custom groups and ignore external drops',async()=>{
  class Element extends EventTarget {
    dataset={};children=new Set();classes=new Set();
    classList={add:value=>this.classes.add(value),remove:value=>this.classes.delete(value)};
    setAttribute(){} removeAttribute(){} focus(){} remove(){}
    contains(target){return target===this||this.children.has(target);}
    closest(selector){return selector==='[data-asset-focus]'&&this.dataset.assetFocus?this:selector==='[data-assets-group]'&&this.dataset.assetsGroup?this:null;}
    querySelectorAll(){return [];}
  }
  const drawer=new Element(),trigger=new Element(),body=new Element(),form=new Element(),asset=new Element(),group=new Element();
  asset.dataset.assetFocus='portrait';group.dataset.assetsGroup='asset-type-costumes';
  drawer.children.add(asset);drawer.children.add(group);
  drawer.querySelector=selector=>selector==='form'?form:body;
  const document=new EventTarget();document.createElement=()=>drawer;
  let state={types:[{id:'asset-type-costumes',name:'服装'}],categories:{'portrait-file':'character'},names:{portrait:'主角'},collapsed:['prop','asset-type-costumes']},saves=0,focused=0,fail=false;
  const errors=[],inventory=[{id:'portrait',assetId:'portrait-file',name:'主角',kind:'image',category:'character',url:'test.png'}];
  const context=vm.createContext({document,AbortController,crypto});
  vm.runInContext(readFileSync(new URL('../public/features/drama/project-assets.js',import.meta.url),'utf8').replaceAll('export function','function'),context);
  const mounted=context.mountProjectAssetsDrawer({board:{append(){}},trigger,items:()=>inventory,getState:()=>state,setState:async next=>{if(fail)throw new Error('保存失败');state=next;saves++;},focusAsset:()=>focused++,toast:message=>errors.push(message),icon:()=>''});
  trigger.dispatchEvent(new Event('click'));
  assert.match(body.innerHTML,/draggable="true" data-asset-focus="portrait"/);
  assert.match(body.innerHTML,/<img[^>]*draggable="false"/);
  const transfer={effectAllowed:'',dropEffect:'',data:{},setData(type,value){this.data[type]=value;}};
  const dispatch=(type,target,dataTransfer=transfer,host=drawer)=>{
    const event=new Event(type,{cancelable:true});Object.defineProperties(event,{target:{value:target},dataTransfer:{value:dataTransfer},relatedTarget:{value:null}});host.dispatchEvent(event);return event;
  };
  assert.equal(dispatch('drop',group).defaultPrevented,false,'external drops must not move project assets');
  dispatch('dragstart',asset);assert.equal(transfer.effectAllowed,'move');
  assert.equal(transfer.data['application/x-gugu-project-asset'],'portrait');
  const markup=body.innerHTML;inventory.push({id:'new',name:'新增素材'});mounted.update();assert.equal(body.innerHTML,markup,'updates must not replace the active drag source');
  assert.equal(dispatch('dragover',group).defaultPrevented,true);assert.ok(group.classes.has('is-assets-drop-target'));
  dispatch('drop',group);dispatch('click',asset);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(focused,0,'dropping must not focus a canvas asset');assert.equal(drawer.hidden,false);
  assert.equal(saves,1);assert.equal(state.categories.portrait,'asset-type-costumes');assert.equal(state.categories['portrait-file'],'asset-type-costumes');
  assert.deepEqual(Array.from(state.collapsed),['prop']);assert.equal(state.names.portrait,'主角');
  assert.ok(!group.classes.has('is-assets-drop-target'));
  assert.equal(projectAssetGroups(inventory,state).find(group=>group.id==='asset-type-costumes').items[0].id,'portrait');
  dispatch('dragstart',asset);dispatch('drop',group);await new Promise(resolve=>setImmediate(resolve));assert.equal(saves,1,'same-category drops do not save');
  group.dataset.assetsGroup='other';fail=true;dispatch('dragstart',asset);dispatch('drop',group);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(errors,['保存失败']);assert.equal(state.categories.portrait,'asset-type-costumes');
  fail=false;dispatch('dragstart',asset);dispatch('dragover',group);dispatch('dragend',asset,transfer,document);
  assert.ok(!group.classes.has('is-assets-drop-target'));assert.equal(saves,1,'canceling does not change categories');
  dispatch('drop',group);assert.equal(saves,1);mounted.destroy();
});

test('project inventory inherits entity types for results and merges imported and native media once',()=>{
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const state={generationDrafts:[{id:'hero',entity:{kind:'character',name:'主角'}},{id:'result',parentId:'hero'}]};
  const context=vm.createContext({agentState:null,workspace:()=>state,hiddenIds:()=>new Set(['deleted']),nodes:()=>[
    {id:'hero',kind:'canvas-generation',title:'角色',item:state.generationDrafts[0]},
    {id:'result',kind:'canvas-generation',title:'结果',taskId:'task',item:state.generationDrafts[1]},
    {id:'file',kind:'asset',title:'图片',media:{id:'file',kind:'image',url:'https://example.com/a.png'}},
    {id:'song',kind:'asset',title:'配乐',media:{id:'song',kind:'audio',url:'https://example.com/song.mp3'}},
    {id:'deleted',kind:'canvas-generation',item:{},title:'已删除'}],bridge:{media:task=>task?{id:'file',kind:'image',url:'https://example.com/a.png'}:null},canvasLibraryMedia:()=>[{id:'native',kind:'video',name:'视频',url:'https://example.com/b.mp4'}]});
  vm.runInContext(source.slice(source.indexOf('  function projectAssetItems('),source.indexOf('  function canvasLibraryMedia(')),context);
  const inventory=JSON.parse(JSON.stringify(context.projectAssetItems()));
  assert.equal(inventory.filter(item=>item.assetId==='file').length,1);
  assert.equal(inventory.find(item=>item.id==='result').category,'character');
  assert.equal(inventory.find(item=>item.id==='result').name,'主角');
  assert.ok(inventory.some(item=>item.id==='song'&&item.kind==='audio'));
  assert.ok(inventory.some(item=>item.id==='native'&&item.kind==='video'));
  assert.ok(!inventory.some(item=>item.id==='deleted'));
  assert.ok(!inventory.some(item=>item.id==='hero'),'ungenerated entity cards must not appear');
});

test('asset drawer and persistence changes are connected through fresh cache versions',()=>{
  const read=file=>readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8');
  for(const [file,urls] of [
    ['index.html',['/app.js?v=640','/styles.css?v=440']],
    ['app.js',['./drama-studio.js?v=323','./features/agent/workspace.js?v=190']],
    ['drama-studio.js',['./features/drama/director-workspace.js?v=214']],
    ['features/agent/workspace.js',['../drama/director-workspace.js?v=214','../drama/director-actions.js?v=21']],
    ['features/drama/director-workspace.js',['./director-actions.js?v=21','./project-assets.js?v=4','./media-name-editor.js?v=1','../../vendor/director/reference-canvas.js?v=43']],
    ['features/drama/director-actions.js',['./project-assets.js?v=4']],
  ])for(const url of urls)assert.ok(read(file).includes(url),`${file}: ${url}`);
});
