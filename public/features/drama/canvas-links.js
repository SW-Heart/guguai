// Canvas connections. A link always points from an upstream node to a
// generation node and means "use this as input": text becomes part of the
// description, pictures, videos and sound become references. Results of a
// generation node are linked to it through `parentId`, not through links.
export const LINK_LIMIT=500;
export const entityKinds={character:'角色',location:'场景',prop:'道具'};
const mediaNames={image:'图片',video:'视频',audio:'音频'};

export const linkId=(from,to)=>`link-${from}--${to}`;

export function normalizeLinks(value){
  const seen=new Set(),valid=id=>typeof id==='string'&&id.length>0&&id.length<200;
  return (Array.isArray(value)?value:[]).filter(link=>link&&valid(link.from)&&valid(link.to)&&link.from!==link.to).flatMap(link=>{
    const id=linkId(link.from,link.to);
    if(seen.has(id))return [];
    seen.add(id);return [{id,from:link.from,to:link.to}];
  }).slice(0,LINK_LIMIT);
}

export const isGenerator=draft=>Boolean(draft&&!draft.taskId);
export const isInlineGenerator=draft=>isGenerator(draft)&&!draft.entity&&draft.role!=='shot';
export const draftResults=(drafts,id)=>(drafts||[]).filter(item=>item.parentId===id&&item.taskId);
export function displayedResult(drafts,generator){
  if(!isInlineGenerator(generator))return null;
  const results=draftResults(drafts,generator.id);
  return results.find(item=>item.id===generator.primaryId)||results.at(-1)||null;
}
export const inputLinks=(links,id)=>(links||[]).filter(link=>link.to===id);

// What a generation node stands for when linked onward. A character, location
// or prop card uses its main picture (the first finished one until the user
// picks another); any other node uses its latest finished result.
export function primaryResult(drafts,generator,task){
  if(!generator)return null;
  const results=draftResults(drafts,generator.id);
  const done=item=>task(item.taskId)?.status==='completed';
  const chosen=results.find(item=>item.id===generator.primaryId&&done(item));
  return chosen||(generator.entity?results.find(done):results.findLast(done))||null;
}

export function generatorLabel(draft){
  if(draft?.entity?.name)return draft.entity.name;
  if(draft?.title)return draft.title;
  if(draft?.type==='audio'&&draft.speechMode==='design'&&draft.voiceName)return draft.voiceName;
  const prompt=String(draft?.prompt||'').replace(/\s+/g,' ').trim();
  return prompt?Array.from(prompt).slice(0,16).join(''):draft?.type==='audio'?(draft.speechMode==='design'?'音色设计':'语音生成'):draft?.type==='video'?'视频生成':'图像生成';
}

// Which inputs a generation node can take. Returns an error message or ''.
export function linkError(target,source){
  if(!isGenerator(target))return '只能连接到生成节点';
  if(!source)return '这个内容不能作为输入';
  if(source.id===target.id)return '不能连接到自身';
  if(source.kind==='text')return '';
  if(target.type==='audio')return target.speechMode!=='design'&&source.voiceId?'':'语音生成只能连接文字或已生成的音色';
  if(target.type==='image'&&source.kind!=='image')return '图像生成只能使用图片作为参考';
  if(!mediaNames[source.kind])return '这个内容不能作为输入';
  return '';
}

export function addLink(workspace,from,to){
  const links=workspace.links=normalizeLinks(workspace.links);
  const id=linkId(from,to);
  if(links.some(link=>link.id===id))return false;
  if(links.length>=LINK_LIMIT)throw new Error('画布连线数量已达上限');
  links.push({id,from,to});return true;
}

export function removeLinks(workspace,match){
  const before=(workspace.links||[]).length;
  workspace.links=(workspace.links||[]).filter(link=>!match(link));
  return workspace.links.length!==before;
}

