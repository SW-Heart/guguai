import { renameAssistantConversation, deleteAssistantConversation, assistantConversationMenuPosition } from './history-actions.js?v=1';
import { mountAssistantSuggestions, applySuggestionSkill } from './suggestions.js?v=5';
import { mountAssistantSkillPicker } from './skill-picker.js?v=2';
import { attachmentAccept, maxAttachments, validateAttachment, readDocument, uploadAssistantImage, assistantAttachmentMessage } from './attachments.js?v=1';
import { mountAttachmentPreviews } from '../agent/attachment-preview.js?v=5';
import { createReasoningText, reasoningPhrases } from '../agent/reasoning-text.js?v=4';
import { createCreativeAgentClient } from '../agent/client.js?v=15';
import { createAssistantStream, patchAssistantDraft, renderAssistantMessages, assistantMessageFiles } from './conversation.js?v=4';
import { createMessageScroller } from '../agent/message-scroller.js?v=7';
import { renderAssistantHistory, renderAssistantShell, renderAssistantWelcome } from './presentation.js?v=8';
import { mountAssistantModelPicker } from './model-picker.js?v=8';
import { mountContentCopy } from '../agent/code-block.js?v=2';

const activeReply = state => ['running','queued','waiting_job'].includes(state);

// Keep the existing Agent transport and message components; only adapt its session scope.
export function assistantApi(api, { getModel = () => '', onCreated = () => {} } = {}) {
  return async (path, options) => {
    const url = new URL(path, 'https://local.invalid');
    if (url.pathname === '/api/agent/config' || (url.pathname === '/api/agent/sessions' && !options?.method)) url.searchParams.set('mode','assistant');
    if (options?.body) {
      const body = JSON.parse(options.body);
      if (url.pathname === '/api/agent/sessions') {
        delete body.projectId; delete body.agentProjectId;
        body.mode = 'assistant';
        if (getModel()) body.model = getModel();
      }
      delete body.modelPreferences;
      options = {...options,body:JSON.stringify(body)};
    }
    const result = await api(url.pathname + url.search, options);
    if(url.pathname === '/api/agent/sessions' && options?.method === 'POST') onCreated(result.id);
    if (/^\/api\/agent\/sessions\/[\w-]+(?:\/settings)?$/.test(url.pathname) && result.settings && result.settings.mode !== 'assistant') throw new Error('请打开助手对话');
    return result;
  };
}

