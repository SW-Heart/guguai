import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import { selectPointerNode, nativeArrowAnchorSelected, patchWhiteboardSelection } from '../scripts/director/whiteboard-resize.mjs';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const selectionColor='),source.indexOf('function cardKind(')),context);

test('starting a drag on a selected component preserves all selected nodes',()=>{
  const state={selectedNodeIds:['first','second']};
  const core={getState:()=>state,_selectNodes(ids,append){state.selectedNodeIds=append?[...state.selectedNodeIds,...ids]:ids;}};
  selectPointerNode(core,'second',false);
  assert.deepEqual(state.selectedNodeIds,['first','second']);
  selectPointerNode(core,'second',true);
  assert.deepEqual(state.selectedNodeIds,['first','second']);
  selectPointerNode(core,'third',true);
  assert.deepEqual(state.selectedNodeIds,['first','second','third']);
  selectPointerNode(core,'fourth',false);
  assert.deepEqual(state.selectedNodeIds,['fourth']);
  assert.throws(()=>patchWhiteboardSelection('unsupported engine'),/Unable to locate/);
  const bundle=readFileSync(new URL('../public/vendor/director/reference-canvas.js',import.meta.url),'utf8');
  assert.ok(/selectedNodeIds\?\?\[\]\)\.includes\(\w+\)\|\|\w+\._selectNodes/.test(bundle));
});

test('generated connections never leave native endpoint circles after a nested selection change',()=>{
  const state={selectedNodeIds:['picture','shot','edge-link-picture--shot']};
  const core={getState:()=>state};
  const original=[...state.selectedNodeIds];
  assert.equal(nativeArrowAnchorSelected(core,'edge-link-picture--shot',original),false);
  state.selectedNodeIds=['picture','shot'];
  assert.equal(nativeArrowAnchorSelected(core,'edge-link-picture--shot',original),false);
  for(const id of ['edge-link-picture--shot','edge-result-shot','edge-story']){
    state.selectedNodeIds=[id];
    assert.equal(nativeArrowAnchorSelected(core,id,[id]),false,id);
  }
  state.selectedNodeIds=['drawing-arrow'];
  assert.equal(nativeArrowAnchorSelected(core,'drawing-arrow',['drawing-arrow']),true);
  state.selectedNodeIds=['picture','shot'];
  assert.equal(nativeArrowAnchorSelected(core,'drawing-arrow',['drawing-arrow']),false);
  const engine='o && r(this, L)._selectNodes([o], i.evt.shiftKey); const s = n.includes(this.config.id);';
  const patched=patchWhiteboardSelection(engine);
  assert.ok(patched.includes(nativeArrowAnchorSelected.toString()));
  const bundle=readFileSync(new URL('../public/vendor/director/reference-canvas.js',import.meta.url),'utf8');
  assert.match(bundle,/!String\(\w+\)\.startsWith\("edge-"\)&&\w+\.includes\(\w+\)&&\(\w+\.getState\(\)\.selectedNodeIds\?\?\[\]\)\.includes/);
});

function selectionHandlers(){
  const handlers={};
  const context=vm.createContext({
    canvas:{selectNodes(ids){context.ids=Array.from(ids);handlers['nodes:selected'](context.ids);},on:(name,fn)=>{handlers[name]=fn;},getStage:()=>({on:(names,fn)=>{for(const name of names.split(' '))handlers[name]=fn;}}),getState:()=>({selectedNodeIds:context.ids}),getToolType:()=> 'select',getNodeConfigById:()=>({$_type:'html'})},
    host:{querySelector:()=>({classList:{toggle(){}},hidden:false,innerHTML:''})},
    generationDraft:id=>id?{id}:null,selected:'',activeGenerationId:'',inspectorOpen:false,
    renderGenerationComposer(){},drawInspector(){},syncCanvas(){},renderEdges(){},liveCanvasNodes:()=>[],nativeTransformer:{},window:{setTimeout(){}},mountEpoch:1,epoch:1,
  });
  vm.runInContext(source.slice(source.indexOf("      canvas.on('nodes:selected',ids=>"),source.indexOf("      canvas.on('nodes:deleted'")),context);
  return {context,select:ids=>{context.ids=ids;handlers['nodes:selected'](ids);},fire:(type,event={})=>handlers[`${type}.director-selection`]({evt:{button:0,clientX:20,clientY:30,pointerId:1},...event})};
}

test('connected storyboard and picture selections exclude generated edges from the drag group',()=>{
  const {context,select}=selectionHandlers();
  for(const ids of [
    ['shot','edge-link-picture--shot','picture'],
    ['edge-result-shot','shot','picture','edge-link-picture--shot'],
    ['text','drawing-arrow','edge-link-text--shot','shot','picture'],
  ]){
    select(ids);
    assert.deepEqual(Array.from(context.ids),ids.filter(id=>!id.startsWith('edge-')));
    assert.equal(context.activeGenerationId,'');
  }
  // A connection stays selectable on its own for deletion and context actions.
  select(['edge-link-picture--shot']);
  assert.deepEqual(Array.from(context.ids),['edge-link-picture--shot']);
  assert.equal(context.selected,'');
  select(['shot','edge-link-picture--shot']);
  assert.deepEqual(Array.from(context.ids),['shot']);
  assert.equal(context.activeGenerationId,'');
});

