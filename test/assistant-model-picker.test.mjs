import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingAssistantModels, renderAssistantModels, modelMenuPlacement } from '../public/features/assistant/model-picker.js';
import { renderAssistantWelcome } from '../public/features/assistant/presentation.js';
import { agentLogoMarkup } from '../public/features/agent/welcome.js';

const models=[{id:'deepseek-v4-pro',label:'DeepSeek Pro'},{id:'model-gpt',label:'GPT 对话'},{id:'custom-model',label:'<script>bad()</script>'}];

test('model menu searches both the displayed name and actual model id',()=>{
  assert.deepEqual(matchingAssistantModels(models,'  DEEPSEEK '),[models[0]]);
  assert.deepEqual(matchingAssistantModels(models,'v4-pro'),[models[0]]);
  assert.deepEqual(matchingAssistantModels(models,'对话'),[models[1]]);
  assert.deepEqual(matchingAssistantModels(models,'不存在'),[]);
  assert.deepEqual(matchingAssistantModels(models,'  '),models);
});

test('model menu marks the saved choice and escapes names from the model catalog',()=>{
  const html=renderAssistantModels(models,'model-gpt');
  assert.equal((html.match(/aria-selected="true"/g)||[]).length,1);
  assert.match(html,/aria-selected="true" data-model-id="model-gpt"/);
  assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(renderAssistantModels(models,'model-gpt','不存在'),/没有找到相关模型/);
  assert.match(renderAssistantModels([],'',''),/暂无可用模型/);
});

test('model popover fits the viewport and opens above a composer near the bottom',()=>{
  const bottom=modelMenuPlacement({top:650,bottom:684,left:340},1200,800);
  assert.equal(bottom.above,true);assert.equal(bottom.edge,158);assert.equal(bottom.width,320);
  const top=modelMenuPlacement({top:30,bottom:64,left:340},1200,800);
  assert.equal(top.above,false);assert.equal(top.edge,72);
  const narrow=modelMenuPlacement({top:400,bottom:434,left:250},360,640);
  assert.ok(narrow.left>=12);assert.ok(narrow.left+narrow.width<=348);
  assert.ok(narrow.maxHeight<400);
});

test('assistant welcome reuses the canvas Agent logo component',()=>{
  assert.ok(renderAssistantWelcome().includes(agentLogoMarkup));
  assert.match(agentLogoMarkup,/gugu-agent-logo/);
});
