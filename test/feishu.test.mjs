import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyGenerationFailure, __test } from '../lib/feishu.mjs';

const webhookEnv = { FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook' };

test('generation failure card keeps the upstream error and requested fields', () => {
  const card = __test.generationFailureCard({
    task: { id: 'generation-1', modelId: 'seedance-2.0', provider: 'diw' },
    user: { username: 'alice' },
    error: { upstreamMessage: '上游返回：内容审核拒绝' },
    createdAt: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(card.msg_type, 'interactive');
  assert.match(card.card.header.title.content, /生成任务失败/);
  assert.match(card.card.elements[0].fields[0].text.content, /seedance-2.0/);
  assert.match(card.card.elements[0].fields[1].text.content, /diw/);
  assert.match(card.card.elements[1].text.content, /^任务 ID：generation-1$/);
  assert.match(card.card.elements[2].text.content, /^用户名：alice$/);
  assert.match(card.card.elements[4].text.content, /内容审核拒绝/);
  assert.match(card.card.elements[5].text.content, /2026-09-11 08:00:00/);
  assert.doesNotMatch(JSON.stringify(card), /\\n/);
  assert.doesNotMatch(JSON.stringify(card), /积分|退款/);
});

test('feishu notification retries business failures and succeeds', async () => {
  let attempts = 0;
  const result = await notifyGenerationFailure({
    env: webhookEnv,
    task: { id: 'generation-2', modelId: 'gpt-image-2', provider: 'duomi' },
    user: { username: 'bob' },
    error: { message: 'HTTP 500：上游服务异常' },
    fetchImpl: async (_url, init) => {
      attempts += 1;
      assert.equal(init.method, 'POST');
      assert.match(init.headers['Content-Type'], /application\/json/);
      const response = attempts < 3 ? { code: 999, msg: 'temporary failure' } : { code: 0, msg: 'success' };
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  assert.equal(result.sent, true);
  assert.equal(attempts, 3);
});
