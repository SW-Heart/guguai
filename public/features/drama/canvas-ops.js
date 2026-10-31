// Edits the assistant makes to a canvas. The server prepares an edit (checks
// it and fills in ids and positions), applies it to the saved canvas and keeps
// it in a short log. Clients apply the same operations to their local canvas,
// and a save from a client that missed some edits gets them replayed first,
// so neither side overwrites the other.
import { normalizeLinks, linkId, linkError, isGenerator, isInlineGenerator, entityKinds, uniqueEntityName, renameEntity, placeResults } from './canvas-links.js?v=3';
import { canvasGenerationFrameSize } from './canvas-generation.js?v=24';

export const EDIT_LOG_LIMIT=50;
export const OPERATION_LIMIT=60;
const cardKinds=['character','location','prop','shot','image','video'];
const settingKeys=['modelId','aspect','quality','mode','duration','quantity'];
const NOTE_SIZE={width:400,height:360};

const typeOf=kind=>['shot','video'].includes(kind)?'video':'image';
const defaultAspect=kind=>kind==='location'?'16:9':kind==='prop'?'1:1':kind==='character'?'3:4':kind==='shot'||kind==='video'?'16:9':'1:1';
const text=(value,max)=>String(value??'').slice(0,max);
const line=(value,max)=>String(value??'').replace(/[\r\n]/g,' ').trim().slice(0,max);

function cleanSettings(value){
  const result={};
  for(const key of settingKeys){
    if(value?.[key]===undefined||value[key]===null||value[key]==='')continue;
    if(['duration','quantity'].includes(key)){const number=Number(value[key]);if(Number.isFinite(number))result[key]=Math.max(0,Math.min(key==='duration'?60:10,number));}
    else result[key]=line(value[key],100);
  }
  return result;
}

function rectOf(workspace,id){
  const rect=workspace.positions?.[id];
  return rect&&Number.isFinite(rect.x)&&Number.isFinite(rect.y)?{x:rect.x,y:rect.y,width:Number(rect.width)||280,height:Number(rect.height)||228}:null;
}

// New cards go beside the node they belong to, otherwise in a row below
// everything already on the canvas.
function placeCard(workspace,size,near,placed){
  const obstacles=[...Object.values(workspace.positions||{}),...placed];
  const anchor=near&&rectOf(workspace,near);
  if(anchor)return placeResults(anchor,[size],obstacles,32,64)[0];
  const rects=obstacles.filter(rect=>Number.isFinite(rect?.x)&&Number.isFinite(rect?.y));
  if(!rects.length)return {x:placed.length*(size.width+32),y:0,...size};
  const left=Math.min(...rects.map(rect=>rect.x));
  const bottom=Math.max(...Object.values(workspace.positions||{}).filter(rect=>Number.isFinite(rect?.y)).map(rect=>rect.y+(Number(rect.height)||228)),-Infinity);
  const row=placed.length?placed.at(-1):null;
  return row?{x:row.x+row.width+32,y:row.y,...size}:{x:left,y:(Number.isFinite(bottom)?bottom:0)+96,...size};
}

