import { bindDirectorMentions } from './director-mentions.js?v=1';
import { importedImageBounds } from '../agent/image-bounds.js?v=1';
import { renderMarkdown } from '../agent/markdown.js?v=1';
import { placeMediaFrames } from '../agent/frames.js?v=1';
import { createCreativeAgentClient } from '../agent/client.js?v=3';
import { mountReferenceCanvas } from '../../vendor/director/reference-canvas.js?v=28';
import { normalizeDirectorWorkspace, normalizeCanvasNodes, applyDirectorEdit, fitDirectorViewport } from './director-actions.js?v=6';

const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={queued:'等待制作',running:'制作中',completed:'已完成',succeeded:'已完成',failed:'失败',cancelled:'已取消',pending:'等待制作',processing:'生成中'};

function createConversationMessage(item, key) {
  const element=document.createElement('div');
  element.className=`dw-message ${item?.role==='user'?'user':'assistant'}`;
  element.dataset.messageId=key;
  const author=document.createElement('small');
  author.textContent=item?.role==='user'?'你':'GuGu';
  const content=document.createElement('div');
  content.className='dw-message-content';
  updateMessageContent(content,item?.text??'',item?.role);
  element.append(author,content);
  return element;
}

function updateMessageContent(content,text,role) {
  if(content._source===text&&content._role===role)return;
  content._source=text;content._role=role;
  if(role==='user')content.textContent=text;
  else content.innerHTML=renderMarkdown(text);
}

function createConversationWelcome() {
  const welcome=document.createElement('div');
  welcome.className='dw-welcome';
  welcome.innerHTML='<span class="dw-welcome-mark">✦</span><h2>从一个想法开始</h2><p>一起构思、写作，或把想象变成画面。</p><div class="dw-suggestions"><button data-example="和我一起构思一个故事，先聊聊方向">一起构思故事<span>↗</span></button><button data-example="帮我完善一个创作想法">完善我的想法<span>↗</span></button><button data-example="我想设计一张图片，先帮我确定画面方向">设计一张图片<span>↗</span></button></div></div>';
  return welcome;
}

// Keep finalized messages mounted while the assistant draft is streaming.
// Replacing the whole message panel on every poll restarts the user-message
// entrance animation and makes the user's bubble visibly flash.
function renderConversationMessages(container, items, draft='') {
  const activity=container.querySelector('.dw-turn-activity');
  activity?.remove();
  let history=container.querySelector('.dw-message-history');
  if(!history){history=document.createElement('div');history.className='dw-message-history';container.prepend(history);}
  const existing=new Map([...history.querySelectorAll('.dw-message[data-message-id]')].map(node=>[node.dataset.messageId,node]));
  if(!items.length){
    if(!history.querySelector('.dw-welcome'))history.replaceChildren(createConversationWelcome());
  }else{
    history.querySelector('.dw-welcome')?.remove();
    const keys=new Set();
    items.forEach((item,index)=>{
      const key=String(item?.id??`message-${index}`);keys.add(key);
      const node=existing.get(key)||createConversationMessage(item,key);
      const className=`dw-message ${item?.role==='user'?'user':'assistant'}`;
      const author=item?.role==='user'?'你':'GuGu';
      const text=String(item?.text??'');
      if(node.className!==className)node.className=className;
      if(node.querySelector('small').textContent!==author)node.querySelector('small').textContent=author;
      updateMessageContent(node.querySelector('.dw-message-content'),text,item?.role);
      const current=history.children[index];
      if(current!==node)history.insertBefore(node,current||null);
    });
    existing.forEach((node,key)=>{if(!keys.has(key))node.remove();});
  }
  if(activity){
    const latestUser=[...history.querySelectorAll('.dw-message.user')].at(-1);
    if(latestUser)latestUser.after(activity);
    else container.append(activity);
  }
  let draftNode=container.querySelector('.dw-message-draft');
  if(draft){
    if(!draftNode){draftNode=createConversationMessage({role:'assistant'},'');draftNode.classList.add('dw-message-draft');container.append(draftNode);}
    const text=String(draft);
    updateMessageContent(draftNode.querySelector('.dw-message-content'),text,'assistant');
  }else draftNode?.remove();
}

