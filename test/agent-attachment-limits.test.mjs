import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { attachmentKind } from '../public/features/agent/attachment-preview.js';

const source = readFileSync(new URL('../public/features/agent/workspace.js', import.meta.url), 'utf8');
function fixture() {
  let uploaded = 0, picked = 0;
  const notices = [];
  const context = vm.createContext({
    attachments:[], busy:0, state:{files:[]}, crypto:{randomUUID}, attachmentKind,
    menuEvents:new AbortController(),localPreviewUrls:new Set(),URL:{createObjectURL:()=>`blob:${randomUUID()}`},
    toast:text => notices.push(text), current:() => true, drawAttachments() {}, previewUrl:() => '',
    api:async () => ({ asset:{ id:`uploaded-${++uploaded}`, kind:'image' } }),
    importCanvasAsset:async () => ({ id:`library-${++picked}`, kind:'image', name:'图片' }),
    cloudFile:async file => file,
  });
  vm.runInContext(source.slice(source.indexOf('    const addSelectedFiles='), source.indexOf('    addButton.onclick=')) + '\nglobalThis.addSelectedFiles=addSelectedFiles;globalThis.addLibraryAsset=addLibraryAsset;', context);
  return { context, notices, uploaded:() => uploaded, picked:() => picked };
}

test('local upload accepts 30 images and blocks the 31st before uploading', async () => {
  const f = fixture();
  await f.context.addSelectedFiles(Array.from({length:31}, (_,i) => ({name:`image-${i}.png`,type:'image/png',size:100})));
  assert.equal(f.context.attachments.filter(item => item.status === 'ready').length, 30);
  assert.equal(f.uploaded(), 30);
  assert.match(f.notices.at(-1), /30/);
});

test('library selection prepares all 30 images and rejects additional picks', async () => {
  const f = fixture();
  for (let i = 0; i < 31; i++) await f.context.addLibraryAsset();
  assert.equal(f.context.attachments.filter(item => item.status === 'ready').length, 30);
  assert.equal(f.picked(), 30);
  assert.match(f.notices.at(-1), /30/);
});

test('raising the image allowance retains the separate document limit', async () => {
  const f = fixture();
  await f.context.addSelectedFiles(Array.from({length:11}, (_,i) => ({name:`document-${i}.txt`,type:'text/plain',size:10,text:async () => '内容'})));
  assert.equal(f.context.attachments.filter(item => item.status === 'ready').length, 10);
  assert.match(f.notices.at(-1), /10 份文档/);
});

test('a local media preview is available while upload is pending and never sent as the asset URL', async () => {
  const f = fixture();let complete;
  f.context.api = () => new Promise(resolve => { complete = resolve; });
  const pending = f.context.addSelectedFiles([{name:'video.mp4',type:'video/mp4',size:100}]);
  const item = f.context.attachments[0];
  assert.equal(item.status, 'loading');
  assert.match(item.previewUrl, /^blob:/);
  assert.ok(f.context.localPreviewUrls.has(item.previewUrl));
  complete({asset:{id:'cloud',kind:'video',url:'https://example.com/video.mp4'}});
  await pending;
  assert.equal(item.status, 'ready');
  assert.equal(item.asset.url, 'https://example.com/video.mp4');
});

test('leaving the entry during upload prevents remaining files and stale assets being added', async () => {
  const f = fixture();let complete;
  f.context.api = () => new Promise(resolve => { complete = resolve; });
  const pending = f.context.addSelectedFiles(['one','two'].map(name=>({name:`${name}.png`,type:'image/png',size:100})));
  f.context.menuEvents.abort();
  complete({asset:{id:'old',kind:'image'}});
  await pending;
  assert.equal(f.context.attachments.length, 1);
  assert.equal(f.context.state.files.length, 0);
  assert.equal(f.context.busy, 0);
});
