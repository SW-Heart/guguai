import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDirectorWorkspace, validateDirectorPlan, applyDirectorEdit } from '../public/features/drama/director-actions.js';
const project=()=>({resources:[{id:'r1',name:'苏蔓',prompt:'original'}],shots:[{id:'s1',script:'这句台词必须保留',duration:8,videoVersions:['v1']}],directorWorkspace:normalizeDirectorWorkspace()});
test('director defaults and malformed viewport are bounded',()=>{
 const w=normalizeDirectorWorkspace({autonomy:'invalid',positions:{bad:{x:'bad',y:1}},viewport:{scale:100}});
 assert.equal(w.autonomy,'director');assert.equal(w.viewport.scale,3);assert.deepEqual(w.positions,{});
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
