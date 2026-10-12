import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAgentWeb } from '../services/agent-web-search.mjs';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { reasoningPhrases } from '../public/features/agent/reasoning-text.js';

test('conversation status displays searching before and between streamed replies', () => {
  for (const streaming of [false, true]) assert.deepEqual(reasoningPhrases({ activity: '正在搜索资料…', streaming }), ['正在搜索资料']);
  assert.deepEqual(reasoningPhrases({ activity: '正在回复…', streaming: true }), ['正在回复']);
});

test('Tavily search uses only the server credential and returns bounded, attributable sources', async () => {
  const result = await searchAgentWeb({ query: ' 官方资料 ', topic: 'news', timeRange: 'week', maxResults: 3 }, {
    env: { TAVILY_API: 'test-secret' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.tavily.com/search');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.deepEqual(JSON.parse(options.body), { query: '官方资料', max_results: 3, topic: 'news', search_depth: 'basic', include_answer: false, include_raw_content: false, include_images: false, time_range: 'week' });
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ results: [
        { title: '官方文档', url: 'https://example.com/docs', content: '文'.repeat(4000), published_date: '2026-10-12', raw_content: 'private body' },
        { title: '无效链接', url: 'javascript:alert(1)', content: 'bad' },
        { title: '第二来源', url: 'https://example.org/news', content: '摘要' },
        { title: '超出数量', url: 'https://example.net/' },
      ], answer: 'unused' }) };
    },
  });
  assert.equal(result.query, '官方资料');
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].content.length, 3000);
  assert.equal(result.results[0].publishedDate, '2026-10-12');
  assert.equal(result.results[1].url, 'https://example.org/news');
  assert.doesNotMatch(JSON.stringify(result), /test-secret|private body|unused/);
});

test('missing credentials and invalid search conditions do not send requests', async () => {
  const options = { env: {}, fetchImpl: () => assert.fail('must not send a request') };
  await assert.rejects(searchAgentWeb({ query: '资料' }, options), /搜索暂不可用/);
  for (const args of [{ query: ' ' }, { query: '字'.repeat(401) }, { query: '资料', maxResults: 2.5 }, { query: '资料', maxResults: 9 }, { query: '资料', topic: 'invalid' }, { query: '资料', timeRange: 'invalid' }]) {
    await assert.rejects(searchAgentWeb(args, options));
  }
});

test('provider errors and malformed responses never expose upstream secrets', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401, json: async () => assert.fail('do not read error body') }),
    async () => { throw new Error('Bearer test-secret'); },
    async () => ({ ok: true, json: async () => { throw new Error('test-secret'); } }),
    async () => ({ ok: true, json: async () => ({}) }),
  ]) {
    await assert.rejects(searchAgentWeb({ query: '资料' }, { env: { TAVILY_API: 'test-secret' }, fetchImpl }), { message: '搜索暂未成功，请稍后重试' });
  }
  const empty = await searchAgentWeb({ query: '资料' }, { env: { TAVILY_API: 'test-secret' }, fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }) });
  assert.deepEqual(empty.results, []);
});

test('search respects both interruption and timeout', async () => {
  const fetchImpl = async (_url, { signal }) => {
    signal.throwIfAborted();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const controller = new AbortController();
  const pending = searchAgentWeb({ query: '资料' }, { env: { TAVILY_API: 'test-secret' }, fetchImpl, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /搜索已停止/);
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(searchAgentWeb({ query: '资料' }, { env: { TAVILY_API: 'test-secret' }, fetchImpl, timeoutMs: 10 }), /搜索超时/);
  } finally { clearInterval(keepAlive); }
});

test('agent exposes web search as an optional tool and forwards cancellation', async () => {
  const controller = new AbortController();
  const tools = createAgentTools({ webSearch: async (args, { signal }) => {
    assert.deepEqual(args, { query: '资料' });
    assert.equal(signal, controller.signal);
    return { query: args.query, results: [] };
  } });
  const definition = tools.definitions().find(item => item.function.name === 'web_search');
  assert.deepEqual(definition.function.parameters.required, ['query']);
  assert.equal(tools.get('web_search').paid, undefined);
  assert.deepEqual(await tools.execute('web_search', { query: '资料' }, {}, { signal: controller.signal }), { query: '资料', results: [] });
  await assert.rejects(tools.execute('web_search', { query: '资料', apiKey: 'injected' }, {}), /不支持 apiKey/);
});
