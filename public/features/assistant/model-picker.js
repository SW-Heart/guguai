import { textModelLogoMarkup, textModelName } from './text-models.js?v=2';
import { assistantIcon } from './presentation.js?v=8';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function matchingAssistantModels(models,query='') {
  const term=query.trim().toLocaleLowerCase();
  return term ? models.filter(model=>`${model.label||''} ${model.id}`.toLocaleLowerCase().includes(term)) : models;
}

export function renderAssistantModels(models,value,query='') {
  const matches=matchingAssistantModels(models,query);
  if(!matches.length)return `<p class="assistant-model-empty">${query.trim()?'没有找到相关模型':'暂无可用模型'}</p>`;
  return matches.map(model=>`<button type="button" class="assistant-model-option" role="option" aria-selected="${model.id===value}" data-model-id="${escape(model.id)}" tabindex="-1"><span class="assistant-text-model-logo">${textModelLogoMarkup(model.id,model.label)}</span><span class="assistant-model-option-copy"><strong>${escape(model.label||model.id)}</strong>${Number.isFinite(model.inputYuanPerMillion)&&Number.isFinite(model.outputYuanPerMillion)?`<small>输入 ¥${model.inputYuanPerMillion} · 输出 ¥${model.outputYuanPerMillion} / 百万 Token</small>`:''}</span><span class="assistant-model-check">${model.id===value?assistantIcon('check'):''}</span></button>`).join('');
}

export function modelMenuPlacement(rect,width,height) {
  const margin=12,gap=8,panelWidth=Math.min(320,width-margin*2);
  const above=rect.top-margin-gap,below=height-rect.bottom-margin-gap;
  return {width:panelWidth,left:Math.max(margin,Math.min(rect.left,width-panelWidth-margin)),above:above>=below,maxHeight:Math.max(0,Math.min(380,Math.max(above,below))),edge:above>=below?height-rect.top+gap:rect.bottom+gap};
}

// beUI Select's trigger/list/checked-row interaction, adapted for the native
// Agent DOM. Popover provides light dismissal and an unclipped top-layer surface.
export function mountAssistantModelPicker(root,{signal,onChange}) {
  const trigger=root.querySelector('[data-model-trigger]'), label=root.querySelector('[data-model-label]');
  const menu=root.querySelector('[data-model-menu]'), list=root.querySelector('[data-model-list]'), search=root.querySelector('[data-model-search]');
  let models=[],value='',disabled=true,signature='',openingFocus=null;
  const options=()=>[...list.querySelectorAll('[role="option"]')];
  function draw(){
    const next=JSON.stringify([models,value,search.value]);
    if(next===signature)return;
    signature=next;list.innerHTML=renderAssistantModels(models,value,search.value);
  }
  function position(){
    const placement=modelMenuPlacement(trigger.getBoundingClientRect(),window.innerWidth,window.innerHeight);
    menu.style.width=`${placement.width}px`;menu.style.left=`${placement.left}px`;
    menu.style.maxHeight=`${placement.maxHeight}px`;
    menu.style.top=placement.above?'auto':`${placement.edge}px`;
    menu.style.bottom=placement.above?`${placement.edge}px`:'auto';
    menu.dataset.placement=placement.above?'top':'bottom';
  }
  function close(restoreFocus=false){menu.hidePopover();if(restoreFocus&&!trigger.disabled)trigger.focus({preventScroll:true});}
  function focusOption(index){const rows=options();rows[index]?.focus({preventScroll:true});rows[index]?.scrollIntoView({block:'nearest'});}
  menu.addEventListener('beforetoggle',event=>{
    if(event.newState==='open'){search.value='';draw();position();}
    trigger.setAttribute('aria-expanded',String(event.newState==='open'));
  },{signal});
  menu.addEventListener('toggle',event=>{
    if(event.newState==='open'){
      if(openingFocus===null)search.focus({preventScroll:true});
      else focusOption(openingFocus==='last'?options().length-1:Math.max(0,options().findIndex(row=>row.getAttribute('aria-selected')==='true')));
    }
    openingFocus=null;
  },{signal});
  trigger.addEventListener('keydown',event=>{
    if(!['ArrowDown','ArrowUp'].includes(event.key)||disabled)return;
    event.preventDefault();openingFocus=event.key==='ArrowUp'?'last':'selected';menu.showPopover();
  },{signal});
  search.addEventListener('input',draw,{signal});
  menu.addEventListener('keydown',event=>{
    const rows=options(),index=rows.indexOf(document.activeElement);
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
    if(event.key==='Tab'){close(true);return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      focusOption(event.key==='ArrowDown'?(index+1)%Math.max(1,rows.length):(index<=0?rows.length-1:index-1));
    }else if(index>=0&&['Home','End'].includes(event.key)){event.preventDefault();focusOption(event.key==='Home'?0:rows.length-1);}
  },{signal});
  list.addEventListener('click',event=>{
    const option=event.target.closest('[data-model-id]');
    if(!option||disabled)return;
    const next=option.dataset.modelId;close(true);
    if(next!==value)onChange(next);
  },{signal});
  const reposition=()=>{if(menu.matches(':popover-open'))position();};
  window.addEventListener('resize',reposition,{signal});
  window.visualViewport?.addEventListener('resize',reposition,{signal});
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(reposition);
  observer?.observe(root.querySelector('.assistant-composer'));
  const dispose=()=>{observer?.disconnect();menu.hidePopover();};
  signal?.addEventListener('abort',dispose,{once:true});
  return {
    update(next){
      models=next.models||[];value=next.value||'';disabled=next.disabled;
      const selected=models.find(model=>model.id===value);
      label.textContent=selected?.label||textModelName(value)||(models.length?'选择模型':'暂无可用模型');
      const logo=root.querySelector('[data-model-logo]'),markup=textModelLogoMarkup(value,selected?.label);if(logo.innerHTML!==markup)logo.innerHTML=markup;
      trigger.title=label.textContent;trigger.setAttribute('aria-label',`切换对话模型：${label.textContent}`);
      trigger.disabled=disabled||!models.length;
      if(trigger.disabled&&menu.matches(':popover-open'))close();
      draw();
    },
  };
}
