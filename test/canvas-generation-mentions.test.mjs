import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {setImmediate} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {canvasGenerationPayload} from '../public/features/drama/canvas-generation.js';
import {normalizeDirectorWorkspace} from '../public/features/drama/director-actions.js';
import {addGenerationReference} from '../public/features/drama/canvas-generation-references.js';
import {bindGenerationMentionDialog} from '../public/features/drama/director-mentions.js';

class Element extends EventTarget {
  constructor(){super();this.children=[];this.style={};this.dataset={};this.attributes={};this.value='';this.isConnected=true;this.offsetWidth=280;this.offsetHeight=160;}
  append(...children){this.children.push(...children);}
  setAttribute(name,value){this.attributes[name]=value;}
  removeAttribute(name){delete this.attributes[name];}
  remove(){this.isConnected=false;}
  focus(){this.focused=true;}
  getBoundingClientRect(){return {left:40,top:300};}
  setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=this.selectionEnd=start+text.length;}
}

test('typing @ opens the reference dialog and inserts its selection after the composer redraws',async()=>{
  const input=new Element();input.value='参考 @ 后续';input.selectionStart=input.selectionEnd=4;
  const replacement=new Element();replacement.value=input.value;
  let openings=0,insertions=0;
  replacement.addEventListener('input',()=>insertions++);
  bindGenerationMentionDialog(input,{signal:new AbortController().signal,getInput:()=>replacement,pick:async()=>{openings++;input.isConnected=false;return {label:'参考图片.png'};}});
  input.dispatchEvent(new Event('input'));await setImmediate();
  assert.equal(openings,1);assert.equal(replacement.value,'参考 @参考图片.png  后续');
  assert.equal(insertions,1);assert.equal(replacement.focused,true);
});

test('cancelling the reference dialog keeps the text and typing cannot open duplicate dialogs',async()=>{
  const input=new Element();input.value='@';input.selectionStart=input.selectionEnd=1;
  let complete,openings=0;
  bindGenerationMentionDialog(input,{signal:new AbortController().signal,pick:()=>{openings++;return new Promise(resolve=>{complete=resolve;});}});
  input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('input'));
  assert.equal(openings,1);complete(null);await setImmediate();
  assert.equal(input.value,'@');assert.equal(input.focused,true);
});

test('IME waits until composition finishes and removed components cannot receive a selection',async()=>{
  const input=new Element();input.value='@';input.selectionStart=input.selectionEnd=1;
  let openings=0;
  bindGenerationMentionDialog(input,{signal:new AbortController().signal,pick:async()=>{openings++;input.isConnected=false;return {label:'猫'};}});
  input.dispatchEvent(new Event('compositionstart'));input.dispatchEvent(new Event('input'));
  assert.equal(openings,0);input.dispatchEvent(new Event('compositionend'));await setImmediate();
  assert.equal(openings,1);assert.equal(input.value,'@');
});

test('ordinary mention text and email addresses do not open the reference dialog',async()=>{
  const input=new Element();let openings=0;
  bindGenerationMentionDialog(input,{signal:new AbortController().signal,pick:async()=>{openings++;return null;}});
  for(const value of ['@猫','a@b.com','普通文字']){
    input.value=value;input.selectionStart=input.selectionEnd=value.length;input.dispatchEvent(new Event('input'));
  }
  await setImmediate();assert.equal(openings,0);
});

function harness(attach,items=()=>[{id:'cat',title:'猫'}]){
  const document=new Element();document.body=new Element();document.createElement=()=>new Element();
  const window=new Element();window.innerWidth=1000;
  const input=new Element();input.value='参考 @猫 后续';input.selectionStart=input.selectionEnd=5;
  let current=input;
  const context=vm.createContext({document,window,Event,attach,input,items,getInput:()=>current,signal:new AbortController().signal});
  const source=readFileSync(new URL('../public/features/drama/director-mentions.js',import.meta.url),'utf8');
  vm.runInContext(source.replaceAll('export function','function')+"\nbindDirectorMentions(input,{items,attach,signal,getInput,pickerId:'canvasGenerationMentionPicker',placeholder:'输入 @ 引用素材'});",context);
  input.dispatchEvent(new Event('input'));
  const picker=document.body.children.at(-1),button=picker?.children[1]?.children[0];
  return {input,picker,getPicker:()=>document.body.children.at(-1),select:()=>button.onclick(),replace:()=>{input.isConnected=false;current=new Element();current.value=input.value;return current;},clear:()=>{current=null;}};
}

test('late file searches cannot overwrite the latest mention query',async()=>{
  const requests=[];
  const h=harness(async()=>true,()=>new Promise(resolve=>requests.push(resolve)));
  h.input.value='参考 @狗';h.input.selectionStart=h.input.selectionEnd=5;
  h.input.dispatchEvent(new Event('input'));
  requests[1]([{id:'dog',title:'狗'}]);await setImmediate();
  const latest=h.getPicker();assert.equal(latest.children[1].children[0].children[0].textContent,'狗');
  requests[0]([{id:'cat',title:'猫'}]);await setImmediate();
  assert.equal(h.getPicker(),latest);
});

