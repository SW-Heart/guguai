import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generationVisualStates,generationFrameState,renderGenerationPlaceholder} from '../public/features/drama/generation-status.js';

test('every canvas generation state has a distinct visible status treatment',()=>{
  assert.deepEqual(generationVisualStates,[
    'draft','submitting','waiting_approval','queued','running',
    'processing','saving','completed','failed','cancelled',
  ]);
  const expected=['等待生成','正在开始','等待确认','排队中','正在生成','正在处理','正在准备文件','已完成','生成失败','已取消'];
  for(const [index,state] of generationVisualStates.entries()){
    const html=renderGenerationPlaceholder(state,{progress:60});
    assert.match(html,new RegExp(`data-phase="${state}"`));
    assert.ok(html.includes(expected[index]));
    assert.match(html,/<svg[^>]*aria-hidden="true"/);
    if(['running','processing','saving'].includes(state))assert.match(html,/value="60"/);
    else assert.doesNotMatch(html,/<progress/);
  }
  const cancelled=renderGenerationPlaceholder('cancelled',{progress:90});
  assert.match(cancelled,/已取消/);
  assert.doesNotMatch(cancelled,/dw-frame-pulse|<progress/);
  assert.notEqual(cancelled,renderGenerationPlaceholder('failed',{progress:90}));
  assert.equal(generationFrameState('cancelled'),'cancelled');
  assert.equal(generationFrameState('completed'),'saving');
  assert.equal(generationFrameState('failed',true),'completed');
  assert.equal(generationFrameState('unexpected'),'queued');
});

test('manual and agent frames share the status treatment and completed media stays unframed',()=>{
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.equal(source.match(/renderGenerationPlaceholder\(state,/g)?.length,2);
  for(const state of generationVisualStates.filter(state=>state!=='completed'))assert.ok(css.includes(`[data-state=${state}]`),state);
  assert.match(css,/\.dw-generation-frame\[data-state=completed\]\{overflow:visible;border:0/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.dw-frame-state-icon svg/);
});

test('busy phases without a measured value show a moving track instead of a number',()=>{
  for(const state of ['submitting','running','processing','saving']){
    const html=renderGenerationPlaceholder(state);
    assert.match(html,/class="dw-frame-meter"/,state);
    assert.doesNotMatch(html,/<progress|%<\/span>/,state);
  }
  for(const state of ['draft','waiting_approval','queued','failed','cancelled'])assert.doesNotMatch(renderGenerationPlaceholder(state,{progress:40}),/dw-frame-meter|<progress/,state);
  const running=renderGenerationPlaceholder('running',{progress:30});
  assert.match(running,/<span class="dw-frame-progress-label">30%<\/span>/);
  assert.doesNotMatch(running,/dw-frame-meter/);
  assert.equal(renderGenerationPlaceholder('running',{progress:100}).match(/value="(\d+)"/)[1],'99');
  assert.notEqual(renderGenerationPlaceholder('draft',{kind:'video'}),renderGenerationPlaceholder('draft',{kind:'image'}));
});

test('canvas cards share status tones and the redesigned modules are cache-busted',()=>{
  const read=path=>readFileSync(new URL(`../public/${path}`,import.meta.url),'utf8');
  const source=read('features/drama/director-workspace.js');
  const css=read('styles.css');
  assert.ok(source.includes("./generation-status.js?v=2"));
  assert.ok(source.includes("./canvas-icons.js?v=1"));
  assert.ok(read('features/drama/generation-status.js').includes("./canvas-icons.js?v=1"));
  for(const tone of ['waiting','active','done','danger','locked'])assert.ok(css.includes(`[data-tone=${tone}]`),tone);
  assert.match(source,/data-tone="\$\{tone\}"/);
  assert.match(source,/class="dw-node-progress"/);
  assert.match(css,/\.dw-frame-caption\{position:absolute;left:0;right:0;top:auto;bottom:calc\(100% \+ 6px\)/);
  assert.ok(Number(read('index.html').match(/\/styles\.css\?v=(\d+)\b/)?.[1])>=340);
  assert.ok(Number(read('index.html').match(/\/app\.js\?v=(\d+)\b/)?.[1])>=454);
  assert.ok(read('app.js').includes("./drama-studio.js?v=225"));
  assert.ok(read('app.js').includes("./features/agent/workspace.js?v=89"));
  assert.ok(read('drama-studio.js').includes("./features/drama/director-workspace.js?v=125"));
  assert.ok(read('features/agent/workspace.js').includes("../drama/director-workspace.js?v=125"));
});
