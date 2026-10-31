import { attachmentCardMarkup } from '../agent/attachment-preview.js?v=5';
import { createStreamPacer } from '../agent/stream-pacer.js?v=1';
import { renderMarkdown, renderStreamingMarkdownBlocks } from '../agent/markdown.js?v=4';
import { patchCodeBlock, copyButtonMarkup } from '../agent/code-block.js?v=2';

// The same buffering policy as the canvas Agent, with final replies held until
// their buffered tail has finished instead of jumping to the complete message.
export function createAssistantStream({render,requestFrame=requestAnimationFrame,cancelFrame=cancelAnimationFrame,immediate=()=>false,now}={}) {
  const pacer=createStreamPacer({now});
  let session='',latest,settling='',frame=0,lastTime=0,disposed=false;
  function publish(frameOnly=false){render({messages:settling?latest.messages.slice(0,-1):latest.messages,draft:pacer.text,working:Boolean(settling)||['running','queued','waiting_job'].includes(latest.state),activity:latest.activity||''},{frameOnly});}
  function finish(){if(settling&&pacer.caughtUp){settling='';pacer.reset();publish();}}
  function tick(time){
    frame=0;if(disposed)return;
    const elapsed=lastTime?time-lastTime:16;lastTime=time;
    if(pacer.advance(elapsed))publish(true);
    if(!pacer.caughtUp)frame=requestFrame(tick);else{lastTime=0;finish();}
  }
  return {
    update(value){
      if(disposed)return;
      const changed=session!==value.id;
      if(changed){if(frame)cancelFrame(frame);frame=0;lastTime=0;pacer.reset();settling='';session=value.id;}
      latest=value;
      const last=value.messages.at(-1),text=last?.text||'';
      if(!value.draft&&!changed&&pacer.target&&last?.role==='assistant'&&(pacer.text?text.startsWith(pacer.text):text.startsWith(pacer.target))&&(settling===last.id||(!settling&&text!==pacer.text)))settling=last.id;
      else if(value.draft||last?.id!==settling)settling='';
      pacer.update(settling?text:value.draft,{done:Boolean(settling)||!['running','queued','waiting_job'].includes(value.state),immediate:changed||immediate()});
      publish();finish();
      if(!pacer.caughtUp&&!frame)frame=requestFrame(tick);
    },
    dispose(){disposed=true;if(frame)cancelFrame(frame);frame=0;pacer.reset();},
  };
}

// Keep completed blocks and code viewports mounted; replace only changing blocks.
export function patchAssistantDraft(content,text){
  if(content._streamSource===text)return;
  content._streamSource=text;
  const blocks=renderStreamingMarkdownBlocks(text);
  blocks.forEach((html,index)=>{
    const current=content.children[index];if(current?._streamHTML===html)return;
    const template=document.createElement('template');template.innerHTML=html;
    const next=template.content.firstElementChild;if(!next)return;
    if(patchCodeBlock(current,next)){current._streamHTML=html;return;}
    next._streamHTML=html;if(current)current.replaceWith(next);else content.append(next);
  });
  while(content.children.length>blocks.length)content.lastElementChild.remove();
}

export const assistantMessageFiles=messages=>messages.flatMap(message=>(message.attachments||[]).map(file=>({...file,key:`${message.id}:${file.id}`,removable:false})));

export function renderAssistantMessages(history,messages,welcome){
  if(!messages.length){if(!history.querySelector('.assistant-welcome'))history.innerHTML=welcome();return;}
  history.querySelector('.assistant-welcome')?.remove();
  const existing=new Map([...history.children].map(node=>[node.dataset.messageId,node]));
  for(const [index,message] of messages.entries()){
    let node=existing.get(message.id);existing.delete(message.id);
    if(!node){node=document.createElement('article');node.dataset.messageId=message.id;}
    const signature=JSON.stringify([message.role,message.text,message.attachments]);
    if(node._signature!==signature){
      node.className=`dw-message ${message.role==='user'?'user':'assistant'}`;
      const content=document.createElement('div');content.className='dw-message-content';
      if(message.role==='user'){content.textContent=message.text;content.style.whiteSpace='pre-wrap';}else content.innerHTML=renderMarkdown(message.text);
      node.replaceChildren(content);
      if(message.attachments?.length){const files=document.createElement('div');files.className='attachment-strip assistant-message-files';files.innerHTML=assistantMessageFiles([message]).map(attachmentCardMarkup).join('');node.append(files);}
      if(message.role==='assistant'){
        const actions=document.createElement('div');actions.className='dw-message-actions';actions.dataset.copyText=message.text;
        actions.innerHTML=copyButtonMarkup('data-response-action="copy"','复制回复');node.append(actions);
      }
      node._signature=signature;
    }
    // Appending only when out of position preserves focus, selection and scroll.
    if(history.children[index]!==node)history.insertBefore(node,history.children[index]||null);
  }
  for(const node of existing.values())node.remove();
}
