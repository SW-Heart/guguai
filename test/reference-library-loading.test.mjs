import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/features/media/controller.js',import.meta.url),'utf8');
const loader=source.slice(source.indexOf('  async function loadReferenceFiles('),source.indexOf('  async function loadFiles('));

test('reference selection reads all file library pages without inheriting the current filter',async()=>{
  const queries=[],files=new Map();
  const context=vm.createContext({accountSnapshot:()=>({id:'account'}),getAccountEpoch:()=>1,requestIsCurrent:()=>true,
    listDesktopFiles:async options=>{
      queries.push(options);
      return options.cursor?{items:[{id:'video',kind:'video'},{id:'deleted',localStatus:'missing'},{id:'image',kind:'image'}]}:
        {items:[{id:'image',kind:'image'}],nextCursor:'page-two'};
    },mergeStateFiles:items=>items.forEach(file=>files.set(file.id,file)),fileById:id=>files.get(id),
  });
  vm.runInContext(loader,context);
  const result=await context.loadReferenceFiles();
  assert.deepEqual(Array.from(result,file=>file.id),['image','video']);
  assert.deepEqual(queries.map(query=>query.cursor),['','page-two']);
  assert.ok(queries.every(query=>!query.kind&&!query.search));
});

test('changing accounts discards a pending file library page',async()=>{
  let resolvePage,merged=false,current=true;
  const context=vm.createContext({accountSnapshot:()=>({}),getAccountEpoch:()=>1,requestIsCurrent:()=>current,
    listDesktopFiles:()=>new Promise(resolve=>{resolvePage=resolve;}),mergeStateFiles:()=>{merged=true;},fileById:()=>null,
  });
  vm.runInContext(loader,context);
  const request=context.loadReferenceFiles();current=false;
  resolvePage({items:[{id:'old-account-file'}]});
  assert.equal((await request).length,0);assert.equal(merged,false);
});

test('the shared reference dialog refreshes its file library on every opening',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const opening=app.slice(app.indexOf('function openReferenceDialog('),app.indexOf('function openVideoFrameDialog('));
  assert.match(opening,/refreshReferenceLibrary\(\)/);
  const canvas=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  assert.doesNotMatch(canvas,/画布素材|data-gen-canvas-image|generationCanvasImages/);
  assert.match(canvas,/await syncCanvasMediaLibrary\(\);if\(isCurrent\(\)\)return bridge.uploadGenerationFile\(\)/);
});
