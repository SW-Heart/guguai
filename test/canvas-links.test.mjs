import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLinks, linkId, addLink, removeLinks, linkError, primaryResult, generatorLabel, resolveGenerationInputs, generationRequestDraft, placeResults, linkCurve, migrateCanvasDrafts, foldedResults, uniqueEntityName, renameEntity, summarizeCanvas } from '../public/features/drama/canvas-links.js';
import { normalizeDirectorWorkspace } from '../public/features/drama/director-actions.js';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { admitLinkedReference } from '../public/features/drama/canvas-generation-references.js';
import { canvasGenerationPayload } from '../public/features/drama/canvas-generation.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { curvePath, rectAt, connectionTarget, magneticPortPosition, connectionSource } from '../public/features/drama/canvas-connect.js';
import { displayedResult } from '../public/features/drama/canvas-links.js';

test('ordinary generators fold all output frames and display a selected result in place',()=>{
  for(const type of ['image','video']){
    const generator={id:'g',type};
    const results=[{id:'r1',parentId:'g',taskId:'t1'},{id:'r2',parentId:'g',taskId:'t2'}];
    assert.deepEqual(foldedResults(results,generator,()=>null),{folded:['r1','r2'],total:2});
    assert.equal(displayedResult(results,generator).id,'r2');
    generator.primaryId='r1';
    assert.equal(displayedResult(results,generator).id,'r1');
    generator.primaryId='missing';
    assert.equal(displayedResult(results,generator).id,'r2');
    assert.equal(displayedResult(results,{...generator,entity:{kind:'character',name:'外婆'}}),null);
    assert.equal(displayedResult(results,{...generator,role:'shot'}),null);
    assert.equal(foldedResults(results,{...generator,role:'shot'},()=>null).folded.length,0);
  }
});

const modes = [
  { generationType: 'TEXT', aspectRatios: ['16:9'], durations: [5], qualityOptions: ['720p'], maxImages: 0 },
  { generationType: 'REFERENCE', aspectRatios: ['16:9'], durations: [5], qualityOptions: ['720p'], maxImages: 2, referenceLimits: { image: 2, video: 1, audio: 1, total: 3 } },
];
const config = { videoCapabilities: { models: [{ id: 'vid', modes }] } };
const video = (extra = {}) => ({ id: 'canvas-gen-shot', type: 'video', modelId: 'vid', mode: 'TEXT', aspect: '16:9', quality: '720p', duration: 5, prompt: '', promptSegments: [], attachments: [], taskId: '', ...extra });

test('links are unique, never point at themselves and can be removed', () => {
  assert.deepEqual(normalizeLinks([{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }, { from: 'c', to: 'c' }, { from: 1, to: 'b' }]), [{ id: linkId('a', 'b'), from: 'a', to: 'b' }]);
  const workspace = {};
  assert.equal(addLink(workspace, 'a', 'b'), true);
  assert.equal(addLink(workspace, 'a', 'b'), false);
  assert.equal(removeLinks(workspace, link => link.from === 'a'), true);
  assert.deepEqual(workspace.links, []);
});

test('only generation nodes take inputs, and each kind of input goes where it fits', () => {
  const image = { id: 'i', type: 'image', taskId: '' }, clip = { id: 'v', type: 'video', taskId: '' };
  assert.equal(linkError(image, { id: 't', kind: 'text' }), '');
  assert.equal(linkError(clip, { id: 'a', kind: 'audio' }), '');
  assert.equal(linkError(clip, { id: 'p', kind: 'image' }), '');
  assert.match(linkError(image, { id: 'v2', kind: 'video' }), /只能使用图片/);
  assert.match(linkError({ ...image, taskId: 'done' }, { id: 't', kind: 'text' }), /只能连接到/);
  assert.match(linkError(image, { id: 'i', kind: 'image' }), /自身/);
});

test('linking a picture switches a text-only video to references and respects model limits', () => {
  const draft = video();
  admitLinkedReference(draft, 'image', [], config);
  assert.equal(draft.mode, 'REFERENCE');
  assert.throws(() => admitLinkedReference(draft, 'image', ['image', 'image'], config), /数量超过/);
});