// Resolve a generation node's inputs into one request draft. `describe(id)`
// returns {kind,label,text?,file?,pending?} for a canvas node. Two inputs that
// end up as the same file share one reference slot, so mentioning a character
// card and its chosen picture never uploads the picture twice.
export function resolveGenerationInputs(draft,links,describe){
  const texts=[],linked=[],missing=[];let voiceId='';
  for(const link of inputLinks(links,draft.id)){
    const source=describe(link.from);
    if(!source)continue;
    if(draft.type==='audio'&&source.voiceId){if(voiceId&&voiceId!==source.voiceId)throw new Error('每个配音节点只能选择一个音色');voiceId=source.voiceId;continue;}
    if(source.kind==='text'){const text=String(source.text||'').trim();if(text)texts.push({id:link.from,label:source.label,text});continue;}
    if(!source.file?.id){missing.push(source.label);continue;}
    linked.push({sourceId:link.from,label:source.label,file:source.file});
  }
  const attachments=[],aliases=new Map(),labels=new Set();
  const unique=label=>{let name=label||'参考素材',index=2;while(labels.has(name))name=`${label} ${index++}`;labels.add(name);return name;};
  for(const file of draft.attachments||[]){
    if(attachments.some(item=>item.id===file.id))continue;
    attachments.push({...file,name:unique(file.name)});aliases.set(file.id,file.id);
  }
  for(const item of linked){
    const existing=attachments.find(file=>file.id===item.file.id);
    if(existing){aliases.set(item.sourceId,existing.id);continue;}
    attachments.push({id:item.file.id,kind:item.file.kind,name:unique(item.label),url:item.file.url||''});
    aliases.set(item.sourceId,item.file.id);
  }
  return {texts,attachments,aliases,missing,voiceId};
}

// Build the draft that is actually submitted: linked text first, then the
// node's own description; mentions of linked nodes point at their files.
const joinSegments=segments=>segments.map(segment=>typeof segment==='string'?segment:`@${segment.label}`).join('');

export function generationRequestDraft(draft,inputs){
  const named=new Map(inputs.attachments.map(file=>[file.id,file.name]));
  const consistent=Array.isArray(draft.promptSegments)&&draft.promptSegments.length>0&&joinSegments(draft.promptSegments)===String(draft.prompt||'');
  // Mentions point at the resolved file; labels follow the request's names.
  const segments=consistent?draft.promptSegments.map(segment=>{
    if(typeof segment==='string')return segment;
    const id=inputs.aliases.get(segment.id)||segment.id;
    return {id,label:named.get(id)||segment.label};
  }):[];
  const own=consistent?joinSegments(segments):String(draft.prompt||'');
  const text=inputs.texts.map(item=>item.text).join('\n\n');
  const request={...draft,...(inputs.voiceId?{voiceId:inputs.voiceId}:{}),attachments:inputs.attachments,promptSegments:segments,prompt:own};
  if(!text)return request;
  if(!own.trim())return {...request,prompt:text,promptSegments:[text]};
  const prefix=`${text}\n\n`;
  return {...request,prompt:prefix+own,promptSegments:consistent?[prefix,...segments]:[]};
}

const overlaps=(a,b,gap)=>a.x<b.x+b.width+gap&&a.x+a.width>b.x-gap&&a.y<b.y+b.height+gap&&a.y+a.height>b.y-gap;

// Results line up in a column to the right of their generation node, skipping
// any space already taken by other content.
export function placeResults(parent,sizes,obstacles=[],gap=24,offset=96){
  const placed=[],taken=obstacles.filter(rect=>rect&&Number.isFinite(rect.x)&&Number.isFinite(rect.y)).map(rect=>({x:rect.x,y:rect.y,width:Number(rect.width)||280,height:Number(rect.height)||228}));
  const left=parent.x+(Number(parent.width)||280)+offset;
  for(const size of sizes){
    let rect=null;
    for(let column=0;column<20&&!rect;column++){
      const x=left+column*(size.width+offset);
      let y=parent.y;
      for(let step=0;step<200;step++){
        const candidate={x,y,width:size.width,height:size.height};
        const blocker=taken.find(item=>overlaps(candidate,item,gap));
        if(!blocker){rect=candidate;break;}
        y=blocker.y+blocker.height+gap;
        if(y>parent.y+4000)break;
      }
    }
    rect||={x:left,y:parent.y+(placed.length?placed.at(-1).y-parent.y+placed.at(-1).height+gap:0),width:size.width,height:size.height};
    placed.push(rect);taken.push(rect);
  }
  return placed;
}

