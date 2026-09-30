import assert from 'node:assert/strict';
import test from 'node:test';
import { installResponseHeaderGuard, sanitizeResponseHeaders } from '../desktop/response-headers.mjs';

test('keeps valid response headers without changing their values', () => {
  const headers = { 'content-type':['text/plain; charset=utf-8'], 'x-latin1':['caf\u00e9'] };
  assert.equal(sanitizeResponseHeaders(headers), null);
  const callbacks = [];
  let handler;
  installResponseHeaderGuard({ onHeadersReceived: (_filter, listener) => { handler = listener; } });
  handler({ responseHeaders:headers }, response => callbacks.push(response));
  assert.deepEqual(callbacks, [{}]);
});

test('removes only response header values that Electron cannot convert to ByteString', () => {
  const headers = {
    'content-type':['application/octet-stream'],
    'content-disposition':['attachment; filename="' + 'a'.repeat(40) + '输出版.mp4"'],
    'x-options':['usable', '含中文'],
  };
  assert.throws(() => new Headers({ 'content-disposition':headers['content-disposition'][0] }), /character at index 62 has a value of 36755/);
  const reported = [];
  let handler;
  installResponseHeaderGuard({ onHeadersReceived: (_filter, listener) => { handler = listener; } }, (url, names) => reported.push({ url, names }));
  let result;
  handler({ url:'https://storage.example/file?signature=secret', responseHeaders:headers }, response => { result = response; });
  assert.deepEqual(result.responseHeaders, { 'content-type':['application/octet-stream'], 'x-options':['usable'] });
  assert.deepEqual(headers['x-options'], ['usable', '含中文']);
  assert.deepEqual(reported, [{ url:'https://storage.example/file?signature=secret', names:['content-disposition', 'x-options'] }]);
  for (const values of Object.values(result.responseHeaders)) {
    for (const value of values) assert.doesNotThrow(() => new Headers({ check:value }));
  }
});

test('removes invalid names and control characters before Electron constructs Headers', () => {
  const headers = {
    'bad name':['ok'],
    '中文':['ok'],
    'x-control':['a\0b', 'a\rb', 'a\nb', 'valid\ttab'],
    'content-disposition':["attachment; filename*=UTF-8''%E8%BE%93%E5%87%BA.mp4"],
    'set-cookie':['session=valid; HttpOnly', 'broken=中文'],
  };
  const result = sanitizeResponseHeaders(headers);
  assert.deepEqual(result.responseHeaders, {
    'x-control':['valid\ttab'],
    'content-disposition':headers['content-disposition'],
    'set-cookie':['session=valid; HttpOnly'],
  });
  const converted = new Headers();
  for (const [name, values] of Object.entries(result.responseHeaders)) converted.set(name, values.join(', '));
  assert.equal(converted.get('x-control'), 'valid\ttab');
});

test('diagnostic failures cannot interrupt the header callback', () => {
  let handler;
  installResponseHeaderGuard({ onHeadersReceived: (_filter, listener) => { handler = listener; } }, () => { throw new Error('log failure'); });
  let calls = 0;
  handler({ responseHeaders:{ 'x-invalid':['中文'] } }, result => {
    calls++;
    assert.deepEqual(result, { responseHeaders:{} });
  });
  assert.equal(calls, 1);
});
