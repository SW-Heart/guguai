import {createPromptEditorCodec} from '../../components/prompt-editor.js?v=2';
import {bindGenerationMentionDialog,mentionTrigger} from './director-mentions.js?v=5';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const generationPromptCodec=createPromptEditorCodec({mentionClass:'video-prompt-mention',mentionSelector:'[data-video-prompt-mention-id]',labelAttribute:'videoPromptMentionLabel'});
export const generationSegmentsText=segments=>segments.map(segment=>typeof segment==='string'?segment:`@${segment.label}`).join('');

export function generationMentionMarkup(file,label=file.name||'未命名素材'){
  const url=escape(file.url||file.previewUrl||'');
  const thumb=file.kind==='image'?`<img src="${url}" alt="" decoding="async">`:file.kind==='video'?`<video src="${url}" muted playsinline preload="metadata"></video>`:'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 10v4m4-7v10m4-14v18m4-14v10m4-7v4m4-6v8"/></svg>';
  return `<span class="video-prompt-mention" data-video-prompt-mention-id="${escape(file.id)}" data-video-prompt-mention-label="${escape(label)}" data-video-prompt-mention-kind="${escape(file.kind)}" contenteditable="false" aria-label="引用${escape(label)}"><span class="video-prompt-mention-thumb">${thumb}</span><span class="video-prompt-mention-name">${escape(label)}</span></span>`;
}

export function generationPromptMarkup(draft){
  let segments=draft.promptSegments;
  if(!Array.isArray(segments)||generationSegmentsText(segments)!==draft.prompt){
    segments=[];
    const files=draft.attachments.filter(file=>file.name).sort((a,b)=>b.name.length-a.name.length);
    let text=String(draft.prompt||''),plain='';
    while(text){
      const file=text[0]==='@'?files.find(file=>text.startsWith(`@${file.name}`)):null;
      if(file){if(plain)segments.push(plain);plain='';segments.push({id:file.id,label:file.name});text=text.slice(file.name.length+1);}
      else{plain+=text[0];text=text.slice(1);}
    }
    if(plain)segments.push(plain);
  }
  return segments.map(segment=>{
    if(typeof segment==='string')return escape(segment);
    const file=draft.attachments.find(file=>file.id===segment.id);
    return file?generationMentionMarkup(file,segment.label):escape(`@${segment.label}`);
  }).join('');
}

export function generationPromptSegments(editor){
  const segments=[];
  const visit=(node,root=false)=>{
    if(node.nodeType===3){if(node.nodeValue)segments.push(node.nodeValue.replace(/\u00a0/g,' '));return;}
    if(node.nodeType!==1)return;
    if(node.classList.contains('video-prompt-mention')){segments.push({id:node.dataset.videoPromptMentionId,label:node.dataset.videoPromptMentionLabel});return;}
    if(node.nodeName==='BR'){segments.push('\n');return;}
    [...node.childNodes].forEach(child=>visit(child));
    if(!root&&/^(DIV|P)$/.test(node.nodeName))segments.push('\n');
  };
  visit(editor,true);return segments;
}

export function generationSelection(editor){
  const selection=editor.ownerDocument.defaultView.getSelection();
  if(!selection?.rangeCount||!editor.contains(selection.anchorNode)||!editor.contains(selection.focusNode))return null;
  const range=selection.getRangeAt(0);
  const length=node=>{
    if(node.nodeType===3)return node.nodeValue.length;
    if(node.nodeType!==1)return 0;
    if(node.classList.contains('video-prompt-mention'))return node.dataset.videoPromptMentionLabel.length+1;
    if(node.nodeName==='BR')return 1;
    return [...node.childNodes].reduce((total,child)=>total+length(child),0)+(/^(DIV|P)$/.test(node.nodeName)?1:0);
  };
  const offset=(target,index)=>{
    let position=0,found=false;
    const visit=(node,root=false)=>{
      if(found)return;
      if(node===target){
        position+=node.nodeType===3?index:[...node.childNodes].slice(0,index).reduce((total,child)=>total+length(child),0);
        found=true;return;
      }
      if(node.nodeType===3||node.nodeName==='BR'||node.classList?.contains('video-prompt-mention')){position+=length(node);return;}
      [...node.childNodes].forEach(child=>visit(child));
      if(!found&&!root&&/^(DIV|P)$/.test(node.nodeName))position++;
    };
    visit(editor,true);return position;
  };
  return [offset(range.startContainer,range.startOffset),offset(range.endContainer,range.endOffset)];
}

