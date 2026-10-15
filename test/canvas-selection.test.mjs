import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import { selectPointerNode, patchWhiteboardSelection } from '../scripts/director/whiteboard-resize.mjs';

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

function selectionHandlers(){
  const handlers={};
  const context=vm.createContext({
    canvas:{on:(name,fn)=>{handlers[name]=fn;},getStage:()=>({on:(name,fn)=>{handlers[name]=fn;}}),getState:()=>({selectedNodeIds:context.ids}),getToolType:()=> 'select',getNodeConfigById:()=>({$_type:'html'})},
    host:{querySelector:()=>({classList:{toggle(){}},hidden:false,innerHTML:''})},
    generationDraft:id=>id?{id}:null,selected:'',activeGenerationId:'',inspectorOpen:false,
    renderGenerationComposer(){},drawInspector(){},syncCanvas(){},renderEdges(){},liveCanvasNodes:()=>[],nativeTransformer:{},window:{setTimeout(){}},mountEpoch:1,epoch:1,
  });
  vm.runInContext(source.slice(source.indexOf("      canvas.on('nodes:selected',ids=>"),source.indexOf("      canvas.on('nodes:deleted'")),context);
  return {context,select:ids=>{context.ids=ids;handlers['nodes:selected'](ids);},click:event=>handlers['pointerclick.director-selection'](event)};
}

test('marquee selection never opens parameters; clicking a single component does',()=>{
  const {context,select,click}=selectionHandlers();
  select(['first','second']);
  assert.equal(context.selected,'');
  assert.equal(context.activeGenerationId,'');
  click({target:{id:()=> 'first'}});
  assert.equal(context.activeGenerationId,'');
  select(['first']);
  assert.equal(context.activeGenerationId,'');
  click({target:{id:()=> 'first'}});
  assert.equal(context.activeGenerationId,'first');
  select(['first','second']);
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
