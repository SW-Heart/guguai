import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mentionTrigger} from '../public/features/drama/director-mentions.js';

test('mentions find a query at the caret without consuming surrounding text',()=>{
  assert.deepEqual(mentionTrigger('参考 @角色 后续',6),{start:3,end:6,query:'角色'});
  assert.deepEqual(mentionTrigger('@',1),{start:0,end:1,query:''});
  assert.deepEqual(mentionTrigger('参考@角色',5),{start:2,end:5,query:'角色'});
  assert.equal(mentionTrigger('a@b.com',7),null);
  assert.equal(mentionTrigger('@角色\n继续',6),null);
  assert.equal(mentionTrigger('@角色',1,3),null);
});
test('mention entry cache chain is updated',()=>{
  for(const [file,url] of [['index.html','/app.js?v=328'],['app.js','./drama-studio.js?v=137'],['drama-studio.js','./features/drama/director-workspace.js?v=42'],['features/drama/director-workspace.js','./director-mentions.js?v=1']]){
    assert.ok(readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8').includes(url));
  }
});