function textPosition(editor,offset){
  let result;
  const visit=(node,root=false)=>{
    if(result)return;
    const index=()=>[...node.parentNode.childNodes].indexOf(node);
    if(node.nodeType===3){if(offset<=node.nodeValue.length)result=[node,offset];else offset-=node.nodeValue.length;return;}
    if(node.nodeType!==1)return;
    if(node.classList.contains('video-prompt-mention')||node.nodeName==='BR'){
      const length=node.nodeName==='BR'?1:node.dataset.videoPromptMentionLabel.length+1;
      if(offset<=length)result=[node.parentNode,index()+(offset?1:0)];else offset-=length;return;
    }
    [...node.childNodes].forEach(child=>visit(child));
    if(!result&&!root&&/^(DIV|P)$/.test(node.nodeName)){
      if(offset<=1)result=[node.parentNode,index()+1];else offset--;
    }
  };
  visit(editor,true);return result||[editor,editor.childNodes.length];
}

export function restoreGenerationSelection(editor,offsets){
  if(!offsets)return;
  const range=editor.ownerDocument.createRange();range.setStart(...textPosition(editor,offsets[0]));range.setEnd(...textPosition(editor,offsets[1]));
  editor.focus({preventScroll:true});
  const selection=editor.ownerDocument.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range);
}

export function bindGenerationRichPrompt(editor,{pick,getInput,signal}){
  editor.dataset.placeholder='描述视频中的画面、动作与镜头，输入 @ 引用素材…';
  generationPromptCodec.normalizeEmpty(editor);
  // Let the composer save this input event before opening a dialog rebuilds it.
  bindGenerationMentionDialog(editor,{pick:()=>Promise.resolve().then(pick),getInput,signal,read:target=>generationPromptCodec.serialize(target),
    trigger:()=>{const offsets=generationSelection(editor);return offsets?mentionTrigger(generationPromptCodec.serialize(editor),...offsets):null;},
    insert:(target,selected,trigger)=>{
      restoreGenerationSelection(target,[trigger.start,trigger.end]);
      const range=target.ownerDocument.defaultView.getSelection().getRangeAt(0);range.deleteContents();
      const holder=target.ownerDocument.createElement('span');holder.innerHTML=generationMentionMarkup(selected.file,selected.label);
      const chip=holder.firstElementChild,space=target.ownerDocument.createTextNode(' ');
      range.insertNode(chip);chip.after(space);generationPromptCodec.setCaret(target,space,1);
    },
  });
  editor.addEventListener('keydown',event=>{
    if(event.isComposing||!['Backspace','Delete'].includes(event.key))return;
    const mention=generationPromptCodec.mentionAtCaret(editor,event.key==='Backspace'?'backward':'forward');
    if(!mention)return;
    event.preventDefault();const parent=mention.parentNode,index=[...parent.childNodes].indexOf(mention);mention.remove();
    const range=editor.ownerDocument.createRange();range.setStart(parent,index);range.collapse(true);
    const selection=editor.ownerDocument.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range);
    editor.dispatchEvent(new Event('input',{bubbles:true}));
  },{signal});
  editor.addEventListener('paste',event=>{
    const selection=editor.ownerDocument.defaultView.getSelection();if(!selection?.rangeCount||!editor.contains(selection.anchorNode))return;
    event.preventDefault();const range=selection.getRangeAt(0);range.deleteContents();
    const text=editor.ownerDocument.createTextNode(event.clipboardData.getData('text/plain'));range.insertNode(text);
    generationPromptCodec.setCaret(editor,text,text.nodeValue.length);editor.dispatchEvent(new Event('input',{bubbles:true}));
  },{signal});
  editor.addEventListener('compositionstart',()=>{editor.dataset.composing='true';},{signal});
  editor.addEventListener('compositionend',()=>{editor.dataset.composing='false';editor.dispatchEvent(new Event('input',{bubbles:true}));},{signal});
}
