import { createHash } from 'node:crypto';
import { load, JSON_SCHEMA } from 'js-yaml';
export const isLocalSkill = name => /^local-[a-f0-9]{32}$/.test(String(name));
export function parseLocalSkill(source){
  if(typeof source!=='string'||source.length>40000)throw new Error('技能说明过长，请缩短后再添加');
  const match=source.replace(/^\uFEFF/,'').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  if(!match)throw new Error('技能缺少名称和简介，请检查 SKILL.md');
  let data;try{data=load(match[1],{schema:JSON_SCHEMA});}catch{throw new Error('技能的名称或简介格式不正确，请检查 SKILL.md');}
  if(!data||typeof data.name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)||data.name.length>64||typeof data.description!=='string'||!data.description.trim()||data.description.length>1024)throw new Error('技能需要有效的名称和简介，请检查 SKILL.md');
  const heading=source.slice(match[0].length).match(/^#\s+(.+)$/m)?.[1];
  const title=typeof data.metadata?.display_name==='string'?data.metadata.display_name:heading||data.name;
  return {sourceName:data.name,title:title.replace(/[\r\n\u0000-\u001f]/g,' ').slice(0,120),description:data.description.trim(),summary:data.description.replace(/\s+/g,' ').trim().slice(0,120)};
}
export function localSkillResourceAllowed(resource){
  return resource==='SKILL.md'||typeof resource==='string'&&resource.length<=240&&!resource.includes('\\')&&!resource.split('/').some(part=>!part||part==='..'||part.startsWith('.')||part==='scripts')&&/\.(md|txt|csv|json|yaml|yml)$/i.test(resource);
}
export function validateLocalSkillSnapshot(value){
  if(!value||!isLocalSkill(value.name)||!value.files||typeof value.files!=='object'||Array.isArray(value.files))throw new Error('本地技能内容无效，请重新添加');
  const entries=Object.entries(value.files).sort(([a],[b])=>a.localeCompare(b));
  if(!entries.length||entries.length>64)throw new Error('技能资料过多，请精简后再添加');
  let length=0;const files=Object.create(null);
  for(const [resource,text] of entries){
    if(!localSkillResourceAllowed(resource)||typeof text!=='string'||text.length>60000||(length+=text.length)>400000)throw new Error('技能资料无效或过长，请精简后再添加');
    files[resource]=text;
  }
  const metadata=parseLocalSkill(files['SKILL.md']);
  return {name:value.name,...metadata,files,revision:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
export function publicLocalSkill(snapshot){
  if(!snapshot)return null;
  const {files,...metadata}=snapshot;return {...metadata,origin:'local'};
}
export function readLocalSkillResource(snapshot,resource='SKILL.md',offset=0){
  if(!localSkillResourceAllowed(resource)||!Object.hasOwn(snapshot.files,resource))throw new Error('没有找到这份技能资料，或暂不支持读取这种文件');
  const text=snapshot.files[resource];
  if(!Number.isSafeInteger(offset)||offset<0||offset>text.length)throw new Error('读取位置无效');
  const end=Math.min(text.length,offset+4000);
  return {name:snapshot.name,resource,text:text.slice(offset,end),offset,nextOffset:end<text.length?end:null,totalCharacters:text.length};
}
