import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithTimeout } from '../desktop/network.mjs';

function waitForAbort(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once:true });
  });
}

test('a stalled desktop request times out and preserves request options', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(fetchWithTimeout((url, options) => {
      assert.equal(options.method, 'PUT');
      assert.equal(options.body, 'bytes');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.timeoutMs, undefined);
      return waitForAbort(url, options);
    }, 'https://storage.test/upload', { method:'PUT', body:'bytes', credentials:'omit', timeoutMs:20 }), /连接超时/);
  } finally { clearInterval(keepAlive); }
});

test('request deadline still aborts a body that stalls after response headers', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const response = await fetchWithTimeout(async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once:true });
      },
    })), 'https://studio.test/status', { timeoutMs:20 });
    await assert.rejects(response.json(), /连接超时/);
  } finally { clearInterval(keepAlive); }
});

test('an existing caller cancellation is retained', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  controller.abort(reason);
  await assert.rejects(fetchWithTimeout(waitForAbort, 'https://studio.test/status', { signal:controller.signal }), error => error === reason);
});
