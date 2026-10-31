import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { parseLocalSkill,localSkillResourceAllowed,validateLocalSkillSnapshot } from '../lib/agent/local-skills.mjs';
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const key=directory=>'local-'+createHash('sha256').update(directory).digest('hex').slice(0,32);
export function createLocalSkillRegistry({file,onChange=()=>{},pollIntervalMs=2500}){
  let roots=null,watchers=[],timer,loading,poller,fingerprint='',closed=false,polling=false;
  const metadataCache=new Map();
  const signature=result=>JSON.stringify([result.items.map(item=>[item.name,item.revision]),result.errors]);
  async function poll(){if(closed||polling)return;polling=true;try{const result=await discover(),next=signature(result);if(!closed&&fingerprint&&next!==fingerprint)changed();fingerprint=next;}catch{}finally{polling=false;}}
  const changed=()=>{clearTimeout(timer);timer=setTimeout(onChange,150);timer.unref?.();};
  function watchRoots(){watchers.forEach(w=>w.close());watchers=[];clearInterval(poller);if(closed)return;poller=setInterval(poll,Math.max(100,pollIntervalMs));poller.unref?.();for(const root of roots){try{watchers.push(watch(root,{recursive:true},changed));watchers.at(-1).on('error',()=>{});}catch{}}}
  async function load(){if(roots)return;loading??=(async()=>{try{const data=JSON.parse(await fs.readFile(file,'utf8'));roots=Array.isArray(data.roots)?data.roots.filter(root=>typeof root==='string'&&path.isAbsolute(root)).slice(0,20):[];}catch{roots=[];}watchRoots();})();await loading;}
  async function boundedText(target,limit=250000){const handle=await fs.open(target,'r');try{const stat=await handle.stat();if(!stat.isFile()||stat.size>limit)throw new Error('技能文件过大，请精简后再添加');return await handle.readFile('utf8');}finally{await handle.close();}}
  async function candidates(root){
    const canonical=await fs.realpath(root);
    if(await fs.stat(path.join(canonical,'SKILL.md')).then(stat=>stat.isFile(),()=>false))return [canonical];
    const entries=await fs.readdir(canonical,{withFileTypes:true});
    const dirs=[];
    for(const entry of entries.slice(0,500)){
      if(entry.name.startsWith('.')||!entry.isDirectory()&&!entry.isSymbolicLink())continue;
      const resolved=await fs.realpath(path.join(canonical,entry.name)).catch(()=>null);
      if(resolved&&inside(canonical,resolved))dirs.push(resolved);
    }
    return dirs;
  }
  async function discover(){
    await load();const items=new Map(),errors=[];
    for(const root of roots){
      let directories;try{directories=await candidates(root);}catch{errors.push('有技能文件夹已不可用，请重新添加');continue;}
      for(const directory of directories){
        if(items.size>=100)break;
        try{
          const source=await fs.realpath(path.join(directory,'SKILL.md'));
          if(!inside(directory,source))throw new Error('技能说明必须位于所选文件夹内');
          const stat=await fs.stat(source),stamp=`${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
          let cached=metadataCache.get(source);
          if(cached?.stamp!==stamp){const text=await boundedText(source,160000);cached={stamp,metadata:{...parseLocalSkill(text),revision:createHash('sha256').update(text).digest('hex')}};if(metadataCache.size>500)metadataCache.clear();metadataCache.set(source,cached);}
          const metadata=cached.metadata;
          if(metadata.sourceName!==path.basename(directory))throw new Error('技能名称需要与文件夹名称一致');
          const name=key(directory);items.set(name,{name,...metadata,origin:'local',directory});
        }catch(error){if(await fs.stat(path.join(directory,'SKILL.md')).then(()=>true,()=>false))errors.push(`${path.basename(directory)}：${error.message.startsWith('技能')?error.message:'无法读取，请检查文件'}`);}
      }
    }
    return {items:[...items.values()],errors};
  }
  const publicList=result=>({items:result.items.map(({directory,...item})=>item),errors:result.errors});
  async function list(){const result=await discover();fingerprint=signature(result);return publicList(result);}
  async function add(directory){
    await load();const resolved=await fs.realpath(directory);
    const previous=roots;roots=[...new Set([...roots,resolved])];
    if(roots.length>20){roots=previous;throw new Error('最多添加 20 个技能文件夹');}
    const found=await discover();
    const added=found.items.filter(item=>inside(resolved,item.directory));
    if(!added.length){roots=previous;throw new Error(found.errors[0]||'没有找到有效技能，请选择包含 SKILL.md 的技能文件夹或其上级文件夹');}
    try{await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify({version:1,roots}),{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
    catch{roots=previous;throw new Error('未能保存技能文件夹，请稍后重试');}
    fingerprint=signature(found);watchRoots();changed();return {...publicList(found),added:added.map(({directory,...item})=>item)};
  }
  async function snapshot(name){
    const {items}=await discover(),skill=items.find(item=>item.name===name);
    if(!skill)throw new Error('本地技能已不可用，请重新添加');
    const files=Object.create(null);let visited=0;
    const source=await fs.realpath(path.join(skill.directory,'SKILL.md'));if(!inside(skill.directory,source))throw new Error('技能说明必须位于技能文件夹内');
    files['SKILL.md']=await boundedText(source,160000);
    async function readTree(directory,prefix=''){
      for(const entry of await fs.readdir(directory,{withFileTypes:true})){
        if(++visited>1000)throw new Error('技能资料过多，请精简后再添加');
        if(entry.name.startsWith('.')||entry.name==='scripts')continue;
        const resource=prefix+entry.name,target=path.join(directory,entry.name);
        if(entry.isSymbolicLink())continue;
        if(entry.isDirectory()){if(resource.split('/').length<5)await readTree(target,resource+'/');continue;}
        if(!localSkillResourceAllowed(resource))continue;
        const resolved=await fs.realpath(target);if(!inside(skill.directory,resolved))throw new Error('技能资料必须位于技能文件夹内');
        files[resource]=await boundedText(resolved);
        if(Object.keys(files).length>64||Object.values(files).reduce((sum,text)=>sum+text.length,0)>400000)throw new Error('技能资料过多，请精简后再添加');
      }
    }
    await readTree(skill.directory);
    return validateLocalSkillSnapshot({name,files});
  }
  return {list,add,snapshot,close(){closed=true;clearInterval(poller);clearTimeout(timer);watchers.forEach(w=>w.close());watchers=[];}};
}
