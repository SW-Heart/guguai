export function bindMediaNameInput(input,{save,done,error}){
  const events=new AbortController();let saving=false,closed=false;
  const finish=()=>{closed=true;events.abort();done();};
  async function commit(){
    if(closed||saving||input.isComposing)return;
    const name=input.value.replace(/[\r\n\u0000-\u001f]/g,'').trim().slice(0,160);
    if(!name){error('文件名不能为空');input.focus();return;}
    saving=true;input.readOnly=true;
    try{await save(name);if(!closed)finish();}
    catch(reason){if(!closed){error(reason.message||'文件名保存失败，请重试');input.readOnly=false;input.focus();}}
    finally{saving=false;}
  }
  input.addEventListener('compositionstart',()=>{input.isComposing=true;},{signal:events.signal});
  input.addEventListener('compositionend',()=>{input.isComposing=false;if(input.ownerDocument&&input.ownerDocument.activeElement!==input)void commit();},{signal:events.signal});
  input.ownerDocument?.addEventListener('pointerdown',event=>{if(event.target!==input)void commit();},{capture:true,signal:events.signal});
  input.addEventListener('blur',()=>void commit(),{signal:events.signal});
  input.addEventListener('keydown',event=>{
    event.stopPropagation();if(event.isComposing||input.isComposing)return;
    if(event.key==='Enter'){event.preventDefault();void commit();}
    if(event.key==='Escape'&&!saving){event.preventDefault();finish();}
  },{signal:events.signal});
  input.focus({preventScroll:true});input.select();
  return {commit,destroy(){closed=true;events.abort();}};
}
export function mountMediaNameEditor(container,{entries,save,error}){
  const layer=document.createElement('div');layer.className='dw-media-names';container.append(layer);
  const labels=new Map();let edit=null,disposed=false;
  function position(element,entry){Object.assign(element.style,{left:`${entry.rect.x}px`,top:`${entry.rect.y-28}px`,width:`${Math.max(entry.rect.width,edit?.input===element?140:0)}px`});}
  function update(){
    if(disposed)return;
    const current=entries(),ids=new Set();
    for(const entry of current){
      if(!entry.native)continue;ids.add(entry.id);
      let label=labels.get(entry.id);if(!label){label=document.createElement('span');label.className='dw-media-name';layer.append(label);labels.set(entry.id,label);}
      label.textContent=entry.name;label.hidden=edit?.id===entry.id;position(label,entry);
    }
    for(const [id,label] of labels)if(!ids.has(id)){label.remove();labels.delete(id);}
    if(edit){const entry=current.find(item=>item.id===edit.id);if(entry)position(edit.input,entry);else{edit.controller.destroy();edit.input.remove();edit=null;}}
  }
  function begin(id){
    const entry=entries().find(item=>item.id===id);if(!entry)return;
    if(edit){if(edit.id===id){edit.input.focus();edit.input.select();}else void edit.controller.commit();return;}
    const input=document.createElement('input');input.className='dw-media-name-input';input.maxLength=160;input.value=entry.name;input.setAttribute('aria-label','文件名称');
    ['pointerdown','mousedown','click','dblclick'].forEach(type=>input.addEventListener(type,event=>event.stopPropagation()));
    layer.append(input);edit={id,input,controller:null};position(input,entry);
    edit.controller=bindMediaNameInput(input,{save:name=>name===entry.name?Promise.resolve():save(id,name),error,done(){input.remove();edit=null;update();}});
    update();
  }
  return {begin,update,destroy(){disposed=true;edit?.controller.destroy();edit=null;layer.remove();labels.clear();}};
}
