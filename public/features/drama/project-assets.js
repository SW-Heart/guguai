const defaults=[{id:'character',name:'角色'},{id:'location',name:'场景'},{id:'prop',name:'物品'},{id:'audio',name:'音频'},{id:'other',name:'其他'}];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function normalizeProjectAssets(value={}){
  const types=[],names=new Set(defaults.map(type=>type.name)),ids=new Set(defaults.map(type=>type.id));
  for(const type of Array.isArray(value?.types)?value.types:[]){
    const name=String(type?.name||'').trim().slice(0,24),id=String(type?.id||'');
    if(!name||names.has(name)||ids.has(id)||!/^asset-type-[\w-]{1,100}$/.test(id)||types.length>=30)continue;
    types.push({id,name});names.add(name);ids.add(id);
  }
  const namesById=Object.fromEntries(Object.entries(value?.names&&typeof value.names==='object'?value.names:{}).filter(([id,name])=>id.length>0&&id.length<=200&&typeof name==='string'&&name.trim()).slice(0,2000).map(([id,name])=>[id,name.replace(/[\r\n\u0000-\u001f]/g,'').trim().slice(0,160)]).filter(([,name])=>name));
  return {types,names:namesById,categories:Object.fromEntries(Object.entries(value?.categories&&typeof value.categories==='object'?value.categories:{}).filter(([id,category])=>id.length>0&&id.length<=200&&ids.has(category)).slice(0,2000)),collapsed:[...new Set((Array.isArray(value?.collapsed)?value.collapsed:[]).filter(id=>ids.has(id)))]};
}
export function projectAssetGroups(items,state){
  const normalized=normalizeProjectAssets(state),groups=[...defaults,...normalized.types].map(type=>({...type,items:[]})),byId=new Map(groups.map(group=>[group.id,group])),seen=new Set();
  for(const item of items){
    if(!item?.id||seen.has(item.id))continue;seen.add(item.id);
    const category=normalized.categories[item.assetId]||normalized.categories[item.id]||(byId.has(item.category)?item.category:item.kind==='audio'?'audio':'other');
    byId.get(category).items.push(item);
  }
  return groups;
}
export function mountProjectAssetsDrawer({board,trigger,items,getState,setState,importAssets,focusAsset,toast,icon}){
  const drawer=document.createElement('aside'),events=new AbortController();
  drawer.className='dw-project-assets';drawer.hidden=true;drawer.id=`project-assets-${crypto.randomUUID()}`;drawer.setAttribute('role','dialog');drawer.setAttribute('aria-label','项目资产');trigger.setAttribute('aria-controls',drawer.id);
  drawer.innerHTML=`<header><h2>项目资产</h2><button type="button" data-assets-close aria-label="关闭项目资产">${icon('x')}</button></header><div class="dw-project-assets-groups"></div><footer><button type="button" data-assets-custom>${icon('plus')}<span>添加自定义类型</span></button><form hidden><label>类型名称<input name="name" maxlength="24" autocomplete="off" placeholder="输入类型名称" required></label><div><button type="button" data-assets-cancel>取消</button><button type="submit">添加</button></div></form></footer>`;
  board.append(drawer);
  let disposed=false,adding=false,moving=false,draggedId='',dropTarget=null,suppressClickUntil=0,signature='',groupEvents=new AbortController();
  const body=drawer.querySelector('.dw-project-assets-groups'),form=drawer.querySelector('form');
  const save=async state=>{await setState(normalizeProjectAssets(state));};
  function update(force=false){
    if(disposed||drawer.hidden||draggedId)return;
    const state=normalizeProjectAssets(getState()),groups=projectAssetGroups(items(),state),next=JSON.stringify([groups,state.collapsed,adding]);
    if(!force&&signature===next)return;signature=next;
    groupEvents.abort();groupEvents=new AbortController();
    const scroll=body.scrollTop;
    body.innerHTML=groups.map(group=>`<details data-assets-group="${esc(group.id)}" ${state.collapsed.includes(group.id)?'':'open'}><summary><span>${esc(group.name)}<small>${group.items.length}</small></span><button type="button" data-assets-add="${esc(group.id)}" aria-label="添加${esc(group.name)}资产" ${adding?'disabled':''}>${icon('plus')}</button></summary><div class="dw-project-assets-list">${group.items.map(item=>`<div class="dw-project-asset"><button type="button" draggable="true" data-asset-focus="${esc(item.id)}" title="${esc(item.name)}（可拖动到其他分类）">${item.kind==='image'&&item.url?`<img src="${esc(item.url)}" alt="" draggable="false" loading="lazy">`:icon(item.kind==='audio'?'music':item.kind==='video'?'video':'file-text')}<span>${esc(item.name)}</span></button>${item.kind==='audio'&&item.url?`<audio src="${esc(item.url)}" controls preload="none" aria-label="播放${esc(item.name)}"></audio>`:''}</div>`).join('')||'<p class="dw-project-assets-empty">暂无资产</p>'}</div></details>`).join('');
    body.scrollTop=scroll;
    body.querySelectorAll('details').forEach(details=>details.addEventListener('toggle',()=>{
      if(disposed||!details.isConnected)return;
      const state=normalizeProjectAssets(getState()),collapsed=new Set(state.collapsed),id=details.dataset.assetsGroup;
      if(collapsed.has(id)===!details.open)return;
      if(details.open)collapsed.delete(id);else collapsed.add(id);
      void save({...state,collapsed:[...collapsed]}).catch(error=>toast(error.message));
    },{signal:groupEvents.signal}));
  }
  function highlight(target){
    if(dropTarget===target)return;
    dropTarget?.classList.remove('is-assets-drop-target');dropTarget=target;
    dropTarget?.classList.add('is-assets-drop-target');
  }
  function endDrag(){draggedId='';highlight(null);suppressClickUntil=Date.now()+250;}
  drawer.addEventListener('dragstart',event=>{
    const asset=event.target.closest?.('[data-asset-focus]');
    if(!asset||!drawer.contains(asset)||!event.dataTransfer)return;
    event.stopPropagation();
    if(moving){event.preventDefault();return;}
    draggedId=asset.dataset.assetFocus;
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('application/x-gugu-project-asset',draggedId);
  },{signal:events.signal});
  drawer.addEventListener('dragover',event=>{
    if(!draggedId)return;
    event.stopPropagation();
    const group=event.target.closest?.('[data-assets-group]');
    if(!group||!drawer.contains(group)){highlight(null);return;}
    event.preventDefault();event.dataTransfer.dropEffect='move';highlight(group);
  },{signal:events.signal});
  drawer.addEventListener('dragleave',event=>{
    if(dropTarget&&!dropTarget.contains(event.relatedTarget))highlight(null);
  },{signal:events.signal});
  drawer.addEventListener('drop',async event=>{
    if(!draggedId)return;
    event.preventDefault();event.stopPropagation();
    const group=event.target.closest?.('[data-assets-group]'),id=draggedId;
    endDrag();
    if(!group||!drawer.contains(group)){update();return;}
    const state=normalizeProjectAssets(getState()),groups=projectAssetGroups(items(),state),category=group.dataset.assetsGroup;
    const source=groups.find(group=>group.items.some(item=>item.id===id)),item=source?.items.find(item=>item.id===id);
    if(!item||source.id===category||!groups.some(group=>group.id===category)){update();return;}
    state.categories[item.id]=category;if(item.assetId)state.categories[item.assetId]=category;
    state.collapsed=state.collapsed.filter(id=>id!==category);
    moving=true;
    try{await save(state);}catch(error){if(!disposed)toast(error.message);}
    finally{moving=false;update(true);}
  },{signal:events.signal});
  document.addEventListener('dragend',()=>{if(draggedId){endDrag();update();}},{capture:true,signal:events.signal});
  function close(restore=false){drawer.hidden=true;trigger.setAttribute('aria-expanded','false');if(restore)trigger.focus({preventScroll:true});}
  trigger.addEventListener('click',()=>{if(!drawer.hidden){close();return;}drawer.hidden=false;trigger.setAttribute('aria-expanded','true');update(true);drawer.querySelector('[data-assets-close]').focus({preventScroll:true});},{signal:events.signal});
  drawer.addEventListener('click',async event=>{
    if(Date.now()<suppressClickUntil){event.preventDefault();event.stopPropagation();return;}
    if(event.target.closest('[data-assets-close]')){close(true);return;}
    if(event.target.closest('[data-assets-custom]')){form.hidden=false;form.elements.name.focus();return;}
    if(event.target.closest('[data-assets-cancel]')){form.hidden=true;form.reset();return;}
    const add=event.target.closest('[data-assets-add]');
    if(add){
      event.preventDefault();event.stopPropagation();if(adding)return;
      const category=add.dataset.assetsAdd;adding=true;update(true);
      try{
        const files=await importAssets();if(disposed)return;
        if(files?.length){const state=normalizeProjectAssets(getState());for(const file of files)state.categories[file.id]=category;await save(state);}
      }catch(error){if(!disposed)toast(error.message);}
      finally{adding=false;update(true);}
      return;
    }
    const asset=event.target.closest('[data-asset-focus]');if(asset)focusAsset(asset.dataset.assetFocus);
  },{signal:events.signal});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const name=form.elements.name.value.trim(),state=normalizeProjectAssets(getState());
    if(!name){form.elements.name.focus();return;}
    if([...defaults,...state.types].some(type=>type.name===name)){toast('已有同名资产类型');return;}
    if(state.types.length>=30){toast('自定义类型最多添加 30 个');return;}
    state.types.push({id:`asset-type-${crypto.randomUUID()}`,name});
    try{await save(state);if(disposed)return;form.reset();form.hidden=true;update(true);}catch(error){if(!disposed)toast(error.message);}
  },{signal:events.signal});
  document.addEventListener('pointerdown',event=>{
    if(drawer.hidden||drawer.contains(event.target)||trigger.contains(event.target)||event.target.closest?.('dialog[open]'))return;
    close();
  },{capture:true,signal:events.signal});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!drawer.hidden&&!event.target.closest?.('dialog[open]')){event.preventDefault();close(true);}},{signal:events.signal});
  return {update,destroy(){disposed=true;events.abort();groupEvents.abort();drawer.querySelectorAll('audio').forEach(audio=>{audio.pause();audio.removeAttribute('src');audio.load();});drawer.remove();trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-controls');}};
}
