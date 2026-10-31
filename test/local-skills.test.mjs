import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalSkillRegistry} from '../desktop/local-skills.mjs';
import {parseLocalSkill,validateLocalSkillSnapshot,readLocalSkillResource,publicLocalSkill} from '../lib/agent/local-skills.mjs';
import {readAssistantRequiredSkill,assistantSkillAllowed} from '../lib/agent/assistant-skills.mjs';
const source=(name='my-writing',body='保留用户的人物设定。')=>`---\nname: ${name}\ndescription: >\n  改写剧本，\n  完成人物对白。\nmetadata:\n  display_name: 我的剧本技能\n---\n# 剧本创作\n${body}\n`;
const id='local-'+ 'a'.repeat(32);

test('standard YAML metadata and multiline descriptions load without executable YAML types',()=>{
 const result=parseLocalSkill(source());assert.equal(result.title,'我的剧本技能');assert.equal(result.sourceName,'my-writing');assert.match(result.description,/改写剧本， 完成人物对白/);
 for(const text of ['no metadata',source('Invalid'),source().replace('name: my-writing','name: !!js/function "function(){}"')])assert.throws(()=>parseLocalSkill(text),/技能/);
 const snapshot=validateLocalSkillSnapshot({name:id,files:{'SKILL.md':source(),'references/对白.md':'对白应可表演。'}});
 assert.equal(assistantSkillAllowed(id),false);assert.equal(assistantSkillAllowed(id,snapshot),true);assert.equal(assistantSkillAllowed('local-'+ 'b'.repeat(32),snapshot),false);
 assert.ok(!('files' in publicLocalSkill(snapshot)));
 assert.equal(readLocalSkillResource(snapshot,'references/对白.md').text,'对白应可表演。');
 assert.throws(()=>readLocalSkillResource(snapshot,'../secret.txt'),/没有找到/);
 for(const resource of ['scripts/run.py','../outside.md','.env','references/../../secret.md','references\\secret.md'])assert.throws(()=>validateLocalSkillSnapshot({name:id,files:{'SKILL.md':source(),[resource]:'bad'}}),/资料/);
});

test('native directory registry discovers, persists, refreshes and snapshots only approved skill resources',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'gugu-local-skills-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'skills'),skill=path.join(root,'my-writing'),config=path.join(temp,'profile','roots.json');
 await mkdir(path.join(skill,'references'),{recursive:true});await mkdir(path.join(skill,'scripts'));
 await writeFile(path.join(skill,'SKILL.md'),source());await writeFile(path.join(skill,'references','对白.md'),'说话要符合人物身份');await writeFile(path.join(skill,'scripts','run.py'),'raise Exception("must never run")');await writeFile(path.join(skill,'.env'),'SECRET');
 const outside=path.join(temp,'secret.txt');await writeFile(outside,'PRIVATE CONTENT');await symlink(outside,path.join(skill,'references','secret.txt'));
 const registry=createLocalSkillRegistry({file:config});t.after(()=>registry.close());
 assert.deepEqual((await registry.list()).items,[]);
 const added=await registry.add(root);assert.equal(added.added.length,1);assert.equal(added.items[0].title,'我的剧本技能');assert.ok(!('directory' in added.items[0]));
 const name=added.items[0].name,first=await registry.snapshot(name);assert.match(first.files['SKILL.md'],/保留用户/);assert.equal(first.files['references/对白.md'],'说话要符合人物身份');assert.ok(!JSON.stringify(first).includes('PRIVATE CONTENT'));assert.ok(!Object.keys(first.files).some(file=>file.startsWith('scripts/')||file==='.env'));
 assert.equal((await readAssistantRequiredSkill({},name,first)).instructions,first.files['SKILL.md']);
 await writeFile(path.join(skill,'SKILL.md'),source('my-writing','新增对白修改要求。'));
 const next=await registry.snapshot(name);assert.notEqual(next.revision,first.revision);
 const reloaded=createLocalSkillRegistry({file:config});t.after(()=>reloaded.close());assert.equal((await reloaded.list()).items[0].name,name);
 assert.deepEqual(JSON.parse(await readFile(config,'utf8')).roots,[await realpath(root)]);
 await rm(path.join(skill,'SKILL.md'));await assert.rejects(registry.snapshot(name),/本地技能已不可用/);
});

test('invalid directories do not become authorized and skill identity includes the source folder',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'gugu-skill-scope-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const registry=createLocalSkillRegistry({file:path.join(temp,'settings.json')});t.after(()=>registry.close());
 await assert.rejects(registry.add(temp),/没有找到/);
 for(const root of ['one','two']){const folder=path.join(temp,root,'my-writing');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'SKILL.md'),source());await registry.add(folder);}
 const list=await registry.list();assert.equal(list.items.length,2);assert.notEqual(list.items[0].name,list.items[1].name);
 const secondAccount=createLocalSkillRegistry({file:path.join(temp,'other-profile.json')});t.after(()=>secondAccount.close());await assert.rejects(secondAccount.snapshot(list.items[0].name),/不可用/);
});

test('watch notifications refresh locally edited skills and desktop packages include the reader',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'gugu-skill-watch-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const directory=path.join(temp,'my-writing');await mkdir(directory);await writeFile(path.join(directory,'SKILL.md'),source());
 let notify;
 const registry=createLocalSkillRegistry({file:path.join(temp,'profile.json'),pollIntervalMs:150,onChange:()=>notify?.()});t.after(()=>registry.close());
 const changed=()=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('skill change notification timed out')),2500);notify=()=>{clearTimeout(timeout);notify=null;resolve();};});
 const initial=changed();await registry.add(directory);await initial;
 const next=changed();await writeFile(path.join(directory,'SKILL.md'),source().replace('我的剧本技能','修改后的技能名称'));await next;
 assert.equal((await registry.list()).items[0].title,'修改后的技能名称');
 const builder=await readFile(new URL('../desktop/electron-builder.yml',import.meta.url),'utf8');assert.ok(builder.includes('lib/agent/local-skills.mjs'));
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));assert.ok(pkg.dependencies['js-yaml']);
});