export function mountAssistant({ host, api, toast, setCreditBalance = () => {} }) {
  const events = new AbortController();
  let localSkills=[],localSkillRefresh=0;
  const nativeSkills=globalThis.guguDesktop?.localSkills;
  let disposed = false, client, current, config, busy = false, renderedId = '', selectedModel = '', items = [], historySignature = '', menuTarget=null, menuAnchor=null, renameTarget=null, deleteTarget=null;
  const request = async (...args) => {
    if(disposed)throw new Error('对话已关闭');
    const result = await api(...args);
    if(disposed)throw new Error('对话已关闭');
    return result;
  };
  host.innerHTML = renderAssistantShell();
  const $ = selector => host.querySelector(selector);
  const input = $('#assistantMessage'), status = $('[data-status]');
  const suggestions=mountAssistantSuggestions($('[data-suggestions]'),input,{signal:events.signal,onDraft:toast,onUse:async item=>{let applied=false;await perform(async()=>{await applySuggestionSkill(item,{catalog:config?.skills,selected:current.settings.skill,select:saveSkill});applied=true;});return applied;}});
  let attachments=[],uploading=false,attachmentEpoch=0;
  const revoke=file=>{if(file.previewUrl?.startsWith('blob:'))URL.revokeObjectURL(file.previewUrl);};
  function clearAttachments(){attachmentEpoch++;attachments.forEach(revoke);attachments=[];uploading=false;drawAttachments();}
  function drawAttachments(){
    $('[data-attachments]').hidden=!attachments.length;
    const fileStatus=$('[data-file-status]');fileStatus.textContent=uploading?(attachments.some(file=>file.kind==='image'&&file.status==='loading')?'正在上传图片…':'正在读取文件…'):attachments.some(file=>file.status==='error')?'有文件未能读取，请移除后重新添加':'';fileStatus.hidden=!fileStatus.textContent;
    previews.update(attachments.map(file=>({...file,removeDisabled:busy})));
    controls();
  }
  const previews=mountAttachmentPreviews($('[data-attachments]'),{signal:events.signal,onRemove:file=>{const item=attachments.find(item=>item.key===file.key);if(item)revoke(item);attachments=attachments.filter(item=>item.key!==file.key);drawAttachments();}});
  const messagePreviews=mountAttachmentPreviews($('.dw-message-history'),{signal:events.signal,renderCards:false});
  async function addFiles(files){
    if(uploading||busy||!current)return;
    const token=attachmentEpoch;uploading=true;controls();
    try{for(const file of files){
      if(disposed||token!==attachmentEpoch)break;
      if(attachments.length>=maxAttachments){toast('一次最多添加 10 个文件');break;}
      let item;
      try{
        const {kind}=validateAttachment(file);
        item={key:crypto.randomUUID(),name:file.name.replace(/[\\/\r\n\u0000-\u001f]/g,' ').slice(0,160),size:file.size,kind,status:'loading',file};
        if(kind==='image')item.previewUrl=URL.createObjectURL(file);
        attachments.push(item);drawAttachments();
        if(kind==='image'){
          item.asset=await uploadAssistantImage(file,request,{signal:events.signal});
        }else{
          item.text=await readDocument(file);
          if(attachments.filter(other=>other!==item&&other.kind==='document').reduce((total,other)=>total+(other.text?.length||0),0)+item.text.length>800_000)throw new Error('文字内容过多，请减少文件数量');
        }
        if(disposed||token!==attachmentEpoch)break;
        item.status='ready';
      }catch(error){if(item)item.status='error';if(!disposed&&token===attachmentEpoch)toast(`${file.name}：${error.message||'文件未能读取，请重新添加'}`);}
      if(!disposed&&token===attachmentEpoch)drawAttachments();
    }}finally{if(!disposed&&token===attachmentEpoch){uploading=false;drawAttachments();}}
  }
  const fileInput=$('[data-file-input]');fileInput.accept=attachmentAccept;
  $('[data-upload]').onclick=()=>fileInput.click();
  fileInput.onchange=()=>{const files=[...fileInput.files];fileInput.value='';void addFiles(files);};
  input.addEventListener('paste',event=>{const files=[...event.clipboardData?.files||[]].filter(file=>file.type.startsWith('image/'));if(files.length){event.preventDefault();void addFiles(files);}},{signal:events.signal});
  const composer=$('.assistant-composer');
  composer.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();composer.classList.add('is-dragging');}},{signal:events.signal});
  composer.addEventListener('dragleave',event=>{if(!composer.contains(event.relatedTarget))composer.classList.remove('is-dragging');},{signal:events.signal});
  composer.addEventListener('drop',event=>{composer.classList.remove('is-dragging');if(event.dataTransfer?.files.length){event.preventDefault();void addFiles([...event.dataTransfer.files]);}},{signal:events.signal});
  async function refreshLocalSkills(){
    if(!nativeSkills||disposed)return;
    const token=++localSkillRefresh;
    try{const result=await nativeSkills.list();if(!disposed&&token===localSkillRefresh){localSkills=result.items||[];controls();}}catch{}
  }
  async function saveSkill(skill){
    if(skill.startsWith('local-')){
      if(!nativeSkills)throw new Error('请在桌面客户端重新添加此本地技能');
      const localSkill=await nativeSkills.snapshot(skill);
      await client.settings({skill,localSkill});
    }else await client.settings({skill});
  }
  const skillPicker=mountAssistantSkillPicker(host,{signal:events.signal,onOpen:()=>void refreshLocalSkills(),onChange:async skill=>{let saved=false;await perform(async()=>{await saveSkill(skill);saved=true;});return saved;},onAdd:async()=>{
    let selected=false;
    await perform(async()=>{
      if(!nativeSkills)throw new Error('请在最新版桌面客户端中添加本地 Skill');
      const result=await nativeSkills.choose();if(disposed||result.canceled)return;
      localSkills=result.items||[];
      if(result.added?.length===1){await saveSkill(result.added[0].name);selected=true;}
      toast(`已添加 ${result.added?.length||0} 个本地技能`);
    });
    return selected;
  }});
  const stopLocalSkillChanges=nativeSkills?.onChanged(()=>void refreshLocalSkills());
  events.signal.addEventListener('abort',()=>stopLocalSkillChanges?.(),{once:true});
  const modelPicker=mountAssistantModelPicker(host,{signal:events.signal,onChange:model=>void perform(()=>client.settings({model}))});
  const scroller = createMessageScroller($('.dw-messages'),$('.dw-message-rail'),$('.assistant-chat'),$('[data-message-jump]'));
  const reasoning=createReasoningText();
  $('.dw-turn-activity').prepend(reasoning.element);
  const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const draftContent=document.createElement('div');draftContent.className='dw-message-content';
  $('.dw-message-draft').replaceChildren(draftContent);
  const stream=createAssistantStream({immediate:()=>reducedMotion.matches,render:(view,{frameOnly})=>{
    if(!frameOnly){renderAssistantMessages($('.dw-message-history'),view.messages,renderAssistantWelcome);messagePreviews.update(assistantMessageFiles(view.messages));}
    patchAssistantDraft(draftContent,view.draft);
    $('.dw-message-draft').hidden=!view.draft;
    reasoning.update({active:Boolean(config?.configured)&&view.working,phrases:reasoningPhrases({activity:view.activity,streaming:Boolean(view.draft)})});
    scroller.refresh();
  }});
  mountContentCopy(host,{signal:events.signal,onError:toast});
  const conversationMenu=$('#assistantConversationMenu');
  function conversationTarget(id){const item=items.find(item=>item.id===id);return {id,title:item?.title||(id===current?.id?current.settings?.title:'')||'新对话'};}
  function targetMenu(id,anchor){menuTarget={...conversationTarget(id),fromHistory:Boolean(anchor.closest('[data-history]'))};menuAnchor=anchor;}
  function restoreMenuFocus(target){
    if(disposed||!target)return;
    const row=target.fromHistory&&sidebarOpen?[...host.querySelectorAll('[data-history-more]')].find(button=>button.dataset.historyMore===target.id):null;
    const anchor=target.fromHistory&&sidebarOpen?(row||$('[data-history-search]')):$('[data-more]');
    anchor?.focus({preventScroll:true});
  }
  $('[data-more]').onclick=event=>{if(current)targetMenu(current.id,event.currentTarget);};
  conversationMenu.addEventListener('beforetoggle',event=>{
    if(event.newState!=='open')return;
    const anchor=menuAnchor?.isConnected?menuAnchor:$('[data-more]');
    const position=assistantConversationMenuPosition(anchor.getBoundingClientRect(),window.innerWidth,window.innerHeight);
    conversationMenu.style.top=`${position.top}px`;conversationMenu.style.left=`${position.left}px`;
  },{signal:events.signal});
  conversationMenu.addEventListener('toggle',event=>{if(event.newState==='open')$('[data-rename]').focus({preventScroll:true});},{signal:events.signal});
  conversationMenu.addEventListener('keydown',event=>{
    const rows=[...conversationMenu.querySelectorAll('button:not(:disabled)')],index=rows.indexOf(document.activeElement);
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||!rows.length)return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?rows.length-1:(index+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length;rows[next].focus();
  },{signal:events.signal});
  $('[data-history]').addEventListener('scroll',()=>{if(menuAnchor?.closest('[data-history]'))conversationMenu.hidePopover();},{signal:events.signal});
  const shell=$('.assistant-workspace'), sidebar=$('.assistant-history'), toggle=$('[data-sidebar-toggle]');
  let compact=host.clientWidth<820, sidebarOpen=!compact;
  function setSidebar(open,{focus=false}={}) {
    const wasOpen=sidebarOpen;
    sidebarOpen=open;
    if(!open&&menuAnchor?.closest('[data-history]'))conversationMenu.hidePopover();
    shell.classList.toggle('is-sidebar-open',open);
    shell.classList.toggle('is-compact',compact);
    sidebar.inert=!open;
    $('.assistant-chat').inert=compact&&open;
    $('[data-sidebar-close].assistant-sidebar-overlay').hidden=!(compact&&open);
    toggle.setAttribute('aria-expanded',String(open));
    toggle.setAttribute('aria-label',open?'收起历史对话':'展开历史对话');
    if(focus&&open)sidebar.querySelector('[data-sidebar-close]').focus();
    else if(wasOpen&&!open&&sidebar.contains(document.activeElement))toggle.focus();
  }
  toggle.onclick=()=>setSidebar(!sidebarOpen,{focus:compact});
  for(const button of host.querySelectorAll('[data-sidebar-close]'))button.onclick=()=>setSidebar(false);
  $('[data-history-search]').oninput=()=>{history();controls();};
  shell.addEventListener('keydown',event=>{
    if(host.querySelector('dialog[open]')||conversationMenu.matches(':popover-open'))return;
    if(event.key==='Escape'&&compact&&sidebarOpen){event.preventDefault();setSidebar(false);toggle.focus();}
    if(event.key==='Tab'&&compact&&sidebarOpen){
      const focusable=[...sidebar.querySelectorAll('button:not(:disabled),input')];
      const first=focusable[0], last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  },{signal:events.signal});
  const shellObserver=typeof ResizeObserver==='undefined'?null:new ResizeObserver(([entry])=>{
    const next=entry.contentRect.width<820;
    if(next!==compact){compact=next;setSidebar(!next);}
  });
  shellObserver?.observe(shell);
  setSidebar(sidebarOpen);
  function resizeComposer(){input.style.height='auto';input.style.height=`${Math.min(200,Math.max(56,input.scrollHeight))}px`;}
  function history() {
    const query=$('[data-history-search]').value;
    const title=current?.settings?.title||items.find(item=>item.id===current?.id)?.title||'新对话';
    $('[data-conversation-title]').textContent=title;
    $('[data-conversation-title]').title=title;
    const next=JSON.stringify([current?.id,items,query]);
    if(historySignature===next)return;
    historySignature=next;
    $('[data-history]').innerHTML = renderAssistantHistory(items,current?.id,query);
  }
  function controls() {
    const running = activeReply(current?.state), ready = Boolean(current && config?.configured && !busy);
    suggestions.update({sessionId:current?.id||'',empty:Boolean(current&&!current.messages.length&&!current.draft&&!running),disabled:!ready||running||uploading});
    $('[data-send]').hidden=running;
    $('[data-more]').disabled=!current||busy;
    $('[data-send]').disabled = !ready || running || uploading || attachments.some(file=>file.status!=='ready') || (!input.value.trim()&&!attachments.length);
    skillPicker.update({skills:[...(config?.skills||[]),...localSkills,...(current?.settings?.localSkill&&!localSkills.some(skill=>skill.name===current.settings.localSkill.name)?[current.settings.localSkill]:[])],selected:current?.settings?.skill||'',disabled:!ready||running});
    modelPicker.update({models:config?.models||[],value:selectedModel,disabled:!ready||running});
    $('[data-upload]').disabled=!ready||uploading;
    $('[data-stop]').hidden = !running;
    $('[data-stop]').disabled = busy;
    $('[data-resume]').hidden = !['paused','failed'].includes(current?.state);
    $('[data-resume]').disabled = !ready;
    for(const button of host.querySelectorAll('[data-new]'))button.disabled=busy||!client;
    $('[data-delete]').disabled = !current || busy;
    $('[data-rename]').disabled = !current || busy;
    for(const button of host.querySelectorAll('[data-session],[data-history-more]'))button.disabled=busy;
  }
  function state(value, settings) {
    if(disposed)return;
    current=value; config=settings; selectedModel=value.settings.model;
    const changed = renderedId!==value.id;
    if(changed){conversationMenu.hidePopover();skillPicker.close();clearAttachments();renderedId=value.id;input.value='';resizeComposer();$('[data-title-dialog]').close();}
    const chat=$('.assistant-chat'),empty=!value.messages.length&&!value.draft&&!activeReply(value.state);
    if(changed||chat.classList.contains('is-empty')!==empty)chat.scrollTop=0;
    chat.classList.toggle('is-empty',empty);
    stream.update(value);
    status.textContent=!config?.configured?'对话服务暂时不可用，请稍后再试':(activeReply(value.state)?'':value.activity||'');
    setCreditBalance(value.balance);
    history();controls();scroller.refresh({reset:changed});
  }
  async function perform(action) {
    if(busy||disposed)return;
    busy=true;controls();
    try{await action();}catch(error){if(!disposed){toast(error.message);status.textContent=error.message;}}
    finally{busy=false;if(!disposed)controls();}
  }
  const adapter=assistantApi(request,{getModel:()=>selectedModel});
  $('[data-history]').onclick=event=>{const more=event.target.closest('[data-history-more]');if(more){if(!busy)targetMenu(more.dataset.historyMore,more);return;}const id=event.target.closest('[data-session]')?.dataset.session;if(id&&id!==current?.id)void perform(async()=>{await client.open(id);if(compact)setSidebar(false);});};
  for(const button of host.querySelectorAll('[data-new]'))button.onclick=()=>void perform(async()=>{await client.newConversation();if(compact)setSidebar(false);input.focus();});
  input.oninput=()=>{resizeComposer();controls();};
  input.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!event.defaultPrevented){event.preventDefault();$('.assistant-composer').requestSubmit();}};
  $('.assistant-composer').onsubmit=event=>{
    event.preventDefault();const text=input.value.trim();
    if((!text&&!attachments.length)||busy||uploading||attachments.some(file=>file.status!=='ready')||activeReply(current?.state)||!config?.configured)return;
    const payload=assistantAttachmentMessage(text,attachments);
    void perform(async()=>{if(current.settings.skill?.startsWith('local-'))await saveSkill(current.settings.skill);await client.send(payload.text,payload.selection,payload.documents);clearAttachments();if(input.value.trim()===text){input.value='';resizeComposer();}});
  };
  $('[data-stop]').onclick=()=>void perform(()=>client.interrupt());
  $('[data-resume]').onclick=()=>void perform(()=>client.resume());
  $('[data-rename]').onclick=()=>{
    if(!menuTarget||busy)return;renameTarget={...menuTarget};
    $('[data-title]').value=renameTarget.title;conversationMenu.hidePopover();$('[data-title-dialog]').showModal();$('[data-title]').select();
  };
  for(const button of host.querySelectorAll('[data-cancel-title]'))button.onclick=()=>{$('[data-title-dialog]').close();};
  $('[data-title-form]').onsubmit=event=>{
    event.preventDefault();if(!renameTarget||busy)return;const id=renameTarget.id,title=$('[data-title]').value.trim();
    void perform(async()=>{await renameAssistantConversation({id,title,currentId:()=>current?.id,client,request});$('[data-title-dialog]').close();});
  };
  $('[data-title-dialog]').addEventListener('close',()=>{const target=renameTarget;renameTarget=null;restoreMenuFocus(target);},{signal:events.signal});
  $('[data-delete]').onclick=()=>{
    if(!menuTarget||busy)return;deleteTarget={...menuTarget};conversationMenu.hidePopover();
    const dialog=$('[data-delete-dialog]');dialog.returnValue='';$('[data-delete-name]').textContent=`“${deleteTarget.title}”`;dialog.showModal();
  };
  $('[data-delete-dialog]').addEventListener('close',()=>{
    const target=deleteTarget;deleteTarget=null;
    if($('[data-delete-dialog]').returnValue!=='delete'||!target){restoreMenuFocus(target);return;}
    const deletingCurrent=target.id===current?.id;
    void perform(async()=>{await deleteAssistantConversation({id:target.id,currentId:()=>current?.id,client,request});if(deletingCurrent){if(compact)setSidebar(false);input.focus({preventScroll:true});}else restoreMenuFocus(target);});
  },{signal:events.signal});
  $('[data-reconnect]').onclick=()=>{client?.dispose();client=null;$('[data-reconnect]').hidden=true;void start();};
  async function start() {
    try{
      const result=await request('/api/agent/sessions?mode=assistant');
      items=result.sessions;
      selectedModel=items[0]?.model||'';
      client=createCreativeAgentClient({api:adapter,initialSessionId:items[0]?.id||'',onState:state,onError:error=>{if(!disposed){status.textContent=error.message;}},onHistory:values=>{if(!disposed){items=values;history();controls();}}});
      await client.start();
      await refreshLocalSkills();
    }catch(error){if(!disposed){status.textContent=error.message;$('[data-reconnect]').hidden=false;toast(error.message);}}
  }
  void start();
  return {dispose(){disposed=true;localSkillRefresh++;attachmentEpoch++;attachments.forEach(revoke);reasoning.destroy();stream.dispose();client?.dispose();events.abort();shellObserver?.disconnect();scroller.destroy();$('[data-title-dialog]')?.close();$('#assistantConversationMenu')?.hidePopover();$('[data-delete-dialog]')?.close();host.replaceChildren();}};
}
