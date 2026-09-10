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
      root.innerHTML = `<div class="vl-home"><header class="vl-hero"><div><h1>爆款实验室</h1><p>从一条参考视频开始，做出你的版本。</p></div></header><div class="vl-entry-grid"><button type="button" class="vl-entry" data-vl="create" data-type="replica"><span class="vl-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7V5Z"/><path d="M4 5v14"/></svg></span><span class="vl-entry-copy"><h2>爆款视频复刻</h2><p>保留镜头节奏，替换成你的商品和表达。</p></span><span class="vl-entry-action">开始复刻 <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg></span></button><button type="button" class="vl-entry vl-entry-outfit" data-vl="create" data-type="outfit"><span class="vl-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 4h8l2 4-3 2v10H9V10L6 8l2-4Z"/><path d="M9 10h6"/></svg></span><span class="vl-entry-copy"><h2>电商换装复刻</h2><p>整理人物和服装，编排一条完整的换装表达。</p></span><span class="vl-entry-action">开始换装 <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg></span></button></div><section class="vl-projects"><div class="vl-section-title"><h2>最近项目</h2></div><div class="vl-project-list">${projects.length ? projects.map(p => `<button type="button" data-vl="open" data-id="${esc(p.id)}"><span class="vl-project-mark" aria-hidden="true">${p.type === 'outfit' ? '换装' : '复刻'}</span><span class="vl-project-copy"><b>${esc(p.title)}</b><span>${p.approved ? '方案已确认' : p.sourceAnalyzed ? '原片已分析' : '继续编辑'}</span></span><span class="vl-project-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg></span></button>`).join('') : '<div class="vl-empty">还没有项目，从上方开始吧。</div>'}</div></section><p data-vl-message role="status"></p></div>`;
      return;
    }
    const p = project;
    root.innerHTML = p.type === 'outfit' ? outfitWorkbenchMarkup(p) : replicaWorkbenchMarkup(p);
    renderResults();
  }
  function toolbarMarkup(p) {
    return `<header class="vl-toolbar">${button('back','<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg><span>实验室</span>')}<div class="vl-toolbar-title"><input data-project-field="title" aria-label="项目名称" value="${esc(p.title)}" maxlength="80"><span data-vl-message role="status">${dirty ? '未保存' : '已保存'}</span></div><div class="vl-toolbar-actions">${button('export','导出')}${button('save','保存', '', true)}</div></header>`;
  }
  function materialRows(p) {
    return p.materials.map((m,i) => `<article>${media(m.assetId)}<div><input data-material-field="label" data-index="${i}" value="${esc(m.label)}" aria-label="素材名称" placeholder="素材名称">${select(`data-material-field="role" data-index="${i}" aria-label="素材用途"`, roles, m.role)}<input data-material-field="lookId" data-index="${i}" value="${esc(m.lookId)}" placeholder="服装编号（可选）" aria-label="服装编号">${button('remove-material','移除',`data-index="${i}"`)}</div></article>`).join('');
  }
  function planMarkup(p, subtitle) {
    return `<section id="vl-plan"><div class="vl-section-title"><div><h2>制作方案</h2><p class="vl-section-subtitle">${subtitle}</p></div><div class="vl-actions">${button('add-unit','添加分段')}${button('ai-plan','AI 整理')}</div></div>${p.planError ? `<p class="vl-alert">${esc(p.planError)}</p>` : ''}${p.planning ? '<p class="vl-alert">正在整理方案…</p>' : ''}${p.units.map((u,i) => unitMarkup(u,i)).join('')}<div class="vl-confirm-strip"><p>方案准备好后，就可以开始生成。</p>${button('confirm-plan',p.planApproval && !dirty ? '重新确认方案' : '确认方案','',true)}</div></section>`;
  }
  function resultsMarkup() {
    return `<section class="vl-card" id="vl-results"><div class="vl-section-title"><h2>生成结果</h2>${button('refresh','刷新')}</div><div data-vl-results></div></section>`;
  }
  function sourceObservationMarkup(p) {
    const observation = p.sourceObservation;
    if (!observation) return '<div class="vl-analysis-empty">开始分析后，原片的节奏、动作和台词会显示在这里，也可以直接编辑下面的拆解。</div>';
    const timeline = (observation.timeline || []).map(item => `<div class="vl-observation-beat"><time>${item.startSeconds.toFixed(1)}–${item.endSeconds.toFixed(1)} 秒</time><div><b>${esc(item.visualAction || '画面保持')}</b>${item.spokenContent ? `<p>${esc(item.speakerMode === 'voiceover' ? `画外音：${item.spokenContent}` : item.spokenContent)}</p>` : ''}${item.visibleText?.length ? `<span>${esc(item.visibleText.join(' · '))}</span>` : ''}</div></div>`).join('');
    return `<div class="vl-observation"><p class="vl-observation-summary">${esc(observation.summary || '已完成原片观察，可在下方补充细节。')}</p><div class="vl-observation-timeline">${timeline || '<p class="vl-analysis-empty">暂未识别到可编辑的时间段。</p>'}</div>${observation.uncertainties?.length ? `<p class="vl-observation-note">${esc(observation.uncertainties[0])}</p>` : ''}</div>`;
  }
  function replicaWorkbenchMarkup(p) {
    const analysisAction = capabilities.automaticSourceAnalysis ? button('analyze-source', p.sourceAnalysisState?.status === 'running' ? '重新分析' : p.sourceObservation ? '重新分析' : '开始分析', p.sourceAssetId ? '' : 'disabled') : '';
    const analysisError = p.sourceAnalysisState?.status === 'failed' ? '<p class="vl-alert">原片分析没有完成，可以重试或直接编辑拆解。</p>' : '';
    return `<div class="vl-workbench vl-replica-workbench">${toolbarMarkup(p)}<nav class="vl-steps" aria-label="视频复刻流程"><a href="#vl-source"><span>1</span>参考</a><a href="#vl-analysis"><span>2</span>拆解</a><a href="#vl-plan"><span>3</span>分段</a><a href="#vl-results"><span>4</span>生成</a></nav><div class="vl-columns"><aside class="vl-source" id="vl-source"><section class="vl-card"><div class="vl-section-title"><h2>参考视频</h2>${button('pick-source',p.sourceAssetId ? '更换' : '选择视频')}</div>${p.sourceAssetId ? media(p.sourceAssetId, true) : '<div class="vl-upload-empty">选择一条视频，作为这次创作的节奏参考。</div>'}<div class="vl-file-name">${esc(file(p.sourceAssetId)?.name || '')}</div><label>商品名称<input data-project-field="productName" value="${esc(p.productName)}" placeholder="例如：夏日亚麻套装" maxlength="120"></label><label>创作要求<textarea data-project-field="brief" rows="3" placeholder="想保留什么，想替换什么？">${esc(p.brief)}</textarea></label></section><section class="vl-card"><div class="vl-section-title"><h2>创作素材</h2>${button('pick-material','添加素材')}</div><p class="vl-help">把这次创作会用到的素材放在这里。</p><div class="vl-materials">${materialRows(p)}</div>${button('confirm-assets',p.assetApproval && !dirty ? '重新确认素材' : '确认素材','',true)}</section></aside><div class="vl-main"><section class="vl-card" id="vl-analysis"><div class="vl-section-title"><div><h2>原片拆解</h2><p class="vl-section-subtitle">按时间记录画面、动作和台词。</p></div><div class="vl-actions">${analysisAction}${button('import-notes','导入文本')}</div></div>${analysisError}${sourceObservationMarkup(p)}<textarea class="vl-notes" data-project-field="sourceNotes" aria-label="原片拆解" placeholder="0–3 秒｜人物举起商品｜画外音：……&#10;3–8 秒｜产品特写｜……">${esc(p.sourceNotes)}</textarea></section>${planMarkup(p,'每段视频独立配置，随时可以调整。')}${resultsMarkup()}</div></div></div>`;
  }
  function outfitWorkbenchMarkup(p) {
    return `<div class="vl-workbench vl-outfit-workbench">${toolbarMarkup(p)}<nav class="vl-steps" aria-label="换装复刻流程"><a href="#vl-source"><span>1</span>Look 板</a><a href="#vl-analysis"><span>2</span>节奏</a><a href="#vl-plan"><span>3</span>编排</a><a href="#vl-results"><span>4</span>生成</a></nav><section class="vl-card vl-look-board" id="vl-source"><div class="vl-section-title"><div><h2>人物与服装</h2><p class="vl-section-subtitle">先整理人物和每一套 Look，再安排换装顺序。</p></div>${button('pick-material','添加素材')}</div><div class="vl-look-grid">${p.materials.length ? p.materials.map((m,i) => `<article class="vl-look-card">${media(m.assetId)}<div class="vl-look-card-fields"><input data-material-field="label" data-index="${i}" value="${esc(m.label)}" aria-label="素材名称" placeholder="素材名称">${select(`data-material-field="role" data-index="${i}" aria-label="素材用途"`, roles, m.role)}<input data-material-field="lookId" data-index="${i}" value="${esc(m.lookId)}" placeholder="Look 编号" aria-label="Look 编号">${button('remove-material','移除',`data-index="${i}"`)}</div></article>`).join('') : '<div class="vl-empty">先添加人物或服装素材。</div>'}</div>${button('confirm-assets',p.assetApproval && !dirty ? '重新确认素材' : '确认素材','',true)}</section><div class="vl-outfit-grid"><section class="vl-card vl-outfit-reference"><div class="vl-section-title"><h2>参考视频</h2>${button('pick-source',p.sourceAssetId ? '更换' : '选择视频')}</div>${p.sourceAssetId ? media(p.sourceAssetId, true) : '<div class="vl-upload-empty">选择一条换装参考视频。</div>'}<div class="vl-file-name">${esc(file(p.sourceAssetId)?.name || '')}</div><label>商品名称<input data-project-field="productName" value="${esc(p.productName)}" placeholder="例如：春季通勤系列" maxlength="120"></label></section><section class="vl-card" id="vl-analysis"><div class="vl-section-title"><div><h2>换装节奏</h2><p class="vl-section-subtitle">记录每套 Look 的出场、停留和切换。</p></div>${button('import-notes','导入文本')}</div><textarea class="vl-notes" data-project-field="sourceNotes" aria-label="换装节奏" placeholder="0–5 秒｜Look 01 出场，正面展示&#10;5–10 秒｜转身切换 Look 02&#10;10–15 秒｜Look 02 展示细节">${esc(p.sourceNotes)}</textarea><label>补充要求<textarea data-project-field="brief" rows="3" placeholder="想突出哪些 Look 或细节？">${esc(p.brief)}</textarea></label></section></div>${planMarkup(p,'每段对应一组换装动作，先确认素材再开始生成。')}${resultsMarkup()}</div>`;
  }
  function unitMarkup(unit, index) {
    const sourceRange = unit.sourceRange ? `<span class="vl-unit-source-range">原片 ${Number(unit.sourceRange.startSeconds).toFixed(1)}–${Number(unit.sourceRange.endSeconds).toFixed(1)} 秒</span>` : '';
    return `<article class="vl-card vl-unit"><div class="vl-section-title"><div class="vl-unit-title"><span>${String(index + 1).padStart(2,'0')}</span><b>${esc(unit.title)}</b>${sourceRange}</div>${button('remove-unit','移除',`data-id="${esc(unit.id)}"`)}</div><div class="vl-parameters"><label>模型与时长${select(`data-unit-field="modelId" data-unit="${esc(unit.id)}"`,project.type === 'outfit' ? {'seedance-2.5':'Seedance 2.5 · 30 秒'} : {'seedance-2.5':'Seedance 2.5 · 30 秒','seedance-2.0':'Seedance 2.0 · 15 秒'},unit.modelId)}</label><label>画幅${select(`data-unit-field="aspectRatio" data-unit="${esc(unit.id)}"`,{'9:16':'9:16','16:9':'16:9','1:1':'1:1'},unit.aspectRatio)}</label><label>清晰度${select(`data-unit-field="quality" data-unit="${esc(unit.id)}"`,{'720p':'720p','480p':'480p'},unit.quality)}</label></div><div class="vl-unit-refs">${project.materials.map(m => `<label><input type="checkbox" data-unit-ref data-unit="${esc(unit.id)}" value="${esc(m.assetId)}" ${unit.referenceAssetIds.includes(m.assetId) ? 'checked' : ''}>${esc(m.label || roles[m.role])}</label>`).join('')}</div><textarea data-unit-field="prompt" data-unit="${esc(unit.id)}" class="vl-prompt" aria-label="第 ${index+1} 段提示词" placeholder="写下这一段要发生的画面、动作和声音。">${esc(unit.prompt)}</textarea><div class="vl-unit-footer">${button('generate','生成',`data-id="${esc(unit.id)}"`,true)}</div></article>`;
  }
  function renderResults() {
    const target = root.querySelector('[data-vl-results]'); if (!target) return;
    target.innerHTML = tasks.length ? tasks.map(task => {
      const asset = file(task.assetId);
      const download = task.status === 'completed' && task.assetId ? `<a class="secondary-button vl-result-download" href="${esc(asset?.url || `/api/files/${encodeURIComponent(task.assetId)}/content`)}" download>下载成片</a>` : '';
      return `<article class="vl-result"><div><b>${esc(project.units.find(u => u.id === task.viralUnitId)?.title || '历史分段')}</b><span>${statuses[task.status] || '处理中'}</span>${task.status === 'completed' && task.assetId ? media(task.assetId,true) : ''}<p>${esc(task.error || '')}</p>${task.status === 'completed' ? `<div class="vl-result-file">已保存到文件库${asset ? `：${esc(asset.name)}` : ''}</div>` : ''}</div><div class="vl-result-actions">${download}${task.status === 'failed' ? button('retry','重试',`data-id="${esc(task.viralUnitId)}"`) : ''}</div></article>`;
    }).join('') : '<p class="vl-empty-copy">生成结果会出现在这里。</p>';
  }
  async function choose(kind, onSelect, current) {
    await loadFiles(); current();
    const dialog = document.createElement('dialog'); dialog.className = 'vl-dialog';
    const draw = () => { dialog.innerHTML = `<header><h3>${kind === 'source' ? '选择参考视频' : '选择创作素材'}</h3><button type="button" data-close aria-label="关闭"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><input type="search" data-search placeholder="搜索素材" aria-label="搜索素材"><div class="vl-picker">${state.files.filter(f => kind === 'source' ? f.kind === 'video' : ['image','audio'].includes(f.kind)).map(f => `<button type="button" data-file="${esc(f.id)}" data-name="${esc(f.name.toLowerCase())}">${media(f.id)}<span>${esc(f.name)}</span></button>`).join('')}</div><footer>${button('upload','上传本地素材')}</footer>`; };
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
      if (action === 'analyze-source') {
        const quote = await post(`${base}/${project.id}/source-quote`,{revision:project.revision});current();
        if (!await confirmCost('分析参考视频',`预计消耗 ${quote.maxCredits.toFixed(3)} 积分，确认继续吗？`)) return;
        current(); notice('正在分析参考视频…');
        const result = await post(`${base}/${project.id}/source-analyze`,{revision:project.revision,quoteId:quote.quoteId},{timeoutMs:240000});current();project=result.project;setCreditBalance(result.balance);render();return;
      }
      if (action === 'ai-plan') {
        if (!capabilities.aiPlan) throw new Error('AI 方案服务暂不可用，可以先填写或粘贴已有提示词');
        const quote = await post(`${base}/${project.id}/plan-quote`,{revision:project.revision});current();
        if (!await confirmCost('AI 整理制作方案',`预计消耗 ${quote.maxCredits.toFixed(3)} 积分，确认继续吗？`)) return;
        current(); notice('AI 正在整理方案…');
        const result = await post(`${base}/${project.id}/plan`,{revision:project.revision,quoteId:quote.quoteId},{timeoutMs:210000});current();project=result.project;setCreditBalance(result.balance);render();return;
      }
      if (action === 'generate' || action === 'retry') {
        if (!project.planApproval) throw new Error('请先确认制作方案');
        if (project.materials.some(m=>m.role==='identity')) throw new Error('当前素材暂时无法生成，请更换后再试');
        const unit = project.units.find(u=>u.id===el.dataset.id); if (!unit) throw new Error('请在当前方案中选择分段');
        if ([...unit.prompt].length>4096) throw new Error('提示词有些长，请精简后再试');
        const generationReferenceIds = [project.sourceAssetId, ...unit.referenceAssetIds.filter(id => id !== project.sourceAssetId)];
        const quote = await post('/api/model-quote',{...unit,referenceAssetIds:generationReferenceIds,type:'video',generationType:'REFERENCE',exactReferencePrice:true});current();
        if (!await confirmCost(action === 'retry' ? '重新生成这一段' : '生成这一段',`预计消耗 ${quote.credits} 积分，确认继续吗？`)) return;
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
