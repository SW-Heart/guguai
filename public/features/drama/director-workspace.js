import { CanvasApi } from '../../vendor/director/whiteboard.js?v=2';
import { normalizeDirectorWorkspace, applyDirectorEdit } from './director-actions.js?v=2';

const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={queued:'等待制作',running:'制作中',completed:'已完成',succeeded:'已完成',failed:'失败',cancelled:'已取消',pending:'等待制作',processing:'生成中'};
const paid=new Set(['generate_resource','generate_video','assemble','read_tail']);
export function createDirectorWorkspace(host, bridge) {
  let canvas, projectId='', syncing=false, saveTimer, selected='', busy=false, stopped=false, epoch=0, draft='', layoutHistory=[], inspectorOpen=false;
  const assetSizes=new Map(), assetSizeLoads=new Map();
  const get=()=>bridge.project();
  const workspace=()=>{const p=get();return p.directorWorkspace ||= normalizeDirectorWorkspace();};
  const save=async()=>{const result=await bridge.patch({directorWorkspace:workspace()});if(!result)throw new Error('工作台状态未保存，请重试');};
  const message=text=>workspace().messages.push({id:crypto.randomUUID(),role:'assistant',text});
  function nodes() {
    const p=get();return [...bridge.imported().map(f=>({id:f.id,kind:'asset',title:f.name||'参考素材',text:'已导入素材',item:f,media:f})),{id:'story',kind:'story',title:'剧情',text:p.synopsis||p.script||'写下一句话，让故事从这里开始。'},...p.resources.map(x=>({id:x.id,kind:'resource',title:x.name,text:x.description||x.prompt,item:x,taskId:x.selectedTaskId||x.versions?.at(-1)})),...p.shots.map((x,i)=>({id:x.id,kind:'shot',title:`${String(i+1).padStart(2,'0')} · ${x.title}`,text:x.script||x.prompt||'等待导演设计这一镜',item:x,taskId:x.selectedVideoTaskId||x.videoVersions?.at(-1)}))];
  }
  function position(n,i) {if(n.kind==='asset')return workspace().positions[n.id]||{x:40+i*300,y:-140};i-=bridge.imported().length;return workspace().positions[n.id]||{x:n.kind==='story'?40:n.kind==='resource'?360:700+Math.floor((i-1-get().resources.length)/3)*320,y:n.kind==='story'?160:n.kind==='resource'?40+(i-1)*260:40+((i-1-get().resources.length)%3)*260};}
  function assetBounds(url){
    const size=assetSizes.get(url);
    if(!size)return {width:280,height:220};
    const scale=Math.min(280/size.width,220/size.height,1);
    return {width:Math.max(24,Math.round(size.width*scale)),height:Math.max(24,Math.round(size.height*scale))};
  }
  function loadAssetSize(id,url){
    if(assetSizes.has(url)||assetSizeLoads.has(url))return;
    const image=new Image();
    assetSizeLoads.set(url,image);
    image.onload=()=>{
      assetSizeLoads.delete(url);
      if(!image.naturalWidth||!image.naturalHeight)return;
      assetSizes.set(url,{width:image.naturalWidth,height:image.naturalHeight});
      const current=canvas?.getNodeConfigById(id);
      if(current?.$_type==='image'&&current.$_imageUrl===url){
        const bounds=assetBounds(url);
        canvas.updateNodes([id],bounds);
      }
    };
    image.onerror=()=>assetSizeLoads.delete(url);
    image.src=url;
  }
  function nodeContent(n) {
    // Imported images are real whiteboard image nodes. They intentionally have
    // no business card chrome; the canvas owns their selection, resize, crop
    // and layer interactions. Videos still use the media card below because
    // this bundled whiteboard has no native video node type.
    if(n.kind==='asset'&&n.media?.kind==='image')return '';
    const t=bridge.task(n.taskId);const media=n.media||bridge.media(n.taskId);const action=workspace().plan?.actions?.find(a=>a.targetId===n.id&&['running','failed'].includes(a.status));
    const status=action?labels[action.status]:t?(labels[t.status]||t.status):n.kind==='asset'?'已导入':n.kind==='story'&&get().script?'已设计':'待制作';
    const locked=workspace().lockedIds.includes(n.id);
    return `<article class="dw-node${selected===n.id?' is-selected':''}" data-node-id="${escape(n.id)}" style="box-sizing:border-box;width:280px;height:228px;border:1px solid ${action?.status==='failed'?'#d66b64':'#dfe2ee'};border-radius:16px;background:#fff;color:#24283d;overflow:hidden;font:14px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px #26345b0b"><header style="padding:12px 14px;display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #eef0f6"><b>${escape(n.title)}</b><span style="font-size:12px;color:#535c86">${locked?'已锁定':escape(status)}</span></header>${media?`<${media.kind==='video'?'video controls':'img'} src="${escape(media.url)}" ${media.kind==='image'?`alt="${escape(n.title)}"`:''} style="width:100%;height:124px;object-fit:contain;background:#f1f2f8" >${media.kind==='video'?'</video>':''}`:`<p style="padding:0 14px;height:124px;overflow:auto;white-space:pre-wrap;line-height:1.65">${escape(n.text)}</p>`}<footer style="padding:7px 14px;font-size:12px;color:#636b83">${n.kind==='shot'?`${n.item.duration} 秒 · ${n.item.aspectRatio} · ${n.item.videoVersions?.length||0} 个版本`:n.kind==='resource'?({character:'角色',location:'场景',prop:'道具'}[n.item.type]||'素材'):n.kind==='asset'?'参考素材':'故事蓝图'}${t?.progress?` · ${Math.round(t.progress)}%`:''}</footer></article>`;
  }
  function syncCanvas() {
    if(!canvas)return;syncing=true;
    const ns=nodes();const existing=new Map(canvas.getState().nodes.map(n=>[n.id,n]));
    const links=ns.filter(n=>n.kind!=='story'&&n.kind!=='asset').map(n=>({from:n.kind==='resource'?'story':(n.item.resourceIds?.find(id=>ns.some(x=>x.id===id))||'story'),to:n.id}));
    const valid=new Set([...ns.map(n=>n.id),...links.map(l=>`edge-${l.to}`)]);
    canvas.deleteNodes([...existing.keys()].filter(id=>!valid.has(id)));
    ns.forEach((n,i)=>{
      const old=existing.get(n.id);const pos=position(n,i);
      if(n.kind==='asset'&&n.media?.kind==='image'){
        const url=n.media?.url;
        if(!url)return;
        loadAssetSize(n.id,url);
        const bounds=assetBounds(url);
        // Replace the old custom HTML card in place.  Keeping the project id
        // as the canvas id means selections and saved positions remain stable.
        if(old && (old.$_type!=='image'||old.$_imageUrl!==url)){
          canvas.deleteNodes([n.id]);
          canvas.createNodes([{id:n.id,$_type:'image',$_actualType:'director-asset',$_imageUrl:url,...bounds,...pos,draggable:true}],false);
        }else if(!old){
          canvas.createNodes([{id:n.id,$_type:'image',$_actualType:'director-asset',$_imageUrl:url,...bounds,...pos,draggable:true}],false);
        }else if(old.x!==pos.x||old.y!==pos.y){
          canvas.updateNodes([n.id],{x:pos.x,y:pos.y});
        }
        return;
      }
      const html=nodeContent(n);
      if(!old)canvas.createNodes([{id:n.id,$_type:'html',$_actualType:'director',$_htmlContent:html,width:280,height:228,...pos,draggable:true}],false);
      else if(old.$_type==='html'&&old.$_htmlContent!==html)canvas.updateNodes([n.id],{$_htmlContent:html});
    });
    links.forEach(l=>{const from=canvas.getNodeConfigById(l.from),to=canvas.getNodeConfigById(l.to);if(!from||!to)return;const id=`edge-${l.to}`;const config={id,$_type:'arrow',x:0,y:0,points:[from.x+280,from.y+114,to.x,to.y+114],stroke:'#b7bad4',fill:'#b7bad4',strokeWidth:1.5,pointerLength:6,pointerWidth:6,$_listening:false};if(existing.has(id))canvas.updateNodes([id],config);else canvas.createNodes([config],false);canvas.moveNodesToBottom([id]);});
    syncing=false;
  }
  function syncEdges(snapshotNodes=canvas?.getState().nodes||[]) {
    if(!canvas)return;
    const ns=nodes();
    const links=ns.filter(n=>n.kind!=='story'&&n.kind!=='asset').map(n=>({from:n.kind==='resource'?'story':(n.item.resourceIds?.find(id=>ns.some(x=>x.id===id))||'story'),to:n.id}));
    const byId=new Map(snapshotNodes.map(node=>[node.id,node]));
    const updates=[];
    links.forEach(link=>{
      const from=byId.get(link.from),to=byId.get(link.to);
      if(!from||!to)return;
      updates.push({id:`edge-${link.to}`,points:[from.x+280,from.y+114,to.x,to.y+114]});
    });
    if(!updates.length)return;
    syncing=true;
    updates.forEach(({id,points})=>{if(canvas.getNodeConfigById(id))canvas.updateNodes([id],{points});});
    syncing=false;
  }
  function drawPanels() {
    if(!canvas)return;
    const w=workspace(),p=get(),plan=w.plan;
    host.querySelector('[data-director-mode]').value=w.autonomy;
    host.querySelector('[data-director-mode]').disabled=busy;
    host.querySelector('[data-director-delegate]').disabled=busy;
    host.querySelector('[data-director-stop]').hidden=!busy;
    const messages=host.querySelector('.dw-messages');const stickToBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<60;
    const messagesMarkup=w.messages.length?w.messages.map(m=>`<div class="dw-message ${m.role}"><small>${m.role==='user'?'你':'智能导演'}</small><p>${escape(m.text)}</p></div>`).join(''):`<div class="dw-welcome"><h2>这一部，想拍什么？</h2><p>告诉我你的创意，或选中画布上的角色、分镜继续创作。</p><button data-example>做一个 30 秒的霸总反转短剧</button></div>`;
    if(messages.innerHTML!==messagesMarkup)messages.innerHTML=messagesMarkup;
    host.querySelector('[data-example]')?.addEventListener('click',()=>{host.querySelector('#directorMessage').value='给我做一个30秒霸总反转短剧';host.querySelector('#directorMessage').focus();});
    const planOpen=host.querySelector('.dw-plan details')?.open;
    host.querySelector('.dw-plan').innerHTML=plan?`<b>${escape(plan.summary)}</b><p>${plan.actions.filter(a=>a.status==='succeeded').length} / ${plan.actions.length} 项已完成</p><details><summary>查看制作计划</summary>${plan.actions.map(a=>`<p>${escape(a.label)} · ${labels[a.status]||a.status}${a.error?`：${escape(a.error)}`:''}</p>`).join('')}</details>${!busy&&plan.actions.some(a=>a.status!=='succeeded')?'<button data-confirm class="dw-primary">确认并继续制作</button>':''}`:'';
    if(planOpen&&host.querySelector('.dw-plan details'))host.querySelector('.dw-plan details').open=true;
    host.querySelector('[data-confirm]')?.addEventListener('click',()=>void resume());
    const sendButton=host.querySelector('[data-director-send]');
    sendButton.disabled=busy;
    sendButton.textContent=busy?'处理中…':'发送';
    sendButton.setAttribute('aria-busy',String(busy));
    if(stickToBottom)messages.scrollTop=messages.scrollHeight;
    if(!host.querySelector('.dw-inspector')?.contains(document.activeElement))drawInspector();syncCanvas();
  }
  function drawInspector() {
    const n=nodes().find(n=>n.id===selected),el=host.querySelector('.dw-inspector');
    el.hidden=!n;
    if(!n){el.innerHTML='';return;}
    const locked=workspace().lockedIds.includes(n.id);
    const ask=()=>{host.querySelector('.director-workspace').classList.remove('agent-collapsed');host.querySelector('[data-show-agent]').hidden=true;const input=host.querySelector('#directorMessage');input.value=`${n.kind==='asset'?'使用':'修改'}「${n.title}」：`;input.focus();};
    if(!inspectorOpen||n.kind==='asset'){
      el.classList.add('compact');
      el.innerHTML=`<b>${escape(n.title)}</b>${n.kind==='asset'?'':'<button data-open-edit>编辑</button>'}<button data-quick-lock>${locked?'解锁':'锁定'}</button><button data-quick-ask class="dw-primary">交给导演</button><button data-dismiss-selection aria-label="取消选择">×</button>`;
      el.querySelector('[data-open-edit]')?.addEventListener('click',()=>{inspectorOpen=true;drawInspector();});
      el.querySelector('[data-quick-lock]').onclick=async()=>{workspace().lockedIds=locked?workspace().lockedIds.filter(id=>id!==n.id):[...workspace().lockedIds,n.id];await save();drawPanels();};
      el.querySelector('[data-quick-ask]').onclick=ask;
      el.querySelector('[data-dismiss-selection]').onclick=()=>{selected='';canvas.selectNodes([]);drawInspector();};return;
    }
    el.classList.remove('compact');
    el.innerHTML=`<button data-close-edit class="dw-close-edit" aria-label="收起编辑">×</button><h3>${escape(n.title)}</h3><button data-lock>${locked?'解除锁定':'锁定内容'}</button><label>${n.kind==='story'?'剧本':'Prompt'}<textarea data-edit ${locked?'disabled':''}>${escape(n.kind==='story'?get().script:n.item.prompt)}</textarea></label>${n.kind==='shot'?`<label>镜头时长（秒）<input data-duration type="number" min="1" max="60" value="${n.item.duration}" ${locked?'disabled':''}></label>`:''}<button data-save-edit ${locked?'disabled':''}>保存修改</button><button data-ask-node>让导演修改此节点</button>`;
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
  async function plan(messageText, automatic=false) {
    if(busy&&!automatic)return;
    const token=epoch;busy=true;stopped=false;
    if(!automatic)workspace().messages.push({id:crypto.randomUUID(),role:'user',text:messageText});
    drawPanels();
    try {await save();const result=await bridge.plan(messageText+(selected?`\n当前选中节点 ID：${selected}`:''));if(token!==epoch)return;workspace().plan=result.plan;message(result.plan.summary);await save();const shouldRun=!stopped&&workspace().autonomy!=='assist';busy=false;if(shouldRun)await run(false);else drawPanels();}
    catch(e){if(token===epoch){message(e.message);busy=false;await save().catch(()=>{});drawPanels();}}
  }
  async function run(confirmed=false) {
    if(busy)return;const token=epoch;const p=workspace().plan;if(!p)return;
    busy=true;stopped=false;let needsApproval=false;
    try {
      p.status='running';
      for(const a of p.actions) {
        if(stopped||token!==epoch)break;
        if(a.status==='succeeded')continue;
        if(workspace().lockedIds.includes(a.targetId))throw new Error('目标节点已锁定，制作已暂停');
        if(workspace().autonomy==='assist'&&!confirmed || workspace().autonomy==='director'&&paid.has(a.type)&&!confirmed){needsApproval=true;break;}
        if(a.generationFailed&&confirmed){a.previousTaskIds=[...(a.previousTaskIds||[]),a.taskId];delete a.taskId;delete a.requestBody;delete a.generationFailed;}
        a.status='running';a.attempts++;workspace().plan=p;await save();drawPanels();
        try {
          if(['add_resource','update_resource','add_shot','update_shot'].includes(a.type))await bridge.patch(applyDirectorEdit(get(),a));
          else {
            try {await bridge.execute(a,()=>stopped||token!==epoch);}
            catch(error){
              if(error.generationFailed&&error.retryable&&workspace().autonomy==='auto'&&a.attempts<2&&!stopped){
                a.previousTaskIds=[...(a.previousTaskIds||[]),a.taskId];delete a.taskId;delete a.requestBody;a.attempts++;
                workspace().plan=p;await save();
                await bridge.execute(a,()=>stopped||token!==epoch);
              }else {if(error.generationFailed)a.generationFailed=true;throw error;}
            }
          }
          if(token!==epoch)return;
          a.status='succeeded';a.error='';
        }catch(e){a.status='failed';a.error=e.message;p.status='paused';throw e;}
        // Server mutations replace the project, so retain the active plan explicitly.
        workspace().plan=p;await save();drawPanels();
      }
      p.status=stopped?'paused':needsApproval?'awaiting_confirmation':p.actions.every(a=>a.status==='succeeded')?'completed':'paused';
      if(needsApproval)message('设计已准备好。请查看制作计划，确认后开始生成素材与视频。');
      else if(p.status==='completed')message('本轮制作已完成，结果已经更新到画布。');
      workspace().plan=p;await save();
    }catch(e){if(token===epoch){workspace().plan=p;p.status='paused';message(`制作已暂停：${e.message}`);await save().catch(()=>{});}}
    finally{if(token===epoch){busy=false;drawPanels();}}
  }
  function mount() {
    if(projectId===get().id&&canvas&&host.querySelector('.dw-canvas')){drawPanels();return;}
    dispose();projectId=get().id;
    host.innerHTML=`<section class="director-workspace"><section class="dw-board"><div class="dw-canvas" aria-label="无限分镜画布"></div><div class="dw-canvas-actions"><button data-import title="导入素材到画布">＋ 导入素材</button><button data-show-agent hidden>打开导演</button></div><section class="dw-inspector" hidden></section><footer class="dw-tools" aria-label="画布工具"><button data-tool="select" aria-label="选择节点" title="选择并移动节点">选择</button><button data-tool="hand" aria-label="平移画布" title="拖动画布">平移</button><button data-tool="text" aria-label="添加文字" title="在画布上添加文字">文字</button><button data-tool="rectangle" aria-label="添加形状" title="绘制形状">形状</button><button data-tool="arrow" aria-label="添加箭头" title="连接节点">箭头</button><button data-tool="brush" aria-label="画笔" title="自由绘制">画笔</button><span class="dw-tool-divider"></span><button data-zoom-out aria-label="缩小">−</button><output>75%</output><button data-zoom-in aria-label="放大">＋</button><button data-fit title="自动排列并查看全部节点">整理</button><button data-layout-undo title="撤销上次整理">撤销</button></footer></section><aside class="dw-agent"><header><b>导演</b><select data-director-mode aria-label="导演自治等级"><option value="assist">辅助模式</option><option value="director">导演模式</option><option value="auto">全自动模式</option></select><button data-hide-agent aria-label="收起导演对话" title="收起对话，扩大画布">→</button></header><div class="dw-messages" aria-live="polite"></div><div class="dw-plan"></div><form class="dw-composer"><label for="directorMessage" class="dw-sr-only">告诉导演你的目标</label><textarea id="directorMessage" placeholder="想拍什么？或选中画面告诉我怎么改…" rows="3"></textarea><div><button data-director-delegate type="button" title="接管当前项目，完成剩余制作">委托导演</button><button data-director-stop type="button" hidden>暂停</button><button data-director-send class="dw-primary" type="submit" aria-label="发送给导演">发送</button></div></form></aside></section>`;
    canvas=new CanvasApi(host.querySelector('.dw-canvas'));canvas.updateViewport(workspace().viewport);
    canvas.on('nodes:selected',ids=>{const next=ids.find(id=>!id.startsWith('edge-'))||'';if(next!==selected)inspectorOpen=false;selected=next;drawInspector();syncCanvas();});
    let edgeFrame=0;
    let latestSnapshot=null;
    const queueEdgeSync=snapshot=>{latestSnapshot=snapshot;if(edgeFrame)return;edgeFrame=requestAnimationFrame(()=>{edgeFrame=0;const next=latestSnapshot;latestSnapshot=null;if(next)syncEdges(next.nodes);});};
    canvas.on('state:change',snapshot=>{if(syncing)return;queueEdgeSync(snapshot);const visibleIds=new Set(nodes().map(item=>item.id));const positions=Object.fromEntries(snapshot.nodes.filter(n=>visibleIds.has(n.id)).map(n=>[n.id,{x:n.x,y:n.y}]));workspace().positions=positions;workspace().viewport=snapshot.viewport;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(get()?.id===projectId)void save().catch(e=>bridge.toast(e.message));},600);});
    canvas.on('viewport:change',v=>{workspace().viewport=v;host.querySelector('output').textContent=`${Math.round(v.scale*100)}%`;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(get()?.id===projectId)void save().catch(e=>bridge.toast(e.message));},600);});
    host.querySelector('[data-director-mode]').onchange=async e=>{workspace().autonomy=e.target.value;stopped=busy;await save();};
    host.querySelector('.dw-composer').onsubmit=e=>{e.preventDefault();const input=host.querySelector('#directorMessage');const text=input.value.trim();if(text){draft='';input.value='';void submit(text);}};
    host.querySelector('#directorMessage').value=draft;
    const composerInput=host.querySelector('#directorMessage');
    const resizeComposer=()=>{composerInput.style.height='auto';composerInput.style.height=`${Math.min(180,Math.max(76,composerInput.scrollHeight))}px`;};
    composerInput.addEventListener('input',resizeComposer);
    composerInput.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!busy)host.querySelector('.dw-composer').requestSubmit();}};
    composerInput.addEventListener('focus',()=>host.querySelector('.dw-composer').classList.add('is-focused'));
    composerInput.addEventListener('blur',()=>host.querySelector('.dw-composer').classList.remove('is-focused'));
    resizeComposer();
    host.querySelector('.dw-canvas').addEventListener('dblclick',event=>{if(selected&&!event.target.closest('video,input,textarea,button')){inspectorOpen=true;drawInspector();}});
    host.querySelector('.director-workspace').addEventListener('keydown',event=>{if(event.key==='Escape'){inspectorOpen=false;selected='';canvas.selectNodes([]);drawInspector();}});

    const toggleAgent=collapsed=>{host.querySelector('.director-workspace').classList.toggle('agent-collapsed',collapsed);host.querySelector('[data-show-agent]').hidden=!collapsed; if(!collapsed)requestAnimationFrame(()=>composerInput.focus());};
    host.querySelector('[data-hide-agent]').onclick=()=>toggleAgent(true);
    host.querySelector('[data-show-agent]').onclick=()=>toggleAgent(false);
    host.querySelector('[data-import]').onclick=async()=>{try{const file=await bridge.importAsset();if(!file)return;const v=canvas.getState().viewport;workspace().positions[file.id]={x:(80-v.x)/v.scale,y:(100-v.y)/v.scale};await save();syncCanvas();canvas.selectNodes([file.id]);}catch(e){bridge.toast(e.message);}};
    host.querySelector('[data-director-delegate]').onclick=()=>void delegate();
    host.querySelector('[data-director-stop]').onclick=()=>{stopped=true;message('将在当前任务结束后暂停，你可以接管继续修改。');drawPanels();};
    const setTool=type=>{canvas.setToolType(type);host.querySelectorAll('[data-tool]').forEach(button=>{const active=button.dataset.tool===type;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});};
    host.querySelectorAll('[data-tool]').forEach(button=>{button.onclick=()=>setTool(button.dataset.tool);});
    setTool('select');
    host.querySelector('[data-zoom-in]').onclick=()=>canvas.updateViewport({scale:Math.min(3,canvas.getState().viewport.scale*1.2)});
    host.querySelector('[data-zoom-out]').onclick=()=>canvas.updateViewport({scale:Math.max(.1,canvas.getState().viewport.scale/1.2)});
    host.querySelector('[data-fit]').onclick=()=>{layoutHistory.push(structuredClone(workspace().positions));layoutHistory=layoutHistory.slice(-30);workspace().positions={};syncing=true;nodes().forEach((n,i)=>canvas.updateNodes([n.id],position(n,i)));syncing=false;canvas.scrollToContent({padding:40,scale:true});void save();};
    host.querySelector('[data-layout-undo]').onclick=()=>{const last=layoutHistory.pop();if(!last)return;workspace().positions=last;syncing=true;nodes().forEach((n,i)=>canvas.updateNodes([n.id],position(n,i)));syncing=false;void save();};
    drawPanels();
  }
  async function continueStages() {
    const token=epoch;
    for(let round=0;round<8&&token===epoch&&!stopped&&workspace().autonomy!=='assist'&&workspace().delegated&&workspace().plan?.status==='completed'&&!get().finalAssetId;round++){
      if(!workspace().plan.actions.length)break;
      await plan('继续完成剩余制作，检查当前结果；已有成功版本不要重复生成。所有镜头完成后 assemble。',true);
    }
  }
  async function submit(text){
    if(workspace().autonomy==='auto')workspace().delegated=true;
    await plan(text);await continueStages();
  }
  async function resume(){await run(true);await continueStages();}
  async function delegate() {
    workspace().delegated=true;
    await plan('委托你完成剩余制作。读取已有剧情、人物、场景、镜头及已选版本，保留锁定内容，先执行当前可完成的阶段。');
    await continueStages();
  }
  function dispose(){epoch++;stopped=true;busy=false;clearTimeout(saveTimer);canvas?.dispose();canvas=null;projectId='';selected='';inspectorOpen=false;}
  return {mount,refresh:drawPanels,dispose};
}
