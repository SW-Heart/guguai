import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {renameMediaFile} from '../desktop/media-rename.mjs';

test('file rename changes the disk name, preserves bytes and extensions, and never overwrites namesakes',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'gugu-rename-'));
  try{
    await fs.writeFile(path.join(workspace,'original.png'),'original bytes');
    await fs.writeFile(path.join(workspace,'林默.png'),'another asset');
    const renamed=await renameMediaFile({workspace,asset:{relativePath:'original.png'},name:'林默'});
    assert.equal(renamed.name,'林默.png');assert.equal(renamed.relativePath,'林默 (2).png');
    assert.equal(await fs.readFile(path.join(workspace,renamed.relativePath),'utf8'),'original bytes');
    assert.equal(await fs.readFile(path.join(workspace,'林默.png'),'utf8'),'another asset');
    await assert.rejects(fs.access(path.join(workspace,'original.png')));
    await assert.rejects(renameMediaFile({workspace,asset:{relativePath:'../outside.png'},name:'林默'}),/路径不受信任/);
    await assert.rejects(renameMediaFile({workspace,asset:{relativePath:renamed.relativePath},name:'..'}),/不能为空/);
    const safe=await renameMediaFile({workspace,asset:{relativePath:renamed.relativePath},name:'../门外'});
    assert.equal(path.dirname(path.resolve(workspace,safe.relativePath)),workspace);
  }finally{await fs.rm(workspace,{recursive:true,force:true});}
});

test('workspace changes during rename roll back the new path and retain the original',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'gugu-rename-'));
  try{
    await fs.writeFile(path.join(workspace,'original.png'),'bytes');let checks=0;
    await assert.rejects(renameMediaFile({workspace,asset:{relativePath:'original.png'},name:'林默',assertCurrent:()=>{if(++checks>1)throw new Error('workspace changed');}}),/workspace changed/);
    assert.equal(await fs.readFile(path.join(workspace,'original.png'),'utf8'),'bytes');
    await assert.rejects(fs.access(path.join(workspace,'林默.png')));
  }finally{await fs.rm(workspace,{recursive:true,force:true});}
});
