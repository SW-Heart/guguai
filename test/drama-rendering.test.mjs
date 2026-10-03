import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { calculateVirtualShotRange } from '../public/features/drama/pure.js';

const source=readFileSync(new URL('../public/drama-studio.js',import.meta.url),'utf8');
const functionSource=(name,next)=>source.slice(source.indexOf(`  function ${name}(`),source.indexOf(`  function ${next}(`));

test('virtual scrolling retains overlapping editors and videos and releases removed media',()=>{
  const bound=[];
  const released=[];
  const cards=[];
  const items={children:cards,querySelector:selector=>cards.find(card=>selector.includes(`"${card.dataset.wbShot}"`)),insertBefore(card,before){
    const existing=cards.indexOf(card);if(existing>=0)cards.splice(existing,1);
    const index=before?cards.indexOf(before):cards.length;cards.splice(index,0,card);
  }};
  const makeCard=id=>({dataset:{wbShot:id},classList:{toggle(){}},contains:()=>false,
    querySelectorAll:()=>[{pause(){released.push(id);},removeAttribute(){},load(){}}],
    remove(){cards.splice(cards.indexOf(this),1);}});
  const scroll={scrollTop:0,clientHeight:600,scrollHeight:12000,querySelector:selector=>selector==='[data-wb-virtual-items]'?items:null};
  let range={start:0,end:3};
  const context={state:{route:'drama',tasks:[],files:[]},root:{contains:node=>cards.includes(node)},
    project:{shots:Array.from({length:30},(_,i)=>({id:`s${i}`}))},document:{activeElement:null,createElement:()=>({content:{},set innerHTML(id){this.content.firstElementChild=makeCard(id);}})},
    window:{innerHeight:600},CSS:{escape:String},isMountedVirtualShotScroll:()=>true,virtualRangeFor:()=>({...range}),
    virtualRangeKey:'',virtualStart:0,virtualEnd:0,virtualShotResizeObserver:null,workbenchVideoObserver:null,
    releaseWorkbenchVideos:card=>card.querySelectorAll('video').forEach(video=>{video.pause();video.removeAttribute('src');video.load();}),
    projectEditingLocked:()=>false,professionalShotId:'s0',mentionPicker:{editor:null},workbenchShotCard:shot=>shot.id,
    updateVirtualSpacers(){},clampVirtualScrollOffset:value=>value,professionalPreviewTaskIds:new Map(),
    shotPreviewSignatures:new Map(),shotPreviewContentSignatureFromMaps:()=>'',localDeliverySignature:()=>'',assetSyncing(){},task:()=>null,
    bindStoryboardWorkbench:({scope})=>bound.push(scope),observeVirtualShotHeights(){}};
  vm.createContext(context);vm.runInContext(functionSource('renderProfessionalShotWindow','workbenchEmptyShotState'),context);
  context.renderProfessionalShotWindow({scroll});
  const editor=cards[1];const preview=cards[2];
  range={start:1,end:4};scroll.scrollTop=430;
  context.renderProfessionalShotWindow({scroll});
  assert.equal(cards[0],editor);assert.equal(cards[1],preview);
  assert.deepEqual(cards.map(card=>card.dataset.wbShot),['s1','s2','s3']);
  assert.deepEqual(released,['s0']);assert.equal(bound.length,4,'retained cards must not receive duplicate listeners');
  context.document.activeElement={closest:()=>editor};
  range={start:15,end:18};scroll.scrollTop=6450;
  context.renderProfessionalShotWindow({scroll});
  assert.deepEqual(cards.map(card=>card.dataset.wbShot),['s15','s16','s17'],'an offscreen focused editor must not expand the window to dozens of shots');
});

test('background refresh preserves unchanged project images and video decoders',()=>{
  const file={id:'video',name:'视频',url:'gugu-media://one'};
  const name={textContent:''};let replacements=0;let hydrations=0;
  const button={dataset:{projectAsset:file.id},firstChild:name,querySelector:()=>name};
  name.insertAdjacentHTML=()=>replacements++;
  const context={releaseWorkbenchVideos(){},setWorkbenchText:(node,value)=>{if(node)node.textContent=value;},project:{},root:{querySelectorAll:()=>[button]},asset:()=>file,assetSyncing:()=>false,
    projectAssetMedia:value=>value.url,workbenchAssetSurfaceSignatures:new WeakMap([[button,file.url]]),hydrateWorkbenchVideos:()=>hydrations++};
  vm.createContext(context);vm.runInContext(functionSource('patchProfessionalAssetSurfaces','mentionKindLabel'),context);
  for(let i=0;i<5;i++)context.patchProfessionalAssetSurfaces();
  assert.equal(replacements,0);assert.equal(hydrations,0);assert.equal(name.textContent,'视频');
  file.url='gugu-media://two';context.patchProfessionalAssetSurfaces();
  assert.equal(replacements,1);assert.equal(hydrations,1);
});

