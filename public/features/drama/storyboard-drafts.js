import { createCanvasGenerationDraft, reconcileCanvasGenerationDraft, canvasGenerationFrameSize } from './canvas-generation.js?v=13';
import { addGenerationReference } from './canvas-generation-references.js?v=4';

// Turns the agent's storyboard plans into ordinary canvas generation cards.
// Cards stay fully editable; a later plan revision only rewrites cards whose
// description the user has not changed and that have not been generated.
const kindLabels={character:'角色',location:'场景',prop:'道具'};
const ROW_GAP=96, CARD_GAP=32, ROW_LIMIT=8;

export const storyboardDraftId=(storyboardId,role,key)=>`canvas-gen-sb-${String(storyboardId).replace(/^sb-/,'')}-${role==='reference'?'r':'s'}-${key}`;

function referenceAspect(reference){
  return reference.aspect||(reference.kind==='location'?'16:9':'3:4');
}

function segmentDraft(storyboard,segment,config){
  const draft=createCanvasGenerationDraft('video',config);
  Object.assign(draft,{
    id:storyboardDraftId(storyboard.id,'segment',segment.key),prompt:segment.prompt,promptSegments:[],
    modelId:storyboard.video.modelId,aspect:storyboard.video.aspect,quality:storyboard.video.quality,mode:'TEXT',duration:segment.duration,
    title:`${segment.episode} · ${segment.title}`,
    source:{storyboardId:storyboard.id,key:segment.key,revision:storyboard.revision,role:'segment',name:'',prompt:segment.prompt,references:segmentReferenceNames(storyboard,segment),autoAttached:[]},
  });
  return reconcileCanvasGenerationDraft(draft,config);
}

function referenceDraft(storyboard,reference,config){
  const draft=createCanvasGenerationDraft('image',config);
  Object.assign(draft,{
    id:storyboardDraftId(storyboard.id,'reference',reference.key),prompt:reference.prompt,promptSegments:[],
    ...(storyboard.image?.modelId?{modelId:storyboard.image.modelId}:{}),...(storyboard.image?.quality?{quality:storyboard.image.quality}:{}),
    aspect:referenceAspect(reference),quantity:1,
    title:`${kindLabels[reference.kind]||'参考'} · ${reference.name}`,
    source:{storyboardId:storyboard.id,key:reference.key,revision:storyboard.revision,role:'reference',name:reference.name,prompt:reference.prompt,references:[],autoAttached:[]},
  });
  return reconcileCanvasGenerationDraft(draft,config);
}

function segmentReferenceNames(storyboard,segment){
  const byKey=new Map((storyboard.references||[]).map(reference=>[reference.key,reference]));
  return (segment.references||[]).map(key=>byKey.get(key)?.name).filter(Boolean);
}

// The real image behind a reference: an existing asset chosen by the agent, or
// the finished result of the reference card on this canvas.
function referenceFile(storyboard,name,drafts,{task,media}){
  const reference=(storyboard.references||[]).find(item=>item.name===name);
  if(!reference)return null;
  if(reference.assetId)return {id:reference.assetId,name,kind:'image',url:reference.url||''};
  const card=drafts.find(item=>item.id===storyboardDraftId(storyboard.id,'reference',reference.key));
  const result=card?.taskId?task(card.taskId):null;
  if(result?.status!=='completed'||!result.assetId)return null;
  return {id:result.assetId,name,kind:'image',url:media(card.taskId)?.url||''};
}

function attachReferences(draft,storyboard,drafts,config,lookups){
  if(draft.taskId||draft.source?.role!=='segment')return false;
  let changed=false;
  for(const name of draft.source.references||[]){
    const file=referenceFile(storyboard,name,drafts,lookups);
    if(!file||draft.source.autoAttached.includes(file.id))continue;
    // Remember the attempt even when the model refuses the file, so a card the
    // user cleared is not refilled on every refresh.
    draft.source.autoAttached=[...draft.source.autoAttached,file.id];
    changed=true;
    try{addGenerationReference(draft,file,config);}catch{}
  }
  if(changed)reconcileCanvasGenerationDraft(draft,config);
  return changed;
}

