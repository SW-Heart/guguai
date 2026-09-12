// Persist only inert canvas attributes, never executable HTML or application state.
function isMeaningfulRichText(node) {
 const html=typeof node?.$_htmlContent==='string'?node.$_htmlContent:(typeof node?.text==='string'?node.text:'');
 return html.replace(/<br\s*\/?>/gi,'').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;|&#xA0;/gi,' ').replace(/[\u200b-\u200d\ufeff]/g,'').trim().length>0;
}
export function normalizeCanvasNodes(nodes) {
 const allowed=new Set(['image','rect','rectangle','ellipse','circle','line','arrow','star','triangle','diamond','text','rich-text','path','brush','polygon']);
 const numeric=['x','y','width','height','scaleX','scaleY','rotation','strokeWidth','fontSize','opacity','radius','numPoints','innerRadius','outerRadius'];
 return (Array.isArray(nodes)?nodes:[]).slice(0,300).filter(n=>n&&typeof n.id==='string'&&n.id.length<200&&allowed.has(n.$_type)&&(n.$_type!=='rich-text'||isMeaningfulRichText(n))).map(n=>{
  const out={id:n.id,$_type:n.$_type};
  for(const key of numeric)if(Number.isFinite(n[key]))out[key]=Math.max(-100000,Math.min(100000,n[key]));
  for(const key of ['fill','stroke','text','fontFamily','align','data'])if(typeof n[key]==='string')out[key]=n[key].slice(0,20000);
  if(n.$_type==='rich-text'&&typeof n.$_htmlContent==='string')out.$_htmlContent=n.$_htmlContent.slice(0,20000).split(/(<[^>]*>)/g).map(part=>{
   const tag=part.match(/^<(\/)?(p|br|strong|em|u|s|span|ul|ol|li|h[1-6])(?:\s[^>]*)?\s*>$/i);
   return tag?`<${tag[1]||''}${tag[2].toLowerCase()}>`:part.replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }).join('');
  if(Array.isArray(n.points))out.points=n.points.filter(Number.isFinite).slice(0,10000);
  if(typeof n.$_imageUrl==='string'&&/^(https?:|blob:|data:image\/|\/|gugu-media:)/i.test(n.$_imageUrl))out.$_imageUrl=n.$_imageUrl.slice(0,2000000);
  if(n.$_type==='image'){out.brightness=0;out.$_applyBrightnessFilter=false;}
  return out;
 });
}
// One action contract for manual controls and the director. No generated code is executed.
export const directorActionTypes = ['design_story','add_resource','update_resource','add_shot','update_shot','generate_resource','generate_video','read_tail','check_continuity','assemble'];
export function normalizeDirectorWorkspace(value = {}) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { version:1, delegated:Boolean(object.delegated), autonomy:['assist','director','auto'].includes(object.autonomy)?object.autonomy:'director',
    canvasNodes:normalizeCanvasNodes(object.canvasNodes),
    hiddenIds:[...new Set((Array.isArray(object.hiddenIds)?object.hiddenIds:[]).map(String).filter(id=>id.length>0&&id.length<200))].slice(0,500),
    positions:Object.fromEntries(Object.entries(object.positions||{}).filter(([id,p])=>id.length<200&&Number.isFinite(p?.x)&&Number.isFinite(p?.y)).slice(0,500).map(([id,p])=>[id,{x:Math.max(-100000,Math.min(100000,p.x)),y:Math.max(-100000,Math.min(100000,p.y)),...Object.fromEntries(['width','height','scaleX','scaleY','rotation'].filter(k=>Number.isFinite(p[k])).map(k=>[k,Math.max(-100000,Math.min(100000,p[k]))]))}])),
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

export function fitDirectorViewport(nodes,width,height,padding=64) {
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return null;
 const points=[];
 for(const node of nodes){
  if(String(node.id).startsWith('edge-'))continue;
  const x=Number(node.x)||0,y=Number(node.y)||0,w=Number(node.width)||280,h=Number(node.height)||228;
  const sx=Number.isFinite(node.scaleX)?node.scaleX:1,sy=Number.isFinite(node.scaleY)?node.scaleY:1;
  const radians=(Number(node.rotation)||0)*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  for(const [dx,dy] of [[0,0],[w*sx,0],[0,h*sy],[w*sx,h*sy]])points.push([x+dx*c-dy*s,y+dx*s+dy*c]);
 }
 if(!points.length||points.some(p=>p.some(v=>!Number.isFinite(v))))return null;
 const minX=Math.min(...points.map(p=>p[0])),maxX=Math.max(...points.map(p=>p[0]));
 const minY=Math.min(...points.map(p=>p[1])),maxY=Math.max(...points.map(p=>p[1]));
 const margin=Math.min(padding,width/4,height/4);
 const scale=Math.max(.01,Math.min(1,(width-2*margin)/Math.max(1,maxX-minX),(height-2*margin)/Math.max(1,maxY-minY)));
 return {x:width/2-(minX+maxX)/2*scale,y:height/2-(minY+maxY)/2*scale,scale};
}
