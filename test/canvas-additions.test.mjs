import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {placeCanvasNodes,focusCanvasViewport} from '../public/features/drama/canvas-layout.js';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
function fixture(){
  let items=[],nodes=[],saves=0,views=[];const frames=[];
  const saved={positions:{},generationDrafts:[]};
  const canvas={getState:()=>({nodes,viewport:{x:0,y:0,scale:1}}),getContainer:()=>({clientWidth:1000,clientHeight:700}),
    createNodes(created){nodes.push(...created);context.handleCreatedCanvasNodes(created);},
    deleteNodes(ids){nodes=nodes.filter(node=>!ids.includes(node.id));},
    updateNodes(ids,attrs){nodes.forEach(node=>{if(ids.includes(node.id))Object.assign(node,attrs);});},
    updateViewport(value){views.push(value);},
    getNodeConfigById:id=>nodes.find(node=>node.id===id),
  };
  const context=vm.createContext({canvas,bridge:{agentMode:true,media:()=>null},epoch:1,chatMode:'side',agentReady:true,syncing:false,canvasContentReady:false,
    seenCanvasNodeIds:new Set(),pendingCanvasFocus:new Set(),automaticImageSizing:new Set(),canvasFocusFrame:0,saveTimer:0,
    placeCanvasNodes,focusCanvasViewport,workspace:()=>saved,liveCanvasNodes:()=>nodes,canvasItems:()=>items,position:node=>saved.positions[node.id]||{},
    canvasItemSize:node=>({width:node.width||280,height:node.height||228}),nodeContent:node=>node.text||'',edgeLinks:()=>[],renderEdges(){},alignCard(){},alignCards(){},paintAssetImage(){},drawPanels(){},positionGenerationComposer(){},
    queueWorkspaceFrame:fn=>{frames.push(fn);return frames.length;},clearTimeout(){},setTimeout:()=>1,
    save:async()=>{saves++;},scheduleCanvasSave:()=>saves++,persistLiveCanvasState(){},
  });
  const helpers=source.slice(source.indexOf('  function canvasView('),source.indexOf('  function canvasItemSize('));
  vm.runInContext(helpers,context);
  vm.runInContext(source.slice(source.indexOf('  function syncCanvas('),source.indexOf('  function syncEdges(')),context);
  return {context,canvas,saved,get nodes(){return nodes;},get views(){return views;},get saves(){return saves;},items:value=>{items=value;},flush(){while(frames.length)frames.shift()();}};
}

test('saved project hydration preserves its viewport, then new documents and placeholders focus once',()=>{
  const f=fixture();
  f.saved.positions.saved={x:2000,y:900,width:280,height:228};
  f.items([{id:'saved',kind:'document',text:'旧内容'}]);
  f.context.syncCanvas();f.flush();assert.equal(f.views.length,0);
  const savedPosition={...f.nodes[0]};
  f.items([{id:'saved',kind:'document',text:'旧内容'},{id:'document',kind:'document',text:'新内容'},{id:'generation',kind:'generation',text:'待生成',width:320,height:320}]);
  f.context.syncCanvas();f.flush();assert.equal(f.views.length,1);
  assert.equal(f.nodes[0].x,savedPosition.x);assert.equal(f.nodes[0].y,savedPosition.y);
  f.items([{id:'saved',kind:'document',text:'旧内容'},{id:'document',kind:'document',text:'新内容'},{id:'generation',kind:'generation',text:'生成中',width:320,height:320}]);
  f.context.syncCanvas();f.flush();assert.equal(f.views.length,1);
  assert.equal(f.context.syncing,false);
});

test('native pasted components avoid existing content and undo restoration does not steal focus',()=>{
  const f=fixture();f.context.canvasContentReady=true;
  const existing={id:'existing',x:400,y:200,width:320,height:320,$_type:'rect'};
  f.canvas.createNodes([existing]);f.flush();
  const old={x:existing.x,y:existing.y};
  const paste=[{id:'pasted-image',x:old.x,y:old.y,width:200,height:100,$_type:'image'},
    {id:'pasted-note',x:old.x,y:old.y,width:240,height:150,$_type:'rich-text'}];
  f.canvas.createNodes(paste);f.flush();
  assert.equal(existing.x,old.x);assert.equal(existing.y,old.y);
  for(const node of paste)assert.ok(node.x!==old.x||node.y!==old.y);
  const focused=f.views.length;
  f.canvas.deleteNodes(['pasted-note']);
  f.canvas.createNodes([paste[1]]);f.flush();assert.equal(f.views.length,focused);
});

test('multiple native additions in one frame share a single focus and a late focus cannot affect another project',()=>{
  const f=fixture();f.context.canvasContentReady=true;
  f.canvas.createNodes([{id:'one',width:200,height:100,$_type:'rect'}]);
  f.canvas.createNodes([{id:'two',width:300,height:200,$_type:'image'}]);
  f.flush();assert.equal(f.views.length,1);
  f.canvas.createNodes([{id:'three',width:300,height:200,$_type:'rect'}]);
  f.context.epoch++;f.flush();assert.equal(f.views.length,1);
});

test('focusing a newly added component opens the canvas from full conversation mode',()=>{
  const f=fixture();f.context.canvasContentReady=true;f.context.chatMode='full';
  f.canvas.createNodes([{id:'one',width:200,height:100,$_type:'rect'}]);f.flush();
  assert.equal(f.context.chatMode,'side');assert.equal(f.views.length,1);
});