// A smooth left-to-right curve between the right edge of `from` and the left
// edge of `to`, as Konva bezier points.
export function linkCurve(from,to){
  const x1=from.x+from.width,y1=from.y+from.height/2,x2=to.x,y2=to.y+to.height/2;
  const bend=Math.max(40,Math.min(240,Math.abs(x2-x1)/2+Math.abs(y2-y1)/6));
  return [x1,y1,x1+bend,y1,x2-bend,y2,x2,y2];
}

// Older canvases stored storyboard reference cards without an entity and let
// a finished picture replace the card. Turn them into a card that keeps its
// description plus a linked result beside it.
export function migrateCanvasDrafts(workspace,size=()=>({width:280,height:373})){
  const drafts=workspace.generationDrafts||[],positions=workspace.positions||={};
  const kinds=Object.fromEntries(Object.entries(entityKinds).map(([kind,label])=>[label,kind]));
  let changed=false;
  for(const draft of [...drafts]){
    if(!draft.entity&&draft.source?.role==='reference'&&draft.source.name){
      const kind=kinds[String(draft.title||'').split(' · ')[0]]||'character';
      draft.entity={kind,name:draft.source.name};changed=true;
    }
    if(draft.source?.role==='segment'&&!draft.role&&!draft.taskId){draft.role='shot';changed=true;}
    if(!draft.entity||!draft.taskId)continue;
    const id=draft.id.length<=107?`${draft.id}-r1`:`canvas-gen-${globalThis.crypto.randomUUID()}`;
    if(!drafts.some(item=>item.id===id)){
      const {source,entity,primaryId,title,...result}=draft;
      drafts.push({...result,id,attachments:[],parentId:draft.id});
      const parent=positions[draft.id];
      if(parent){
        const box=size(draft),obstacles=Object.entries(positions).filter(([key])=>key!==draft.id).map(([,rect])=>rect);
        positions[id]=placeResults({...box,...parent},[{width:parent.width||box.width,height:parent.height||box.height}],obstacles)[0];
      }
    }
    Object.assign(draft,{taskId:'',status:'',primaryId:id});
    changed=true;
  }
  return changed;
}

export const FOLD_AFTER=3;
// Ids of results that stay on the canvas while older ones are folded: the
// latest few, plus the main picture of a card.
export function foldedResults(drafts,generator,task){
  const results=draftResults(drafts,generator.id);
  if(isInlineGenerator(generator))return {folded:results.map(item=>item.id),total:results.length};
  if(generator.expanded||results.length<=FOLD_AFTER)return {folded:[],total:results.length};
  const keep=new Set(results.slice(-FOLD_AFTER).map(item=>item.id));
  const primary=generator.entity?primaryResult(drafts,generator,task):null;
  if(primary)keep.add(primary.id);
  return {folded:results.filter(item=>!keep.has(item.id)).map(item=>item.id),total:results.length};
}

// Card names are what @ mentions use, so they stay unique on the canvas.
export function uniqueEntityName(drafts,name,exceptId=''){
  const base=String(name||'').replace(/[@\r\n]/g,'').trim().slice(0,40)||'未命名';
  const taken=new Set((drafts||[]).filter(item=>item.entity&&item.id!==exceptId).map(item=>item.entity.name));
  if(!taken.has(base))return base;
  for(let index=2;;index++){const next=`${base.slice(0,36)} ${index}`;if(!taken.has(next))return next;}
}

