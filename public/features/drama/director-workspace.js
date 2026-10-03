import { modelLogoMarkup } from '../../components/model-logo.js?v=1';
import { attachmentCardMarkup, mountAttachmentPreviews } from '../agent/attachment-preview.js?v=3';
import { mountGenerationApproval } from '../agent/generation-approval.js?v=2';
import { bindDirectorMentions } from './director-mentions.js?v=1';
import { importedImageBounds } from '../agent/image-bounds.js?v=1';
import { renderMarkdown, renderStreamingMarkdownBlocks } from '../agent/markdown.js?v=3';
import { copyButtonMarkup, mountContentCopy, patchCodeBlock } from '../agent/code-block.js?v=1';
import { createStreamPacer } from '../agent/stream-pacer.js?v=1';
import { createReasoningText, reasoningPhrases } from '../agent/reasoning-text.js?v=4';
import { createMessageScroller } from '../agent/message-scroller.js?v=2';
import { mediaFrameSize } from '../agent/frames.js?v=3';
import { placeCanvasNodes, focusCanvasViewport } from './canvas-layout.js?v=1';
import { createCreativeAgentClient } from '../agent/client.js?v=13';
import { projectLoadingMarkup } from '../agent/project-loading.js?v=1';
import { readCanvasSnapshot, writeCanvasSnapshot } from './local-snapshot.js?v=1';
import { mountReferenceCanvas } from '../../vendor/director/reference-canvas.js?v=32';
import { normalizeDirectorWorkspace, persistCanvasSnapshot, applyDirectorEdit, fitDirectorViewport } from './director-actions.js?v=11';
import { canvasGenerationModels, canvasGenerationOptions, canvasGenerationPayload, canvasGenerationRatios, canvasGenerationModeLabels, canvasGenerationModeDescriptions, canvasGenerationModelIcon, canvasGenerationQualityLabel, canvasGenerationFrameSize, createCanvasGenerationDraft, reconcileCanvasGenerationDraft } from './canvas-generation.js?v=6';
import { generationFrameState, renderGenerationPlaceholder } from './generation-status.js?v=2';
import { canvasIcon } from './canvas-icons.js?v=1';
import { agentLogoMarkup, agentWelcomeHeroMarkup, creativePresetsMarkup, bindCreativePresets } from '../agent/welcome.js?v=1';
import { mountModelPreferencePicker } from '../agent/model-preference-picker.js?v=5';
import { normalizeModelPreferences } from '../agent/model-preferences.js?v=1';

const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={queued:'等待制作',running:'制作中',completed:'已完成',succeeded:'已完成',failed:'失败',cancelled:'已取消',pending:'等待制作',processing:'生成中'};
// Canvas cards share one status palette with generation frames.
const cardTones={queued:'waiting',pending:'waiting',running:'active',processing:'active',completed:'done',succeeded:'done',failed:'danger',cancelled:'muted'};
const cardKinds={story:['book-open','剧本'],shot:['clapperboard','分镜'],document:['file-text','文字作品'],'source-observation':['film','原片分析'],'source-transcript':['captions','台词'],generation:['sparkles','生成作品']};
// The canvas engine paints selection in a stock blue and re-applies it on
// every selection change; keep its visible outline on the product accent.
const selectionColor='#6366f1';
function brandSelectionTransformer(transformer){
  if(!transformer||transformer.__guguBranded||typeof transformer.borderStroke!=='function')return;
  transformer.__guguBranded=true;
  const border=transformer.borderStroke.bind(transformer);
  transformer.borderStroke=(...args)=>args.length?border(args[0]==='transparent'?args[0]:selectionColor):border();
  border(transformer.borderStroke()==='transparent'?'transparent':selectionColor);
  transformer.anchorStroke?.(selectionColor);
  transformer.anchorFill?.('#ffffff');
  transformer.anchorCornerRadius?.(3);
  transformer.forceUpdate?.();
  transformer.getLayer?.()?.batchDraw?.();
}
function cardKind(n){
  if(n.kind==='resource')return ({character:['user-round','角色'],location:['map-pin','场景'],prop:['package','道具']})[n.item?.type]||['package','素材'];
  if(n.kind==='asset')return n.media?.kind==='audio'?['music','音频素材']:n.media?.kind==='video'?['video','参考素材']:['image','参考素材'];
  return cardKinds[n.kind]||['file-text','内容'];
}
const skillIcon='<span class="gugu-lucide gugu-lucide-book-open-check" aria-hidden="true"></span>';

function resizeAgentComposer(input) {
  if(!input)return;
  const minHeight=76,maxHeight=180;
  input.style.height='auto';
  input.style.height=`${input.value?Math.min(maxHeight,Math.max(minHeight,input.scrollHeight)):minHeight}px`;
  if(!input.value)input.scrollTop=0;
}

function messageAttachments(item) {
  if (item?.role !== 'user') return [];
  const files = item.attachments || item.images || [];
  return files.filter(Boolean).map((file,index)=>({...file,key:`${item.id}:${file.id || index}`,removable:false}));
}

function createConversationMessage(item, key) {
  const element=document.createElement('div');
  element.className=`dw-message ${item?.role==='user'?'user':'assistant'}`;
  element.dataset.messageId=key;
  const content=document.createElement('div');
  content.className='dw-message-content';
  updateMessageContent(content,item?.text??'',item?.role,messageAttachments(item));
  element.append(content);
  if(item?.role!=='user'){
    const actions=document.createElement('div');
    actions.className='dw-message-actions';
    actions.hidden=true;
    actions.setAttribute('role','group');
    actions.setAttribute('aria-label','回复操作');
    actions.setAttribute('aria-live','off');
    actions.innerHTML='<button type="button" data-response-action="copy" aria-label="复制回复" title="复制回复"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button type="button" data-response-feedback="up" aria-label="有帮助" title="有帮助" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v12H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h3Zm0 0 5-8a3 3 0 0 1 2 3v4h5a3 3 0 0 1 3 3l-1.2 7a3 3 0 0 1-3 3H7"/></svg></button><button type="button" data-response-feedback="down" aria-label="没有帮助" title="没有帮助" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14V2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3Zm0 0 5 8a3 3 0 0 0 2-3v-4h5a3 3 0 0 0 3-3l-1.2-7a3 3 0 0 0-3-3H7"/></svg></button>';
    element.append(actions);
  }
  return element;
}

function updateMessageContent(content,text,role,attachments=[]) {
  const signature=JSON.stringify(attachments);
  if(content._source===text&&content._role===role&&content._attachments===signature)return;
  content._source=text;content._role=role;content._attachments=signature;
  content.replaceChildren();
  if(role==='user'){
    if(attachments.length){
      const gallery=document.createElement('div');
      gallery.className='dw-message-attachments attachment-strip';
      gallery.setAttribute('aria-label','消息附件');
      gallery.innerHTML=attachments.map(attachmentCardMarkup).join('');
      content.append(gallery);
    }
    if(text){
      const messageText=document.createElement('div');
      messageText.className='dw-message-text';
      messageText.textContent=text;
      content.append(messageText);
    }
  }else content.innerHTML=renderMarkdown(text);
}

// Streaming replies change only at the tail, so finished blocks stay mounted
// and only the block still being written is replaced on each frame.
function patchStreamingContent(content,text) {
  if(content._role==='assistant-stream'&&content._source===text)return;
  if(content._role!=='assistant-stream')content.replaceChildren();
  content._source=text;content._role='assistant-stream';content._attachments='[]';
  const blocks=renderStreamingMarkdownBlocks(text),nodes=content.children;
  blocks.forEach((html,index)=>{
    const current=nodes[index];
    if(current?._html===html)return;
    const template=document.createElement('template');
    template.innerHTML=html;
    const next=template.content.firstElementChild;
    if(!next)return;
    if(patchCodeBlock(current,next)){current._html=html;return;}
    next._html=html;
    if(current)current.replaceWith(next);else content.append(next);
  });
  while(nodes.length>blocks.length)nodes[nodes.length-1].remove();
}

function createDraftMessage() {
  const node=createConversationMessage({role:'assistant'},'');
  node.classList.add('dw-message-draft');
  node.dataset.state='streaming';
  node.setAttribute('aria-busy','true');
  return node;
}

// Per-frame draft update: touches only the streaming message, not the history.
function updateConversationDraft(container,draft) {
  let draftNode=container.querySelector('.dw-message-draft');
  if(!draftNode){
    draftNode=createDraftMessage();
    container.insertBefore(draftNode,[...container.children].find(node=>node.classList.contains('dw-turn-activity'))||null);
  }
  patchStreamingContent(draftNode.querySelector('.dw-message-content'),String(draft));
}

function createConversationWelcome() {
  const welcome=document.createElement('div');
  welcome.className='dw-welcome';
  welcome.innerHTML=agentWelcomeHeroMarkup()+creativePresetsMarkup();
  return welcome;
}

// Keep finalized messages mounted while the assistant draft is streaming.
// Replacing the whole message panel on every poll restarts the user-message
// entrance animation and makes the user's bubble visibly flash.
function renderConversationMessages(container, items, draft='', status='complete', animateLatestActions=false, showActions=false, showWelcome=true) {
  container.dataset.state=status;
  container.setAttribute('aria-busy',String(status==='streaming'));
  const activity=container.querySelector('.dw-turn-activity');
  // Keep the status mounted so polling does not restart its animations.
  if(activity&&activity.parentNode!==container)container.append(activity);
  let history=container.querySelector('.dw-message-history');
  if(!history){history=document.createElement('div');history.className='dw-message-history';container.prepend(history);}
  const existing=new Map([...history.querySelectorAll('.dw-message[data-message-id]')].map(node=>[node.dataset.messageId,node]));
  if(!items.length){
    if(showWelcome){if(!history.querySelector('.dw-welcome'))history.replaceChildren(createConversationWelcome());}
    else history.replaceChildren();
  }else{
    history.querySelector('.dw-welcome')?.remove();
    const keys=new Set();
    items.forEach((item,index)=>{
      const key=String(item?.id??`message-${index}`);keys.add(key);
      const node=existing.get(key)||createConversationMessage(item,key);
      const className=`dw-message ${item?.role==='user'?'user':'assistant'}`;
      const text=String(item?.text??'');
      if(node.className!==className)node.className=className;
      updateMessageContent(node.querySelector('.dw-message-content'),text,item?.role,messageAttachments(item));
      const actions=node.querySelector('.dw-message-actions');
      if(actions){
        actions.dataset.copyText=text;
        const wasHidden=actions.hidden;
        actions.hidden=!showActions;
        if(wasHidden&&showActions)actions.dataset.enter=String(animateLatestActions&&index===items.length-1);
      }
      const current=history.children[index];
      if(current!==node)history.insertBefore(node,current||null);
    });
    existing.forEach((node,key)=>{if(!keys.has(key))node.remove();});
  }
  let draftNode=container.querySelector('.dw-message-draft');
  if(draft){
    if(!draftNode){draftNode=createDraftMessage();container.insertBefore(draftNode,activity||null);}
    patchStreamingContent(draftNode.querySelector('.dw-message-content'),String(draft));
  }else draftNode?.remove();
}