test('model changes replace settings while preserving the editor, references and preview',()=>{
  const selectors=['.wb-model-select','.wb-mode-control','.wb-specs-control'];
  const replaced=[];const bound=[];
  const stable={editor:{},references:{},preview:{},generate:{}};
  const controls=new Map(selectors.map(selector=>[selector,{replaceWith:next=>replaced.push([selector,next])}]));
  const card={dataset:{wbShot:'s'},querySelector:selector=>controls.get(selector)||stable[selector]};
  const context={project:{shots:[{id:'s'}]},projectEditingLocked:()=>false,workbenchShotSettings:()=>({modelSelect:'model',modeSelect:'mode',specs:'specs'}),
    document:{createElement:()=>({content:{querySelector:selector=>({selector})}})},
    workbenchCardSignatures:new WeakMap(),bindWorkbenchDropdowns:node=>bound.push(node),bindWorkbenchShotSettings:node=>assert.equal(node,card),refreshWorkbenchShotStatus:node=>assert.equal(node,card)};
  vm.createContext(context);vm.runInContext(functionSource('refreshWorkbenchShotControls','bindWorkbenchActionBar'),context);
  context.refreshWorkbenchShotControls(card);
  assert.deepEqual(replaced.map(([selector])=>selector),selectors);assert.equal(bound.length,3);
  assert.equal(card.querySelector('editor'),stable.editor);assert.equal(card.querySelector('preview'),stable.preview);
  assert.equal(card.querySelector('references'),stable.references);assert.equal(card.querySelector('generate'),stable.generate);
});

