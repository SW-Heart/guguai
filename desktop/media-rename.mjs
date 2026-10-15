import fs from 'node:fs/promises';
import path from 'node:path';

// Exclusive links avoid replacing another asset with the same requested name.
export async function renameMediaFile({workspace,asset,name,assertCurrent=()=>{}}) {
  const source=path.resolve(workspace,asset.relativePath || '');
  if(!source.startsWith(path.resolve(workspace)+path.sep))throw new Error('本地素材路径不受信任');
  const extension=path.extname(source);
  let filename=String(name||'').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().slice(0,150);
  if(!filename||/^\.+$/.test(filename))throw new Error('文件名不能为空');
  if(extension&&!filename.toLowerCase().endsWith(extension.toLowerCase()))filename+=extension;
  const base=filename.slice(0,filename.length-extension.length);
  for(let index=1;index<=1000;index++){
    assertCurrent();
    const target=path.join(path.dirname(source),index===1?filename:`${base} (${index})${extension}`);
    if(target===source)return {name:filename,relativePath:asset.relativePath};
    try{await fs.link(source,target);}catch(error){if(error.code==='EEXIST')continue;throw error;}
    let removed=false;
    try{assertCurrent();await fs.unlink(source);removed=true;assertCurrent();}catch(error){
      if(removed)await fs.link(target,source);
      await fs.unlink(target).catch(()=>{});throw error;
    }
    return {name:filename,relativePath:path.relative(workspace,target)};
  }
  throw new Error('存在过多同名文件，请换一个名称');
}
