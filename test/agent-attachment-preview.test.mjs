import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {attachmentKind, attachmentSource, attachmentCardMarkup, attachmentDetailMarkup, mountAttachmentPreviews} from '../public/features/agent/attachment-preview.js';

test('files without MIME types retain previews and local library URLs take precedence', () => {
  for (const [name, kind] of [['photo.PNG','image'],['clip.mov','video'],['voice.m4a','audio'],['story.docx','document'],['archive.zip','file']]) {
    assert.equal(attachmentKind({name}), kind);
    const html = attachmentCardMarkup({key:name,name,url:'/file',text:kind === 'document' ? '故事开头' : ''});
    assert.ok(html.includes(`attachment-card--${kind}`));
    assert.ok(html.includes('aria-label="预览 '));
    assert.ok(html.includes('aria-label="移除 '));
  }
  assert.equal(attachmentKind({name:'audio.webm',type:'audio/webm'}), 'audio');
  assert.equal(attachmentSource({url:'gugu-media://local/one',previewUrl:'https://example.com/expired'}), 'gugu-media://local/one');
  assert.equal(attachmentSource({previewUrl:'blob:local',url:'https://example.com/image'}), 'blob:local');
  const image=attachmentCardMarkup({key:'image',name:'私密照片.png',kind:'image',previewUrl:'/image'});
  assert.ok(image.includes('<img src="/image"'));
  assert.ok(!image.includes('attachment-card-caption'));
  assert.ok(!image.includes('>私密照片.png<'));
});

test('media controls are operable in previews and document HTML remains inert text', () => {
  for (const kind of ['video','audio']) {
    const html = attachmentDetailMarkup({kind,name:'参考素材',url:'/media'});
    assert.ok(html.includes(`<${kind} src="/media" controls`));
    assert.ok(!html.includes('autoplay'));
  }
  const file = {key:'"<unsafe>', name:'<img src=x onerror=alert(1)>.txt', text:'<script>alert(1)</script>',url:'javascript:alert(1)'};
  const html = attachmentCardMarkup(file) + attachmentDetailMarkup(file);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(attachmentDetailMarkup({name:'readme.txt',status:'loading'}).includes('正在读取文件'));
  assert.ok(attachmentDetailMarkup({name:'archive.zip'}).includes('暂不支持内容预览'));
  assert.equal(attachmentSource({url:'data:text/html,<script>'}), '');
  assert.ok(!attachmentCardMarkup({key:'sent',name:'视频.mp4',removable:false}).includes('data-attachment-remove'));
  assert.ok(attachmentDetailMarkup({name:'已删除.mp4',status:'unavailable'}).includes('文件已不可用，请重新添加'));
});

test('a failed image preview retries the original image before showing an error', () => {
  const listeners={};
  const card={classList:{added:[],add(value){this.added.push(value);}}};
  const container={addEventListener:(type,listener)=>{listeners[type]=listener;}};
  const previews=mountAttachmentPreviews(container,{renderCards:false});
  previews.update([{key:'photo',kind:'image',name:'照片.png',previewUrl:'/preview',url:'/content'}]);
  const image={dataset:{},src:'/preview',hidden:false,matches:selector=>selector.split(',').includes('img'),getAttribute:()=>image.src,closest:selector=>selector==='[data-attachment-preview]'?{dataset:{attachmentPreview:'photo'}}:card};
  listeners.error({target:image});
  assert.equal(image.src,'/content');
  assert.equal(image.hidden,false);
  listeners.error({target:image});
  assert.equal(image.hidden,true);
  assert.deepEqual(card.classList.added,['has-media-error']);
});

test('polling preserves playback; removal, closing and disposal stop media and ignore stale updates', t => {
  const original = globalThis.document;
  function element() {
    const node = {listeners:{},open:false,isConnected:true,writes:0,pauses:0,loads:0,content:'',
      set innerHTML(value) {this.content=value;this.writes++;},get innerHTML() {return this.content;},
      addEventListener(type,fn,options={}) {(this.listeners[type] ||= []).push(fn);options.signal?.addEventListener('abort',()=>{this.listeners[type]=this.listeners[type].filter(item=>item!==fn);},{once:true});},
      emit(type,event={}) {for(const fn of this.listeners[type]||[])fn(event);},
      setAttribute(){},querySelectorAll(){return [{pause:()=>this.pauses++,removeAttribute(){},load:()=>this.loads++}];},
      replaceChildren(){this.content='';},showModal(){this.open=true;},close(){this.open=false;this.emit('close');},remove(){this.isConnected=false;},
    };return node;
  }
  const container=element(),dialog=element(),controller=new AbortController(),removed=[];
  globalThis.document={createElement:()=>dialog,body:{append(){}}};
  t.after(()=>{if(original===undefined)delete globalThis.document;else globalThis.document=original;});
  const previews=mountAttachmentPreviews(container,{signal:controller.signal,onRemove:file=>removed.push(file.key)});
  const file={key:'audio',kind:'audio',name:'音乐',url:'/audio',status:'ready'};
  const trigger={dataset:{attachmentPreview:'audio'},isConnected:true,focus(){this.focused=true;}};
  const click=(selector,target)=>container.emit('click',{target:{closest:query=>query===selector?target:null}});
  previews.update([file]);click('[data-attachment-preview]',trigger);
  assert.equal(dialog.open,true);
  const writes=dialog.writes,pauses=dialog.pauses,cardWrites=container.writes;
  previews.update([{...file}]);previews.update([{...file}]);
  assert.equal(dialog.writes,writes);assert.equal(dialog.pauses,pauses);assert.equal(container.writes,cardWrites);
  dialog.close();assert.equal(trigger.focused,true);assert.ok(dialog.pauses>pauses);
  previews.update([{...file,removeDisabled:true}]);
  click('[data-attachment-remove]',{dataset:{attachmentRemove:'audio'}});assert.deepEqual(removed,[]);
  previews.update([file]);click('[data-attachment-preview]',trigger);
  click('[data-attachment-remove]',{dataset:{attachmentRemove:'audio'}});
  assert.deepEqual(removed,['audio']);assert.equal(dialog.open,false);
  click('[data-attachment-preview]',trigger);previews.update([]);assert.equal(dialog.open,false);
  previews.update([file]);click('[data-attachment-preview]',trigger);controller.abort();
  assert.equal(dialog.open,false);assert.equal(dialog.isConnected,false);
  const before=container.innerHTML;previews.update([]);assert.equal(container.innerHTML,before);
  click('[data-attachment-preview]',trigger);assert.equal(dialog.open,false);
});

