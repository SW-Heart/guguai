export function createCancelledNodeCleanup({items,remove,setTimer=setTimeout,clearTimer=clearTimeout}){
  const pending=new Map();let disposed=false;
  const stop=(id,entry)=>{clearTimer(entry.timer);entry.element?.classList.remove('dw-cancelled-removing');pending.delete(id);};
  const current=id=>items().find(item=>item.id===id&&item.cancelled);
  function update(){
    if(disposed)return;
    const cancelled=new Map(items().filter(item=>item.cancelled).map(item=>[item.id,item]));
    for(const [id,entry] of pending)if(!cancelled.has(id))stop(id,entry);
    for(const [id,item] of cancelled){
      if(pending.has(id))continue;
      const entry={element:item.element,timer:null};pending.set(id,entry);
      entry.timer=setTimer(()=>{
        if(disposed)return;
        const item=current(id);if(!item){stop(id,entry);return;}
        entry.element=item.element;entry.element?.classList.add('dw-cancelled-removing');
        entry.timer=setTimer(()=>{
          if(disposed)return;
          const item=current(id);if(!item){stop(id,entry);return;}
          pending.delete(id);remove(id);
        },300);
      },3000);
    }
  }
  return {update,destroy(){disposed=true;for(const [id,entry] of pending)stop(id,entry);}};
}