// Turn the assistant's requested operations into fully specified ones.
// `lookup(id)` describes ids that are not cards on this canvas, such as the
// assistant's documents or files: {kind:'text'|'image'|'video'|'audio',asset?:true}.
export function prepareCanvasEdit(canvas,operations,{uuid,lookup=()=>null}){
  const workspace=canvas.directorWorkspace,drafts=workspace.generationDrafts||[];
  if(!Array.isArray(operations)||!operations.length)throw new Error('请提供要修改的内容');
  if(operations.length>OPERATION_LIMIT)throw new Error(`一次最多修改 ${OPERATION_LIMIT} 项，请分批进行`);
  const locked=new Set(workspace.lockedIds||[]),hidden=new Set(workspace.hiddenIds||[]);
  const created=new Map(),placed=[],ready=[];
  const draftOf=id=>created.get(id)||drafts.find(item=>item.id===id&&!hidden.has(item.id));
  const noteOf=id=>created.get(id)||(workspace.notes||[]).find(item=>item.id===id&&!hidden.has(item.id));
  const editable=(id,what='这张卡片')=>{if(locked.has(id))throw new Error(`${what}已被锁定，不能修改`);};
  const generator=id=>{const draft=draftOf(id);if(!draft||!isGenerator(draft))throw new Error(`找不到可编辑的卡片「${id}」，请先用 canvas_read 读取`);editable(id);return draft;};
  const source=id=>{
    const draft=draftOf(id);if(draft)return {kind:draft.type};
    if(noteOf(id))return {kind:'text'};
    const other=lookup(id);if(other)return other;
    throw new Error(`找不到「${id}」，请先读取画布或素材`);
  };
  for(const input of operations){
    const type=input?.type;
    if(type==='create_card'){
      if(!cardKinds.includes(input.kind))throw new Error('卡片类型只能是角色、场景、道具、分镜、图像生成或视频生成');
      const id=`canvas-gen-${uuid()}`,settings=cleanSettings(input.settings);
      const aspect=settings.aspect||defaultAspect(input.kind);
      const op={type,id,kind:input.kind,prompt:text(input.prompt,10000),settings:{...settings,aspect}};
      if(entityKinds[input.kind])op.name=uniqueEntityName([...drafts,...created.values()],input.name||`${entityKinds[input.kind]} 1`);
      else if(input.title||input.kind==='shot')op.title=line(input.title||'分镜',80);
      op.position=placeCard(workspace,canvasGenerationFrameSize(typeOf(input.kind),aspect),input.near,placed);
      placed.push(op.position);
      created.set(id,{id,type:typeOf(input.kind),...(op.name?{entity:{kind:input.kind,name:op.name}}:{})});
      ready.push(op);continue;
    }
    if(type==='update_card'){
      const draft=generator(input.id),op={type,id:input.id};
      if(input.name!==undefined){if(!draft.entity)throw new Error('只有角色、场景、道具卡可以改名称');op.name=line(input.name,40);}
      if(input.title!==undefined)op.title=line(input.title,80);
      if(input.prompt!==undefined)op.prompt=text(input.prompt,10000);
      const settings=cleanSettings(input.settings);if(Object.keys(settings).length)op.settings=settings;
      if(Object.keys(op).length===2)throw new Error('请说明要修改卡片的哪些内容');
      ready.push(op);continue;
    }
    if(type==='create_text'){
      if((workspace.notes||[]).length+[...created.values()].filter(item=>item.note).length>=100)throw new Error('文字卡数量已达上限');
      const id=`canvas-note-${uuid()}`,role=input.role==='script'?'script':'text';
      const op={type,id,role,title:line(input.title||(role==='script'?'剧本':'文字'),160),text:text(input.text,60000)};
      op.position=placeCard(workspace,NOTE_SIZE,input.near,placed);placed.push(op.position);
      created.set(id,{id,note:true});ready.push(op);continue;
    }
    if(type==='update_text'){
      if(!noteOf(input.id))throw new Error('只能修改画布上的剧本和文字卡；你写的文字作品请用 documents_write 修改');
      editable(input.id,'这张文字卡');
      const op={type,id:input.id};
      if(input.title!==undefined)op.title=line(input.title,160);
      if(input.text!==undefined)op.text=text(input.text,60000);
      ready.push(op);continue;
    }
    if(type==='link'||type==='unlink'){
      const target=generator(input.to);
      if(type==='link'){
        const from=source(input.from),error=linkError(target,{...from,id:input.from});
        if(error)throw new Error(error);
        ready.push({type,from:input.from,to:input.to,...(from.asset?{asset:input.from}:{})});
      }else ready.push({type,from:input.from,to:input.to});
      continue;
    }
    if(type==='set_primary'){
      const result=drafts.find(item=>item.id===input.id&&item.taskId);
      const parent=result?.parentId&&draftOf(result.parentId);
      if(!parent?.entity)throw new Error('只能把角色、场景、道具卡生成的图片设为主图');
      editable(parent.id);ready.push({type,id:input.id});continue;
    }
    if(type==='move'){
      if(!Number.isFinite(Number(input.x))||!Number.isFinite(Number(input.y)))throw new Error('请提供卡片的新位置');
      editable(input.id);
      ready.push({type,id:line(input.id,200),x:Math.max(-100000,Math.min(100000,Number(input.x))),y:Math.max(-100000,Math.min(100000,Number(input.y)))});continue;
    }
    if(type==='delete'){
      const ids=[...new Set((Array.isArray(input.ids)?input.ids:[input.id]).filter(id=>typeof id==='string'&&id))].slice(0,100);
      if(!ids.length)throw new Error('请说明要删除哪些内容');
      ids.forEach(id=>editable(id,'这项内容'));
      ready.push({type,ids});continue;
    }
    throw new Error(`不支持的修改：${type||'未说明类型'}`);
  }
  return ready;
}