test('a card passes on its main picture and other nodes their latest result', () => {
  const drafts = [{ id: 'g', primaryId: 'r2', entity: { kind: 'character', name: '外婆' } }, { id: 'r1', parentId: 'g', taskId: 't1' }, { id: 'r2', parentId: 'g', taskId: 't2' }, { id: 'r3', parentId: 'g', taskId: 't3' }];
  const tasks = { t1: { status: 'completed' }, t2: { status: 'running' }, t3: { status: 'completed' } };
  assert.equal(primaryResult(drafts, drafts[0], id => tasks[id]).id, 'r1', 'an unfinished choice falls back to the first finished picture');
  tasks.t2.status = 'completed';
  assert.equal(primaryResult(drafts, drafts[0], id => tasks[id]).id, 'r2');
  const plain = { id: 'g' };
  assert.equal(primaryResult(drafts, plain, id => tasks[id]).id, 'r3', 'other nodes pass on their latest result');
  plain.primaryId='r1';
  assert.equal(primaryResult(drafts,plain,id=>tasks[id]).id,'r1','switching the displayed result updates references');
  assert.equal(generatorLabel({ entity: { name: '外婆' }, title: '角色 · 外婆' }), '外婆');
});

test('a card and its main picture share one reference, and mentions follow the shared file', () => {
  const draft = video({ mode: 'REFERENCE', prompt: '@外婆 看向 @外婆图 和 @猫', promptSegments: [{ id: 'card', label: '外婆' }, ' 看向 ', { id: 'pic', label: '外婆图' }, ' 和 ', { id: 'cat-file', label: '猫' }], attachments: [{ id: 'cat-file', kind: 'image', name: '猫', url: '/cat.png' }] });
  const links = normalizeLinks([{ from: 'card', to: draft.id }, { from: 'pic', to: draft.id }, { from: 'note', to: draft.id }]);
  const sources = {
    card: { kind: 'image', label: '外婆', file: { id: 'asset-grandma', kind: 'image', url: '/g.png' } },
    pic: { kind: 'image', label: '外婆图', file: { id: 'asset-grandma', kind: 'image', url: '/g.png' } },
    note: { kind: 'text', label: '剧本', text: '夜晚' },
  };
  const inputs = resolveGenerationInputs(draft, links, id => sources[id]);
  assert.deepEqual(inputs.attachments.map(file => file.id), ['cat-file', 'asset-grandma']);
  const request = generationRequestDraft(draft, inputs);
  assert.equal(request.prompt, '夜晚\n\n@外婆 看向 @外婆 和 @猫');
  const payload = canvasGenerationPayload(request, config);
  assert.equal(payload.prompt, '夜晚\n\nImage2 看向 Image2 和 Image1');
  assert.deepEqual(payload.referenceAssetIds, ['cat-file', 'asset-grandma']);
});

test('plain-text mentions from a storyboard resolve to the linked card by name', () => {
  const draft = video({ mode: 'REFERENCE', prompt: '@外婆 睁眼' });
  const inputs = resolveGenerationInputs(draft, normalizeLinks([{ from: 'card', to: draft.id }]), () => ({ kind: 'image', label: '外婆', file: { id: 'asset-grandma', kind: 'image' } }));
  assert.equal(canvasGenerationPayload(generationRequestDraft(draft, inputs), config).prompt, 'Image1 睁眼');
});

test('two different files with the same name get distinct labels', () => {
  const draft = video({ mode: 'REFERENCE' });
  const sources = { a: { kind: 'image', label: '外婆', file: { id: 'one', kind: 'image' } }, b: { kind: 'image', label: '外婆', file: { id: 'two', kind: 'image' } } };
  const inputs = resolveGenerationInputs(draft, normalizeLinks([{ from: 'a', to: draft.id }, { from: 'b', to: draft.id }]), id => sources[id]);
  assert.deepEqual(inputs.attachments.map(file => file.name), ['外婆', '外婆 2']);
});

test('linked text alone is enough to describe the request', () => {
  const draft = { id: 'canvas-gen-img', type: 'image', prompt: '', attachments: [] };
  const inputs = resolveGenerationInputs(draft, normalizeLinks([{ from: 'doc', to: draft.id }]), () => ({ kind: 'text', label: '设定', text: '红衣少女' }));
  assert.equal(generationRequestDraft(draft, inputs).prompt, '红衣少女');
});

test('results line up to the right of their node and step around existing content', () => {
  const parent = { x: 0, y: 0, width: 200, height: 300 };
  const [first, second] = placeResults(parent, [{ width: 200, height: 300 }, { width: 200, height: 300 }], [{ x: 296, y: 0, width: 100, height: 100 }]);
  assert.equal(first.x, 296);
  assert.ok(first.y >= 124, 'moves below the blocking card');
  assert.ok(second.y >= first.y + 324);
  assert.deepEqual(linkCurve({ x: 0, y: 0, width: 100, height: 100 }, { x: 300, y: 0, width: 100, height: 100 }).slice(0, 2), [100, 50]);
});