function layoutRows(rows,positions){
  const placed=Object.values(positions||{}).filter(item=>Number.isFinite(item?.x)&&Number.isFinite(item?.y));
  const left=placed.length?Math.min(...placed.map(item=>item.x)):0;
  let top=placed.length?Math.max(...placed.map(item=>item.y+(Number(item.height)||228)))+ROW_GAP*2:0;
  const result={};
  for(const row of rows){
    for(let start=0;start<row.length;start+=ROW_LIMIT){
      let x=left,height=0;
      for(const draft of row.slice(start,start+ROW_LIMIT)){
        const size=canvasGenerationFrameSize(draft.type,draft.aspect);
        result[draft.id]={x,y:top,...size};
        x+=size.width+CARD_GAP;height=Math.max(height,size.height);
      }
      top+=height+ROW_GAP;
    }
  }
  return result;
}

export function mergeStoryboardDrafts(workspace,storyboards,{config={},task=()=>null,media=()=>null,limit=200}={}){
  const drafts=workspace.generationDrafts||=[];
  const positions=workspace.positions||={};
  const lookups={task,media};
  const added=[],rows=[];
  let changed=false,skipped=0;
  for(const storyboard of Array.isArray(storyboards)?storyboards:[]){
    if(!storyboard?.id||!storyboard.video||!Array.isArray(storyboard.segments))continue;
    const fresh=[];
    const upsert=(id,create,update)=>{
      const existing=drafts.find(item=>item.id===id);
      if(!existing){
        if(drafts.length>=limit){skipped++;return;}
        const draft=create();drafts.push(draft);fresh.push(draft);added.push(id);changed=true;return;
      }
      if(!existing.source||existing.source.revision>=storyboard.revision)return;
      const untouched=!existing.taskId&&existing.prompt===existing.source.prompt;
      update(existing,untouched);
      existing.source.revision=storyboard.revision;
      changed=true;
    };
    for(const reference of storyboard.references||[]){
      if(reference.assetId)continue;
      upsert(storyboardDraftId(storyboard.id,'reference',reference.key),()=>referenceDraft(storyboard,reference,config),(draft,untouched)=>{
        draft.title=`${kindLabels[reference.kind]||'参考'} · ${reference.name}`;
        if(!untouched)return;
        Object.assign(draft,{prompt:reference.prompt,promptSegments:[]});draft.source.prompt=reference.prompt;
      });
    }
    for(const segment of storyboard.segments){
      upsert(storyboardDraftId(storyboard.id,'segment',segment.key),()=>segmentDraft(storyboard,segment,config),(draft,untouched)=>{
        draft.title=`${segment.episode} · ${segment.title}`;
        draft.source.references=segmentReferenceNames(storyboard,segment);
        if(!untouched)return;
        Object.assign(draft,{prompt:segment.prompt,promptSegments:[],modelId:storyboard.video.modelId,aspect:storyboard.video.aspect,quality:storyboard.video.quality,duration:segment.duration});
        draft.source.prompt=segment.prompt;
        reconcileCanvasGenerationDraft(draft,config);
      });
    }
    for(const draft of drafts)if(draft.source?.storyboardId===storyboard.id&&attachReferences(draft,storyboard,drafts,config,lookups))changed=true;
    if(fresh.length){
      const references=fresh.filter(draft=>draft.source.role==='reference');
      const episodes=new Map();
      for(const draft of fresh.filter(item=>item.source.role==='segment')){
        const episode=storyboard.segments.find(segment=>segment.key===draft.source.key)?.episode||'';
        if(!episodes.has(episode))episodes.set(episode,[]);
        episodes.get(episode).push(draft);
      }
      rows.push(...[references,...episodes.values()].filter(row=>row.length));
      Object.assign(positions,layoutRows(rows.splice(0),positions));
    }
  }
  return {changed,added,skipped};
}
