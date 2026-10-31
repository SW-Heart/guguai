import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {readDocument,validateAttachment,uploadAssistantImage,assistantAttachmentMessage} from '../public/features/assistant/attachments.js';
import {assistantInputDocument} from '../lib/agent/assistant-input.mjs';
const file=(name,bytes)=>new File([bytes],name);

test('text attachments decode UTF-8, UTF-16 and Chinese legacy files locally without network calls',async()=>{
  assert.equal(await readDocument(file('剧本.md','# 第一场\n对白：你好')),'# 第一场\n对白：你好');
  assert.equal(await readDocument(file('剧本.txt',new Uint8Array([0xff,0xfe,0x2d,0x4e,0x87,0x65]))),'中文');
  assert.equal(await readDocument(file('剧本.csv',new Uint8Array([0xd6,0xd0,0xce,0xc4]))),'中文');
  await assert.rejects(readDocument(file('empty.txt','  ')),/没有读到文字/);
  assert.throws(()=>validateAttachment({name:'app.exe',size:20}),/支持/);
  assert.throws(()=>validateAttachment({name:'huge.pdf',size:16*1024*1024}),/15 MB/);
  await assert.rejects(readDocument(file('huge.txt','x'.repeat(300001))),/文字内容过长/);
});

test('bundled Word reader extracts actual DOCX paragraphs as plain text',async()=>{
  const require=createRequire(import.meta.url),JSZip=createRequire(require.resolve('mammoth'))('jszip');
  const zip=new JSZip();
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一场：你好 &amp; 世界</w:t></w:r></w:p><w:p><w:r><w:t>第二场</w:t></w:r></w:p></w:body></w:document>');
  const bytes=await zip.generateAsync({type:'uint8array'});
  const loadWord=()=>import('../public/vendor/documents/word.js');
  assert.equal(await readDocument(file('剧本.docx',bytes),{loadWord}),'第一场：你好 & 世界\n\n第二场');
  await assert.rejects(readDocument(file('坏文件.docx','bad zip'),{loadWord}),/无法读取这份 Word/);
});

test('PDF extraction keeps page separation, releases readers and reports encrypted or scanned documents',async()=>{
  let destroyed=0,cleaned=0;
  const options={loadPdf:async()=>({GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({numPages:2,getPage:async page=>({getTextContent:async()=>({items:[{str:`第 ${page} 页`,hasEOL:true}]}),cleanup(){cleaned++;}})}),destroy:async()=>destroyed++})})};
  assert.equal(await readDocument(file('正文.pdf','pdf'),options),'第 1 页\n\n\n第 2 页');assert.equal(destroyed,1);assert.equal(cleaned,2);
  const failure=error=>({loadPdf:async()=>({GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.reject(error),destroy:async()=>destroyed++})})});
  await assert.rejects(readDocument(file('加密.pdf','pdf'),failure({name:'PasswordException'})),/已加密/);
  await assert.rejects(readDocument(file('损坏.pdf','pdf'),failure(new Error('internal parser error'))),/无法读取这份 PDF/);
  assert.equal(destroyed,3);
});

test('images use the existing authenticated upload flow and retain the actual returned asset ID',async()=>{
  const calls=[],image=file('画面.png','image'),asset={id:'image-a',kind:'image'};
  const api=async(path,options)=>{calls.push([path,options]);return path.endsWith('/init')?{uploadId:'upload-a',uploadUrl:'https://storage.example/upload',headers:{'Content-Type':'image/png'}}:asset;};
  assert.deepEqual(await uploadAssistantImage(image,api,{fetchImpl:async(url,options)=>{assert.equal(url,'https://storage.example/upload');assert.equal(options.body,image);return {ok:true};}}),asset);
  assert.equal(JSON.parse(calls[0][1].body).mimeType,'image/png');assert.equal(calls[1][0],'/api/files/uploads/upload-a/complete');
  assert.deepEqual(await uploadAssistantImage(image,async()=>({asset}),{fetchImpl:()=>assert.fail('reused files need no upload')}),asset);
  await assert.rejects(uploadAssistantImage(image,api,{fetchImpl:async()=>({ok:false})}),/上传失败/);
});

