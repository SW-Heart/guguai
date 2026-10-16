import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
function fixture(){
  const events=()=>({handlers:new Map(),addEventListener(type,fn){const set=this.handlers.get(type)||new Set();set.add(fn);this.handlers.set(type,set);},removeEventListener(type,fn){this.handlers.get(type)?.delete(fn);},emit(type,event){for(const fn of [...this.handlers.get(type)||[]])fn(event);}});
  const document=events(),window=Object.assign(events(),{innerWidth:1000,innerHeight:700});
  const created=[],menus=[];
  const trigger={expanded:'false',setAttribute(key,value){if(key==='aria-expanded')this.expanded=value;},contains(target){return target===this;},focus(){document.activeElement=this;}};
  document.createElement=()=>{
    const menu=Object.assign(events(),{style:{},offsetWidth:180,offsetHeight:320,setAttribute(){},remove(){this.removed=true;},contains(target){return target===this||this.buttons.includes(target);},querySelector(){return this.buttons[0];},querySelectorAll(){return this.buttons;}});
    Object.defineProperty(menu,'innerHTML',{set(html){this.buttons=[...html.matchAll(/data-create-kind="(.*?)"/g)].map(match=>({dataset:{createKind:match[1]},closest(){return this;},focus(){document.activeElement=this;}}));}});
    menus.push(menu);return menu;
  };
  document.body={append(){}};
  const context=vm.createContext({canvas:{},linkPopup:null,document,window,canvasIcon:()=>'',escape:String,createCanvasNode:(kind,options)=>created.push({kind,options})});
  vm.runInContext(source.slice(source.indexOf('  const createOptions='),source.indexOf('  // Dropping a link on empty canvas')),context);
  const open=()=>{context.showCreateMenu({anchor:{left:200,top:630}},{label:'创建节点',trigger});return menus.at(-1);};
  return {context,document,window,trigger,created,open};
}

test('the unified menu opens upward and creates each of the nine node types once',()=>{
  const f=fixture(),kinds=['script','text','character','location','prop','shot','image','video','audio'];
  for(const kind of kinds){
    const menu=f.open();
    assert.deepEqual(menu.buttons.map(button=>button.dataset.createKind),kinds);
    assert.equal(menu.style.top,'302px');
    assert.equal(f.trigger.expanded,'true');
    menu.emit('click',{target:menu.buttons.find(button=>button.dataset.createKind===kind)});
    assert.equal(menu.removed,true);assert.equal(f.trigger.expanded,'false');
    assert.equal(f.context.linkPopup,null);
  }
  assert.deepEqual(f.created.map(item=>item.kind),kinds);
  assert.ok(f.created.every(item=>item.options.at===null&&item.options.from===''));
});

test('keyboard navigation wraps and Escape restores focus without creating a node',()=>{
  const f=fixture(),menu=f.open();
  const key=value=>f.document.emit('keydown',{key:value,preventDefault(){}});
  assert.equal(f.document.activeElement,menu.buttons[0]);
  key('ArrowUp');assert.equal(f.document.activeElement,menu.buttons.at(-1));
  key('ArrowDown');assert.equal(f.document.activeElement,menu.buttons[0]);
  key('Escape');assert.equal(f.document.activeElement,f.trigger);
  assert.equal(f.trigger.expanded,'false');assert.equal(f.created.length,0);
  assert.equal(f.document.handlers.get('keydown').size,0);
  assert.equal(f.window.handlers.get('resize').size,0);
});

test('trigger interactions allow toggling; outside clicks, resize and replacement dismiss cleanly',()=>{
  const f=fixture();let menu=f.open();
  f.document.emit('pointerdown',{target:f.trigger});assert.ok(!menu.removed);
  f.context.linkPopup.dismiss();assert.equal(menu.removed,true);
  menu=f.open();f.document.emit('pointerdown',{target:{}});assert.equal(menu.removed,true);
  menu=f.open();f.window.emit('resize',{});assert.equal(menu.removed,true);
  const old=f.open();menu=f.open();assert.equal(old.removed,true);
  assert.equal(f.document.handlers.get('pointerdown').size,1);
  menu.dismiss();assert.equal(f.document.handlers.get('pointerdown').size,0);
  assert.equal(f.trigger.expanded,'false');assert.equal(f.created.length,0);
});
