import { createCancelledNodeCleanup } from './canvas-cancelled-cleanup.js?v=1';
import { createAgentAssetMetadataSync } from './agent-asset-metadata.js?v=1';
import { mountMediaNameEditor } from './media-name-editor.js?v=1';
import { mountProjectAssetsDrawer } from './project-assets.js?v=4';
import { isDocumentCard, documentCardMarkup, mountDocumentCard, documentDownload } from './document-card.js?v=3';
import { modelLogoMarkup } from '../../components/model-logo.js?v=5';
import { ImageCache, mapImagesWithLimit } from '../media/image-cache.js?v=1';
import { canvasImageUrl } from '../media/thumbnail-url.js?v=2';
import { cullOffscreenImages, isOffscreen } from './canvas-culling.js?v=1';

import { attachmentCardMarkup, mountAttachmentPreviews } from '../agent/attachment-preview.js?v=5';
import { mountGenerationApproval } from '../agent/generation-approval.js?v=2';
import { bindDirectorMentions } from './director-mentions.js?v=5';
import { importedImageBounds } from '../agent/image-bounds.js?v=1';
import { renderMarkdown, renderStreamingMarkdownBlocks } from '../agent/markdown.js?v=3';
import { copyButtonMarkup, mountContentCopy, patchCodeBlock } from '../agent/code-block.js?v=1';
import { createStreamPacer } from '../agent/stream-pacer.js?v=1';
import { createReasoningText, reasoningPhrases } from '../agent/reasoning-text.js?v=4';
import { createMessageScroller } from '../agent/message-scroller.js?v=5';
import { mediaFrameSize } from '../agent/frames.js?v=4';
import { placeCanvasNodes, placeCanvasRow, focusCanvasViewport, canvasNodeBounds } from './canvas-layout.js?v=2';
import { createCreativeAgentClient } from '../agent/client.js?v=13';
import { projectLoadingMarkup } from '../agent/project-loading.js?v=1';
import { readCanvasSnapshot, writeCanvasSnapshot } from './local-snapshot.js?v=1';
import { mountReferenceCanvas } from '../../vendor/director/reference-canvas.js?v=40';
import { normalizeDirectorWorkspace, persistCanvasSnapshot, applyDirectorEdit, fitDirectorViewport } from './director-actions.js?v=20';
import { canvasGenerationModels, canvasGenerationOptions, canvasGenerationPayload, canvasGenerationRatios, canvasGenerationModeLabels, canvasGenerationModeDescriptions, canvasGenerationModelIcon, canvasGenerationQualityLabel, canvasGenerationFrameSize, createCanvasGenerationDraft, reconcileCanvasGenerationDraft } from './canvas-generation.js?v=15';
import { generationFrameState, renderGenerationPlaceholder } from './generation-status.js?v=2';
import { generationPromptCodec, generationPromptMarkup, generationPromptSegments, removeGenerationMention, generationSelection, restoreGenerationSelection, bindGenerationRichPrompt } from './canvas-generation-editor.js?v=5';
import { canvasIcon } from './canvas-icons.js?v=1';
import { addGenerationReference, admitLinkedReference, hydrateGenerationReferences } from './canvas-generation-references.js?v=7';
import { addLink, removeLinks, normalizeLinks, inputLinks, isGenerator, isInlineGenerator, displayedResult, draftResults, primaryResult, generatorLabel, linkError, resolveGenerationInputs, generationRequestDraft, placeResults, linkCurve, entityKinds, migrateCanvasDrafts, foldedResults, FOLD_AFTER, uniqueEntityName, renameEntity } from './canvas-links.js?v=2';
import { mountCanvasConnector, rectAt } from './canvas-connect.js?v=3';
import { replayCanvasEdits, canReplay } from './canvas-ops.js?v=2';
import { mergeStoryboardDrafts } from './storyboard-drafts.js?v=6';
import { canvasMediaFiles, createCanvasMediaLibrary } from './canvas-media-library.js?v=3';
import { agentLogoMarkup, agentWelcomeHeroMarkup, creativePresetsMarkup, bindCreativePresets } from '../agent/welcome.js?v=1';
import { mountModelPreferencePicker } from '../agent/model-preference-picker.js?v=14';
import { normalizeModelPreferences } from '../agent/model-preferences.js?v=1';
import { bindProjectTitleEditor } from '../agent/project-title-editor.js?v=1';
import { mountCanvasContextMenu } from './canvas-context-menu.js?v=2';