test('message preview registry does not replace conversation contents or expose remove actions', t => {
  const original=globalThis.document,controller=new AbortController();
  const listeners={},removed=[];
  const dialog={open:false,addEventListener(){},querySelectorAll:()=>[],setAttribute(){},showModal(){this.open=true;},close(){this.open=false;},remove(){}};
  const container={innerHTML:'消息正文',addEventListener:(type,fn)=>{listeners[type]=fn;}};
  globalThis.document={createElement:()=>dialog,body:{append(){}}};
  t.after(()=>{controller.abort();if(original===undefined)delete globalThis.document;else globalThis.document=original;});
  const previews=mountAttachmentPreviews(container,{signal:controller.signal,renderCards:false,onRemove:file=>removed.push(file)});
  previews.update([{key:'message:file',name:'参考视频.mp4',url:'/video',removable:false}]);
  assert.equal(container.innerHTML,'消息正文');
  const click=(selector,data)=>listeners.click({target:{closest:value=>value===selector?{dataset:data}:null}});
  click('[data-attachment-preview]',{attachmentPreview:'message:file'});
  assert.equal(dialog.open,true);assert.ok(dialog.innerHTML.includes('<video'));
  click('[data-attachment-remove]',{attachmentRemove:'message:file'});assert.equal(removed.length,0);
  previews.update([]);assert.equal(dialog.open,false);assert.equal(container.innerHTML,'消息正文');
});

test('sent message rendering places non-removable previews before text and retains them while streaming', () => {
  const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
  const element=()=>({children:[],setAttribute(){},replaceChildren(){this.children=[];},append(node){this.children.push(node);}});
  const context=vm.createContext({document:{createElement:element},attachmentCardMarkup});
  vm.runInContext(source.slice(source.indexOf('function messageAttachments('),source.indexOf('function createConversationWelcome(')),context);
  const content=element(),message={id:'input-1',role:'user',text:'修改这段视频',attachments:[{id:'video',kind:'video',name:'参考视频.mp4',url:'/video'}]};
  context.updateMessageContent(content,message.text,message.role,context.messageAttachments(message));
  const gallery=content.children[0];
  assert.equal(gallery.className,'dw-message-attachments attachment-strip');
  assert.ok(gallery.innerHTML.includes('<video'));
  assert.ok(!gallery.innerHTML.includes('data-attachment-remove'));
  assert.equal(content.children[1].textContent,message.text);
  context.updateMessageContent(content,message.text,message.role,context.messageAttachments(message));
  assert.equal(content.children[0],gallery);
  assert.equal(context.messageAttachments({id:'old',role:'user',images:[{id:'image',kind:'image',url:'/image'}]})[0].key,'old:image');
});

test('both composers put previews above text and all changed entry cache keys are connected', () => {
  const read=path=>readFileSync(new URL(`../public/${path}`,import.meta.url),'utf8');
  assert.match(read('features/agent/workspace.js'),/class="agent-entry-attachments attachment-strip"[^>]*><\/div><textarea id="agentEntryMessage"/);
  assert.match(read('features/drama/director-workspace.js'),/data-agent-attachments[^>]*><\/div><textarea id="directorMessage"/);
  for(const [path,urls] of [
    ['index.html',['/app.js?v=489','/styles.css?v=364']],
    ['app.js',['./features/agent/workspace.js?v=90','./drama-studio.js?v=226']],
    ['drama-studio.js',['./features/drama/director-workspace.js?v=126']],
    ['features/agent/workspace.js',['../drama/director-workspace.js?v=126','./attachment-preview.js?v=3']],
    ['features/drama/director-workspace.js',['../agent/attachment-preview.js?v=3']],
  ])for(const url of urls)assert.ok(read(path).includes(url),`${path}: ${url}`);
});
