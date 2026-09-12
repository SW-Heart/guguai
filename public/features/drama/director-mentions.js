export function mentionTrigger(value, start, end=start) {
  if(start!==end)return null;
  const match=value.slice(0,start).match(/(?:^|[^\p{ASCII}]|\s)@([^@\n]*)$/u);
  return match?{start:start-match[1].length-1,end:start,query:match[1]}:null;
}

export function bindDirectorMentions(input,{items,attach,signal}) {
  let picker,trigger,composing=false;
  const close=()=>{picker?.remove();picker=null;trigger=null;input.removeAttribute('aria-controls');input.setAttribute('aria-expanded','false');};
  const update=()=>{
    if(composing)return;
    close();
    trigger=mentionTrigger(input.value,input.selectionStart,input.selectionEnd);
    if(!trigger)return;
    picker=document.createElement('div');picker.className='wb-mention-picker';picker.id='directorMentionPicker';
    picker.setAttribute('role','dialog');picker.setAttribute('aria-label','引用素材');
    const header=document.createElement('header');
    const title=document.createElement('b');title.textContent='引用素材 · 输入名称搜索';
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='×';dismiss.setAttribute('aria-label','关闭素材选择器');dismiss.onclick=()=>{close();input.focus();};
    header.append(title,dismiss);picker.append(header);
    const options=document.createElement('div');options.className='wb-mention-options';
    const query=trigger.query.trim().toLocaleLowerCase();
    const matches=items().filter(item=>item.title.toLocaleLowerCase().includes(query));
    for(const item of matches){
      const button=document.createElement('button');button.type='button';button.dataset.mentionOption=item.id;
      const name=document.createElement('b');name.textContent=item.title;button.append(name);
      button.onclick=async()=>{
        const range=trigger,original=input.value;close();
        if(await attach(item.id)){
          if(input.isConnected&&input.value===original){input.setRangeText(`@${item.title} `,range.start,range.end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));close();}
        }
      };
      options.append(button);
    }
    if(!matches.length){const empty=document.createElement('div');empty.className='wb-mention-empty';empty.textContent='没有匹配的素材，请先导入素材或完成生成';options.append(empty);}
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
  input.placeholder='想聊什么，或输入 @ 引用素材';
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
