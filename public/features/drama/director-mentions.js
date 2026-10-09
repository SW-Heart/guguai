export function mentionTrigger(value, start, end=start) {
  if(start!==end)return null;
  const match=value.slice(0,start).match(/(?:^|[^\p{ASCII}]|\s)@([^@\n]*)$/u);
  return match?{start:start-match[1].length-1,end:start,query:match[1]}:null;
}

export function bindGenerationMentionDialog(input,{pick,getInput=()=>input,signal,read=target=>target.value,trigger=()=>mentionTrigger(input.value,input.selectionStart,input.selectionEnd),insert=(target,selected,range)=>target.setRangeText(`@${selected.label} `,range.start,range.end,'end')}) {
  let composing=false,pending=false;
  const update=async event=>{
    if(signal.aborted||composing||event.isComposing||pending)return;
    const range=trigger();
    if(!range||range.query)return;
    const original=read(input);
    pending=true;
    try{
      const selected=await pick();
      const target=getInput();
      if(!target?.isConnected||read(target)!==original)return;
      if(selected){
        insert(target,selected,range);
        target.dispatchEvent(new Event('input',{bubbles:true}));
      }
      target.focus({preventScroll:true});
    }finally{pending=false;}
  };
  input.placeholder='描述视频中的画面、动作与镜头，输入 @ 引用素材…';
  input.addEventListener('input',update,{signal});
  input.addEventListener('compositionstart',()=>{composing=true;},{signal});
  input.addEventListener('compositionend',event=>{composing=false;void update(event);},{signal});
}

export function bindDirectorMentions(input,{items,attach,signal,placeholder='想聊什么，或输入 @ 引用素材',pickerId='directorMentionPicker',getInput=()=>input}) {
  let picker,trigger,composing=false,revision=0;
  const close=()=>{revision++;picker?.remove();picker=null;trigger=null;input.removeAttribute('aria-controls');input.setAttribute('aria-expanded','false');};
  const update=async event=>{
    if(signal.aborted||composing)return;
    close();
    if(event?.directorMentionInserted)return;
    trigger=mentionTrigger(input.value,input.selectionStart,input.selectionEnd);
    if(!trigger)return;
    const pendingTrigger=trigger,version=revision;
    let available,error='';
    try{const result=items();available=typeof result?.then==='function'?await result:result;}
    catch{available=[];error='素材暂时无法加载，请重新输入 @ 重试';}
    if(signal.aborted||version!==revision||!input.isConnected)return;
    trigger=pendingTrigger;
    picker=document.createElement('div');picker.className='wb-mention-picker';picker.id=pickerId;
    picker.setAttribute('role','dialog');picker.setAttribute('aria-label','引用素材');
    const header=document.createElement('header');
    const title=document.createElement('b');title.textContent='引用素材 · 输入名称搜索';
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='×';dismiss.setAttribute('aria-label','关闭素材选择器');dismiss.onclick=()=>{close();input.focus();};
    header.append(title,dismiss);picker.append(header);
    const options=document.createElement('div');options.className='wb-mention-options';
    const query=trigger.query.trim().toLocaleLowerCase();
    const matches=(available||[]).filter(item=>item.title.toLocaleLowerCase().includes(query));
    for(const item of matches){
      const button=document.createElement('button');button.type='button';button.dataset.mentionOption=item.id;
      const name=document.createElement('b');name.textContent=item.title;button.append(name);
      button.onclick=async()=>{
        const range=trigger,original=input.value;close();
        const attached=await attach(item.id);
        if(attached){
          const target=getInput();
          if(target?.isConnected&&target.value===original){
            target.setRangeText(`@${attached.label||item.title} `,range.start,range.end,'end');
            const event=new Event('input',{bubbles:true});event.directorMentionInserted=true;
            target.dispatchEvent(event);close();target.focus({preventScroll:true});
          }
        }
      };
      options.append(button);
    }
    if(!matches.length){const empty=document.createElement('div');empty.className='wb-mention-empty';empty.textContent=error||'文件库中没有匹配的素材，请先上传文件或换个名称搜索';options.append(empty);}
    picker.append(options);document.body.append(picker);
    input.setAttribute('aria-controls',picker.id);input.setAttribute('aria-expanded','true');
    const rect=input.getBoundingClientRect();
    picker.style.maxHeight=`${Math.max(100,Math.min(360,rect.top-16))}px`;
    picker.style.left=`${Math.max(8,Math.min(rect.left,window.innerWidth-picker.offsetWidth-8))}px`;
    picker.style.top=`${Math.max(8,rect.top-picker.offsetHeight-8)}px`;
    picker.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();input.focus();}
      if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const buttons=[...options.querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
    });
  };
  input.placeholder=placeholder;
  input.addEventListener('input',update,{signal});
  input.addEventListener('click',update,{signal});
  input.addEventListener('compositionstart',()=>{composing=true;close();},{signal});
  input.addEventListener('compositionend',()=>{composing=false;update();},{signal});
  input.addEventListener('keydown',event=>{
    if(!picker||event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}
    if(event.key==='ArrowDown'||(event.key==='Enter'&&!event.shiftKey)){event.preventDefault();event.stopImmediatePropagation();const first=picker.querySelector('[data-mention-option]');if(event.key==='Enter')first?.click();else first?.focus();}
  },{signal,capture:true});
  document.addEventListener('pointerdown',event=>{if(event.target!==input&&!picker?.contains(event.target))close();},{signal});
  window.addEventListener('resize',close,{signal});
  signal.addEventListener('abort',close,{once:true});
  return close;
}
