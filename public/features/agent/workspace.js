import { attachmentKind, mountAttachmentPreviews } from './attachment-preview.js?v=3';
import { createDirectorWorkspace } from '../drama/director-workspace.js?v=126';
import { normalizeDirectorWorkspace } from '../drama/director-actions.js?v=11';
import { projectLoadingMarkup } from './project-loading.js?v=1';
import { mountSkillGallery } from './skill-gallery.js?v=6';
import { defaultTitleFromMessage } from './default-title.js?v=1';
import { agentWelcomeHeroMarkup, creativePresetsMarkup, bindCreativePresets } from './welcome.js?v=1';
import { mountModelPreferencePicker } from './model-preference-picker.js?v=10';

const previewUrl=file=>String(file?.url||'').startsWith('gugu-media://')?file.url:file?.previewUrl||file?.url||'';

export function createAgentWorkspace({api,state,toast,uploadAsset,importCanvasAsset,loadFiles,loadTasks,scheduleTaskPoll,syncDesktopDeliveries,setCreditBalance,accountSnapshot,isAccountCurrent,onProjectTitleChanged}) {
  const host=document.querySelector('#agentView');
  const project={id:'',directorWorkspace:normalizeDirectorWorkspace(),assetIds:[],resources:[],shots:[],script:'',synopsis:''};
  let view=null,sessionId='',account=null,initialMessage='',initialAttachments=[],initialDocuments=[],initialSkill='',initialModelPreferences,screen='',navigationEpoch=0,creating=false;
  let homeActionsController=null;
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const locationFor=(viewName,id='')=>viewName==='workspace'?`/projects/${encodeURIComponent(id)}`:'/agent';
  function changeLocation(viewName,id=''){window.history.pushState({route:viewName==='workspace'?'project':'agent'},'',locationFor(viewName,id));}
  function dispatchRoute(){window.dispatchEvent(new PopStateEvent('popstate'));}
  function resetView(){navigationEpoch++;homeActionsController?.abort();homeActionsController=null;view?.dispose();view=null;host.replaceChildren();sessionId='';project.id='';project.directorWorkspace=normalizeDirectorWorkspace();project.assetIds=[];initialMessage='';initialAttachments=[];initialDocuments=[];initialSkill='';initialModelPreferences=undefined;}
  function showHome(){
    if(screen==='home'&&isAccountCurrent(account)&&host.querySelector('.agent-entry'))return;
    resetView();account=accountSnapshot();screen='home';
    renderEntry(host);
  }
  function renderEntry(host,{onSubmit=createProject,config=null,skill='',modelPreferences,onModelPreferencesChange}={}){
    homeActionsController?.abort();
    host.innerHTML=`<section class="agent-entry"><div class="agent-entry-main">${agentWelcomeHeroMarkup('h1')}${creativePresetsMarkup()}<form class="agent-entry-form"><label class="dw-sr-only" for="agentEntryMessage">描述你的创作想法</label><div class="agent-entry-attachments attachment-strip" aria-label="已添加的文件"></div><textarea id="agentEntryMessage" rows="3" placeholder="写下你的想法，GuGu 会和你一起完成……"></textarea><div class="agent-entry-footer"><div class="agent-entry-add-wrap"><button type="button" class="agent-entry-add" data-entry-add aria-label="添加文件" title="添加文件" aria-haspopup="menu" aria-expanded="false" aria-controls="agentEntryActions"><span class="gugu-lucide gugu-lucide-plus" aria-hidden="true"></span></button><div class="agent-entry-menu" id="agentEntryActions" role="menu" aria-label="添加文件" hidden><button type="button" role="menuitem" data-entry-action="library"><span class="agent-entry-menu-icon" aria-hidden="true"><span class="gugu-lucide gugu-lucide-folder-open"></span></span><span class="agent-entry-menu-copy"><span>从文件库选择</span><small>已保存的图片、视频或音频</small></span></button><button type="button" role="menuitem" data-entry-action="local"><span class="agent-entry-menu-icon" aria-hidden="true"><span class="gugu-lucide gugu-lucide-upload"></span></span><span class="agent-entry-menu-copy"><span>从本地上传</span><small>图片、音频、视频或文档</small></span></button></div></div><input type="file" data-entry-files multiple hidden accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/aac,audio/webm,audio/flac,.pdf,.docx,.txt,.md,.csv,.json,.html,.rtf"><span class="agent-entry-spacer"></span><button type="submit" class="dw-primary agent-entry-send" aria-label="发送消息" title="发送消息" disabled><span class="gugu-lucide gugu-lucide-arrow-up" aria-hidden="true"></span></button></div></form></div></section>`;
    const form=host.querySelector('.agent-entry-form'),input=host.querySelector('#agentEntryMessage'),filePicker=host.querySelector('[data-entry-files]'),chipList=host.querySelector('.agent-entry-attachments'),send=host.querySelector('.agent-entry-send');
    const addButton=host.querySelector('[data-entry-add]'),addMenu=host.querySelector('.agent-entry-menu'),addWrap=host.querySelector('.agent-entry-add-wrap');
    const skillIcon='<span class="gugu-lucide gugu-lucide-book-open-check" aria-hidden="true"></span>';
    input.insertAdjacentHTML('beforebegin',`<div class="agent-entry-selected-skill" data-entry-selected-skill hidden>${skillIcon}<span></span><button type="button" data-entry-skill-remove aria-label="移除所选创作方式"><span class="gugu-lucide gugu-lucide-x" aria-hidden="true"></span></button></div>`);
    addWrap.insertAdjacentHTML('afterend',`<div class="agent-entry-skill-wrap"><button type="button" class="agent-entry-skill-trigger" data-entry-skill aria-label="选择创作方式" title="选择创作方式" aria-haspopup="menu" aria-expanded="false" aria-controls="agentEntrySkillMenu" disabled>${skillIcon}</button><div class="agent-entry-menu agent-entry-skill-menu" id="agentEntrySkillMenu" role="menu" aria-label="选择创作方式" hidden></div></div>`);
    const skillWrap=host.querySelector('.agent-entry-skill-wrap'),skillButton=host.querySelector('[data-entry-skill]'),skillMenu=host.querySelector('.agent-entry-skill-menu'),selectedSkillChip=host.querySelector('[data-entry-selected-skill]');
    const attachments=[],localPreviewUrls=new Set();
    let busy=0,submitting=false,modelUpdating=false,preferencesReady=modelPreferences!==undefined,selectedSkill='',availableSkills=[];
    const menuEvents=new AbortController();homeActionsController=menuEvents;
    const modelPicker=mountModelPreferencePicker(addWrap,{
      value:modelPreferences,signal:menuEvents.signal,
      loadCatalog:()=>api('/api/agent/media-models',{signal:menuEvents.signal}),
      onOpen:()=>setMenu('',false),
      onError:error=>toast(error.message||'保存失败，请重试。'),
      onReady:ready=>{preferencesReady=ready;updateComposer();},
      onSave:async value=>{modelUpdating=true;updateComposer();try{if(onModelPreferencesChange)await onModelPreferencesChange(value);else await api('/api/agent/model-preferences',{method:'PUT',body:JSON.stringify({modelPreferences:value}),signal:menuEvents.signal});}finally{modelUpdating=false;if(!menuEvents.signal.aborted)updateComposer();}},
    });
    const fitSkillMenu=()=>{
      if(skillMenu.hidden)return;
      const trigger=skillButton.getBoundingClientRect(),viewport=host.querySelector('.agent-entry').getBoundingClientRect();
      const top=Math.max(0,viewport.top),bottom=Math.min(window.innerHeight,viewport.bottom),gap=21;
      const below=Math.max(0,bottom-trigger.bottom-gap),above=Math.max(0,trigger.top-top-gap);
      const opensUp=below<Math.min(420,skillMenu.scrollHeight)&&above>below;
      skillMenu.classList.toggle('opens-up',opensUp);
      skillMenu.style.maxHeight=`${Math.min(420,opensUp?above:below)}px`;
    };
    const setMenu=(name,open)=>{
      for(const [key,button,menu] of [['files',addButton,addMenu],['skill',skillButton,skillMenu]]){
        const active=key===name&&open;
        menu.hidden=!active;button.setAttribute('aria-expanded',String(active));button.classList.toggle('is-open',active);
        if(active){if(menu===skillMenu){menu.scrollTop=0;fitSkillMenu();}menu.querySelector('[role^="menuitem"]')?.focus({preventScroll:true});}
      }
    };
    const chooseSkill=value=>{selectedSkill=value;const selected=availableSkills.find(item=>item.name===value);selectedSkillChip.hidden=!selected;selectedSkillChip.querySelector('span:not(.gugu-lucide)').textContent=selected?.title||'';selectedSkillChip.querySelector('[data-entry-skill-remove]').setAttribute('aria-label',`移除${selected?.title||'所选创作方式'}`);skillButton.classList.toggle('is-selected',Boolean(selected));skillMenu.querySelectorAll('[data-entry-skill-option]').forEach(option=>option.setAttribute('aria-checked',String(option.dataset.entrySkillOption===value)));updateComposer();};
    const renderSkills=()=>{skillMenu.innerHTML=availableSkills.map(item=>`<button type="button" role="menuitemcheckbox" aria-checked="false" data-entry-skill-option="${escape(item.name)}"><span class="agent-entry-menu-icon" aria-hidden="true">${skillIcon}</span><span class="agent-entry-menu-copy"><span>${escape(item.title||item.name)}</span><small>${escape(item.summary||'')}</small></span></button>`).join('');skillButton.disabled=!availableSkills.length;};
    const ready=()=>attachments.filter(item=>item.status==='ready');
    const updateComposer=()=>{
      input.style.height='auto';
      const lineHeight=Number.parseFloat(getComputedStyle(input).lineHeight)||27;
      input.style.height=`${Math.min(Math.max(input.scrollHeight,3*lineHeight),8*lineHeight)}px`;
      send.disabled=!preferencesReady||submitting||modelUpdating||busy>0||(!input.value.trim()&&!ready().length&&!selectedSkill);
      send.setAttribute('aria-busy',String(submitting||modelUpdating||busy>0));
      modelPicker.update({disabled:submitting});
    };
    const releasePreview=item=>{if(item?.previewUrl&&localPreviewUrls.delete(item.previewUrl))URL.revokeObjectURL(item.previewUrl);};
    const previews=mountAttachmentPreviews(chipList,{signal:menuEvents.signal,onRemove:file=>{
      const index=attachments.findIndex(item=>item.key===file.key);
      if(index<0)return;
      releasePreview(attachments[index]);attachments.splice(index,1);drawAttachments();input.focus({preventScroll:true});
    }});
    menuEvents.signal.addEventListener('abort',()=>{localPreviewUrls.forEach(url=>URL.revokeObjectURL(url));localPreviewUrls.clear();},{once:true});
    const drawAttachments=()=>{
      if(menuEvents.signal.aborted)return;
      previews.update(attachments.map(item=>({...item.asset,...item,kind:item.asset?.kind||attachmentKind(item),previewUrl:item.previewUrl||previewUrl(item.asset)})));
      updateComposer();
    };
    const addSelectedFiles=async files=>{
      for(const file of files){
        if(menuEvents.signal.aborted)return;
        if(!file||attachments.length>=30){toast('一次最多添加 30 个文件');break;}
        const extension=String(file.name).split('.').pop().toLowerCase();
        if(['pdf','docx','txt','md','csv','json','html','rtf'].includes(extension)&&attachments.filter(item=>item.kind==='document'&&item.status==='ready').length>=10){toast('一次最多添加 10 份文档');continue;}
        const fileLimit=['pdf','docx'].includes(extension)?15:extension==='png'||extension==='jpg'||extension==='jpeg'||extension==='webp'?20:25;
        if(file.size>fileLimit*1024*1024){toast(`${file.name} 超过 ${fileLimit} MB`);continue;}
        const item={key:crypto.randomUUID(),name:file.name,size:file.size,type:file.type,status:'loading',kind:'',asset:null,text:'',previewUrl:''};
        if(['image','video','audio'].includes(attachmentKind(item))){item.previewUrl=URL.createObjectURL(file);localPreviewUrls.add(item.previewUrl);}
        attachments.push(item);busy++;drawAttachments();
        try{
          const mediaMime=file.type||({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4',aac:'audio/aac',flac:'audio/flac'}[extension]||'');
          if(mediaMime.startsWith('image/')||mediaMime.startsWith('audio/')||mediaMime.startsWith('video/')){
            const mimeType=mediaMime==='image/jpg'?'image/jpeg':mediaMime;
            const intent=await api('/api/files/uploads/init',{method:'POST',body:JSON.stringify({mimeType,name:file.name,size:file.size})});
            let asset=intent.asset;
            if(!asset){
              const uploaded=await fetch(intent.uploadUrl,{method:'PUT',headers:intent.headers||{},body:file});
              if(!uploaded.ok)throw new Error('文件上传失败，请重试');
              asset=await api(`/api/files/uploads/${encodeURIComponent(intent.uploadId)}/complete`,{method:'POST',body:'{}'});
            }
            if(menuEvents.signal.aborted)return;
            if(!current())throw new Error('账号已切换，请重新添加文件');
            state.files=[asset,...state.files.filter(entry=>entry.id!==asset.id)];
            item.asset={...asset,previewUrl:previewUrl(asset)};item.kind='media';
          }else if(['pdf','docx'].includes(extension)){
            const result=await api(`/api/agent/documents/extract?name=${encodeURIComponent(file.name)}`,{method:'POST',body:file,timeoutMs:120000});
            item.text=result.text;item.kind='document';
          }else if(['txt','md','csv','json','html','rtf'].includes(extension)){
            let text=await file.text();
            if(extension==='html')text=new DOMParser().parseFromString(text,'text/html').body.textContent||'';
            if(extension==='rtf')text=text.replace(/\\'[0-9a-f]{2}/gi,' ').replace(/\\[a-z]+-?\\d* ?/gi,' ').replace(/[{}]/g,'').replace(/\\\\/g,'\\');
            item.text=text;item.kind='document';
          }else throw new Error('暂不支持这种文件格式');
          if(item.kind==='document'){
            if(!item.text.trim())throw new Error('文件中没有可读取的文字内容');
            if(item.text.length>300_000)throw new Error('文档文字内容过长，暂时无法读取');
            const priorLength=attachments.filter(entry=>entry!==item&&entry.status==='ready'&&entry.kind==='document').reduce((total,entry)=>total+entry.text.length,0);
            if(priorLength+item.text.length>800_000)throw new Error('附带文件内容过多，请减少文件数量');
          }
          if(!current())throw new Error('账号已切换，请重新添加文件');
          item.status='ready';
        }catch(error){item.status='error';if(!menuEvents.signal.aborted)toast(`${file.name}：${error.message}`);}
        finally{busy=Math.max(0,busy-1);drawAttachments();}
      }
    };
    const addLibraryAsset=async()=>{
      if(attachments.length>=30){toast('一次最多添加 30 个文件');return;}
      const selected=await importCanvasAsset({chat:true,multiple:true,maxFiles:30-attachments.length});
      if(!selected||!current()||menuEvents.signal.aborted)return;
      for(const file of Array.isArray(selected)?selected:[selected]){
        if(menuEvents.signal.aborted||!current())return;
        if(!file||attachments.some(item=>item.asset?.id===file.id&&item.status!=='error'))continue;
        if(attachments.length>=30){toast('一次最多添加 30 个文件');break;}
        const item={key:crypto.randomUUID(),name:file.name,size:file.size,status:'loading',kind:file.kind,asset:null,text:'',previewUrl:previewUrl(file)};
        attachments.push(item);busy++;drawAttachments();
        try{
          state.files=[file,...state.files.filter(entry=>entry.id!==file.id)];
          const readyAsset=await cloudFile(file);
          if(menuEvents.signal.aborted)return;
          if(!readyAsset||!current())throw new Error('素材暂时无法使用，请重试');
          item.asset={...readyAsset,previewUrl:previewUrl(readyAsset)};item.status='ready';
        }catch(error){item.status='error';if(!menuEvents.signal.aborted)toast(`${file.name}：${error.message}`);}
        finally{busy=Math.max(0,busy-1);drawAttachments();}
      }
    };
    addButton.onclick=()=>setMenu('files',addMenu.hidden);
    addMenu.onclick=event=>{
      const action=event.target.closest('[data-entry-action]');if(!action)return;
      const selected=action.dataset.entryAction;setMenu('',false);
      if(selected==='local')filePicker.click();else if(selected==='library')void addLibraryAsset();
    };
    skillButton.onclick=()=>setMenu('skill',skillMenu.hidden);
    skillMenu.onclick=event=>{const option=event.target.closest('[data-entry-skill-option]');if(!option)return;chooseSkill(option.dataset.entrySkillOption);setMenu('',false);input.focus({preventScroll:true});};
    selectedSkillChip.querySelector('[data-entry-skill-remove]').onclick=()=>{chooseSkill('');input.focus({preventScroll:true});};
    document.addEventListener('pointerdown',event=>{if((!addMenu.hidden||!skillMenu.hidden)&&!addWrap.contains(event.target)&&!skillWrap.contains(event.target))setMenu('',false);},{signal:menuEvents.signal});
    window.addEventListener('resize',fitSkillMenu,{signal:menuEvents.signal});
    host.querySelector('.agent-entry').addEventListener('scroll',fitSkillMenu,{passive:true,signal:menuEvents.signal});
    document.addEventListener('keydown',event=>{
      const menu=!addMenu.hidden?addMenu:!skillMenu.hidden?skillMenu:null;if(!menu)return;
      const button=menu===addMenu?addButton:skillButton,items=[...menu.querySelectorAll('[role^="menuitem"]')],index=items.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();setMenu('',false);button.focus({preventScroll:true});}
      else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const delta=event.key==='ArrowDown'?1:-1;items[(index+delta+items.length)%items.length]?.focus({preventScroll:true});}
    },{signal:menuEvents.signal});
    filePicker.onchange=()=>{void addSelectedFiles([...filePicker.files]);filePicker.value='';};
    input.addEventListener('input',updateComposer);
    bindCreativePresets(host,input,{signal:menuEvents.signal,isDisabled:()=>submitting});
    input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!send.disabled)form.requestSubmit();}});
    form.onsubmit=event=>{
      event.preventDefault();if(send.disabled){if(!input.value.trim()&&!ready().length&&!selectedSkill)input.focus();return;}
      const files=ready(),media=files.filter(item=>item.asset).map(item=>item.asset),documents=files.filter(item=>item.kind==='document').map(item=>({title:item.name,text:item.text}));
      const selected=availableSkills.find(item=>item.name===selectedSkill);
      const text=input.value.trim()||(selected?(files.length?`请根据我添加的文件，帮我完成${selected.title||'创作'}。`:`我想进行${selected.title||'创作'}，请告诉我需要提供什么。`):(documents.length?'请参考我附带的文件开始创作。':''));
      submitting=true;updateComposer();void onSubmit(text,media,documents,selectedSkill,modelPicker.getValue()).catch(error=>{if(!menuEvents.signal.aborted)toast(error.message);}).finally(()=>{if(!menuEvents.signal.aborted){submitting=false;updateComposer();}});
    };
    const gallery=mountSkillGallery(host.querySelector('.agent-entry'),{signal:menuEvents.signal,onChoose:name=>{
      chooseSkill(name);setMenu('',false);
      form.scrollIntoView({block:'center',behavior:'instant'});
      input.focus({preventScroll:true});
    },onRetry:()=>loadSkills()});
    const applyConfig=value=>{if(menuEvents.signal.aborted)return;availableSkills=value.skills||[];renderSkills();chooseSkill(skill);gallery.update(availableSkills);};
    const loadSkills=()=>api('/api/agent/skills',{signal:menuEvents.signal}).then(applyConfig).catch(()=>gallery.error());
    if(config)applyConfig(config);else void loadSkills();
    updateComposer();
    const dispose=()=>menuEvents.abort();
    dispose.updateModelPreferences=value=>modelPicker.update({value});
    return dispose;
  }
  async function createProject(message='',attachments=[],documents=[],skill='',modelPreferences){
    if(creating)return;
    creating=true;const token=navigationEpoch;
    try{
      const title=defaultTitleFromMessage(message)||defaultTitleFromMessage(documents.length?`根据${documents[0].title}创作`:attachments.length?'基于附件开始创作':'')||'新项目';
      const {project:created}=await api('/api/agent/projects',{method:'POST',body:JSON.stringify({title})});
      if(token!==navigationEpoch)return;
      changeLocation('workspace',created.id);await openProject(created.id,message,attachments,documents,skill,modelPreferences);dispatchRoute();
    }catch(error){if(token===navigationEpoch)toast(error.message);}
    finally{creating=false;}
  }
  async function openProject(id,message='',attachments=[],documents=[],skill='',modelPreferences){
    if(screen==='workspace'&&project.id===id&&view)return;
    resetView();const token=navigationEpoch;screen='loading';host.innerHTML=`<div class="agent-project-loading is-opening" role="status" aria-live="polite" aria-busy="true">${projectLoadingMarkup}</div>`;
    try{
      const result=await api(`/api/agent/projects/${encodeURIComponent(id)}`);
      if(screen!=='loading'||token!==navigationEpoch)return;
      project.id=result.project.id;project.title=result.project.title;initialMessage=message;initialAttachments=attachments;initialDocuments=documents.map((file,index)=>({...file,id:file.id||`entry-${index}-${crypto.randomUUID()}`}));initialSkill=skill;initialModelPreferences=modelPreferences;screen='workspace';mountWorkspace();
    }catch(error){if(token!==navigationEpoch)return;toast(error.message);changeLocation('home');dispatchRoute();}
  }
  const asset=id=>state.files.find(file=>file.id===id&&file.localStatus!=='missing');
  const task=id=>state.tasks.find(item=>item.id===id);
  const taskAsset=id=>asset(task(id)?.assetId);
  const current=()=>isAccountCurrent(account);
  async function cloudFile(file){
    if(!file)return null;
    if(!file.localOnly&&file.remoteStatus!=='local_only'&&file.referenceSourceAvailable!==false)return {...file,previewUrl:previewUrl(file)};
    const sourceId=file.localId||file.id;
    const result=await window.guguDesktop?.media?.syncLocal?.({assetId:sourceId,uploadForReference:true});
    if(!current())return null;
    if(!result?.cloudAsset?.id||result.cloudAsset.remoteStatus==='local_only')throw new Error('素材上传失败，请重试');
    const synced={...result.cloudAsset,url:result.url||result.cloudAsset.url,localId:sourceId,localStatus:'saved'};
    state.files=[synced,...state.files.filter(item=>item.id!==synced.id)];
    return {...synced,previewUrl:previewUrl(synced)};
  }
  async function saveCanvas(changes={}){
    if(!sessionId)throw new Error('对话正在连接，请稍后重试');
    if(changes.directorWorkspace)project.directorWorkspace=changes.directorWorkspace;
    if(changes.assetIds)project.assetIds=changes.assetIds;
    const result=await api(`/api/agent/sessions/${sessionId}/canvas`,{method:'PATCH',body:JSON.stringify({directorWorkspace:project.directorWorkspace,assetIds:project.assetIds})});
    if(!current())return null;
    return result.canvas;
  }
  function mountWorkspace(){
    if(view){view.mount();return;}
    const nextAccount=accountSnapshot();
    if(account&&(account.epoch!==nextAccount.epoch||account.userId!==nextAccount.userId))sessionId='';
    account=nextAccount;
    view=createDirectorWorkspace(host,{
      agentMode:true,agentProjectId:()=>'',creativeProjectId:()=>project.id,initialSessionId:()=>sessionId,
      initialMessage:()=>{const text=initialMessage;initialMessage='';return text;},
      initialAttachments:()=>{const files=initialAttachments;initialAttachments=[];return files;},
      initialDocuments:()=>{const files=initialDocuments;initialDocuments=[];return files;},
      initialSkill:()=>{const skill=initialSkill;initialSkill='';return skill;},
      initialModelPreferences:()=>{const value=initialModelPreferences;initialModelPreferences=undefined;return value;},
      renderEmptyConversation:renderEntry,
      hasInitialContent:()=>Boolean(initialMessage||initialAttachments.length||initialDocuments.length),
      projectTitle:()=>project.title||'智能创作',onProjectBack:()=>{changeLocation('home');dispatchRoute();},
      sessionChanged:session=>{
        const keepCanvas=Boolean(sessionId)&&session?.agentProjectId===project.id;
        sessionId=session?.id||'';
        if(keepCanvas)return;
        project.directorWorkspace=normalizeDirectorWorkspace(session?.canvas?.directorWorkspace);
        project.assetIds=Array.isArray(session?.canvas?.assetIds)?session.canvas.assetIds:[];
      },
      project:()=>project,task,toast,
      messageAttachment:file=>{
        const local=state.files.find(item=>item.id===file.id&&item.localStatus==='saved'&&String(item.url||'').startsWith('gugu-media://'));
        return local?{...file,url:local.url,remoteUrl:file.url,previewUrl:local.url}:file;
      },
      images:()=>state.files.filter(file=>file.kind==='image'&&file.localStatus!=='missing'),
      generationConfig:()=>state.config,
      generationPricing:()=>({config:state.config,pricing:state.pricing}),
      formatCredits:value=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2}),
      imported:()=>project.assetIds.map(asset).filter(Boolean).map(file=>({...file,url:previewUrl(file)})),
      importAsset:async()=>{
        const file=await importCanvasAsset();
        if(!current()||!file)return null;
        state.files=[file,...state.files.filter(item=>item.id!==file.id)];
        const ready=await cloudFile(file);
        if(!ready)return null;
        project.assetIds=[...new Set([...project.assetIds,ready.id])];
        await saveCanvas({assetIds:project.assetIds});
        return ready;
      },
      prepareChatAsset:async({assetId,taskId})=>cloudFile(assetId?asset(assetId):taskAsset(taskId)),
      uploadChatFile:async({maxFiles=30}={})=>{
        const token=navigationEpoch,active=()=>token===navigationEpoch&&current();
        const selected=await importCanvasAsset({chat:true,multiple:true,maxFiles});
        if(!active()||!selected)return [];
        const files=Array.isArray(selected)?selected:[selected],prepared=[];
        for(const file of files){
          if(!active())return [];
          if(!file)continue;
          try{
            state.files=[file,...state.files.filter(item=>item.id!==file.id)];
            const ready=await cloudFile(file);
            if(!active())return [];
            if(ready)prepared.push(ready);
          }catch(error){if(!active())return [];toast(`${file.name}：${error.message}`);}
        }
        if(prepared.length){project.assetIds=[...new Set([...project.assetIds,...prepared.map(file=>file.id)])];await saveCanvas({assetIds:project.assetIds});}
        return prepared;
      },
      uploadGenerationFile:async()=>{
        const file=await importCanvasAsset({generation:true});
        if(!current()||!file)return null;
        state.files=[file,...state.files.filter(item=>item.id!==file.id)];
        const ready=await cloudFile(file);
        if(ready){project.assetIds=[...new Set([...project.assetIds,ready.id])];await saveCanvas({assetIds:project.assetIds});}
        return ready;
      },
      media:id=>{
        const file=taskAsset(id);
        if(!file)return null;
        if(window.guguDesktop&&(file.localStatus!=='saved'||!String(file.url||'').startsWith('gugu-media://')))return null;
        return {kind:file.kind,url:previewUrl(file),width:file.width,height:file.height};
      },
      patch:saveCanvas,
      snapshotKey:()=>'',agentApi:async(url,options)=>{
        const result=await api(url,options);
        if(!current())return result;
        if(project.title==='新项目'&&options?.method==='POST'&&/^\/api\/agent\/sessions\/[\w-]+\/messages$/.test(url)){
          const projectId=project.id;
          void api(`/api/agent/projects/${encodeURIComponent(projectId)}`).then(({project:saved})=>{
            if(!current()||project.id!==projectId||project.title!=='新项目'||!saved?.title||saved.title==='新项目')return;
            renameProject(projectId,saved.title);
            onProjectTitleChanged?.(projectId,saved.title);
          }).catch(()=>{});
        }
        if(result.balance!==undefined)setCreditBalance(result.balance);
        if(result.audioAssets?.length){
          const ids=new Set(result.audioAssets.map(item=>item.id));
          state.files=[...result.audioAssets,...state.files.filter(item=>!ids.has(item.id))];
        }
        if(result.composedAssets?.length){
          const ids=new Set(result.composedAssets.map(item=>item.id));
          state.files=[...result.composedAssets,...state.files.filter(item=>!ids.has(item.id))];
        }
        if(result.tasks?.length){
          const previousTasks=new Map(state.tasks.map(item=>[item.id,item]));
          const generatedAssetIds=[...new Set(result.tasks.map(item=>{
            const assetId=String(item?.assetId||'');
            return assetId&&String(previousTasks.get(item?.id)?.assetId||'')!==assetId?assetId:'';
          }).filter(Boolean))];
          const ids=new Set(result.tasks.map(item=>item.id));
          state.tasks=[...result.tasks,...state.tasks.filter(item=>!ids.has(item.id))];
          if(generatedAssetIds.length&&typeof syncDesktopDeliveries==='function')void syncDesktopDeliveries({assetIds:generatedAssetIds}).catch(error=>console.warn('[agent] 画布成品本地同步失败',error));
          scheduleTaskPoll(0);
        }
        return result;
      },
    });
    view.mount();
    const mountedView=view;
    void Promise.all([state.files.length?Promise.resolve():loadFiles({background:true}),loadTasks({background:true})]).then(()=>{if(view===mountedView)mountedView.refresh();}).catch(()=>{});
  }
  function load(){
    const params=new URLSearchParams(window.location.search),id=params.get('project');
    if(id){void openProject(id);return;}
    showHome();
  }
  function renameProject(id,title){
    if(!id||project.id!==String(id))return;
    project.title=title;
    const heading=host?.querySelector('.dw-agent-project-title');
    if(heading){heading.textContent=title;heading.title=title;}
  }
  return {load,showHome,loadProject:id=>openProject(id),refreshTasks:()=>view?.refresh(),renameProject,suspend(){resetView();screen='';}};
}
