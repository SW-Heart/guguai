import test from 'node:test';
import assert from 'node:assert/strict';
import { createCenterMorphDialog } from '../public/features/drama/prompt-optimization.js';

function fixture(t, reduce = false) {
  const attrs = new Map([['aria-haspopup', 'dialog']]);
  const trigger = { isConnected:true, focusCalls:0, focus() { this.focusCalls++; },
    getAttribute:name => attrs.get(name), setAttribute:(name,value) => attrs.set(name,value), removeAttribute:name => attrs.delete(name) };
  const doc = { body:{style:{overflow:'auto'}}, activeElement:trigger };
  for (const [key,value] of Object.entries({document:doc,matchMedia:() => ({matches:reduce}),getComputedStyle:() => ({clipPath:'inset(20% 20% 20% 20% round 30px)',opacity:'1'})})) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
    t.after(() => { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; });
  }
  function makeDialog(id) {
    const events = new Map(), classes = new Set(), animations = [];
    const surface = { inert:false, animate(frames,options) {
      let resolve, reject;
      const item = {frames,options,finished:new Promise((yes,no) => {resolve=yes;reject=no;}),finish:() => resolve(),cancel:() => reject(new Error('cancelled'))};
      animations.push(item); return item;
    } };
    const dialog = {id,open:false,classList:{add:(...names) => names.forEach(name => classes.add(name)),remove:(...names) => names.forEach(name => classes.delete(name))},
      querySelector:() => surface, addEventListener:(name,callback) => events.set(name,callback),
      showModal() { this.open = true; }, close() { this.open = false; },
      getBoundingClientRect:() => ({left:100,top:100,right:900,bottom:700}),
      emit(name,event = {}) { events.get(name)?.(event); } };
    return {dialog,surface,animations,classes};
  }
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
  return {doc,trigger,attrs,makeDialog,tick};
}

test('closing waits for the fold, disables content, restores scroll and trigger, and cleans up once', async t => {
  const f = fixture(t), d = f.makeDialog('optimization'); let closed = 0;
  const modal = createCenterMorphDialog(d.dialog,{onClosed:() => closed++});
  modal.show();
  assert.equal(f.doc.body.style.overflow,'hidden');
  assert.equal(f.attrs.get('aria-expanded'),'true');
  assert.equal(f.attrs.get('aria-controls'),'optimization');
  modal.close();
  assert.equal(d.dialog.open,true); assert.equal(d.surface.inert,true);
  assert.equal(d.animations[1].frames[0].clipPath,'inset(20% 20% 20% 20% round 30px)');
  d.animations[1].finish(); await f.tick();
  assert.equal(d.dialog.open,false); assert.equal(f.doc.body.style.overflow,'auto');
  assert.equal(f.attrs.get('aria-expanded'),'false'); assert.equal(f.attrs.has('aria-controls'),false);
  assert.equal(f.trigger.focusCalls,1); assert.equal(closed,1);
  d.dialog.emit('close'); assert.equal(closed,1);
});

test('reopening invalidates a queued exit completion and keeps the new modal open', async t => {
  const f = fixture(t), d = f.makeDialog('optimization');
  const modal = createCenterMorphDialog(d.dialog);
  modal.show(); modal.close(); d.animations[1].finish();
  modal.show(); await f.tick();
  assert.equal(d.dialog.open,true); assert.equal(d.surface.inert,false);
  assert.equal(f.doc.body.style.overflow,'hidden'); assert.equal(f.attrs.get('aria-expanded'),'true');
  d.dialog.emit('close'); assert.equal(d.dialog.open,true);
  d.animations[2].finish(); await f.tick(); assert.equal(d.classes.size,0);
  modal.close({immediate:true}); assert.equal(f.doc.body.style.overflow,'auto');
});

test('nested dialogs retain the scroll lock until the outer dialog closes', t => {
  const f = fixture(t), first = f.makeDialog('optimization'), second = f.makeDialog('direction');
  const main = createCenterMorphDialog(first.dialog), child = createCenterMorphDialog(second.dialog);
  main.show(); child.show(); child.close({immediate:true});
  assert.equal(f.doc.body.style.overflow,'hidden'); assert.equal(first.dialog.open,true);
  main.close({immediate:true}); assert.equal(f.doc.body.style.overflow,'auto');
});

test('Escape and backdrop dismissal obey save guard and do not dismiss after a drag from the content', t => {
  const f = fixture(t), d = f.makeDialog('optimization'); let saving = true, dismissals = 0, prevented = 0;
  const modal = createCenterMorphDialog(d.dialog,{canDismiss:() => !saving,onDismiss:() => dismissals++});
  modal.show();
  d.dialog.emit('cancel',{preventDefault:() => prevented++}); assert.equal(prevented,1); assert.equal(dismissals,0);
  const outside = {target:d.dialog,clientX:20,clientY:20};
  d.dialog.emit('pointerdown',outside); d.dialog.emit('click',outside); assert.equal(dismissals,0);
  saving = false;
  d.dialog.emit('pointerdown',{target:d.surface,clientX:200,clientY:200}); d.dialog.emit('click',outside); assert.equal(dismissals,0);
  d.dialog.emit('pointerdown',outside); d.dialog.emit('click',outside); assert.equal(dismissals,1);
  d.dialog.emit('cancel',{preventDefault() {}}); assert.equal(dismissals,2);
  modal.close({immediate:true});
});

test('reduced motion uses short fades without clipping and missing animation support still closes', async t => {
  const f = fixture(t,true), d = f.makeDialog('optimization');
  const modal = createCenterMorphDialog(d.dialog);
  modal.show(); assert.deepEqual(d.animations[0].frames,[{opacity:0},{opacity:1}]); assert.equal(d.animations[0].options.duration,140);
  d.animations[0].finish(); await f.tick(); modal.close();
  assert.equal('clipPath' in d.animations[1].frames[1],false);
  d.animations[1].finish(); await f.tick(); assert.equal(d.dialog.open,false);
  delete d.surface.animate;
  modal.show(); modal.close(); assert.equal(d.dialog.open,false); assert.equal(f.doc.body.style.overflow,'auto');
});
