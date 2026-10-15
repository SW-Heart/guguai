// Reapply saved names after downloads finish as well as after agent updates.
export function createAgentAssetMetadataSync({findFile,renameFile,current,onChange,onError}) {
  const pending = new Map(), applied = new Map();
  return function sync(items = []) {
    if(!current())return;
    for(const item of items){
      const file=findFile(item.id);
      if(!file)continue;
      const signature=JSON.stringify([item.name,file.localId||file.id,file.localStatus]);
      if(file.name===item.name){applied.set(item.id,signature);continue;}
      if(applied.get(item.id)===signature||pending.has(item.id))continue;
      const work=(async()=>{
        try{await renameFile(file,item.name);applied.set(item.id,signature);if(current())onChange();}
        catch(error){if(current())onError(error);}
        finally{pending.delete(item.id);}
      })();
      pending.set(item.id,work);
    }
  };
}
