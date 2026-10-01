// Adapted from beui.dev/components/agents/code-block for the native DOM renderer.
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copyIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const checkIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>';
const fileIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v6h6"/><path d="m5 12-3 3 3 3m4-6 3 3-3 3"/></svg>';

export function copyButtonMarkup(attribute,label='复制内容') {
  return `<button type="button" class="agent-content-copy" ${attribute} aria-label="${escape(label)}" title="${escape(label)}">${copyIcon}<span data-copy-label>复制</span></button>`;
}

export function renderCodeBlock(code,info='',streaming=false) {
  const metadata=String(info).trim();
  const filename=metadata.match(/(?:filename|title)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const parts=metadata.replace(/(?:filename|title)=(?:"[^"]*"|'[^']*'|[^\s]+)/gi,'').trim().split(/\s+/);
  const language=parts[0]||'';
  const name=filename?(filename[1]??filename[2]??filename[3]):parts.slice(1).join(' ');
  const numbers=String(code).split('\n').map((_,index)=>index+1).join('\n');
  return `<div class="agent-code-block" data-state="${streaming?'streaming':'complete'}" aria-busy="${streaming}"><div class="agent-code-header"><span class="agent-code-icon">${fileIcon}</span><span class="agent-code-name">${escape(name||language||'代码')}</span>${name&&language?`<span class="agent-code-language">${escape(language)}</span>`:''}<span class="agent-code-status">${streaming?'正在生成':'已完成'}</span>${copyButtonMarkup('data-code-copy','复制代码')}</div><pre class="agent-code-viewport"><span class="agent-code-lines" aria-hidden="true">${numbers}</span><code>${escape(code)}</code></pre></div>`;
}

// Keep the header, copy feedback and reader's scroll position mounted while
// new tokens arrive. Copy always reads the current code, without line numbers.
export function patchCodeBlock(current,next) {
  if(!current?.classList.contains('agent-code-block')||!next?.classList.contains('agent-code-block'))return false;
  const viewport=current.querySelector('.agent-code-viewport');
  const follow=viewport.scrollHeight-viewport.scrollTop-viewport.clientHeight<24;
  for(const selector of ['code','.agent-code-lines','.agent-code-name','.agent-code-status'])current.querySelector(selector).textContent=next.querySelector(selector).textContent;
  const language=current.querySelector('.agent-code-language'),nextLanguage=next.querySelector('.agent-code-language');
  if(language&&nextLanguage)language.textContent=nextLanguage.textContent;
  else if(language)language.remove();
  else if(nextLanguage)current.querySelector('.agent-code-name').after(nextLanguage);
  current.dataset.state=next.dataset.state;
  current.setAttribute('aria-busy',next.getAttribute('aria-busy'));
  if(follow&&next.dataset.state==='streaming')viewport.scrollTop=viewport.scrollHeight;
  return true;
}

async function writeClipboard(text) {
  if(globalThis.navigator?.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}
  const active=document.activeElement,selection=document.getSelection?.();
  const ranges=selection?Array.from({length:selection.rangeCount},(_,index)=>selection.getRangeAt(index).cloneRange()):[];
  const input=document.createElement('textarea');
  input.value=text;input.setAttribute('readonly','');
  input.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(input);
  try{input.select();if(!document.execCommand?.('copy'))throw new Error('复制失败');}
  finally{input.remove();active?.focus?.({preventScroll:true});if(selection){selection.removeAllRanges();ranges.forEach(range=>selection.addRange(range));}}
}

export function mountContentCopy(root,{signal,onError=()=>{}}={}) {
  const states=new Map();
  let disposed=false;
  const restore=(button,state)=>{
    clearTimeout(state.timer);
    if(button.isConnected){button.innerHTML=state.html;button.setAttribute('aria-label',state.label);button.title=state.title;button.classList.remove('is-copied');}
    states.delete(button);
  };
  const onClick=async event=>{
    const button=event.target.closest?.('[data-code-copy],[data-doc-copy],[data-response-action="copy"]');
    if(!button||!root.contains(button)||disposed)return;
    event.preventDefault();
    let state=states.get(button);
    if(state?.pending)return;
    if(!state){state={html:button.innerHTML,label:button.getAttribute('aria-label'),title:button.title};states.set(button,state);}
    clearTimeout(state.timer);state.pending=true;
    const text=button.hasAttribute('data-code-copy')?button.closest('.agent-code-block')?.querySelector('code')?.textContent:button.hasAttribute('data-doc-copy')?button.closest('.dw-inspector')?.querySelector('.dw-document-content')?.value:button.closest('.dw-message-actions')?.dataset.copyText;
    try{
      if(typeof text!=='string')throw new Error('复制内容不存在');
      await writeClipboard(text);
      if(disposed||!button.isConnected){states.delete(button);return;}
      button.innerHTML=checkIcon+(state.html.includes('data-copy-label')?'<span data-copy-label>已复制</span>':'');
      button.setAttribute('aria-label','已复制');button.title='已复制';button.classList.add('is-copied');
      state.timer=setTimeout(()=>restore(button,state),1600);
    }catch{
      restore(button,state);
      if(!disposed&&button.isConnected)onError('复制失败，请重试');
    }finally{state.pending=false;}
  };
  const destroy=()=>{disposed=true;root.removeEventListener('click',onClick);states.forEach((state,button)=>restore(button,state));signal?.removeEventListener('abort',destroy);};
  if(signal?.aborted){disposed=true;return {destroy};}
  root.addEventListener('click',onClick);
  signal?.addEventListener('abort',destroy,{once:true});
  return {destroy};
}
