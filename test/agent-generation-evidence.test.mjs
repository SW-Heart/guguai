import test from 'node:test';
import assert from 'node:assert/strict';
import { generationReplyIssue } from '../lib/agent/generation-evidence.mjs';
import { createAgentTools } from '../lib/agent/tools.mjs';

const doc = { messages: [{role:'user',content:'设计林默角色三视图和汽车旅馆场景参考图'}, {role:'assistant',content:'建议制作七张图像素材。'}, {role:'user',content:'生成'}] };
const issue = (content, jobs = [], current = doc) => generationReplyIssue({content}, current, jobs);

test('rejects simulated batches, submission and completion without real media jobs', () => {
  assert.equal(issue('现在提交生成这两个核心资产：\n正在生成：\n等待生成中...\n两张核心资产已生成完成！\n全部图像资产生成完成！✅'), 'unverified_generation_completion');
  for (const text of ['正在生成：林默三视图', '等待生成中...', '已提交图片生成', '已开始生成参考图']) {
    assert.equal(issue(text), 'unverified_generation_submission', text);
  }
  assert.equal(issue('两张核心资产已生成完成！', [], {...doc,prepared:{p:{quote:{},input:{type:'image'}}}}), 'unverified_generation_completion');
});

test('requires a finished job with an asset, and permits honest pending/failed reports', () => {
  for (const job of [{status:'queued'}, {status:'running'}, {status:'failed'}, {status:'completed'}]) {
    assert.equal(issue('图片已生成完成。', [job]), 'unverified_generation_completion');
  }
  assert.equal(issue('图片已生成完成。', [{status:'completed',assetId:'image-1'}]), '');
  assert.equal(issue('正在生成：林默三视图', [{status:'queued'}]), '');
  for (const text of ['尚未生成完成，请稍等。', '没有提交生成。', '图片生成失败，尚未完成。', '生成完成后我会检查图片。', '我将要生成两张参考图。', '先生成一张林默三视图，作为人物参考。', '你提到它声称图片已生成完成，但并没有图片。', '> 全部图像资产生成完成！', '```\n图片已生成完成\n```']) {
    assert.equal(issue(text), '', text);
  }
  assert.equal(issue('小说生成完成。', [], {messages:[{role:'user',content:'写一篇小说'}]}), '');
});

test('evidence reads scoped server jobs, never assistant status text or preview placeholders', () => {
  const reads = [];
  const scope = {deviceId:'d',workspaceId:'w'};
  const tools = createAgentTools({findGeneration:(user,id,requestedScope)=>{
    reads.push({user,id,scope:requestedScope});
    return id === 'missing' ? null : {id,status:'running',assetId:''};
  }});
  const session = {userId:'u',scope,doc:{generations:[{id:'submitted',status:'completed',assetId:'invented'}],prepared:{preview:{status:'completed'}},messages:[
    {role:'assistant',content:'所有图片已生成完成！'},
    {role:'assistant',tool_calls:[{function:{name:'jobs_read',arguments:'{"jobId":"read-job"}'}},{function:{name:'jobs_wait',arguments:'{"jobIds":["submitted","missing"]}'}},{function:{name:'jobs_read',arguments:'bad-json'}}]},
  ]}};
  assert.deepEqual(tools.generationEvidence(session), [{id:'submitted',status:'running',assetId:''},{id:'read-job',status:'running',assetId:''}]);
  assert.equal(reads.length,3);
  assert.ok(reads.every(read=>read.user==='u'&&read.scope===scope));
});