export function createDirectorWorkspace(host, bridge) {
  let canvas, canvasMount, projectId='', syncing=false, saveTimer, selected='', busy=false, stopped=false, epoch=0, draft='', layoutHistory=[], inspectorOpen=false;
  let mainLayer, lastNodeGeometry='', edgeRenderFrame=0, resizingChat=false, resizeCanvasSnapshot=null, resizeFinishFrame=0;
  let streamFrame=0, streamSession='', visibleDraft='', targetDraft='', lastStreamTime=0, resizeObserver;
  let agentClient, agentState=null, agentConfig=null, sending=false, connectionError='', conversations=[], historyOpen=false;
  let attachments=[], uploading=false, popoverEvents;

  const assetSizes=new Map(), assetSizeLoads=new Map(), assetImages=new Map();
  const get=()=>bridge.project();
  const workspace=()=>{const p=get();return p.directorWorkspace ||= normalizeDirectorWorkspace();};
  const save=async()=>{const result=await bridge.patch({directorWorkspace:workspace()});if(!result)throw new Error('工作台状态未保存，请重试');};
  const message=text=>workspace().messages.push({id:crypto.randomUUID(),role:'assistant',text});
  const hiddenIds=()=>new Set(workspace().hiddenIds||[]);
  const canvasItems=()=>{const hidden=hiddenIds();return nodes().filter(item=>!hidden.has(item.id));};
  const revealCanvasItem=id=>{const hidden=hiddenIds();if(!hidden.delete(id))return false;workspace().hiddenIds=[...hidden];return true;};
  function nodes() {
    const p=get();return [...(agentState?.documents||[]).map(d=>({id:d.id,kind:'document',title:d.title,text:d.text,item:d})),...(agentState?.generations||[]).map(g=>({id:g.canvasId||g.id,kind:'generation',title:g.title,text:'',taskId:g.id,item:g})),...bridge.imported().map(f=>({id:f.id,kind:'asset',title:f.name||'参考素材',text:'已导入素材',item:f,media:f})),...((p.synopsis?.trim()||p.script?.trim())?[{id:'story',kind:'story',title:'剧本',text:p.synopsis||p.script}]:[]),...p.resources.map(x=>({id:x.id,kind:'resource',title:x.name,text:x.description||x.prompt,item:x,taskId:x.selectedTaskId||x.versions?.at(-1)})),...p.shots.map((x,i)=>({id:x.id,kind:'shot',title:`${String(i+1).padStart(2,'0')} · ${x.title}`,text:x.script||x.prompt||'等待导演设计这一镜',item:x,taskId:x.selectedVideoTaskId||x.videoVersions?.at(-1)}))];
  }
  function position(n,i) {
    const saved=workspace().positions[n.id];if(saved)return saved;
    if(['document','generation'].includes(n.kind))return {x:40+i*320,y:-460};
    if(n.kind==='asset')return {x:40+bridge.imported().findIndex(x=>x.id===n.id)*300,y:-140};
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
      const canvasNodes=canvas?.getState?.()?.nodes;
      const targets=Array.isArray(canvasNodes)?canvasNodes:[canvas?.getNodeConfigById?.(id)];
      for(const current of targets){
        if(current?.$_type!=='image'||current.$_imageUrl!==url)continue;
        const bounds=assetBounds(url,current);
        const saved=workspace().positions[current.id]||{};
        workspace().positions[current.id]={...saved,x:current.x,y:current.y,...bounds};
        canvas.updateNodes([current.id],bounds);
        paintAssetImage(current.id,url);
      }
      globalThis.clearTimeout?.(saveTimer);
      saveTimer=globalThis.setTimeout?.(()=>{if(token===epoch)void save().catch(e=>bridge.toast(e.message));},600);
    };
    image.onerror=()=>assetSizeLoads.delete(url);
    if(!url.startsWith('gugu-media://'))image.crossOrigin='anonymous';
    image.src=url;
  }
  function nodeContent(n) {
    if(n.kind==='asset'&&n.media?.kind==='image')return '';
    if(n.kind==='asset'&&n.media?.kind==='video')return `<div class="dw-generation-frame dw-imported-video" data-state="completed"><video controls playsinline preload="metadata" src="${escape(n.media.url)}" aria-label="${escape(n.title)}"></video><span class="dw-frame-caption">${escape(n.title)}</span></div>`;
    if(n.kind==='generation'){
      const task=bridge.task(n.taskId),media=bridge.media(n.taskId);
      const status=n.item.placeholder?n.item.status:task?.status||'queued';
      const state=media?'completed':status==='completed'?'saving':status;
      const text=({waiting_approval:'等待确认',queued:'排队中',running:'正在创作',processing:'正在创作',saving:'正在保存到本地',failed:'生成失败',cancelled:'已取消'})[state]||'正在准备';
      const progress=Number(task?.progress);const percentage=Number.isFinite(progress)&&progress>0?Math.min(99,Math.round(progress)):null;
      return `<div class="dw-generation-frame" data-state="${escape(state)}" aria-label="${escape(n.title)}">${media?`<${media.kind==='video'?'video controls playsinline preload="metadata"':'img'} src="${escape(media.url)}" ${media.kind==='image'?`alt="${escape(n.title)}"`:''}>${media.kind==='video'?'</video>':''}`:`<div class="dw-frame-placeholder"><span class="dw-frame-pulse" aria-hidden="true"></span><b>${text}</b>${percentage?`<span>${percentage}%</span><progress max="100" value="${percentage}"></progress>`:''}</div>`}<span class="dw-frame-caption">${escape(n.title)}</span></div>`;
    }
    const t=bridge.task(n.taskId);const media=n.media||bridge.media(n.taskId);const action=workspace().plan?.actions?.find(a=>a.targetId===n.id&&['running','failed'].includes(a.status));
    const status=action?labels[action.status]:t?(labels[t.status]||t.status):n.kind==='asset'?'已导入':n.kind==='story'&&get().script?'已设计':'待制作';
    const locked=workspace().lockedIds.includes(n.id);
    return `<div class="dw-node-content${selected===n.id?' is-selected':''}" data-node-id="${escape(n.id)}"><header class="dw-node-title"><b>${escape(n.title)}</b><span class="dw-node-status${action?.status==='failed'?' is-failed':''}">${locked?'已锁定':escape(status)}</span></header>${media?`<${media.kind==='video'?'video controls':'img'} src="${escape(media.url)}" ${media.kind==='image'?`alt="${escape(n.title)}"`:''} class="dw-node-media" >${media.kind==='video'?'</video>':''}`:`<p class="dw-node-copy">${escape(n.text)}</p>`}<footer class="dw-node-meta">${n.kind==='shot'?`${n.item.duration} 秒 · ${n.item.aspectRatio} · ${n.item.videoVersions?.length||0} 个版本`:n.kind==='resource'?({character:'角色',location:'场景',prop:'道具'}[n.item.type]||'素材'):n.kind==='asset'?'参考素材':n.kind==='document'?`文字作品 · 第 ${n.item.revision} 版`:n.kind==='generation'?'生成作品':'剧本'}${t?.progress?` · ${Math.round(t.progress)}%`:''}</footer></div>`;
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
  function findLayerNode(id) {
    let found=null;
    mainLayer?.children?.forEach?.(node=>{if(!found&&node.id?.()===id)found=node;});
    return found;
  }
  function liveCanvasNodes() {
    const state=canvas?.getState();
    if(!state)return [];
    return (state.nodes||[]).map(node=>{
      const shape=findLayerNode(node.id), attrs=shape?.getAttrs?.();
      return attrs?{...node,x:attrs.x??node.x,y:attrs.y??node.y,width:attrs.width??node.width,height:attrs.height??node.height,scaleX:attrs.scaleX??node.scaleX,scaleY:attrs.scaleY??node.scaleY}:node;
    });
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
  function scheduleEdgeRender(snapshotNodes) {
    if(edgeRenderFrame)return;
    edgeRenderFrame=requestAnimationFrame(()=>{edgeRenderFrame=0;renderEdges(snapshotNodes);});
  }
  function alignCard(id,html) {
    const node=canvas.getCanvasNodeById(id),element=node?.htmlElement,shape=node?.getElement?.();
    if(!element||!shape)return;
    if(html!==undefined&&element.dataset.content!==html){element.innerHTML=html;element.dataset.content=html;}
    // HtmlNode already synchronizes this element from getClientRect() on
    // viewport/drag events. Do the same here when content changes. Applying
    // getAbsoluteTransform() as a CSS matrix on top of the core's left/top
    // writes double-applies the viewport translation, making cards jump away
    // from their Konva hit rectangle while dragging.
    const rect=shape.getClientRect();
    Object.assign(element.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`,transformOrigin:'0 0',transform:'none'});
    element.querySelectorAll('video').forEach(video=>{
      // Forward gestures on the picture to Konva; reserve the bottom 48 CSS
      // pixels for native playback controls (their shadow DOM is opaque).
      if(video.dataset.canvasPlayback)return;
      video.dataset.canvasPlayback='true';
      ['pointerdown','mousedown','touchstart','click','dblclick','keydown','keyup'].forEach(type=>video.addEventListener(type,event=>{
        event.stopPropagation();
        const point=event.touches?.[0]||event;
        const rect=video.getBoundingClientRect();
        const onPicture=Number.isFinite(point.clientY)&&point.clientY<rect.bottom-48;
        if(onPicture&&['pointerdown','mousedown','touchstart'].includes(type)){
          const surface=canvas.getStage().content;
          surface.dispatchEvent(new event.constructor(type,event));
          if(type!=='pointerdown')event.preventDefault();
        }else if(type==='pointerdown'&&selected!==id){
          canvas.selectNodes([id]);
        }
        if(onPicture&&(type==='click'||type==='dblclick'))event.preventDefault();
      },{passive:false}));
    });
    const frame=element.querySelector('.dw-generation-frame');
    if(frame){
      const media=frame.querySelector('img,video');
      if(media){const measure=()=>{const width=media.naturalWidth||media.videoWidth,height=media.naturalHeight||media.videoHeight;if(!width||!height)return;const p=workspace().positions[id];if(!p)return;const nextHeight=p.width*height/width;if(Math.abs(p.height-nextHeight)>.5){p.height=nextHeight;canvas.updateNodes([id],{height:nextHeight});alignCard(id);clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save().catch(e=>bridge.toast(e.message)),600);}};media.onload=measure;media.onloadedmetadata=measure;if(media.complete||media.readyState>=1)measure();}
      return;
    }
    // Scale the fixed 280 × 228 card with its canvas bounds, just like images.
    // Scaling only the outer overlay leaves the text card huge when zoomed out.
    if(element.firstElementChild)element.firstElementChild.style.transform=`scale(${rect.width/280},${rect.height/228})`;
  }
  function alignCards(){if(!canvas)return;nodes().forEach(n=>alignCard(n.id));}
  function fitCanvas(ids){
    if(!canvas)return;
    const surface=canvas.getContainer();
    const list=canvas.getState().nodes.filter(n=>!String(n.id).startsWith('edge-')&&(!ids||ids.includes(n.id)));
    const viewport=fitDirectorViewport(list,surface.clientWidth,surface.clientHeight);
    if(viewport){canvas.updateViewport(viewport);requestAnimationFrame(alignCards);}
  }
  async function importAssetIntoCanvas(){
    try{
      const file=await bridge.importAsset();
      if(!file)return;
      revealCanvasItem(file.id);
      if(canvas){
        const v=canvas.getState().viewport;
        workspace().positions[file.id]={x:(host.querySelector('.dw-board').clientWidth/2-v.x)/v.scale-140,y:(180-v.y)/v.scale};
        await save();
        syncCanvas();
        canvas.selectNodes([file.id]);
        fitCanvas([file.id]);
      }
    }catch(e){bridge.toast(e.message);}
  }
  function syncCanvas() {
    if(!canvas||syncing)return;syncing=true;
    const ns=canvasItems();const existing=new Map(canvas.getState().nodes.map(n=>[n.id,n]));
    const placements=placeMediaFrames(agentState?.generations||[],workspace().positions,[...existing.values()].filter(n=>!String(n.id).startsWith('edge-')));
    if(Object.keys(placements).length){Object.assign(workspace().positions,placements);clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save().catch(e=>bridge.toast(e.message)),600);}
    const links=edgeLinks();
    const valid=new Set([...ns.map(n=>n.id),...links.map(l=>`edge-${l.to}`)]);
    canvas.deleteNodes([...existing.keys()].filter(id=>!valid.has(id)&&(id.startsWith('edge-')||['director','video','director-asset'].includes(existing.get(id).$_actualType))));
    ns.forEach((n,i)=>{
      const old=existing.get(n.id);const pos=position(n,i);
      if(n.kind==='asset'&&n.media?.kind==='image'){
        const url=old?.$_type==='image'?old.$_imageUrl:n.media?.url;
        if(!url)return;
        loadAssetSize(n.id,url);
        const bounds=assetBounds(url,pos);
        // Replace the old custom HTML card in place.  Keeping the project id
        // as the canvas id means selections and saved positions remain stable.
        if(old && (old.$_type!=='image'||old.$_imageUrl!==url)){
          canvas.deleteNodes([n.id]);
          canvas.createNodes([{id:n.id,$_type:'image',$_actualType:'director-asset',$_imageUrl:url,brightness:0,$_applyBrightnessFilter:false,...pos,...bounds,draggable:true}],false);
        }else if(!old){
          canvas.createNodes([{id:n.id,$_type:'image',$_actualType:'director-asset',$_imageUrl:url,brightness:0,$_applyBrightnessFilter:false,...pos,...bounds,draggable:true}],false);
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
      const actualType=media?.kind==='video'?'video':'director';
      if(!old)canvas.createNodes([{id:n.id,$_type:'html',$_actualType:actualType,$_htmlContent:html,fill:'rgba(255,255,255,0.001)',strokeEnabled:false,width:280,height:228,...pos,draggable:true}],false);
      else if(old.$_type==='html'&&(old.$_htmlContent!==html||old.$_actualType!==actualType))canvas.updateNodes([n.id],{$_actualType:actualType,$_htmlContent:html,fill:'rgba(255,255,255,0.001)',strokeEnabled:false});
      alignCard(n.id,html);
    });
    links.forEach(l=>{const from=canvas.getNodeConfigById(l.from),to=canvas.getNodeConfigById(l.to);if(!from||!to)return;const id=`edge-${l.to}`;const config={id,$_type:'arrow',x:0,y:0,points:edgePoints(from,to),stroke:'#9b99c9',fill:'#9b99c9',strokeWidth:1.5,pointerLength:6,pointerWidth:6,$_listening:false};if(existing.has(id))canvas.updateNodes([id],config);else canvas.createNodes([config],false);canvas.moveNodesToBottom([id]);});
    syncing=false;
    renderEdges(canvas.getState().nodes);
  }
  function syncEdges(snapshotNodes=canvas?.getState().nodes||[]) {
    renderEdges(snapshotNodes,true);
  }
  function drawPanels() {
    if(!host.querySelector('.dw-messages'))return;
    busy=['queued','running','waiting_job'].includes(agentState?.state);
    const models=agentConfig?.models||[];
    const modelButton=host.querySelector('[data-agent-model-toggle]');
    const currentModel=agentState?.settings?.model;
    modelButton.title=`切换模型：${models.find(m=>m.id===currentModel)?.label||'正在加载'}`;
    modelButton.disabled=!agentState||sending||!models.length;
    const modelList=host.querySelector('[data-agent-model-list]');
    const options=models.map(m=>`<button type="button" data-agent-model="${escape(m.id)}" aria-pressed="${m.id===currentModel}" ${sending?'disabled':''}>${escape(m.label)}${m.id===currentModel?'<span aria-hidden="true">✓</span>':''}</button>`).join('');
    if(modelList.innerHTML!==options)modelList.innerHTML=options;
    host.querySelector('[data-agent-upload]').disabled=uploading||sending;
    host.querySelector('[data-agent-upload]').title=uploading?'正在上传…':'上传文件';
    const attachmentList=host.querySelector('[data-agent-attachments]');
    attachmentList.innerHTML=attachments.map(f=>`<span class="dw-attachment${['image','video'].includes(f.kind)&&(f.previewUrl||f.url)?' dw-attachment-preview':''}" title="${escape(f.name)}">${f.kind==='image'&&(f.previewUrl||f.url)?`<img src="${escape(f.previewUrl||f.url)}" alt="${escape(f.name)}">`:f.kind==='video'&&(f.previewUrl||f.url)?`<video src="${escape(f.previewUrl||f.url)}" preload="metadata" muted playsinline aria-label="${escape(f.name)}"></video>`:`<span>${escape(f.name)}</span>`}<button type="button" data-remove-attachment="${escape(f.id)}" aria-label="移除 ${escape(f.name)}" ${sending?'disabled':''}>×</button></span>`).join('')+(uploading?'<span role="status">正在上传文件…</span>':'');
    host.querySelector('[data-agent-new]').disabled=sending||!agentConfig;
    host.querySelector('[data-agent-history]').disabled=!agentClient;
    host.querySelector('[data-agent-retry]').hidden=!connectionError;
    const history=host.querySelector('.dw-conversations');

    host.querySelector('[data-agent-history]').setAttribute('aria-expanded',String(historyOpen));
    if(historyOpen){
      history.innerHTML=`<div class="dw-history-heading"><strong>历史对话</strong><span>${conversations.length} 条</span></div>`+(conversations.length?conversations.map(c=>`<button type="button" data-conversation="${escape(c.id)}" aria-current="${c.id===agentState?.id}"><span>${escape(c.title)}</span><small>${escape(new Date(c.updatedAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'}))}${['running','queued','waiting_job'].includes(c.state)?' · 进行中':''}</small></button>`).join(''):'<p>还没有历史对话</p>');
      history.querySelectorAll('[data-conversation]').forEach(button=>button.onclick=()=>void switchConversation(button.dataset.conversation));
    }
    const auto=host.querySelector('[data-agent-auto]');
    if(document.activeElement!==auto)auto.checked=Boolean(agentState?.settings.autoGenerate);
    const budget=host.querySelector('[data-agent-budget]');
    if(document.activeElement!==budget)budget.value=String((agentState?.settings.generationBudgetMicro||0)/1000000);
    const status=host.querySelector('.dw-mode-help');
    status.textContent=connectionError||agentState?.activity||'';
    status.setAttribute('role','status');
    host.querySelector('[data-director-stop]').hidden=!busy;
    host.querySelector('[data-director-delegate]').hidden=agentState?.state!=='paused';
    const messages=host.querySelector('.dw-messages');
    const stickToBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
    const items=agentState?.messages||[];
    if(streamSession!==agentState?.id){cancelAnimationFrame(streamFrame);streamFrame=0;visibleDraft='';targetDraft='';streamSession=agentState?.id;messages.querySelector('.dw-message-history')?.remove();messages.querySelector('.dw-message-draft')?.remove();}
    targetDraft=agentState?.draft||'';
    if(!targetDraft.startsWith(visibleDraft))visibleDraft='';
    if(!targetDraft){cancelAnimationFrame(streamFrame);streamFrame=0;visibleDraft='';}
    renderConversationMessages(messages,items,visibleDraft);
    if(targetDraft&&!streamFrame)streamFrame=requestAnimationFrame(animateDraft);
    host.querySelectorAll('[data-example]').forEach(button=>button.onclick=()=>{host.querySelector('#directorMessage').value=button.dataset.example;host.querySelector('#directorMessage').focus();});
    const approval=agentState?.approval;
    const plan=host.querySelector('.dw-plan');
    const approvalSignature=approval?JSON.stringify([approval.id,approval.title,approval.modelId,approval.quantity,approval.credits,approval.prompt]):'';
    if(plan.dataset.approvalSignature!==approvalSignature){
      const promptExpanded=plan.querySelector('details')?.open;
      plan.innerHTML=approval?`<div class="dw-agent-approval"><strong>${escape(approval.title)}</strong><p>${escape(approval.modelId)} · ${approval.quantity} 个 · ${approval.credits} 积分</p><details><summary>查看创作描述</summary><p>${escape(approval.prompt)}</p></details><div><button data-agent-decline>取消</button><button data-agent-approve class="dw-primary">确认生成</button></div></div>`:'';
      plan.dataset.approvalSignature=approvalSignature;
      if(promptExpanded)plan.querySelector('details').open=true;
      plan.querySelector('[data-agent-approve]')?.addEventListener('click',()=>void agentAction(()=>agentClient.approve(approval.id,true)));
      plan.querySelector('[data-agent-decline]')?.addEventListener('click',()=>void agentAction(()=>agentClient.approve(approval.id,false)));
    }
    const sendButton=host.querySelector('[data-director-send]');
    sendButton.disabled=uploading||sending||!agentState||!agentConfig?.configured;
    sendButton.textContent=sending?'发送中…':busy?'补充要求':'发送';
    sendButton.setAttribute('aria-busy',String(sending));
    if(stickToBottom)messages.scrollTop=messages.scrollHeight;
    if(!host.querySelector('.dw-inspector')?.contains(document.activeElement))drawInspector();
    syncCanvas();
  }
  function animateDraft(time) {
    streamFrame=0;
    const messages=host.querySelector('.dw-messages');
    if(!messages||!targetDraft)return;
    const follow=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
    const elapsed=Math.min(50,Math.max(16,time-lastStreamTime));lastStreamTime=time;
    const remaining=Array.from(targetDraft.slice(visibleDraft.length));
    const count=window.matchMedia('(prefers-reduced-motion: reduce)').matches?remaining.length:Math.max(1,Math.ceil(remaining.length*elapsed/100));
    visibleDraft+=remaining.slice(0,count).join('');
    renderConversationMessages(messages,agentState?.messages||[],visibleDraft);
    if(follow)messages.scrollTop=messages.scrollHeight;
    if(visibleDraft!==targetDraft)streamFrame=requestAnimationFrame(animateDraft);
  }
  async function agentAction(action){try{await action();connectionError='';}catch(error){if(!error.stale){connectionError=error.message;bridge.toast(error.message);}}drawPanels();}
  async function runImageAction(action,ids) {
    if(sending||uploading)throw new Error('请等待当前操作完成');
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
    if(sending||uploading)return;
    const items=nodes().filter(n=>ids.includes(n.id)&&(n.kind==='asset'||n.taskId));
    if(!items.length){bridge.toast('请选择已有文件的素材');return;}
    const token=epoch,conversationId=agentState?.id;
    uploading=true;
    host.querySelector('.director-workspace').classList.remove('agent-collapsed');
    host.querySelector('[data-show-agent]').hidden=true;
    drawPanels();
    try{
      for(const item of items){
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
    el.hidden=!n;
    if(!n){el.innerHTML='';return;}
    if(n.kind==='document'){
      el.classList.remove('compact');
      el.innerHTML=`<h3>${escape(n.title)}</h3><textarea readonly aria-label="作品正文" class="dw-document-content">${escape(n.text)}</textarea><button data-doc-download>下载文稿</button><button data-doc-ask>继续修改</button>`;
      el.querySelector('[data-doc-download]').onclick=()=>{const url=URL.createObjectURL(new Blob([n.text],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`${n.title.replace(/[\\/:*?"<>|]/g,'_')}.md`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      el.querySelector('[data-doc-ask]').onclick=async()=>{if(n.item.conversationId&&n.item.conversationId!==agentState?.id)await switchConversation(n.item.conversationId);host.querySelector('#directorMessage').value=`修改「${n.title}」：`;host.querySelector('#directorMessage').focus();};return;
    }
    const locked=workspace().lockedIds.includes(n.id);
    const ask=()=>{host.querySelector('.director-workspace').classList.remove('agent-collapsed');host.querySelector('[data-show-agent]').hidden=true;const input=host.querySelector('#directorMessage');input.value=`${n.kind==='asset'?'使用':'修改'}「${n.title}」：`;input.focus();};
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
  function mount() {
    if(projectId===get().id&&canvas&&host.querySelector('.dw-canvas')){drawPanels();return;}
    dispose();projectId=get().id;
    host.innerHTML=`<section class="director-workspace"><section class="dw-board"><div class="dw-canvas reference-canvas-host" aria-label="无限分镜画布"></div><button class="dw-agent-reopen" data-show-agent hidden>打开对话</button><section class="dw-inspector" hidden></section></section><aside class="dw-agent"><div class="dw-agent-resizer" role="separator" aria-label="调整对话区域宽度" aria-orientation="vertical" tabindex="0"></div><header><b>GuGu</b><nav aria-label="对话操作"><button type="button" data-agent-new title="新建对话">＋ 新对话</button><button type="button" data-agent-history aria-expanded="false" aria-haspopup="dialog" popovertarget="directorHistoryPicker">历史</button><button type="button" data-hide-agent aria-label="收起对话" title="收起对话">›</button></nav></header><section id="directorHistoryPicker" class="dw-conversations dw-history-picker" aria-label="历史对话" popover role="dialog"></section><details class="dw-agent-options"><summary>生成设置</summary><label><input type="checkbox" data-agent-auto> 预算内自动生成</label><label>本次对话生成预算（积分）<input type="number" data-agent-budget min="0" max="10000" step="1" value="0"></label><button type="button" data-agent-save-settings>保存设置</button></details><div class="dw-messages" aria-live="polite"><div class="dw-turn-activity"><p class="dw-mode-help"></p><button type="button" class="dw-agent-retry" data-agent-retry hidden>重新连接</button></div></div><div class="dw-plan"></div><form class="dw-composer"><label for="directorMessage" class="dw-sr-only">告诉 GuGu 你的想法</label><textarea id="directorMessage" placeholder="想聊什么，或希望我帮你创作什么？" rows="3"></textarea><div data-agent-attachments class="dw-attachments"></div><div class="dw-composer-actions"><button type="button" data-agent-upload class="dw-icon-button" aria-label="上传文件" title="上传文件"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l10-10a4 4 0 0 1 5.66 5.66l-10 10a2 2 0 0 1-2.83-2.83l9.19-9.19"/></svg></button><small>Enter 发送 · Shift + Enter 换行</small><button data-director-delegate type="button" title="继续当前创作">继续</button><button data-director-stop type="button" hidden>暂停</button><button type="button" data-agent-model-toggle class="dw-icon-button" aria-label="切换对话模型" aria-haspopup="dialog" aria-expanded="false" popovertarget="directorModelPicker"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/></svg></button><button data-director-send class="dw-primary" type="submit" aria-label="发送消息">发送</button></div></form><div id="directorModelPicker" class="dw-model-picker" popover role="dialog" aria-label="选择对话模型"><strong>选择对话模型</strong><div data-agent-model-list></div></div></aside></section>`;
    const bindCanvas=api=>{
      canvas=api;
      mainLayer=canvas.getMainLayer?.();
      if(workspace().viewport)canvas.updateViewport(workspace().viewport);
      canvas.on('nodes:selected',ids=>{const next=ids.find(id=>!id.startsWith('edge-'))||'';const isRichText=Boolean(next&&canvas.getNodeConfigById?.(next)?.$_type==='rich-text');host.querySelector('.director-workspace')?.classList.toggle('rich-text-selected',isRichText);if(next!==selected)inspectorOpen=false;selected=next;if(isRichText){const inspector=host.querySelector('.dw-inspector');if(inspector){inspector.hidden=true;inspector.innerHTML='';}}else drawInspector();if(ids.length)syncCanvas();else queueMicrotask(()=>{if(canvas&&!syncing&&!selected)syncCanvas();});});
      canvas.on('nodes:deleted',deletedNodes=>{
        if(syncing||!Array.isArray(deletedNodes)||deletedNodes.length===0)return;
        const knownIds=new Set([...nodes().map(item=>item.id),...(workspace().canvasNodes||[]).map(item=>item.id)]);
        const deletedIds=deletedNodes.map(node=>node?.id).filter(id=>id&&knownIds.has(id));
        if(deletedIds.length===0)return;
        const hidden=new Set(workspace().hiddenIds||[]);
        deletedIds.forEach(id=>hidden.add(id));
        workspace().hiddenIds=[...hidden];
        deletedIds.forEach(id=>{if(workspace().positions)delete workspace().positions[id];});
        clearTimeout(saveTimer);
        saveTimer=setTimeout(()=>{if(get()?.id===projectId)void save().catch(e=>bridge.toast(e.message));},600);
      });
      let edgeFrame=0;
      let latestSnapshot=null;
      const queueEdgeSync=snapshot=>{latestSnapshot=snapshot;if(edgeFrame)return;edgeFrame=requestAnimationFrame(()=>{edgeFrame=0;const next=latestSnapshot;latestSnapshot=null;if(next)renderEdges(next.nodes);});};
      const geometrySignature=snapshot=>(snapshot.nodes||[]).filter(n=>!String(n.id).startsWith('edge-')).map(n=>`${n.id}:${n.x}:${n.y}:${n.width}:${n.height}:${n.scaleX||1}:${n.scaleY||1}`).join('|');
      // Changing the chat column can make the canvas report a resize-related
      // state/viewport event. Those events describe layout, not user edits.
      canvas.on('state:change',snapshot=>{if(syncing||resizingChat)return;const geometry=geometrySignature(snapshot);if(geometry!==lastNodeGeometry){lastNodeGeometry=geometry;queueEdgeSync(snapshot);}const visibleIds=new Set(nodes().map(item=>item.id));const positions=Object.fromEntries(snapshot.nodes.filter(n=>visibleIds.has(n.id)).map(n=>[n.id,{x:n.x,y:n.y,width:n.width,height:n.height,scaleX:n.scaleX,scaleY:n.scaleY,rotation:n.rotation}]));workspace().positions=positions;workspace().canvasNodes=normalizeCanvasNodes(snapshot.nodes.filter(n=>(!visibleIds.has(n.id)||n.$_type==='image')&&!String(n.id).startsWith('edge-')));workspace().viewport=snapshot.viewport;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(get()?.id===projectId)void save().catch(e=>bridge.toast(e.message));},600);});
      canvas.on('viewport:change',v=>{if(resizingChat)return;requestAnimationFrame(alignCards);workspace().viewport=v;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(get()?.id===projectId)void save().catch(e=>bridge.toast(e.message));},600);});
      // The whiteboard emits the public state event at the end of a drag. The
      // Konva layer receives `dragmove` every frame, so draw arrow endpoints
      // directly on the native shape for a continuous, low-latency response.
      const onDragMove=event=>{const target=event?.target;if(!target||String(target.id?.()).startsWith('edge-'))return;alignCards();scheduleEdgeRender(liveCanvasNodes());};
      const onDragEnd=event=>{const target=event?.target;if(!target||String(target.id?.()).startsWith('edge-'))return;renderEdges(liveCanvasNodes(),true);};
      mainLayer?.on?.('dragmove.director-edges',onDragMove);
      mainLayer?.on?.('dragend.director-edges',onDragEnd);
      syncing=true;
      const hidden=hiddenIds();
      canvas.createNodes((workspace().canvasNodes||[]).filter(node=>!hidden.has(node.id)),false);
      syncing=false;
      syncCanvas();
      requestAnimationFrame(()=>{if(canvas){fitCanvas();alignCards();}});
      drawPanels();
    };
    canvasMount=mountReferenceCanvas(host.querySelector('.dw-canvas'),{sessionKey:projectId,adapter:{
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
      resizeFinishFrame=requestAnimationFrame(()=>{resizeFinishFrame=0;resizingChat=false;workspaceElement.classList.remove('is-resizing-chat');});
    };
    const resizeLayoutOnly=(width,persist=true)=>{
      if(!resizingChat){resizeCanvasSnapshot=captureCanvasForResize();resizingChat=true;workspaceElement.classList.add('is-resizing-chat');}
      setWidth(width,persist);
      requestAnimationFrame(()=>endResize());
    };
    handle.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();if(resizeFinishFrame){cancelAnimationFrame(resizeFinishFrame);resizeFinishFrame=0;}resizeCanvasSnapshot=captureCanvasForResize();resizingChat=true;handle.setPointerCapture(event.pointerId);workspaceElement.classList.add('is-resizing-chat');};
    handle.onpointermove=event=>{if(!handle.hasPointerCapture(event.pointerId))return;event.preventDefault();event.stopPropagation();setWidth(workspaceElement.getBoundingClientRect().right-event.clientX,true);};
    handle.onpointerup=event=>{event.preventDefault();event.stopPropagation();endResize(event);};
    handle.onpointercancel=event=>{event?.stopPropagation?.();endResize(event);};handle.onlostpointercapture=()=>{if(resizingChat)endResize();};
    handle.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();resizeLayoutOnly(event.key==='Home'?280:event.key==='End'?720:Number(handle.getAttribute('aria-valuenow'))+(event.key==='ArrowLeft'?24:-24),true);};
    handle.ondblclick=()=>resizeLayoutOnly(460,true);
    resizeObserver=new ResizeObserver(()=>setWidth(preferredWidth));resizeObserver.observe(workspaceElement);setWidth(preferredWidth);
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
      if(modelPicker.matches(':popover-open'))positionPopover(modelPicker,host.querySelector('[data-agent-model-toggle]'),true);
      if(historyPicker.matches(':popover-open'))positionPopover(historyPicker,host.querySelector('[data-agent-history]'),false);
    };
    popoverEvents=new AbortController();
    window.addEventListener('resize',positionPopovers,{signal:popoverEvents.signal});
    host.addEventListener('scroll',positionPopovers,{capture:true,signal:popoverEvents.signal});
    modelPicker.addEventListener('toggle',positionPopovers);
    historyPicker.addEventListener('toggle',event=>{
      historyOpen=event.newState==='open';drawPanels();positionPopovers();
      if(historyOpen)void agentAction(()=>agentClient.history()).then(positionPopovers);
    });

    modelPicker.addEventListener('toggle',event=>host.querySelector('[data-agent-model-toggle]').setAttribute('aria-expanded',String(event.newState==='open')));
    host.querySelector('[data-agent-model-list]').onclick=event=>{const button=event.target.closest('[data-agent-model]');if(!button||sending)return;modelPicker.hidePopover();void agentAction(()=>agentClient.settings({model:button.dataset.agentModel}));};
    host.querySelector('[data-agent-attachments]').onclick=event=>{const button=event.target.closest('[data-remove-attachment]');if(button&&!sending){attachments=attachments.filter(f=>f.id!==button.dataset.removeAttachment);drawPanels();}};
    host.querySelector('[data-agent-upload]').onclick=async()=>{
      if(uploading||sending)return;
      const token=epoch;uploading=true;drawPanels();
      try{const file=await bridge.uploadChatFile();if(token===epoch&&file&&!attachments.some(f=>f.id===file.id))attachments.push(file);}
      catch(error){if(token===epoch&&!error.stale)bridge.toast(error.message);}
      finally{if(token===epoch){uploading=false;drawPanels();}}
    };
    host.querySelector('[data-agent-save-settings]').onclick=()=>void agentAction(()=>agentClient.settings({autoGenerate:host.querySelector('[data-agent-auto]').checked,generationBudgetCredits:Number(host.querySelector('[data-agent-budget]').value)}));
    host.querySelector('.dw-composer').onsubmit=e=>{e.preventDefault();const input=host.querySelector('#directorMessage');const text=input.value.trim()||(attachments.length?'请查看这些附件':'' );if(text&&!sending&&!uploading&&agentState&&agentConfig?.configured){draft='';input.value='';void submit(text);}};
    host.querySelector('#directorMessage').value=draft;
    const composerInput=host.querySelector('#directorMessage');
    const closeMentions=bindDirectorMentions(composerInput,{items:()=>nodes().filter(n=>n.kind==='asset'||n.taskId),attach:id=>attachCanvasFiles([id]),signal:popoverEvents.signal});
    host.querySelector('[data-agent-new]').addEventListener('click',closeMentions);
    host.querySelector('[data-agent-history]').addEventListener('click',closeMentions);
    const resizeComposer=()=>{composerInput.style.height='auto';composerInput.style.height=`${Math.min(180,Math.max(76,composerInput.scrollHeight))}px`;};
    composerInput.addEventListener('input',resizeComposer);
    composerInput.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!sending)host.querySelector('.dw-composer').requestSubmit();}};
    composerInput.addEventListener('focus',()=>host.querySelector('.dw-composer').classList.add('is-focused'));
    composerInput.addEventListener('blur',()=>host.querySelector('.dw-composer').classList.remove('is-focused'));
    resizeComposer();
    host.querySelector('.dw-canvas').addEventListener('dblclick',event=>{if(selected&&!event.target.closest('video,input,textarea,button')){inspectorOpen=true;drawInspector();}});
    host.querySelector('.director-workspace').addEventListener('keydown',event=>{if(event.key==='Escape'){inspectorOpen=false;selected='';canvas.selectNodes([]);drawInspector();}});

    const toggleAgent=collapsed=>{host.querySelector('.director-workspace').classList.toggle('agent-collapsed',collapsed);host.querySelector('[data-show-agent]').hidden=!collapsed; if(!collapsed)requestAnimationFrame(()=>composerInput.focus());};
    host.querySelector('[data-hide-agent]').onclick=()=>toggleAgent(true);
    host.querySelector('[data-show-agent]').onclick=()=>toggleAgent(false);
    host.querySelector('[data-director-delegate]').onclick=()=>void agentAction(()=>agentClient.resume());
    host.querySelector('[data-director-stop]').onclick=()=>void agentAction(()=>agentClient.interrupt());
    const token=epoch;
    agentClient=createCreativeAgentClient({api:bridge.agentApi,projectId,onHistory:items=>{if(token===epoch){conversations=items;drawPanels();}},onState:(state,config)=>{if(token!==epoch)return;agentState=state;agentConfig=config;connectionError=config.configured?'':'对话服务尚未配置';drawPanels();},onError:error=>{if(token===epoch&&!error.stale){connectionError=error.message;drawPanels();}}});
    void agentClient.start().catch(error=>{if(token===epoch){connectionError=error.message;drawPanels();}});
    drawPanels();
  }
  async function switchConversation(id){
    if(sending||uploading)return;
    sending=true;drawPanels();
    try{await (id?agentClient.open(id):agentClient.newConversation());host.querySelector('#directorHistoryPicker').hidePopover();historyOpen=false;attachments=[];host.querySelector('#directorMessage').value='';connectionError='';}
    catch(error){connectionError=error.message;}
    finally{sending=false;drawPanels();}
  }
  async function submit(text,files=attachments,selectionIds=selected?[selected]:[]){
    const composerSend=files===attachments;
    if(sending||uploading)return;
    sending=true;drawPanels();
    try{await save();const content=text+(files.length?'\n\n附件：\n'+files.map(f=>`${f.name}（素材 ID：${f.id}）`).join('\n'):'');await agentClient.send(content,[...new Set([...selectionIds,...files.map(f=>f.id)])]);if(composerSend)attachments=[];connectionError='';}
    catch(error){if(!error.stale){connectionError=error.message;if(composerSend)host.querySelector('#directorMessage').value=text;bridge.toast(error.message);}}
    finally{sending=false;drawPanels();}
  }
  function dispose(){resizingChat=false;resizeCanvasSnapshot=null;if(resizeFinishFrame)cancelAnimationFrame(resizeFinishFrame);resizeFinishFrame=0;popoverEvents?.abort();assetSizeLoads.forEach(image=>{image.onload=null;image.onerror=null;});assetSizeLoads.clear();assetImages.clear();assetSizes.clear();attachments=[];uploading=false;cancelAnimationFrame(streamFrame);streamFrame=0;visibleDraft='';targetDraft='';streamSession='';resizeObserver?.disconnect();agentClient?.dispose();agentClient=null;agentState=null;agentConfig=null;connectionError='';conversations=[];historyOpen=false;epoch++;stopped=true;busy=false;clearTimeout(saveTimer);if(edgeRenderFrame)cancelAnimationFrame(edgeRenderFrame);edgeRenderFrame=0;mainLayer?.off?.('.director-edges');mainLayer=null;canvasMount?.unmount?.();canvasMount=null;canvas=null;projectId='';selected='';inspectorOpen=false;lastNodeGeometry='';}
  return {mount,refresh:drawPanels,dispose};
}