// Apply prepared operations. Shared by the server and every client, so it
// only depends on the operations and the canvas they are applied to.
export function applyCanvasOps(canvas,ops){
  const workspace=canvas.directorWorkspace;
  workspace.generationDrafts||=[];workspace.notes||=[];workspace.positions||={};workspace.hiddenIds||=[];
  const touched=new Set();
  const find=id=>workspace.generationDrafts.find(item=>item.id===id);
  for(const op of ops){
    if(op.type==='create_card'){
      if(find(op.id))continue;
      const settings=op.settings||{};
      workspace.generationDrafts.push({id:op.id,type:typeOf(op.kind),prompt:op.prompt||'',promptSegments:[],modelId:settings.modelId||'',aspect:settings.aspect||defaultAspect(op.kind),
        quality:settings.quality||'',mode:settings.mode||'',duration:settings.duration||0,quantity:settings.quantity||1,attachments:[],midjourney:{},taskId:'',status:'',
        ...(op.name?{entity:{kind:op.kind,name:op.name}}:{}),...(op.kind==='shot'?{role:'shot'}:{}),...(op.title?{title:op.title}:{})});
      workspace.positions[op.id]=op.position;touched.add(op.id);
    }else if(op.type==='update_card'){
      const draft=find(op.id);if(!draft)continue;
      if(op.name!==undefined&&draft.entity)renameEntity(workspace,op.id,op.name);
      if(op.title!==undefined)draft.title=op.title;
      if(op.prompt!==undefined){draft.prompt=op.prompt;draft.promptSegments=[];}
      Object.assign(draft,op.settings||{});
      touched.add(op.id);
    }else if(op.type==='create_text'){
      if(workspace.notes.some(note=>note.id===op.id))continue;
      workspace.notes.push({id:op.id,role:op.role,title:op.title,text:op.text,revision:1});
      workspace.positions[op.id]=op.position;touched.add(op.id);
    }else if(op.type==='update_text'){
      const note=workspace.notes.find(item=>item.id===op.id);if(!note)continue;
      if(op.title!==undefined)note.title=op.title;
      if(op.text!==undefined)note.text=op.text;
      note.revision=(note.revision||1)+1;touched.add(op.id);
    }else if(op.type==='link'){
      const links=workspace.links=normalizeLinks(workspace.links);
      if(!links.some(link=>link.from===op.from&&link.to===op.to))links.push({id:linkId(op.from,op.to),from:op.from,to:op.to});
      if(op.asset&&!canvas.assetIds?.includes(op.asset))canvas.assetIds=[...(canvas.assetIds||[]),op.asset];
      workspace.hiddenIds=workspace.hiddenIds.filter(id=>id!==op.from);
      touched.add(op.to);
    }else if(op.type==='unlink'){
      workspace.links=normalizeLinks(workspace.links).filter(link=>!(link.from===op.from&&link.to===op.to));
      touched.add(op.to);
    }else if(op.type==='set_primary'){
      const result=find(op.id),parent=result?.parentId&&find(result.parentId);
      if(parent){parent.primaryId=op.id;touched.add(parent.id);}
    }else if(op.type==='move'){
      const current=workspace.positions[op.id]||{};
      workspace.positions[op.id]={...current,x:op.x,y:op.y};touched.add(op.id);
    }else if(op.type==='delete'){
      workspace.hiddenIds=[...new Set([...workspace.hiddenIds,...op.ids])];
    }else if(op.type==='add_results'){
      for(const result of op.results){
        if(find(result.id))continue;
        workspace.generationDrafts.push({...result,promptSegments:[],attachments:[],midjourney:{},quantity:1});
        workspace.positions[result.id]=op.positions[result.id];touched.add(result.id);
      }
      const parent=find(op.parentId);
      if(parent?.entity&&!parent.primaryId&&op.results[0])parent.primaryId=op.results[0].id;
      if(isInlineGenerator(parent)&&op.results.length)parent.primaryId=op.results.at(-1).id;
      touched.add(op.parentId);
    }else if(op.type==='restore'){
      restore(canvas,op);
      Object.keys({...op.drafts,...op.notes,...op.positions}).forEach(id=>touched.add(id));
    }
  }
  return [...touched];
}