test('older reference cards that were replaced by their picture become a card plus a result', () => {
  const workspace = { generationDrafts: [{ id: 'canvas-gen-sb-1-r-a', type: 'image', prompt: '老人', title: '场景 · 卧室', source: { role: 'reference', name: '卧室' }, taskId: 't1', status: 'completed', attachments: [] }], positions: { 'canvas-gen-sb-1-r-a': { x: 0, y: 0, width: 280, height: 373 } } };
  assert.equal(migrateCanvasDrafts(workspace), true);
  const [card, result] = workspace.generationDrafts;
  assert.deepEqual(card.entity, { kind: 'location', name: '卧室' });
  assert.equal(card.taskId, '');assert.equal(card.prompt, '老人');assert.equal(card.primaryId, result.id);
  assert.equal(result.taskId, 't1');assert.equal(result.parentId, card.id);assert.equal(result.source, undefined);
  assert.ok(workspace.positions[result.id].x > 280);
  assert.equal(migrateCanvasDrafts(workspace), false);
});

test('the drag handle finds the topmost node and draws a forward curve', () => {
  const rects = [{ id: 'below', left: 0, top: 0, width: 100, height: 100 }, { id: 'above', left: 50, top: 50, width: 100, height: 100 }];
  assert.equal(rectAt(rects, 60, 60).id, 'above');
  assert.equal(rectAt(rects, 60, 60, { exclude: 'above' }).id, 'below');
  assert.equal(rectAt(rects, 170, 60, { slack: 24 }).id, 'above');
  assert.equal(rectAt(rects, 300, 300), null);
  assert.match(curvePath(0, 0, 200, 100), /^M0 0 C[\d.]+ 0 [\d.]+ 100 200 100$/);
});

test('older results fold away while the latest three and the main picture stay', () => {
  const card = { id: 'g', entity: { kind: 'character', name: '外婆' }, primaryId: 'r1' };
  const drafts = [card, ...[1, 2, 3, 4, 5, 6].map(index => ({ id: `r${index}`, parentId: 'g', taskId: `t${index}` }))];
  const done = () => ({ status: 'completed' });
  assert.deepEqual(foldedResults(drafts, card, done), { folded: ['r2', 'r3'], total: 6 });
  assert.deepEqual(foldedResults(drafts, { ...card, expanded: true }, done).folded, []);
  assert.deepEqual(foldedResults(drafts.slice(0, 4), card, done).folded, []);
});

test('card names stay unique and renaming updates the shots that use the card', () => {
  const workspace = { generationDrafts: [
    { id: 'a', entity: { kind: 'character', name: '外婆' } }, { id: 'b', entity: { kind: 'character', name: '阿婆' } }, { id: 'c', entity: { kind: 'character', name: '外婆婆' } },
    { id: 's', prompt: '@外婆睁眼，@外婆婆 起身', promptSegments: [] },
    { id: 'v', prompt: '@外婆 看', promptSegments: [{ id: 'a', label: '外婆' }, ' 看'] },
    { id: 'other', prompt: '@外婆 不相关', promptSegments: [] },
  ], links: [{ from: 'a', to: 's' }, { from: 'a', to: 'v' }] };
  assert.equal(uniqueEntityName(workspace.generationDrafts, '阿婆'), '阿婆 2');
  assert.equal(renameEntity(workspace, 'a', '阿婆'), '阿婆 2');
  const [, , , shot, video, other] = workspace.generationDrafts;
  assert.equal(shot.prompt, '@阿婆 2睁眼，@外婆婆 起身', 'longer names are left alone');
  assert.deepEqual(video.promptSegments, [{ id: 'a', label: '阿婆 2' }, ' 看']);
  assert.equal(video.prompt, '@阿婆 2 看');
  assert.equal(other.prompt, '@外婆 不相关', 'only nodes linked from the card change');
});

test('saved canvases keep text cards, shot cards and expanded results', () => {
  const workspace = normalizeDirectorWorkspace({
    notes: [{ id: 'canvas-note-1', role: 'script', title: '剧本\n第一版', text: '雨夜', revision: 3 }, { id: 'bad', text: 'x' }],
    generationDrafts: [{ id: 'canvas-gen-s', type: 'video', role: 'shot', title: '分镜 1', expanded: true }, { id: 'canvas-gen-x', type: 'image', role: 'other', expanded: 'yes' }],
  });
  assert.deepEqual(workspace.notes, [{ id: 'canvas-note-1', role: 'script', title: '剧本 第一版', text: '雨夜', revision: 3 }]);
  assert.equal(workspace.generationDrafts[0].role, 'shot');assert.equal(workspace.generationDrafts[0].expanded, true);
  assert.equal(workspace.generationDrafts[1].role, undefined);assert.equal(workspace.generationDrafts[1].expanded, undefined);
  const storyboard = { generationDrafts: [{ id: 'canvas-gen-sb-1-s-a', type: 'video', source: { role: 'segment' }, taskId: '' }] };
  assert.equal(migrateCanvasDrafts(storyboard), true);
  assert.equal(storyboard.generationDrafts[0].role, 'shot');
});

