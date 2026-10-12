import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const selectionColor='),source.indexOf('function cardKind(')),context);

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
