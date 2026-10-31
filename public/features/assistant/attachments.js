export const attachmentAccept='.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.pdf,.docx';
export const maxAttachments=10;
const imageTypes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};
export function validateAttachment(file){
  const extension=String(file.name||'').split('.').pop().toLowerCase();
  const kind=imageTypes[extension]?'image':'document';
  if(!attachmentAccept.split(',').includes(`.${extension}`))throw new Error('支持 PNG、JPEG、WebP 图片，以及 TXT、Markdown、CSV、JSON、PDF、Word 文档');
  const limit=kind==='image'?20:15;
  if(!file.size)throw new Error('文件为空');
  if(file.size>limit*1024*1024)throw new Error(`文件不能超过 ${limit} MB`);
  return {kind,extension,mimeType:imageTypes[extension]};
}
export function validateDocumentText(value){
  const text=String(value||'').replace(/\u0000/g,'').trim();
  if(!text)throw new Error('没有读到文字，请使用包含文字的文件；扫描件可作为图片添加');
  if(text.length>300_000)throw new Error('文字内容过长，请拆分文件后添加');
  return text;
}
export async function readDocument(file,{loadPdf=()=>import('../../vendor/documents/pdf.js?v=1'),loadWord=()=>import('./word-reader.js?v=1')}={}){
  const {extension,kind}=validateAttachment(file);
  if(kind!=='document')throw new Error('请选择文档');
  if(extension==='pdf'){
    const pdfjs=await loadPdf();pdfjs.GlobalWorkerOptions.workerSrc='/vendor/documents/pdf.worker.js?v=1';
    const task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true,cMapUrl:'/vendor/documents/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/documents/standard_fonts/'});
    try{
      const pdf=await task.promise;
      if(pdf.numPages>500)throw new Error('PDF 不能超过 500 页，请拆分后添加');
      const pages=[];let length=0;
      for(let i=1;i<=pdf.numPages;i++){
        const page=await pdf.getPage(i),content=await page.getTextContent();
        const text=content.items.map(item=>(item.str||'')+(item.hasEOL?'\n':' ')).join('');
        length+=text.length;if(length>300_000)throw new Error('文字内容过长，请拆分文件后添加');
        pages.push(text);page.cleanup();
      }
      return validateDocumentText(pages.join('\n\n'));
    }catch(error){if(error.name==='PasswordException')throw new Error('PDF 已加密，请解密后重新添加');if(/^(PDF 不能|文字内容|没有读到)/.test(error.message))throw error;throw new Error('无法读取这份 PDF，请确认文件未损坏后重试');}
    finally{await task.destroy();}
  }
  if(extension==='docx'){
    let result;
    try{const mammoth=await loadWord();result=await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()});}
    catch{throw new Error('无法读取这份 Word 文档，请确认文件未损坏后重试');}
    return validateDocumentText(result.value);
  }
  const bytes=new Uint8Array(await file.arrayBuffer());
  let text;
  if(bytes[0]===0xff&&bytes[1]===0xfe)text=new TextDecoder('utf-16le').decode(bytes);
  else if(bytes[0]===0xfe&&bytes[1]===0xff)text=new TextDecoder('utf-16be').decode(bytes);
  else{try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('gb18030').decode(bytes);}}
  return validateDocumentText(text);
}
export async function uploadAssistantImage(file,api,{fetchImpl=fetch,signal}={}){
  const {kind,mimeType}=validateAttachment(file);
  if(kind!=='image')throw new Error('请选择图片');
  const intent=await api('/api/files/uploads/init',{method:'POST',body:JSON.stringify({name:file.name,size:file.size,mimeType}),signal});
  if(intent.asset)return intent.asset;
  const response=await fetchImpl(intent.uploadUrl,{method:'PUT',headers:intent.headers||{},body:file,signal});
  if(!response.ok)throw new Error('图片上传失败，请重试');
  return api(`/api/files/uploads/${encodeURIComponent(intent.uploadId)}/complete`,{method:'POST',body:'{}',signal});
}
export function assistantAttachmentMessage(text,files){
  const images=files.filter(file=>file.kind==='image'),documents=files.filter(file=>file.kind==='document');
  return {text:(text||'请查看这些附件。')+(images.length?'\n\n附件：\n'+images.map(file=>`${file.name}（素材 ID：${file.asset.id}）`).join('\n'):'')+(documents.length?'\n\n附带文件：\n'+documents.map(file=>file.name).join('\n'):''),selection:images.map(file=>file.asset.id),documents:documents.map(file=>({title:file.name,text:file.text}))};
}
