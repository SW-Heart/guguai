import {filterAssistantHistory,renderAssistantHistory} from './presentation.js?v=8';

export function createAssistantHistoryRenderer(container){
  let signature='';
  return (items,activeId,query='')=>{
    const visible=filterAssistantHistory(items,query);
    const next=JSON.stringify([activeId,!visible.length&&Boolean(query.trim()),visible.map(item=>[item.id,item.title||'新对话'])]);
    if(signature===next)return;
    signature=next;
    if(!visible.length){container.innerHTML=renderAssistantHistory(items,activeId,query);return;}
    const existing=new Map([...container.children].map(row=>[row.querySelector('[data-session]')?.dataset.session,row]));
    for(const [index,item] of visible.entries()){
      let row=existing.get(item.id);existing.delete(item.id);
      if(!row){
        const template=document.createElement('template');template.innerHTML=renderAssistantHistory([item],activeId);
        row=template.content.firstElementChild;
      }else{
        const title=item.title||'新对话',button=row.querySelector('[data-session]');
        row.classList.toggle('is-current',item.id===activeId);
        if(button.title!==title){button.title=title;button.querySelector('span').textContent=title;row.querySelector('[data-history-more]').setAttribute('aria-label',`${title}的操作`);}
        if(item.id===activeId)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
      }
      if(container.children[index]!==row)container.insertBefore(row,container.children[index]||null);
    }
    for(const row of existing.values())row.remove();
  };
}

export async function renameAssistantConversation({id,title,currentId,client,request}){
  if(id===currentId())await client.settings({title});
  else await request(`/api/agent/sessions/${encodeURIComponent(id)}/settings`,{method:'POST',body:JSON.stringify({title})});
  await client.history();
}
export async function deleteAssistantConversation({id,currentId,client,request}){
  await request(`/api/agent/sessions/${encodeURIComponent(id)}`,{method:'DELETE'});
  if(id===currentId())await client.newConversation();
  await client.history();
}
export function assistantConversationMenuPosition(rect,width,height){
  const menuWidth=168,menuHeight=90,gap=6,margin=8;
  return {left:Math.max(margin,Math.min(width-menuWidth-margin,rect.right-menuWidth)),top:rect.bottom+gap+menuHeight<=height-margin?rect.bottom+gap:Math.max(margin,rect.top-gap-menuHeight)};
}
