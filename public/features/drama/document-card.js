const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const isDocumentCard=node=>['document','source-transcript','source-observation','note','story'].includes(node?.kind);
// Cards whose text the user edits directly on the canvas.
const editable=node=>['document','note','story'].includes(node?.kind);
const kindLabel=node=>node.kind==='document'?'文字作品':node.kind==='source-transcript'?'台词':node.kind==='source-observation'?'原片分析':node.kind==='story'||node.item?.role==='script'?'剧本':'文字';
export function documentCardMarkup(node){
  return `<article class="dw-node-content dw-document-card" data-node-id="${escape(node.id)}" aria-label="${kindLabel(node)}"><span class="dw-frame-caption" data-document-title></span><span data-document-revision class="dw-node-meta"></span><input class="dw-document-title-input" data-document-title-input maxlength="160" aria-label="标题" hidden><textarea class="dw-document-editor" data-document-body readonly aria-label="${editable(node)?'正文':'素材内容'}" spellcheck="false"></textarea><footer class="dw-document-actions"><button type="button" data-document-edit>编辑</button><button type="button" data-document-save hidden>保存</button><button type="button" data-document-cancel hidden>取消</button><button type="button" data-document-copy>复制</button><button type="button" data-document-download>下载</button><button type="button" data-document-ask>继续修改</button></footer><p class="dw-document-feedback" data-document-feedback role="status" aria-live="polite"></p></article>`;
}
export function documentCardText(node){
  return node.kind==='source-transcript'&&node.item.cues?.length?node.item.cues.map(cue=>`${Math.round(cue.startSeconds*100)/100}–${Math.round(cue.endSeconds*100)/100} 秒  ${cue.text}`).join('\n'):String(node.text??'');
}
export function documentDownload(node,text){
  if(node.kind!=='source-transcript')return {text,extension:'md'};
  const stamp=seconds=>{const ms=Math.max(0,Math.round(seconds*1000));return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
  return {extension:'srt',text:(node.item.cues||[]).map((cue,index)=>`${index+1}\n${stamp(cue.startSeconds)} --> ${stamp(cue.endSeconds)}\n${cue.text}`).join('\n\n')};
}
export function mountDocumentCard(card,{save,ask,copy,download}){
  const body=card.querySelector('[data-document-body]'),title=card.querySelector('[data-document-title]'),titleInput=card.querySelector('[data-document-title-input]'),revision=card.querySelector('[data-document-revision]'),feedback=card.querySelector('[data-document-feedback]');
  const button=name=>card.querySelector(`[data-document-${name}]`);
  let node,editing=false,saving=false,locked=false,baseRevision;
  const controls=()=>{
    body.readOnly=!editing||saving;
    button('edit').hidden=editing||!editable(node);button('edit').disabled=locked;
    // Text cards written on the canvas can be renamed while editing.
    const renaming=editing&&node.kind==='note';
    titleInput.hidden=!renaming;title.hidden=renaming;titleInput.disabled=saving;
    button('save').hidden=!editing;button('cancel').hidden=!editing;
    button('save').disabled=saving||locked;button('cancel').disabled=saving;
    button('ask').hidden=editing;button('ask').textContent=node.kind==='source-transcript'?'继续创作':'继续修改';
    button('download').disabled=node.kind==='source-transcript'&&!node.item.cues?.length;
    card.classList.toggle('is-editing',editing);
  };
  const showText=()=>{
    const text=documentCardText(node);
    if(body.value!==text){const {scrollTop,scrollLeft}=body;body.value=text;body.scrollTop=scrollTop;body.scrollLeft=scrollLeft;}
  };
  // Only the body and buttons consume gestures; the title remains a drag handle.
  for(const target of [body,titleInput,...card.querySelectorAll('button')]){
    for(const type of ['pointerdown','pointerup','mousedown','mouseup','touchstart','touchend','click','dblclick','wheel','keydown','keyup'])target.addEventListener(type,event=>event.stopPropagation(),{passive:true});
  }
  button('edit').onclick=()=>{if(locked)return;editing=true;baseRevision=node.item.revision;titleInput.value=node.title;feedback.textContent='';controls();body.focus({preventScroll:true});};
  button('cancel').onclick=()=>{if(saving)return;editing=false;feedback.textContent='';showText();controls();};
  button('save').onclick=async()=>{
    if(saving||locked)return;
    saving=true;feedback.textContent='正在保存…';controls();
    try{
      const document=await save(node,{text:body.value,expectedRevision:baseRevision,...(node.kind==='note'?{title:titleInput.value.trim()||node.title}:{})});
      node={...node,title:document.title,text:document.text,item:{...node.item,...document}};
      editing=false;title.textContent=node.title;revision.textContent=document.revision?`第 ${document.revision} 版`:'';feedback.textContent='已保存';showText();
    }catch(error){feedback.textContent=error.message||'保存失败，请重试';}
    finally{saving=false;controls();}
  };
  button('copy').onclick=async()=>{try{await copy(body.value);feedback.textContent='已复制';}catch{feedback.textContent='复制失败，请重试';}};
  button('download').onclick=()=>download(node,body.value);
  button('ask').onclick=()=>ask(node);
  // Open a new, empty card straight in edit mode.
  const edit=()=>{if(!editing&&!locked)button('edit').onclick();};
  return {edit,update(next,isLocked=false){
    // A poll started before saving can still carry the preceding revision.
    if(node&&next.kind==='document'&&next.item.revision<node.item.revision)return;
    node=next;locked=isLocked;title.textContent=node.title;
    revision.textContent=node.item.revision?`第 ${node.item.revision} 版`:'';
    if(!editing)showText();controls();
  }};
}
