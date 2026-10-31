import { isLocalSkill, publicLocalSkill } from './local-skills.mjs';
// Reuse creative guidance without granting workspace or media operations.
const textSkills = new Set([
  'script-writing', 'short-drama', 'prompt-optimization', 'character-design',
  'fight-choreography', 'video-production', 'image-design', 'creative-review',
  'seedance-creation-bible', 'minimax-creation-bible',
]);
export const assistantTools = new Set(['web_search', 'skills_search', 'skills_read']);
export const assistantSkillAllowed = (name,localSkill) => textSkills.has(name)||isLocalSkill(name)&&localSkill?.name===name;
export const assistantSkillCatalog = (items,localSkill) => [...items.filter(item => assistantSkillAllowed(item.name)),...(localSkill?[publicLocalSkill(localSkill)]:[])];

export async function readAssistantRequiredSkill(skills,name,localSkill){
  if(isLocalSkill(name)&&localSkill?.name===name)return {name,instructions:localSkill.files['SKILL.md']};
  if(!assistantSkillAllowed(name))throw new Error('所选技能暂时不可用，请重新选择');
  let offset=0,text='';
  do{
    const page=await skills.read(name,'SKILL.md',offset);
    if(typeof page.text!=='string'||!page.text.trim())throw new Error('暂时无法读取所选技能，请稍后重试');
    text+=page.text;
    if(text.length>60000)throw new Error('所选技能内容过长，请更换技能');
    if(page.nextOffset==null)return {name,instructions:text};
    if(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset)throw new Error('暂时无法读取所选技能，请稍后重试');
    offset=page.nextOffset;
  }while(true);
}
