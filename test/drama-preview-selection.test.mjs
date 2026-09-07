import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/drama-studio.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end));

test('assembly clicks switch the preview independently of shot order and preserve playback on unrelated toggles',()=>{
  const candidates=[1,2,3].map(n=>({shot:{id:`s${n}`,title:`Shot ${n}`},index:n-1,taskId:`t${n}`,file:{url:`video-${n}.mp4`,name:`Video ${n}`}}));
  const buttons=candidates.map(item=>({dataset:{assemblyVersion:item.shot.id,assemblyTask:item.taskId}}));
  const inputs=candidates.map(item=>({dataset:{assemblyInclude:item.shot.id},checked:true}));
  let pauses=0;
  const preview={innerHTML:'',querySelector:()=>({pause:()=>pauses++})};
  const confirm={};
  const dialog={innerHTML:'',querySelector:selector=>selector==='[data-assembly-preview]'?preview:selector==='[data-assembly-confirm]'?confirm:null,querySelectorAll:selector=>selector==='[data-assembly-version]'?buttons:selector==='[data-assembly-include]'?inputs:[],showModal(){}};
  const context={project:{shots:candidates.map(item=>item.shot)},professionalAssemblyCandidates:()=>candidates,document:{querySelector:()=>dialog},esc:String,closeProfessionalAssemblyDialog(){},performProfessionalAssembly(){}};
  vm.createContext(context);
  vm.runInContext(extract('  function assemblySelectionItems(', '  function closeProfessionalAssemblyDialog(')+extract('  function openProfessionalAssemblyDialog(){','  async function performProfessionalAssembly('),context);
  context.openProfessionalAssemblyDialog();
  assert.match(preview.innerHTML,/video-1.mp4/);
  buttons[1].onclick();assert.match(preview.innerHTML,/video-2.mp4/);
  buttons[2].onclick();assert.match(preview.innerHTML,/video-3.mp4/);
  const previousPauses=pauses;
  inputs[0].checked=false;inputs[0].onchange();assert.match(preview.innerHTML,/video-3.mp4/);assert.equal(pauses,previousPauses);
  inputs[2].checked=false;inputs[2].onchange();assert.match(preview.innerHTML,/video-2.mp4/);
  inputs[1].checked=false;inputs[1].onchange();assert.match(preview.innerHTML,/assembly-preview-empty/);assert.equal(confirm.disabled,true);
  buttons[0].onclick();assert.match(preview.innerHTML,/video-1.mp4/);
});

test('shot preview only inserts submission placeholders while a request is pending',()=>{
  const context={professionalGenerationPending:new Set(),professionalPreviewTaskIds:new Map(),task:()=>({status:'completed'}),taskLocallyReady:()=>true,taskSyncing:()=>false,taskAsset:()=>({id:'file'}),videoPreviewVersionState:()=> 'ready',workbenchVideoMarkup:()=>'<video></video>',workbenchPreviewThumbMarkup:()=>'<button>Finished version</button>',esc:String,ratioCss:String};
  vm.createContext(context);
  vm.runInContext(extract('  function workbenchShotPreview(shot){','  function workbenchTitleWidth('),context);
  const shot={id:'s1',title:'Shot',selectedVideoTaskId:'t1',videoVersions:['t1'],generation:{count:2}};
  assert.doesNotMatch(context.workbenchShotPreview(shot),/wb-preview-thumb-loader/);
  context.professionalGenerationPending.add('s1');
  assert.equal((context.workbenchShotPreview(shot).match(/wb-preview-thumb-loader/g)||[]).length,2);
  context.professionalGenerationPending.clear();
  assert.doesNotMatch(context.workbenchShotPreview(shot),/wb-preview-thumb-loader/);
});