test('new shots keep the workspace and existing media mounted after saving',async()=>{
  let saves=0;let windows=0;let shellWrites=0;let scrollWrites=0;let focused=0;
  const scroll={classList:{contains:()=>false},scrollTop:0,insertAdjacentHTML(){},set innerHTML(value){scrollWrites++;}};
  const context={project:{id:'p',shots:[{id:'old'}]},professionalShotId:'old',professionalPreviewShotId:'old',
    projectRequest:()=>({}),assertProjectRequest(){},createProfessionalShot:()=>({id:'new'}),ensureProfessionalVideoSettings(){},
    patch:async(_body,options)=>{assert.equal(options.quiet,true);saves++;},
    root:{querySelector:selector=>selector==='.wb-shot-scroll'?scroll:selector==='.wb-action-bar'?{remove(){}}:{focus:()=>focused++},set innerHTML(value){shellWrites++;}},
    dropFocus(){},closeWorkbenchDropdowns(){},workbenchActionBar:()=>'',bindWorkbenchActionBar(){},updateVirtualSpacers(){},
    syncWorkbenchActionBar(){},virtualHeightBefore:()=>430,renderProfessionalShotWindow:({scroll:node})=>{assert.equal(node,scroll);windows++;},activateProfessionalShot(){},CSS:{escape:String}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function addProfessionalShot('),source.indexOf('  function invalidateProfessionalShot(')),context);
  await context.addProfessionalShot();
  assert.equal(saves,1);assert.equal(windows,1);assert.equal(shellWrites,0);assert.equal(scrollWrites,0);assert.equal(focused,1);
  assert.equal(context.project.shots[0].id,'old');assert.equal(context.project.shots[1].id,'new');
});

test('local videos load only near the viewport and changed entrypoints share fresh cache keys',()=>{
  const mediaSource=source.slice(source.indexOf('  const workbenchVideoMarkup'),source.indexOf('  const resetWorkbenchVideoObserver'));
  assert.match(mediaSource,/data-wb-video-src=/);assert.match(mediaSource,/preload="metadata"/);assert.doesNotMatch(mediaSource,/preload="auto"/);
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.ok(html.includes('/app.js?v=479'));assert.ok(html.includes('/styles.css?v=360'));
  assert.ok(app.includes('./drama-studio.js?v=220'));
  assert.ok(source.includes('./features/drama/workbench-media.js?v=1'));
});

test('the workbench bounds painting and the narrow viewport while keeping glass colors',()=>{
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  const optimization=css.slice(css.indexOf('/* Repeated controls sit on opaque panels.'),css.indexOf('@media (prefers-reduced-motion: reduce)',css.indexOf('/* Repeated controls sit on opaque panels.')));
  assert.match(optimization,/backdrop-filter: none/);assert.match(optimization,/contain: paint/);
  assert.match(optimization,/@media \(max-width: 920px\)[\s\S]*height: calc\(100dvh/);
  assert.match(optimization,/grid-template-rows: auto minmax\(0, 1fr\)/);
  assert.doesNotMatch(optimization,/background:|box-shadow:/,'the optimization preserves the existing glass tint and shadows');
});

test('generation, delivery and save refreshes keep the same project shell and cards mounted',()=>{
  const cards=[{dataset:{wbShot:'a'}},{dataset:{wbShot:'b'}}];
  const scroll={classList:{contains:()=>false}};
  const mounted={dataset:{projectId:'p'},classList:{contains:()=>false}};
  let shellWrites=0;let resets=0;let patches=0;
  const context={project:{id:'p',shots:[{id:'a'},{id:'b'}]},professionalShotId:'a',professionalPreviewShotId:'a',
    virtualShotProjectId:'p',virtualShotHeights:new Map(),projectEditingLocked:()=>false,
    root:{querySelector:selector=>selector==='.storyboard-workbench'?mounted:scroll,querySelectorAll:()=>cards,set innerHTML(value){shellWrites++;}},
    closeMentionPicker(){},removeOrphanMentionChips(){},seedProjectAssets(){},patchWorkbenchAssets(){},syncWorkbenchActionBar(){},
    renderProfessionalShotWindow(){},patchMountedWorkbenchShot(){patches++;},patchProfessionalTaskSurfaces(){},
    resetWorkbenchVideoObserver(){resets++;},resetVirtualShotWindow(){resets++;}};
  vm.createContext(context);vm.runInContext(functionSource('renderProfessionalWorkspace','createProfessionalShot'),context);
  for(let i=0;i<100;i++){
    context.project={...context.project,shots:context.project.shots.map(shot=>({...shot,revision:i}))};
    context.renderProfessionalWorkspace({focus:false});
  }
  assert.equal(shellWrites,0);assert.equal(resets,0);assert.equal(patches,200);
  assert.equal(cards[0].dataset.wbShot,'a');assert.equal(cards[1].dataset.wbShot,'b');
});

test('a title edit after saving updates the current shot object',()=>{
  const handlers={};const classNames=new Set();
  const input={value:'',classList:{add(){},remove(){}},addEventListener:(type,fn)=>handlers[`input-${type}`]=fn,focus(){},select(){}};
  const display={textContent:'旧名称',classList:{add(){},remove(){}},setAttribute(){},addEventListener:(type,fn)=>handlers[`display-${type}`]=fn};
  const card={dataset:{wbShot:'a'},classList:{contains:name=>classNames.has(name),add:name=>classNames.add(name),remove:name=>classNames.delete(name)},
    addEventListener(){},querySelector:selector=>selector==='[data-wb-edit-title]'?display:selector==='[data-wb-field="title"]'?input:null,
    querySelectorAll:()=>[]};
  const old={id:'a',title:'旧名称'};
  const context={project:{shots:[old]},root:{querySelector:()=>null},DEFAULT_SHOT_TITLE:'未命名分镜',
    bindWorkbenchDropdowns(){},fitWorkbenchTitle(){},bindMentionChipInteractions(){},bindWorkbenchShotSettings(){},rememberWorkbenchCard(){},
    bindWorkbenchPreviewActions(){},bindWorkbenchVideoRatios(){},hydrateWorkbenchVideos(){},requestAnimationFrame:fn=>fn(),
    updateWorkbenchShot:(id,field,value)=>{context.project.shots.find(shot=>shot.id===id)[field]=value;}};
  vm.createContext(context);vm.runInContext(functionSource('bindStoryboardWorkbench','applyProjectAssetToShot'),context);
  context.bindStoryboardWorkbench({focus:false,cardsOnly:true,scope:{querySelectorAll:()=>[card]}});
  context.project={shots:[{id:'a',title:'已保存名称'}]};
  handlers['display-click']({stopPropagation(){}});assert.equal(input.value,'已保存名称');
  classNames.add('is-editing-title');input.value='新名称';handlers['input-blur']();
  assert.equal(context.project.shots[0].title,'新名称');assert.equal(old.title,'旧名称');
});

test('unchanged preview media and existing versions survive adding another version',()=>{
  const oldStage={querySelector:()=>null,dataset:{wbPreviewContent:'video-a'},replaceWith:()=>assert.fail('unchanged main preview must stay mounted')};
  const nextStage={querySelector:()=>null,dataset:{wbPreviewContent:'video-a'}};
  const existing={dataset:{wbVersion:'a',wbThumbContent:'ready'},className:'wb-preview-thumb',querySelector:()=>null};
  const nextExisting={dataset:{...existing.dataset},className:'wb-preview-thumb selected',querySelector:()=>null};
  const added={dataset:{wbVersion:'b',wbThumbContent:'ready'},className:'wb-preview-thumb',querySelector:()=>null};
  const versions={children:[existing],insertBefore(node){this.children.push(node);}};
  const current={setAttribute(){},querySelector:selector=>selector==='header span'?{textContent:'1 个版本'}:selector==='.wb-preview-stage'?oldStage:versions};
  const next={getAttribute:()=>'',querySelector:selector=>selector==='header span'?{textContent:'2 个版本'}:selector==='.wb-preview-stage'?nextStage:{children:[nextExisting,added]}};
  const hydrated=[];
  const context={setWorkbenchText:(node,value)=>node.textContent=value,releaseWorkbenchVideos:()=>assert.fail('unchanged media must not be released'),
    bindWorkbenchPreviewActions(){},hydrateWorkbenchVideos:node=>hydrated.push(node)};
  vm.createContext(context);vm.runInContext(functionSource('patchWorkbenchPreview','patchProfessionalTaskSurfaces'),context);
  context.patchWorkbenchPreview(current,next);
  assert.equal(versions.children[0],existing);assert.equal(versions.children[1],added);
  assert.equal(existing.className,nextExisting.className);assert.deepEqual(hydrated,[added]);
});

test('measuring the overscan cards preserves the visible scroll anchor',()=>{
  let callback;let frames=0;
  const shots=Array.from({length:6},(_,index)=>({id:`s${index}`}));
  const cards=shots.slice(0,3).map((shot,index)=>({dataset:{wbShot:shot.id,wbShotIndex:String(index)}}));
  const scroll={scrollTop:860,querySelectorAll:()=>cards};
  const heights=new Map();
  class ResizeObserver {constructor(fn){callback=fn;}observe(){}}
  const context={window:{ResizeObserver},ResizeObserver,root:{},project:{shots},virtualShotResizeObserver:null,
    calculateVirtualShotRange,virtualEstimatedShotHeight:430,virtualShotHeights:heights,
    virtualShotHeight:index=>heights.get(shots[index].id)||430,isMountedVirtualShotScroll:()=>true,
    getComputedStyle:()=>({marginTop:'0',marginBottom:'0'}),updateVirtualSpacers(){},scheduleVirtualShotWindow:()=>frames++};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  const observeVirtualShotHeights ='),source.indexOf('  const scheduleVirtualShotWindow ='))+'\nglobalThis.observe=observeVirtualShotHeights;',context);
  context.observe(scroll);
  const entries=[{target:cards[0],borderBoxSize:[{blockSize:330}]},{target:cards[1],borderBoxSize:[{blockSize:400}]}];
  callback(entries);assert.equal(scroll.scrollTop,730);assert.equal(frames,1);
  callback(entries);assert.equal(scroll.scrollTop,730);assert.equal(frames,1,'unchanged measurements must not start a repaint loop');
});

test('duplicate input events do not create duplicate revisions or saves',()=>{
  const shot={id:'a',script:'中文输入',assetMentions:[]};
  const context={project:{shots:[shot]},serializeRichEditor:()=>shot.script,mentionsFromEditor:()=>[],
    shotReferenceIds:()=>assert.fail('an unchanged input event must not repeat reference and pricing work')};
  vm.createContext(context);vm.runInContext(functionSource('updateShotScriptFromEditor','bindMentionChipInteractions'),context);
  context.updateShotScriptFromEditor('a',{});
  context.updateShotScriptFromEditor('a',{});
});

test('background reference updates leave a composing editor and its selection intact',()=>{
  let deferred=0;
  const editor={dataset:{composing:'true'}};
  const context={root:{querySelector:()=>editor},deferProfessionalRender:()=>deferred++,window:{getSelection:()=>assert.fail('composition selection must stay untouched')}};
  vm.createContext(context);vm.runInContext(functionSource('refreshWorkbenchReferenceRow','workbenchDropdownMarkup'),context);
  context.refreshWorkbenchReferenceRow('a',{id:'a'});assert.equal(deferred,1);
});
