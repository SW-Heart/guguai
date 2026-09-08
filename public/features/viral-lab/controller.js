const roles = { product:'商品图', identity:'人物身份板', look:'服装白底图', storyboard:'改好分镜图', scene:'场景参考', audio:'声音参考' };
const statuses = { queued:'排队中', running:'生成中', completed:'已完成', failed:'失败' };

export function createViralLab({ api, state, esc, toast, uploadAsset, loadFiles, loadTasks, scheduleTaskPoll, setCreditBalance, accountSnapshot, isAccountCurrent }) {
  const root = document.querySelector('#viralLabView');
  let project = null, assets = [], tasks = [], projects = [], busy = false, dirty = false, timer = null, epoch = 0;
  let capabilities = {};
  const base = '/api/viral-lab/projects';
  const post = (url, body, options = {}) => api(url, { method:'POST', body:JSON.stringify(body), ...options });
  const file = id => state.files.find(item => item.id === id) || assets.find(item => item.id === id);
  const button = (action, label, extra = '', primary = false) => `<button type="button" class="${primary ? 'gradient-button' : 'secondary-button'}" data-vl="${action}" ${extra}>${label}</button>`;
  const select = (attr, options, value) => `<select ${attr}>${Object.entries(options).map(([id, label]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  function media(id, controls = false) {
    const asset = file(id);
    if (!asset) return '<div class="vl-placeholder">素材不可用，请重新选择</div>';
    const url = esc(asset.url || `/api/files/${encodeURIComponent(id)}/content`);
    if (asset.kind === 'image') return `<img src="${esc(asset.previewUrl || asset.url || `/api/files/${encodeURIComponent(id)}/preview`)}" alt="${esc(asset.name)}" loading="lazy">`;
    if (asset.kind === 'video') return `<video src="${url}" ${controls ? 'controls' : 'muted'} preload="metadata"></video>`;
    return `<audio src="${url}" controls preload="none"></audio>`;
  }
  function notice(message) { root.querySelector('[data-vl-message]')?.replaceChildren(document.createTextNode(message)); }
  function collect() {
    if (!project) return;
    root.querySelectorAll('[data-project-field]').forEach(el => { project[el.dataset.projectField] = el.value; });
    root.querySelectorAll('[data-material-field]').forEach(el => { const item = project.materials[Number(el.dataset.index)]; if (item) item[el.dataset.materialField] = el.value; });
    root.querySelectorAll('[data-unit-field]').forEach(el => { const item = project.units.find(u => u.id === el.dataset.unit); if (item) item[el.dataset.unitField] = el.value; });
    for (const unit of project.units) {
      unit.duration = unit.modelId === 'seedance-2.0' ? 15 : 30;
      unit.referenceAssetIds = [...root.querySelectorAll('[data-unit-ref]')].filter(el => el.dataset.unit === unit.id && el.checked).map(el => el.value);
    }
  }
  async function save() {
    collect();
    if (!dirty) return;
    const captured = epoch, scope = accountSnapshot();
    const result = await api(`${base}/${project.id}`, { method:'PATCH', body:JSON.stringify(project) });
    if (captured !== epoch || !isAccountCurrent(scope)) throw Object.assign(new Error('账号已切换'), { stale:true });
    project = result.project; dirty = false;
    notice('已保存');
  }
  async function run(work) {
    if (busy) return;
    const captured = epoch, scope = accountSnapshot();
    const current = () => { if (captured !== epoch || !isAccountCurrent(scope)) throw Object.assign(new Error('账号已切换'), { stale:true }); };
    busy = true;
    root.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = true; });
    try { await work(current); current(); }
    catch (error) { if (!error.stale) { notice(error.message); toast(error.message); } }
    finally { if (captured === epoch && isAccountCurrent(scope)) { busy = false; root.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = false; }); } }
  }
  async function load() {
    await run(async current => {
      const result = await api(base); current(); projects = result.projects; capabilities = result.capabilities;
      if (project && !dirty) await open(project.id, current); else render();
    });
    clearInterval(timer);
    timer = setInterval(() => { if (project && !busy && state.route === 'lab') void refreshTasks(); }, 8000);
  }
  async function open(id, current = () => {}) {
    const result = await api(`${base}/${id}`); current();
    project = result.project; assets = result.assets; tasks = result.tasks; dirty = false; render();
  }
  async function refreshTasks() {
    const scope = accountSnapshot(), captured = epoch, id = project?.id;
    if (!id) return;
    try {
      const result = await api(`${base}/${id}`);
      if (captured !== epoch || !isAccountCurrent(scope) || project?.id !== id) return;
      tasks = result.tasks; assets = result.assets;
      renderResults();
    } catch { /* Retain the last known task state; explicit refresh reports errors. */ }
  }
  function render() {
    if (!project) {
      root.innerHTML = `<div class="vl-home"><header class="vl-hero"><span class="vl-eyebrow">GuGu 创作空间</span><h2>把灵感，变成你的作品。</h2><p>带来一条参考视频，从自己的商品和人物出发，制作新的表达。</p></header><div class="vl-entry-grid"><button type="button" class="vl-entry" data-vl="create" data-type="replica"><span class="vl-entry-icon">↗</span><small>VIDEO REMIX</small><h3>爆款视频复刻</h3><p>保留镜头与节奏，换上你的商品。拆解、分镜、制作，一处完成。</p><strong>开始创作 <span>→</span></strong></button><button type="button" class="vl-entry vl-entry-outfit" data-vl="create" data-type="outfit"><span class="vl-entry-icon">✧</span><small>LOOKBOOK</small><h3>电商换装复刻</h3><p>整理模特与每套 Look，编排换装节奏，先把资产与方案定下来。</p><strong>创建换装项目 <span>→</span></strong></button></div><div class="vl-section-title"><h3>我的实验</h3><span>${projects.length} 个项目</span></div><div class="vl-project-list">${projects.length ? projects.map(p => `<button type="button" data-vl="open" data-id="${esc(p.id)}"><span class="vl-project-mark">${p.type === 'outfit' ? '换装' : '复刻'}</span><span><b>${esc(p.title)}</b><small>${p.unitCount} 个分段 · ${p.approved ? '方案已确认' : '制作中'}</small></span><span>继续 →</span></button>`).join('') : '<div class="vl-empty">从上方选择一种创作方式，开始你的第一个实验。</div>'}</div><p data-vl-message role="status"></p></div>`;
      return;
    }
    const p = project;
    root.innerHTML = `<div class="vl-workbench"><header class="vl-toolbar">${button('back','← 我的实验')}<input data-project-field="title" aria-label="项目名称" value="${esc(p.title)}" maxlength="80"><span data-vl-message role="status">${dirty ? '有未保存的修改' : '已保存'}</span>${button('export','导出方案')}${button('save','保存', '', true)}</header>
      <nav class="vl-steps" aria-label="制作流程"><a href="#vl-source">01 原片与素材</a><a href="#vl-analysis">02 原片拆解</a><a href="#vl-plan">03 制作方案</a><a href="#vl-results">04 生成与交付</a></nav>
      <div class="vl-columns"><aside class="vl-source" id="vl-source"><section class="vl-card"><div class="vl-section-title"><h3>参考视频</h3>${button('pick-source',p.sourceAssetId ? '更换' : '选择视频')}</div>${p.sourceAssetId ? media(p.sourceAssetId, true) : '<div class="vl-upload-empty">从文件库选择，或上传本地参考视频</div>'}<small>${esc(file(p.sourceAssetId)?.name || '参考视频用于对照，不会自动作为视频模型参考上传。')}</small><label>商品名称<input data-project-field="productName" value="${esc(p.productName)}" placeholder="例如：夏日亚麻套装" maxlength="120"></label><label>我的创作要求<textarea data-project-field="brief" rows="3" placeholder="要保留的节奏、要替换的内容、画幅与声音要求">${esc(p.brief)}</textarea></label></section>
      <section class="vl-card"><div class="vl-section-title"><h3>${p.type === 'outfit' ? '人物与 Look' : '创作素材'}</h3>${button('pick-material','添加素材')}</div><p class="vl-help">${p.type === 'outfit' ? '上传已整理的人物身份板和每套服装白底图，每套使用独立 Look 编号。' : '原片分镜控制镜头；商品图控制外观；人物图只控制指定身份。'}</p><div class="vl-materials">${p.materials.map((m,i) => `<article>${media(m.assetId)}<div><input data-material-field="label" data-index="${i}" value="${esc(m.label)}" aria-label="素材名称">${select(`data-material-field="role" data-index="${i}" aria-label="素材用途"`, roles, m.role)}<input data-material-field="lookId" data-index="${i}" value="${esc(m.lookId)}" placeholder="服装填写 Look 编号" aria-label="Look 编号">${button('remove-material','移除',`data-index="${i}"`)}</div></article>`).join('')}</div><p class="vl-help">确认表示你已查看实际图片，并核对身份、商品与套装归属。修改素材后需要重新确认。</p>${button('confirm-assets',p.assetApproval && !dirty ? '资产已确认 · 重新检查' : '我已检查，确认资产','',true)}</section></aside>
      <div class="vl-main"><section class="vl-card" id="vl-analysis"><div class="vl-section-title"><div><span class="vl-eyebrow">SOURCE NOTES</span><h3>把原片拆清楚</h3></div>${button('import-notes','导入拆解文本')}</div><p class="vl-help">播放左侧原片，记录时间、画面动作、说话人和原台词。也可以粘贴已验证的拆解。当前 AI 只根据这些记录整理方案，不会自动读取视频。</p><textarea class="vl-notes" data-project-field="sourceNotes" aria-label="原片拆解" placeholder="0–3秒｜近景，人物举起商品｜画外音：原台词……&#10;3–8秒｜产品特写，展示关键细节｜……&#10;保留硬切、角色关系与口播顺序；看不清的内容标注待确认。">${esc(p.sourceNotes)}</textarea></section>
      <section id="vl-plan"><div class="vl-section-title"><div><span class="vl-eyebrow">PRODUCTION PLAN</span><h3>制作方案</h3></div><div class="vl-actions">${button('add-unit','添加分段')}${button('ai-plan','AI 整理方案')}</div></div><p class="vl-help">可以直接粘贴已验证的完整提示词。每段独立选择实际引用素材，编号按下方顺序排列。当前 2.0 为 15 秒、2.5 为 30 秒；换装 30 秒内的多个 Look 放在同一段。</p>${p.planError ? `<p class="vl-alert">${esc(p.planError)}</p>` : ''}${p.planning ? '<p class="vl-alert">上次 AI 请求尚未结束，请等待；若已中断，可先导出方案保留内容。</p>' : ''}${p.units.map((u,i) => unitMarkup(u,i)).join('')}<div class="vl-confirm-strip"><p>确认完整提示词、画面与声音、各段素材映射。生成前会再次展示本段积分费用。</p>${button('confirm-plan',p.planApproval && !dirty ? '方案已确认' : '确认制作方案','',true)}</div>${p.materials.some(m => m.role === 'identity') || p.type === 'outfit' ? '<p class="vl-alert">真人素材审核接入中：可保存、整理和导出方案，真人视频暂不提交。</p>' : ''}</section>
      <section class="vl-card" id="vl-results"><div class="vl-section-title"><h3>生成与交付</h3>${button('refresh','刷新记录')}</div><div data-vl-results></div></section></div></div></div>`;
    renderResults();
  }
  function unitMarkup(unit, index) {
    return `<article class="vl-card vl-unit"><div class="vl-section-title"><b>${String(index + 1).padStart(2,'0')} / ${esc(unit.title)}</b>${button('remove-unit','移除分段',`data-id="${esc(unit.id)}"`)}</div><div class="vl-parameters"><label>模型 / 时长${select(`data-unit-field="modelId" data-unit="${esc(unit.id)}"`,project.type === 'outfit' ? {'seedance-2.5':'Seedance 2.5 · 30 秒'} : {'seedance-2.5':'Seedance 2.5 · 30 秒','seedance-2.0':'Seedance 2.0 · 15 秒'},unit.modelId)}</label><label>画幅${select(`data-unit-field="aspectRatio" data-unit="${esc(unit.id)}"`,{'9:16':'9:16','16:9':'16:9','1:1':'1:1'},unit.aspectRatio)}</label><label>分辨率${select(`data-unit-field="quality" data-unit="${esc(unit.id)}"`,{'720p':'720p','480p':'480p'},unit.quality)}</label></div><div class="vl-unit-refs">${project.materials.map(m => `<label><input type="checkbox" data-unit-ref data-unit="${esc(unit.id)}" value="${esc(m.assetId)}" ${unit.referenceAssetIds.includes(m.assetId) ? 'checked' : ''}>${esc(m.label || roles[m.role])}</label>`).join('')}</div><small>已选引用：${unit.referenceAssetIds.map((id,i) => `@${file(id)?.kind === 'audio' ? '音频' : '图片'}${unit.referenceAssetIds.slice(0,i+1).filter(x => file(x)?.kind === file(id)?.kind).length} ${esc(project.materials.find(m => m.assetId === id)?.label || file(id)?.name || id)}`).join(' · ') || '请选择素材'}</small><textarea data-unit-field="prompt" data-unit="${esc(unit.id)}" class="vl-prompt" aria-label="第 ${index+1} 段完整提示词" placeholder="粘贴完整提示词，或先填写原片拆解，再让 AI 整理。">${esc(unit.prompt)}</textarea><div class="vl-unit-footer"><small>完整保存，不自动截断；提交上限 ${[...unit.prompt].length} / 4096 字</small>${button('generate','查看费用并生成',`data-id="${esc(unit.id)}"`,true)}</div></article>`;
  }
  function renderResults() {
    const target = root.querySelector('[data-vl-results]'); if (!target) return;
    target.innerHTML = tasks.length ? tasks.map(task => {
      const asset = file(task.assetId);
      return `<article class="vl-result"><div><b>${esc(project.units.find(u => u.id === task.viralUnitId)?.title || '历史分段')}</b><span>${statuses[task.status] || '处理中'}${task.viralPlanHash !== project.planApproval?.hash ? ' · 旧方案版本' : ''}</span>${task.status === 'completed' && task.assetId ? media(task.assetId,true) : ''}<p>${esc(task.error || '')}</p>${task.status === 'completed' ? `<small>已生成的素材可在文件库中查看、下载${asset ? `：${esc(asset.name)}` : '，正在同步'}</small>` : ''}</div>${task.status === 'failed' ? button('retry','定向重试',`data-id="${esc(task.viralUnitId)}"`) : ''}</article>`;
    }).join('') : '<p class="vl-help">确认方案后，逐段生成。完成的分段会保存在文件库；多段成片可使用短剧工作台的合成功能。</p>';
  }
  async function choose(kind, onSelect, current) {
    await loadFiles(); current();
    const dialog = document.createElement('dialog'); dialog.className = 'vl-dialog';
    const draw = () => { dialog.innerHTML = `<header><h3>${kind === 'source' ? '选择参考视频' : '选择创作素材'}</h3><button type="button" data-close aria-label="关闭">×</button></header><input type="search" data-search placeholder="搜索文件名" aria-label="搜索素材"><div class="vl-picker">${state.files.filter(f => kind === 'source' ? f.kind === 'video' : ['image','audio'].includes(f.kind)).map(f => `<button type="button" data-file="${esc(f.id)}" data-name="${esc(f.name.toLowerCase())}">${media(f.id)}<span>${esc(f.name)}</span></button>`).join('')}</div><footer>${button('upload','上传本地素材')}</footer>`; };
    draw(); document.body.append(dialog); dialog.showModal();
    await new Promise(resolve => {
      const close = () => dialog.close();
      dialog.addEventListener('close', () => { dialog.remove(); resolve(); }, { once:true });
      dialog.querySelector('[data-close]').onclick = close;
      dialog.querySelector('[data-search]').oninput = event => dialog.querySelectorAll('[data-file]').forEach(el => { el.hidden = !el.dataset.name.includes(event.target.value.toLowerCase()); });
      dialog.onclick = async event => {
        try {
          current();
          const selected = event.target.closest('[data-file]');
          if (selected) { onSelect(file(selected.dataset.file)); close(); }
          if (event.target.closest('[data-vl="upload"]')) {
            const f = await uploadAsset(); current();
            if (f && (kind === 'source' ? f.kind === 'video' : ['image','audio'].includes(f.kind))) { onSelect(f); close(); }
            else if (f) toast(kind === 'source' ? '请选择视频文件' : '请选择图片或音频');
          }
        } catch (error) { close(); if (!error.stale) toast(error.message); }
      };
    });
  }
  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type:mime }));
    const a = document.createElement('a'); a.href = url; a.download = name.replace(/[\\/:*?"<>|]/g,'_'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  async function confirmCost(title, message) {
    const dialog = document.createElement('dialog'); dialog.className = 'vl-dialog vl-cost';
    dialog.innerHTML = `<header><h3>${esc(title)}</h3></header><p>${esc(message)}</p><footer><button type="button" data-no class="secondary-button">返回修改</button><button type="button" data-yes class="gradient-button">确认并继续</button></footer>`;
    document.body.append(dialog); dialog.showModal();
    return new Promise(resolve => { let accepted = false; dialog.querySelector('[data-no]').onclick = () => dialog.close(); dialog.querySelector('[data-yes]').onclick = () => { accepted = true; dialog.close(); }; dialog.onclose = () => { dialog.remove(); resolve(accepted); }; });
  }
  root.addEventListener('input', () => { dirty = true; notice('有未保存的修改'); });
  root.addEventListener('change', event => { if (event.target.matches('select,[data-unit-ref]')) { collect(); dirty = true; render(); } });
  root.addEventListener('click', event => {
    const el = event.target.closest('[data-vl]'); if (!el) return;
    void run(async current => {
      const action = el.dataset.vl;
      if (action === 'create') { const result = await post(base, { type:el.dataset.type, title:el.dataset.type === 'outfit' ? '我的换装实验' : '我的视频复刻' }); current(); project = result.project; tasks = []; assets = []; dirty = false; render(); return; }
      if (action === 'open') { await open(el.dataset.id,current); return; }
      if (action === 'back') { await save(); current(); project = null; const result = await api(base); current(); projects = result.projects; render(); return; }
      if (!project) return;
      collect();
      if (action === 'save') { await save(); current(); render(); return; }
      if (action === 'export') { download(`${project.title}.json`,JSON.stringify({ ...project, assetApproval:undefined, planApproval:undefined, planning:undefined, exportedAt:new Date().toISOString(), note:'制作方案与素材引用清单，不包含素材文件。' },null,2),'application/json'); return; }
      if (action === 'import-notes') {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.txt,.md';
        input.onchange = async () => { try { current(); const f = input.files[0]; if (!f) return; if (f.size > 100000) throw new Error('拆解文本不能超过 100 KB'); const value = await f.text(); current(); if (value.length > 20000) throw new Error('拆解最多 20000 字，请分批整理'); project.sourceNotes = value; dirty = true; render(); } catch(e) { if(!e.stale)toast(e.message); } }; input.click(); return;
      }
      if (action === 'pick-source' || action === 'pick-material') {
        await choose(action === 'pick-source' ? 'source' : 'material', f => {
          if (!f) return; assets = [f,...assets.filter(a => a.id !== f.id)];
          if (action === 'pick-source') project.sourceAssetId = f.id;
          else if (!project.materials.some(m => m.assetId === f.id)) project.materials.push({assetId:f.id,role:f.kind === 'audio' ? 'audio' : 'product',label:f.name,lookId:''});
          dirty = true;
        }, current); current(); render(); return;
      }
      if (action === 'remove-material') { const [removed] = project.materials.splice(Number(el.dataset.index),1); project.units.forEach(u => {u.referenceAssetIds=u.referenceAssetIds.filter(id=>id!==removed.assetId);}); dirty=true;render();return; }
      if (action === 'add-unit') { project.units.push({id:crypto.randomUUID(),title:`第 ${project.units.length+1} 段`,modelId:'seedance-2.5',duration:30,aspectRatio:'9:16',quality:'720p',prompt:'',referenceAssetIds:project.materials.map(m=>m.assetId)});dirty=true;render();return; }
      if (action === 'remove-unit') { project.units=project.units.filter(u=>u.id!==el.dataset.id);dirty=true;render();return; }
      if (action === 'refresh') { await save();current();await open(project.id,current);return; }
      await save(); current();
      if (action === 'confirm-assets' || action === 'confirm-plan') {
        const result = await post(`${base}/${project.id}/${action === 'confirm-assets' ? 'assets-confirm' : 'plan-confirm'}`,{revision:project.revision});current();project=result.project;render();return;
      }
      if (action === 'ai-plan') {
        if (!capabilities.aiPlan) throw new Error('AI 方案服务暂不可用，可以先填写或粘贴已有提示词');
        const quote = await post(`${base}/${project.id}/plan-quote`,{revision:project.revision});current();
        if (!await confirmCost('AI 整理制作方案',`仅根据你填写的原片拆解整理提示词。最多预留 ${quote.maxCredits.toFixed(3)} 积分，完成后按实际用量结算，不自动生成视频。`)) return;
        current(); notice('AI 正在整理方案…');
        const result = await post(`${base}/${project.id}/plan`,{revision:project.revision,quoteId:quote.quoteId},{timeoutMs:210000});current();project=result.project;setCreditBalance(result.balance);render();return;
      }
      if (action === 'generate' || action === 'retry') {
        if (!project.planApproval) throw new Error('请先确认当前制作方案');
        if (project.materials.some(m=>m.role==='identity')) throw new Error('真人素材审核尚未接入，当前可导出制作方案');
        const unit = project.units.find(u=>u.id===el.dataset.id); if (!unit) throw new Error('请在当前方案中选择分段');
        if ([...unit.prompt].length>4096) throw new Error('当前视频线路提示词上限 4096 字，请手动调整后重新确认；原稿已完整保存');
        const quote = await post('/api/model-quote',{...unit,type:'video',generationType:'REFERENCE',exactReferencePrice:true});current();
        if (!await confirmCost(action === 'retry' ? '定向重试此分段' : '生成此分段',`${unit.title} · ${unit.duration} 秒 · ${unit.quality}，本次 ${quote.credits} 积分。只提交这一段，其他分段保持不变。`)) return;
        current();
        if(action==='retry'){const result=await post(`${base}/${project.id}/retry`,{revision:project.revision,unitId:unit.id});current();project=result.project;}
        const task = await post('/api/generations',{viralProjectId:project.id,viralUnitId:unit.id,viralPlanHash:project.planApproval.hash,requestId:project.planApproval.requests[unit.id],expectedPriceVersion:quote.priceVersion});current();
        setCreditBalance(task.balance); await loadTasks(); current(); scheduleTaskPoll(); await open(project.id,current);toast('任务已提交，生成结果会进入文件库');
      }
    });
  });
  function reset() { epoch++; clearInterval(timer); timer=null; document.querySelectorAll('.vl-dialog').forEach(d=>d.close());project=null;assets=[];tasks=[];projects=[];dirty=false;busy=false;root.replaceChildren(); }
  function suspend() { clearInterval(timer);timer=null; }
  return { load, resetForAccount:reset, suspend, refreshTasks };
}
