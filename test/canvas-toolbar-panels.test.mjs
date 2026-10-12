import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const tools=read('scripts/director/reference-canvas/control/ToolsMenu.tsx');
const sheet=read('scripts/director/reference-canvas-shims/components/ui/shad/sheet.tsx');

test('retired precision tool has no toolbar entry, help entry, or bundled keyboard binding',()=>{
  assert.ok(!tools.includes('image-marker'));
  assert.ok(!tools.includes('shortcuts.precisionEdit'));
  const bundle=read('public/vendor/director/reference-canvas.js');
  assert.ok(!bundle.includes('i:"image-marker"'));
});

test('layer outside clicks close on capture while panel interactions and toolbar toggle stay open',()=>{
  const layer=read('scripts/director/reference-canvas/control/LayerPanel.tsx');
  const marker='        onInteractOutside={';
  const callback=layer.slice(layer.indexOf(marker)+marker.length,layer.indexOf('\n      >',layer.indexOf(marker))).trim().replace(/}$/, '');
  // Exercise the actual callbacks without mounting a client window.
  const handler=sheet.slice(sheet.indexOf('    const onPointerDown'),sheet.indexOf("    document.addEventListener('keydown'"));
  let closes=0;
  const context=vm.createContext({contentRef:{current:{contains:target=>target.inside}},setOpen:value=>{if(!value)closes++;}});
  vm.runInContext(stripTypeScriptTypes(`const onInteractOutside=${callback};\n${handler}\nglobalThis.click=onPointerDown;`),context);
  const event=(inside,toggle)=>({target:{inside,closest:()=>toggle},defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}});
  context.click(event(true,false));assert.equal(closes,0);
  context.click(event(false,false));assert.equal(closes,1);
  context.click(event(false,true));assert.equal(closes,1);
  assert.ok(sheet.includes("document.addEventListener('pointerdown', onPointerDown, true)"));
  assert.ok(sheet.includes("document.removeEventListener('pointerdown', onPointerDown, true)"));
});