test('canvas mention selection inserts at the original caret after the composer renders again',async()=>{
  let target,insertions=0;
  const h=harness(async id=>{assert.equal(id,'cat');target=h.replace();target.addEventListener('input',()=>insertions++);return true;});
  await h.select();
  assert.equal(target.value,'参考 @猫  后续');
  assert.equal(target.selectionStart,6);
  assert.equal(target.focused,true);
  assert.equal(insertions,1);
  assert.equal(h.picker.isConnected,false);
});

test('failed reference attachment leaves the mention query and surrounding text intact',async()=>{
  const h=harness(async()=>false);
  await h.select();assert.equal(h.input.value,'参考 @猫 后续');
});

test('an existing reference uses its saved name when the canvas title differs',async()=>{
  const h=harness(async()=>({label:'猫的参考图.png'}));
  await h.select();assert.equal(h.input.value,'参考 @猫的参考图.png  后续');
});

test('a changed prompt or closed component cannot receive a pending mention',async()=>{
  for(const clear of [false,true]){
    const h=harness(async()=>{if(clear)h.clear();else h.replace().value='新的描述';return true;});
    await h.select();assert.equal(h.input.value,'参考 @猫 后续');
  }
});

test('video mentions map to reference order by media kind and survive project restoration',()=>{
  const mode={generationType:'REFERENCE',qualityOptions:['720p'],durations:[5],aspectRatios:['16:9'],referenceLimits:{image:2,video:1,audio:1,total:4}};
  const config={videoCapabilities:{models:[{id:'test-video',modes:[mode]}]}};
  const draft={id:'canvas-gen-mentions',type:'video',modelId:'test-video',mode:'REFERENCE',quality:'720p',duration:5,aspect:'16:9',prompt:'@猫 跟随 @狗，模仿 @动作，使用 @音乐',attachments:[
    {id:'dog',kind:'image',name:'狗'},{id:'cat',kind:'image',name:'猫'},
    {id:'motion',kind:'video',name:'动作'},{id:'music',kind:'audio',name:'音乐'},
  ]};
  const restored=normalizeDirectorWorkspace({generationDrafts:[draft]}).generationDrafts[0];
  const payload=canvasGenerationPayload(restored,config);
  assert.equal(payload.prompt,'Image2 跟随 Image1，模仿 Video1，使用 Audio1');
  assert.deepEqual(payload.referenceAssetIds,['dog','cat','motion','music']);
  restored.attachments=restored.attachments.filter(file=>file.id!=='cat');
  assert.match(canvasGenerationPayload(restored,config).prompt,/@猫/);
});

test('typing @ in the video composer uses the shared reference dialog and rejects a switched component',async()=>{
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const mode={generationType:'REFERENCE',qualityOptions:['720p'],durations:[5],aspectRatios:['16:9'],referenceLimits:{image:1,total:1}};
  const config={videoCapabilities:{models:[{id:'video',modes:[mode]}]}};
  const draft={id:'canvas-gen-mentions',type:'video',modelId:'video',mode:'REFERENCE',attachments:[]};
  let options,resolveFile,saved=0;
  const context=vm.createContext({video:true,AbortController,epoch:1,draft,input:{},panel:{querySelector:()=>({})},
    activeGenerationId:draft.id,generationDraft:()=>draft,generationUploading:false,generationSubmitting:false,
    syncCanvasMediaLibrary:async()=>{},nodes:()=>[],hiddenIds:()=>new Set(),
    bridge:{toast:assert.fail,uploadGenerationFile:()=>new Promise(resolve=>{resolveFile=resolve;})},
    generationPromptSegments:()=>[],bindGenerationRichPrompt:(_,value)=>{options=value;},addGenerationReference,generationConfig:()=>config,
    closeGenerationMenu(){},renderGenerationComposer(){},reconcileCanvasGenerationDraft(){},resizeGenerationArea(){},scheduleCanvasSave(){saved++;},
  });
  vm.runInContext(source.slice(source.indexOf('  async function attachGenerationReference('),source.indexOf('  function generationMenuMarkup(')),context);
  const start=source.indexOf('    if(video){',source.indexOf('  function renderGenerationComposer('));
  vm.runInContext(source.slice(start,source.indexOf('    fitGenerationPrompt(input);',start)),context);
  assert.equal(options.items,undefined);
  const attached=options.pick();await setImmediate();
  resolveFile({id:'cloud-cat',kind:'image',name:'猫'});
  assert.equal((await attached).label,'猫');
  assert.equal(draft.attachments[0].name,'猫');assert.equal(saved,1);
  draft.attachments=[];
  const stale=options.pick();await setImmediate();context.activeGenerationId='other';
  resolveFile({id:'stale',kind:'image',name:'猫'});
  assert.equal(await stale,null);assert.equal(draft.attachments.length,0);assert.equal(saved,1);
});