test('first click opens parameters even when the new selection overlay receives pointerup',()=>{
  const {context,select,fire}=selectionHandlers();
  select(['first']);
  assert.equal(context.activeGenerationId,'');
  fire('pointerdown',{target:{id:()=> 'first'}});
  fire('pointerup',{target:{getParent:()=>context.nativeTransformer,hasName:()=>true}});
  assert.equal(context.activeGenerationId,'first');
  select(['second']);
  fire('pointerdown',{target:{id:()=> 'second'}});
  fire('pointerup');
  assert.equal(context.activeGenerationId,'second');
});

test('marquee selection stays closed even when it selects only one generatable node',()=>{
  for(const ids of [['first'],['first','second']]){
    const {context,select,fire}=selectionHandlers();
    select([]);
    fire('pointerdown',{target:{id:()=> ''}});
    select(ids);
    fire('pointerup',{target:{id:()=> 'first'}});
    assert.equal(context.activeGenerationId,'');
  }
});

test('multi-selection, dragging, resizing and cancelled presses never open parameters',()=>{
  for(const type of ['pointermove','dragstart','transformstart','pointercancel','multi']){
    const {context,select,fire}=selectionHandlers();
    select(type==='multi'?['first','second']:['first']);
    fire('pointerdown',{target:{id:()=> 'first'}});
    if(type!=='multi')fire(type,{evt:{clientX:40,clientY:30,pointerId:1}});
    fire('pointerup');
    assert.equal(context.activeGenerationId,'',type);
  }
  const {context,select,fire}=selectionHandlers();
  select(['first']);
  fire('pointerdown',{target:{id:()=> 'first'}});
  fire('pointerup',{evt:{clientX:40,clientY:30,pointerId:1}});
  assert.equal(context.activeGenerationId,'');
});

test('group dragging updates geometry for every selected card and excludes connections',()=>{
  const first={id:()=> 'first'},second={id:()=> 'second'},edge={id:()=> 'edge-link'};
  const transformer={nodes:()=>[first,second,edge]};
  const start=source.indexOf('      const geometryIds=event=>{');
  const end=source.indexOf('      const onGeometryMove=',start);
  const geometryIds=vm.runInNewContext(`${source.slice(start,end)};geometryIds`,{nativeTransformer:transformer});
  for(const target of [first,second,transformer]){
    assert.deepEqual(Array.from(geometryIds({type:'dragmove',target})),['first','second']);
  }
  assert.deepEqual(Array.from(geometryIds({type:'dragend',target:{id:()=> 'other'}})),['other']);
});

function fixture(){
  const attrs={borderStroke:'#00a1ff',rotateEnabled:true,enabledAnchors:['top-left','top-center','top-right','middle-left','middle-right','bottom-left','bottom-center','bottom-right'],keepRatio:false};
  let selected=[];
  const transformer={nodes:()=>selected,forceUpdate(){},getLayer:()=>({batchDraw(){}})};
  for(const key of ['enabledAnchors','keepRatio','borderStroke','rotateEnabled','rotateLineVisible','borderDash','borderStrokeWidth','padding','anchorStroke','anchorFill','anchorSize','anchorStrokeWidth','anchorCornerRadius','anchorStyleFunc']){
    transformer[key]=(...args)=>{
      if(!args.length)return attrs[key];
      attrs[key]=args[0];return transformer;
    };
  }
  context.brandSelectionTransformer(transformer);
  return {transformer,attrs,select:configs=>{selected=configs.map(config=>({getAttr:key=>config[key]}));}};
}

test('selection cannot re-enable rotation when the engine switches components or multi-selects',()=>{
  const {transformer}=fixture();
  assert.equal(transformer.rotateEnabled(),false);
  for(const type of ['image','video','html','rich-text','rect','multi-selection']){
    assert.equal(transformer.rotateEnabled(true),transformer,type);
    assert.equal(transformer.rotateEnabled(),false,type);
  }
  context.brandSelectionTransformer(transformer);
  assert.equal(transformer.rotateEnabled(true).rotateEnabled(),false);
});

test('selection stays solid and compact with larger resize hit areas and transparent arrow borders',()=>{
  const {transformer,attrs}=fixture();
  assert.equal(attrs.rotateLineVisible,false);
  assert.equal(attrs.borderDash.length,0);
  assert.equal(attrs.padding,3);
  let hitWidth=0;
  attrs.anchorStyleFunc({hitStrokeWidth:value=>{hitWidth=value;}});
  assert.ok(attrs.anchorSize+hitWidth>=20);
  transformer.borderStroke('#00a1ff');
  assert.equal(transformer.borderStroke(),'#6366f1');
  transformer.borderStroke('transparent');
  assert.equal(transformer.borderStroke(),'transparent');
});

test('native and card media expose only proportional corner resizing, including mixed selections',()=>{
  const {transformer,attrs,select}=fixture();
  for(const config of [{$_type:'image'},{$_type:'video'},{$_type:'html',$_actualType:'image'},{$_type:'html',$_actualType:'video'}]){
    for(const selection of [[config],[config,{$_type:'rect'}]]){
      select(selection);
      transformer.enabledAnchors(attrs.enabledAnchors);
      transformer.keepRatio(false);
      assert.deepEqual(Array.from(transformer.enabledAnchors()),['top-left','top-right','bottom-left','bottom-right']);
      assert.equal(transformer.keepRatio(),true);
    }
  }
  select([{$_type:'rect'}]);
  assert.equal(transformer.enabledAnchors().length,8);
  assert.equal(transformer.keepRatio(),false);
  select([{$_type:'rich-text'}]);
  transformer.enabledAnchors(['middle-left','middle-right']);
  assert.deepEqual(transformer.enabledAnchors(),['middle-left','middle-right']);
  select([]);
  assert.equal(transformer.keepRatio(),false);
});
