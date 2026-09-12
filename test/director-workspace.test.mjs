import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDirectorWorkspace, validateDirectorPlan, applyDirectorEdit, fitDirectorViewport, persistCanvasSnapshot } from '../public/features/drama/director-actions.js';
const project=()=>({resources:[{id:'r1',name:'苏蔓',prompt:'original'}],shots:[{id:'s1',script:'这句台词必须保留',duration:8,videoVersions:['v1']}],directorWorkspace:normalizeDirectorWorkspace()});
test('director defaults and malformed viewport are bounded',()=>{
 const w=normalizeDirectorWorkspace({autonomy:'invalid',hiddenIds:['shot-1','shot-1',42,''],positions:{bad:{x:'bad',y:1}},viewport:{scale:100}});
 assert.equal(w.autonomy,'director');assert.equal(w.viewport.scale,3);assert.deepEqual(w.positions,{});assert.deepEqual(w.hiddenIds,['shot-1','42']);
});
test('plans reject unknown operations, invented IDs and locked changes',()=>{
 for(const a of [{type:'execute_js'},{type:'generate_video',targetId:'missing'}])assert.throws(()=>validateDirectorPlan({summary:'test',actions:[a]},project()));
 const p=project();p.directorWorkspace.lockedIds=['s1'];
 assert.throws(()=>validateDirectorPlan({summary:'test',actions:[{type:'update_shot',targetId:'s1'}]},p));
 assert.throws(()=>validateDirectorPlan({summary:'test',actions:[{type:'design_story'}]},p));
});
test('local and agent edits preserve dialogue and output versions',()=>{
 const p=project();applyDirectorEdit(p,{type:'update_shot',targetId:'s1',data:{duration:10,videoVersions:[],id:'bad'}});
 assert.equal(p.shots[0].duration,10);assert.equal(p.shots[0].script,'这句台词必须保留');assert.deepEqual(p.shots[0].videoVersions,['v1']);assert.equal(p.shots[0].id,'s1');
});
test('workspace persists generated task identity for resume',()=>{
 const p=project();const plan=validateDirectorPlan({summary:'生成角色图',actions:[{type:'generate_resource',targetId:'r1'}]},p);
 plan.actions[0].taskId='paid-job';plan.actions[0].status='running';
 const saved=normalizeDirectorWorkspace(JSON.parse(JSON.stringify({plan})));
 assert.equal(saved.plan.actions[0].taskId,'paid-job');
});
test('locks are checked again at execution time',()=>{
 const p=project();p.directorWorkspace.lockedIds=['r1'];
 assert.throws(()=>applyDirectorEdit(p,{type:'update_resource',targetId:'r1',data:{name:'changed'}}));
 assert.equal(p.resources[0].name,'苏蔓');
});

test('canvas image and annotation state survives project normalization without executable markup',()=>{
 const saved=normalizeDirectorWorkspace({canvasNodes:[
  {id:'image',$_type:'image',$_imageUrl:'/uploads/reference.png',width:280,height:180,brightness:1,$_htmlContent:'<script>bad()</script>'},
  {id:'arrow',$_type:'arrow',points:[0,0,120,80],stroke:'#5653cf'},
  {id:'unsafe',$_type:'html',$_htmlContent:'<script>bad()</script>'},
 ],positions:{image:{x:100,y:150,width:280,height:180,scaleX:1.5,scaleY:1.5,rotation:12}}});
 const restored=normalizeDirectorWorkspace(JSON.parse(JSON.stringify(saved)));
 assert.equal(restored.canvasNodes.length,2);
 assert.equal(restored.canvasNodes[0].$_imageUrl,'/uploads/reference.png');
 assert.equal(restored.canvasNodes[0].brightness,0);
 assert.equal(restored.canvasNodes[0].$_applyBrightnessFilter,false);
 assert.equal(restored.canvasNodes[0].$_htmlContent,undefined);
 assert.deepEqual(restored.canvasNodes[1].points,[0,0,120,80]);
 assert.equal(restored.positions.image.scaleX,1.5);
 assert.equal(restored.positions.image.rotation,12);
});