test('attachments stay associated with their user turn and reach the model as image parts and document text',async()=>{
  const payload=assistantAttachmentMessage('',[{kind:'image',name:'参考.png',asset:{id:'image-a'}},{kind:'document',name:'剧本.txt',text:'第一场：重逢'}]);
  assert.deepEqual(payload.selection,['image-a']);assert.deepEqual(payload.documents,[{title:'剧本.txt',text:'第一场：重逢'}]);
  const doc={messages:[{role:'user',content:payload.text,attachmentIds:['image-a'],documentIds:['doc-a']},{role:'assistant',content:'已阅读'},{role:'user',content:'继续分析'}],documents:[{id:'doc-a',title:'剧本.txt',text:'第一场：重逢'},{id:'other',title:'剧本.txt',text:'另一条消息'}]};
  const result=await assistantInputDocument({doc},{images:async(_s,options)=>{assert.deepEqual(options,{ids:['image-a'],detail:'auto',includeFrames:false});return [{type:'image_url',image_url:{url:'data:image/png;base64,AA==',detail:'auto'}}];}});
  assert.match(result.messages[0].content[0].text,/第一场：重逢/);assert.doesNotMatch(result.messages[0].content[0].text,/另一条消息/);
  assert.equal(result.messages[0].content[1].type,'image_url');assert.equal(result.messages[2].content,'继续分析');assert.ok(!('attachmentIds' in result.messages[0]));
  assert.equal(doc.messages[0].content,payload.text,'durable history keeps references, not image bytes');
  const compacted=await assistantInputDocument({doc:{...doc,compaction:{through:2}}},{images:()=>assert.fail('compacted images should not be loaded')});assert.equal(compacted.messages[0].content,payload.text);
});

test('upload action stays left while model selection and sending share the right side; all entry versions match',async()=>{
  const {renderAssistantShell}=await import('../public/features/assistant/presentation.js');
  const html=renderAssistantShell();assert.match(html,/assistant-composer-actions[\s\S]*data-upload[\s\S]*assistant-composer-right[\s\S]*data-model-trigger[\s\S]*data-send/);
  for(const [path,urls] of [['public/index.html',['/app.js?v=635']],['public/app.js',['features/assistant/workspace.js?v=17','features/assistant/workspace.css?v=14']],['public/features/assistant/workspace.js',['./attachments.js?v=1','./conversation.js?v=4','./presentation.js?v=8','./model-picker.js?v=8','attachment-preview.js?v=5']],['public/features/assistant/model-picker.js',['./presentation.js?v=8']],['public/features/assistant/attachments.js',['pdf.js?v=1','pdf.worker.js?v=1','./word-reader.js?v=1']],['public/features/assistant/word-reader.js',['word.worker.js?v=1']]]){
    const source=await readFile(new URL(`../${path}`,import.meta.url),'utf8');for(const url of urls)assert.ok(source.includes(url),`${path}: ${url}`);
  }
});

test('bundled PDF parser and worker read a real PDF without uploading it',async t=>{
  const require=createRequire(import.meta.url),canvas=require('@napi-rs/canvas');
  for(const name of ['DOMMatrix','ImageData','Path2D']){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value:canvas[name]});t.after(()=>{if(old)Object.defineProperty(globalThis,name,old);else delete globalThis[name];});}
  const pdfjs=await import('../public/vendor/documents/pdf.js');
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('../public/vendor/documents/pdf.worker.js',import.meta.url).href;
  const stream='BT /F1 12 Tf 20 60 Td (Hello screenplay) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let source='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(source.length);source+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=source.length;source+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const text=await readDocument(file('script.pdf',source),{loadPdf:async()=>({getDocument:options=>pdfjs.getDocument({...options,standardFontDataUrl:new URL('../public/vendor/documents/standard_fonts/',import.meta.url).href}),GlobalWorkerOptions:{}})});
  assert.equal(text,'Hello screenplay');
});