// The parts of a canvas an edit can change, keyed so a change can be undone
// item by item without touching anything else.
function parts(canvas){
  const workspace=canvas.directorWorkspace||{};
  const map=(list)=>Object.fromEntries((list||[]).map(item=>[item.id,JSON.stringify(item)]));
  return {
    drafts:map(workspace.generationDrafts),notes:map(workspace.notes),
    positions:Object.fromEntries(Object.entries(workspace.positions||{}).map(([id,rect])=>[id,JSON.stringify(rect)])),
    links:map(normalizeLinks(workspace.links)),
    hidden:Object.fromEntries((workspace.hiddenIds||[]).map(id=>[id,'1'])),
    assets:Object.fromEntries((canvas.assetIds||[]).map(id=>[id,'1'])),
  };
}

// A `restore` operation that puts back what changed between two canvases.
export function canvasRestoreFor(before,after){
  const a=parts(before),b=parts(after),op={type:'restore'};
  for(const key of Object.keys(a)){
    const changes={};
    for(const id of new Set([...Object.keys(a[key]),...Object.keys(b[key])])){
      if(a[key][id]===b[key][id])continue;
      changes[id]=a[key][id]===undefined?null:['hidden','assets'].includes(key)?true:JSON.parse(a[key][id]);
    }
    op[key]=changes;
  }
  return op;
}

function restore(canvas,op){
  const workspace=canvas.directorWorkspace;
  const put=(list,changes)=>{
    let result=[...(list||[])];
    for(const [id,value] of Object.entries(changes||{})){
      const index=result.findIndex(item=>item.id===id);
      if(value===null){if(index>=0)result.splice(index,1);}
      else if(index>=0)result[index]=value;
      else result.push(value);
    }
    return result;
  };
  workspace.generationDrafts=put(workspace.generationDrafts,op.drafts);
  workspace.notes=put(workspace.notes,op.notes);
  workspace.links=put(normalizeLinks(workspace.links),op.links);
  for(const [id,value] of Object.entries(op.positions||{})){if(value===null)delete workspace.positions[id];else workspace.positions[id]=value;}
  const flags=(list,changes)=>{const set=new Set(list||[]);for(const [id,value] of Object.entries(changes||{})){if(value)set.add(id);else set.delete(id);}return [...set];};
  workspace.hiddenIds=flags(workspace.hiddenIds,op.hidden);
  canvas.assetIds=flags(canvas.assetIds,op.assets);
}

// Bring a canvas up to date with the edit log.
export function replayCanvasEdits(canvas,edits){
  const workspace=canvas.directorWorkspace,from=Number(workspace.editSeq)||0;
  const pending=(edits||[]).filter(edit=>edit.seq>from).sort((a,b)=>a.seq-b.seq);
  const touched=new Set();
  for(const edit of pending){applyCanvasOps(canvas,edit.ops).forEach(id=>touched.add(id));workspace.editSeq=edit.seq;}
  return {applied:pending.length,touched:[...touched]};
}

// The log only keeps recent edits. A canvas older than the log cannot be
// brought up to date and should be replaced by the saved one.
export function canReplay(edits,editSeq){
  if(!edits?.length)return true;
  const oldest=Math.min(...edits.map(edit=>edit.seq));
  return (Number(editSeq)||0)>=oldest-1;
}