test('the assistant reads cards with their main picture, shots with inputs, and text cards', async () => {
  const workspace = {
    generationDrafts: [
      { id: 'canvas-gen-a', type: 'image', prompt: '白发老人', entity: { kind: 'character', name: '外婆' } },
      { id: 'canvas-gen-a-r1', type: 'image', taskId: 't1', parentId: 'canvas-gen-a' },
      { id: 'canvas-gen-gone', type: 'image', prompt: '已删除', entity: { kind: 'prop', name: '旧物' } },
      { id: 'canvas-gen-s', type: 'video', role: 'shot', title: '分镜 1', prompt: '@外婆 睁眼', duration: 5 },
    ],
    links: [{ from: 'canvas-gen-a', to: 'canvas-gen-s' }, { from: 'canvas-note-x', to: 'canvas-gen-s' }],
    notes: [{ id: 'canvas-note-x', role: 'script', title: '剧本', text: '第一场' }],
    hiddenIds: ['canvas-gen-gone'],
  };
  const summary = summarizeCanvas(workspace, id => id === 't1' ? { status: 'completed', assetId: 'asset-1' } : null);
  assert.deepEqual(summary.cards.map(card => [card.kind, card.name, card.mainAssetId]), [['角色', '外婆', 'asset-1']]);
  assert.deepEqual(summary.shots[0].inputs, ['外婆', '剧本']);
  assert.equal(summary.notes[0].text, '第一场');
  const tools = createAgentTools({ canvasStore: { read: () => ({ directorWorkspace: workspace }) }, findGeneration: (_user, id) => id === 't1' ? { status: 'completed', assetId: 'asset-1' } : null });
  assert.equal((await tools.execute('canvas_read', {}, { userId: 'u', scope: {}, doc: {} })).cards[0].mainAssetId, 'asset-1');
  const empty = createAgentTools({ canvasStore: { read: () => null } });
  assert.deepEqual((await empty.execute('canvas_read', {}, { userId: 'u', scope: {}, doc: {} })).cards, []);
});


test('connections snap near compatible input cards and preserve invalid-target feedback',()=>{
  const rects=[{id:'source',left:0,top:0,width:100,height:100},
    {id:'shot',left:300,top:0,width:100,height:100},
    {id:'picture',left:450,top:0,width:100,height:100}];
  const check=(from,to)=>to==='shot'?'':'不能接收';
  assert.equal(connectionTarget(rects,270,50,'source',check)?.id,'shot');
  assert.equal(connectionTarget(rects,282,-20,'source',check)?.id,'shot');
  assert.equal(connectionTarget(rects,240,50,'source',check),null);
  assert.equal(connectionTarget(rects,435,50,'source',check)?.id,'shot');
  assert.equal(connectionTarget(rects,460,50,'source',check)?.id,'picture');
  assert.equal(connectionTarget(rects,50,50,'source',check),null);
  assert.equal(connectionTarget(rects,270,50,'source',()=> '不支持'),null);
});