// The canvas engine loads image nodes itself; let it request the display-sized copy.
globalThis.guguCanvasImageUrl=canvasImageUrl;

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
  // The engine re-enables rotation in setNodes, including multi-selection.
  // Keep the getter/setter contract while enforcing the workspace policy.
  if(typeof transformer.rotateEnabled==='function'){
    const rotate=transformer.rotateEnabled.bind(transformer);
    transformer.rotateEnabled=(...args)=>args.length?rotate(false):rotate();
    rotate(false);
  }
  const hasMedia=()=>transformer.nodes?.().some(node=>
    ['image','video'].includes(node.getAttr('$_type'))||['image','video'].includes(node.getAttr('$_actualType'))
  );
  const corners=['top-left','top-right','bottom-left','bottom-right'];
  // Read the current selection so native media and HTML video/image cards
  // stay proportional even when other selection handlers reset these options.
  if(typeof transformer.enabledAnchors==='function'){
    const anchors=transformer.enabledAnchors.bind(transformer);
    transformer.enabledAnchors=(...args)=>args.length?anchors(...args):hasMedia()?corners:anchors();
  }
  if(typeof transformer.keepRatio==='function'){
    const ratio=transformer.keepRatio.bind(transformer);
    transformer.keepRatio=(...args)=>args.length?ratio(...args):hasMedia()?true:ratio();
  }
  transformer.rotateLineVisible?.(false);
  transformer.borderDash?.([]);
  transformer.borderStrokeWidth?.(1.25);
  transformer.padding?.(3);
  transformer.anchorStroke?.(selectionColor);
  transformer.anchorFill?.('#ffffff');
  transformer.anchorSize?.(8);
  transformer.anchorStrokeWidth?.(1.25);
  transformer.anchorCornerRadius?.(2);
  transformer.anchorStyleFunc?.(anchor=>anchor.hitStrokeWidth(12));
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
  let canvas, canvasMount, projectId='', syncing=false, saveTimer, viewportPersistTimer, selected='', busy=false, stopped=false, epoch=0, draft='', layoutHistory=[], inspectorOpen=false;
  let chatMode=bridge.initialCanvasOpen?.()?'side':'full',initialMessageSent=false;
  let emptyEntry=null,emptyEntrySession='',disposeEmptyEntry=null;
  let mainLayer, nativeTransformer, lastNodeGeometry='', edgeRenderFrame=0, resizingChat=false, resizeCanvasSnapshot=null, resizeFinishFrame=0;
  let streamFrame=0, streamSession='', visibleDraft='', targetDraft='', lastStreamTime=0, resizeObserver, mediaLoadObserver;
  // settlingMessageId: a finished reply whose remaining text is still being revealed.
  let streamPacer=createStreamPacer(), settlingMessageId='', messageScroller=null, reasoning=null;
  let agentClient, agentState=null, agentConfig=null, agentReady=false, sending=false, switchingConversation=false, skillUpdating=false, skillSelection=null, modelPreferencePicker=null, preferenceUpdating=false, connectionError='', conversations=[], historyOpen=false;
  let lastAgentCacheSignature='', generationApproval=null;
  const syncAgentAssetMetadata=createAgentAssetMetadataSync({findFile:id=>bridge.canvasFile?.({assetId:id}),renameFile:(file,name)=>bridge.renameFile(file,name),current:()=>!stopped,onChange:()=>drawPanels(),onError:error=>bridge.toast(error.message)});
  let submissionQueue=[], drainingSubmissions=false;
  let attachments=[], documentAttachments=[], uploading=false, popoverEvents, attachmentPreviews, messagePreviews;
  let activeGenerationId='', generationUploading=false, generationSubmitting=false, generationCostSequence=0, generationCostTimer=0, generationMenu='', generationMenuLayer=null, generationMenuElement=null;
  const autoOpenedGenerations=new Set();
  let cancelledNodeCleanup=null,mediaNameEditor=null,projectAssetsDrawer=null,canvasLibrary=null,lastCanvasMediaSignature='',connector=null,linkPopup=null;
  let canvasContextMenu=null;
  let generationMentionEvents=null;
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

  const assetSizes=new Map(), assetSizeLoads=new Map(), assetImages=new ImageCache();
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
  // Older results of a node stay folded away until the user expands them.
  const foldedIds=()=>{
    const drafts=liveDrafts(),counts=new Map(),ids=new Set();
    for(const item of drafts)if(item.parentId&&item.taskId)counts.set(item.parentId,(counts.get(item.parentId)||0)+1);
    for(const item of drafts)if(!item.taskId&&(isInlineGenerator(item)||(counts.get(item.id)||0)>FOLD_AFTER))foldedResults(drafts,item,id=>bridge.task(id)).folded.forEach(id=>ids.add(id));
    return ids;
  };
  const canvasItems=()=>{const hidden=hiddenIds(),folded=foldedIds();return nodes().filter(item=>!hidden.has(item.id)&&!folded.has(item.id));};
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
  function removeCanvasInputEdges(ids) {
    const deleted=new Set(ids);
    const matches=link=>deleted.has(`edge-${link.id}`)||deleted.has(link.from)||deleted.has(link.to);
    for(const link of (workspace().links||[]).filter(matches)){
      const draft=generationDraft(link.to);
      if(draft)removeGenerationMention(draft,link.from,generationPromptView(draft));
    }
    const changed=removeLinks(workspace(),matches);
    if(changed)bridge.markCanvasDirty?.();
    return changed;
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
    removeCanvasInputEdges(selectedIds);
    event.preventDefault();
    event.stopPropagation();
    const deleted=canvas.deleteNodes(selectedIds);
    if(Array.isArray(deleted)&&deleted.length)scheduleCanvasSave();
  }
  function nodes() {
    const p=get(),imported=bridge.imported(),importedIds=new Set(imported.map(file=>file.id));return [...(agentState?.documents||[]).map(d=>({id:d.id,kind:'document',title:d.title,text:d.text,item:d})),...(agentState?.sourceObservations||[]).map(o=>({id:`source-${o.assetId}`,kind:'source-observation',title:`原片分析 · ${o.assetName}`,text:o.overview||'已记录原片时间线',item:o})),...(agentState?.sourceTranscripts||[]).map(t=>({id:t.id,kind:'source-transcript',title:`台词 · ${t.assetName}`,text:t.text||'未识别到台词',item:t})),...(agentState?.generations||[]).filter(g=>!g.attachedTo).map(g=>({id:g.canvasId||g.id,kind:'generation',title:g.title,text:'',taskId:g.id,item:g})),...(workspace().notes||[]).map(note=>({id:note.id,kind:'note',title:note.title||(note.role==='script'?'剧本':'文字'),text:note.text,item:note})),...(workspace().generationDrafts||[]).map(d=>({id:d.id,kind:'canvas-generation',title:d.title||(d.type==='image'?'图像生成':'视频生成'),text:d.prompt,taskId:d.taskId||displayedResult(workspace().generationDrafts,d)?.taskId,item:d})),...imported.map(f=>({id:f.id,kind:'asset',title:f.name||'参考素材',text:'已导入素材',item:f,media:f})),...(agentState?.audioAssets||[]).filter(f=>!importedIds.has(f.id)).map(f=>({id:f.id,kind:'asset',title:f.name||'提取音频',text:'提取的音轨',item:f,media:f})),...(agentState?.composedAssets||[]).filter(f=>!importedIds.has(f.id)).map(f=>({id:f.id,kind:'asset',title:f.name||'复刻成片',text:'已合成视频',item:f,media:f})),...((p.synopsis?.trim()||p.script?.trim())?[{id:'story',kind:'story',title:'剧本',text:p.script||p.synopsis,item:{}}]:[]),...p.resources.map(x=>({id:x.id,kind:'resource',title:x.name,text:x.description||x.prompt,item:x,taskId:x.selectedTaskId||x.versions?.at(-1)})),...p.shots.map((x,i)=>({id:x.id,kind:'shot',title:`${String(i+1).padStart(2,'0')} · ${x.title}`,text:x.script||x.prompt||'等待导演设计这一镜',item:x,taskId:x.selectedVideoTaskId||x.videoVersions?.at(-1)}))].map(node=>{const file=node.media||(node.taskId?bridge.canvasFile?.({taskId:node.taskId}):null);const name=workspace().projectAssets?.names?.[node.id]||workspace().projectAssets?.names?.[file?.id];return name?{...node,title:name}:node;});
  }
  function hasSavedCanvasContent() {
    const hidden=hiddenIds();
    return nodes().some(node=>!hidden.has(node.id))||workspace().canvasNodes.some(node=>node&&!hidden.has(node.id));
  }
  function position(n,i) {
    const saved=workspace().positions[n.id];if(saved)return saved;
    if(['document','source-observation','source-transcript','generation','canvas-generation','note'].includes(n.kind))return {x:40+i*320,y:-460};
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
    cullOffscreenImages(shape);
    shape.image(image);
    paintedAssetImages.set(shape,url);
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
  const queuedAssetLoads=new Map();
  const paintedAssetImages=new WeakMap();
  function finishAssetLoad(url,image){
    if(assetSizeLoads.get(url)!==image)return;
    assetSizeLoads.delete(url);
    const next=queuedAssetLoads.entries().next().value;
    if(next){queuedAssetLoads.delete(next[0]);loadAssetSize(next[1],next[0]);}
  }
  function pruneAssetImages(nodes){
    const urls=new Set((nodes||[]).map(node=>node.$_imageUrl).filter(Boolean));
    for(const url of assetImages.keys())if(!urls.has(url))assetImages.delete(url);
    for(const url of assetSizes.keys())if(!urls.has(url))assetSizes.delete(url);
    for(const url of queuedAssetLoads.keys())if(!urls.has(url))queuedAssetLoads.delete(url);
    for(const [url,image] of assetSizeLoads)if(!urls.has(url)){
      image.onload=null;image.onerror=null;image.src='';assetSizeLoads.delete(url);
    }
    while(assetSizeLoads.size<2&&queuedAssetLoads.size){
      const [url,id]=queuedAssetLoads.entries().next().value;
      queuedAssetLoads.delete(url);loadAssetSize(id,url);
    }
  }
  function loadAssetSize(id,url){
    if(assetSizeLoads.has(url))return;
    const shape=canvas?.getCanvasNodeById?.(id)?.getElement?.();
    if(assetSizes.has(url)&&(assetImages.has(url)||(shape&&paintedAssetImages.get(shape)===url)))return;
    if(assetSizeLoads.size>=2){queuedAssetLoads.set(url,id);return;}
    const token=epoch;
    const image=new Image();
    assetSizeLoads.set(url,image);
    image.onload=()=>{
      if(token!==epoch)return;
      finishAssetLoad(url,image);
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
    image.onerror=()=>finishAssetLoad(url,image);
    if(!url.startsWith('gugu-media://'))image.crossOrigin='anonymous';
    // Sizes keep the original aspect ratio; crop reloads the original first.
    const display=canvasImageUrl(url);
    if(display!==url)image.dataset.guguThumbnail='1';
    image.src=display;
  }
  // One layout for every card that describes something to make: characters,
  // locations, props and shots, whether made on the canvas or in older projects.
  function productionCard({id,icon,label,name,state='draft',status='',tone='idle',progress=null,media='',prompt='',placeholder='',foot=''}){
    const pill=status?`<span class="dw-node-status" data-tone="${tone}" role="status">${tone==='locked'?canvasIcon('lock'):'<i class="dw-node-dot" aria-hidden="true"></i>'}<span>${escape(status)}</span></span>`:'';
    const meter=progress===null?'':`<progress class="dw-node-progress" max="100" value="${progress}" aria-label="制作进度"></progress>`;
    return `<div class="dw-generation-frame dw-entity-card" data-state="${escape(state)}" data-card-id="${escape(id)}" aria-label="${escape(`${label}：${name}`)}"><span class="dw-frame-caption">${escape(name)}</span>${pill?`<header class="dw-node-head">${pill}</header>`:''}${media}<p class="dw-entity-prompt${prompt?'':' is-empty'}">${escape(prompt||placeholder)}</p>${foot?`<footer class="dw-gen-node-foot">${foot}</footer>`:''}${meter}</div>`;
  }
  // Every generated picture or clip uses the same frame, whoever asked for it.
  function resultFrame({state,kind,media,caption,progress,extra=''}){
    const body=media?`<${media.kind==='video'?'video controls playsinline preload="none"':'img'} ${media.kind==='video'?'data-preview-src':'data-canvas-src'}="${escape(media.url)}" ${media.kind==='image'?`alt="${escape(caption)}"`:''}>${media.kind==='video'?'</video>':''}`:renderGenerationPlaceholder(state,{kind,progress});
    return `<div class="dw-generation-frame dw-manual-frame" data-state="${escape(state)}" data-kind="${escape(kind)}" aria-label="${escape(caption)}">${body}${extra}<span class="dw-frame-caption">${escape(caption)}</span></div>`;
  }
  const entityIcons={character:'user-round',location:'map-pin',prop:'package'};
  const finishedStatuses=['completed','succeeded','failed','cancelled'];
  function generatorFoot(draft,drafts){
    const results=draftResults(drafts,draft.id);
    const running=results.filter(item=>!finishedStatuses.includes(bridge.task(item.taskId)?.status||item.status)).length;
    const inputs=inputLinks(workspace().links,draft.id).filter(link=>!hiddenIds().has(link.from)).length;
    const {folded,total}=foldedResults(drafts,draft,id=>bridge.task(id));
    const parts=[
      draft.status==='submitting'?'正在提交':running?`生成中 ${running} 个`:results.length?`已生成 ${results.length} 个`:'',
      inputs?`${inputs} 个输入`:'',
    ].filter(Boolean).map(text=>`<span>${escape(text)}</span>`);
    if(folded.length)parts.push(`<button type="button" class="dw-card-toggle" data-toggle-results="${escape(draft.id)}">展开较早的 ${folded.length} 个</button>`);
    else if(draft.expanded&&total>FOLD_AFTER)parts.push(`<button type="button" class="dw-card-toggle" data-toggle-results="${escape(draft.id)}">收起较早结果</button>`);
    return {html:parts.join(''),running};
  }
  function nodeContent(n) {
    const renamed=workspace().projectAssets?.names?.[n.id]||workspace().projectAssets?.names?.[n.taskId?bridge.canvasFile?.({taskId:n.taskId})?.id:''];
    if(isDocumentCard(n))return documentCardMarkup(n);
    const captionTrack=assetId=>assetId&&agentState?.id&&(agentState.sourceTranscripts||[]).some(item=>item.assetId===assetId&&item.cues?.length)?`<track kind="subtitles" src="/api/agent/sessions/${encodeURIComponent(agentState.id)}/captions/${encodeURIComponent(assetId)}.vtt" srclang="zh" label="台词" default>`:'';
    if(n.kind==='canvas-generation'){
      const draft=n.item,task=draft.taskId?bridge.task(draft.taskId):null,media=draft.taskId?bridge.media(draft.taskId):null;
      if(draft.taskId){
        const state=generationFrameState(task?.status||draft.status||'queued',Boolean(media));
        const parent=draft.parentId?generationDraft(draft.parentId):null;
        const caption=renamed||(parent?describeSource(draft.id)?.label||generatorLabel(parent):draft.title||String(draft.prompt||'').trim()||n.title);
        // A picture from a character, location or prop card can become its main picture.
        const primary=parent?.entity&&task?.status==='completed'?primaryResult(liveDrafts(),parent,id=>bridge.task(id))?.id===draft.id:null;
        const badge=primary===true?'<span class="dw-frame-badge">主图</span>':primary===false?`<button type="button" class="dw-frame-action" data-set-primary="${escape(draft.id)}">设为主图</button>`:'';
        return resultFrame({state,kind:draft.type,media,caption,progress:task?.progress,extra:badge});
      }
      if(isInlineGenerator(draft)){
        const output=displayedResult(liveDrafts(),draft);
        if(draft.status==='submitting'||output){
          const task=output&&bridge.task(output.taskId),media=draft.status==='submitting'?null:output&&bridge.media(output.taskId);
          const state=generationFrameState(draft.status==='submitting'?'queued':task?.status||output?.status||'queued',Boolean(media));
          return resultFrame({state,kind:draft.type,media,caption:renamed||(draft.status==='submitting'?draft.prompt:output?.prompt)||draft.prompt||n.title,progress:task?.progress});
        }
      }
      // Description cards keep their text and display results beside them.
      const drafts=liveDrafts(),foot=generatorFoot(draft,drafts);
      const meta=[draft.type==='video'&&draft.duration?`${draft.duration} 秒`:'',draft.aspect].filter(Boolean).join(' · ');
      const state=draft.status==='submitting'||foot.running?'processing':'draft';
      if(draft.entity){
        const main=primaryResult(drafts,draft,id=>bridge.task(id));
        const picture=main?bridge.media(main.taskId):null;
        return productionCard({id:draft.id,icon:entityIcons[draft.entity.kind],label:entityKinds[draft.entity.kind],name:draft.entity.name,state,
          media:picture?`<img class="dw-entity-picture" data-canvas-src="${escape(picture.url)}" alt="${escape(draft.entity.name)}">`:'',
          prompt:String(draft.prompt||'').trim(),placeholder:'选中后填写画面描述，生成这张卡片的图片',foot:foot.html});
      }
      if(draft.role==='shot')return productionCard({id:draft.id,icon:'clapperboard',label:'分镜',name:draft.title||'未命名分镜',state,status:meta,
        prompt:String(draft.prompt||'').trim(),placeholder:'选中后填写这一镜的画面、动作与台词',foot:foot.html});
      const prompt=String(draft.prompt||'').trim();
      const body=prompt?`<div class="dw-frame-script"><span class="dw-frame-script-meta">${escape([draft.title,meta].filter(Boolean).join(' · '))}</span><p>${escape(prompt)}</p></div>`:renderGenerationPlaceholder('draft',{kind:draft.type});
      return `<div class="dw-generation-frame dw-manual-frame${prompt?' has-script':''} dw-generator" data-state="draft" data-kind="${escape(draft.type)}" aria-label="${escape(generatorLabel(draft))}">${body}${foot.html?`<footer class="dw-gen-node-foot">${foot.html}</footer>`:''}</div>`;
    }
    if(n.kind==='asset'&&n.media?.kind==='image')return '';
    if(n.kind==='asset'&&n.media?.kind==='video')return `<div class="dw-generation-frame dw-imported-video" data-state="completed"><video controls playsinline preload="none" data-preview-src="${escape(n.media.url)}" aria-label="${escape(n.title)}">${captionTrack(n.media.id)}</video><span class="dw-frame-caption">${escape(n.title)}</span></div>`;
    if(n.kind==='asset'&&n.media?.kind==='audio')return `<div class="dw-generation-frame dw-imported-audio" data-state="completed"><span class="dw-audio-head"><span class="dw-audio-icon" aria-hidden="true">${canvasIcon('music')}</span><span class="dw-audio-name">${escape(n.title)}</span></span><audio controls preload="none" data-canvas-src="${escape(n.media.url)}" aria-label="${escape(n.title)}"></audio><span class="dw-frame-caption">${escape(n.title)}</span></div>`;
    if(n.kind==='generation'){
      const task=bridge.task(n.taskId),media=bridge.media(n.taskId);
      const status=n.item.placeholder?n.item.status:task?.status||'queued';
      return resultFrame({state:generationFrameState(status,Boolean(media)),kind:n.item.type,media,caption:n.title,progress:task?.progress});
    }
    // Characters, locations, props and shots from older projects.
    const t=bridge.task(n.taskId);const media=n.media||bridge.media(n.taskId);const action=workspace().plan?.actions?.find(a=>a.targetId===n.id&&['running','failed'].includes(a.status));
    const status=action?labels[action.status]:t?(labels[t.status]||t.status):'待制作';
    const locked=workspace().lockedIds.includes(n.id);
    const [kindIcon,kindLabel]=cardKind(n);
    const rawStatus=action?.status||t?.status||'';
    const tone=locked?'locked':cardTones[rawStatus]||(status==='待制作'?'idle':'done');
    const progress=tone==='active'&&Number(t?.progress)>0?Math.min(99,Math.round(Number(t.progress))):null;
    const state=tone==='active'?'processing':tone==='danger'?'failed':tone==='waiting'?'queued':'draft';
    const meta=n.kind==='shot'?`${n.item.duration} 秒 · ${n.item.aspectRatio} · ${n.item.videoVersions?.length||0} 个版本`:'';
    const picture=media?`<${media.kind==='video'?'video controls preload="none"':'img'} ${media.kind==='video'?'data-preview-src':'data-canvas-src'}="${escape(media.url)}" ${media.kind==='image'?`alt="${escape(n.title)}"`:''} class="dw-entity-picture">${media.kind==='video'?'</video>':''}`:'';
    return productionCard({id:n.id,icon:kindIcon,label:kindLabel,name:n.title,state,tone,progress,status:locked?'已锁定':`${status}${progress===null?'':` ${progress}%`}`,media:picture,
      prompt:String(n.kind==='resource'?n.text:n.item.script||n.item.prompt||n.text||'').trim(),placeholder:'双击填写画面描述',foot:meta?`<span>${escape(meta)}</span>`:''});
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
  // Three kinds of lines: the story layout of older projects, a generation
  // node to each of its results, and an input linked into a generation node.
  function edgeLinks() {
    const ns=canvasItems(),ids=new Set(ns.map(n=>n.id));
    const nativeIds=new Set((canvas?.getState?.().nodes||[]).map(node=>node.id));
    const present=id=>ids.has(id)||nativeIds.has(id);
    const story=ns.filter(n=>['resource','shot'].includes(n.kind)).map(n=>({id:`edge-${n.id}`,from:n.kind==='resource'?'story':(n.item.resourceIds?.find(id=>ns.some(x=>x.id===id))||'story'),to:n.id,style:'story'})).filter(edge=>ids.has(edge.from));
    const drafts=workspace().generationDrafts||[];
    const results=drafts.filter(item=>item.parentId&&ids.has(item.id)&&ids.has(item.parentId)).map(item=>({id:`edge-result-${item.id}`,from:item.parentId,to:item.id,style:'result'}));
    const inputs=normalizeLinks(workspace().links).filter(link=>present(link.from)&&ids.has(link.to)&&!hiddenIds().has(link.from)).map(link=>({id:`edge-${link.id}`,from:link.from,to:link.to,style:'input'}));
    return [...story,...results,...inputs];
  }
  const edgeStyles={
    story:{stroke:'#9b99c9',fill:'#9b99c9',strokeWidth:1.5,pointerLength:6,pointerWidth:6},
    result:{stroke:'#b9bbd3',fill:'#b9bbd3',strokeWidth:1.5,pointerLength:6,pointerWidth:6,dash:[6,6],bezier:true},
    input:{stroke:'#6366f1',fill:'#6366f1',strokeWidth:2,pointerLength:7,pointerWidth:7,bezier:true},
  };
  const edgePointsFor=(link,from,to)=>link.style==='story'?edgePoints(from,to):linkCurve(nodeRect(from),nodeRect(to));
  function nodeRect(node){
    const bounds=canvasNodeBounds(node);
    return {x:bounds.left,y:bounds.top,width:bounds.right-bounds.left,height:bounds.bottom-bounds.top};
  }
  // What a canvas node offers as an input: text, or a file to reference.
  function describeSource(id){
    const draft=generationDraft(id);
    const fileOf=(taskId,kind)=>{
      if(bridge.task(taskId)?.status!=='completed')return null;
      const file=bridge.canvasFile?.({taskId});
      return file?.id?{id:file.id,kind:file.kind||kind,name:file.name||'',url:bridge.media(taskId)?.url||file.previewUrl||file.url||''}:null;
    };
    if(draft){
      if(draft.taskId){
        const parent=draft.parentId&&generationDraft(draft.parentId);
        const siblings=parent?draftResults(liveDrafts(),parent.id):[];
        const primary=parent&&primaryResult(liveDrafts(),parent,taskId=>bridge.task(taskId));
        const label=parent?(primary?.id===draft.id?generatorLabel(parent):`${generatorLabel(parent)} ${siblings.indexOf(draft)+1}`):generatorLabel(draft);
        return {kind:draft.type,label,file:fileOf(draft.taskId,draft.type)};
      }
      const primary=primaryResult(liveDrafts(),draft,taskId=>bridge.task(taskId));
      return {kind:draft.type,label:generatorLabel(draft),file:primary?fileOf(primary.taskId,draft.type):null,generator:true};
    }
    const item=nodes().find(n=>n.id===id);
    if(item){
      if(item.kind==='story')return {kind:'text',label:'剧本',text:get().script||item.text};
      if(isDocumentCard(item))return {kind:'text',label:item.title,text:item.item?.text||item.text};
      if(item.kind==='asset'&&item.media?.kind){
        const file=bridge.canvasFile?.({assetId:item.id})||item.media;
        return {kind:item.media.kind,label:item.title,file:{id:item.id,kind:item.media.kind,name:item.title,url:file.previewUrl||item.media.url||''}};
      }
      const taskId=item.kind==='resource'?item.item.selectedTaskId||item.item.versions?.at(-1):item.kind==='generation'?item.taskId:'';
      if(taskId){const kind=bridge.task(taskId)?.type||bridge.media(taskId)?.kind||'image';return {kind,label:item.title,file:fileOf(taskId,kind)};}
      return null;
    }
    const native=canvas?.getNodeConfigById?.(id);
    if(native?.$_type==='rich-text'){
      const holder=document.createElement('div');holder.innerHTML=String(native.$_htmlContent||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|li|h[1-6])>/gi,'\n');
      return {kind:'text',label:'文字',text:holder.textContent.trim()};
    }
    if(['image','video'].includes(native?.$_type)&&native.$_assetId){
      const file=bridge.canvasFile?.({assetId:native.$_assetId});
      return {kind:native.$_type,label:file?.name||(native.$_type==='image'?'图片':'视频'),file:{id:native.$_assetId,kind:native.$_type,name:file?.name||'',url:native.$_type==='image'?native.$_imageUrl:native.$_videoUrl}};
    }
    return null;
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
    edgeLinks().forEach(link=>{
      const from=byId.get(link.from),to=byId.get(link.to);
      if(!from||!to)return;
      const points=edgePointsFor(link,from,to),id=link.id;
      if(persist&&canvas.getNodeConfigById(id))canvas.updateNodes([id],{points});
      const shape=findLayerNode(id);
      // The native arrow normalizer forces closed paths and theme colors.
      // Repair the live shape after every update so curves never fill or close.
      const scale=Math.abs(Number(canvas.getState().viewport?.scale)||1);
      const selected=(canvas.getState().selectedNodeIds||[]).includes(id);
      shape?.setAttrs?.({closed:false,fillEnabled:false,listening:true,draggable:false,hitStrokeWidth:14/scale,stroke:selected?'#4f46e5':edgeStyles[link.style].stroke,strokeWidth:edgeStyles[link.style].strokeWidth+(selected?1.5:0)});
      shape?.points?.(points);
    });
    mainLayer.batchDraw?.();
  }

  function scheduleEdgeRender() {
    if(edgeRenderFrame)return;
    edgeRenderFrame=queueWorkspaceFrame(()=>{edgeRenderFrame=0;renderEdges(liveCanvasNodes());});
  }
  const documentCards=new WeakMap();
  function bindDocumentCard(id,element){
    // Look up the project model only for document cards; rebuilding it for
    // every card made a full alignment pass quadratic in the node count.
    const card=element.querySelector('.dw-document-card');
    if(!card)return;
    const node=nodes().find(item=>item.id===id);
    if(!isDocumentCard(node))return;
    let controller=documentCards.get(card);
    if(!controller){
      const mountEpoch=epoch;
      controller=mountDocumentCard(card,{
        save:async(node,input)=>{
          // Text written on the canvas belongs to the project itself.
          if(node.kind==='note'){
            const note=(workspace().notes||[]).find(item=>item.id===node.id);
            if(!note)throw new Error('这张文字卡已被删除');
            Object.assign(note,{text:input.text.slice(0,60000),title:String(input.title||note.title).slice(0,160),revision:note.revision+1});
            await save();if(mountEpoch===epoch)syncCanvas();
            return {title:note.title,text:note.text,revision:note.revision};
          }
          if(node.kind==='story'){
            if(!await bridge.patch({script:input.text}))throw new Error('剧本未保存，请重试');
            if(mountEpoch===epoch)syncCanvas();
            return {title:'剧本',text:input.text};
          }
          const result=await bridge.agentApi(`/api/agent/sessions/${encodeURIComponent(node.item.conversationId||agentState.id)}/documents`,{method:'PATCH',body:JSON.stringify({id:node.id,...input})});
          if(mountEpoch===epoch){
            const current=agentState?.documents?.find(item=>item.id===node.id);
            if(current&&current.revision<=result.document.revision)Object.assign(current,result.document);
          }
          return result.document;
        },
        ask:async node=>{
          if(node.item.conversationId&&node.item.conversationId!==agentState?.id)await switchConversation(node.item.conversationId);
          if(mountEpoch!==epoch)return;
          host.querySelector('.director-workspace').classList.remove('agent-collapsed');
          if(bridge.agentMode)chatMode='side';
          drawPanels();
          const input=host.querySelector('#directorMessage');input.value=`修改「${node.title}」：`;resizeAgentComposer(input);input.focus();
        },
        copy:text=>navigator.clipboard.writeText(text),
        download:(node,text)=>{
          const file=documentDownload(node,text),url=URL.createObjectURL(new Blob([file.text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');
          link.href=url;link.download=`${node.title.replace(/[\\/:*?"<>|]/g,'_')}.${file.extension}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        },
      });
      documentCards.set(card,controller);
    }
    controller.update(node,workspace().lockedIds.includes(id));
  }
  function forwardCanvasMediaWheel(event) {
    const onVideo=event.target?.closest?.('video')||(event.composedPath?.()||[]).some(node=>node?.tagName==='VIDEO');
    const documentCard=event.target?.closest?.('.dw-document-card');
    if((!onVideo&&!documentCard)||!canvas)return;
    // Editing long text needs its own scroll; zoom gestures still belong to the canvas.
    if(!onVideo&&documentCard?.classList?.contains('is-editing')&&event.target?.closest?.('[data-document-body]')&&!event.ctrlKey)return;
    const surface=canvas.getStage()?.content;
    if(!surface)return;
    event.preventDefault();
    event.stopPropagation();
    surface.dispatchEvent(new event.constructor('wheel',{
      bubbles:true,cancelable:true,
      deltaX:event.deltaX,deltaY:event.deltaY,deltaZ:event.deltaZ,deltaMode:event.deltaMode,
      clientX:event.clientX,clientY:event.clientY,screenX:event.screenX,screenY:event.screenY,
      ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey,metaKey:event.metaKey,
    }));
  }
  function forwardCanvasDocumentPan(event) {
    if(!canvas||!event.target?.closest?.('.dw-document-card'))return;
    if(canvas.getToolType?.()!=='hand'&&event.button!==1)return;
    const surface=canvas.getStage()?.content;
    if(!surface)return;
    event.stopPropagation();
    if(event.type!=='pointerdown')event.preventDefault();
    surface.dispatchEvent(new event.constructor(event.type,{
      bubbles:true,cancelable:true,
      clientX:event.clientX,clientY:event.clientY,screenX:event.screenX,screenY:event.screenY,
      button:event.button,buttons:event.buttons,
      ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey,metaKey:event.metaKey,
      pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary,
      touches:event.touches,targetTouches:event.targetTouches,changedTouches:event.changedTouches,
    }));
  }
  function alignCard(id,html,geometryOnly=false) {
    const node=canvas.getCanvasNodeById(id),element=node?.htmlElement,shape=node?.getElement?.();
    if(!element||!shape)return;
    if(html!==undefined&&element.dataset.content!==html){releaseWorkspaceMedia(element);element.innerHTML=html;element.dataset.content=html;}
    if(!geometryOnly)bindDocumentCard(id,element);
    if(!geometryOnly)element.querySelectorAll('[data-canvas-src]').forEach(media=>{
      if(mediaLoadObserver)mediaLoadObserver.observe(media);
      else {media.src=media.tagName==='IMG'?canvasImageUrl(media.dataset.canvasSrc):media.dataset.canvasSrc;delete media.dataset.canvasSrc;if(media.tagName==='VIDEO')media.preload='metadata';}
    });
    // HtmlNode already synchronizes this element from getClientRect() on
    // viewport/drag/transform events. Do the same here when content changes. Applying
    // getAbsoluteTransform() as a CSS matrix on top of the core's left/top
    // writes double-applies the viewport translation, making cards jump away
    // from their Konva hit rectangle while dragging.
    const rect=shape.getClientRect();
    Object.assign(element.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`,transformOrigin:'0 0',transform:'none'});
    // Cards far outside the window keep their box but skip rendering content.
    const stage=canvas.getStage?.();
    if(stage)element.classList?.toggle('dw-offscreen',isOffscreen(rect,stage.width(),stage.height()));
    if(!geometryOnly)element.querySelectorAll('video').forEach(video=>{
      // Forward gestures on the picture to Konva; reserve the bottom 48 CSS
      // pixels for native playback controls (their shadow DOM is opaque),
      // except when the hand tool or middle button explicitly requests panning.
      if(video.dataset.canvasPlayback)return;
      video.dataset.canvasPlayback='true';
      ['pointerdown','mousedown','touchstart','click','dblclick','keydown','keyup'].forEach(type=>video.addEventListener(type,event=>{
        event.stopPropagation();
        const point=event.touches?.[0]||event;
        const rect=video.getBoundingClientRect();
        const panning=canvas.getToolType?.()==='hand'||event.button===1;
        const onPicture=panning||(Number.isFinite(point.clientY)&&point.clientY<rect.bottom-48);
        if(onPicture&&['pointerdown','mousedown','touchstart'].includes(type)){
          const surface=canvas.getStage().content;
          // The engine starts middle-button drags on the stage container
          // and finishes them on window, so the forwarded event must bubble.
          const forwarded=new event.constructor(type,{...event,bubbles:true,cancelable:true,
              clientX:event.clientX,clientY:event.clientY,screenX:event.screenX,screenY:event.screenY,
              button:event.button,buttons:event.buttons,
              ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey,metaKey:event.metaKey,
              pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary,
              touches:event.touches,targetTouches:event.targetTouches,changedTouches:event.changedTouches,
            });
          surface.dispatchEvent(forwarded);
          if(type!=='pointerdown')event.preventDefault();
        }else if(type==='pointerdown'&&selected!==id){
          canvas.selectNodes([id]);
        }
        if(onPicture&&(type==='click'||type==='dblclick'))event.preventDefault();
      },{passive:false}));
    });
    const frame=element.querySelector('.dw-generation-frame');
    // Character, location and prop cards keep their own layout around the picture.
    if(frame&&!geometryOnly&&!frame.classList.contains('dw-entity-card')){
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
      const documentCard=content.classList.contains('dw-document-card');
      if(frame||documentCard)Object.assign(content.style,{width:`${logicalWidth}px`,height:`${logicalHeight}px`});
      // Cards have a fixed 280 x 228 layout. Scale that entire layout with
      // the Konva rectangle; frame content instead grows to its live size.
      const contentWidth=frame||documentCard?logicalWidth:280;
      const contentHeight=frame||documentCard?logicalHeight:228;
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
  function alignCards(){if(!canvas)return;nodes().forEach(n=>alignCard(n.id));mediaNameEditor?.update();}
  // Panning and zooming move cards without changing their content; skip media
  // and document binding, which only matter when a card's HTML is replaced.
  function alignCardGeometry(){if(!canvas)return;nodes().forEach(n=>alignCard(n.id,undefined,true));mediaNameEditor?.update();}
  function fitCanvas(ids){
    if(!canvas)return;
    const surface=canvas.getContainer();
    const list=canvas.getState().nodes.filter(n=>!String(n.id).startsWith('edge-')&&(!ids||ids.includes(n.id)));
    const viewport=fitDirectorViewport(list,visibleCanvasWidth(surface),surface.clientHeight);
    if(viewport){canvas.updateViewport(viewport);queueWorkspaceFrame(alignCards);}
  }
  function canvasView(){
    const surface=canvas.getContainer();
    return {viewport:canvas.getState().viewport,width:visibleCanvasWidth(surface),height:surface.clientHeight};
  }
  // The conversation floats over the canvas, so fitting and placement use only
  // the part of the surface it leaves uncovered.
  function visibleCanvasWidth(surface){
    const width=surface.clientWidth,agent=host.querySelector('.dw-agent');
    if(!bridge.agentMode||chatMode!=='side'||!agent)return width;
    const overlap=surface.getBoundingClientRect().right-agent.getBoundingClientRect().left;
    return overlap>0?Math.max(width/2,width-overlap):width;
  }
  // The assistant's canvas edits arrive with the conversation state. Apply the
  // ones this canvas has not seen; the server replays the same edits onto any
  // save that reaches it first, so neither side loses the other's changes.
  function applyAgentCanvasEdits(){
    const remote=agentState?.canvas,config=generationConfig();
    if(!agentReady||!canvas||!remote||!config.videoCapabilities?.models?.length)return;
    const latest=Number(remote.editSeq)||0,local=Number(workspace().editSeq)||0;
    if(latest<=local)return;
    const project=get(),edits=remote.canvasEdits||[];
    let touched=[];
    if(canReplay(edits,local)){
      const data={directorWorkspace:workspace(),assetIds:project.assetIds||[]};
      touched=replayCanvasEdits(data,edits).touched;
      project.assetIds=data.assetIds;
    }else{
      // Too far behind the log: take the saved canvas as it is.
      project.directorWorkspace=normalizeDirectorWorkspace(remote.directorWorkspace);
      project.assetIds=[...(remote.assetIds||[])];
      touched=(workspace().generationDrafts||[]).map(item=>item.id);
    }
    workspace().editSeq=latest;
    for(const id of touched){
      const draft=generationDraft(id);
      if(!draft||draft.taskId)continue;
      reconcileCanvasGenerationDraft(draft,config);
      // A linked picture needs a video mode that accepts references.
      const media=linkedGenerationInputs(draft).filter(item=>item.kind!=='text');
      if(draft.type==='video'&&draft.mode==='TEXT'&&media.length)try{admitLinkedReference(draft,media[0].kind,media.slice(1).map(item=>item.kind),config);}catch{}
    }
    syncCanvas();scheduleCanvasSave();
    highlightCanvasNodes(touched);
    if(activeGenerationId&&touched.includes(activeGenerationId))renderGenerationComposer();
  }
  function highlightCanvasNodes(ids){
    for(const id of ids){
      const element=canvas?.getCanvasNodeById?.(id)?.htmlElement?.firstElementChild;
      if(!element)continue;
      element.classList.remove('dw-agent-touched');void element.offsetWidth;element.classList.add('dw-agent-touched');
      globalThis.setTimeout?.(()=>element.classList.remove('dw-agent-touched'),2000);
    }
  }
  function applyAgentStoryboards(){
    const config=generationConfig();
    // Without the live model catalog the cards would fall back to arbitrary models.
    if(!agentReady||!agentState?.storyboards?.length||!config.videoCapabilities?.models?.length)return;
    const result=mergeStoryboardDrafts(workspace(),agentState.storyboards,{config});
    if(result.skipped)bridge.toast(`画布卡片已达上限，${result.skipped} 张分镜卡片未添加`);
    if(!result.changed)return;
    scheduleCanvasSave();
    if(result.added.length)focusNewCanvasContent(result.added);
    if(activeGenerationId&&!generationDraft(activeGenerationId)?.taskId)queueWorkspaceFrame(renderGenerationComposer);
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
    // Drawing tools already provide the user's chosen world coordinates.
    // Only incoming media needs automatic placement and viewport focus.
    const movable=fresh.filter(node=>['image','video'].includes(node.$_type));
    const ids=new Set(movable.map(node=>node.id));
    const placements=placeCanvasNodes(movable,{},liveCanvasNodes().filter(node=>!ids.has(node.id)),canvasView());
    syncing=true;
    try{Object.entries(placements).forEach(([id,position])=>canvas.updateNodes([id],position));}
    finally{syncing=false;}
    persistLiveCanvasState();scheduleCanvasSave();
    if(movable.length)focusNewCanvasContent(movable.map(node=>node.id));
    queueCanvasMediaLibrary();
  }
  function canvasMediaNameEntries(){
    if(!canvas)return [];
    const items=new Map(nodes().map(item=>[item.id,item]));
    return (canvas.getState().nodes||[]).flatMap(config=>{
      if(config.visible===false||hiddenIds().has(config.id))return [];
      const item=items.get(config.id),native=['image','video'].includes(config.$_type);
      const media=native?{kind:config.$_type,url:config.$_imageUrl||config.$_videoUrl}:item?.media||(item?.taskId?bridge.media(item.taskId):null);
      if(!media?.url||!['image','video','audio'].includes(media.kind))return [];
      const node=canvas.getCanvasNodeById(config.id),shape=node?.getElement?.();if(!shape)return [];
      let file=(config.$_assetId||item?.media?.id||item?.taskId?bridge.canvasFile?.({assetId:config.$_assetId||item?.media?.id,taskId:item?.taskId}):null)||item?.media;
      if(native&&file?.url&&![file.url,file.previewUrl,file.remoteUrl].includes(media.url))file=null;
      const name=workspace().projectAssets?.names?.[config.id]||workspace().projectAssets?.names?.[file?.id]||node.htmlElement?.querySelector('.dw-frame-caption')?.textContent||file?.name||item?.title||({image:'图片',video:'视频',audio:'音频'})[media.kind];
      return [{id:config.id,name,rect:shape.getClientRect(),native,file,media}];
    });
  }
  async function saveCanvasMediaName(id,name){
    const token=epoch,entry=canvasMediaNameEntries().find(item=>item.id===id);if(!entry)throw new Error('文件已移除');
    let file=entry.file;
    if(!file?.id&&canvasLibrary)file=await canvasLibrary.add({id,kind:entry.media.kind,url:entry.media.url,name:entry.name});
    if(token!==epoch)return;
    if(!file?.id)throw new Error('文件尚未就绪，请稍后重试');
    await bridge.renameFile(file,name);
    if(token!==epoch)return;
    workspace().projectAssets||={types:[],categories:{},collapsed:[],names:{}};
    const names=workspace().projectAssets.names||={};names[id]=name;names[file.id]=name;
    await save();if(token!==epoch)return;syncCanvas();mediaNameEditor?.update();
  }
  function projectAssetItems(){
    const drafts=workspace().generationDrafts||[],byId=new Map(drafts.map(draft=>[draft.id,draft])),hidden=hiddenIds();
    const entries=nodes().filter(node=>node.kind==='asset'||!hidden.has(node.id)).flatMap(node=>{
      const draft=node.kind==='canvas-generation'?node.item:null,parent=draft?.parentId?byId.get(draft.parentId):null;
      const entity=draft?.entity||parent?.entity,media=node.media||(node.taskId?bridge.media(node.taskId):null),file=(node.media?.id||node.taskId?bridge.canvasFile?.({assetId:node.media?.id,taskId:node.taskId}):null)||media,url=media?.previewUrl||media?.url;
      if(!url||!['image','video','audio'].includes(file.kind))return [];
      return [{id:node.id,assetId:file.id||'',name:workspace().projectAssets?.names?.[node.id]||workspace().projectAssets?.names?.[file.id]||entity?.name||file.name||node.title||'未命名资产',kind:file.kind,url,category:entity?.kind||(node.kind==='resource'?node.item.type:file.category||'')}];
    });
    const known=new Set(entries.map(item=>item.id));
    for(const file of canvasLibraryMedia())if(!known.has(file.id)){entries.push({id:file.id,assetId:file.assetId||'',name:workspace().projectAssets?.names?.[file.id]||workspace().projectAssets?.names?.[file.assetId]||file.name,kind:file.kind,url:file.url,category:file.category});known.add(file.id);}
    const seen=new Set(),metadata=new Map((agentState?.assetMetadata||[]).map(item=>[item.id,item]));
    return entries.filter(item=>{const key=item.assetId||item.url||item.id;if(seen.has(key))return false;seen.add(key);return true;}).map(item=>{const saved=metadata.get(item.assetId)||metadata.get(item.id);return saved?{...item,name:saved.name,category:saved.category}:item;});
  }
  function canvasLibraryMedia(){
    return canvasMediaFiles(canvas?.getState(),nodes().map(item=>({...item,media:item.media||bridge.media(item.taskId)})),hiddenIds());
  }
  function queueCanvasMediaLibrary(){
    if(!canvasLibrary)return;
    const signature=canvasLibraryMedia().map(item=>`${item.id}:${item.url}:${item.assetId||''}`).join('|');
    if(signature===lastCanvasMediaSignature)return;
    lastCanvasMediaSignature=signature;
    void syncCanvasMediaLibrary().catch(error=>{if(signature===lastCanvasMediaSignature)lastCanvasMediaSignature='';if(!error.stale)bridge.toast(error.message);});
  }
  async function syncCanvasMediaLibrary(){
    if(!canvasLibrary)return;
    const token=epoch,library=canvasLibrary;
    for(const media of canvasLibraryMedia()){
      const file=await library.add(media);
      if(token!==epoch||canvasLibrary!==library||!canvas)return;
      const current=canvas.getNodeConfigById(media.id);
      const urlKey=media.kind==='video'?'$_videoUrl':'$_imageUrl';
      if(!current||hiddenIds().has(media.id)||(current[urlKey]&&current[urlKey]!==media.url))continue;
      // Managed HTML cards already point at their library files. Only native
      // media needs its temporary source replaced with a durable library URL.
      if(!['image','video'].includes(current.$_type))continue;
      const url=file.url||media.url;
      if(current.$_assetId===file.id&&current[urlKey]===url)continue;
      const previousSyncing=syncing;syncing=true;
      try{canvas.updateNodes([media.id],{$_assetId:file.id,[urlKey]:url});}
      finally{syncing=previousSyncing;}
      persistLiveCanvasState();scheduleCanvasSave();
    }
  }
  function canvasItemSize(node){
    if(isDocumentCard(node))return {width:400,height:360};
    if(node.kind==='generation')return mediaFrameSize(node.item);
    if(node.kind==='canvas-generation')return canvasGenerationFrameSize(node.item.type,node.item.aspect);
    if(node.kind==='asset'&&node.media?.kind==='image'){
      if(node.media.width>0&&node.media.height>0)return importedImageBounds(node.media);
      return assetBounds(node.media.url);
    }
    if(node.kind==='asset'&&node.media?.kind==='video'&&node.media.width>0&&node.media.height>0)return mediaFrameSize(node.media);
    return {width:280,height:228};
  }
  async function prepareImportedCanvasRow(files,token){
    return mapImagesWithLimit(files,async file=>{
      if(token!==epoch)return null;
      if(file.kind!=='image')return {id:file.id,...mediaFrameSize(file)};
      const url=file.previewUrl||file.url;
      if(url&&!assetImages.has(url)){
        const image=new Image(),display=canvasImageUrl(url);
        if(display!==url)image.dataset.guguThumbnail='1';
        image.src=display;
        try{
          await image.decode();
          if(token!==epoch)return null;
          assetImages.set(url,image);
          assetSizes.set(url,{width:image.naturalWidth,height:image.naturalHeight});
        }catch{}
      }
      const size=assetSizes.get(url)||(file.width>0&&file.height>0?file:null);
      return {id:file.id,...importedImageBounds(size)};
    }).then(items=>items.filter(Boolean));
  }
  async function importAssetIntoCanvas(point=null){
    try{
      const token=epoch;
      const existingIds=new Set(liveCanvasNodes().map(node=>node.id));
      const selected=await bridge.importAsset();
      if(token!==epoch)return;
      const files=(Array.isArray(selected)?selected:[selected]).filter(Boolean);
      if(!files.length)return;
      const ids=[...new Set(files.map(file=>file.id))];
      ids.forEach(revealCanvasItem);
      if(canvas){
        const newFiles=files.filter(file=>!existingIds.has(file.id));
        const items=await prepareImportedCanvasRow(newFiles,token);
        if(token!==epoch||!canvas)return;
        const newIds=new Set(items.map(item=>item.id));
        let rowX=point?.x;
        const placements=point?Object.fromEntries(items.map(item=>{
          const position={x:rowX,y:point.y,width:item.width,height:item.height};
          rowX+=item.width+32;
          return [item.id,position];
        })):placeCanvasRow(items,liveCanvasNodes().filter(node=>!newIds.has(node.id)),canvasView());
        Object.assign(workspace().positions,placements);
        const previousSyncing=syncing;syncing=true;
        try{
          for(const [id,position] of Object.entries(placements)){
            automaticImageSizing.delete(id);
            if(canvas.getNodeConfigById(id))canvas.updateNodes([id],position);
          }
        }finally{syncing=previousSyncing;}
        syncCanvas();
        canvas.selectNodes(ids);
        focusNewCanvasContent(ids);
        await save();
      }
    }catch(e){bridge.toast(e.message);}
  }
  function syncCanvas() {
    if(bridge.agentMode&&!agentReady)return;
    if(!canvas||syncing)return;
    if(migrateCanvasDrafts(workspace(),draft=>canvasGenerationFrameSize(draft.type,draft.aspect)))scheduleCanvasSave();
    syncing=true;
    const ns=canvasItems();const existing=new Map(canvas.getState().nodes.map(n=>[n.id,n]));
    const additions=[];
    const newItems=ns.filter(node=>!existing.has(node.id)).map(node=>({id:node.id,...canvasItemSize(node)}));
    const placements=placeCanvasNodes(newItems,workspace().positions,liveCanvasNodes(),canvasView());
    ns.filter(node=>placements[node.id]&&node.kind==='asset'&&node.media?.kind==='image').forEach(node=>automaticImageSizing.add(node.id));
    if(Object.keys(placements).length){Object.assign(workspace().positions,placements);clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save().catch(e=>bridge.toast(e.message)),600);}
    const links=edgeLinks();
    const valid=new Set([...ns.map(n=>n.id),...links.map(l=>l.id)]);
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
    links.forEach(l=>{const from=canvas.getNodeConfigById(l.from),to=canvas.getNodeConfigById(l.to);if(!from||!to)return;const id=l.id;const config={id,$_type:'arrow',x:0,y:0,points:edgePointsFor(l,from,to),...edgeStyles[l.style],$_strokeColor:edgeStyles[l.style].stroke,closed:false,fillEnabled:false,$_listening:true,draggable:false,hitStrokeWidth:14};if(existing.has(id))canvas.updateNodes([id],config);else canvas.createNodes([config],false);canvas.moveNodesToBottom([id]);});
    syncing=false;
    pruneAssetImages(canvas.getState().nodes);
    renderEdges(canvas.getState().nodes);
    if(canvasContentReady){const fresh=additions.filter(node=>!existing.has(node.id));if(fresh.length)focusNewCanvasContent(fresh.map(node=>node.id));}
    canvasContentReady=true;
    projectAssetsDrawer?.update();
    mediaNameEditor?.update();
    cancelledNodeCleanup?.update();
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
    syncAgentAssetMetadata(agentState?.assetMetadata);
    const root=host.querySelector('.director-workspace');
    const messages=root?.querySelector('.dw-messages');
    if(!root||!messages)return;
    if(!drawConversationEntry(root))return;
    if(bridge.agentMode){
      applyAgentCanvasEdits();
      applyAgentStoryboards();
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
    if(host.querySelector('[data-gen-prompt]')?.dataset.composing!=='true'&&hydrateGenerationDraft(generationDraft(activeGenerationId)))renderGenerationComposer();
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
    if(isDocumentCard(n)){el.hidden=true;el.innerHTML='';return;}
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
  function hydrateGenerationDraft(draft){
    return hydrateGenerationReferences(draft,id=>{
      const file=bridge.canvasFile?.({assetId:id});
      return file?(bridge.messageAttachment?.(file)||file):null;
    });
  }
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
    upload:genIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>'),
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
    return `<span class="dw-gen-model-icon" aria-hidden="true">${src?modelLogoMarkup(src,{generation:true}):''}</span>`;
  };
  const bindGenModelIcons=root=>root?.querySelectorAll('img[data-gen-model-icon]').forEach(img=>{
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
    // The project bar and the conversation float above the canvas; keep the
    // composer in the space they leave open.
    const chromeRect=host.querySelector('.dw-project-chrome')?.getBoundingClientRect();
    const chromeBottom=chromeRect?.height?chromeRect.bottom-boardRect.top:0;
    const agentRect=bridge.agentMode&&chatMode==='side'?host.querySelector('.dw-agent')?.getBoundingClientRect():null;
    const width=agentRect?.width?Math.max(board.clientWidth/2,Math.min(board.clientWidth,agentRect.left-boardRect.left)):board.clientWidth;
    return {board,width,offsetX,offsetY,minTop:Math.max(12,offsetY+12,chromeBottom+10),maxBottom:Math.min(board.clientHeight-12,launcherTop-10)};
  }
  function positionGenerationComposer(){
    const panel=host.querySelector('.dw-generation-composer');
    if(!panel||panel.hidden||!canvas||!activeGenerationId)return;
    const shape=canvas.getCanvasNodeById(activeGenerationId)?.getElement?.();
    const bounds=generationBounds();
    if(!shape||!bounds)return;
    const {width:boardWidth,offsetX,offsetY,minTop,maxBottom}=bounds;
    const client=shape.getClientRect(),rect={x:client.x+offsetX,y:client.y+offsetY,width:client.width,height:client.height};
    const type=generationDraft(activeGenerationId)?.type,width=Math.min(type==='video'?680:600,boardWidth-24);
    panel.classList.toggle('is-narrow',width<500);
    panel.style.width=`${width}px`;
    panel.style.maxHeight=`${Math.max(160,maxBottom-minTop)}px`;
    const height=panel.offsetHeight;
    const left=Math.max(12,Math.min(boardWidth-width-12,rect.x+rect.width/2-width/2));
    const below=rect.y+rect.height+14,above=rect.y-height-14;
    // Prefer the space under the frame, then above it; when neither fits keep
    // the composer inside the visible area instead of covering the toolbar.
    const top=below+height<=maxBottom?below:above>=minTop?above:Math.max(minTop,Math.min(below,maxBottom-height));
    Object.assign(panel.style,{left:`${left}px`,top:`${top}px`});
    panel.dataset.placement=top===above?'top':'bottom';
    positionGenerationMenu();
  }
  function generationQualityChoice(draft,value){return draft.type==='image'&&draft.modelId==='midjourney'?String(value):canvasGenerationQualityLabel(draft,value).replace(/画质$/,'');}
  // Results the user deleted no longer count as a node's pictures.
  const liveDrafts=()=>{const hidden=hiddenIds();return (workspace().generationDrafts||[]).filter(item=>!hidden.has(item.id));};
  // Deleted nodes no longer feed anything linked from them.
  const describeInput=id=>hiddenIds().has(id)?null:describeSource(id);
  // Inputs linked into a generation node, in link order.
  function linkedGenerationInputs(draft){
    return inputLinks(workspace().links,draft.id).flatMap(link=>{
      const source=describeInput(link.from);
      return source?[{id:link.from,...source}]:[];
    });
  }
  // Linked pictures and clips can be mentioned in the description like files.
  function generationPromptView(draft,linked=linkedGenerationInputs(draft)){
    const extra=linked.filter(item=>item.kind!=='text'&&!draft.attachments.some(file=>file.id===item.id)).map(item=>({id:item.id,kind:item.kind,name:item.label,url:item.file?.url||''}));
    return extra.length?{...draft,attachments:[...draft.attachments,...extra]}:draft;
  }
  // Link `from` into the generation node `to`. Throws a readable reason.
  function connectNodes(from,to){
    const target=generationDraft(to),source=describeSource(from);
    const error=linkError(target,source&&{...source,id:from});
    if(error)throw new Error(error);
    if(inputLinks(workspace().links,to).some(link=>link.from===from))return false;
    if(source.kind!=='text'){
      const kinds=linkedGenerationInputs(target).filter(item=>item.kind!=='text').map(item=>item.kind);
      admitLinkedReference(target,source.kind,kinds,generationConfig());
      reconcileCanvasGenerationDraft(target,generationConfig());
    }
    addLink(workspace(),from,to);
    syncCanvas();scheduleCanvasSave();
    if(activeGenerationId===to)renderGenerationComposer();
    return true;
  }
  function disconnectNodes(from,to){
    const draft=generationDraft(to);
    const view=draft&&generationPromptView(draft);
    if(!removeLinks(workspace(),link=>link.from===from&&link.to===to))return;
    if(draft)removeGenerationMention(draft,from,view);
    syncCanvas();scheduleCanvasSave();
    if(activeGenerationId===to)renderGenerationComposer();
  }
  // Choose what an @ mention refers to: something already on the canvas, or a new file.
  function pickGenerationInput(draft,anchor){
    linkPopup?.dismiss?.();linkPopup?.remove();
    const linked=new Set(inputLinks(workspace().links,draft.id).map(link=>link.from));
    const candidates=canvasItems().map(item=>item.id).concat((canvas?.getState?.().nodes||[]).filter(node=>['image','video'].includes(node.$_type)&&node.$_assetId).map(node=>node.id))
      .filter((id,index,list)=>id!==draft.id&&list.indexOf(id)===index&&!hiddenIds().has(id))
      .map(id=>({id,source:describeSource(id)}))
      .filter(({id,source})=>source?.file?.url&&source.kind!=='text'&&!linkError(draft,{...source,id}))
      .sort((a,b)=>Number(linked.has(b.id))-Number(linked.has(a.id))||Number(Boolean(generationDraft(b.id)?.entity))-Number(Boolean(generationDraft(a.id)?.entity)));
    return new Promise(resolve=>{
      const picker=linkPopup=document.createElement('div');
      picker.id='canvasInputPicker';picker.className='wb-mention-picker dw-input-picker';picker.setAttribute('role','dialog');picker.setAttribute('aria-label','引用素材');
      const kindName={image:'图片',video:'视频',audio:'音频'};
      const kinds=Object.keys(kindName).filter(kind=>candidates.some(item=>item.source.kind===kind));
      picker.innerHTML=`<header><b>引用素材</b><button type="button" data-picker-close aria-label="关闭">${genIcons.x}</button></header><div class="dw-input-picker-body"><div class="wb-mention-options dw-input-kinds">${kinds.map(kind=>`<button type="button" data-picker-kind="${kind}" aria-expanded="false" aria-controls="canvasInputAssets">${genIcons[kind]||genIcons.image}<b>${kindName[kind]}</b><span class="dw-input-kind-arrow" aria-hidden="true">${genIcons.chevron}</span></button>`).join('')||'<div class="wb-mention-empty">暂无可引用的素材</div>'}<button type="button" data-picker-upload>${genIcons.upload}<b>上传文件</b></button></div><div id="canvasInputAssets" class="wb-mention-options dw-input-assets" role="group" aria-label="可引用素材" hidden></div></div>`;
      const position=()=>{
        const rect=anchor.getBoundingClientRect();
        picker.style.left=`${Math.max(8,Math.min(rect.left,window.innerWidth-picker.offsetWidth-8))}px`;
        picker.style.top=`${Math.max(8,Math.min(rect.top-picker.offsetHeight-8,window.innerHeight-picker.offsetHeight-8))}px`;
      };
      const positionSubmenu=kind=>{
        const submenu=picker.querySelector('.dw-input-assets');
        const rect=picker.getBoundingClientRect();
        const row=picker.querySelector(`[data-picker-kind="${kind}"]`).getBoundingClientRect();
        submenu.style.width=`${Math.min(300,window.innerWidth-16)}px`;
        submenu.style.maxHeight=`${Math.min(280,window.innerHeight-16)}px`;
        const width=submenu.offsetWidth,height=submenu.offsetHeight;
        const left=rect.right+width<=window.innerWidth-8?rect.right:rect.left-width;
        submenu.style.left=`${Math.max(8,Math.min(left,window.innerWidth-width-8))}px`;
        submenu.style.top=`${Math.max(8,Math.min(row.top,window.innerHeight-height-8))}px`;
      };
      let activeKind='';
      const showKind=kind=>{
        if(!kinds.includes(kind))return;
        if(activeKind===kind)return;
        activeKind=kind;
        const matches=candidates.filter(item=>item.source.kind===kind);
        const submenu=picker.querySelector('.dw-input-assets');
        submenu.hidden=false;
        submenu.innerHTML=matches.map(({id,source})=>`<button type="button" data-picker-id="${escape(id)}">${source.kind==='image'?`<img src="${escape(source.file.url)}" alt="">`:source.kind==='video'?`<video src="${escape(source.file.url)}" muted playsinline preload="metadata"></video>`:genIcons.audio}<b>${escape(source.label)}</b></button>`).join('')||'<div class="wb-mention-empty">没有匹配的素材</div>';
        picker.querySelectorAll('[data-picker-kind]').forEach(button=>button.setAttribute('aria-expanded',String(button.dataset.pickerKind===kind)));
        positionSubmenu(kind);
      };
      picker.querySelectorAll('[data-picker-kind]').forEach(button=>{
        button.addEventListener('pointerenter',()=>showKind(button.dataset.pickerKind));
        button.addEventListener('focus',()=>showKind(button.dataset.pickerKind));
        button.addEventListener('click',()=>showKind(button.dataset.pickerKind));
      });
      const signal=generationMentionEvents?.signal;
      let done=false;
      const abort=()=>close(null);
      const close=value=>{
        if(done)return;done=true;picker.remove();
        document.removeEventListener('pointerdown',outside,true);
        document.removeEventListener('scroll',onScroll,true);
        window.removeEventListener('resize',abort);
        signal?.removeEventListener('abort',abort);
        if(linkPopup===picker)linkPopup=null;
        resolve(value);
      };
      const onScroll=event=>{if(!picker.contains(event.target))close(null);};
      const outside=event=>{if(!picker.contains(event.target))close(null);};
      picker.addEventListener('click',event=>{
        if(event.target.closest('[data-picker-close]'))close(null);
        else if(event.target.closest('[data-picker-upload]'))close('upload');
        else{const option=event.target.closest('[data-picker-id]');if(option)close(option.dataset.pickerId);}
      });
      picker.addEventListener('keydown',event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(null);anchor?.focus();return;}
        const button=document.activeElement;
        if(event.key==='ArrowDown'&&button===picker){event.preventDefault();picker.querySelector('[data-picker-kind],[data-picker-upload]')?.focus();return;}
        if(event.key==='ArrowRight'&&button?.dataset.pickerKind){event.preventDefault();picker.querySelector('[data-picker-id]')?.focus();}
        if(event.key==='ArrowLeft'&&button?.dataset.pickerId){event.preventDefault();picker.querySelector(`[data-picker-kind="${activeKind}"]`)?.focus();}
        if(['ArrowDown','ArrowUp'].includes(event.key)){
          const buttons=[...button?.closest('.wb-mention-options')?.querySelectorAll('button')||[]];
          if(buttons.length){event.preventDefault();buttons[(buttons.indexOf(button)+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}
        }
      });
      document.body.append(picker);
      document.addEventListener('pointerdown',outside,true);
      document.addEventListener('scroll',onScroll,true);
      window.addEventListener('resize',abort);
      signal?.addEventListener('abort',abort,{once:true});
      position();
      picker.tabIndex=-1;picker.focus({preventScroll:true});
    });
  }
  // Everything a person can add to the canvas, and what each one is.
  const createOptions=[
    {kind:'script',label:'剧本',icon:'book-open'},{kind:'text',label:'文字',icon:'file-text'},
    {kind:'character',label:'角色',icon:'user-round',type:'image'},{kind:'location',label:'场景',icon:'map-pin',type:'image'},{kind:'prop',label:'道具',icon:'package',type:'image'},
    {kind:'shot',label:'分镜',icon:'clapperboard',type:'video'},{kind:'image',label:'图像生成',icon:'image',type:'image'},{kind:'video',label:'视频生成',icon:'video',type:'video'},
  ];
  function worldPoint(client){
    const box=canvas.getContainer().getBoundingClientRect(),viewport=canvas.getState().viewport;
    return {x:(client.clientX-box.left-viewport.x)/viewport.scale,y:(client.clientY-box.top-viewport.y)/viewport.scale};
  }
  // A small menu at a screen point. Options that cannot take `from` as input
  // are left out, so a dropped link only offers nodes that accept it.
  function showCreateMenu(client,{from='',kinds=createOptions.map(item=>item.kind),at=null,label='新建',trigger=null}={}){
    if(!canvas)return;
    linkPopup?.dismiss?.();linkPopup?.remove();
    const source=from?describeInput(from):null;
    const options=createOptions.filter(item=>kinds.includes(item.kind)&&(!from||item.type&&source&&!linkError({id:'new',type:item.type},{...source,id:from})));
    if(!options.length)return;
    const menu=linkPopup=document.createElement('div');
    menu.className=trigger?'dw-link-menu dw-create-node-menu':'dw-link-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',label);
    menu.innerHTML=options.map(item=>`<button type="button" role="menuitem" data-create-kind="${item.kind}">${canvasIcon(item.icon)}<span>${escape(item.label)}</span></button>`).join('');
    const point=at||(client.world?worldPoint(client):null);
    let done=false;
    const close=()=>{if(done)return;done=true;menu.remove();if(linkPopup===menu)linkPopup=null;trigger?.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',onKey,true);window.removeEventListener('resize',close);};
    menu.dismiss=close;
    trigger?.setAttribute('aria-expanded','true');
    const outside=event=>{if(!menu.contains(event.target)&&!trigger?.contains(event.target))close();};
    const onKey=event=>{
      if(event.key==='Escape'){event.preventDefault();close();trigger?.focus({preventScroll:true});return;}
      if(event.key==='Tab'){close();return;}
      if(!['ArrowDown','ArrowUp'].includes(event.key))return;
      const items=[...menu.querySelectorAll('button')],index=items.indexOf(document.activeElement);
      event.preventDefault();items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
    };
    menu.addEventListener('click',event=>{const option=event.target.closest('[data-create-kind]');if(!option)return;close();createCanvasNode(option.dataset.createKind,{at:point,from});});
    document.body.append(menu);
    const left=client.anchor?client.anchor.left:client.clientX,top=client.anchor?client.anchor.top-menu.offsetHeight-8:client.clientY;
    Object.assign(menu.style,{left:`${Math.max(8,Math.min(left,window.innerWidth-menu.offsetWidth-8))}px`,top:`${Math.max(8,Math.min(top,window.innerHeight-menu.offsetHeight-8))}px`});
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',onKey,true);window.addEventListener('resize',close);
    menu.querySelector('button')?.focus();
  }
  // Dropping a link on empty canvas offers a new node there, already linked.
  function offerGenerationAt(from,client){
    showCreateMenu({...client,world:true},{from,label:'新建并连接'});
  }
  function nextName(label,taken){
    for(let index=1;;index++){const name=`${label} ${index}`;if(!taken.has(name))return name;}
  }
  function createCanvasNode(kind,{at=null,point=null,from=''}={}){
    if(!canvas)return;
    if(kind==='script'||kind==='text'){
      const notes=workspace().notes||=[];
      if(notes.length>=100){bridge.toast('文字卡数量已达上限');return;}
      const note={id:`canvas-note-${crypto.randomUUID()}`,role:kind==='script'?'script':'text',title:kind==='script'?'剧本':'文字',text:'',revision:1};
      notes.push(note);
      if(point)workspace().positions[note.id]={...point,width:400,height:360};
      else if(at)workspace().positions[note.id]={x:at.x,y:at.y-180,width:400,height:360};
      syncCanvas();canvas.selectNodes([note.id]);scheduleCanvasSave(true);
      queueWorkspaceFrame(()=>{const card=canvas?.getCanvasNodeById?.(note.id)?.htmlElement?.querySelector('.dw-document-card');if(card)documentCards.get(card)?.edit();});
      return;
    }
    const drafts=workspace().generationDrafts||[];
    if(Object.hasOwn(entityKinds,kind)){
      const name=nextName(entityKinds[kind],new Set(drafts.filter(item=>item.entity).map(item=>item.entity.name)));
      createGenerationArea('image',{at,point,from,focus:'name',setup:draft=>{draft.entity={kind,name};draft.aspect=kind==='location'?'16:9':kind==='prop'?'1:1':'3:4';}});
      return;
    }
    if(kind==='shot'){
      const title=nextName('分镜',new Set(drafts.filter(item=>item.role==='shot').map(item=>item.title)));
      createGenerationArea('video',{at,point,from,setup:draft=>{draft.role='shot';draft.title=title;}});
      return;
    }
    if(kind==='image'||kind==='video')createGenerationArea(kind,{at,point,from});
  }
  function toggleResults(id){
    const draft=generationDraft(id);
    if(!draft)return;
    draft.expanded=!draft.expanded;
    if(!draft.expanded)delete draft.expanded;
    syncCanvas();scheduleCanvasSave(true);
  }
  // Screen rectangles of nodes that can take part in a link, in drawing order.
  function linkableRects(){
    if(!canvas)return [];
    const hidden=hiddenIds();
    return (canvas.getState().nodes||[]).flatMap(node=>{
      if(String(node.id).startsWith('edge-')||hidden.has(node.id)||node.visible===false)return [];
      const shape=canvas.getCanvasNodeById?.(node.id)?.getElement?.()||findLayerNode(node.id);
      const rect=shape?.getClientRect?.();
      return rect&&rect.width>0&&rect.height>0?[{id:node.id,left:rect.x,top:rect.y,width:rect.width,height:rect.height}]:[];
    });
  }
  function setPrimaryResult(id){
    const result=generationDraft(id),parent=result?.parentId&&generationDraft(result.parentId);
    if(!parent||bridge.task(result.taskId)?.status!=='completed')return;
    parent.primaryId=id;
    // Cards showing the main picture and every node using it must redraw.
    syncCanvas();scheduleCanvasSave(true);
    bridge.toast(`已将这张设为「${generatorLabel(parent)}」的主图`);
  }
  async function attachGenerationReference(draft,loadFile){
    if(generationUploading||generationSubmitting||draft.taskId)return;
    const token=epoch,id=draft.id;generationUploading=true;closeGenerationMenu();renderGenerationComposer();
    try{
      const file=await loadFile(()=>token===epoch&&generationDraft(id)===draft&&!draft.taskId);
      if(token!==epoch||!file||generationDraft(id)!==draft||draft.taskId)return;
      addGenerationReference(draft,file,generationConfig());
      reconcileCanvasGenerationDraft(draft,generationConfig());resizeGenerationArea(draft);
      scheduleCanvasSave();
      return file;
    }catch(error){if(token===epoch&&!error.stale)bridge.toast(error.message);}
    finally{if(token===epoch){generationUploading=false;renderGenerationComposer();}}
  }
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
    generationMentionEvents?.abort();generationMentionEvents=null;
    const panel=host.querySelector('.dw-generation-composer');
    if(!panel)return;
    const draft=generationDraft(activeGenerationId);
    if(!draft||draft.taskId||hiddenIds().has(draft.id)){panel.hidden=true;panel.innerHTML='';renderGenerationMenu();return;}
    hydrateGenerationDraft(draft);
    reconcileCanvasGenerationDraft(draft,generationConfig());
    const options=canvasGenerationOptions(draft,generationConfig()),models=canvasGenerationModels(draft.type,generationConfig());
    const currentModel=models.find(item=>item.id===draft.modelId);
    const video=draft.type==='video',firstLast=video&&draft.mode==='FIRST&LAST';
    const prompt=panel.querySelector('[data-gen-prompt]'),promptFocus=prompt&&document.activeElement===prompt?generationSelection(prompt):null;
    const busy=generationSubmitting||generationUploading;
    const linked=linkedGenerationInputs(draft);
    const linkedChips=linked.map(item=>{
      const thumb=item.kind==='image'&&item.file?.url?`<img src="${escape(item.file.url)}" alt="">`:item.kind==='video'&&item.file?.url?`<video src="${escape(item.file.url)}" muted playsinline preload="metadata"></video>`:`<span class="dw-gen-reference-icon" aria-hidden="true">${item.kind==='text'?canvasIcon('file-text'):genIcons[item.kind]||genIcons.image}</span>`;
      const note=item.kind!=='text'&&!item.file?'<span class="dw-gen-reference-note">未生成</span>':'';
      return `<span class="dw-gen-reference is-linked${note?' is-pending':''}" title="${escape(item.label)}"><span class="dw-gen-reference-preview">${thumb}<button type="button" class="dw-gen-reference-remove" data-gen-unlink="${escape(item.id)}" aria-label="移除${escape(item.label)}" title="移除">${genIcons.x}</button></span>${note}</span>`;
    }).join('');
    const references=draft.attachments.map((file,index)=>{
      const label=firstLast?index===0?'首帧':'尾帧':file.name;
      const thumb=file.kind==='image'&&file.url?`<img src="${escape(file.url)}" alt="">`:file.kind==='video'&&file.url?`<video src="${escape(file.url)}" muted playsinline preload="metadata"></video>`:`<span class="dw-gen-reference-icon" aria-hidden="true">${genIcons[file.kind]||genIcons.image}</span>`;
      return `<span class="dw-gen-reference${firstLast?' is-frame':''}" title="${escape(file.name)}"><span class="dw-gen-reference-preview">${thumb}<button type="button" class="dw-gen-reference-remove" data-gen-remove="${escape(file.id)}" aria-label="移除${escape(label)}" title="移除">${genIcons.x}</button></span>${firstLast?`<span class="dw-gen-reference-name">${escape(label)}</span>`:''}</span>`;
    }).join('')+linkedChips;
    // Keep the frame positions visible when choosing a first and last frame.
    const slotLabel=firstLast&&draft.attachments.length<2?draft.attachments.length?'添加尾帧':'添加首帧':'';
    const slot=slotLabel?`<button type="button" class="dw-gen-slot" data-gen-upload ${busy?'disabled':''}>${generationUploading?genIcons.loader:genIcons.plus}<span>${generationUploading?'正在上传':slotLabel}</span></button>`:'';
    const chip=(name,icon,label,aria,extra='')=>`<button type="button" class="dw-gen-chip${extra}" data-gen-menu="${name}" aria-haspopup="${name==='params'?'dialog':'listbox'}" aria-expanded="false" aria-label="${escape(aria)}" title="${escape(aria)}">${icon}<span class="dw-gen-chip-label">${escape(label)}</span><span class="dw-gen-chip-caret">${genIcons.chevron}</span></button>`;
    const modelLabel=currentModel?.label||draft.modelId||'选择模型';
    const modelChip=chip('model',genModelIcon(currentModel||{id:draft.modelId}),modelLabel,`模型：${modelLabel}`,' is-model');
    const modeLabel=canvasGenerationModeLabels[draft.mode]||draft.mode;
    const modeChip=video&&options.modes.length?chip('mode',`<span class="dw-gen-mode-icon" aria-hidden="true">${genIcons[draft.mode]||genIcons.video}</span>`,modeLabel,`生成方式：${modeLabel}`):'';
    const summary=[draft.aspect,draft.quality?canvasGenerationQualityLabel(draft,draft.quality):'',video?draft.duration?`${draft.duration} 秒`:'':`${draft.quantity} 张`].filter(Boolean).join(' · ');
    const paramsChip=chip('params',genRatioIcon(draft.aspect),summary||'参数设置',`生成参数：${summary}`,' is-params');
    const empty=!String(draft.prompt||'').trim()&&!linked.some(item=>item.kind==='text'&&String(item.text||'').trim());
    panel.dataset.genType=draft.type;
    panel.setAttribute('role','group');
    panel.setAttribute('aria-label',video?'视频生成':'图像生成');
    const results=isInlineGenerator(draft)?draftResults(liveDrafts(),draft.id):[];
    const output=displayedResult(liveDrafts(),draft);
    const resultField=results.length>1?`<label class="dw-gen-name"><span>生成结果</span><select data-gen-result aria-label="选择生成结果">${results.map((item,index)=>`<option value="${escape(item.id)}" ${item.id===output?.id?'selected':''}>第 ${index+1} 个 · ${escape(labels[bridge.task(item.taskId)?.status||item.status]||'等待制作')}</option>`).join('')}</select></label>`:'';
    const nameField=draft.entity?`<label class="dw-gen-name"><span>${escape(entityKinds[draft.entity.kind])}名称</span><input data-gen-name maxlength="40" value="${escape(draft.entity.name)}" autocomplete="off"></label>`:draft.role==='shot'?`<label class="dw-gen-name"><span>分镜标题</span><input data-gen-name maxlength="80" value="${escape(draft.title||'')}" autocomplete="off"></label>`:'';
    panel.innerHTML=`<div class="dw-gen-input">${nameField}${resultField}${references||slot?`<div class="dw-gen-references">${references}${slot}</div>`:''}<label class="dw-sr-only" for="canvasGenerationPrompt">画面描述</label><div id="canvasGenerationPrompt" class="dw-gen-rich-prompt" data-gen-prompt contenteditable="true" role="textbox" aria-multiline="true" aria-label="画面描述">${generationPromptMarkup(generationPromptView(draft,linked))}</div></div><div class="dw-gen-toolbar"><div class="dw-gen-options"><button type="button" class="dw-gen-attach" data-gen-upload aria-label="${video?'添加参考素材':'添加参考图片'}" title="${video?'添加参考素材':'添加参考图片'}" ${busy?'disabled':''}>${generationUploading?genIcons.loader:genIcons.paperclip}</button>${modelChip}${modeChip}${paramsChip}</div><button type="button" class="dw-gen-submit" data-gen-submit aria-label="${generationSubmitting?'正在开始生成':'开始生成'}" title="${empty?'请先填写画面描述':'开始生成（⌘/Ctrl + Enter）'}" ${busy||empty?'disabled':''} ${generationSubmitting?'aria-busy="true"':''}>${generationSubmitting?genIcons.loader:genIcons.sparkles}<span class="dw-gen-submit-label">${generationSubmitting?'正在开始':'生成'}</span><span class="dw-gen-price" data-gen-cost aria-live="polite">估算中…</span></button></div>`;
    panel.classList.toggle('is-uploading',generationUploading);
    panel.classList.toggle('is-submitting',generationSubmitting);
    bindGenModelIcons(panel);
    panel.hidden=false;
    const input=panel.querySelector('[data-gen-prompt]');
    {
      draft.promptSegments=generationPromptSegments(input);
      generationMentionEvents=new AbortController();
      const token=epoch;
      const current=()=>token===epoch&&activeGenerationId===draft.id&&generationDraft(draft.id)===draft&&!draft.taskId;
      bindGenerationRichPrompt(input,{
        type:draft.type,
        signal:generationMentionEvents.signal,
        getInput:()=>current()?panel.querySelector('[data-gen-prompt]'):null,
        pick:async()=>{
          if(!current())return null;
          const choice=await pickGenerationInput(draft,panel.querySelector('[data-gen-prompt]'));
          if(!choice||!current())return null;
          if(choice!=='upload'){
            try{connectNodes(choice,draft.id);}catch(error){bridge.toast(error.message);return null;}
            const item=linkedGenerationInputs(draft).find(entry=>entry.id===choice);
            return item&&current()?{label:item.label,file:{id:choice,kind:item.kind,name:item.label,url:item.file?.url||''}}:null;
          }
          const file=await attachGenerationReference(draft,async isCurrent=>{
            await syncCanvasMediaLibrary();
            if(!current()||!isCurrent())return null;
            const file=await bridge.uploadGenerationFile();
            return current()&&isCurrent()?file:null;
          });
          const reference=file&&draft.attachments.find(reference=>reference.id===file.id);
          return reference&&current()?{label:reference.name,file:reference}:null;
        },
      });
    }
    fitGenerationPrompt(input);
    if(promptFocus)restoreGenerationSelection(input,promptFocus);
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
    const counts={image:0,video:0,audio:0};resolveGenerationInputs(draft,workspace().links,describeInput).attachments.forEach(file=>{if(Object.hasOwn(counts,file.kind))counts[file.kind]++;});
    const request={modelId:draft.modelId,aspectRatio:draft.aspect,duration:Number(draft.duration),quality:draft.quality,generationType:draft.mode,referenceAssetIds:[],referenceCounts:counts};
    generationCostTimer=setTimeout(async()=>{
      try{
        const quote=await bridge.agentApi('/api/model-quote',{method:'POST',body:JSON.stringify(request)});
        if(sequence!==generationCostSequence)return;
        cost.innerHTML=`<b>${escape(format(quote.credits))}</b><small>积分</small>`;
      }catch{if(sequence===generationCostSequence)cost.textContent='暂不可估';}
    },160);
  }
  function createGenerationArea(type,{at=null,point=null,from='',setup=null,focus='prompt'}={}){
    if(!canvas)return;
    const draft=createCanvasGenerationDraft(type,generationConfig());
    if(!draft.modelId){bridge.toast('模型暂不可用，请稍后重试');return;}
    if(setup){setup(draft);reconcileCanvasGenerationDraft(draft,generationConfig());}
    workspace().generationDrafts=[...(workspace().generationDrafts||[]),draft];
    // `point` is a top-left corner (context menu); `at` is where a link was dropped.
    if(point)workspace().positions[draft.id]={...point,...canvasGenerationFrameSize(draft.type,draft.aspect)};
    else if(at){const size=canvasGenerationFrameSize(draft.type,draft.aspect);workspace().positions[draft.id]={x:at.x,y:at.y-size.height/2,...size};}
    if(from)try{connectNodes(from,draft.id);}catch(error){bridge.toast(error.message);}
    activeGenerationId=draft.id;
    syncCanvas();canvas.selectNodes([draft.id]);
    renderGenerationComposer();
    queueWorkspaceFrame(()=>{positionGenerationComposer();const field=host.querySelector(focus==='name'?'[data-gen-name]':'[data-gen-prompt]');field?.focus();if(focus==='name')field?.select?.();});
    scheduleCanvasSave(true);
  }
  // The request a generation node would send right now: its own settings and
  // description plus everything linked into it.
  function generationRequest(draft){
    const inputs=resolveGenerationInputs(draft,workspace().links,describeInput);
    if(inputs.missing.length)throw new Error(`「${inputs.missing[0]}」还没有生成好的画面，请先生成或移除这条连线`);
    return generationRequestDraft(draft,inputs);
  }
  async function submitGenerationArea(){
    const draft=generationDraft(activeGenerationId);
    if(!draft||draft.taskId||generationSubmitting)return;
    let payload,request;
    try{request=generationRequest(draft);payload=canvasGenerationPayload(request,generationConfig());}
    catch(error){bridge.toast(error.message);return;}
    const token=epoch;generationSubmitting=true;draft.status='submitting';renderGenerationComposer();syncCanvas();
    try{
      // References stay local until now; upload them only for this generation.
      if(request.attachments.length&&bridge.prepareCloudFiles){
        const ready=await bridge.prepareCloudFiles(request.attachments);
        if(token!==epoch)return;
        payload.referenceAssetIds=ready.map(file=>file.id);
      }
      if(payload.type==='video'){
        const counts={image:0,video:0,audio:0};request.attachments.forEach(file=>{if(Object.hasOwn(counts,file.kind))counts[file.kind]++;});
        const quote=await bridge.agentApi('/api/model-quote',{method:'POST',body:JSON.stringify({...payload,referenceCounts:counts})});
        if(quote.priceVersion)payload.expectedPriceVersion=quote.priceVersion;
      }
      const requestId=crypto.randomUUID();
      const result=await bridge.agentApi('/api/generations',{method:'POST',headers:{'Idempotency-Key':requestId},body:JSON.stringify({...payload,precheckSource:'agent',requestId})});
      if(token!==epoch)return;
      const tasks=Array.isArray(result?.tasks)?result.tasks:result?.id?[result]:[];
      if(!tasks.length)throw new Error('暂时无法开始生成，请重试');
      // Keep the generator editable; ordinary generators show their output in place.
      draft.status='';
      const size=canvasGenerationFrameSize(draft.type,draft.aspect);
      const parent=workspace().positions[draft.id]||{x:0,y:0,...size};
      // Folded results keep their place, so new ones never land on top of them.
      const obstacles=[...liveCanvasNodes().filter(node=>node.id!==draft.id&&!String(node.id).startsWith('edge-')&&node.visible!==false).map(nodeRect),
        ...draftResults(workspace().generationDrafts,draft.id).map(item=>workspace().positions[item.id]).filter(Boolean)];
      const inline=isInlineGenerator(draft);
      const places=inline?[]:placeResults(parent,tasks.map(()=>size),obstacles);
      const results=tasks.map(task=>({id:`canvas-gen-${crypto.randomUUID()}`,type:draft.type,prompt:request.prompt,promptSegments:[],modelId:draft.modelId,aspect:draft.aspect,quality:draft.quality,mode:draft.mode,duration:draft.duration,quantity:1,attachments:[],midjourney:{},taskId:task.id,status:task.status||'queued',parentId:draft.id}));
      if(!inline)results.forEach((item,index)=>{workspace().positions[item.id]=places[index];});
      if(inline)draft.primaryId=results.at(-1).id;
      workspace().generationDrafts.push(...results);
      if(draft.entity&&!draftResults(workspace().generationDrafts,draft.id).some(item=>item.id===draft.primaryId))draft.primaryId=results[0].id;
      const focusResults=draft.role==='shot'&&activeGenerationId===draft.id;
      if(focusResults){activeGenerationId='';closeGenerationMenu();}
      renderGenerationComposer();syncCanvas();
      if(focusResults){canvas?.selectNodes([results[0].id]);focusNewCanvasContent(results.map(item=>item.id));}
      scheduleCanvasSave(true);
      bridge.toast(tasks.length>1?`已开始生成 ${tasks.length} 个`:'已开始生成');
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
      if(bridge.saveProjectTitle)bindProjectTitleEditor(projectTitle,{title:()=>bridge.projectTitle?.()||'新项目',save:bridge.saveProjectTitle,toast:bridge.toast});
      host.querySelector('.director-workspace').prepend(projectChrome);
    }
    host.querySelectorAll('.dw-agent>header button,.dw-project-chrome button').forEach(button=>{
      const label=button.getAttribute('aria-label')||button.title||button.textContent.trim();
      button.dataset.tooltip=label;
      button.setAttribute('aria-label',label);
      button.removeAttribute('title');
    });
    host.querySelector('.dw-board').insertAdjacentHTML('beforeend',`<div class="dw-generation-composer" hidden></div><div class="dw-generation-dock"><div class="dw-generation-launcher"><button type="button" data-project-assets aria-haspopup="dialog" aria-expanded="false">${canvasIcon('package')}<span>项目资产</span></button></div><div class="dw-project-tools reference-canvas-host" role="toolbar" aria-label="画布工具"></div><div class="dw-generation-launcher"><button type="button" data-create-menu aria-haspopup="menu" aria-expanded="false"><span class="gugu-lucide gugu-lucide-plus" aria-hidden="true"></span><span>创建节点</span></button></div><button type="button" class="dw-agent-reopen" data-show-agent aria-label="打开对话" title="打开对话" hidden>${agentLogoMarkup}</button></div>`);
    const assetsEpoch=epoch;
    projectAssetsDrawer=mountProjectAssetsDrawer({
      board:host.querySelector('.dw-board'),trigger:host.querySelector('[data-project-assets]'),
      getState:()=>workspace().projectAssets,
      setState:async state=>{if(assetsEpoch!==epoch)return;workspace().projectAssets=state;await save();},
      items:projectAssetItems,
      importAssets:async()=>{const files=await bridge.importAsset({projectAssets:true});if(assetsEpoch!==epoch)return [];syncCanvas();return (Array.isArray(files)?files:[files]).filter(Boolean);},
      focusAsset:id=>{if(!canvas)return;revealCanvasItem(id);syncCanvas();canvas.selectNodes([id]);focusNewCanvasContent([id]);},
      toast:bridge.toast,icon:name=>name==='x'?genIcons.x:name==='plus'?'<span class="gugu-lucide gugu-lucide-plus" aria-hidden="true"></span>':canvasIcon(name),
    });
    const createTrigger=host.querySelector('[data-create-menu]');
    createTrigger.onclick=()=>{
      if(createTrigger.getAttribute('aria-expanded')==='true'){linkPopup?.dismiss?.();return;}
      showCreateMenu({anchor:createTrigger.getBoundingClientRect()},{label:'创建节点',trigger:createTrigger});
    };
    const generationPanel=host.querySelector('.dw-generation-composer');
    generationPanel.addEventListener('input',event=>{
      const draft=generationDraft(activeGenerationId);if(!draft)return;
      if(event.target.matches('[data-gen-name]')){
        if(draft.role==='shot'){draft.title=event.target.value.replace(/[\r\n]/g,' ').slice(0,80);syncCanvas();scheduleCanvasSave();}
        return;
      }
      if(event.target.matches('[data-gen-prompt]')){
        if(event.isComposing||event.target.dataset.composing==='true')return;
        const previousMentions=new Set((draft.promptSegments||[]).filter(segment=>typeof segment!=='string').map(segment=>segment.id));
        draft.prompt=generationPromptCodec.serialize(event.target);
        draft.promptSegments=generationPromptSegments(event.target);generationPromptCodec.normalizeEmpty(event.target);
        const mentions=new Set((draft.promptSegments||[]).filter(segment=>typeof segment!=='string').map(segment=>segment.id));
        const previousCount=draft.attachments.length;
        draft.attachments=draft.attachments.filter(file=>!previousMentions.has(file.id)||mentions.has(file.id));
        // Deleting the mention of a linked node removes that link as well.
        const unlinked=removeLinks(workspace(),link=>link.to===draft.id&&previousMentions.has(link.from)&&!mentions.has(link.from));
        fitGenerationPrompt(event.target);
        const linkedText=linkedGenerationInputs(draft).some(item=>item.kind==='text'&&String(item.text||'').trim());
        const submit=generationPanel.querySelector('[data-gen-submit]'),empty=!draft.prompt.trim()&&!linkedText;
        if(submit){submit.disabled=empty||generationSubmitting||generationUploading;submit.title=empty?'请先填写画面描述':'开始生成（⌘/Ctrl + Enter）';}
        positionGenerationComposer();scheduleCanvasSave();
        if(unlinked)syncCanvas();
        if(unlinked||previousCount!==draft.attachments.length)renderGenerationComposer();
      }
    });
    // A card name is what @ mentions use: apply it once typing is done.
    generationPanel.addEventListener('change',event=>{
      const draft=generationDraft(activeGenerationId);
      if(draft&&event.target.matches('[data-gen-result]')){
        if(draftResults(liveDrafts(),draft.id).some(item=>item.id===event.target.value)){draft.primaryId=event.target.value;syncCanvas();scheduleCanvasSave();}
        return;
      }
      if(!draft?.entity||!event.target.matches('[data-gen-name]'))return;
      const wanted=event.target.value.trim();
      if(!wanted){event.target.value=draft.entity.name;return;}
      const name=renameEntity(workspace(),draft.id,wanted);
      event.target.value=name;
      if(name!==wanted.replace(/[@\r\n]/g,'').trim().slice(0,40))bridge.toast(`已有同名卡片，已改为「${name}」`);
      syncCanvas();scheduleCanvasSave(true);
    });
    generationMenuLayer=document.createElement('div');
    generationMenuLayer.className='director-workspace dw-generation-overlay';
    generationMenuElement=document.createElement('div');
    generationMenuElement.className='dw-gen-menu';
    generationMenuElement.hidden=true;
    generationMenuLayer.append(generationMenuElement);
    document.body.append(generationMenuLayer);
    canvasContextMenu=mountCanvasContextMenu(host.querySelector('.dw-canvas'),{
      layer:generationMenuLayer,
      icons:{upload:genIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>'),...Object.fromEntries(createOptions.map(item=>[item.kind,canvasIcon(item.icon)])),image:genIcons.image,video:genIcons.video},
      items:[['upload','上传素材'],...createOptions.map(item=>[item.kind,item.label])],
      ready:()=>Boolean(canvas)&&(!bridge.agentMode||agentReady),
      view:()=>({rect:canvas.getContainer().getBoundingClientRect(),viewport:canvas.getState().viewport}),
      onSelect:(action,point)=>action==='upload'?importAssetIntoCanvas(point):createCanvasNode(action,{point}),
      onError:error=>bridge.toast(error.message||'操作失败，请重试'),
    });
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
      const unlink=event.target.closest('[data-gen-unlink]');
      if(unlink){disconnectNodes(unlink.dataset.genUnlink,draft.id);return;}
      const remove=event.target.closest('[data-gen-remove]');
      if(remove){
        const id=remove.dataset.genRemove;
        removeGenerationMention(draft,id,generationPromptView(draft));
        draft.attachments=draft.attachments.filter(file=>file.id!==id);scheduleCanvasSave();renderGenerationComposer();return;
      }
      if(event.target.closest('[data-gen-submit]')){void submitGenerationArea();return;}
      if(!event.target.closest('[data-gen-upload]')||generationUploading)return;
      await attachGenerationReference(draft,async isCurrent=>{await syncCanvasMediaLibrary();if(isCurrent())return bridge.uploadGenerationFile();});
    });
    generationPanel.addEventListener('keydown',event=>{
      if(event.key==='Enter'&&event.target.matches?.('[data-gen-name]')&&!event.isComposing){event.preventDefault();generationPanel.querySelector('[data-gen-prompt]')?.focus();return;}
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
        media.src=media.tagName==='IMG'?canvasImageUrl(url):url;delete media.dataset.canvasSrc;
        if(media.tagName==='VIDEO')media.preload='metadata';
      }
    },{root:host.querySelector('.dw-canvas'),rootMargin:'400px'});
    const bindCanvas=api=>{
      if(mountEpoch!==epoch){api.dispose?.();return;}
      canvas=api;
      cancelledNodeCleanup=createCancelledNodeCleanup({
        items:()=>canvas?(canvas.getState().nodes||[]).flatMap(node=>{
          const element=canvas.getCanvasNodeById(node.id)?.htmlElement;
          return element?[{id:node.id,element,cancelled:Boolean(element.querySelector('[data-phase="cancelled"],[data-state="cancelled"]'))}]:[];
        }):[],
        remove:id=>{
          if(!canvas)return;
          removeCanvasInputEdges([id]);markCanvasItemsHidden([id]);
          if(activeGenerationId===id){activeGenerationId='';renderGenerationComposer();}
          const selection=canvas.getState().selectedNodeIds||[];
          if(selection.includes(id))canvas.selectNodes(selection.filter(selectedId=>selectedId!==id));
          syncCanvas();scheduleCanvasSave(true);
        },
      });
      canvas.getContainer().addEventListener('wheel',forwardCanvasMediaWheel,{capture:true,passive:false});
      for(const type of ['pointerdown','mousedown','touchstart'])canvas.getContainer().addEventListener(type,forwardCanvasDocumentPan,{capture:true,passive:false});
      canvasLibrary=createCanvasMediaLibrary({api:bridge.agentApi,findFile:bridge.canvasFile,registerFile:bridge.registerCanvasFile,importLocal:bridge.importLocalMedia,
        isCurrent:()=>mountEpoch===epoch&&Boolean(canvas)});
      canvas.on('nodes:created',handleCreatedCanvasNodes);
      mainLayer=canvas.getMainLayer?.();
      connector=mountCanvasConnector(canvas.getContainer(),{
        rects:linkableRects,
        canStart:id=>Boolean(describeInput(id)),
        check:(from,to)=>{const source=describeInput(from);return linkError(generationDraft(to),source&&{...source,id:from});},
        connect:(from,to)=>{try{if(connectNodes(from,to))bridge.toast('已连接');}catch(error){bridge.toast(error.message);}},
        dropEmpty:offerGenerationAt,
        toast:bridge.toast,
      });
      canvas.getContainer().addEventListener('click',event=>{
        const button=event.target.closest?.('[data-set-primary]');
        if(button){event.stopPropagation();setPrimaryResult(button.dataset.setPrimary);return;}
        const toggle=event.target.closest?.('[data-toggle-results]');
        if(toggle){event.stopPropagation();toggleResults(toggle.dataset.toggleResults);}
      });
      nativeTransformer=canvas.getTransformer?.();
      brandSelectionTransformer(nativeTransformer);
      if(workspace().viewport)canvas.updateViewport(workspace().viewport);
      canvas.on('nodes:selected',ids=>{const next=ids.find(id=>!id.startsWith('edge-'))||'';const isRichText=Boolean(next&&canvas.getNodeConfigById?.(next)?.$_type==='rich-text');host.querySelector('.director-workspace')?.classList.toggle('rich-text-selected',isRichText);if(next!==selected)inspectorOpen=false;selected=next;activeGenerationId=generationDraft(next)?.taskId?'':generationDraft(next)?.id||'';renderGenerationComposer();if(isRichText){const inspector=host.querySelector('.dw-inspector');if(inspector){inspector.hidden=true;inspector.innerHTML='';}}else drawInspector();if(ids.length)syncCanvas();else window.setTimeout(()=>{if(mountEpoch===epoch&&canvas&&!syncing&&!selected)syncCanvas();},0);});
      canvas.on('nodes:deleted',deletedNodes=>{
        if(syncing||!Array.isArray(deletedNodes)||deletedNodes.length===0)return;
        const ids=deletedNodes.map(node=>node?.id).filter(Boolean);
        const unlinked=removeCanvasInputEdges(ids);
        const deletedIds=markCanvasItemsHidden(ids);
        if(deletedIds.length===0&&!unlinked)return;
        pruneAssetImages(liveCanvasNodes().filter(node=>!deletedIds.includes(node.id)));
        clearTimeout(saveTimer);
        saveTimer=setTimeout(()=>{if(get()?.id===projectId)void save().catch(e=>bridge.toast(e.message));},600);
      });
      let edgeFrame=0;
      let latestSnapshot=null;
      const queueEdgeSync=snapshot=>{latestSnapshot=snapshot;if(edgeFrame)return;edgeFrame=queueWorkspaceFrame(()=>{edgeFrame=0;const next=latestSnapshot;latestSnapshot=null;if(next)renderEdges(next.nodes);});};
      const geometrySignature=snapshot=>(snapshot.nodes||[]).filter(n=>!String(n.id).startsWith('edge-')).map(n=>`${n.id}:${n.x}:${n.y}:${n.width}:${n.height}:${n.scaleX||1}:${n.scaleY||1}`).join('|');
      // Changing the chat column can make the canvas report a resize-related
      // state/viewport event. Those events describe layout, not user edits.
      // Image classes are shared, so registering the first picture covers all.
      let imageCulling=false;
      canvas.on('state:change',snapshot=>{if(!imageCulling){const shape=mainLayer?.find?.('Image')?.[0];if(shape){cullOffscreenImages(shape);imageCulling=true;}}if(mountEpoch!==epoch||syncing||resizingChat)return;bridge.markCanvasDirty?.();syncCanvasOverlayVisibility(snapshot);const current=persistLiveCanvasState(snapshot);if(!current)return;const geometry=geometrySignature(current);if(geometry!==lastNodeGeometry){lastNodeGeometry=geometry;queueEdgeSync(current);}scheduleCanvasSave();queueCanvasMediaLibrary();});
      // Wheel and pan events arrive several times per frame. Align once per
      // frame, and write the node snapshot back only after the gesture settles:
      // a viewport change moves no nodes, and copying every node (including
      // embedded crop images) on each event made large canvases stutter.
      let viewportFrame=0;
      canvas.on('viewport:change',v=>{canvasContextMenu?.close();if(mountEpoch!==epoch||syncing||resizingChat||(bridge.agentMode&&!agentReady))return;bridge.markCanvasDirty?.();workspace().viewport=v;if(!viewportFrame)viewportFrame=queueWorkspaceFrame(()=>{viewportFrame=0;alignCardGeometry();positionGenerationComposer();connector?.refresh();});clearTimeout(viewportPersistTimer);viewportPersistTimer=setTimeout(()=>{if(mountEpoch!==epoch||!canvas)return;persistLiveCanvasState(liveCanvasSnapshot({...canvas.getState(),viewport:workspace().viewport}));},150);scheduleCanvasSave();});
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
        mediaNameEditor?.update();
        if(ids.includes(activeGenerationId))positionGenerationComposer();
        scheduleEdgeRender();
      };
      const onGeometryEnd=event=>{
        const ids=geometryIds(event);
        if(!ids.length)return;
        if(event.type==='transformend')ids.forEach(id=>automaticImageSizing.delete(id));
        ids.forEach(id=>alignCard(id,undefined,true));
        mediaNameEditor?.update();
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
      queueCanvasMediaLibrary();
    };
    canvasMount=mountReferenceCanvas(host.querySelector('.dw-canvas'),{sessionKey:projectId,toolbarHost:host.querySelector('.dw-project-tools'),adapter:{
      workspaceToolbar:false,
      canRenameFile:id=>canvasMediaNameEntries().some(item=>item.id===id),
      renameFile:id=>mediaNameEditor?.begin(id),
      attachFiles:ids=>attachCanvasFiles(ids),
      imageAction:runImageAction,
      downloadFiles:downloadCanvasFiles,
      importAsset:()=>importAssetIntoCanvas(),
      sendMessage:(text)=>{if(text)void submit(text);},
      saveUpload:payload=>bridge.saveUpload?.(payload)||URL.createObjectURL(new Blob([Uint8Array.from(atob(payload.base64),char=>char.charCodeAt(0))])),
      saveTemp:payload=>bridge.saveTemp?.(payload)||bridge.saveUpload?.(payload),
    },onReady:bindCanvas});
    mediaNameEditor=mountMediaNameEditor(host.querySelector('.dw-canvas'),{entries:canvasMediaNameEntries,save:saveCanvasMediaName,error:bridge.toast});
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
    handle.onpointermove=event=>{if(!handle.hasPointerCapture(event.pointerId))return;event.preventDefault();event.stopPropagation();setWidth(host.querySelector('.dw-agent').getBoundingClientRect().right-event.clientX,true);};
    handle.onpointerup=event=>{event.preventDefault();event.stopPropagation();endResize(event);};
    handle.onpointercancel=event=>{event?.stopPropagation?.();endResize(event);};handle.onlostpointercapture=()=>{if(resizingChat)endResize();};
    handle.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();resizeLayoutOnly(event.key==='Home'?280:event.key==='End'?720:Number(handle.getAttribute('aria-valuenow'))+(event.key==='ArrowLeft'?24:-24),true);};
    handle.ondblclick=()=>resizeLayoutOnly(460,true);
    resizeObserver=new ResizeObserver(()=>{setWidth(preferredWidth);positionGenerationComposer();});resizeObserver.observe(workspaceElement);resizeObserver.observe(host.querySelector('.dw-canvas'));setWidth(preferredWidth);
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
    host.querySelector('.dw-canvas').addEventListener('dblclick',event=>{
      if(event.target.closest('video,input,textarea,button,[contenteditable="true"]'))return;
      // Double-clicking empty canvas adds something right there.
      if(canvas&&(canvas.getState().toolType||'select')==='select'){
        const box=canvas.getContainer().getBoundingClientRect();
        if(!rectAt(linkableRects(),event.clientX-box.left,event.clientY-box.top)){showCreateMenu({clientX:event.clientX,clientY:event.clientY,world:true});return;}
      }
      if(selected){inspectorOpen=true;drawInspector();}
    });
    host.querySelector('.director-workspace').addEventListener('keydown',handleCanvasDeleteKeydown,true);
    host.querySelector('.director-workspace').addEventListener('keydown',event=>{if(event.key==='Escape'){inspectorOpen=false;selected='';canvas.selectNodes([]);drawInspector();}});

    // Minimizing flies the panel into the reopen button so people can see where the conversation went.
    const genieTransform=(panel,button)=>`translate(${button.left+button.width/2-panel.left-panel.width/2}px,${button.top+button.height/2-panel.top-panel.height/2}px) scale(${button.width/panel.width},${button.height/panel.height})`;
    const animateAgentToggle=(collapsed,change)=>{
      const agent=host.querySelector('.dw-agent'),reopen=host.querySelector('[data-show-agent]');
      const before=collapsed?agent.getBoundingClientRect():reopen.hidden?null:reopen.getBoundingClientRect();
      change();
      if(!before||!agent.animate||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      const panel=collapsed?before:agent.getBoundingClientRect(),button=collapsed?reopen.getBoundingClientRect():before;
      if(!panel.width||!panel.height||!button.width)return;
      const docked={transform:genieTransform(panel,button),opacity:0,borderRadius:'50%'},open={transform:'none',opacity:1,borderRadius:'20px'};
      agent.animate(collapsed?[open,{opacity:1,offset:.55},docked]:[docked,{opacity:1,offset:.45},open],{duration:collapsed?420:360,easing:'cubic-bezier(.45,0,.2,1)'});
      if(collapsed){
        reopen.animate([{transform:'scale(.4)',opacity:0},{transform:'scale(.4)',opacity:0,offset:.6},{transform:'scale(1.14)',opacity:1,offset:.85},{transform:'scale(1)',opacity:1}],{duration:620,easing:'ease-out'});
        reopen.classList.remove('is-arriving');void reopen.offsetWidth;reopen.classList.add('is-arriving');
        reopen.addEventListener('animationend',event=>{if(event.animationName==='dw-agent-reopen-ripple')reopen.classList.remove('is-arriving');},{once:true});
      }
    };
    const toggleAgent=collapsed=>{animateAgentToggle(collapsed,()=>{if(bridge.agentMode){chatMode=collapsed?'minimized':'side';drawPanels();}else{host.querySelector('.director-workspace').classList.toggle('agent-collapsed',collapsed);host.querySelector('[data-show-agent]').hidden=!collapsed;}}); if(!collapsed)queueWorkspaceFrame(()=>composerInput.focus());};
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
      if(state?.assetMetadata?.length){
        workspace().projectAssets||={types:[],categories:{},collapsed:[],names:{}};
        const names=workspace().projectAssets.names||={};
        for(const item of state.assetMetadata){const file=bridge.canvasFile?.({assetId:item.id});names[item.id]=item.name;if(file?.id)names[file.id]=item.name;}
      }
      if(bridge.agentMode&&(sessionChanged||firstReadySession))chatMode=(hasSavedCanvasContent()||(firstReadySession&&bridge.initialCanvasOpen?.()))?'side':'full';
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
        // Attachments stay local until the message is actually sent.
        const files=request.files.length&&bridge.prepareCloudFiles?await bridge.prepareCloudFiles(request.files):request.files;
        if(!current()){request.resolve?.();continue;}
        const mediaText=files.length?'\n\n附件：\n'+files.map(f=>`${f.name}（素材 ID：${f.id}）`).join('\n'):'';
        const documentText=request.documents.length?'\n\n附带文件：\n'+request.documents.map(file=>file.title).join('\n'):'';
        const content=request.text+mediaText+documentText;
        await client.send(content,[...new Set([...request.selectionIds,...files.map(f=>f.id)])],request.documents,request.modelPreferences);
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
    queuedAssetLoads.clear();
    generationMentionEvents?.abort();generationMentionEvents=null;
    cancelledNodeCleanup?.destroy();cancelledNodeCleanup=null;
    mediaNameEditor?.destroy();mediaNameEditor=null;
    projectAssetsDrawer?.destroy();projectAssetsDrawer=null;
    connector?.dispose();connector=null;linkPopup?.dismiss?.();linkPopup?.remove();linkPopup=null;
    generationApproval?.destroy();generationApproval=null;
    // Invalidate callbacks before disconnecting clients or unmounting React.
    epoch++;workspaceActive=false;
    workspaceFrames.forEach(frame=>cancelAnimationFrame(frame));workspaceFrames.clear();
    const surfaces=[...(mountedWorkspace?.querySelectorAll('canvas')||[])];
    releaseWorkspaceMedia(mountedWorkspace);
    if(canvasFocusFrame)cancelAnimationFrame(canvasFocusFrame);canvasFocusFrame=0;canvasContentReady=false;seenCanvasNodeIds.clear();pendingCanvasFocus.clear();automaticImageSizing.clear();canvasContextMenu?.destroy();canvasContextMenu=null;generationMenuLayer?.remove();generationMenuLayer=null;generationMenuElement=null;clearEmptyEntry();host.querySelector('[data-conversation-loading]')?.remove();mediaLoadObserver?.disconnect();mediaLoadObserver=null;resizingChat=false;resizeCanvasSnapshot=null;if(resizeFinishFrame)cancelAnimationFrame(resizeFinishFrame);resizeFinishFrame=0;popoverEvents?.abort();messageScroller?.destroy();messageScroller=null;attachmentPreviews=null;messagePreviews=null;assetSizeLoads.forEach(image=>{image.onload=null;image.onerror=null;image.src='';});assetSizeLoads.clear();assetImages.clear();assetSizes.clear();attachments=[];documentAttachments=[];uploading=false;sending=false;switchingConversation=false;skillUpdating=false;skillSelection=null;modelPreferencePicker=null;preferenceUpdating=false;canvasLibrary=null;lastCanvasMediaSignature='';activeGenerationId='';generationMenu='';generationUploading=false;generationSubmitting=false;generationCostSequence++;clearTimeout(generationCostTimer);submissionQueue.splice(0).forEach(request=>request.resolve?.());cancelAnimationFrame(streamFrame);streamFrame=0;visibleDraft='';targetDraft='';streamSession='';streamPacer.reset();settlingMessageId='';lastStreamTime=0;reasoning?.destroy();reasoning=null;resizeObserver?.disconnect();agentClient?.dispose();agentClient=null;agentState=null;agentConfig=null;agentReady=false;lastAgentCacheSignature='';connectionError='';conversations=[];historyOpen=false;stopped=true;busy=false;clearTimeout(saveTimer);clearTimeout(viewportPersistTimer);if(edgeRenderFrame)cancelAnimationFrame(edgeRenderFrame);edgeRenderFrame=0;mainLayer?.off?.('.director-edges');mainLayer=null;nativeTransformer?.off?.('.director-edges');nativeTransformer=null;for(const type of ['pointerdown','mousedown','touchstart'])canvas?.getContainer()?.removeEventListener(type,forwardCanvasDocumentPan,true);canvas?.getContainer()?.removeEventListener('wheel',forwardCanvasMediaWheel,true);canvasMount?.unmount?.();canvasMount=null;canvas=null;
    // Clear backing stores after the canvas engine has saved its history and disposed.
    surfaces.forEach(surface=>{surface.width=0;surface.height=0;});
    mountedWorkspace?.remove();mountedWorkspace=null;
    projectId='';selected='';inspectorOpen=false;lastNodeGeometry='';}
  return {mount,refresh:drawPanels,dispose};
}
