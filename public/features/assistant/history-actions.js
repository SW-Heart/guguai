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