test('existing and persisted connections stay open and unfilled after native arrow normalization',()=>{
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const attrs={closed:true,fillEnabled:true,stroke:'#000000'};
  let points,draws=0,updates=0;
  const shape={setAttrs:value=>Object.assign(attrs,value),points:value=>{points=value;}};
  const nodes=[{id:'from'},{id:'to'}];
  const context=vm.createContext({canvas:{getState:()=>({nodes}),getNodeConfigById:()=>({}),updateNodes(){updates++;Object.assign(attrs,{closed:true,fillEnabled:true,stroke:'#000000'});}},
    mainLayer:{batchDraw(){draws++;}},edgeLinks:()=>[{id:'edge',from:'from',to:'to',style:'input'}],edgeStyles:{input:{stroke:'#6366f1'}},
    edgePointsFor:()=>[100,50,180,50,220,80,300,80],findLayerNode:()=>shape});
  vm.runInContext(source.slice(source.indexOf('  function renderEdges('),source.indexOf('  function scheduleEdgeRender(')),context);
  context.renderEdges(nodes);
  assert.equal(attrs.closed,false);assert.equal(attrs.fillEnabled,false);assert.equal(attrs.stroke,'#6366f1');
  context.renderEdges(nodes,true);
  assert.equal(attrs.closed,false);assert.equal(attrs.fillEnabled,false);assert.equal(attrs.stroke,'#6366f1');
  assert.equal(updates,1);assert.equal(draws,2);assert.equal(points.length,8);
  assert.equal(attrs.listening,true);assert.equal(attrs.draggable,false);
  assert.equal(attrs.hitStrokeWidth,14);
  context.canvas.getState=()=>({nodes,viewport:{scale:.25},selectedNodeIds:['edge']});
  context.edgeStyles.input.strokeWidth=2;
  context.renderEdges(nodes);
  assert.equal(attrs.hitStrokeWidth,56);
  assert.equal(attrs.stroke,'#4f46e5');assert.equal(attrs.strokeWidth,3.5);
  context.canvas.getState=()=>({nodes,viewport:{scale:2},selectedNodeIds:[]});
  context.renderEdges(nodes);
  assert.equal(attrs.hitStrokeWidth,7);
  assert.equal(attrs.stroke,'#6366f1');assert.equal(attrs.strokeWidth,2);
});

test('deleting selected input edges disconnects only those inputs',()=>{
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const state={links:[{id:'link-a--b',from:'a',to:'b'},{id:'link-c--b',from:'c',to:'b'}]};
  let dirty=0;
  const context=vm.createContext({workspace:()=>state,generationDraft:()=>null,removeLinks,bridge:{markCanvasDirty(){dirty++;}}});
  vm.runInContext(source.slice(source.indexOf('  function removeCanvasInputEdges('),source.indexOf('  function handleCanvasDeleteKeydown(')),context);
  assert.equal(context.removeCanvasInputEdges(['edge-link-a--b','a']),true);
  assert.deepEqual(state.links,[{id:'link-c--b',from:'c',to:'b'}]);
  assert.equal(context.removeCanvasInputEdges(['edge-result-a']),false);
  assert.equal(dirty,1);
});


test('connection plus follows a nearby pointer within a bounded distance and resets outside its reach',()=>{
  const rect={id:'a',left:100,top:100,width:200,height:120};
  const origin=magneticPortPosition(rect);
  assert.deepEqual(origin,{x:318,y:160});
  assert.deepEqual(magneticPortPosition(rect,origin),origin);
  const near={x:348,y:180},position=magneticPortPosition(rect,near);
  assert.ok(position.x>origin.x&&position.y>origin.y);
  assert.ok(Math.hypot(position.x-origin.x,position.y-origin.y)<=12);
  assert.deepEqual(magneticPortPosition(rect,{x:400,y:160}),origin);
  assert.deepEqual(magneticPortPosition(rect,{x:321,y:162}),{x:321,y:162});
});

test('connection plus detects the pointer outside its small visible circle without selecting an obscured node',()=>{
  const rect={id:'a',left:100,top:100,width:200,height:120};
  assert.equal(connectionSource([rect],{x:356,y:180},()=>true)?.id,'a');
  assert.equal(connectionSource([rect],{x:400,y:180},()=>true),null);
  assert.equal(connectionSource([rect],{x:350,y:160},()=>false),null);
  const obstruction={id:'blocked',left:340,top:140,width:100,height:100};
  assert.equal(connectionSource([rect,obstruction],{x:350,y:160},id=>id==='a'),null);
});

test('generated connections never open stroke controls, including mixed selections',()=>{
  const source=readFileSync(new URL('../scripts/director/reference-canvas/control/ColorAndStrokeWidthPanel.tsx',import.meta.url),'utf8');
  const start=source.indexOf('    const handleNodesSelected =');
  const handler=source.slice(start,source.indexOf("    api.on(",start))
    .replace('ids: string[]','ids').replace(/ as StrokeEditableConfig \| null/g,'');
  let selected=[];
  const context=vm.createContext({api:{getNodeConfigById:()=>({$_type:'arrow',$_strokeColor:'#000'})},
    setSelectedBrushIds:ids=>{selected=Array.from(ids);},setStrokeWidth(){},setStrokeColor(){},getDisplayStrokeWidth:()=>2});
  vm.runInContext(`${handler}\nglobalThis.select = handleNodesSelected;`,context);
  context.select(['drawing-arrow']);assert.deepEqual(selected,['drawing-arrow']);
  for(const ids of [['edge-link-a--b'],['edge-result-a'],['edge-shot'],['drawing-arrow','edge-link-a--b'],[]]){
    context.select(ids);assert.deepEqual(selected,[]);
  }
});
