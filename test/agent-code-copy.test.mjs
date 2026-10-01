import test from 'node:test';
import assert from 'node:assert/strict';
import {mountContentCopy,patchCodeBlock} from '../public/features/agent/code-block.js';

function harness() {
  let listener;
  const root={contains:button=>button.inside!==false,addEventListener:(_,callback)=>{listener=callback;},removeEventListener:()=>{listener=null;}};
  const button=(kind,source)=>{
    const attributes=new Map([[kind,''],['aria-label','复制内容']]);
    const classes=new Set();
    return {source,isConnected:true,innerHTML:'<svg></svg><span data-copy-label>复制</span>',title:'复制内容',
      getAttribute:key=>attributes.get(key),setAttribute:(key,value)=>attributes.set(key,value),hasAttribute:key=>attributes.has(key),
      classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),contains:key=>classes.has(key)},
      closest(selector){if(selector==='.agent-code-block')return {querySelector:()=>({textContent:this.source})};if(selector==='.dw-inspector')return {querySelector:()=>({value:this.source})};return {dataset:{copyText:this.source}};},
    };
  };
  return {root,button,click:async button=>{await listener?.({target:{closest:()=>button},preventDefault(){}});}};
}
function replaceGlobal(t,key,value) {
  const original=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  t.after(()=>{if(original)Object.defineProperty(globalThis,key,original);else delete globalThis[key];});
}

test('streaming patches retain the copy button and only follow scrolling when the reader is at the end',()=>{
  const code={textContent:'a'.repeat(500)},copyButton={feedback:'已复制'};
  let top=50;
  const viewport={clientHeight:280,get scrollHeight(){return code.textContent.length;},get scrollTop(){return top;},set scrollTop(value){top=Math.min(value,this.scrollHeight-this.clientHeight);}};
  const fields={'code':code,'.agent-code-lines':{textContent:'1'},'.agent-code-name':{textContent:'js'},'.agent-code-status':{textContent:'正在生成'},'.agent-code-viewport':viewport,'[data-code-copy]':copyButton};
  const current={classList:{contains:()=>true},dataset:{state:'streaming'},querySelector:selector=>fields[selector],setAttribute(){}};
  const next=text=>({classList:{contains:()=>true},dataset:{state:'streaming'},querySelector:selector=>selector==='code'?{textContent:text}:fields[selector],getAttribute:()=> 'true'});
  assert.ok(patchCodeBlock(current,next('b'.repeat(600))));
  assert.equal(code.textContent,'b'.repeat(600));
  assert.equal(viewport.scrollTop,50);
  assert.equal(current.querySelector('[data-code-copy]'),copyButton);
  assert.equal(copyButton.feedback,'已复制');
  viewport.scrollTop=320;
  patchCodeBlock(current,next('c'.repeat(700)));
  assert.equal(viewport.scrollTop,420);
  assert.equal(patchCodeBlock(null,next('code')),false);
});

test('copies exact code, current streaming content, Markdown documents and full replies independently',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const written=[];
  replaceGlobal(t,'navigator',{clipboard:{writeText:async text=>{written.push(text);}}});
  const h=harness(),controller=new AbortController();
  const errors=[];
  mountContentCopy(h.root,{signal:controller.signal,onError:error=>errors.push(error)});
  t.after(()=>controller.abort());
  const code=h.button('data-code-copy','  const html = "<div>&</div>";\n\n\t结束\n');
  const second=h.button('data-code-copy','其他代码');
  await h.click(code);
  assert.equal(written[0],code.source);
  assert.equal(code.getAttribute('aria-label'),'已复制');
  assert.equal(second.getAttribute('aria-label'),'复制内容');
  code.source+='最新一行';
  await h.click(code);
  assert.equal(written[1],code.source);
  t.mock.timers.tick(1600);
  assert.equal(code.getAttribute('aria-label'),'复制内容');
  assert.equal(code.classList.contains('is-copied'),false);
  const doc=h.button('data-doc-copy','# 说明\n\n**重点**\n- 第一项\n');
  const reply=h.button('data-response-action','回复\n\n```js\n代码\n```');
  await h.click(doc);await h.click(reply);await h.click(second);
  assert.deepEqual(written.slice(2),[doc.source,reply.source,second.source]);
  assert.deepEqual(errors,[]);
});

test('denied clipboard access gives failure feedback and allows retry',async t=>{
  let denied=true;
  replaceGlobal(t,'navigator',{clipboard:{writeText:async()=>{if(denied)throw new Error('Denied');}}});
  const h=harness(),errors=[],copy=mountContentCopy(h.root,{onError:error=>errors.push(error)});
  t.after(()=>copy.destroy());
  const button=h.button('data-code-copy','code'),original=button.innerHTML;
  await h.click(button);
  assert.deepEqual(errors,['复制失败，请重试']);
  assert.equal(button.innerHTML,original);
  assert.equal(button.getAttribute('aria-label'),'复制内容');
  denied=false;await h.click(button);
  assert.equal(button.getAttribute('aria-label'),'已复制');
});

test('pending copy runs once and is cancelled cleanly when the workspace unmounts',async t=>{
  let finish,calls=0;
  replaceGlobal(t,'navigator',{clipboard:{writeText:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}}});
  const h=harness(),controller=new AbortController(),errors=[];
  mountContentCopy(h.root,{signal:controller.signal,onError:error=>errors.push(error)});
  const button=h.button('data-code-copy','draft'),original=button.innerHTML;
  const pending=h.click(button);await h.click(button);
  assert.equal(calls,1);
  controller.abort();finish();await pending;
  assert.equal(button.innerHTML,original);
  assert.equal(button.getAttribute('aria-label'),'复制内容');
  assert.deepEqual(errors,[]);
});

test('without the Clipboard API, copies through a temporary selection and reports actual success',async t=>{
  replaceGlobal(t,'navigator',{});
  let selected=false,removed=false,focused=false,copiedText='',allowed=true;
  replaceGlobal(t,'document',{
    activeElement:{focus:()=>{focused=true;}},
    createElement:()=>({style:{},setAttribute(){},select(){selected=true;copiedText=this.value;},remove(){removed=true;}}),
    body:{append(){}},execCommand:command=>{assert.equal(command,'copy');return allowed;},
  });
  const h=harness(),errors=[],copy=mountContentCopy(h.root,{onError:error=>errors.push(error)});
  t.after(()=>copy.destroy());
  const button=h.button('data-doc-copy','# 原始文稿\n\n空行和缩进\n  保留');
  await h.click(button);
  assert.equal(copiedText,button.source);
  assert.ok(selected&&removed&&focused);
  assert.equal(button.getAttribute('aria-label'),'已复制');
  allowed=false;await h.click(button);
  assert.deepEqual(errors,['复制失败，请重试']);
  assert.equal(button.getAttribute('aria-label'),'复制内容');
});
