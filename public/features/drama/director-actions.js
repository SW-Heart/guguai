// One action contract for manual controls and the director. No generated code is executed.
export const directorActionTypes = ['design_story','add_resource','update_resource','add_shot','update_shot','generate_resource','generate_video','read_tail','check_continuity','assemble'];
export function normalizeDirectorWorkspace(value = {}) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { version:1, delegated:Boolean(object.delegated), autonomy:['assist','director','auto'].includes(object.autonomy)?object.autonomy:'director',
    positions:Object.fromEntries(Object.entries(object.positions||{}).filter(([id,p])=>id.length<200&&Number.isFinite(p?.x)&&Number.isFinite(p?.y)).slice(0,500).map(([id,p])=>[id,{x:Math.max(-100000,Math.min(100000,p.x)),y:Math.max(-100000,Math.min(100000,p.y))}])),
    viewport:{x:Number.isFinite(object.viewport?.x)?object.viewport.x:40,y:Number.isFinite(object.viewport?.y)?object.viewport.y:40,scale:Math.max(.1,Math.min(3,Number(object.viewport?.scale)||.75))},
    lockedIds:[...new Set((Array.isArray(object.lockedIds)?object.lockedIds:[]).map(String))].slice(0,500),
    messages:(Array.isArray(object.messages)?object.messages:[]).slice(-80).map(m=>({id:String(m.id||''),role:m.role==='user'?'user':'assistant',text:String(m.text||'').slice(0,10000)})),
    plan:object.plan && typeof object.plan==='object'?object.plan:null,
  };
}
export function validateDirectorPlan(value, project) {
  if (!value || typeof value.summary!=='string' || !Array.isArray(value.actions) || value.actions.length>80) throw new Error('导演返回了无效操作计划');
  const ids=new Set([...(project.resources||[]),...(project.shots||[])].map(x=>x.id));
  const locked=new Set(project.directorWorkspace?.lockedIds||[]);
  const actions=value.actions.map((a,index)=>{
    if(!directorActionTypes.includes(a.type))throw new Error(`不支持的导演操作：${a.type}`);
    const targetId=String(a.targetId||'');
    if(['update_resource','update_shot','generate_resource','generate_video','read_tail'].includes(a.type)&&!ids.has(targetId))throw new Error('导演引用了不存在的作品节点');
    if(locked.has(targetId))throw new Error('导演计划试图修改已锁定节点，请先调整目标或解除锁定');
    if(a.type==='design_story'&&locked.size)throw new Error('已有锁定内容，请使用局部修改，不能重建整个故事');
    return {id:`action-${index+1}`,type:a.type,targetId,label:String(a.label||a.type).slice(0,160),data:a.data&&typeof a.data==='object'&&!Array.isArray(a.data)?a.data:{},status:'queued',attempts:0};
  });
  return {id:globalThis.crypto.randomUUID(),summary:value.summary.slice(0,4000),actions,status:'proposed',createdAt:new Date().toISOString()};
}
export function applyDirectorEdit(project, action, id = () => globalThis.crypto.randomUUID()) {
  if(project.directorWorkspace?.lockedIds?.includes(action.targetId))throw new Error('此节点已锁定');
  const data=action.data||{};
  const fields=action.type.includes('resource')?['name','type','description','prompt','bible']:['title','script','prompt','promptOverride','duration','resourceIds','referenceAssetIds','generation','continuityNotes','narrativeFunction','startState','endState','sourceBeatIds','motionPlan','sceneId','shotSize','cameraMovement','sound'];
  const patch=Object.fromEntries(fields.filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]]));
  const key=action.type.includes('resource')?'resources':'shots';
  if(action.type.startsWith('add_'))project[key].push({id:id(),...patch});
  else {const item=project[key].find(x=>x.id===action.targetId);if(!item)throw new Error('作品节点不存在');if(patch.generation)patch.generation={...item.generation,...patch.generation};Object.assign(item,patch);}
  return {[key]:project[key]};
}