export function createDirectorWorkspace(host, bridge) {
  let canvas, canvasMount, projectId='', syncing=false, saveTimer, selected='', busy=false, stopped=false, epoch=0, draft='', layoutHistory=[], inspectorOpen=false;
  let chatMode='full',initialMessageSent=false;
  let emptyEntry=null,emptyEntrySession='',disposeEmptyEntry=null;
  let mainLayer, nativeTransformer, lastNodeGeometry='', edgeRenderFrame=0, resizingChat=false, resizeCanvasSnapshot=null, resizeFinishFrame=0;
  let streamFrame=0, streamSession='', visibleDraft='', targetDraft='', lastStreamTime=0, resizeObserver, mediaLoadObserver;
  // settlingMessageId: a finished reply whose remaining text is still being revealed.
  let streamPacer=createStreamPacer(), settlingMessageId='', messageScroller=null, reasoning=null;
  let agentClient, agentState=null, agentConfig=null, agentReady=false, sending=false, switchingConversation=false, skillUpdating=false, skillSelection=null, modelPreferencePicker=null, preferenceUpdating=false, connectionError='', conversations=[], historyOpen=false;
  let lastAgentCacheSignature='', generationApproval=null;
  let submissionQueue=[], drainingSubmissions=false;
  let attachments=[], documentAttachments=[], uploading=false, popoverEvents, attachmentPreviews, messagePreviews;
  let activeGenerationId='', generationUploading=false, generationSubmitting=false, generationCostSequence=0, generationCostTimer=0, generationMenu='', generationMenuLayer=null, generationMenuElement=null;
  const autoOpenedGenerations=new Set();
  const seenCanvasNodeIds=new Set(),pendingCanvasFocus=new Set(),automaticImageSizing=new Set();
  let canvasContentReady=false,canvasFocusFrame=0,mountedWorkspace=null,workspaceActive=false;
  const workspaceFrames=new Set();
  function queueWorkspaceFrame(callback){
    if(!workspaceActive)return 0;
    const token=epoch;
    const frame=requestAnimationFrame(time=>{
      workspaceFrames.delete(frame);
      if(token===epoch&&workspaceActive)callback(time);
    });
    workspaceFrames.add(frame);
    return frame;
  }
  function releaseWorkspaceMedia(scope){
    scope?.querySelectorAll('video,audio').forEach(media=>{
      media.pause();
      media.removeAttribute('src');
      media.removeAttribute('data-canvas-src');
      media.querySelectorAll('source').forEach(source=>source.removeAttribute('src'));
      media.load();
    });
  }

  const assetSizes=new Map(), assetSizeLoads=new Map(), assetImages=new Map();
  const get=()=>bridge.project();
  const workspace=()=>{const p=get();return p.directorWorkspace ||= normalizeDirectorWorkspace();};
  const save=async()=>{
    // Initial viewport/layout events are not edits. The saved session has not
    // arrived yet, so never persist that provisional canvas or show an error.
    if(bridge.agentMode&&!agentReady)return;
    const result=await bridge.patch({directorWorkspace:workspace()});if(!result)throw new Error('工作台状态未保存，请重试');
  };
  const message=text=>workspace().messages.push({id:crypto.randomUUID(),role:'assistant',text});
  const hiddenIds=()=>new Set(workspace().hiddenIds||[]);
  const canvasItems=()=>{const hidden=hiddenIds();return nodes().filter(item=>!hidden.has(item.id));};
  const revealCanvasItem=id=>{const hidden=hiddenIds();if(!hidden.delete(id))return false;workspace().hiddenIds=[...hidden];return true;};
  function markCanvasItemsHidden(ids) {
    const knownIds=new Set([...nodes().map(item=>item.id),...(workspace().canvasNodes||[]).map(item=>item.id)]);
    const deletedIds=[...new Set(ids)].filter(id=>knownIds.has(id)&&!String(id).startsWith('edge-'));
    if(deletedIds.length===0)return [];
    bridge.markCanvasDirty?.();
    const hidden=hiddenIds();
    deletedIds.forEach(id=>hidden.add(id));
    workspace().hiddenIds=[...hidden];
    deletedIds.forEach(id=>{if(workspace().positions)delete workspace().positions[id];});
    return deletedIds;
  }
  function handleCanvasDeleteKeydown(event) {
    if(!canvas||!['Delete','Backspace'].includes(event.key)||canvas.isEditingText)return;
    const target=event.target;
    if(target?.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    const canvasHost=host.querySelector('.dw-canvas');
    if(!canvasHost?.contains(target))return;
    const selectedIds=(canvas.getState?.().selectedNodeIds||[]).filter(Boolean);
    if(selectedIds.length===0)return;
    // The whiteboard emits `nodes:selected([])` before `nodes:deleted`. Mark
    // dynamic nodes hidden first so that the intermediate sync cannot recreate
    // a failed generation placeholder while the delete event is still pending.
    markCanvasItemsHidden(selectedIds);
    event.preventDefault();
    event.stopPropagation();
    const deleted=canvas.deleteNodes(selectedIds);
    if(Array.isArray(deleted)&&deleted.length)scheduleCanvasSave();
  }
  function nodes() {
    const p=get(),imported=bridge.imported(),importedIds=new Set(imported.map(file=>file.id));return [...(agentState?.documents||[]).map(d=>({id:d.id,kind:'document',title:d.title,text:d.text,item:d})),...(agentState?.sourceObservations||[]).map(o=>({id:`source-${o.assetId}`,kind:'source-observation',title:`原片分析 · ${o.assetName}`,text:o.overview||'已记录原片时间线',item:o})),...(agentState?.sourceTranscripts||[]).map(t=>({id:t.id,kind:'source-transcript',title:`台词 · ${t.assetName}`,text:t.text||'未识别到台词',item:t})),...(agentState?.generations||[]).map(g=>({id:g.canvasId||g.id,kind:'generation',title:g.title,text:'',taskId:g.id,item:g})),...(workspace().generationDrafts||[]).map(d=>({id:d.id,kind:'canvas-generation',title:d.type==='image'?'图像生成':'视频生成',text:d.prompt,taskId:d.taskId,item:d})),...imported.map(f=>({id:f.id,kind:'asset',title:f.name||'参考素材',text:'已导入素材',item:f,media:f})),...(agentState?.audioAssets||[]).filter(f=>!importedIds.has(f.id)).map(f=>({id:f.id,kind:'asset',title:f.name||'提取音频',text:'提取的音轨',item:f,media:f})),...(agentState?.composedAssets||[]).filter(f=>!importedIds.has(f.id)).map(f=>({id:f.id,kind:'asset',title:f.name||'复刻成片',text:'已合成视频',item:f,media:f})),...((p.synopsis?.trim()||p.script?.trim())?[{id:'story',kind:'story',title:'剧本',text:p.synopsis||p.script}]:[]),...p.resources.map(x=>({id:x.id,kind:'resource',title:x.name,text:x.description||x.prompt,item:x,taskId:x.selectedTaskId||x.versions?.at(-1)})),...p.shots.map((x,i)=>({id:x.id,kind:'shot',title:`${String(i+1).padStart(2,'0')} · ${x.title}`,text:x.script||x.prompt||'等待导演设计这一镜',item:x,taskId:x.selectedVideoTaskId||x.videoVersions?.at(-1)}))];
  }
  function hasSavedCanvasContent() {
    const hidden=hiddenIds();
    return nodes().some(node=>!hidden.has(node.id))||workspace().canvasNodes.some(node=>node&&!hidden.has(node.id));
  }
  function position(n,i) {
    const saved=workspace().positions[n.id];if(saved)return saved;
    if(['document','source-observation','source-transcript','generation','canvas-generation'].includes(n.kind))return {x:40+i*320,y:-460};
    if(n.kind==='asset'){const index=bridge.imported().findIndex(x=>x.id===n.id);return {x:40+(index>=0?index:i)*300,y:-140};}
    if(n.kind==='story')return {x:40,y:160};
    if(n.kind==='resource')return {x:360,y:40+get().resources.findIndex(x=>x.id===n.id)*260};
    const index=get().shots.findIndex(x=>x.id===n.id);return {x:700+Math.floor(index/3)*320,y:40+(index%3)*260};
  }
  function assetBounds(url,saved={}){
    const size=assetSizes.get(url);
    if(!size)return {width:saved.width||280,height:saved.height||220};
    if(typeof importedImageBounds==='function')return importedImageBounds(size,saved);
    const scale=Math.min(280/size.width,220/size.height,1);
    return {width:Math.max(24,size.width*scale),height:Math.max(24,size.height*scale)};
  }
  function paintAssetImage(id,url){
    const image=assetImages.get(url),shape=canvas?.getCanvasNodeById(id)?.getElement?.();
    if(!image||!shape?.image||canvas.getNodeConfigById(id)?.$_imageUrl!==url)return;
    shape.image(image);
    shape.clearCache();
    shape.getLayer()?.batchDraw();
  }
  function findLayerNode(id) {
    let found=null;
    mainLayer?.children?.forEach?.(node=>{if(!found&&node.id?.()===id)found=node;});
    return found;
  }
  function liveCanvasNodes(state=canvas?.getState?.()) {
    if(!state)return [];
    return (state.nodes||[]).map(node=>{
      // Konva owns the live geometry while a node is being dragged. The
      // whiteboard state is rebuilt on dragend and can therefore still carry
      // the previous coordinates when this callback runs.
      const shape=canvas?.getCanvasNodeById?.(node.id)?.getElement?.()||findLayerNode(node.id);
      const attrs=shape?.getAttrs?.();
      return attrs?{...node,
        x:attrs.x??node.x,y:attrs.y??node.y,width:attrs.width??node.width,height:attrs.height??node.height,
        scaleX:attrs.scaleX??node.scaleX,scaleY:attrs.scaleY??node.scaleY,rotation:attrs.rotation??node.rotation,
      }:node;
    });
  }
  function loadAssetSize(id,url){
    if(assetSizes.has(url)||assetSizeLoads.has(url))return;
    const token=epoch;
    const image=new Image();
    assetSizeLoads.set(url,image);
    image.onload=()=>{
      if(token!==epoch)return;
      assetSizeLoads.delete(url);
      if(!image.naturalWidth||!image.naturalHeight)return;
      assetImages.set(url,image);
      assetSizes.set(url,{width:image.naturalWidth,height:image.naturalHeight});
      // A viewport/selection event may already have persisted placeholder
      // dimensions. Correct every node sharing this URL after decoding.
      // Image decoding is asynchronous; read the live Konva geometry so a
      // completed load cannot restore a stale pre-drag position.
      const targets=liveCanvasNodes().filter(node=>node.id===id||node.$_imageUrl===url);
      if(!targets.length){
        const fallback=canvas?.getNodeConfigById?.(id);
        if(fallback)targets.push(fallback);
      }
      let changed=false;
      for(const current of targets){
        if(current?.$_type!=='image'||current.$_imageUrl!==url)continue;
        // Fresh images initially reserve a box. Decode into that box instead
        // of growing a portrait image through the neighboring components.
        const automatic=automaticImageSizing.has(current.id);
        const bounds=assetBounds(url,automatic?{}:current);
        if(automatic){
          const dx=((Number(current.width)||bounds.width)-bounds.width)*(current.scaleX??1)/2;
          const dy=((Number(current.height)||bounds.height)-bounds.height)*(current.scaleY??1)/2;
          const radians=(Number(current.rotation)||0)*Math.PI/180;
          bounds.x=(Number(current.x)||0)+dx*Math.cos(radians)-dy*Math.sin(radians);
          bounds.y=(Number(current.y)||0)+dx*Math.sin(radians)+dy*Math.cos(radians);
        }
        automaticImageSizing.delete(current.id);
        if(Math.abs((Number(current.width)||0)-bounds.width)<=.5&&Math.abs((Number(current.height)||0)-bounds.height)<=.5){paintAssetImage(current.id,url);continue;}
        const saved=workspace().positions[current.id]||{};
        workspace().positions[current.id]={...saved,x:current.x,y:current.y,...bounds};
        const previousSyncing=syncing;syncing=true;
        try{canvas.updateNodes([current.id],bounds);}finally{syncing=previousSyncing;}
        paintAssetImage(current.id,url);
        changed=true;
      }
      if(changed){
        globalThis.clearTimeout?.(saveTimer);
        saveTimer=globalThis.setTimeout?.(()=>{if(token===epoch)void save().catch(e=>bridge.toast(e.message));},600);
      }
    };
    image.onerror=()=>assetSizeLoads.delete(url);
    if(!url.startsWith('gugu-media://'))image.crossOrigin='anonymous';
    image.src=url;
  }
  function nodeContent(n) {
    const captionTrack=assetId=>assetId&&agentState?.id&&(agentState.sourceTranscripts||[]).some(item=>item.assetId===assetId&&item.cues?.length)?`<track kind="subtitles" src="/api/agent/sessions/${encodeURIComponent(agentState.id)}/captions/${encodeURIComponent(assetId)}.vtt" srclang="zh" label="台词" default>`:'';
    if(n.kind==='canvas-generation'){
      const draft=n.item,task=draft.taskId?bridge.task(draft.taskId):null,media=draft.taskId?bridge.media(draft.taskId):null;
      const status=task?.status||draft.status||'draft';
      const state=generationFrameState(status,Boolean(media));
      const caption=String(draft.prompt||'').trim()||n.title;
      return `<div class="dw-generation-frame dw-manual-frame" data-state="${escape(state)}" data-kind="${escape(draft.type)}" aria-label="${escape(caption)}">${media?`<${media.kind==='video'?'video controls playsinline preload="none"':'img'} data-canvas-src="${escape(media.url)}" ${media.kind==='image'?`alt="${escape(caption)}"`:''}>${media.kind==='video'?'</video>':''}`:renderGenerationPlaceholder(state,{kind:draft.type,progress:task?.progress})}<span class="dw-frame-caption">${escape(caption)}</span></div>`;
    }
    if(n.kind==='asset'&&n.media?.kind==='image')return '';
    if(n.kind==='asset'&&n.media?.kind==='video')return `<div class="dw-generation-frame dw-imported-video" data-state="completed"><video controls playsinline preload="none" data-canvas-src="${escape(n.media.url)}" aria-label="${escape(n.title)}">${captionTrack(n.media.id)}</video><span class="dw-frame-caption">${escape(n.title)}</span></div>`;
    if(n.kind==='asset'&&n.media?.kind==='audio')return `<div class="dw-generation-frame dw-imported-audio" data-state="completed"><span class="dw-audio-head"><span class="dw-audio-icon" aria-hidden="true">${canvasIcon('music')}</span><span class="dw-audio-name">${escape(n.title)}</span></span><audio controls preload="none" data-canvas-src="${escape(n.media.url)}" aria-label="${escape(n.title)}"></audio><span class="dw-frame-caption">${escape(n.title)}</span></div>`;
    if(n.kind==='generation'){
      const task=bridge.task(n.taskId),media=bridge.media(n.taskId);
      const status=n.item.placeholder?n.item.status:task?.status||'queued';
      const state=generationFrameState(status,Boolean(media));
      return `<div class="dw-generation-frame" data-state="${escape(state)}" aria-label="${escape(n.title)}">${media?`<${media.kind==='video'?'video controls playsinline preload="none"':'img'} data-canvas-src="${escape(media.url)}" ${media.kind==='image'?`alt="${escape(n.title)}"`:''}>${media.kind==='video'?'</video>':''}`:renderGenerationPlaceholder(state,{kind:n.item.type,progress:task?.progress})}<span class="dw-frame-caption">${escape(n.title)}</span></div>`;
    }
    const t=bridge.task(n.taskId);const media=n.media||bridge.media(n.taskId);const action=workspace().plan?.actions?.find(a=>a.targetId===n.id&&['running','failed'].includes(a.status));
    const status=action?labels[action.status]:t?(labels[t.status]||t.status):n.kind==='asset'?'已导入':['source-observation','source-transcript'].includes(n.kind)?'已记录':n.kind==='story'&&get().script?'已设计':'待制作';
    const locked=workspace().lockedIds.includes(n.id);
    const [kindIcon,kindLabel]=cardKind(n);
    const rawStatus=action?.status||t?.status||'';
    const tone=locked?'locked':cardTones[rawStatus]||(status==='待制作'?'idle':'done');
    const progress=tone==='active'&&Number(t?.progress)>0?Math.min(99,Math.round(Number(t.progress))):null;
    const name=['source-observation','source-transcript'].includes(n.kind)?(n.item.assetName||n.title):n.title;
    const meta=n.kind==='shot'?`${n.item.duration} 秒 · ${n.item.aspectRatio} · ${n.item.videoVersions?.length||0} 个版本`:n.kind==='source-observation'?`${n.item.eventCount} 条记录 · 第 ${n.item.revision} 版`:n.kind==='source-transcript'?`${n.item.wordCount} 个词 · ${Math.round(n.item.startSeconds)}–${Math.round(n.item.endSeconds)} 秒`:n.kind==='document'?`第 ${n.item.revision} 版`:'';
    const body=media?`<${media.kind==='video'?'video controls preload="none"':'img'} data-canvas-src="${escape(media.url)}" ${media.kind==='image'?`alt="${escape(name)}"`:''} class="dw-node-media" >${media.kind==='video'?'</video>':''}`:`<p class="dw-node-copy">${escape(n.text)}</p>`;
    const statusText=locked?'已锁定':`${status}${progress===null?'':` ${progress}%`}`;
    return `<div class="dw-node-content${selected===n.id?' is-selected':''}" data-node-id="${escape(n.id)}" data-kind="${escape(n.kind)}" data-tone="${tone}"><header class="dw-node-head"><span class="dw-node-kind">${canvasIcon(kindIcon)}<span>${kindLabel}</span></span><span class="dw-node-status" data-tone="${tone}" role="status">${locked?canvasIcon('lock'):'<i class="dw-node-dot" aria-hidden="true"></i>'}<span>${escape(statusText)}</span></span></header><b class="dw-node-name">${escape(name)}</b>${body}${meta?`<footer class="dw-node-meta">${escape(meta)}</footer>`:''}${progress===null?'':`<progress class="dw-node-progress" max="100" value="${progress}" aria-label="制作进度"></progress>`}</div>`;
  }
  function nodeBounds(node) {
    const width=Math.max(1,Number(node?.width)||280)*(Number(node?.scaleX)||1);
    const height=Math.max(1,Number(node?.height)||228)*(Number(node?.scaleY)||1);
    return {width,height};
  }
  function edgePoints(from,to) {
    const a=nodeBounds(from), b=nodeBounds(to);
    const fromRight=(Number(from.x)||0)+a.width;
    const fromMid=(Number(from.y)||0)+a.height/2;
    const toLeft=Number(to.x)||0;
    const toMid=(Number(to.y)||0)+b.height/2;
    return [fromRight,fromMid,toLeft,toMid];
  }
  function edgeLinks() {
    const ns=canvasItems();
    return ns.filter(n=>['resource','shot'].includes(n.kind)).map(n=>({from:n.kind==='resource'?'story':(n.item.resourceIds?.find(id=>ns.some(x=>x.id===id))||'story'),to:n.id})).filter(edge=>ns.some(n=>n.id===edge.from));
  }
  function liveCanvasSnapshot(fallback=null) {
    const state=fallback||canvas?.getState?.();
    if(!state)return null;
    const currentNodes=liveCanvasNodes(state);
    return {...state,nodes:currentNodes.length?currentNodes:(state.nodes||[])};
  }
  function persistLiveCanvasState(snapshot=liveCanvasSnapshot()) {
    if(bridge.agentMode&&!agentReady)return null;
    if(!snapshot)return null;
    persistCanvasSnapshot(workspace(),snapshot,new Set(nodes().map(item=>item.id)));
    return snapshot;
  }
  function scheduleCanvasSave(immediate=false) {
    clearTimeout(saveTimer);
    if(bridge.agentMode&&!agentReady)return;
    if(immediate){
      void save().catch(e=>bridge.toast(e.message));
      return;
    }
    saveTimer=setTimeout(()=>{if(get()?.id===projectId)void save().catch(e=>bridge.toast(e.message));},600);
  }
  function renderEdges(snapshotNodes=canvas?.getState().nodes||[], persist=false) {
    if(!canvas||!mainLayer)return;
    const byId=new Map(snapshotNodes.map(node=>[node.id,node]));
    const updates=[];
    edgeLinks().forEach(link=>{
      const from=byId.get(link.from),to=byId.get(link.to);
      if(!from||!to)return;
      const points=edgePoints(from,to),id=`edge-${link.to}`,shape=findLayerNode(id);
      if(shape?.points)shape.points(points);
      updates.push({id,points});
    });
    mainLayer.batchDraw?.();
    if(!persist)return;
    updates.forEach(({id,points})=>{if(canvas.getNodeConfigById(id))canvas.updateNodes([id],{points});});
  }
  function scheduleEdgeRender() {
    if(edgeRenderFrame)return;
    edgeRenderFrame=queueWorkspaceFrame(()=>{edgeRenderFrame=0;renderEdges(liveCanvasNodes());});
  }
  function alignCard(id,html,geometryOnly=false) {
    const node=canvas.getCanvasNodeById(id),element=node?.htmlElement,shape=node?.getElement?.();
    if(!element||!shape)return;
    if(html!==undefined&&element.dataset.content!==html){releaseWorkspaceMedia(element);element.innerHTML=html;element.dataset.content=html;}
    if(!geometryOnly)element.querySelectorAll('[data-canvas-src]').forEach(media=>{
      if(mediaLoadObserver)mediaLoadObserver.observe(media);
      else {media.src=media.dataset.canvasSrc;delete media.dataset.canvasSrc;if(media.tagName==='VIDEO')media.preload='metadata';}
    });
    // HtmlNode already synchronizes this element from getClientRect() on
    // viewport/drag/transform events. Do the same here when content changes. Applying
    // getAbsoluteTransform() as a CSS matrix on top of the core's left/top
    // writes double-applies the viewport translation, making cards jump away
    // from their Konva hit rectangle while dragging.
    const rect=shape.getClientRect();
    Object.assign(element.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`,transformOrigin:'0 0',transform:'none'});
    if(!geometryOnly)element.querySelectorAll('video').forEach(video=>{
      // Forward gestures on the picture to Konva; reserve the bottom 48 CSS
      // pixels for native playback controls (their shadow DOM is opaque).
      if(video.dataset.canvasPlayback)return;
      video.dataset.canvasPlayback='true';
      ['pointerdown','mousedown','touchstart','wheel','click','dblclick','keydown','keyup'].forEach(type=>video.addEventListener(type,event=>{
        event.stopPropagation();
        const point=event.touches?.[0]||event;
        const rect=video.getBoundingClientRect();
        const onPicture=Number.isFinite(point.clientY)&&point.clientY<rect.bottom-48;
        if(onPicture&&['pointerdown','mousedown','touchstart','wheel'].includes(type)){
          const surface=canvas.getStage().content;
          const forwarded=type==='wheel'
            ? new event.constructor('wheel',{
              deltaX:event.deltaX,
              deltaY:event.deltaY,
              deltaZ:event.deltaZ,
              deltaMode:event.deltaMode,
              clientX:event.clientX,
              clientY:event.clientY,
              screenX:event.screenX,
              screenY:event.screenY,
              ctrlKey:event.ctrlKey,
              shiftKey:event.shiftKey,
              altKey:event.altKey,
              metaKey:event.metaKey,
            })
            : new event.constructor(type,event);
          surface.dispatchEvent(forwarded);
          if(type!=='pointerdown')event.preventDefault();
        }else if(type==='pointerdown'&&selected!==id){
          canvas.selectNodes([id]);
        }
        if(onPicture&&(type==='click'||type==='dblclick'))event.preventDefault();
      },{passive:false}));
    });
    const frame=element.querySelector('.dw-generation-frame');
    if(frame&&!geometryOnly){
      const media=frame.querySelector('img,video');
      if(media){
        const measure=()=>{
          const width=media.naturalWidth||media.videoWidth,height=media.naturalHeight||media.videoHeight;
          if(!width||!height)return;
          const p=workspace().positions[id];if(!p||p.manualSize)return;
          const nextWidth=Math.min(p.width,(p.height||320)*width/height),nextHeight=nextWidth*height/width;
          if(Math.abs(p.height-nextHeight)>.5||Math.abs(p.width-nextWidth)>.5){
            p.width=nextWidth;p.height=nextHeight;
            const previousSyncing=syncing;syncing=true;
            try{canvas.updateNodes([id],{width:nextWidth,height:nextHeight});}finally{syncing=previousSyncing;}
            alignCard(id);clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save().catch(e=>bridge.toast(e.message)),600);
          }
        };
        media.onload=measure;media.onloadedmetadata=measure;if(media.complete||media.readyState>=1)measure();
      }
    }
    // Keep the HTML overlay aligned with the Konva hit rectangle, then scale
    // the card's own content as a single unit. In particular, the placeholder
    // text inside a generation frame must follow the canvas zoom as well.
    const readDimension=(owner,key,fallback)=>{
      const value=owner?.[key],number=typeof value==='function'?value.call(owner):value;
      const result=Number(number);
      return Number.isFinite(result)&&result>0?result:fallback;
    };
    const config=canvas.getNodeConfigById?.(id)||{};
    element.style.visibility=config.visible===false?'hidden':'visible';
    const baseWidth=readDimension(shape,'width',readDimension(config,'width',280));
    const baseHeight=readDimension(shape,'height',readDimension(config,'height',228));
    const scaleX=Math.abs(readDimension(shape,'scaleX',readDimension(config,'scaleX',1)));
    const scaleY=Math.abs(readDimension(shape,'scaleY',readDimension(config,'scaleY',1)));
    const logicalWidth=Math.max(1,baseWidth*scaleX),logicalHeight=Math.max(1,baseHeight*scaleY);
    const content=element.firstElementChild;
    if(content){
      if(frame)Object.assign(content.style,{width:`${logicalWidth}px`,height:`${logicalHeight}px`});
      // Cards have a fixed 280 x 228 layout. Scale that entire layout with
      // the Konva rectangle; frame content instead grows to its live size.
      const contentWidth=frame?logicalWidth:280;
      const contentHeight=frame?logicalHeight:228;
      Object.assign(content.style,{transformOrigin:'0 0',transform:`scale(${rect.width/contentWidth},${rect.height/contentHeight})`});
    }
  }
  function syncCanvasOverlayVisibility(snapshot=canvas?.getState?.()) {
    if(!canvas)return;
    (snapshot?.nodes||[]).forEach(node=>{
      if(node?.$_type!=='html')return;
      const element=canvas.getCanvasNodeById?.(node.id)?.htmlElement;
      if(element)element.style.visibility=node.visible===false?'hidden':'visible';
    });
  }
  function alignCards(){if(!canvas)return;nodes().forEach(n=>alignCard(n.id));}
  function fitCanvas(ids){
    if(!canvas)return;
    const surface=canvas.getContainer();
    const list=canvas.getState().nodes.filter(n=>!String(n.id).startsWith('edge-')&&(!ids||ids.includes(n.id)));
    const viewport=fitDirectorViewport(list,surface.clientWidth,surface.clientHeight);
    if(viewport){canvas.updateViewport(viewport);queueWorkspaceFrame(alignCards);}
  }
  function canvasView(){
    const surface=canvas.getContainer();
    return {viewport:canvas.getState().viewport,width:surface.clientWidth,height:surface.clientHeight};
  }
  function focusNewCanvasContent(ids){
    ids.forEach(id=>pendingCanvasFocus.add(id));
    if(canvasFocusFrame)return;
    const token=epoch;
    canvasFocusFrame=queueWorkspaceFrame(()=>{
      canvasFocusFrame=0;
      const ids=new Set(pendingCanvasFocus);pendingCanvasFocus.clear();
      if(token!==epoch||!canvas||!ids.size)return;
      if(bridge.agentMode&&chatMode!=='side'){chatMode='side';drawPanels();}
      const viewport=focusCanvasViewport(canvas.getState().nodes.filter(node=>ids.has(node.id)),canvasView());
      if(viewport){canvas.updateViewport(viewport);workspace().viewport=viewport;alignCards();positionGenerationComposer();scheduleCanvasSave();}
    });
  }
  function handleCreatedCanvasNodes(created){
    if(!Array.isArray(created))return;
    const fresh=created.filter(node=>!seenCanvasNodeIds.has(node.id)&&!String(node.id).startsWith('edge-')&&!node.$_parentId);
    created.forEach(node=>seenCanvasNodeIds.add(node.id));
    if(syncing||!canvasContentReady||!fresh.length)return;
    // Annotations attached to an image and connecting arrows retain their
    // drawn geometry; independent components and pasted media are arranged.
    const movable=fresh.filter(node=>!['arrow','line','brush','image-marker'].includes(node.$_type));
    const ids=new Set(movable.map(node=>node.id));
    const placements=placeCanvasNodes(movable,{},liveCanvasNodes().filter(node=>!ids.has(node.id)),canvasView());
    syncing=true;
    try{Object.entries(placements).forEach(([id,position])=>canvas.updateNodes([id],position));}
    finally{syncing=false;}
    persistLiveCanvasState();scheduleCanvasSave();focusNewCanvasContent(fresh.map(node=>node.id));
  }
  function canvasItemSize(node){
    if(node.kind==='generation')return mediaFrameSize(node.item);
    if(node.kind==='canvas-generation')return canvasGenerationFrameSize(node.item.type,node.item.aspect);
    if(node.kind==='asset'&&node.media?.kind==='image'){
      if(node.media.width>0&&node.media.height>0)return importedImageBounds(node.media);
      return assetBounds(node.media.url);
    }
    if(node.kind==='asset'&&node.media?.kind==='video'&&node.media.width>0&&node.media.height>0)return mediaFrameSize(node.media);
    return {width:280,height:228};
  }
  async function importAssetIntoCanvas(){
    try{
      const file=await bridge.importAsset();
      if(!file)return;
      revealCanvasItem(file.id);
      if(canvas){
        syncCanvas();
        canvas.selectNodes([file.id]);
        focusNewCanvasContent([file.id]);
        await save();
      }
    }catch(e){bridge.toast(e.message);}
  }
  function syncCanvas() {
    if(bridge.agentMode&&!agentReady)return;
    if(!canvas||syncing)return;syncing=true;
    const ns=canvasItems();const existing=new Map(canvas.getState().nodes.map(n=>[n.id,n]));
    const additions=[];
    const newItems=ns.filter(node=>!existing.has(node.id)).map(node=>({id:node.id,...canvasItemSize(node)}));
    const placements=placeCanvasNodes(newItems,workspace().positions,liveCanvasNodes(),canvasView());
    ns.filter(node=>placements[node.id]&&node.kind==='asset'&&node.media?.kind==='image').forEach(node=>automaticImageSizing.add(node.id));
    if(Object.keys(placements).length){Object.assign(workspace().positions,placements);clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save().catch(e=>bridge.toast(e.message)),600);}
    const links=edgeLinks();
    const valid=new Set([...ns.map(n=>n.id),...links.map(l=>`edge-${l.to}`)]);
    canvas.deleteNodes([...existing.keys()].filter(id=>!valid.has(id)&&(id.startsWith('edge-')||id.startsWith('canvas-gen-')||['director','video','director-asset'].includes(existing.get(id).$_actualType))));
    ns.forEach((n,i)=>{
      const old=existing.get(n.id);const pos=position(n,i);
      if(old&&placements[n.id])canvas.updateNodes([n.id],placements[n.id]);
      if(n.kind==='asset'&&n.media?.kind==='image'){
        const url=old?.$_type==='image'?old.$_imageUrl:n.media?.url;
        if(!url)return;
        loadAssetSize(n.id,url);
        const bounds=assetBounds(url,pos);
        // Replace the old custom HTML card in place.  Keeping the project id
        // as the canvas id means selections and saved positions remain stable.
        if(old && (old.$_type!=='image'||old.$_imageUrl!==url)){
          canvas.deleteNodes([n.id]);
          additions.push({id:n.id,$_type:'image',$_actualType:'director-asset',$_imageUrl:url,brightness:0,$_applyBrightnessFilter:false,...pos,...bounds,draggable:true});
        }else if(!old){
          additions.push({id:n.id,$_type:'image',$_actualType:'director-asset',$_imageUrl:url,brightness:0,$_applyBrightnessFilter:false,...pos,...bounds,draggable:true});
        }else if(old.$_applyBrightnessFilter!==false||old.brightness!==0){
          // The Konva image node owns live drag/transform coordinates. The
          // workspace position is only the last persisted snapshot, so
          // writing x/y here during agent polling snaps an active gesture
          // back to stale coordinates.
          canvas.updateNodes([n.id],{brightness:0,$_applyBrightnessFilter:false});
        }
        paintAssetImage(n.id,url);
        return;
      }
      const html=nodeContent(n);
      const media=n.media||bridge.media(n.taskId);
      const actualType=media?.kind==='video'?'video':media?.kind==='image'?'image':'director';
      const mediaAttrs=media?.kind==='image'&&media.url?{$_imageUrl:media.url}:{};
      if(!old)additions.push({id:n.id,$_type:'html',$_actualType:actualType,...mediaAttrs,$_htmlContent:html,fill:'rgba(255,255,255,0.001)',strokeEnabled:false,width:280,height:228,...pos,draggable:true});
      else if(old.$_type==='html'&&(old.$_htmlContent!==html||old.$_actualType!==actualType||old.$_imageUrl!==mediaAttrs.$_imageUrl))canvas.updateNodes([n.id],{$_actualType:actualType,...mediaAttrs,$_htmlContent:html,fill:'rgba(255,255,255,0.001)',strokeEnabled:false});
      if(old)alignCard(n.id,html);
    });
    if(additions.length){
      canvas.createNodes(additions,false);
      additions.forEach(node=>seenCanvasNodeIds.add(node.id));
      additions.forEach(node=>{
        if(node.$_type==='image')paintAssetImage(node.id,node.$_imageUrl);
        else alignCard(node.id,node.$_htmlContent);
      });
    }
    links.forEach(l=>{const from=canvas.getNodeConfigById(l.from),to=canvas.getNodeConfigById(l.to);if(!from||!to)return;const id=`edge-${l.to}`;const config={id,$_type:'arrow',x:0,y:0,points:edgePoints(from,to),stroke:'#9b99c9',fill:'#9b99c9',strokeWidth:1.5,pointerLength:6,pointerWidth:6,$_listening:false};if(existing.has(id))canvas.updateNodes([id],config);else canvas.createNodes([config],false);canvas.moveNodesToBottom([id]);});
    syncing=false;
    renderEdges(canvas.getState().nodes);
    if(canvasContentReady){const fresh=additions.filter(node=>!existing.has(node.id));if(fresh.length)focusNewCanvasContent(fresh.map(node=>node.id));}
    canvasContentReady=true;
  }
  function syncEdges(snapshotNodes=canvas?.getState().nodes||[]) {
    renderEdges(snapshotNodes,true);
  }
  function clearEmptyEntry(){
    disposeEmptyEntry?.();disposeEmptyEntry=null;
    emptyEntry?.remove();emptyEntry=null;emptyEntrySession='';
  }
  function drawConversationEntry(root){
    if(!bridge.agentMode)return true;
    // Until the saved session arrives, never paint a provisional empty chat.
    const ready=agentReady&&Boolean(canvas);
    root.style.visibility=ready?'':'hidden';
    root.inert=!ready;
    let loading=host.querySelector('[data-conversation-loading]');
    if(!ready){
      if(!loading){loading=document.createElement('div');loading.className='agent-project-loading agent-conversation-loading';loading.dataset.conversationLoading='';loading.setAttribute('role','status');host.append(loading);}
      const error=agentReady?'':connectionError;
      const signature=error||'loading';
      if(loading.dataset.loadingState!==signature){
        loading.dataset.loadingState=signature;
        loading.classList.toggle('is-opening',!error);
        loading.setAttribute('aria-busy',String(!error));
        loading.setAttribute('aria-live','polite');
        if(error){
          loading.textContent=error;
          const retry=document.createElement('button');retry.type='button';retry.textContent='重新加载';retry.onclick=()=>{const token=epoch;connectionError='';drawPanels();void agentClient.start().catch(error=>{if(token!==epoch)return;connectionError=error.message;drawPanels();});};loading.append(retry);
        }else loading.innerHTML=projectLoadingMarkup;
      }
      return false;
    }
    loading?.remove();
    if(emptyEntrySession&&emptyEntrySession!==agentState.id)clearEmptyEntry();
    const empty=!(agentState.messages||[]).length&&!agentState.draft&&!['queued','running','waiting_job'].includes(agentState.state);
    if(!empty)clearEmptyEntry();
    if(empty&&chatMode==='full'&&!emptyEntry&&bridge.renderEmptyConversation&&!bridge.hasInitialContent?.()&&!sending){
      emptyEntry=document.createElement('div');emptyEntry.className='agent-conversation-entry';root.append(emptyEntry);
      emptyEntrySession=agentState.id;
      const token=epoch,session=agentState.id;
      disposeEmptyEntry=bridge.renderEmptyConversation(emptyEntry,{config:agentConfig,skill:agentState.settings?.skill||'',modelPreferences:agentState.settings?.modelPreferences,onModelPreferencesChange:async value=>{
        if(token!==epoch||session!==agentState?.id||switchingConversation)throw new Error('对话已切换，请重新选择');
        preferenceUpdating=true;drawPanels();
        try{await agentClient.settings({modelPreferences:value});}
        finally{if(token===epoch){preferenceUpdating=false;drawPanels();}}
      },onSubmit:async(text,files,documents,skill,modelPreferences)=>{
        if(token!==epoch||session!==agentState?.id||switchingConversation)return;
        if(!agentConfig?.configured)throw new Error('对话功能暂时无法使用，请稍后再试');
        skillUpdating=true;
        try{
          if(skill!==(agentState.settings?.skill||''))await agentClient.settings({skill});
          if(token!==epoch||session!==agentState?.id)return;
          await submit(text,files,[],documents,modelPreferences);
        }finally{if(token===epoch){skillUpdating=false;drawPanels();}}
      }});
    }
    const visible=Boolean(emptyEntry)&&chatMode==='full';
    disposeEmptyEntry?.updateModelPreferences?.(agentState.settings?.modelPreferences);
    root.classList.toggle('has-conversation-entry',visible);
    if(emptyEntry){emptyEntry.hidden=!visible;emptyEntry.inert=switchingConversation;}
    return true;
  }
  function drawPanels() {
    const root=host.querySelector('.director-workspace');
    const messages=root?.querySelector('.dw-messages');
    if(!root||!messages)return;
    if(!drawConversationEntry(root))return;
    if(bridge.agentMode){
      const activeGenerations=(agentState?.generations||[]).filter(frame=>{
        const task=frame.placeholder?null:bridge.task(frame.id);
        return ['queued','running','processing','waiting_job'].includes(task?.status||frame.status);
      });
      const hasNewActiveGeneration=activeGenerations.some(frame=>!autoOpenedGenerations.has(frame.id));
      activeGenerations.forEach(frame=>autoOpenedGenerations.add(frame.id));
      if(hasNewActiveGeneration&&chatMode==='full')chatMode='side';
      if(chatMode==='full')closeGenerationMenu(false);
      root.classList.toggle('agent-home',chatMode==='full');
      root.classList.toggle('agent-empty',chatMode==='full'&&!(agentState?.messages||[]).length);
      root.classList.toggle('agent-collapsed',chatMode==='minimized');
      root.querySelector('[data-show-agent]')?.toggleAttribute('hidden',chatMode!=='minimized');
      const toggle=root.querySelector('[data-agent-canvas]');
      if(toggle){
        const label=chatMode==='full'?'显示画布':'放大对话';
        toggle.innerHTML=`<span class="gugu-lucide ${chatMode==='full'?'gugu-lucide-minimize-2':'gugu-lucide-maximize-2'}" aria-hidden="true"></span>`;
        toggle.setAttribute('aria-label',label);toggle.dataset.tooltip=label;
      }
      const hideToggle=root.querySelector('[data-hide-agent]');
      if(hideToggle){
        const label=chatMode==='minimized'?'打开对话':'收起对话';
        hideToggle.innerHTML=`<span class="gugu-lucide ${chatMode==='minimized'?'gugu-lucide-message-circle':'gugu-lucide-minus'}" aria-hidden="true"></span>`;
        hideToggle.setAttribute('aria-label',label);hideToggle.dataset.tooltip=label;
      }
      const selectedSkill=skillSelection??agentState?.settings?.skill??'';
      const skillChip=root.querySelector('[data-selected-skill]');
      if(skillChip){const item=agentConfig?.skills?.find(skill=>skill.name===selectedSkill);skillChip.hidden=!selectedSkill;skillChip.querySelector('span:not(.gugu-lucide)').textContent=item?.title||selectedSkill;skillChip.querySelector('[data-agent-skill-remove]').setAttribute('aria-label',`移除${item?.title||'所选创作方式'}`);skillChip.querySelector('[data-agent-skill-remove]').disabled=skillUpdating||switchingConversation;}
      const skillTrigger=root.querySelector('[data-agent-skill-trigger]');
      if(skillTrigger){skillTrigger.disabled=!agentReady||skillUpdating||switchingConversation||!agentConfig?.skills?.length;skillTrigger.setAttribute('aria-pressed',String(Boolean(selectedSkill)));}
      root.querySelectorAll('[data-agent-skill-option]').forEach(option=>option.setAttribute('aria-checked',String(option.dataset.agentSkillOption===selectedSkill)));
    }
    busy=['queued','running','waiting_job'].includes(agentState?.state);
    const models=agentConfig?.models||[];
    const modelButton=root.querySelector('[data-agent-model-toggle]');
    const currentModel=agentState?.settings?.model;
    // A running generation is not a conversation lock.  `sending` only
    // describes the short request that adds a message to the queue; the
    // composer must remain usable while the agent is thinking or waiting for
    // a media task.
    const conversationBusy=drainingSubmissions||switchingConversation;
    modelPreferencePicker?.update({value:agentState?.settings?.modelPreferences,scope:agentState?.id||'',disabled:!agentReady||conversationBusy||skillUpdating||preferenceUpdating});
    modelButton?.setAttribute('title',`切换模型：${models.find(m=>m.id===currentModel)?.label||'正在加载'}`);
    if(modelButton)modelButton.disabled=!agentReady||conversationBusy||!models.length;
    const modelList=root.querySelector('[data-agent-model-list]');
    const options=models.map(m=>`<button type="button" data-agent-model="${escape(m.id)}" aria-pressed="${m.id===currentModel}" ${conversationBusy?'disabled':''}>${escape(m.label)}${m.id===currentModel?'<span aria-hidden="true">✓</span>':''}</button>`).join('');
    if(modelList&&modelList.innerHTML!==options)modelList.innerHTML=options;
    const uploadButton=root.querySelector('[data-agent-upload]');
    if(uploadButton){uploadButton.disabled=!agentReady||uploading||switchingConversation;uploadButton.title=uploading?'正在上传…':bridge.agentMode?'添加文件':'上传文件';}
    attachmentPreviews?.update([
      ...attachments.map(file=>({...file,key:`media:${file.id}`,removeDisabled:sending||switchingConversation})),
      ...documentAttachments.map((file,index)=>({...file,key:`document:${file.id||index}`,kind:'document',removeDisabled:sending||switchingConversation})),
    ],{uploading});
    const newButton=root.querySelector('[data-agent-new]');
    if(newButton)newButton.disabled=conversationBusy||skillUpdating||preferenceUpdating||!agentReady;
    const historyButton=root.querySelector('[data-agent-history]');
    historyButton?.toggleAttribute('disabled',!agentReady||preferenceUpdating);
    root.querySelector('[data-agent-retry]')?.toggleAttribute('hidden',!connectionError);
    const history=root.querySelector('.dw-conversations');

    historyButton?.setAttribute('aria-expanded',String(historyOpen));
    if(historyOpen&&history){
      history.innerHTML=`<div class="dw-history-heading"><strong>历史对话</strong><span>${conversations.length} 条</span></div>`+(conversations.length?conversations.map(c=>`<button type="button" data-conversation="${escape(c.id)}" aria-current="${c.id===agentState?.id}" ${conversationBusy?'disabled':''}><span>${escape(c.title)}</span><small>${escape(new Date(c.updatedAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'}))}${['running','queued','waiting_job'].includes(c.state)?' · 进行中':''}</small></button>`).join(''):'<p>还没有历史对话</p>');
      history.querySelectorAll('[data-conversation]').forEach(button=>button.onclick=()=>void switchConversation(button.dataset.conversation));
    }
    const auto=root.querySelector('[data-agent-auto]');
    if(auto&&document.activeElement!==auto)auto.checked=Boolean(agentState?.settings.autoGenerate);
    const budget=root.querySelector('[data-agent-budget]');
    if(budget&&document.activeElement!==budget)budget.value=String((agentState?.settings.generationBudgetMicro||0)/1000000);
    const status=root.querySelector('.dw-mode-help');
    // While the agent works, the animated status line replaces the plain text;
    // pauses, confirmations and errors keep the readable static message.
    const working=busy&&agentReady&&!connectionError;
    reasoning?.update({active:working,phrases:reasoningPhrases({activity:agentState?.activity,streaming:Boolean(agentState?.draft)})});
    if(status){status.textContent=working?'':connectionError||agentState?.activity||'';status.setAttribute('role','status');}
    root.querySelector('[data-director-stop]')?.toggleAttribute('hidden',!busy||!agentReady);
    root.querySelector('[data-director-delegate]')?.toggleAttribute('hidden',!agentReady||agentState?.state!=='paused');
    const items=(agentState?.messages||[]).map(item=>item.role==='user'&&bridge.messageAttachment
      ? {...item,attachments:(item.attachments||item.images||[]).map(file=>bridge.messageAttachment(file)||file)} : item);
    messagePreviews?.update(items.flatMap(messageAttachments));
    const sessionChanged=streamSession!==agentState?.id;
    if(sessionChanged){
      cancelAnimationFrame(streamFrame);streamFrame=0;visibleDraft='';targetDraft='';streamSession=agentState?.id;
      // Preserve the activity element while replacing the conversation history.
      const activity=messages.querySelector('.dw-turn-activity');
      if(activity)messages.append(activity);
      messages.querySelector('.dw-message-history')?.remove();messages.querySelector('.dw-message-draft')?.remove();
    }
    const previousResponseState=sessionChanged?'complete':messages.dataset.state;
    targetDraft=agentState?.draft||'';
    if(sessionChanged)streamPacer.reset();
    // When a reply finishes, its saved message replaces the live draft. Keep
    // revealing the remaining text in place so the ending does not pop in.
    const lastItem=items.at(-1),lastText=String(lastItem?.text??'');
    if(!targetDraft&&!sessionChanged&&visibleDraft&&lastItem?.role==='assistant'&&lastText.startsWith(visibleDraft)&&(settlingMessageId===String(lastItem.id)||(!settlingMessageId&&lastText!==visibleDraft)))settlingMessageId=String(lastItem.id);
    else settlingMessageId='';
    if(settlingMessageId)targetDraft=lastText;
    const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    streamPacer.update(targetDraft,{done:Boolean(settlingMessageId)||!busy,immediate:sessionChanged||reducedMotion});
    visibleDraft=streamPacer.text;
    if(!targetDraft){cancelAnimationFrame(streamFrame);streamFrame=0;lastStreamTime=0;}
    const responseState=connectionError?'error':busy||Boolean(targetDraft)?'streaming':'complete';
    const responseJustFinished=previousResponseState==='streaming'&&responseState!=='streaming';
    const showWelcome=!bridge.agentMode||(!items.length&&!targetDraft&&!busy&&!sending&&!bridge.hasInitialContent?.()&&chatMode!=='full');
    renderConversationMessages(messages,settlingMessageId?items.slice(0,-1):items,visibleDraft,responseState,responseJustFinished,agentState?.state==='completed',showWelcome);
    messageScroller?.refresh({reset:sessionChanged});
    if(targetDraft&&!streamFrame)streamFrame=queueWorkspaceFrame(animateDraft);
    generationApproval?.update(agentReady?agentState?.approval:null);
    updateSendAvailability();
    const composer=root.querySelector('#directorMessage');
    if(composer)composer.placeholder=busy?'生成进行中也可以继续补充创作要求':bridge.agentMode?'写下你的想法，GuGu 会和你一起完成……':'想聊什么，或希望我帮你创作什么？';
    if(!host.querySelector('.dw-inspector')?.contains(document.activeElement))drawInspector();
    syncCanvas();
    positionGenerationComposer();
  }
  function animateDraft(time) {
    streamFrame=0;
    const messages=host.querySelector('.dw-messages');
    if(!messages||!targetDraft)return;
    const elapsed=Math.min(64,Math.max(0,lastStreamTime?time-lastStreamTime:16));lastStreamTime=time;
    if(streamPacer.advance(elapsed)){visibleDraft=streamPacer.text;updateConversationDraft(messages,visibleDraft);messageScroller?.refresh();}
    if(!streamPacer.caughtUp){streamFrame=queueWorkspaceFrame(animateDraft);return;}
    lastStreamTime=0;
    if(settlingMessageId){
      // The finished reply is fully shown; hand it over to the saved message.
      settlingMessageId='';streamPacer.reset();visibleDraft='';targetDraft='';
      drawPanels();
    }
  }
  async function agentAction(action){const token=epoch,session=agentState?.id;try{await action();if(token!==epoch||session!==agentState?.id)return;connectionError='';}catch(error){if(token!==epoch||session!==agentState?.id)return;if(!error.stale){connectionError=error.message;bridge.toast(error.message);}}drawPanels();}
  function updateSendAvailability(){
    const button=host.querySelector('[data-director-send]');if(!button)return;
    const hasSkill=bridge.agentMode&&Boolean(skillSelection??agentState?.settings?.skill);
    const hasContent=Boolean(host.querySelector('#directorMessage')?.value.trim()||attachments.length||documentAttachments.length||hasSkill);
    button.disabled=!agentReady||uploading||switchingConversation||skillUpdating||preferenceUpdating||!agentState||!agentConfig?.configured||!hasContent;
    const label=busy?'补充要求':sending?'发送中…':'发送';
    if(bridge.agentMode){const accessibleLabel=label==='发送'?'发送消息':label;button.setAttribute('aria-label',accessibleLabel);button.title=accessibleLabel;}
    else button.textContent=label;
    button.setAttribute('aria-busy',String(sending||skillUpdating||preferenceUpdating));
  }
  async function runImageAction(action,ids) {
    if(uploading||switchingConversation)throw new Error('请等待当前操作完成');
    if(!agentState||!agentConfig?.configured)throw new Error('请先连接 GuGu 对话');
    const prompts={upscale:'请增强附件图片的清晰度和细节，保留原图主体、构图和内容，并生成处理后的图片。',cutout:'请移除附件图片的背景，完整保留主体及边缘细节，生成透明背景的 PNG 图片。'};
    if(!prompts[action])throw new Error('不支持的图片操作');
    const item=nodes().find(n=>ids.includes(n.id));
    if(!item)throw new Error('请选择已导入的图片素材');
    const token=epoch,conversationId=agentState.id;
    uploading=true;drawPanels();
    let file;
    try{file=await bridge.prepareChatAsset({assetId:item.kind==='asset'?item.id:undefined,taskId:item.taskId});}
    finally{if(token===epoch){uploading=false;drawPanels();}}
    if(token!==epoch||conversationId!==agentState?.id)return;
    host.querySelector('.director-workspace').classList.remove('agent-collapsed');
    host.querySelector('[data-show-agent]').hidden=true;
    await submit(prompts[action],[file],ids);
  }
  async function downloadCanvasFiles(ids) {
    const items=ids.map(id=>nodes().find(n=>n.id===id));
    const media=items.map(n=>n&&(n.media||bridge.media(n.taskId)));
    if(!media.length||media.some(file=>!file?.url))return false;
    // Native images may have been cropped; export their current canvas state.
    if(ids.some(id=>canvas.getNodeConfigById(id)?.$_type==='image'))return false;
    for(let index=0;index<media.length;index++){
      const file=media[index],response=await fetch(file.url);
      if(!response.ok)throw new Error(`下载失败（${response.status}）`);
      const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
      const extension=blob.type==='video/webm'?'webm':blob.type.startsWith('video/')?'mp4':blob.type==='image/jpeg'?'jpg':'png';
      const name=(items[index].title||'素材').replace(/[\\/:*?"<>|]/g,'_');
      link.href=url;link.download=/\.[a-z0-9]{2,5}$/i.test(name)?name:`${name}.${extension}`;
      document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    return true;
  }
  async function attachCanvasFiles(ids) {
    if(uploading||switchingConversation)return;
    const items=nodes().filter(n=>ids.includes(n.id)&&(n.kind==='asset'||n.taskId));
    if(!items.length){bridge.toast('请选择已有文件的素材');return;}
    if(attachments.length+documentAttachments.length>=30){bridge.toast('一次最多添加 30 个文件');return;}
    const token=epoch,conversationId=agentState?.id;
    uploading=true;
    host.querySelector('.director-workspace').classList.remove('agent-collapsed');
    host.querySelector('[data-show-agent]').hidden=true;
    drawPanels();
    try{
      for(const item of items){
        if(attachments.length+documentAttachments.length>=30){bridge.toast('一次最多添加 30 个文件');break;}
        const file=await bridge.prepareChatAsset({assetId:item.kind==='asset'?item.id:undefined,taskId:item.taskId});
        if(token!==epoch||conversationId!==agentState?.id)return;
        if(!attachments.some(existing=>existing.id===file.id))attachments.push(file);
      }
      return true;
    }catch(error){if(token===epoch)bridge.toast(error.message);}
    finally{if(token===epoch){uploading=false;drawPanels();host.querySelector('#directorMessage').focus();}}
  }
  function drawInspector() {
    const n=nodes().find(n=>n.id===selected),el=host.querySelector('.dw-inspector');
    if(!el)return;
    el.hidden=!n;
    if(!n){el.innerHTML='';return;}
    if(['document','source-transcript','source-observation'].includes(n.kind)){
      const transcript=n.kind==='source-transcript';
      const stamp=seconds=>{const milliseconds=Math.max(0,Math.round(seconds*1000));const hours=Math.floor(milliseconds/3600000),minutes=Math.floor(milliseconds/60000)%60,secs=Math.floor(milliseconds/1000)%60;return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')},${String(milliseconds%1000).padStart(3,'0')}`;};
      const srt=transcript?(n.item.cues||[]).map((cue,index)=>`${index+1}\n${stamp(cue.startSeconds)} --> ${stamp(cue.endSeconds)}\n${cue.text}`).join('\n\n'):'';
      const content=transcript?(n.item.cues||[]).map(cue=>`${Math.round(cue.startSeconds*100)/100}–${Math.round(cue.endSeconds*100)/100} 秒  ${cue.text}`).join('\n')||n.text:n.text;
      el.classList.remove('compact');
      el.innerHTML=`<h3>${escape(n.title)}</h3><textarea readonly aria-label="${transcript?'台词时间线':'作品正文'}" class="dw-document-content">${escape(content)}</textarea>${copyButtonMarkup('data-doc-copy','复制正文')}<button data-doc-download ${transcript&&!n.item.cues?.length?'disabled':''}>${transcript?'下载字幕':'下载文稿'}</button><button data-doc-ask>${transcript?'按台词继续创作':'继续修改'}</button>`;
      el.querySelector('[data-doc-download]').onclick=()=>{const url=URL.createObjectURL(new Blob([transcript?srt:n.text],{type:transcript?'text/plain;charset=utf-8':'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`${n.title.replace(/[\\/:*?"<>|]/g,'_')}.${transcript?'srt':'md'}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      el.querySelector('[data-doc-ask]').onclick=async()=>{if(n.item.conversationId&&n.item.conversationId!==agentState?.id)await switchConversation(n.item.conversationId);const input=host.querySelector('#directorMessage');input.value=`${transcript?'根据':'修改'}「${n.title}」：`;resizeAgentComposer(input);input.focus();};return;
    }
    const locked=workspace().lockedIds.includes(n.id);
    const ask=()=>{host.querySelector('.director-workspace').classList.remove('agent-collapsed');host.querySelector('[data-show-agent]').hidden=true;const input=host.querySelector('#directorMessage');input.value=`${n.kind==='asset'?'使用':'修改'}「${n.title}」：`;resizeAgentComposer(input);input.focus();};
    if(!inspectorOpen||['asset','generation'].includes(n.kind)){el.hidden=true;el.innerHTML='';return;}
    el.classList.remove('compact');
    el.innerHTML=`<button data-close-edit class="dw-close-edit" aria-label="收起编辑">×</button><h3>${escape(n.title)}</h3><button data-lock>${locked?'解除锁定':'锁定内容'}</button><label>${n.kind==='story'?'剧本':'画面描述'}<textarea data-edit ${locked?'disabled':''}>${escape(n.kind==='story'?get().script:n.item.prompt)}</textarea></label>${n.kind==='shot'?`<label>镜头时长（秒）<input data-duration type="number" min="1" max="60" value="${n.item.duration}" ${locked?'disabled':''}></label>`:''}<button data-save-edit ${locked?'disabled':''}>保存修改</button><button data-ask-node>让 GuGu 修改</button>`;
    el.querySelector('[data-close-edit]').onclick=()=>{inspectorOpen=false;drawInspector();};
    if(n.kind!=='story'){
      const versions=n.kind==='resource'?n.item.versions:n.item.videoVersions;
      const selectedVersion=n.kind==='resource'?n.item.selectedTaskId:n.item.selectedVideoTaskId;
      el.insertAdjacentHTML('beforeend',`<label>作品版本<select data-version ${locked?'disabled':''}><option value="">选择已完成版本</option>${(versions||[]).filter(id=>bridge.task(id)?.status==='completed').map((id,i)=>`<option value="${escape(id)}" ${id===selectedVersion?'selected':''}>版本 ${i+1}${id===selectedVersion?' · 当前':''}</option>`).join('')}</select></label>`);
      el.querySelector('[data-version]').onchange=async e=>{if(!e.target.value)return;const key=n.kind==='resource'?'resources':'shots';const field=n.kind==='resource'?'selectedTaskId':'selectedVideoTaskId';const item=get()[key].find(x=>x.id===n.id);if(workspace().lockedIds.includes(n.id))return;item[field]=e.target.value;await bridge.patch({[key]:get()[key]});drawPanels();};
    }
    if(n.kind==='shot'){
      const images=bridge.images();const options=value=>`<option value="">未指定</option>${images.map(f=>`<option value="${escape(f.id)}" ${f.id===value?'selected':''}>${escape(f.name||f.id)}</option>`).join('')}`;
      el.insertAdjacentHTML('beforeend',`<label>生成方式<select data-generation-type ${locked?'disabled':''}>${[['TEXT','文本生成'],['FIRST&LAST','首尾帧'],['REFERENCE','参考图']].map(([v,t])=>`<option value="${v}" ${n.item.generation?.type===v?'selected':''}>${t}</option>`).join('')}</select></label><label>首帧<select data-first-frame ${locked?'disabled':''}>${options(n.item.generation?.firstFrameAssetId)}</select></label><label>尾帧<select data-last-frame ${locked?'disabled':''}>${options(n.item.generation?.lastFrameAssetId)}</select></label><label>参考图<select data-reference ${locked?'disabled':''}>${options(n.item.generation?.referenceAssetIds?.[0])}</select></label><button data-save-refs ${locked?'disabled':''}>保存参考设置</button>`);
      el.querySelector('[data-save-refs]').onclick=async()=>{if(workspace().lockedIds.includes(n.id))return;const shot=get().shots.find(x=>x.id===n.id);const ref=el.querySelector('[data-reference]').value;shot.generation={...shot.generation,type:el.querySelector('[data-generation-type]').value,firstFrameAssetId:el.querySelector('[data-first-frame]').value,lastFrameAssetId:el.querySelector('[data-last-frame]').value,referenceAssetIds:ref?[ref]:[]};await bridge.patch({shots:get().shots});drawPanels();};
    }
    el.querySelector('[data-lock]').onclick=async()=>{workspace().lockedIds=locked?workspace().lockedIds.filter(id=>id!==n.id):[...workspace().lockedIds,n.id];await save();drawPanels();};
    el.querySelector('[data-save-edit]').onclick=async()=>{try{if(n.kind==='story')await bridge.patch({script:el.querySelector('textarea').value});else {const data={prompt:el.querySelector('textarea').value};if(n.kind==='shot')data.duration=Number(el.querySelector('input').value);await bridge.patch(applyDirectorEdit(get(),{type:n.kind==='shot'?'update_shot':'update_resource',targetId:n.id,data}));}drawPanels();}catch(e){bridge.toast(e.message);}};
    el.querySelector('[data-ask-node]').onclick=()=>{const input=host.querySelector('.dw-composer textarea');input.value=`修改「${n.title}」：`;input.focus();};
  }
  const generationDraft=id=>(workspace().generationDrafts||[]).find(item=>item.id===id);
  const generationConfig=()=>bridge.generationConfig?.()||{};
  function resizeGenerationArea(draft){
    if(!canvas||!draft||draft.taskId)return;
    const current=workspace().positions[draft.id];if(!current)return;
    const size=canvasGenerationFrameSize(draft.type,draft.aspect);
    const x=current.x+(current.width-size.width)/2;
    workspace().positions[draft.id]={...current,x,...size};
    canvas.updateNodes([draft.id],{x,...size});
    alignCard(draft.id);positionGenerationComposer();
  }
  // Lucide line icons used by the canvas generation composer.
  const genIcon=paths=>`<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const genIcons={
    paperclip:genIcon('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l10-10a4 4 0 0 1 5.66 5.66l-10 10a2 2 0 0 1-2.83-2.83l9.19-9.19"/>'),
    chevron:genIcon('<path d="m6 9 6 6 6-6"/>'),
    check:genIcon('<path d="M20 6 9 17l-5-5"/>'),
    x:genIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    plus:genIcon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    minus:genIcon('<path d="M5 12h14"/>'),
    loader:genIcon('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'),
    sparkles:genIcon('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>'),
    settings:genIcon('<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>'),
    image:genIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
    video:genIcon('<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>'),
    audio:genIcon('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    TEXT:genIcon('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>'),
    REFERENCE:genIcon('<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>'),
    'FIRST&LAST':genIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>'),
  };
  const genRatioIcon=value=>{
    const [wide,tall]=String(value).split(':').map(Number),w=wide>0?wide:1,h=tall>0?tall:1,scale=14/Math.max(w,h);
    const width=Math.max(4,Math.round(w*scale*10)/10),height=Math.max(4,Math.round(h*scale*10)/10);
    return `<svg class="dw-gen-ratio-icon" viewBox="0 0 18 18" aria-hidden="true"><rect x="${(18-width)/2}" y="${(18-height)/2}" width="${width}" height="${height}" rx="2"/></svg>`;
  };
  const genModelIcon=model=>{
    const src=canvasGenerationModelIcon(model?.id,model?.iconKey);
    const initial=Array.from(String(model?.label||model?.id||'').trim())[0]||'';
    return `<span class="dw-gen-model-icon" aria-hidden="true"><span>${escape(initial.toUpperCase())}</span>${src?modelLogoMarkup(src,{generation:true}):''}</span>`;
  };
  const bindGenModelIcons=root=>root?.querySelectorAll('img[data-gen-model-icon]').forEach(img=>{
    // Keep the letter badge when the brand icon cannot load (for example offline).
    if(img.complete&&!img.naturalWidth){img.remove();return;}
    img.addEventListener('error',()=>img.remove(),{once:true});
  });
  const fitGenerationPrompt=input=>{if(!input)return;input.style.height='auto';input.style.height=`${Math.min(180,Math.max(72,input.scrollHeight))}px`;};
  function generationBounds(){
    const board=host.querySelector('.dw-board');
    if(!board||!canvas)return null;
    // The canvas surface is offset inside the board (the project header adds
    // top padding), while the composer is positioned relative to the board.
    const surface=canvas.getStage?.()?.container?.()||canvas.getContainer?.()||host.querySelector('.dw-canvas');
    const boardRect=board.getBoundingClientRect(),surfaceRect=surface?.getBoundingClientRect?.()||boardRect;
    const offsetX=surfaceRect.left-boardRect.left,offsetY=surfaceRect.top-boardRect.top;
    const launcher=host.querySelector('.dw-generation-launcher'),launcherRect=launcher?.getBoundingClientRect();
    const launcherTop=launcherRect?.height?launcherRect.top-boardRect.top:board.clientHeight;
    return {board,offsetX,offsetY,minTop:Math.max(12,offsetY+12),maxBottom:Math.min(board.clientHeight-12,launcherTop-10)};
  }
  function positionGenerationComposer(){
    const panel=host.querySelector('.dw-generation-composer');
    if(!panel||panel.hidden||!canvas||!activeGenerationId)return;
    const shape=canvas.getCanvasNodeById(activeGenerationId)?.getElement?.();
    const bounds=generationBounds();
    if(!shape||!bounds)return;
    const {board,offsetX,offsetY,minTop,maxBottom}=bounds;
    const client=shape.getClientRect(),rect={x:client.x+offsetX,y:client.y+offsetY,width:client.width,height:client.height};
    const type=generationDraft(activeGenerationId)?.type,width=Math.min(type==='video'?680:600,board.clientWidth-24);
    panel.classList.toggle('is-narrow',width<500);
    panel.style.width=`${width}px`;
    panel.style.maxHeight=`${Math.max(160,maxBottom-minTop)}px`;
    const height=panel.offsetHeight;
    const left=Math.max(12,Math.min(board.clientWidth-width-12,rect.x+rect.width/2-width/2));
    const below=rect.y+rect.height+14,above=rect.y-height-14;
    // Prefer the space under the frame, then above it; when neither fits keep
    // the composer inside the visible area instead of covering the toolbar.
    const top=below+height<=maxBottom?below:above>=minTop?above:Math.max(minTop,Math.min(below,maxBottom-height));
    Object.assign(panel.style,{left:`${left}px`,top:`${top}px`});
    panel.dataset.placement=top===above?'top':'bottom';
    positionGenerationMenu();
  }
  function generationQualityChoice(draft,value){return draft.type==='image'&&draft.modelId==='midjourney'?String(value):canvasGenerationQualityLabel(draft,value).replace(/画质$/,'');}
  function generationMenuMarkup(draft){
    const config=generationConfig(),options=canvasGenerationOptions(draft,config);
    const choice=(field,value,label,current,extra='')=>`<button type="button" class="dw-gen-choice" role="radio" aria-checked="${String(value)===String(current)}" data-gen-set="${field}" data-value="${escape(value)}" data-focus-key="${field}:${escape(value)}">${extra}<span>${escape(label)}</span></button>`;
    const section=(title,body,extra='')=>`<section class="dw-gen-menu-section${extra}"><h4>${title}</h4>${body}</section>`;
    if(generationMenu==='model'){
      const models=canvasGenerationModels(draft.type,config).filter(item=>item.availability!=='coming-soon');
      return `<div class="dw-gen-menu-title">${draft.type==='image'?'图像模型':'视频模型'}</div><div class="dw-gen-option-list">${models.map(model=>`<button type="button" class="dw-gen-option" role="option" aria-selected="${model.id===draft.modelId}" data-gen-set="modelId" data-value="${escape(model.id)}" data-focus-key="modelId:${escape(model.id)}">${genModelIcon(model)}<span class="dw-gen-option-copy"><b>${escape(model.label||model.id)}</b>${model.description?`<small>${escape(model.description)}</small>`:''}</span><span class="dw-gen-option-check">${genIcons.check}</span></button>`).join('')}</div>`;
    }
    if(generationMenu==='mode'){
      return `<div class="dw-gen-menu-title">生成方式</div><div class="dw-gen-option-list">${options.modes.map(item=>{const value=item.generationType;return `<button type="button" class="dw-gen-option" role="option" aria-selected="${value===draft.mode}" data-gen-set="mode" data-value="${escape(value)}" data-focus-key="mode:${escape(value)}"><span class="dw-gen-mode-icon" aria-hidden="true">${genIcons[value]||genIcons.video}</span><span class="dw-gen-option-copy"><b>${escape(canvasGenerationModeLabels[value]||value)}</b><small>${escape(canvasGenerationModeDescriptions[value]||'')}</small></span><span class="dw-gen-option-check">${genIcons.check}</span></button>`;}).join('')}</div>`;
    }
    const aspects=draft.type==='image'?canvasGenerationRatios:options.aspects;
    const aspect=section(draft.type==='image'?'画面比例':'画幅',`<div class="dw-gen-choice-grid is-ratio" role="radiogroup" aria-label="${draft.type==='image'?'画面比例':'画幅'}">${aspects.map(value=>choice('aspect',value,value,draft.aspect,genRatioIcon(value))).join('')}</div>`);
    const quality=options.qualities.length?section(draft.type==='image'?'质量':'分辨率',`<div class="dw-gen-segmented" role="radiogroup" aria-label="${draft.type==='image'?'质量':'分辨率'}">${options.qualities.map(value=>choice('quality',value,generationQualityChoice(draft,value),draft.quality)).join('')}</div>`):'';
    if(draft.type==='video'){
      const durations=options.parameters?.durations||[];
      const duration=durations.length?section('时长',`<div class="dw-gen-choice-grid is-duration" role="radiogroup" aria-label="时长">${durations.map(value=>choice('duration',value,`${value} 秒`,draft.duration)).join('')}</div>`):'';
      return `${aspect}${quality}${duration}`;
    }
    const midjourney=draft.modelId==='midjourney',min=midjourney?4:1,max=midjourney?8:10,quantity=Number(draft.quantity)||min;
    const stepper=section('数量',`<div class="dw-gen-stepper" role="group" aria-label="生成数量"><button type="button" data-gen-step="-1" data-focus-key="quantity:-" aria-label="减少数量" ${quantity<=min?'disabled':''}>${genIcons.minus}</button><output aria-live="polite">${quantity} 张</output><button type="button" data-gen-step="1" data-focus-key="quantity:+" aria-label="增加数量" ${quantity>=max?'disabled':''}>${genIcons.plus}</button></div>`,' is-inline');
    const mj=midjourney?`<details class="dw-gen-advanced"><summary>更多参数${genIcons.chevron}</summary><div class="dw-gen-advanced-grid"><label>风格化<input data-gen-mj="stylize" type="number" min="0" max="1000" step="10" value="${escape(draft.midjourney.stylize??100)}"></label><label>混乱度<input data-gen-mj="chaos" type="number" min="0" max="100" value="${escape(draft.midjourney.chaos??0)}"></label><label>怪异度<input data-gen-mj="weird" type="number" min="0" max="3000" step="10" value="${escape(draft.midjourney.weird??0)}"></label><label>种子<input data-gen-mj="seed" type="number" min="0" max="4294967295" value="${escape(draft.midjourney.seed??'')}" placeholder="随机"></label><label>参考图权重<input data-gen-mj="imageWeight" type="number" min="0" max="3" step="0.1" value="${escape(draft.midjourney.imageWeight??1)}"></label><label class="dw-gen-wide">排除内容<input data-gen-mj="negativePrompt" type="text" maxlength="500" value="${escape(draft.midjourney.negativePrompt??'')}" placeholder="例如：文字、水印"></label><label class="dw-gen-check"><input data-gen-mj="raw" type="checkbox" ${draft.midjourney.raw?'checked':''}> Raw 模式</label><label class="dw-gen-check"><input data-gen-mj="tile" type="checkbox" ${draft.midjourney.tile?'checked':''}> 无缝平铺</label><label class="dw-gen-check"><input data-gen-mj="draft" type="checkbox" ${draft.midjourney.draft?'checked':''}> 草稿模式</label></div></details>`:'';
    return `${aspect}${quality}${stepper}${mj}`;
  }
  // Keep the menu outside the canvas's clipping and compositing ancestors.
  const generationMenuOpen=menu=>Boolean(menu&&!menu.hidden);
  function positionGenerationMenu(){
    const menu=generationMenuElement;
    if(!generationMenuOpen(menu)||!generationMenu)return;
    const trigger=host.querySelector(`.dw-generation-composer [data-gen-menu="${generationMenu}"]`);
    if(!trigger)return;
    const anchor=trigger.getBoundingClientRect(),viewWidth=document.documentElement.clientWidth||window.innerWidth,viewHeight=window.innerHeight;
    const width=Math.min(generationMenu==='model'?340:generationMenu==='mode'?280:320,viewWidth-24);
    menu.style.width=`${width}px`;menu.style.maxHeight='none';
    const spaceBelow=viewHeight-anchor.bottom-16,spaceAbove=anchor.top-16;
    const natural=menu.scrollHeight,below=natural<=spaceBelow||spaceBelow>=spaceAbove;
    const maxHeight=Math.max(140,below?spaceBelow:spaceAbove),height=Math.min(natural,maxHeight);
    const left=Math.max(12,Math.min(viewWidth-width-12,anchor.left));
    Object.assign(menu.style,{maxHeight:`${maxHeight}px`,left:`${left}px`,top:`${Math.max(8,below?anchor.bottom+8:anchor.top-8-height)}px`});
    menu.dataset.placement=below?'bottom':'top';
  }
  function hideGenerationMenu(menu){
    menu.hidden=true;
    menu.innerHTML='';delete menu.dataset.generationMenu;
  }
  function renderGenerationMenu(){
    const menu=generationMenuElement,panel=host.querySelector('.dw-generation-composer');
    if(!menu)return;
    const draft=generationDraft(activeGenerationId);
    const trigger=generationMenu&&draft&&panel&&!panel.hidden?panel.querySelector(`[data-gen-menu="${generationMenu}"]`):null;
    let markup='';
    if(trigger){
      try{markup=generationMenuMarkup(draft);}
      catch(error){console.error('Canvas generation menu failed to render',error);}
    }
    if(!trigger||!markup){
      generationMenu='';
      panel?.querySelectorAll('[data-gen-menu]').forEach(button=>button.setAttribute('aria-expanded','false'));
      hideGenerationMenu(menu);return;
    }
    const focusKey=menu.contains(document.activeElement)?document.activeElement.dataset?.focusKey||'':'';
    const advancedOpen=menu.querySelector('.dw-gen-advanced')?.open;
    const scrollTop=menu.dataset.generationMenu===generationMenu?menu.scrollTop:0;
    menu.dataset.generationMenu=generationMenu;
    menu.setAttribute('role',generationMenu==='params'?'dialog':'listbox');
    menu.setAttribute('aria-label',generationMenu==='model'?'选择模型':generationMenu==='mode'?'选择生成方式':'生成参数');
    menu.innerHTML=markup;
    if(advancedOpen)menu.querySelector('.dw-gen-advanced')?.setAttribute('open','');
    bindGenModelIcons(menu);
    // Clear stale coordinates before measuring an opened or switched menu.
    Object.assign(menu.style,{left:'0px',top:'0px',maxHeight:'none'});
    menu.hidden=false;
    positionGenerationMenu();
    panel.querySelectorAll('[data-gen-menu]').forEach(button=>button.setAttribute('aria-expanded',String(button===trigger&&generationMenuOpen(menu))));
    menu.scrollTop=scrollTop;
    if(focusKey)[...menu.querySelectorAll('[data-focus-key]')].find(item=>item.dataset.focusKey===focusKey&&!item.disabled)?.focus({preventScroll:true});
  }
  function openGenerationMenu(name){
    generationMenu=generationMenu===name?'':name;
    renderGenerationMenu();
    const menu=generationMenuElement;
    if(!generationMenu||!menu)return;
    const target=menu.querySelector('[aria-selected="true"],[aria-checked="true"]')||menu.querySelector('button:not(:disabled),input');
    target?.focus({preventScroll:true});
  }
  function closeGenerationMenu(restoreFocus=false){
    const name=generationMenu;
    if(!name)return;
    generationMenu='';renderGenerationMenu();
    if(restoreFocus)host.querySelector(`.dw-generation-composer [data-gen-menu="${name}"]`)?.focus({preventScroll:true});
  }
  function fitGenerationAttachments(draft,field,value){
    if(draft.type!=='video'||!draft.attachments.length)return;
    const before=draft.attachments.length;
    if(draft.mode==='TEXT'){
      // Switching models may fall back to text mode; keep references when the model accepts them.
      const modes=canvasGenerationOptions(draft,generationConfig()).modes;
      if(!(field==='mode'&&value==='TEXT')&&modes.some(mode=>mode.generationType==='REFERENCE'))draft.mode='REFERENCE';
      else draft.attachments=[];
    }
    if(draft.mode==='FIRST&LAST')draft.attachments=draft.attachments.filter(file=>file.kind==='image').slice(0,2);
    if(draft.attachments.length<before)bridge.toast(draft.attachments.length?'已移除当前方式不支持的参考素材':'文生视频不使用参考素材，已移除');
  }
  function applyGenerationField(draft,field,value){
    const resetDuration=field==='modelId'&&draft.modelId!==value;
    draft[field]=value;
    reconcileCanvasGenerationDraft(draft,generationConfig(),{resetDuration});
    if(['modelId','mode'].includes(field)){fitGenerationAttachments(draft,field,value);reconcileCanvasGenerationDraft(draft,generationConfig());}
    if(['aspect','modelId','mode'].includes(field))resizeGenerationArea(draft);
    scheduleCanvasSave();renderGenerationComposer();
  }
  function renderGenerationComposer(){
    const panel=host.querySelector('.dw-generation-composer');
    if(!panel)return;
    const draft=generationDraft(activeGenerationId);
    if(!draft||draft.taskId||hiddenIds().has(draft.id)){panel.hidden=true;panel.innerHTML='';renderGenerationMenu();return;}
    reconcileCanvasGenerationDraft(draft,generationConfig());
    const options=canvasGenerationOptions(draft,generationConfig()),models=canvasGenerationModels(draft.type,generationConfig());
    const currentModel=models.find(item=>item.id===draft.modelId);
    const video=draft.type==='video',firstLast=video&&draft.mode==='FIRST&LAST';
    const prompt=panel.querySelector('[data-gen-prompt]'),promptFocus=prompt&&document.activeElement===prompt?[prompt.selectionStart,prompt.selectionEnd]:null;
    const busy=generationSubmitting||generationUploading;
    const references=draft.attachments.map((file,index)=>{
      const label=firstLast?index===0?'首帧':'尾帧':file.name;
      const thumb=file.kind==='image'&&file.url?`<img src="${escape(file.url)}" alt="">`:`<span class="dw-gen-reference-icon" aria-hidden="true">${genIcons[file.kind]||genIcons.image}</span>`;
      return `<span class="dw-gen-reference${firstLast?' is-frame':''}" title="${escape(file.name)}">${thumb}<span class="dw-gen-reference-name">${escape(label)}</span><button type="button" data-gen-remove="${escape(file.id)}" aria-label="移除${escape(label)}" title="移除">${genIcons.x}</button></span>`;
    }).join('');
    // Modes that need pictures show an explicit slot, so the next step is obvious.
    const slotLabel=firstLast&&draft.attachments.length<2?draft.attachments.length?'添加尾帧':'添加首帧':video&&draft.mode==='REFERENCE'&&!draft.attachments.length?'添加参考素材':'';
    const slot=slotLabel?`<button type="button" class="dw-gen-slot" data-gen-upload ${busy?'disabled':''}>${generationUploading?genIcons.loader:genIcons.plus}<span>${generationUploading?'正在上传':slotLabel}</span></button>`:'';
    const chip=(name,icon,label,aria,extra='')=>`<button type="button" class="dw-gen-chip${extra}" data-gen-menu="${name}" aria-haspopup="${name==='params'?'dialog':'listbox'}" aria-expanded="false" aria-label="${escape(aria)}" title="${escape(aria)}">${icon}<span class="dw-gen-chip-label">${escape(label)}</span><span class="dw-gen-chip-caret">${genIcons.chevron}</span></button>`;
    const modelLabel=currentModel?.label||draft.modelId||'选择模型';
    const modelChip=chip('model',genModelIcon(currentModel||{id:draft.modelId}),modelLabel,`模型：${modelLabel}`,' is-model');
    const modeLabel=canvasGenerationModeLabels[draft.mode]||draft.mode;
    const modeChip=video&&options.modes.length?chip('mode',`<span class="dw-gen-mode-icon" aria-hidden="true">${genIcons[draft.mode]||genIcons.video}</span>`,modeLabel,`生成方式：${modeLabel}`):'';
    const summary=[draft.aspect,draft.quality?canvasGenerationQualityLabel(draft,draft.quality):'',video?draft.duration?`${draft.duration} 秒`:'':`${draft.quantity} 张`].filter(Boolean).join(' · ');
    const paramsChip=chip('params',genRatioIcon(draft.aspect),summary||'参数设置',`生成参数：${summary}`,' is-params');
    const empty=!String(draft.prompt||'').trim();
    panel.dataset.genType=draft.type;
    panel.setAttribute('role','group');
    panel.setAttribute('aria-label',video?'视频生成':'图像生成');
    panel.innerHTML=`<div class="dw-gen-input">${references||slot?`<div class="dw-gen-references">${references}${slot}</div>`:''}<label class="dw-sr-only" for="canvasGenerationPrompt">画面描述</label><textarea id="canvasGenerationPrompt" data-gen-prompt rows="3" placeholder="${video?'描述视频中的画面、动作与镜头…':'描述想要的画面、风格与细节…'}">${escape(draft.prompt)}</textarea></div><div class="dw-gen-toolbar"><div class="dw-gen-options"><button type="button" class="dw-gen-attach" data-gen-upload aria-label="${video?'添加参考素材':'添加参考图片'}" title="${video?'添加参考素材':'添加参考图片'}" ${busy?'disabled':''}>${generationUploading?genIcons.loader:genIcons.paperclip}</button>${modelChip}${modeChip}${paramsChip}</div><button type="button" class="dw-gen-submit" data-gen-submit aria-label="${generationSubmitting?'正在开始生成':'开始生成'}" title="${empty?'请先填写画面描述':'开始生成（⌘/Ctrl + Enter）'}" ${busy||empty?'disabled':''} ${generationSubmitting?'aria-busy="true"':''}>${generationSubmitting?genIcons.loader:genIcons.sparkles}<span class="dw-gen-submit-label">${generationSubmitting?'正在开始':'生成'}</span><span class="dw-gen-price" data-gen-cost aria-live="polite">估算中…</span></button></div>`;
    panel.classList.toggle('is-uploading',generationUploading);
    panel.classList.toggle('is-submitting',generationSubmitting);
    bindGenModelIcons(panel);
    panel.hidden=false;
    const input=panel.querySelector('[data-gen-prompt]');
    fitGenerationPrompt(input);
    if(promptFocus){input.focus({preventScroll:true});input.setSelectionRange(...promptFocus);}
    positionGenerationComposer();
    renderGenerationMenu();
    updateGenerationCost(draft);
  }
  function updateGenerationCost(draft){
    const panel=host.querySelector('.dw-generation-composer'),cost=panel?.querySelector('[data-gen-cost]');
    if(!draft||!cost)return;
    const sequence=++generationCostSequence;
    clearTimeout(generationCostTimer);
    const format=value=>bridge.formatCredits?.(value)??Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
    const show=value=>{if(sequence!==generationCostSequence||generationDraft(draft.id)!==draft)return;cost.innerHTML=`<b>${escape(format(value))}</b><small>积分</small>`;};
    if(draft.type==='image'){
      const {config,pricing}=bridge.generationPricing?.()||{config:generationConfig(),pricing:{}};
      const quality=draft.modelId==='gpt-image-2.5'?draft.quality==='1k'?'1K':draft.quality.toUpperCase():'标准';
      const selected=config?.modelPrices?.find(item=>item.modelId===draft.modelId&&String(item.quality).toLowerCase()===quality.toLowerCase()&&item.available!==false);
      const fallback=draft.modelId==='midjourney'?4:draft.modelId==='gpt-image-2.5'?({ '1k':1,'2k':2,'4k':4 }[draft.quality]||1):Number(pricing?.image)||1;
      const unit=Number(selected?.credits??fallback),total=unit*(draft.modelId==='midjourney'?Number(draft.quantity)/4:Number(draft.quantity));
      show(total);return;
    }
    cost.textContent='估算中…';
    const parameters=canvasGenerationOptions(draft,generationConfig()).parameters;
    if(!parameters?.qualityOptions?.length){cost.textContent='暂不可估';return;}
    const counts={image:0,video:0,audio:0};draft.attachments.forEach(file=>{if(Object.hasOwn(counts,file.kind))counts[file.kind]++;});
    const request={modelId:draft.modelId,aspectRatio:draft.aspect,duration:Number(draft.duration),quality:draft.quality,generationType:draft.mode,referenceAssetIds:[],referenceCounts:counts};
    generationCostTimer=setTimeout(async()=>{
      try{
        const quote=await bridge.agentApi('/api/model-quote',{method:'POST',body:JSON.stringify(request)});
        if(sequence!==generationCostSequence)return;
        cost.innerHTML=`<b>${escape(format(quote.credits))}</b><small>积分</small>`;
      }catch{if(sequence===generationCostSequence)cost.textContent='暂不可估';}
    },160);
  }
  function createGenerationArea(type){
    if(!canvas)return;
    const draft=createCanvasGenerationDraft(type,generationConfig());
    if(!draft.modelId){bridge.toast('模型暂不可用，请稍后重试');return;}
    workspace().generationDrafts=[...(workspace().generationDrafts||[]),draft];
    activeGenerationId=draft.id;
    syncCanvas();canvas.selectNodes([draft.id]);
    renderGenerationComposer();
    queueWorkspaceFrame(()=>{positionGenerationComposer();host.querySelector('[data-gen-prompt]')?.focus();});
    scheduleCanvasSave(true);
  }
  async function submitGenerationArea(){
    const draft=generationDraft(activeGenerationId);
    if(!draft||generationSubmitting)return;
    let payload;
    try{payload=canvasGenerationPayload(draft,generationConfig());}
    catch(error){bridge.toast(error.message);return;}
    const token=epoch;generationSubmitting=true;draft.status='submitting';renderGenerationComposer();syncCanvas();
    try{
      if(payload.type==='video'){
        const counts={image:0,video:0,audio:0};draft.attachments.forEach(file=>{if(Object.hasOwn(counts,file.kind))counts[file.kind]++;});
        const quote=await bridge.agentApi('/api/model-quote',{method:'POST',body:JSON.stringify({...payload,referenceCounts:counts})});
        if(quote.priceVersion)payload.expectedPriceVersion=quote.priceVersion;
      }
      const requestId=crypto.randomUUID();
      const result=await bridge.agentApi('/api/generations',{method:'POST',headers:{'Idempotency-Key':requestId},body:JSON.stringify({...payload,requestId})});
      if(token!==epoch)return;
      const tasks=result.tasks||[];
      if(!tasks.length)throw new Error('暂时无法开始生成，请重试');
      draft.taskId=tasks[0].id;draft.status=tasks[0].status||'queued';
      const base=workspace().positions[draft.id],extras=tasks.slice(1).map((task,index)=>({...structuredClone(draft),id:`canvas-gen-${crypto.randomUUID()}`,taskId:task.id,status:task.status||'queued',attachments:[],prompt:draft.prompt,position:{x:base.x+(index+1)*(base.width+24),y:base.y,width:base.width,height:base.height}}));
      extras.forEach(item=>{workspace().positions[item.id]=item.position;delete item.position;});
      workspace().generationDrafts.push(...extras);
      activeGenerationId='';renderGenerationComposer();syncCanvas();scheduleCanvasSave(true);
      bridge.toast(tasks.length>1?`已开始生成 ${tasks.length} 张图片`:'已开始生成');
    }catch(error){if(token===epoch){draft.status='';bridge.toast(error.message);}}
    finally{if(token===epoch){generationSubmitting=false;renderGenerationComposer();syncCanvas();}}
  }
  function mount() {
    if(projectId===get().id&&host.querySelector('.dw-canvas')){drawPanels();return;}
    dispose();projectId=get().id;
    const mountEpoch=epoch;workspaceActive=true;
    host.innerHTML=`<section class="director-workspace"><section class="dw-board"><div class="dw-canvas reference-canvas-host" aria-label="无限分镜画布"></div><section class="dw-inspector" hidden></section></section><aside class="dw-agent"><div class="dw-agent-resizer" role="separator" aria-label="调整对话区域宽度" aria-orientation="vertical" tabindex="0"></div><header><b>GuGu</b><nav aria-label="对话操作"><button type="button" data-agent-new title="新建对话">＋ 新对话</button><button type="button" data-agent-history aria-expanded="false" aria-haspopup="dialog" popovertarget="directorHistoryPicker">历史</button><button type="button" data-hide-agent aria-label="收起对话" title="收起对话"><span class="gugu-lucide gugu-lucide-minus" aria-hidden="true"></span></button></nav></header><section id="directorHistoryPicker" class="dw-conversations dw-history-picker" aria-label="历史对话" popover role="dialog"></section><details class="dw-agent-options"><summary>生成设置</summary><label><input type="checkbox" data-agent-auto> 预算内自动生成</label><label>本次对话生成预算（积分）<input type="number" data-agent-budget min="0" max="10000" step="1" value="0"></label><button type="button" data-agent-save-settings>保存设置</button></details><div class="dw-message-scroller"><div class="dw-messages" role="log" aria-label="对话内容" aria-live="polite" tabindex="0"><div class="dw-turn-activity"><p class="dw-mode-help"></p><button type="button" class="dw-agent-retry" data-agent-retry hidden>重新连接</button></div></div><nav class="dw-message-rail" aria-label="消息导航" hidden></nav></div><div class="dw-plan"></div><form class="dw-composer"><label for="directorMessage" class="dw-sr-only">告诉 GuGu 你的想法</label><div data-agent-attachments class="dw-attachments attachment-strip" aria-label="已添加的文件"></div><textarea id="directorMessage" placeholder="想聊什么，或希望我帮你创作什么？" rows="3"></textarea><div class="dw-composer-actions"><button type="button" data-agent-upload class="dw-icon-button" aria-label="上传文件" title="上传文件"><span class="gugu-lucide gugu-lucide-paperclip" aria-hidden="true"></span></button><button data-director-delegate type="button" title="继续当前创作">继续</button><button data-director-stop type="button" hidden>暂停</button><button type="button" data-agent-model-toggle class="dw-icon-button" aria-label="切换对话模型" aria-haspopup="dialog" aria-expanded="false" popovertarget="directorModelPicker"><span class="gugu-lucide gugu-lucide-layers-2" aria-hidden="true"></span></button><button data-director-send class="dw-primary" type="submit" aria-label="发送消息">发送</button></div></form><div id="directorModelPicker" class="dw-model-picker" popover role="dialog" aria-label="选择对话模型"><strong>选择对话模型</strong><div data-agent-model-list></div></div></aside></section>`;
    mountedWorkspace=host.querySelector('.director-workspace');
    const messagePanel=host.querySelector('.dw-messages');
    messageScroller=createMessageScroller(messagePanel,host.querySelector('.dw-message-rail'),host.querySelector('.dw-agent'));
    reasoning=createReasoningText();
    messagePanel.querySelector('.dw-turn-activity').prepend(reasoning.element);
    messagePanel.addEventListener('click',event=>{
      const button=event.target.closest('[data-response-feedback]');
      if(!button||!messagePanel.contains(button))return;
      const selected=button.getAttribute('aria-pressed')==='true';
      button.parentElement.querySelectorAll('[data-response-feedback]').forEach(feedback=>{
        feedback.setAttribute('aria-pressed',String(feedback===button&&!selected));
      });
    });
    if(bridge.agentMode){
      host.querySelector('.director-workspace').classList.add('agent-space');
      const agentHeader=host.querySelector('.dw-agent>header');
      agentHeader.classList.add('dw-agent-page-header');
      agentHeader.innerHTML=`<div class="dw-agent-project"><button type="button" class="dw-icon-button dw-header-icon" data-agent-project-back aria-label="返回项目列表" title="返回项目列表"><span class="gugu-lucide gugu-lucide-arrow-left" aria-hidden="true"></span></button><h1 class="dw-agent-project-title">${escape(bridge.projectTitle?.()||'新项目')}</h1></div><nav aria-label="对话操作"><button type="button" class="dw-icon-button dw-header-icon" data-agent-new aria-label="新建对话" title="新建对话"><span class="gugu-lucide gugu-lucide-message-square-plus" aria-hidden="true"></span></button><button type="button" class="dw-icon-button dw-header-icon" data-agent-history aria-label="历史对话" title="历史对话" aria-expanded="false" aria-haspopup="dialog" popovertarget="directorHistoryPicker"><span class="gugu-lucide gugu-lucide-history" aria-hidden="true"></span></button><button type="button" class="dw-icon-button dw-header-icon" data-agent-canvas aria-label="显示画布" title="显示画布"><span class="gugu-lucide gugu-lucide-minimize-2" aria-hidden="true"></span></button><button type="button" class="dw-icon-button dw-header-icon" data-hide-agent aria-label="收起对话" title="收起对话"><span class="gugu-lucide gugu-lucide-minus" aria-hidden="true"></span></button></nav>`;
      host.querySelector('.dw-agent-options')?.remove();
      const uploadTrigger=host.querySelector('[data-agent-upload]');
      uploadTrigger.innerHTML='<span class="gugu-lucide gugu-lucide-plus" aria-hidden="true"></span>';
      uploadTrigger.setAttribute('aria-label','添加文件');uploadTrigger.title='添加文件';
      const sendTrigger=host.querySelector('[data-director-send]');
      sendTrigger.innerHTML='<span class="gugu-lucide gugu-lucide-arrow-up" aria-hidden="true"></span>';
      host.querySelector('[data-agent-model-toggle]')?.remove();
      host.querySelector('#directorModelPicker')?.remove();
      host.querySelector('#directorMessage').insertAdjacentHTML('beforebegin',`<div class="dw-selected-skill" data-selected-skill hidden>${skillIcon}<span></span><button type="button" data-agent-skill-remove aria-label="移除所选创作方式"><span class="gugu-lucide gugu-lucide-x" aria-hidden="true"></span></button></div>`);
      host.querySelector('[data-agent-upload]').insertAdjacentHTML('afterend',`<div class="dw-skill-picker"><button type="button" class="dw-icon-button" data-agent-skill-trigger aria-label="选择创作方式" title="选择创作方式" aria-haspopup="menu" aria-expanded="false" aria-pressed="false">${skillIcon}</button><div class="dw-skill-menu" data-agent-skill-menu role="menu" aria-label="选择创作方式" hidden></div></div>`);
      host.querySelector('[data-agent-canvas]').onclick=()=>{chatMode=chatMode==='full'?'side':'full';drawPanels();};
      host.querySelector('[data-agent-project-back]').onclick=()=>bridge.onProjectBack?.();
      const projectChrome=document.createElement('header');
      projectChrome.className='dw-project-chrome';
      projectChrome.append(agentHeader.querySelector('.dw-agent-project'));
      const projectTitle=projectChrome.querySelector('.dw-agent-project-title');
      projectTitle.title=projectTitle.textContent;
      projectChrome.insertAdjacentHTML('beforeend','<div class="dw-project-tools reference-canvas-host" role="toolbar" aria-label="画布工具"></div>');
      host.querySelector('.director-workspace').prepend(projectChrome);
    }
    host.querySelectorAll('.dw-agent>header button,.dw-project-chrome button').forEach(button=>{
      const label=button.getAttribute('aria-label')||button.title||button.textContent.trim();
      button.dataset.tooltip=label;
      button.setAttribute('aria-label',label);
      button.removeAttribute('title');
    });
    host.querySelector('.dw-board').insertAdjacentHTML('beforeend',`<div class="dw-generation-composer" hidden></div><div class="dw-generation-dock"><div class="dw-generation-launcher" role="group" aria-label="在画布上生成内容"><button type="button" data-create-generation="image"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 4"/></svg><span>图像生成</span></button><span class="dw-generation-launcher-divider" aria-hidden="true"></span><button type="button" data-create-generation="video"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2"/></svg><span>视频生成</span></button></div><button type="button" class="dw-agent-reopen" data-show-agent aria-label="打开对话" title="打开对话" hidden>${agentLogoMarkup}</button></div>`);
    host.querySelectorAll('[data-create-generation]').forEach(button=>button.onclick=()=>createGenerationArea(button.dataset.createGeneration));
    const generationPanel=host.querySelector('.dw-generation-composer');
    generationPanel.addEventListener('input',event=>{
      const draft=generationDraft(activeGenerationId);if(!draft)return;
      if(event.target.matches('[data-gen-prompt]')){
        draft.prompt=event.target.value;fitGenerationPrompt(event.target);
        const submit=generationPanel.querySelector('[data-gen-submit]'),empty=!draft.prompt.trim();
        if(submit){submit.disabled=empty||generationSubmitting||generationUploading;submit.title=empty?'请先填写画面描述':'开始生成（⌘/Ctrl + Enter）';}
        positionGenerationComposer();scheduleCanvasSave();
      }
    });
    generationMenuLayer=document.createElement('div');
    generationMenuLayer.className='director-workspace dw-generation-overlay';
    generationMenuElement=document.createElement('div');
    generationMenuElement.className='dw-gen-menu';
    generationMenuElement.hidden=true;
    generationMenuLayer.append(generationMenuElement);
    document.body.append(generationMenuLayer);
    const generationMenuPanel=generationMenuElement;
    generationMenuPanel.addEventListener('click',event=>{
      const draft=generationDraft(activeGenerationId);if(!draft)return;
      const option=event.target.closest('[data-gen-set]'),step=event.target.closest('[data-gen-step]');
      if(option&&!option.disabled){
        const field=option.dataset.genSet,value=field==='duration'?Number(option.dataset.value):option.dataset.value;
        if(String(draft[field])!==String(value))applyGenerationField(draft,field,value);
        if(['modelId','mode'].includes(field))closeGenerationMenu(true);
        return;
      }
      if(step&&!step.disabled){
        const midjourney=draft.modelId==='midjourney';
        applyGenerationField(draft,'quantity',Number(draft.quantity)+Number(step.dataset.genStep)*(midjourney?4:1));
      }
    });
    generationMenuPanel.addEventListener('change',event=>{
      const draft=generationDraft(activeGenerationId),mj=event.target.dataset.genMj;if(!draft||!mj)return;
      draft.midjourney[mj]=event.target.type==='checkbox'?event.target.checked:['seed','negativePrompt'].includes(mj)?event.target.value:Number(event.target.value);
      reconcileCanvasGenerationDraft(draft,generationConfig());scheduleCanvasSave();
    });
    generationMenuPanel.addEventListener('toggle',event=>{if(event.target.matches?.('.dw-gen-advanced'))positionGenerationMenu();},true);
    generationMenuPanel.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeGenerationMenu(true);return;}
      if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)||event.target.matches('input'))return;
      const items=[...generationMenuPanel.querySelectorAll('[data-focus-key]:not(:disabled)')];
      const index=items.indexOf(document.activeElement);if(!items.length)return;
      event.preventDefault();event.stopPropagation();
      const next=event.key==='Home'?0:event.key==='End'?items.length-1:['ArrowDown','ArrowRight'].includes(event.key)?(index+1)%items.length:(index-1+items.length)%items.length;
      items[next].focus({preventScroll:false});
    });
    generationPanel.addEventListener('click',async event=>{
      const draft=generationDraft(activeGenerationId);if(!draft)return;
      const menuTrigger=event.target.closest('[data-gen-menu]');
      if(menuTrigger){openGenerationMenu(menuTrigger.dataset.genMenu);return;}
      const remove=event.target.closest('[data-gen-remove]');
      if(remove){draft.attachments=draft.attachments.filter(file=>file.id!==remove.dataset.genRemove);scheduleCanvasSave();renderGenerationComposer();return;}
      if(event.target.closest('[data-gen-submit]')){void submitGenerationArea();return;}
      if(!event.target.closest('[data-gen-upload]')||generationUploading)return;
      const token=epoch,id=draft.id;generationUploading=true;renderGenerationComposer();
      try{
        const file=await bridge.uploadGenerationFile();
        if(token!==epoch||!file||!generationDraft(id))return;
        if(draft.type==='image'&&file.kind!=='image')throw new Error('图像生成只能添加图片参考');
        if(draft.type==='image'&&draft.attachments.length>=7)throw new Error('参考图片最多添加 7 张');
        if(draft.mode==='FIRST&LAST'&&file.kind!=='image')throw new Error('首尾帧只能添加图片');
        if(draft.type==='video'&&draft.mode==='TEXT'){
          const modes=canvasGenerationOptions(draft,generationConfig()).modes;
          if(!modes.some(mode=>mode.generationType==='REFERENCE'))throw new Error('当前模型不支持参考素材');
          draft.mode='REFERENCE';
        }
        if(draft.mode==='FIRST&LAST'&&draft.attachments.length>=2)throw new Error('首尾帧最多添加两张图片');
        if(!draft.attachments.some(item=>item.id===file.id))draft.attachments.push({id:file.id,name:file.name,kind:file.kind,url:file.previewUrl||file.url||''});
        reconcileCanvasGenerationDraft(draft,generationConfig());resizeGenerationArea(draft);
        scheduleCanvasSave();
      }catch(error){if(token===epoch&&!error.stale)bridge.toast(error.message);}
      finally{if(token===epoch){generationUploading=false;renderGenerationComposer();}}
    });
    generationPanel.addEventListener('keydown',event=>{
      if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void submitGenerationArea();return;}
      const trigger=event.target.closest?.('[data-gen-menu]');
      if(trigger&&event.key==='ArrowDown'&&generationMenu!==trigger.dataset.genMenu){event.preventDefault();openGenerationMenu(trigger.dataset.genMenu);return;}
      if(event.key!=='Escape'||event.isComposing)return;
      event.preventDefault();event.stopPropagation();
      // Escape (or clicking empty canvas) collapses the composer; the draft stays on the canvas.
      if(generationMenu){closeGenerationMenu(true);return;}
      activeGenerationId='';canvas?.selectNodes([]);renderGenerationComposer();
    });
    if(typeof IntersectionObserver==='function')mediaLoadObserver=new IntersectionObserver(entries=>{
      if(mountEpoch!==epoch)return;
      for(const entry of entries){
        if(!entry.isIntersecting||!entry.target.isConnected)continue;
        const media=entry.target,url=media.dataset.canvasSrc;
        mediaLoadObserver?.unobserve(media);
        if(!url)continue;
        media.src=url;delete media.dataset.canvasSrc;
        if(media.tagName==='VIDEO')media.preload='metadata';
      }
    },{root:host.querySelector('.dw-canvas'),rootMargin:'400px'});
    const bindCanvas=api=>{
      if(mountEpoch!==epoch){api.dispose?.();return;}
      canvas=api;
      canvas.on('nodes:created',handleCreatedCanvasNodes);
      mainLayer=canvas.getMainLayer?.();
      nativeTransformer=canvas.getTransformer?.();
      brandSelectionTransformer(nativeTransformer);
      if(workspace().viewport)canvas.updateViewport(workspace().viewport);
      canvas.on('nodes:selected',ids=>{const next=ids.find(id=>!id.startsWith('edge-'))||'';const isRichText=Boolean(next&&canvas.getNodeConfigById?.(next)?.$_type==='rich-text');host.querySelector('.director-workspace')?.classList.toggle('rich-text-selected',isRichText);if(next!==selected)inspectorOpen=false;selected=next;activeGenerationId=generationDraft(next)?.taskId?'':generationDraft(next)?.id||'';renderGenerationComposer();if(isRichText){const inspector=host.querySelector('.dw-inspector');if(inspector){inspector.hidden=true;inspector.innerHTML='';}}else drawInspector();if(ids.length)syncCanvas();else window.setTimeout(()=>{if(mountEpoch===epoch&&canvas&&!syncing&&!selected)syncCanvas();},0);});
      canvas.on('nodes:deleted',deletedNodes=>{
        if(syncing||!Array.isArray(deletedNodes)||deletedNodes.length===0)return;
        const deletedIds=markCanvasItemsHidden(deletedNodes.map(node=>node?.id).filter(Boolean));
        if(deletedIds.length===0)return;
        clearTimeout(saveTimer);
        saveTimer=setTimeout(()=>{if(get()?.id===projectId)void save().catch(e=>bridge.toast(e.message));},600);
      });
      let edgeFrame=0;
      let latestSnapshot=null;
      const queueEdgeSync=snapshot=>{latestSnapshot=snapshot;if(edgeFrame)return;edgeFrame=queueWorkspaceFrame(()=>{edgeFrame=0;const next=latestSnapshot;latestSnapshot=null;if(next)renderEdges(next.nodes);});};
      const geometrySignature=snapshot=>(snapshot.nodes||[]).filter(n=>!String(n.id).startsWith('edge-')).map(n=>`${n.id}:${n.x}:${n.y}:${n.width}:${n.height}:${n.scaleX||1}:${n.scaleY||1}`).join('|');
      // Changing the chat column can make the canvas report a resize-related
      // state/viewport event. Those events describe layout, not user edits.
      canvas.on('state:change',snapshot=>{if(mountEpoch!==epoch||syncing||resizingChat)return;bridge.markCanvasDirty?.();syncCanvasOverlayVisibility(snapshot);const current=persistLiveCanvasState(snapshot);if(!current)return;const geometry=geometrySignature(current);if(geometry!==lastNodeGeometry){lastNodeGeometry=geometry;queueEdgeSync(current);}scheduleCanvasSave();});
      canvas.on('viewport:change',v=>{if(mountEpoch!==epoch||syncing||resizingChat||(bridge.agentMode&&!agentReady))return;bridge.markCanvasDirty?.();queueWorkspaceFrame(()=>{alignCards();positionGenerationComposer();});persistLiveCanvasState(liveCanvasSnapshot({...canvas.getState(),viewport:v}));workspace().viewport=v;scheduleCanvasSave();});
      // Konva owns live geometry during both drag and resize. The public
      // state event arrives only after the gesture, so align HTML cards and
      // arrows from the native shape on every move.
      const geometryIds=event=>{
        const targets=event?.type?.startsWith('transform')?nativeTransformer?.nodes?.():[event?.target];
        return (targets||[]).map(target=>target?.id?.()).filter(id=>id&&!String(id).startsWith('edge-'));
      };
      const onGeometryMove=event=>{
        const ids=geometryIds(event);
        if(!ids.length)return;
        ids.forEach(id=>alignCard(id,undefined,true));
        if(ids.includes(activeGenerationId))positionGenerationComposer();
        scheduleEdgeRender();
      };
      const onGeometryEnd=event=>{
        const ids=geometryIds(event);
        if(!ids.length)return;
        if(event.type==='transformend')ids.forEach(id=>automaticImageSizing.delete(id));
        ids.forEach(id=>alignCard(id,undefined,true));
        const snapshot=persistLiveCanvasState();
        if(event.type==='transformend')ids.forEach(id=>{
          if(canvas.getNodeConfigById(id)?.$_type==='html'&&workspace().positions[id])workspace().positions[id].manualSize=true;
        });
        if(snapshot)renderEdges(snapshot.nodes,true);
        if(ids.includes(activeGenerationId))positionGenerationComposer();
        scheduleCanvasSave(true);
      };
      mainLayer?.on?.('dragmove.director-edges',onGeometryMove);
      mainLayer?.on?.('dragend.director-edges',onGeometryEnd);
      // Konva fires transform on the Transformer and each node directly;
      // unlike dragmove, it does not bubble through the main layer.
      nativeTransformer?.on?.('transform.director-edges',onGeometryMove);
      nativeTransformer?.on?.('transformend.director-edges',onGeometryEnd);
      syncing=true;
      const hidden=hiddenIds();
      canvas.createNodes((workspace().canvasNodes||[]).filter(node=>!hidden.has(node.id)),false);
      syncing=false;
      syncCanvas();
      queueWorkspaceFrame(()=>{if(canvas){syncCanvas();alignCards();}});
      drawPanels();
    };
    canvasMount=mountReferenceCanvas(host.querySelector('.dw-canvas'),{sessionKey:projectId,toolbarHost:host.querySelector('.dw-project-tools'),adapter:{
      workspaceToolbar:false,
      attachFiles:ids=>attachCanvasFiles(ids),
      imageAction:runImageAction,
      downloadFiles:downloadCanvasFiles,
      importAsset:()=>importAssetIntoCanvas(),
      sendMessage:(text)=>{if(text)void submit(text);},
      saveUpload:payload=>bridge.saveUpload?.(payload)||URL.createObjectURL(new Blob([Uint8Array.from(atob(payload.base64),char=>char.charCodeAt(0))])),
      saveTemp:payload=>bridge.saveTemp?.(payload)||bridge.saveUpload?.(payload),
    },onReady:bindCanvas});
    const workspaceElement=host.querySelector('.director-workspace');
    const handle=host.querySelector('.dw-agent-resizer');
    let preferredWidth=460;
    try{preferredWidth=Number(localStorage.getItem('gugu-conversation-width'))||460;}catch{}
    const setWidth=(width,persist=false)=>{
      const maximum=Math.max(280,Math.min(720,workspaceElement.clientWidth-240));
      const next=Math.round(Math.max(280,Math.min(maximum,width)));
      workspaceElement.style.setProperty('--dw-chat-width',`${next}px`);
      handle.setAttribute('aria-valuemin','280');handle.setAttribute('aria-valuemax',String(maximum));handle.setAttribute('aria-valuenow',String(next));
      if(persist){preferredWidth=next;try{localStorage.setItem('gugu-conversation-width',String(next));}catch{}}
    };
    const captureCanvasForResize=()=>{
      if(!canvas)return null;
      const state=canvas.getState?.();
      return state?{viewport:state.viewport?{...state.viewport}:null,nodes:(state.nodes||[]).filter(node=>!String(node.id).startsWith('edge-')).map(node=>({id:node.id,x:node.x,y:node.y,width:node.width,height:node.height,scaleX:node.scaleX,scaleY:node.scaleY,rotation:node.rotation}))}:null;
    };
    const restoreCanvasAfterResize=()=>{
      const snapshot=resizeCanvasSnapshot;resizeCanvasSnapshot=null;
      if(!canvas||!snapshot)return;
      const current=canvas.getState?.();
      if(snapshot.viewport&&JSON.stringify(current?.viewport)!==JSON.stringify(snapshot.viewport))canvas.updateViewport(snapshot.viewport);
      const currentById=new Map((current?.nodes||[]).map(node=>[node.id,node]));
      const changed=snapshot.nodes.filter(node=>{const now=currentById.get(node.id);return now&&['x','y','width','height','scaleX','scaleY','rotation'].some(key=>Number(now[key]??1)!==Number(node[key]??1));});
      changed.forEach(({id,...attrs})=>canvas.updateNodes([id],attrs));
      alignCards();
    };
    const endResize=event=>{
      if(!resizingChat&&!resizeCanvasSnapshot)return;
      if(event?.pointerId!==undefined&&handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      restoreCanvasAfterResize();
      if(resizeFinishFrame)cancelAnimationFrame(resizeFinishFrame);
      resizeFinishFrame=queueWorkspaceFrame(()=>{resizeFinishFrame=0;resizingChat=false;workspaceElement.classList.remove('is-resizing-chat');});
    };
    const resizeLayoutOnly=(width,persist=true)=>{
      if(!resizingChat){resizeCanvasSnapshot=captureCanvasForResize();resizingChat=true;workspaceElement.classList.add('is-resizing-chat');}
      setWidth(width,persist);
      queueWorkspaceFrame(()=>endResize());
    };
    handle.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();if(resizeFinishFrame){cancelAnimationFrame(resizeFinishFrame);resizeFinishFrame=0;}resizeCanvasSnapshot=captureCanvasForResize();resizingChat=true;handle.setPointerCapture(event.pointerId);workspaceElement.classList.add('is-resizing-chat');};
    handle.onpointermove=event=>{if(!handle.hasPointerCapture(event.pointerId))return;event.preventDefault();event.stopPropagation();setWidth(workspaceElement.getBoundingClientRect().right-event.clientX,true);};
    handle.onpointerup=event=>{event.preventDefault();event.stopPropagation();endResize(event);};
    handle.onpointercancel=event=>{event?.stopPropagation?.();endResize(event);};handle.onlostpointercapture=()=>{if(resizingChat)endResize();};
    handle.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();resizeLayoutOnly(event.key==='Home'?280:event.key==='End'?720:Number(handle.getAttribute('aria-valuenow'))+(event.key==='ArrowLeft'?24:-24),true);};
    handle.ondblclick=()=>resizeLayoutOnly(460,true);
    resizeObserver=new ResizeObserver(()=>{setWidth(preferredWidth);positionGenerationComposer();});resizeObserver.observe(workspaceElement);setWidth(preferredWidth);
    host.querySelector('[data-agent-new]').onclick=()=>void switchConversation();

    host.querySelector('[data-agent-retry]').onclick=()=>void agentAction(()=>agentClient.start());
    const modelPicker=host.querySelector('#directorModelPicker');
    const historyPicker=host.querySelector('#directorHistoryPicker');
    const positionPopover=(popup,trigger,above)=>{
      const rect=trigger.getBoundingClientRect();
      const available=above?rect.top-16:window.innerHeight-rect.bottom-16;
      popup.style.maxHeight=`${Math.max(0,Math.min(420,available))}px`;
      popup.style.left=`${Math.max(8,Math.min(rect.right-popup.offsetWidth,window.innerWidth-popup.offsetWidth-8))}px`;
      popup.style.top=`${above?Math.max(8,rect.top-popup.offsetHeight-8):rect.bottom+8}px`;
    };
    const positionPopovers=()=>{
      positionGenerationMenu();
      if(modelPicker?.matches(':popover-open'))positionPopover(modelPicker,host.querySelector('[data-agent-model-toggle]'),true);
      if(historyPicker.matches(':popover-open'))positionPopover(historyPicker,host.querySelector('[data-agent-history]'),false);
    };
    generationApproval=mountGenerationApproval(host.querySelector('.dw-plan'),{onDecision:(id,accepted)=>agentClient.approve(id,accepted)});
    popoverEvents=new AbortController();
    mountContentCopy(host,{signal:popoverEvents.signal,onError:message=>bridge.toast(message)});
    modelPreferencePicker=mountModelPreferencePicker(host.querySelector('[data-agent-upload]'),{
      signal:popoverEvents.signal,
      loadCatalog:()=>bridge.agentApi('/api/agent/media-models',{signal:popoverEvents.signal}),
      onOpen:()=>{host.querySelector('[data-agent-skill-menu]')?.setAttribute('hidden','');host.querySelector('[data-agent-skill-trigger]')?.setAttribute('aria-expanded','false');},
      onError:error=>bridge.toast(error.message||'保存失败，请重试。'),
      onSave:async value=>{
        if(!agentReady||switchingConversation)throw new Error('对话正在连接，请稍后重试');
        const saveToken=epoch,session=agentState.id;
        preferenceUpdating=true;drawPanels();
        try{await agentClient.settings({modelPreferences:value});if(saveToken!==epoch||session!==agentState?.id)throw new Error('对话已切换，请重新选择');}
        finally{if(saveToken===epoch){preferenceUpdating=false;drawPanels();}}
      },
    });
    messagePreviews=mountAttachmentPreviews(messagePanel,{signal:popoverEvents.signal,renderCards:false});
    window.addEventListener('resize',positionPopovers,{signal:popoverEvents.signal});
    document.addEventListener('pointerdown',event=>{
      if(!generationMenu)return;
      const menu=generationMenuElement;
      if(menu?.contains(event.target)||event.target.closest?.('.dw-generation-composer [data-gen-menu]'))return;
      closeGenerationMenu(false);
    },{capture:true,signal:popoverEvents.signal});
    host.addEventListener('scroll',positionPopovers,{capture:true,signal:popoverEvents.signal});
    modelPicker?.addEventListener('toggle',positionPopovers);
    historyPicker.addEventListener('toggle',event=>{
      historyOpen=event.newState==='open';drawPanels();positionPopovers();
      if(historyOpen)void agentAction(()=>agentClient.history()).then(positionPopovers);
    });

    modelPicker?.addEventListener('toggle',event=>host.querySelector('[data-agent-model-toggle]').setAttribute('aria-expanded',String(event.newState==='open')));
    const modelList=host.querySelector('[data-agent-model-list]');
    if(modelList)modelList.onclick=event=>{const button=event.target.closest('[data-agent-model]');if(!button||drainingSubmissions||switchingConversation)return;modelPicker.hidePopover();void agentAction(()=>agentClient.settings({model:button.dataset.agentModel}));};
    if(bridge.agentMode){
      const picker=host.querySelector('.dw-skill-picker'),trigger=picker.querySelector('[data-agent-skill-trigger]'),menu=picker.querySelector('[data-agent-skill-menu]');
      const setSkillMenu=open=>{if(open){const selected=skillSelection??agentState?.settings?.skill??'';menu.innerHTML=(agentConfig?.skills||[]).map(item=>`<button type="button" role="menuitemcheckbox" aria-checked="${item.name===selected}" data-agent-skill-option="${escape(item.name)}"><span class="dw-skill-menu-icon" aria-hidden="true">${skillIcon}</span><span><strong>${escape(item.title||item.name)}</strong><small>${escape(item.summary||'')}</small></span></button>`).join('');}menu.hidden=!open;trigger.setAttribute('aria-expanded',String(open));if(open)menu.querySelector('[data-agent-skill-option]')?.focus({preventScroll:true});};
      const updateSkill=async value=>{
        if(!agentReady||skillUpdating||switchingConversation||value===(agentState?.settings?.skill||''))return;
        const token=epoch,session=agentState?.id;
        skillSelection=value;skillUpdating=true;drawPanels();
        try{await agentClient.settings({skill:value});if(token===epoch&&session===agentState?.id)connectionError='';}
        catch(error){if(token===epoch&&session===agentState?.id&&!error.stale){connectionError=error.message;bridge.toast(error.message);}}
        finally{if(token===epoch&&session===agentState?.id){skillUpdating=false;skillSelection=null;drawPanels();}}
      };
      trigger.onclick=()=>setSkillMenu(menu.hidden);
      menu.onclick=event=>{const option=event.target.closest('[data-agent-skill-option]');if(!option)return;setSkillMenu(false);void updateSkill(option.dataset.agentSkillOption);host.querySelector('#directorMessage').focus({preventScroll:true});};
      host.querySelector('[data-agent-skill-remove]').onclick=()=>{setSkillMenu(false);void updateSkill('');host.querySelector('#directorMessage').focus({preventScroll:true});};
      document.addEventListener('pointerdown',event=>{if(!menu.hidden&&!picker.contains(event.target))setSkillMenu(false);},{signal:popoverEvents.signal});
      document.addEventListener('keydown',event=>{if(!menu.hidden&&event.key==='Escape'){event.preventDefault();setSkillMenu(false);trigger.focus({preventScroll:true});}},{signal:popoverEvents.signal});
    }
    attachmentPreviews=mountAttachmentPreviews(host.querySelector('[data-agent-attachments]'),{signal:popoverEvents.signal,onRemove:file=>{
      if(sending||switchingConversation)return;
      if(file.key.startsWith('media:'))attachments=attachments.filter(item=>item.id!==file.id);
      else documentAttachments=documentAttachments.filter((item,index)=>`document:${item.id||index}`!==file.key);
      drawPanels();host.querySelector('#directorMessage').focus({preventScroll:true});
    }});
    host.querySelector('[data-agent-upload]').onclick=async()=>{
      if(uploading||switchingConversation)return;
      const maxFiles=30-attachments.length-documentAttachments.length;
      if(maxFiles<=0){bridge.toast('一次最多添加 30 个文件');return;}
      const token=epoch,conversationId=agentState?.id;uploading=true;drawPanels();
      try{
        const selected=await bridge.uploadChatFile({maxFiles});
        if(token!==epoch||conversationId!==agentState?.id)return;
        for(const file of Array.isArray(selected)?selected:[selected]){
          if(!file||attachments.some(f=>f.id===file.id))continue;
          if(attachments.length+documentAttachments.length>=30){bridge.toast('一次最多添加 30 个文件');break;}
          attachments.push(file);
        }
      }
      catch(error){if(token===epoch&&!error.stale)bridge.toast(error.message);}
      finally{if(token===epoch){uploading=false;drawPanels();}}
    };
    const saveSettingsButton=host.querySelector('[data-agent-save-settings]');
    if(saveSettingsButton)saveSettingsButton.onclick=()=>void agentAction(()=>agentClient.settings({autoGenerate:host.querySelector('[data-agent-auto]').checked,generationBudgetCredits:Number(host.querySelector('[data-agent-budget]').value)}));
    host.querySelector('.dw-composer').onsubmit=e=>{e.preventDefault();const input=host.querySelector('#directorMessage'),selectedSkill=skillSelection??agentState?.settings?.skill??'',selected=agentConfig?.skills?.find(item=>item.name===selectedSkill);const text=input.value.trim()||(selectedSkill?(attachments.length||documentAttachments.length?`请根据我添加的文件，帮我完成${selected?.title||'创作'}。`:`我想进行${selected?.title||'创作'}，请告诉我需要提供什么。`):(attachments.length||documentAttachments.length?'请查看这些附件':''));if(text&&!uploading&&!switchingConversation&&!skillUpdating&&!preferenceUpdating&&agentState&&agentConfig?.configured){draft='';input.value='';resizeAgentComposer(input);void submit(text);}};
    host.querySelector('#directorMessage').value=draft;
    const composerInput=host.querySelector('#directorMessage');
    const closeMentions=bindDirectorMentions(composerInput,{items:()=>nodes().filter(n=>n.kind==='asset'||n.taskId),attach:id=>attachCanvasFiles([id]),signal:popoverEvents.signal});
    host.querySelector('[data-agent-new]').addEventListener('click',closeMentions);
    host.querySelector('[data-agent-history]').addEventListener('click',closeMentions);
    composerInput.addEventListener('input',()=>{resizeAgentComposer(composerInput);updateSendAvailability();});
    bindCreativePresets(host.querySelector('.dw-agent'),composerInput,{signal:popoverEvents.signal,isDisabled:()=>sending||uploading||switchingConversation||skillUpdating});
    composerInput.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!uploading&&!switchingConversation)host.querySelector('.dw-composer').requestSubmit();}};
    composerInput.addEventListener('focus',()=>host.querySelector('.dw-composer').classList.add('is-focused'));
    composerInput.addEventListener('blur',()=>host.querySelector('.dw-composer').classList.remove('is-focused'));
    resizeAgentComposer(composerInput);
    host.querySelector('.dw-canvas').addEventListener('dblclick',event=>{if(selected&&!event.target.closest('video,input,textarea,button')){inspectorOpen=true;drawInspector();}});
    host.querySelector('.director-workspace').addEventListener('keydown',handleCanvasDeleteKeydown,true);
    host.querySelector('.director-workspace').addEventListener('keydown',event=>{if(event.key==='Escape'){inspectorOpen=false;selected='';canvas.selectNodes([]);drawInspector();}});

    const toggleAgent=collapsed=>{if(bridge.agentMode){chatMode=collapsed?'minimized':'side';drawPanels();}else{host.querySelector('.director-workspace').classList.toggle('agent-collapsed',collapsed);host.querySelector('[data-show-agent]').hidden=!collapsed;} if(!collapsed)queueWorkspaceFrame(()=>composerInput.focus());};
    host.querySelector('[data-hide-agent]').onclick=()=>toggleAgent(chatMode!=='minimized');
    host.querySelector('[data-show-agent]').onclick=()=>toggleAgent(false);
    host.querySelector('[data-director-delegate]').onclick=()=>void agentAction(()=>agentClient.resume());
    host.querySelector('[data-director-stop]').onclick=()=>void agentAction(()=>agentClient.interrupt());
    const token=epoch;
    void readCanvasSnapshot(bridge.snapshotKey?.('agent')).then(cached=>{
      if(token!==epoch||agentState||!cached?.state?.id)return;
      agentState=cached.state;agentConfig=cached.config||null;
      lastAgentCacheSignature=JSON.stringify([cached.state.id,cached.state.version,cached.state.state,cached.state.settings,cached.state.messages?.length,cached.state.draft]);
      drawPanels();
    });
    agentClient=createCreativeAgentClient({api:bridge.agentApi,projectId:bridge.agentProjectId?.()??projectId,agentProjectId:bridge.creativeProjectId?.()||'',initialSessionId:bridge.initialSessionId?.()||'',initialSkill:bridge.initialSkill?.()||'',initialModelPreferences:bridge.initialModelPreferences?.(),onHistory:items=>{if(token===epoch){conversations=items;drawPanels();}},onState:(state,config)=>{
      if(token!==epoch)return;
      if(!state&&agentState?.id){agentConfig=config;drawPanels();return;}
      const firstReadySession=bridge.agentMode&&!agentReady&&Boolean(state?.id);
      const sessionChanged=state?.id!==agentState?.id;
      if(sessionChanged){
        if(!bridge.agentMode||firstReadySession)clearTimeout(saveTimer);
        if(firstReadySession)autoOpenedGenerations.clear();
        bridge.sessionChanged?.(state);
        if(firstReadySession&&canvas){
          syncing=true;
          try{
            canvas.deleteNodes(canvas.getState().nodes.map(node=>node.id));
            canvas.createNodes((workspace().canvasNodes||[]).filter(node=>!hiddenIds().has(node.id)),false);
            canvas.updateViewport(workspace().viewport);
          }finally{syncing=false;}
          selected='';activeGenerationId='';
        }
      }
      agentReady=Boolean(state?.id);
      agentState=state;agentConfig=config;connectionError=config.configured?'':'对话功能暂时无法使用，请稍后再试';
      if(bridge.agentMode&&(sessionChanged||firstReadySession))chatMode=hasSavedCanvasContent()?'side':'full';
      drawPanels();
      if(bridge.agentMode&&agentReady&&!initialMessageSent){initialMessageSent=true;const initial=bridge.initialMessage?.()||'',files=bridge.initialAttachments?.()||[],documents=bridge.initialDocuments?.()||[];attachments=files;documentAttachments=documents;if(initial||files.length||documents.length){if(config.configured)void submit(initial||(documents.length?'请参考我附带的文件继续创作。':''),attachments,[],documentAttachments);else {const input=host.querySelector('#directorMessage');input.value=initial||'请参考我附带的文件继续创作。';resizeAgentComposer(input);}}}
      if(state?.id){
        const signature=JSON.stringify([state.id,state.version,state.state,state.settings,state.messages?.length,state.draft]);
        if(signature!==lastAgentCacheSignature){lastAgentCacheSignature=signature;void writeCanvasSnapshot(bridge.snapshotKey?.('agent'),{state:{...state,project:null,tasks:[]},config});}
      }
    },onError:error=>{if(token===epoch&&!error.stale){connectionError=error.message;drawPanels();}}});
    void agentClient.start().catch(error=>{if(token===epoch){connectionError=error.message;drawPanels();}});
    drawPanels();
  }
  async function switchConversation(id){
    if(sending||uploading||switchingConversation||skillUpdating||preferenceUpdating)return;
    const token=epoch,client=agentClient,input=host.querySelector('#directorMessage'),previousDraft=input?.value;
    switchingConversation=true;
    try{drawPanels();await (id?client.open(id):client.newConversation());if(token!==epoch)return;host.querySelector('#directorHistoryPicker')?.hidePopover();historyOpen=false;attachments=[];documentAttachments=[];if(input&&input.value===previousDraft){input.value='';resizeAgentComposer(input);}connectionError='';}
    catch(error){if(token===epoch&&!error.stale){connectionError=error.message;bridge.toast(error.message);}}
    finally{if(token===epoch){switchingConversation=false;drawPanels();}}
  }
  function redrawComposer(){try{drawPanels();}catch(error){bridge.toast?.(error.message);}}
  async function drainSubmissions(){
    if(drainingSubmissions)return;
    drainingSubmissions=true;
    while(submissionQueue.length){
      const request=submissionQueue.shift();
      const token=epoch,client=agentClient,session=agentState?.id;
      const current=()=>token===epoch&&session===agentState?.id;
      sending=true;
      try{
        redrawComposer();
        await save();
        if(!current()){request.resolve?.();continue;}
        const mediaText=request.files.length?'\n\n附件：\n'+request.files.map(f=>`${f.name}（素材 ID：${f.id}）`).join('\n'):'';
        const documentText=request.documents.length?'\n\n附带文件：\n'+request.documents.map(file=>file.title).join('\n'):'';
        const content=request.text+mediaText+documentText;
        await client.send(content,[...new Set([...request.selectionIds,...request.files.map(f=>f.id)])],request.documents,request.modelPreferences);
        if(!current()){request.resolve?.();continue;}
        connectionError='';
        request.resolve?.();
      }catch(error){
        if(current()&&!error.stale){
          connectionError=error.message;
          const input=host.querySelector('#directorMessage');
          if(request.composerSend&&input&&!input.value){input.value=request.text;resizeAgentComposer(input);}
          if(request.composerSend&&request.files.length){
            const existing=new Set(attachments.map(file=>file.id));
            attachments=[...request.files.filter(file=>!existing.has(file.id)),...attachments];
          }
          if(request.composerSend&&request.documents.length){
            const existing=new Set(documentAttachments.map(file=>file.id));
            documentAttachments=[...request.documents.filter(file=>!existing.has(file.id)),...documentAttachments];
          }
          bridge.toast(error.message);
        }
        request.resolve?.();
      }finally{
        if(token===epoch){sending=false;redrawComposer();}
      }
    }
    drainingSubmissions=false;
    redrawComposer();
  }
  function submit(text,files=attachments,selectionIds=selected?[selected]:[],documents=files===attachments?documentAttachments:[],modelPreferences=agentState?.settings?.modelPreferences){
    if(uploading||switchingConversation||preferenceUpdating)return Promise.resolve();
    const composerSend=files===attachments&&documents===documentAttachments;
    const request={text:String(text||''),files:[...files],documents:[...documents],selectionIds:[...selectionIds],modelPreferences:normalizeModelPreferences(modelPreferences),composerSend};
    if(!request.text&&!request.files.length&&!request.documents.length)return Promise.resolve();
    // Snapshot and release attachments immediately so the next prompt can be
    // prepared while this one is being added to the conversation.
    if(composerSend){attachments=[];documentAttachments=[];}
    const promise=new Promise(resolve=>{request.resolve=resolve;submissionQueue.push(request);});
    void drainSubmissions();
    return promise;
  }
  function dispose(){
    generationApproval?.destroy();generationApproval=null;
    // Invalidate callbacks before disconnecting clients or unmounting React.
    epoch++;workspaceActive=false;
    workspaceFrames.forEach(frame=>cancelAnimationFrame(frame));workspaceFrames.clear();
    const surfaces=[...(mountedWorkspace?.querySelectorAll('canvas')||[])];
    releaseWorkspaceMedia(mountedWorkspace);
    if(canvasFocusFrame)cancelAnimationFrame(canvasFocusFrame);canvasFocusFrame=0;canvasContentReady=false;seenCanvasNodeIds.clear();pendingCanvasFocus.clear();automaticImageSizing.clear();generationMenuLayer?.remove();generationMenuLayer=null;generationMenuElement=null;clearEmptyEntry();host.querySelector('[data-conversation-loading]')?.remove();mediaLoadObserver?.disconnect();mediaLoadObserver=null;resizingChat=false;resizeCanvasSnapshot=null;if(resizeFinishFrame)cancelAnimationFrame(resizeFinishFrame);resizeFinishFrame=0;popoverEvents?.abort();messageScroller?.destroy();messageScroller=null;attachmentPreviews=null;messagePreviews=null;assetSizeLoads.forEach(image=>{image.onload=null;image.onerror=null;});assetSizeLoads.clear();assetImages.clear();assetSizes.clear();attachments=[];documentAttachments=[];uploading=false;sending=false;switchingConversation=false;skillUpdating=false;skillSelection=null;modelPreferencePicker=null;preferenceUpdating=false;activeGenerationId='';generationMenu='';generationUploading=false;generationSubmitting=false;generationCostSequence++;clearTimeout(generationCostTimer);submissionQueue.splice(0).forEach(request=>request.resolve?.());cancelAnimationFrame(streamFrame);streamFrame=0;visibleDraft='';targetDraft='';streamSession='';streamPacer.reset();settlingMessageId='';lastStreamTime=0;reasoning?.destroy();reasoning=null;resizeObserver?.disconnect();agentClient?.dispose();agentClient=null;agentState=null;agentConfig=null;agentReady=false;lastAgentCacheSignature='';connectionError='';conversations=[];historyOpen=false;stopped=true;busy=false;clearTimeout(saveTimer);if(edgeRenderFrame)cancelAnimationFrame(edgeRenderFrame);edgeRenderFrame=0;mainLayer?.off?.('.director-edges');mainLayer=null;nativeTransformer?.off?.('.director-edges');nativeTransformer=null;canvasMount?.unmount?.();canvasMount=null;canvas=null;
    // Clear backing stores after the canvas engine has saved its history and disposed.
    surfaces.forEach(surface=>{surface.width=0;surface.height=0;});
    mountedWorkspace?.remove();mountedWorkspace=null;
    projectId='';selected='';inspectorOpen=false;lastNodeGeometry='';}
  return {mount,refresh:drawPanels,dispose};
}
