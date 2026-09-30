import { generationFrames } from '../../public/features/agent/frames.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { bodyBuffer } from '../http-protocol.mjs';
import { normalizeModelPreferences, validateModelPreferences } from '../../lib/agent/model-preferences.mjs';

const DOCUMENT_UPLOAD_MAX_BYTES=15*1024*1024;
const DOCUMENT_TEXT_MAX_CHARS=300_000;
async function extractDocument(req,name){
  const extension=String(name||'').split('.').pop().toLowerCase();
  if(!['pdf','docx'].includes(extension))throw Object.assign(new Error('目前支持 PDF 和 Word 文档'),{statusCode:415});
  const bytes=await bodyBuffer(req,DOCUMENT_UPLOAD_MAX_BYTES,'文件不能超过 15 MB');
  if(!bytes.length)throw Object.assign(new Error('文件为空'),{statusCode:400});
  let text='';
  if(extension==='pdf'){
    if(bytes.subarray(0,1024).indexOf(Buffer.from('%PDF-'))<0)throw Object.assign(new Error('文件格式与扩展名不一致'),{statusCode:415});
    const pdf=await getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true,verbosity:0}).promise;
    try{
      if(pdf.numPages>500)throw Object.assign(new Error('PDF 页数过多，暂时无法读取'),{statusCode:413});
      const pages=[];let totalChars=0;
      for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
        const page=await pdf.getPage(pageNumber);
        const content=await page.getTextContent();
        let previous='';
        const pageText=content.items.map(item=>{
          const current=item.str||'';
          const separator=item.hasEOL?'\n':(/[A-Za-z0-9]$/.test(previous)&&/^[A-Za-z0-9]/.test(current)?' ':'');
          previous=current.trimEnd();
          return separator+current;
        }).join('');
        pages.push(pageText);totalChars+=pageText.length;
        if(totalChars>DOCUMENT_TEXT_MAX_CHARS)throw Object.assign(new Error('文档文字内容过长，暂时无法读取'),{statusCode:413});
      }
      text=pages.join('\n\n');
    }finally{await pdf.destroy();}
  }else{
    if(bytes[0]!==0x50||bytes[1]!==0x4b)throw Object.assign(new Error('文件格式与扩展名不一致'),{statusCode:415});
    const result=await mammoth.extractRawText({buffer:bytes});
    text=result.value;
    if(text.length>DOCUMENT_TEXT_MAX_CHARS)throw Object.assign(new Error('文档文字内容过长，暂时无法读取'),{statusCode:413});
  }
  text=String(text).replace(/\u0000/g,'').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g,' ').trim();
  if(!text)throw Object.assign(new Error('文件中没有可读取的文字内容'),{statusCode:422});
  return text;
}

