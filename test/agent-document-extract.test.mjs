import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const JSZip = createRequire(require.resolve('mammoth'))('jszip');
const routeUrl = new URL('../server/routes/agent.mjs', import.meta.url).href;
const extractor = `
  import { readFileSync } from 'node:fs';
  import { Readable } from 'node:stream';
  import { createAgentRouteHandler } from ${JSON.stringify(routeUrl)};
  const route = createAgentRouteHandler({
    requireUser:async()=>({id:'document-reader'}),
    requireDesktopWorkspaceScope:()=>({desktop:true,deviceId:'test',workspaceId:'test'}),
    sendJson:(res,status,data)=>Object.assign(res,{status,data}),
  });
  const req = Readable.from([readFileSync(0)]);
  req.method = 'POST';
  const res = {};
  await route(req,res,new URL('http://localhost/api/agent/documents/extract?name=script.docx'));
  process.stdout.write(JSON.stringify(res));
`;

async function extractDocx(xml) {
  const zip = new JSZip();
  zip.file('word/document.xml', xml);
  const input = await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  // A regressed synchronous parser cannot be stopped by a test timeout alone.
  // Keep crafted input in a child process with both time and heap limits.
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', extractor], {
    input, encoding:'utf8', timeout:5000, maxBuffer:1024*1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Word document extraction preserves Chinese text and paragraph breaks after the XML update', async () => {
  const res = await extractDocx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一场：你好 &amp; 世界</w:t></w:r></w:p><w:p><w:r><w:t>第二场：重逢</w:t></w:r></w:p></w:body></w:document>');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {name:'script.docx',text:'第一场：你好 & 世界\n\n第二场：重逢'});
});

test('Word upload rejects the xmldom end-tag ReDoS payload within bounded resources', async () => {
  const res = await extractDocx('<r></' + ' '.repeat(256*1024) + 'x>');
  assert.equal(res.status, 422);
  assert.equal(res.data.error, '无法读取这份文件，请确认文件未损坏后重试');
});

test('Word upload handles deeply nested namespace declarations within bounded resources', async () => {
  const count = 2000;
  const opening = Array.from({length:count}, (_, i) => `<a xmlns:p${i}="urn:${i}">`).join('');
  const res = await extractDocx('<r>' + opening + '</a>'.repeat(count) + '</r>');
  assert.equal(res.status, 422);
  assert.ok(res.data.error);
});
