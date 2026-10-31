const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function slashSkillQuery(text,caret){
  const prefix=String(text).slice(0,caret),match=prefix.match(/(?:^|\s)\/([^\s/]{0,64})$/u);
  return match?{start:prefix.length-match[1].length-1,end:prefix.length,query:match[1]}:null;
}
export function matchingSkills(skills,query=''){
  const term=query.trim().toLocaleLowerCase();
  return skills.filter(skill=>!term||`${skill.title} ${skill.summary||''} ${skill.name}`.toLocaleLowerCase().includes(term));
}
export function renderSkillOptions(skills,index,selected){
  const rows=skills.length?skills.map((skill,i)=>`<button type="button" id="assistant-skill-${i}" role="option" aria-selected="${i===index}" data-skill-option="${escape(skill.name)}" tabindex="-1"><span><strong>${escape(skill.title)}</strong><small>${skill.origin==='local'?'本地 · ':''}${escape(skill.summary||'')}</small></span>${skill.name===selected?'<span aria-label="已选中">✓</span>':''}</button>`).join(''):'<p class="assistant-skill-empty">没有找到相关技能</p>';
  return `<div class="assistant-skill-options" role="presentation">${rows}</div><button type="button" id="assistant-skill-add" class="assistant-skill-add" role="option" aria-selected="${index===skills.length}" data-add-local-skill tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>添加本地 Skill</span></button>`;
}
export function mountAssistantSkillPicker(root,{signal,onChange,onAdd=async()=>false,onOpen=()=>{}}){
  const input=root.querySelector('#assistantMessage'),menu=root.querySelector('[data-skill-menu]'),list=root.querySelector('[data-skill-list]'),chip=root.querySelector('[data-selected-skill]'),remove=root.querySelector('[data-remove-skill]');
  let skills=[],selected='',disabled=true,token=null,matches=[],index=0,opened=false,signature='';
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-haspopup','listbox');input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','false');
  function close(){if(opened)menu.hidePopover();opened=false;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
  function position(){
    const rect=root.querySelector('.assistant-composer').getBoundingClientRect(),gap=8;
    const above=rect.top-gap-12,below=window.innerHeight-rect.bottom-gap-12;
    menu.style.width=`${Math.min(420,rect.width,window.innerWidth-24)}px`;menu.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-parseFloat(menu.style.width)-12))}px`;
    menu.style.maxHeight=`${Math.max(0,Math.min(360,Math.max(above,below)))}px`;
    menu.style.top=above>=below?'auto':`${rect.bottom+gap}px`;menu.style.bottom=above>=below?`${window.innerHeight-rect.top+gap}px`:'auto';
  }
  function draw(){
    const next=JSON.stringify([matches,index,selected]);if(next!==signature){signature=next;list.innerHTML=renderSkillOptions(matches,index,selected);}
    input.setAttribute('aria-activedescendant',index===matches.length?'assistant-skill-add':`assistant-skill-${index}`);
    list.querySelector?.(`#assistant-skill-${index}`)?.scrollIntoView?.({block:'nearest'});
  }
  function refresh(){
    if(disabled||document.activeElement!==input||input.selectionStart!==input.selectionEnd){close();return;}
    const next=slashSkillQuery(input.value,input.selectionStart);
    if(!next){close();return;}
    if(next.query!==token?.query)index=0;
    token=next;matches=matchingSkills(skills,next.query);index=Math.min(index,matches.length);draw();position();
    if(!opened){menu.showPopover();opened=true;onOpen();}input.setAttribute('aria-expanded','true');
  }
  async function addLocal(){
    if(disabled)return;
    const choice=token;close();const result=await onAdd();
    if(signal?.aborted)return;
    if(result&&choice&&input.value.slice(choice.start,choice.end)===`/${choice.query}`){input.value=input.value.slice(0,choice.start)+input.value.slice(choice.end);input.setSelectionRange(choice.start,choice.start);token=null;}
    input.focus({preventScroll:true});input.dispatchEvent(new Event('input',{bubbles:true}));
  }
  async function choose(name){
    if(disabled)return;
    const choice=token;close();
    if(await onChange(name)===false)return;
    if(signal?.aborted)return;
    if(choice&&input.value.slice(choice.start,choice.end)===`/${choice.query}`){input.value=input.value.slice(0,choice.start)+input.value.slice(choice.end);input.setSelectionRange(choice.start,choice.start);}
    token=null;input.focus({preventScroll:true});input.dispatchEvent(new Event('input',{bubbles:true}));
  }
  input.addEventListener('input',event=>{if(!event.isComposing)refresh();},{signal});
  input.addEventListener('compositionend',refresh,{signal});
  input.addEventListener('click',refresh,{signal});
  input.addEventListener('blur',close,{signal});
  input.addEventListener('keyup',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key))refresh();},{signal});
  input.addEventListener('keydown',event=>{
    if(!opened||event.isComposing)return;
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();index=(index+(event.key==='ArrowDown'?1:-1)+matches.length+1)%(matches.length+1);draw();}
    else if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();if(index===matches.length)void addLocal();else if(matches[index])void choose(matches[index].name);}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
  },{signal});
  list.addEventListener('pointerdown',event=>event.preventDefault(),{signal});
  list.addEventListener('click',event=>{if(event.target.closest('[data-add-local-skill]')){void addLocal();return;}const option=event.target.closest('[data-skill-option]');if(option)void choose(option.dataset.skillOption);},{signal});
  remove.addEventListener('click',async()=>{if(!disabled&&await onChange('')!==false)input.focus({preventScroll:true});},{signal});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target)&&event.target!==input)close();},{signal});
  const reposition=()=>{if(opened)position();};
  window.addEventListener('resize',reposition,{signal});
  window.visualViewport?.addEventListener('resize',reposition,{signal});
  signal?.addEventListener('abort',close,{once:true});
  return {update(value){skills=value.skills||[];selected=value.selected||'';disabled=Boolean(value.disabled);chip.hidden=!selected;chip.querySelector('[data-skill-label]').textContent=skills.find(skill=>skill.name===selected)?.title||'所选技能';remove.disabled=disabled;remove.setAttribute('aria-label',`移除${skills.find(skill=>skill.name===selected)?.title||'所选技能'}`);if(disabled)close();else if(opened)refresh();},close};
}