export function createAgentRouteHandler({ repository: repo, runtime, gateway, skills, mediaCatalog = async () => [], bodyJson, sendJson, requireUser, requireDesktopWorkspaceScope, loadProject, publicProject, findGeneration, publicGeneration, findAsset, publicAsset, walletOf }) {
  function attachmentParts(text) {
    // Only interpret the attachment suffix produced by the composer; keep user prose intact.
    let visibleText = String(text || '');
    let documentNames = [], references = [];
    const documentsAt = visibleText.lastIndexOf('\n\n附带文件：\n');
    if (documentsAt >= 0) {
      documentNames = visibleText.slice(documentsAt + '\n\n附带文件：\n'.length).split('\n').filter(Boolean);
      visibleText = visibleText.slice(0, documentsAt);
    }
    const mediaAt = visibleText.lastIndexOf('\n\n附件：\n');
    if (mediaAt >= 0) {
      const lines = visibleText.slice(mediaAt + '\n\n附件：\n'.length).split('\n');
      const matches = lines.map(line => line.match(/^(.+?)（素材\s*ID[：:]\s*([\w-]{1,200})）$/));
      if (matches.length && matches.every(Boolean)) {
        references = matches.map(([, name, id]) => ({ name, id }));
        visibleText = visibleText.slice(0, mediaAt);
      }
    }
    return { visibleText, references, documentNames };
  }
  function referencedFiles(references, session) {
    const seen = new Set();
    return references.flatMap(({ name, id }) => {
      if (seen.has(id)) return [];
      seen.add(id);
      let asset = findAsset?.(session.userId, id, session.scope);
      if (!asset) {
        const generation = findGeneration?.(session.userId, id, session.scope);
        if (generation?.assetId) asset = findAsset?.(session.userId, generation.assetId, session.scope);
      }
      if (!asset || !publicAsset) return [{ id, name, status:'unavailable' }];
      const value = publicAsset(asset);
      return [{ id, name:asset.name || name, kind:asset.kind, mimeType:value.mimeType, size:value.size, url:value.url, previewUrl:value.previewUrl || value.url }];
    });
  }
  async function snapshot(session, { conversationOnly = false } = {}) {
    const { doc } = session;
    if(conversationOnly)return {
      id:session.id,state:session.state,version:doc.version||0,settings:{...session.settings,model:gateway.config.model},
      messages:[],draft:'',activity:'',approval:null,agentProjectId:session.agentProjectId,
      workspaceUnchanged:true,balance:walletOf(session.userId).balance,
    };
    const artifacts = session.projectId || session.agentProjectId ? repo.artifacts(session) : {...doc,generations:generationFrames(doc)};
    // Input records retain the exact document association, including repeated filenames.
    const inputsByText = new Map();
    for (const input of repo.messageInputs?.(session) || []) {
      if (!inputsByText.has(input.text)) inputsByText.set(input.text, []);
      inputsByText.get(input.text).push(input);
    }
    const messageView = (id, role, text, input) => {
      if (role !== 'user') return {id, role, text};
      const {visibleText, references, documentNames} = attachmentParts(text);
      const documents = (doc.documents || []).filter(item => item.source === 'attachment');
      const attachments = [...referencedFiles(references, session), ...documentNames.map((name, index) => {
        const matches = documents.filter(item => item.title === name);
        const document = input ? documents.find(item => item.id === `upload-${input.client_id}-${index+1}`) : matches.length === 1 ? matches[0] : null;
        return document ? {id:document.id, name:document.title, kind:'document', text:document.text}
          : {id:`document-${index}`, name, kind:'document', status:'unavailable'};
      })];
      const images = attachments.filter(file => file.kind === 'image' && (file.previewUrl || file.url));
      return { id, role, text:visibleText, ...(attachments.length ? {attachments} : {}), ...(images.length ? {images} : {}) };
    };
    const messages = doc.messages.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content).map((m, i) => {
      const input = m.role === 'user' ? inputsByText.get(m.content)?.shift() : null;
      return messageView(input ? `input-${input.seq}` : `${session.id}-${i}`, m.role, m.content, input);
    });
    for (const input of repo.inputs(session)) messages.push(messageView(`input-${input.seq}`, 'user', input.text, input));
    const project = session.projectId ? await loadProject(session.userId, session.projectId, session.scope) : null;
    return {
      id: session.id, state: session.state, version: doc.version || 0, settings: {...session.settings,model:gateway.config.model},
      messages, draft: doc.draft || '', activity: doc.activity || '', approval: doc.approval?.decision ? null : doc.approval || null,
      documents: artifacts.documents.map(({ id, title, text, revision, conversationId }) => ({ id, title, text, revision, conversationId })),
      sourceObservations:(session.agentProjectId?repo.listObservations(session):Object.values(doc.sourceObservations||{})).filter(item=>findAsset?.(session.userId,item.assetId,session.scope)).map(({assetId,assetName,overview,revision,events,updatedAt})=>({assetId,assetName,overview,revision,eventCount:events.length,updatedAt})),
      sourceTranscripts:(session.agentProjectId?repo.listTranscripts(session):doc.sourceTranscripts||[]).filter(item=>findAsset?.(session.userId,item.assetId,session.scope)?.sha256===item.sourceSha256).slice(0,20).map(({assetId,assetName,startSeconds,endSeconds,language,text,words,cues,updatedAt})=>({id:`transcript-${assetId}-${Math.round(startSeconds*1000)}-${Math.round(endSeconds*1000)}-${language}`,assetId,assetName,startSeconds,endSeconds,language,text,wordCount:words.length,cues,updatedAt})),
      generations: artifacts.generations,
      audioAssets:findAsset&&publicAsset?[...new Set(Object.values(doc.audioExtractions||{}))].map(id=>findAsset(session.userId,id,session.scope)).filter(Boolean).map(publicAsset):[],
      composedAssets:findAsset&&publicAsset?[...new Set((artifacts.compositions||[]).map(item=>item.assetId))].map(id=>findAsset(session.userId,id,session.scope)).filter(Boolean).map(publicAsset):[],
      tasks: artifacts.generations.filter(g => !g.placeholder).map(g => findGeneration(session.userId, g.id, session.scope)).filter(Boolean).map(publicGeneration),
      project: project ? publicProject(project) : null,
      agentProjectId:session.agentProjectId || '',
      canvas: session.projectId ? null : repo.canvas?.(session) || null,
      balance: walletOf(session.userId).balance,
    };
  }
  async function settings(input, previous = {}) {
    const result = { model: gateway.config.model, autoGenerate: previous.autoGenerate || false, generationBudgetMicro: previous.generationBudgetMicro || 0, skill:previous.skill||'', modelPreferences:normalizeModelPreferences(previous.modelPreferences) };
    if (input.modelPreferences !== undefined) result.modelPreferences = validateModelPreferences(input.modelPreferences, await mediaCatalog());
    if (input.autoGenerate !== undefined) { if (typeof input.autoGenerate !== 'boolean') throw Object.assign(new Error('生成设置无效'), { statusCode: 400 }); result.autoGenerate = input.autoGenerate; }
    if (input.skill !== undefined) {
      if(typeof input.skill!=='string'||input.skill.length>64)throw Object.assign(new Error('所选创作方式无效'),{statusCode:400});
      if(input.skill&&!((await skills.search()).some(item=>item.name===input.skill)))throw Object.assign(new Error('所选创作方式暂时不可用'),{statusCode:400});
      result.skill=input.skill;
    }
    if (input.generationBudgetCredits !== undefined) {
      const credits = input.generationBudgetCredits;
      if (!Number.isFinite(credits) || credits < 0 || credits > 10000) throw Object.assign(new Error('生成预算需在 0 到 10000 积分之间'), { statusCode: 400 });
      result.generationBudgetMicro = Math.round(credits * 1000000);
    }
    return result;
  }
  return async function agentRoute(req, res, url) {
    if (!url.pathname.startsWith('/api/agent/')) return false;
    const user = await requireUser(req, res); if (!user) return true;
    const captionMatch=url.pathname.match(/^\/api\/agent\/sessions\/([\w-]+)\/captions\/([\w-]+)\.vtt$/);
    if(captionMatch&&req.method==='GET'){
      const session=repo.getForUser(captionMatch[1],user.id);
      const asset=session&&findAsset?.(user.id,captionMatch[2],session.scope);
      if(!session||!asset){sendJson(res,404,{error:'字幕不存在'});return true;}
      const stored=(session.agentProjectId?repo.listTranscripts(session,asset.id):session.doc.sourceTranscripts||[]).filter(item=>item.assetId===asset.id&&item.sourceSha256===asset.sha256);
      const ranges=new Map();
      for(const record of stored){const key=`${record.startSeconds}:${record.endSeconds}`;if(!ranges.has(key)||(ranges.get(key).updatedAt||0)<(record.updatedAt||0))ranges.set(key,record);}
      const records=[...ranges.values()].sort((left,right)=>(right.updatedAt||0)-(left.updatedAt||0));
      const cues=[],newerRanges=[];
      for(const record of records){
        for(const cue of record.cues||[]){
          const midpoint=(cue.startSeconds+cue.endSeconds)/2;
          if(cue.endSeconds>cue.startSeconds&&!newerRanges.some(range=>midpoint>=range.startSeconds&&midpoint<range.endSeconds))cues.push(cue);
        }
        newerRanges.push({startSeconds:record.startSeconds,endSeconds:record.endSeconds});
      }
      cues.sort((left,right)=>left.startSeconds-right.startSeconds);
      if(!cues.length){sendJson(res,404,{error:'字幕不存在'});return true;}
      const stamp=value=>{const ms=Math.max(0,Math.round(value*1000));return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};
      const body=`WEBVTT\n\n${cues.map(cue=>`${stamp(cue.startSeconds)} --> ${stamp(cue.endSeconds)}\n${String(cue.text).replace(/[\r\n]+/g,' ').replace(/-->/g,'→').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}`).join('\n\n')}\n`;
      res.writeHead(200,{'Content-Type':'text/vtt; charset=utf-8','Cache-Control':'private, no-store'});
      res.end(body);return true;
    }
    const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
    if(url.pathname==='/api/agent/documents/extract'&&req.method==='POST'){
      const name=String(url.searchParams.get('name')||'').replace(/[\\/\r\n\u0000-\u001f]/g,'').slice(0,160);
      try{sendJson(res,200,{name,text:await extractDocument(req,name)});}
      catch(error){sendJson(res,error.statusCode||422,{error:error.statusCode?error.message:'无法读取这份文件，请确认文件未损坏后重试'});}
      return true;
    }
    if (url.pathname === '/api/agent/config' && req.method === 'GET') {
      sendJson(res, 200, { configured: gateway.config.configured, defaultModel: gateway.config.model, models: await gateway.listModels(), skills: await skills.search() }); return true;
    }
    if (url.pathname === '/api/agent/skills' && req.method === 'GET') {
      sendJson(res, 200, { skills: await skills.search() }); return true;
    }
    if (url.pathname === '/api/agent/media-models' && req.method === 'GET') {
      const models = (await mediaCatalog()).map(({id, label, kind, description, iconKey}) => ({id, label, kind, description, iconKey}));
      sendJson(res, 200, { models, modelPreferences:repo.userModelPreferences(user.id) }); return true;
    }
    if (url.pathname === '/api/agent/model-preferences' && req.method === 'GET') {
      sendJson(res, 200, {modelPreferences:repo.userModelPreferences(user.id)}); return true;
    }
    if (url.pathname === '/api/agent/model-preferences' && req.method === 'PUT') {
      const input = await bodyJson(req);
      const preferences = validateModelPreferences(input.modelPreferences, await mediaCatalog());
      sendJson(res, 200, {modelPreferences:repo.saveUserModelPreferences(user.id, preferences)}); return true;
    }
    if (url.pathname === '/api/agent/projects' && req.method === 'GET') {sendJson(res,200,{projects:repo.listProjects(user.id,scope)});return true;}
    if (url.pathname === '/api/agent/projects' && req.method === 'POST') {
      const input=await bodyJson(req);
      const title=String(input.title||'新项目').trim();
      if(title.length>80){sendJson(res,400,{error:'项目名称太长'});return true;}
      const project=repo.createProject(user.id,scope,title);
      sendJson(res,201,{project});return true;
    }
    const projectMatch=url.pathname.match(/^\/api\/agent\/projects\/([\w-]+)$/);
    if(projectMatch&&req.method==='GET'){
      const project=repo.getProject(projectMatch[1],user.id,scope);
      sendJson(res,project?200:404,project?{project}:{error:'项目不存在'});return true;
    }
    if(projectMatch&&req.method==='PATCH'){
      const input=await bodyJson(req);
      const title=String(input.title||'').replace(/[\r\n\u0000-\u001f]/g,' ').trim();
      if(!title){sendJson(res,400,{error:'请输入名称'});return true;}
      if(title.length>80){sendJson(res,400,{error:'名称最多 80 个字'});return true;}
      const project=repo.renameProject(projectMatch[1],user.id,scope,title);
      sendJson(res,project?200:404,project?{project}:{error:'项目不存在'});return true;
    }
    if(projectMatch&&req.method==='DELETE'){
      const removed=repo.deleteProject(projectMatch[1],user.id,scope);
      if(!removed){sendJson(res,404,{error:'项目不存在'});return true;}
      // Stop any reply still running for the removed conversations.
      for(const sessionId of removed.sessionIds)runtime.interrupt(sessionId);
      sendJson(res,200,{deleted:true,id:removed.id});return true;
    }
    if (url.pathname === '/api/agent/sessions' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      const agentProjectId=url.searchParams.get('agentProjectId')||'';
      if(agentProjectId){
        if(!repo.getProject(agentProjectId,user.id,scope)){sendJson(res,404,{error:'项目不存在'});return true;}
        sendJson(res,200,{sessions:repo.listProjectSessions(user.id,scope,agentProjectId)});return true;
      }
      if (projectId && !await loadProject(user.id, projectId, scope)) { sendJson(res, 404, { error: '画布不存在' }); return true; }
      sendJson(res, 200, { sessions: repo.list(user.id, scope, projectId) }); return true;
    }
    if (url.pathname === '/api/agent/sessions' && req.method === 'POST') {
      const input = await bodyJson(req);
      const projectId = String(input.projectId || '');
      const agentProjectId=String(input.agentProjectId||'');
      if(projectId&&agentProjectId){sendJson(res,400,{error:'请选择一个项目'});return true;}
      if(agentProjectId&&!repo.getProject(agentProjectId,user.id,scope)){sendJson(res,404,{error:'项目不存在'});return true;}
      if (projectId && !await loadProject(user.id, projectId, scope)) { sendJson(res, 404, { error: '画布不存在' }); return true; }
      const previous=input.fresh===true&&agentProjectId&&typeof input.previousSessionId==='string'
        ? repo.get(input.previousSessionId,user.id,scope):null;
      const reuseWorkspace=Boolean(previous&&previous.agentProjectId===agentProjectId&&!previous.projectId);
      const session = repo.create(user.id, scope, projectId, await settings(input), { fresh: input.fresh === true,agentProjectId });
      sendJson(res, 200, await snapshot(session,{conversationOnly:reuseWorkspace})); return true;
    }
    const match = url.pathname.match(/^\/api\/agent\/sessions\/([\w-]+)(?:\/(messages|settings|interrupt|resume|approval|canvas))?$/);
    if (!match) { sendJson(res, 404, { error: '接口不存在' }); return true; }
    const session = repo.get(match[1], user.id, scope);
    if (!session) { sendJson(res, 404, { error: '对话不存在' }); return true; }
    if (match[2] === 'canvas') {
      if (session.projectId) { sendJson(res, 400, {error:'请在短剧项目中编辑画布'}); return true; }
      if (req.method === 'GET') { sendJson(res, 200, {canvas:repo.canvas(session)}); return true; }
      if (req.method !== 'PATCH') { sendJson(res, 405, {error:'请求方式不支持'}); return true; }
      const input = await bodyJson(req);
      if (JSON.stringify(input).length > 2_000_000) { sendJson(res, 413, {error:'画布内容过大'}); return true; }
      sendJson(res, 200, {canvas:repo.saveCanvas(session,input)}); return true;
    }
    if (!match[2] && req.method === 'GET') { sendJson(res, 200, await snapshot(session)); return true; }
    if (req.method !== 'POST') { sendJson(res, 405, { error: '请求方式不支持' }); return true; }
    const input = await bodyJson(req,match[2]==='messages'?8_000_000:2_000_000);
    if (match[2] === 'messages') {
      const text = String(input.text || '').trim();
      if (!text || text.length > 30000 || !/^[\w-]{8,80}$/.test(input.clientId || '')) { sendJson(res, 400, { error: '消息内容或标识无效' }); return true; }
      if(input.documents!==undefined&&(!Array.isArray(input.documents)||input.documents.length>10||input.documents.some(item=>!item||typeof item.title!=='string'||item.title.length>160||typeof item.text!=='string'||item.text.length>300_000)||input.documents.reduce((total,item)=>total+(typeof item?.text==='string'?item.text.length:0),0)>1_000_000)){sendJson(res,400,{error:'附带文件内容无效或过多'});return true;}
      const selection = Array.isArray(input.selection) ? [...new Set(input.selection.filter(v => typeof v === 'string' && v.length <= 200))] : [];
      if (selection.length > 50) { sendJson(res, 400, { error: '一次最多选择 50 个素材或画布内容' }); return true; }
      const modelPreferences = input.modelPreferences === undefined ? undefined : validateModelPreferences(input.modelPreferences, await mediaCatalog(), {allowUnavailable:true});
      repo.enqueue(session, { text, clientId: input.clientId, selection, documents:input.documents||[], modelPreferences });
    } else if (match[2] === 'settings') {
      const next = await settings(input, session.settings);
      if (input.modelPreferences === undefined && repo.userModelPreferences) next.modelPreferences = repo.userModelPreferences(user.id);
      repo.settings(session, next);
    }
    else if (match[2] === 'interrupt') { repo.control(session, 'interrupt'); runtime.interrupt(session.id); }
    else if (match[2] === 'resume') repo.control(session, 'resume');
    else if (match[2] === 'approval') {
      if (typeof input.accepted !== 'boolean') { sendJson(res, 400, { error: '请选择是否生成' }); return true; }
      repo.approve(session, String(input.approvalId || ''), input.accepted);
    } else { sendJson(res, 404, { error: '接口不存在' }); return true; }
    if (!['settings', 'interrupt'].includes(match[2])) runtime.kick(session.id);
    sendJson(res, 202, await snapshot(repo.get(session.id, user.id, scope))); return true;
  };
}