test('canvas state rejects invalid geometry and active image URLs',()=>{
 const saved=normalizeDirectorWorkspace({canvasNodes:[{id:'bad',$_type:'image',$_imageUrl:'javascript:alert(1)',x:Infinity,width:NaN}]});
 assert.equal(saved.canvasNodes[0].$_imageUrl,undefined);
 assert.equal(saved.canvasNodes[0].x,undefined);
 assert.equal(saved.canvasNodes[0].width,undefined);
});

test('canvas snapshot persists moved file coordinates and native canvas nodes',()=>{
 const workspace=normalizeDirectorWorkspace({positions:{file:{x:10,y:20}}});
 persistCanvasSnapshot(workspace,{viewport:{x:12,y:24,scale:.8},nodes:[
  {id:'file',$_type:'html',x:180,y:260,width:280,height:228},
  {id:'note',$_type:'rect',x:420,y:80,width:100,height:60},
  {id:'edge-note',$_type:'arrow',x:0,y:0,points:[0,0,1,1]},
 ]},new Set(['file']));
 assert.deepEqual(workspace.positions.file,{x:180,y:260,width:280,height:228});
 assert.deepEqual(workspace.positions.note,undefined);
 assert.deepEqual(workspace.canvasNodes,[{id:'note',$_type:'rect',x:420,y:80,width:100,height:60}]);
 assert.deepEqual(workspace.viewport,{x:12,y:24,scale:.8});
});

test('canvas snapshot keeps positions that are not present in a partial event',()=>{
 const workspace=normalizeDirectorWorkspace({positions:{file:{x:180,y:260},other:{x:40,y:80}}});
 persistCanvasSnapshot(workspace,{nodes:[{id:'file',$_type:'html',x:220,y:300}]},new Set(['file','other']));
 assert.deepEqual(workspace.positions,{file:{x:220,y:300},other:{x:40,y:80}});
});

test('canvas notes preserve text while stripping active markup attributes',()=>{
 const state=normalizeDirectorWorkspace({canvasNodes:[{id:'note',$_type:'rich-text',$_htmlContent:'<p onclick="bad()">镜头 <strong>一</strong></p><img src=x onerror=bad()>'}]});
 const html=state.canvasNodes[0].$_htmlContent;
 assert.ok(html.startsWith('<p>镜头 <strong>一</strong></p>'));
 assert.ok(!html.includes('<img'));
 assert.ok(!html.includes('onclick'));
 assert.deepEqual(normalizeDirectorWorkspace(state).canvasNodes,state.canvasNodes);
});

test('blank canvas text is not persisted',()=>{
 const state=normalizeDirectorWorkspace({canvasNodes:[
  {id:'blank',$_type:'rich-text',$_htmlContent:'<p><br></p>'},
  {id:'spaces',$_type:'rich-text',$_htmlContent:'<p>&nbsp; </p>'},
  {id:'note',$_type:'rich-text',$_htmlContent:'<p>有内容</p>'},
 ]});
 assert.deepEqual(state.canvasNodes.map(node=>node.id),['note']);
});


test('fit all keeps distant and negatively scaled cards inside the visible surface',()=>{
 const nodes=[{id:'a',x:-4200,y:2700,width:280,height:228},{id:'b',x:-3300,y:3300,width:280,height:228,scaleX:-1,scaleY:1.5}];
 const v=fitDirectorViewport(nodes,1000,700);
 for(const n of nodes)for(const [dx,dy] of [[0,0],[n.width*(n.scaleX??1),n.height*(n.scaleY??1)]]){
  const x=(n.x+dx)*v.scale+v.x,y=(n.y+dy)*v.scale+v.y;
  assert.ok(x>=63&&x<=937,`x outside view: ${x}`);
  assert.ok(y>=63&&y<=637,`y outside view: ${y}`);
 }
 assert.deepEqual(v,fitDirectorViewport([...nodes,{id:'edge-b',x:1e9,y:1e9}],1000,700));
});
test('fit all handles an unmeasured surface and rotated cards',()=>{
 assert.equal(fitDirectorViewport([],1000,700),null);
 assert.equal(fitDirectorViewport([{id:'a'}],0,0),null);
 const v=fitDirectorViewport([{id:'a',x:200,y:300,width:280,height:228,rotation:90}],1000,700);
 assert.ok(Number.isFinite(v.x)&&Number.isFinite(v.y)&&v.scale>0);
 assert.equal(v.x+(200-114)*v.scale,500);
 assert.equal(v.y+(300+140)*v.scale,350);
});