// Rename a card and every mention of it in descriptions linked from it.
export function renameEntity(workspace,id,name){
  const drafts=workspace.generationDrafts||[];
  const card=drafts.find(item=>item.id===id);
  if(!card?.entity)return '';
  const previous=card.entity.name,next=uniqueEntityName(drafts,name,id);
  if(next===previous)return next;
  card.entity={...card.entity,name:next};
  const targets=new Set(normalizeLinks(workspace.links).filter(link=>link.from===id).map(link=>link.to));
  // Leave mentions of longer names alone, such as 外婆婆 when renaming 外婆.
  const longer=drafts.filter(item=>item.entity&&item.id!==id&&item.entity.name.startsWith(previous)&&item.entity.name!==previous).map(item=>item.entity.name);
  const replaceText=text=>{
    let result='',index=0;
    for(;;){
      const at=text.indexOf(`@${previous}`,index);
      if(at<0)return result+text.slice(index);
      const own=!longer.some(other=>text.startsWith(`@${other}`,at));
      result+=text.slice(index,at)+(own?`@${next}`:`@${previous}`);
      index=at+previous.length+1;
    }
  };
  for(const draft of drafts){
    if(!targets.has(draft.id))continue;
    if(Array.isArray(draft.promptSegments)&&draft.promptSegments.length){
      draft.promptSegments=draft.promptSegments.map(segment=>typeof segment==='string'?replaceText(segment):segment.id===id?{...segment,label:next}:segment);
      draft.prompt=draft.promptSegments.map(segment=>typeof segment==='string'?segment:`@${segment.label}`).join('');
    }else draft.prompt=replaceText(String(draft.prompt||''));
  }
  return next;
}

// What the assistant sees of a canvas: cards with their main picture, shots
// and generation nodes with their inputs, and text the user wrote.
export function summarizeCanvas(workspace,task=()=>null){
  const hidden=new Set(workspace.hiddenIds||[]);
  const drafts=(workspace.generationDrafts||[]).filter(item=>!hidden.has(item.id));
  const notes=(workspace.notes||[]).filter(item=>!hidden.has(item.id));
  const links=normalizeLinks(workspace.links).filter(link=>!hidden.has(link.from)&&!hidden.has(link.to));
  const names=new Map([...drafts.filter(item=>!item.taskId).map(item=>[item.id,generatorLabel(item)]),...notes.map(note=>[note.id,note.title||'文字'])]);
  const short=(text,max)=>{const value=String(text||'');return value.length>max?`${value.slice(0,max)}…`:value;};
  const inputs=id=>links.filter(link=>link.to===id).map(link=>names.get(link.from)||'画布素材');
  const assetOf=item=>item?task(item.taskId)?.assetId||'':'';
  const generators=drafts.filter(item=>!item.taskId);
  const common=item=>({id:item.id,prompt:short(item.prompt,2000),inputs:inputs(item.id),results:draftResults(drafts,item.id).length});
  return {
    cards:generators.filter(item=>item.entity).map(item=>({...common(item),kind:entityKinds[item.entity.kind],name:item.entity.name,mainAssetId:assetOf(primaryResult(drafts,item,task))})),
    shots:generators.filter(item=>!item.entity&&item.role==='shot').map(item=>({...common(item),title:item.title||'',duration:item.duration,aspect:item.aspect,latestAssetId:assetOf(primaryResult(drafts,item,task))})),
    generators:generators.filter(item=>!item.entity&&item.role!=='shot').map(item=>({...common(item),type:item.type==='audio'?'语音':item.type==='video'?'视频':'图像',latestAssetId:assetOf(primaryResult(drafts,item,task))})),
    notes:notes.map(note=>({id:note.id,kind:note.role==='script'?'剧本':'文字',title:note.title,text:short(note.text,4000),length:note.text.length})),
  };
}
