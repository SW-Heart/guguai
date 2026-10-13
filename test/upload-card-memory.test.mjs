import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('progress updates keep the same upload card and media; removal and source replacement still work', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const children = [];
  let creations = 0;
  const container = {
    children, dataset:{}, querySelectorAll:() => [...children],
    insertBefore(node, before) {
      const previous = children.indexOf(node);
      if (previous >= 0) children.splice(previous, 1);
      const index = before ? children.indexOf(before) : children.length;
      children.splice(index, 0, node);
    },
  };
  const context = vm.createContext({
    uploadJobCard:job => job,
    elementFromHtml:job => {
      creations++;
      const shade = {innerHTML:''};
      const node = {
        dataset:{uploadId:job.id}, media:{url:job.previewUrl}, classList:{toggle() {}}, setAttribute() {},
        querySelector:selector => selector === '.upload-job-shade' ? shade : null,
        remove() { children.splice(children.indexOf(node), 1); },
        replaceWith(next) { children.splice(children.indexOf(node), 1, next); },
      };
      return node;
    },
  });
  vm.runInContext(source.slice(source.indexOf('function renderUploadJobCards('), source.indexOf('function notifyUploadSurfaceChanged(')), context);
  vm.runInContext(source.slice(source.indexOf('function reconcileCards('), source.indexOf('function bindTaskCard(')), context);
  const job = {id:'one',kind:'video',previewUrl:'gugu-media://asset/one',name:'视频',progress:0,status:'uploading'};
  context.renderUploadJobCards(container, [job]);
  const original = children[0], media = original.media;
  for (let progress = 1; progress <= 100; progress++) {
    context.reconcileCards(container, [], {empty:'',preserve:node => node.dataset.uploadId === job.id});
    context.renderUploadJobCards(container, [{...job, progress}]);
  }
  assert.equal(children[0], original);
  assert.equal(children[0].media, media);
  assert.equal(creations, 1);
  context.renderUploadJobCards(container, [{...job, previewUrl:'gugu-media://asset/two'}]);
  assert.notEqual(children[0], original);
  assert.equal(creations, 2);
  context.renderUploadJobCards(container, []);
  assert.equal(children.length, 0);
});
