import { createGenerationPresentation } from '../generation/presentation.js?v=4';

const roles = { product:'商品图', identity:'人物参考图', look:'服装参考图', storyboard:'分镜图片', scene:'场景参考', audio:'声音参考' };
export function createViralLab({ api, state, esc, toast, uploadAsset, loadFiles, loadTasks, scheduleTaskPoll, setCreditBalance, accountSnapshot, isAccountCurrent }) {
  const root = document.querySelector('#viralLabView');
  const motionPanel = document.querySelector('#motionGeneratorPanel');
  const appShell = document.querySelector('#appView');
  const routeTitle = document.querySelector('#routeTitle');
  const motionBack = document.querySelector('#labMotionBack');
  let project = null, assets = [], busy = false, dirty = false, epoch = 0;
  let capabilities = {};
  let tasks = [], taskTimer = null, visible = false, tasksOpen = false, taskRefreshVersion = 0, taskRefreshError = false;
  let motionOpen = false, motionTasks = [], motionTaskTimer = null, motionRefreshVersion = 0, motionRefreshError = false;
  const { videoProgressMarkup } = createGenerationPresentation({ escapeHtml:esc });
  const motion = { imageAssetIds: [], videoAssetId: '', videoDuration: 0, resolution: '464*832px(竖版)' };
  const base = '/api/viral-lab/projects';
  const post = (url, body, options = {}) => api(url, { method:'POST', body:JSON.stringify(body), ...options });
  const file = id => state.files.find(item => item.id === id) || assets.find(item => item.id === id);
  const sortFilesByRecency = files => [...files].sort((left, right) => {
    const leftTime = Date.parse(String(left?.createdAt || left?.updatedAt || ''));
    const rightTime = Date.parse(String(right?.createdAt || right?.updatedAt || ''));
    if (Number.isFinite(leftTime) || Number.isFinite(rightTime)) {
      const timeOrder = (Number.isFinite(rightTime) ? rightTime : -Infinity) - (Number.isFinite(leftTime) ? leftTime : -Infinity);
      if (timeOrder) return timeOrder;
    }
    return String(right?.id || '').localeCompare(String(left?.id || ''));
  });
  const button = (action, label, extra = '', primary = false) => `<button type="button" class="${primary ? 'gradient-button' : 'secondary-button'}" data-vl="${action}" ${extra}>${label}</button>`;
  const select = (attr, options, value) => `<select ${attr}>${Object.entries(options).map(([id, label]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const qualityOptions = modelId => capabilities.qualityOptions?.[modelId] || [];
  function media(id, controls = false) {
    const asset = file(id);
    if (!asset) return '<div class="vl-placeholder">素材不可用，请重新选择</div>';
    const url = esc(asset.url || `/api/files/${encodeURIComponent(id)}/content`);
    if (asset.kind === 'image') return `<img src="${esc(asset.previewUrl || asset.url || `/api/files/${encodeURIComponent(id)}/preview`)}" alt="${esc(asset.name)}" loading="lazy">`;
    if (asset.kind === 'video') return `<video src="${url}" ${controls ? 'controls' : 'muted'} preload="metadata"></video>`;
    return `<audio src="${url}" controls preload="none"></audio>`;
  }
  function setMotionHeader(active) {
    appShell?.classList.toggle('lab-motion-open', active);
    if (state.route === 'lab' && routeTitle) {
      routeTitle.textContent = active ? '动作迁移' : '实验室';
      document.title = `${active ? '动作迁移' : '实验室'} · GuGu AI`;
      appShell?.classList.toggle('wide-mode', !active);
      document.querySelector('#creatorPanel')?.classList.toggle('hidden', !active);
      if (active) document.querySelectorAll('[data-panel]').forEach(panel => panel.classList.add('hidden'));
    }
    if (motionPanel) motionPanel.classList.toggle('hidden', !active);
  }
  function notice(message) {
    const target = motionPanel?.querySelector('[data-vl-message]') || root.querySelector('[data-vl-message]');
    target?.replaceChildren(document.createTextNode(message));
  }
  function collectMotion() {
    if (!motionOpen) return;
    const duration = Number(motion.videoDuration);
    motion.videoDuration = Number.isFinite(duration) && duration > 0 ? Math.min(120, Math.ceil(duration)) : 0;
  }
  function motionAspectRatio() { return motion.resolution === '832*464px(横版)' ? '16:9' : '9:16'; }
  function motionPrompt() { return '将动作参考视频中的动作迁移到人物照片上。'; }
  function motionFileUrl(asset) { return asset?.url || `/api/files/${encodeURIComponent(asset?.id || '')}/content`; }
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
    const controls = [...root.querySelectorAll('button,input,select,textarea'), ...(motionPanel?.querySelectorAll('button,input,select,textarea') || [])].map(el => [el, el.disabled]);
    controls.forEach(([el]) => { el.disabled = true; });
    try { await work(current); current(); }
    catch (error) { if (!error.stale) {
      // Analysis/planning changes the revision even when the request fails.
      if (project && !dirty) {
        try { const result = await api(`${base}/${project.id}`); current(); project = result.project; assets = result.assets; render(); } catch { /* Keep the original error and draft. */ }
      }
      if (captured === epoch && isAccountCurrent(scope)) { notice(error.message); toast(error.message); }
    } }
    finally { if (captured === epoch && isAccountCurrent(scope)) { busy = false; controls.forEach(([el, disabled]) => { if (el.isConnected) el.disabled = disabled; }); renderTasks(); } }
  }
  async function load() {
    visible = true;
    await run(async current => {
      const result = await api(base); current(); capabilities = result.capabilities;
      render();
    });
    void refreshTasks();
    void refreshMotionTasks();
  }
  function render() {
    renderWorkbench();
    if (motionOpen) { renderMotionTasks(); return; }
    if (!project && !motionOpen) return;
    const host = document.createElement('div'); host.dataset.vlTasks = '';
    root.append(host); renderTasks();
  }
  function renderTasks() {
    const host = root.querySelector('[data-vl-tasks]'); if (!host) return;
    root.querySelectorAll('[data-vl="generate"],[data-vl="retry"]').forEach(el => {
      const attempts = tasks.filter(task => task.viralProjectId === project?.id && task.viralUnitId === el.dataset.id && task.viralPlanHash === project?.planApproval?.hash);
      const task = attempts.find(task => task.id === project?.planApproval?.requests?.[el.dataset.id]);
      el.dataset.vl = task?.status === 'failed' ? 'retry' : 'generate';
      el.textContent = task?.status === 'failed' ? attempts.length < 2 ? '重试这一段' : '请修改方案后生成' : task ? task.assetId ? '已生成' : '正在生成' : '生成';
      el.disabled = !qualityOptions(project.units.find(unit => unit.id === el.dataset.id)?.modelId).length || Boolean(task && (task.status !== 'failed' || attempts.length >= 2));
    });
    const active = tasks.filter(task => ['queued','running'].includes(task.status)).length;
    if (!host.firstElementChild) {
      host.innerHTML = '<details class="vl-card vl-task-list"><summary></summary><div class="vl-task-rows"></div></details>';
      host.querySelector('details').addEventListener('toggle', event => { tasksOpen = event.target.open; });
    }
    host.querySelector('details').open = tasksOpen;
    host.querySelector('summary').textContent = `生成进度 · ${active} 个进行中 · 最近 ${tasks.length} 条${taskRefreshError ? ' · 进度刷新失败，正在重试' : ''}`;
    const rows = host.querySelector('.vl-task-rows');
    const ids = new Set(tasks.map(task => task.id));
    [...rows.children].forEach(row => { if (!ids.has(row.dataset.task)) row.remove(); });
    tasks.forEach((task, index) => {
      let row = [...rows.children].find(item => item.dataset.task === task.id);
      if (!row) { row = document.createElement('article'); row.className = 'vl-task-row'; row.dataset.task = task.id; }
      const signature = JSON.stringify(task);
      if (row._vlTaskSignature !== signature) {
      const status = ({queued:'排队中',running:'生成中',completed:'已完成',succeeded:'已完成',failed:'生成失败'})[task.status] || task.status;
      const progress = Number(task.progress);
      const result = task.assetId ? `<video controls preload="none" src="/api/files/${encodeURIComponent(task.assetId)}/content"></video><p>视频已完成，可以播放</p>` : '';
      row.innerHTML = `<div><b>复刻视频${task.duration ? ` · ${esc(task.duration)} 秒` : ''}</b><span role="status">${esc(status)}${['queued','running'].includes(task.status) && task.progress != null && Number.isFinite(progress) ? ` · ${Math.max(0,Math.min(100,Math.round(progress)))}%` : ''}</span></div><p>${esc(task.createdAt ? new Date(task.createdAt).toLocaleString() : '')}</p>${task.error ? `<p class="vl-alert">${esc(task.error)}</p>` : ''}${result}${task.status === 'failed' ? button('open-task','查看方案与重试',`data-project="${esc(task.viralProjectId)}"`) : ''}`;
      row._vlTaskSignature = signature;
      }
      if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] || null);
    });
    if (!tasks.length) rows.innerHTML = '<p class="vl-help">开始生成后可在这里查看进度和视频，也可以继续制作新的内容。</p>';
  }
  function renderMotionTasks() {
    const host = root.querySelector('[data-motion-tasks]');
    if (!host) return;
    const count = root.querySelector('[data-motion-task-count]');
    if (count) count.textContent = `${motionTasks.length} 条`;
    const rows = motionTasks.map(task => {
      const stateClass = task.status === 'succeeded' ? 'completed' : task.status;
      const progressMarkup = videoProgressMarkup(task);
      const media = task.assetId
        ? `<div class="card-media video"><video controls preload="metadata" src="/api/files/${encodeURIComponent(task.assetId)}/content"></video></div>`
        : task.status === 'failed'
          ? `<div class="card-failure"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 17h.01"/><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg><b>生成失败</b><p>${esc(task.error || '请检查输入素材后重试')}</p></div>`
          : `<div class="card-placeholder ${esc(stateClass)}"${progressMarkup ? '' : ' aria-hidden="true"'}><div class="skeleton-frame"><i></i><i></i><i></i></div>${progressMarkup}</div>`;
      return `<article class="task-card ${esc(stateClass)}"><div class="card-visual">${media}</div></article>`;
    }).join('');
    const empty = '<div class="empty-state"><div class="empty-orbit"><i></i><i></i><i></i></div><h3>还没有动作迁移作品</h3><p>完成左侧参数设置后，生成结果会显示在这里。</p></div>';
    host.innerHTML = rows || empty;
  }
  async function refreshMotionTasks() {
    clearTimeout(motionTaskTimer);
    const captured = epoch, scope = accountSnapshot(), refreshVersion = ++motionRefreshVersion;
    try {
      await loadTasks({ background:true });
      if (captured !== epoch || refreshVersion !== motionRefreshVersion || !isAccountCurrent(scope)) return;
      const next = state.tasks.filter(task => task.type === 'video' && task.videoModelId === 'motion-retargeting');
      const changed = motionRefreshError || JSON.stringify(motionTasks) !== JSON.stringify(next);
      motionRefreshError = false;
      if (changed) { motionTasks = next; renderMotionTasks(); }
    } catch (error) {
      if (captured === epoch && refreshVersion === motionRefreshVersion && isAccountCurrent(scope)) {
        motionRefreshError = true;
        notice(`动作迁移记录刷新失败：${error.message}`);
      }
    } finally {
      if (visible && motionOpen && captured === epoch && refreshVersion === motionRefreshVersion && isAccountCurrent(scope)) motionTaskTimer = setTimeout(refreshMotionTasks, 5000);
    }
  }
  function updateMotionCost() {
    collectMotion();
    const duration = Math.max(0, Number(motion.videoDuration) || 0);
    const count = motion.imageAssetIds.length;
    const total = duration * count;
    motionPanel?.querySelectorAll('[data-motion-cost]').forEach(el => { el.textContent = total ? `${total}` : '—'; });
    const submit = motionPanel?.querySelector('[data-vl="motion-generate"]');
    if (submit) submit.disabled = !count || !motion.videoAssetId || !duration;
  }
  async function readMotionVideoDuration(current) {
    const asset = file(motion.videoAssetId);
    if (!asset) return;
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = motionFileUrl(asset);
    try {
      const duration = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('读取参考素材超时')), 10000);
        video.onloadedmetadata = () => { clearTimeout(timer); resolve(video.duration); };
        video.onerror = () => { clearTimeout(timer); reject(new Error('参考素材不可用')); };
      });
      current();
      if (Number.isFinite(duration) && duration > 0) motion.videoDuration = Math.min(120, Math.ceil(duration));
    } catch (error) {
      if (!error.stale) notice('无法处理该参考视频，请更换视频后重试');
    } finally { video.removeAttribute('src'); video.load(); }
  }
  function motionWorkbenchMarkup(region) {
    const selectedImages = motion.imageAssetIds.map(id => file(id)).filter(Boolean);
    const selectedVideo = file(motion.videoAssetId);
    const imageCards = selectedImages.map(asset => `<div class="reference-thumb motion-reference-thumb">${media(asset.id)}<button type="button" data-vl="motion-image-remove" data-id="${esc(asset.id)}" aria-label="移除${esc(asset.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div>`).join('');
    const imageAction = `<button class="add-reference pick-reference" data-vl="pick-motion-image" type="button" aria-label="添加人物照片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>添加</span></button>`;
    const videoCard = selectedVideo ? `<div class="reference-thumb motion-reference-thumb motion-video-thumb">${media(selectedVideo.id)}<span class="motion-reference-name">${esc(selectedVideo.name)}</span></div>` : '';
    const videoAction = `<button class="add-reference pick-reference" data-vl="pick-motion-video" type="button" aria-label="添加动作参考视频"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>${selectedVideo ? '更换' : '添加'}</span></button>`;
    const submitDisabled = !selectedImages.length || !selectedVideo || !motion.videoDuration;
    const option = (key, value, label) => `<button type="button" class="${motion[key] === value ? 'selected' : ''}" data-vl="motion-option" data-motion-key="${key}" data-motion-value="${esc(value)}">${label}</button>`;
    if (region === 'works') return `<section class="vl-motion-gallery"><header class="content-head"><div class="generation-tabs" role="tablist" aria-label="动作迁移作品视图"><button class="generation-tab active" type="button" role="tab" aria-selected="true">我的作品</button></div></header><div data-motion-tasks class="creation-grid vl-motion-creation-grid"></div></section>`;
    const totalCost = motion.videoDuration && selectedImages.length ? `${motion.videoDuration * selectedImages.length}` : '—';
    return `<div class="vl-motion-generator generator-form"><p class="vl-motion-live vl-motion-sr-only" data-vl-message role="status" aria-live="polite"></p><div class="reference-head"><span class="field-label">人物照片</span></div><div class="reference-strip motion-reference-strip">${imageAction}${imageCards}</div>${selectedImages.length > 1 ? `<p class="vl-motion-selection-note">已选 ${selectedImages.length} 个角色</p>` : ''}<div class="reference-head"><span class="field-label">动作参考视频</span></div><div class="reference-strip motion-reference-strip motion-video-strip">${videoAction}${videoCard}</div><div class="control-section motion-control-section"><span class="field-label">分辨率</span><div class="ratio-grid motion-resolution-grid">${option('resolution','464*832px(竖版)','<span class="ratio-frame"><i style="width:16px;height:23px"></i></span><span>竖版</span><small>464 × 832</small>')} ${option('resolution','832*464px(横版)','<span class="ratio-frame"><i style="width:27px;height:16px"></i></span><span>横版</span><small>832 × 464</small>')}</div></div><button class="gradient-button generate" type="button" data-vl="motion-generate" ${submitDisabled ? 'disabled' : ''}><span>生成视频</span><span class="button-cost"><b data-motion-cost>${totalCost}</b> 积分</span></button></div>`;
  }
  async function refreshTasks() {
    clearTimeout(taskTimer);
    const captured = epoch, scope = accountSnapshot(), refreshVersion = ++taskRefreshVersion;
    try {
      const result = await api('/api/viral-lab/tasks');
      if (captured !== epoch || refreshVersion !== taskRefreshVersion || !isAccountCurrent(scope)) return;
      const changed = taskRefreshError || JSON.stringify(tasks) !== JSON.stringify(result.tasks);
      taskRefreshError = false;
      if (changed) { tasks = result.tasks; renderTasks(); }
    } catch { if (captured === epoch && refreshVersion === taskRefreshVersion && isAccountCurrent(scope)) { taskRefreshError = true; renderTasks(); } }
    finally { if (visible && captured === epoch && refreshVersion === taskRefreshVersion && isAccountCurrent(scope)) taskTimer = setTimeout(refreshTasks, 5000); }
  }
  function renderWorkbench() {
    if (motionOpen) {
      setMotionHeader(true);
      motionPanel.innerHTML = motionWorkbenchMarkup('controls');
      root.innerHTML = motionWorkbenchMarkup('works');
      return;
    }
    setMotionHeader(false);
    if (motionPanel) motionPanel.replaceChildren();
    if (!project) {
      root.innerHTML = `<div class="vl-home"><div class="vl-entry-grid"><button type="button" class="vl-entry vl-entry-motion" data-vl="create-motion" data-vl-coming-soon="true" aria-disabled="true" aria-label="动作迁移，功能即将推出，敬请期待"><span class="vl-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.5"/><path d="m8 10 4-2 4 2M10 9l-1 6 3 2 3-2-1-6M12 17v4M8 21l4-4 4 4"/></svg></span><span class="vl-entry-copy"><h2>动作迁移</h2><p>上传人物照片和动作视频，让照片中的人物跳起来。</p></span><span class="vl-entry-action">敬请期待</span></button><button type="button" class="vl-entry" data-vl="create" data-vl-coming-soon="true" data-type="replica" aria-disabled="true" aria-label="爆款视频复刻，功能即将推出，敬请期待"><span class="vl-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7V5Z"/><path d="M4 5v14"/></svg></span><span class="vl-entry-copy"><h2>爆款视频复刻</h2><p>保留镜头节奏，替换成你的商品和表达。</p></span><span class="vl-entry-action">敬请期待</span></button><button type="button" class="vl-entry vl-entry-outfit" data-vl="create" data-vl-coming-soon="true" data-type="outfit" aria-disabled="true" aria-label="电商换装复刻，功能即将推出，敬请期待"><span class="vl-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 4h8l2 4-3 2v10H9V10L6 8l2-4Z"/><path d="M9 10h6"/></svg></span><span class="vl-entry-copy"><h2>电商换装复刻</h2><p>整理人物和服装，安排一条完整的换装表达。</p></span><span class="vl-entry-action">敬请期待</span></button></div><p data-vl-message role="status"></p></div>`;
      return;
    }
    const p = project;
    root.innerHTML = p.type === 'outfit' ? outfitWorkbenchMarkup(p) : replicaWorkbenchMarkup(p);
  }
  function toolbarMarkup() {
    return `<header class="vl-toolbar">${button('back','<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg><span>实验室</span>')}<span class="vl-toolbar-status" data-vl-message role="status">${dirty ? '有未保存的修改' : '本次创作'}</span></header>`;
  }
  function materialRows(p) {
    return p.materials.map((m,i) => `<article>${media(m.assetId)}<div><input data-material-field="label" data-index="${i}" value="${esc(m.label)}" aria-label="素材名称" placeholder="素材名称">${select(`data-material-field="role" data-index="${i}" aria-label="素材用途"`, roles, m.role)}<input data-material-field="lookId" data-index="${i}" value="${esc(m.lookId)}" placeholder="服装编号（可选）" aria-label="服装编号">${button('remove-material','移除',`data-index="${i}"`)}</div></article>`).join('');
  }
  function planMarkup(p, subtitle) {
    return `<section id="vl-plan"><div class="vl-section-title"><div><h2>制作方案</h2><p class="vl-section-subtitle">${subtitle}</p></div><div class="vl-actions">${button('add-unit','添加分段')}${button('ai-plan','AI 整理')}</div></div>${p.planError ? `<p class="vl-alert">${esc(p.planError)}</p>` : ''}${p.planning ? '<p class="vl-alert">正在整理方案…</p>' : ''}${p.units.map((u,i) => unitMarkup(u,i)).join('')}<div class="vl-confirm-strip"><p>方案准备好后即可开始生成，完成后可以直接查看。</p>${button('confirm-plan',p.planApproval && !dirty ? '重新确认方案' : '确认方案','',true)}</div></section>`;
  }
  function sourceObservationMarkup(p) {
    const observation = p.sourceObservation;
    if (!observation) return '<div class="vl-analysis-empty">分析后会显示原视频中的画面和动作。目前不会自动识别声音，请在下方补充台词和声音，再用 AI 整理创作描述。</div>';
    const timeline = (observation.timeline || []).map(item => `<div class="vl-observation-beat"><time>${item.startSeconds.toFixed(1)}–${item.endSeconds.toFixed(1)} 秒</time><div><b>${esc(item.visualAction || '画面保持')}</b>${item.spokenContent ? `<p>${esc(item.speakerMode === 'voiceover' ? `画外音：${item.spokenContent}` : item.spokenContent)}</p>` : ''}${item.visibleText?.length ? `<span>${esc(item.visibleText.join(' · '))}</span>` : ''}</div></div>`).join('');
    return `<div class="vl-observation"><p class="vl-observation-summary">${esc(observation.summary || '已完成原片观察，可在下方补充细节。')}</p><div class="vl-observation-timeline">${timeline || '<p class="vl-analysis-empty">暂未识别到可编辑的时间段。</p>'}</div>${observation.uncertainties?.length ? `<p class="vl-observation-note">${esc(observation.uncertainties[0])}</p>` : ''}</div>`;
  }
  function replicaWorkbenchMarkup(p) {
    const analysisAction = capabilities.automaticSourceAnalysis ? button('analyze-source', p.sourceAnalysisState?.status === 'running' ? '重新分析' : p.sourceObservation ? '重新分析' : '分析画面', p.sourceAssetId ? '' : 'disabled') : '';
    const analysisError = p.sourceAnalysisState?.status === 'failed' ? '<p class="vl-alert">原片分析没有完成，可以重试或直接编辑拆解。</p>' : '';
    return `<div class="vl-workbench vl-replica-workbench">${toolbarMarkup()}<nav class="vl-steps" aria-label="视频复刻流程"><a href="#vl-source"><span>1</span>参考</a><a href="#vl-analysis"><span>2</span>拆解</a><a href="#vl-plan"><span>3</span>分段</a><a href="#vl-plan"><span>4</span>生成</a></nav><div class="vl-columns"><aside class="vl-source" id="vl-source"><section class="vl-card"><div class="vl-section-title"><h2>参考视频</h2>${button('pick-source',p.sourceAssetId ? '更换' : '选择视频')}</div>${p.sourceAssetId ? media(p.sourceAssetId, true) : '<div class="vl-upload-empty">选择一条视频，作为这次创作的节奏参考。</div>'}<div class="vl-file-name">${esc(file(p.sourceAssetId)?.name || '')}</div><label>商品名称<input data-project-field="productName" value="${esc(p.productName)}" placeholder="例如：夏日亚麻套装" maxlength="120"></label><label>创作要求<textarea data-project-field="brief" rows="3" placeholder="想保留什么，想替换什么？">${esc(p.brief)}</textarea></label></section><section class="vl-card"><div class="vl-section-title"><h2>创作素材</h2>${button('pick-material','添加素材')}</div><p class="vl-help">把这次创作会用到的素材放在这里。</p><div class="vl-materials">${materialRows(p)}</div>${button('confirm-assets',p.assetApproval && !dirty ? '重新确认素材' : '确认素材','',true)}</section></aside><div class="vl-main"><section class="vl-card" id="vl-analysis"><div class="vl-section-title"><div><h2>原片拆解</h2><p class="vl-section-subtitle">自动分析画面与动作；台词和声音需手动补充。</p></div><div class="vl-actions">${analysisAction}${button('import-notes','导入文本')}</div></div>${analysisError}${sourceObservationMarkup(p)}<textarea class="vl-notes" data-project-field="sourceNotes" aria-label="原片拆解" placeholder="0–3 秒｜人物举起商品｜画外音：……&#10;3–8 秒｜产品特写｜……">${esc(p.sourceNotes)}</textarea></section>${planMarkup(p,'每段视频独立配置，随时可以调整。')}</div></div></div>`;
  }
  function outfitWorkbenchMarkup(p) {
    return `<div class="vl-workbench vl-outfit-workbench">${toolbarMarkup()}<nav class="vl-steps" aria-label="换装复刻流程"><a href="#vl-source"><span>1</span>搭配</a><a href="#vl-analysis"><span>2</span>节奏</a><a href="#vl-plan"><span>3</span>安排</a><a href="#vl-plan"><span>4</span>生成</a></nav><section class="vl-card vl-look-board" id="vl-source"><div class="vl-section-title"><div><h2>人物与服装</h2><p class="vl-section-subtitle">先整理人物和每一套搭配，再安排换装顺序。</p></div>${button('pick-material','添加素材')}</div><div class="vl-look-grid">${p.materials.length ? p.materials.map((m,i) => `<article class="vl-look-card">${media(m.assetId)}<div class="vl-look-card-fields"><input data-material-field="label" data-index="${i}" value="${esc(m.label)}" aria-label="素材名称" placeholder="素材名称">${select(`data-material-field="role" data-index="${i}" aria-label="素材用途"`, roles, m.role)}<input data-material-field="lookId" data-index="${i}" value="${esc(m.lookId)}" placeholder="搭配编号" aria-label="搭配编号">${button('remove-material','移除',`data-index="${i}"`)}</div></article>`).join('') : '<div class="vl-empty">先添加人物或服装素材。</div>'}</div>${button('confirm-assets',p.assetApproval && !dirty ? '重新确认素材' : '确认素材','',true)}</section><div class="vl-outfit-grid"><section class="vl-card vl-outfit-reference"><div class="vl-section-title"><h2>参考视频</h2>${button('pick-source',p.sourceAssetId ? '更换' : '选择视频')}</div>${p.sourceAssetId ? media(p.sourceAssetId, true) : '<div class="vl-upload-empty">选择一条换装参考视频。</div>'}<div class="vl-file-name">${esc(file(p.sourceAssetId)?.name || '')}</div><label>商品名称<input data-project-field="productName" value="${esc(p.productName)}" placeholder="例如：春季通勤系列" maxlength="120"></label></section><section class="vl-card" id="vl-analysis"><div class="vl-section-title"><div><h2>换装节奏</h2><p class="vl-section-subtitle">记录每套搭配的出场、停留和切换。</p></div>${button('import-notes','导入文本')}</div><textarea class="vl-notes" data-project-field="sourceNotes" aria-label="换装节奏" placeholder="0–5 秒｜搭配 01 出场，正面展示&#10;5–10 秒｜转身切换 搭配 02&#10;10–15 秒｜搭配 02 展示细节">${esc(p.sourceNotes)}</textarea><label>补充要求<textarea data-project-field="brief" rows="3" placeholder="想突出哪些 搭配 或细节？">${esc(p.brief)}</textarea></label></section></div>${planMarkup(p,'每段对应一组换装动作，先确认素材再开始生成。')}</div>`;
  }
  function unitMarkup(unit, index) {
    const sourceRange = unit.sourceRange ? `<span class="vl-unit-source-range">原片 ${Number(unit.sourceRange.startSeconds).toFixed(1)}–${Number(unit.sourceRange.endSeconds).toFixed(1)} 秒</span>` : '';
    return `<article class="vl-card vl-unit"><div class="vl-section-title"><div class="vl-unit-title"><span>${String(index + 1).padStart(2,'0')}</span><b>${esc(unit.title)}</b>${sourceRange}</div>${button('remove-unit','移除',`data-id="${esc(unit.id)}"`)}</div><div class="vl-parameters"><label>模型与时长${select(`data-unit-field="modelId" data-unit="${esc(unit.id)}"`,project.type === 'outfit' ? {'seedance-2.5':'Seedance 2.5 · 30 秒'} : {'seedance-2.5':'Seedance 2.5 · 30 秒','seedance-2.0':'Seedance 2.0 · 15 秒'},unit.modelId)}</label><label>画幅${select(`data-unit-field="aspectRatio" data-unit="${esc(unit.id)}"`,{'9:16':'9:16','16:9':'16:9','1:1':'1:1'},unit.aspectRatio)}</label><label>清晰度${select(`data-unit-field="quality" data-unit="${esc(unit.id)}"`,Object.fromEntries(qualityOptions(unit.modelId).map(quality => [quality, quality])),unit.quality)}</label></div><div class="vl-unit-refs">${project.materials.map(m => `<label><input type="checkbox" data-unit-ref data-unit="${esc(unit.id)}" value="${esc(m.assetId)}" ${unit.referenceAssetIds.includes(m.assetId) ? 'checked' : ''}>${esc(m.label || roles[m.role])}</label>`).join('')}</div><textarea data-unit-field="prompt" data-unit="${esc(unit.id)}" class="vl-prompt" aria-label="第 ${index+1} 段描述" placeholder="写下这一段要发生的画面、动作和声音。">${esc(unit.prompt)}</textarea><div class="vl-unit-footer">${button('generate','生成',`data-id="${esc(unit.id)}"`,true)}</div></article>`;
  }
  async function choose(kind, onSelect, current) {
    await loadFiles(); current();
    const dialog = document.createElement('dialog'); dialog.className = 'vl-dialog';
    const allowedKinds = { source:['video'], material:['image','audio'], image:['image'], video:['video'] }[kind] || ['image','audio'];
    const title = { source:'选择参考视频', material:'选择创作素材', image:'选择人物照片', video:'选择动作视频' }[kind] || '选择创作素材';
    const draw = () => { dialog.innerHTML = `<header><h3>${title}</h3><button type="button" data-close aria-label="关闭"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><input type="search" data-search placeholder="搜索素材" aria-label="搜索素材"><div class="vl-picker">${sortFilesByRecency(state.files.filter(f => allowedKinds.includes(f.kind))).map(f => `<button type="button" data-file="${esc(f.id)}" data-name="${esc(f.name.toLowerCase())}">${media(f.id)}<span>${esc(f.name)}</span></button>`).join('')}</div><footer>${button('upload','上传素材')}</footer>`; };
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
            if (f && allowedKinds.includes(f.kind)) { onSelect(f); close(); }
            else if (f) toast(`请选择${allowedKinds.includes('video') ? '视频' : allowedKinds.includes('audio') ? '图片或音频' : '图片'}文件`);
          }
        } catch (error) { close(); if (!error.stale) toast(error.message); }
      };
    });
  }
  async function confirmCost(title, message) {
    const dialog = document.createElement('dialog'); dialog.className = 'vl-dialog vl-cost';
    dialog.innerHTML = `<header><h3>${esc(title)}</h3></header><p>${esc(message)}</p><footer><button type="button" data-no class="secondary-button">返回修改</button><button type="button" data-yes class="gradient-button">确认并继续</button></footer>`;
    document.body.append(dialog); dialog.showModal();
    return new Promise(resolve => { let accepted = false; dialog.querySelector('[data-no]').onclick = () => dialog.close(); dialog.querySelector('[data-yes]').onclick = () => { accepted = true; dialog.close(); }; dialog.onclose = () => { dialog.remove(); resolve(accepted); }; });
  }
  const handleInput = event => {
    if (motionOpen && motionPanel?.contains(event.target)) { collectMotion(); updateMotionCost(); return; }
    dirty = true; notice('有未保存的修改');
  };
  const handleChange = event => {
    if (motionOpen && motionPanel?.contains(event.target)) { collectMotion(); updateMotionCost(); return; }
    if (event.target.matches('select,[data-unit-ref]')) { collect(); dirty = true; render(); }
  };
  root.addEventListener('input', handleInput);
  root.addEventListener('change', handleChange);
  motionPanel?.addEventListener('input', handleInput);
  motionPanel?.addEventListener('change', handleChange);
  motionBack?.addEventListener('click', () => {
    if (!motionOpen) return;
    motionOpen = false;
    render();
  });
  document.addEventListener('click', event => {
    const el = event.target.closest('[data-vl]'); if (!el) return;
    if (!root.contains(el) && !motionPanel?.contains(el)) return;
    if (el.dataset.vlComingSoon === 'true') {
      const message = '功能即将推出，敬请期待';
      toast(message);
      return;
    }
    void run(async current => {
      const action = el.dataset.vl;
      if (action === 'open-task') {
        await save(); current();
        const result = await api(`${base}/${el.dataset.project}`); current();
        project = result.project; assets = result.assets; dirty = false; render(); return;
      }
      if (action === 'create') { const result = await post(base, { type:el.dataset.type, title:el.dataset.type === 'outfit' ? '我的换装实验' : '我的视频复刻' }); current(); project = result.project; assets = []; dirty = false; render(); return; }
      if (action === 'create-motion') { motionOpen = true; project = null; assets = []; dirty = false; motion.imageAssetIds = []; motion.videoAssetId = ''; motion.videoDuration = 0; motion.resolution = '464*832px(竖版)'; render(); void refreshMotionTasks(); return; }
      if (action === 'back') { if (motionOpen) { motionOpen = false; render(); return; } await save(); current(); project = null; render(); return; }
      if (motionOpen) {
        if (action === 'motion-option') {
          const key = el.dataset.motionKey;
          if (key === 'resolution') { motion[key] = el.dataset.motionValue; render(); }
          return;
        }
        if (action === 'pick-motion-image') {
          await choose('image', f => { if (!f) return; assets = [f, ...assets.filter(a => a.id !== f.id)]; if (!motion.imageAssetIds.includes(f.id)) motion.imageAssetIds.push(f.id); }, current);
          current(); render(); return;
        }
        if (action === 'motion-image-remove') { motion.imageAssetIds = motion.imageAssetIds.filter(id => id !== el.dataset.id); render(); return; }
        if (action === 'pick-motion-video') {
          await choose('video', f => { if (!f) return; assets = [f, ...assets.filter(a => a.id !== f.id)]; motion.videoAssetId = f.id; motion.videoDuration = 0; }, current);
          current();
          if (motion.videoAssetId) await readMotionVideoDuration(current);
          current(); render(); return;
        }
        if (action === 'motion-generate') {
          collectMotion();
          const imageIds = [...motion.imageAssetIds];
          const duration = Number(motion.videoDuration);
          if (!imageIds.length) throw new Error('请先选择至少一张人物照片');
          if (!motion.videoAssetId) throw new Error('请先选择动作参考视频');
          if (!Number.isSafeInteger(duration) || duration < 1 || duration > 120) throw new Error('请更换参考视频后重试');
          const quote = await post('/api/model-quote', { modelId:'motion-retargeting', generationType:'REFERENCE', aspectRatio:motionAspectRatio(), duration, quality:motion.resolution, referenceAssetIds:[imageIds[0], motion.videoAssetId] }); current();
          const unitCost = Number(quote.credits ?? duration);
          const totalCost = unitCost * imageIds.length;
          if (!await confirmCost('生成动作迁移视频', `共 ${imageIds.length} 个角色，预计消耗 ${totalCost} 积分。`)) return;
          const submitted = []; const failures = [];
          for (const imageId of imageIds) {
            current();
            try {
              const task = await post('/api/generations', { type:'video', modelId:'motion-retargeting', generationType:'REFERENCE', aspectRatio:motionAspectRatio(), duration, quality:motion.resolution, resolution:motion.resolution, referenceAssetIds:[imageId, motion.videoAssetId], prompt:motionPrompt(), requestId:`motion-${crypto.randomUUID()}` });
              current(); submitted.push(task); setCreditBalance(task.balance);
            } catch (error) { failures.push(error.message); }
          }
          await refreshMotionTasks(); current(); scheduleTaskPoll();
          if (!submitted.length && failures.length) throw new Error(failures[0]);
          if (failures.length) throw new Error(`已开始生成 ${submitted.length} 个角色，另有 ${failures.length} 个失败：${failures[0]}`);
          toast(`已开始生成 ${submitted.length} 个动作迁移视频`); return;
        }
        return;
      }
      if (!project) return;
      collect();
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
      await save(); current();
      if (action === 'confirm-assets' || action === 'confirm-plan') {
        const result = await post(`${base}/${project.id}/${action === 'confirm-assets' ? 'assets-confirm' : 'plan-confirm'}`,{revision:project.revision});current();project=result.project;render();return;
      }
      if (action === 'analyze-source') {
        const quote = await post(`${base}/${project.id}/source-quote`,{revision:project.revision});current();
        if (!await confirmCost('分析参考视频画面',`预计消耗 ${quote.maxCredits.toFixed(3)} 积分，确认继续吗？`)) return;
        current(); notice('正在分析参考视频画面…');
        const result = await post(`${base}/${project.id}/source-analyze`,{revision:project.revision,quoteId:quote.quoteId},{timeoutMs:240000});current();project=result.project;setCreditBalance(result.balance);render();return;
      }
      if (action === 'ai-plan') {
        if (!capabilities.aiPlan) throw new Error('AI 整理暂时不可用，可以先填写或粘贴已有创作描述');
        const quote = await post(`${base}/${project.id}/plan-quote`,{revision:project.revision});current();
        if (!await confirmCost('AI 整理制作方案',`预计消耗 ${quote.maxCredits.toFixed(3)} 积分，确认继续吗？`)) return;
        current(); notice('AI 正在整理方案…');
        const result = await post(`${base}/${project.id}/plan`,{revision:project.revision,quoteId:quote.quoteId},{timeoutMs:210000});current();project=result.project;setCreditBalance(result.balance);render();return;
      }
      if (action === 'generate' || action === 'retry') {
        if (!project.planApproval) throw new Error('请先确认制作方案');
        if (project.materials.some(m=>m.role==='identity')) throw new Error('人物参考图暂时无法用于生成，请移除后再试');
        const unit = project.units.find(u=>u.id===el.dataset.id); if (!unit) throw new Error('请在当前方案中选择分段');
        if ([...unit.prompt].length>4096) throw new Error('描述内容有些长，请精简后再试');
        const generationReferenceIds = [project.sourceAssetId, ...unit.referenceAssetIds.filter(id => id !== project.sourceAssetId)];
        const quote = await post('/api/model-quote',{...unit,referenceAssetIds:generationReferenceIds,type:'video',generationType:'REFERENCE',exactReferencePrice:true});current();
        if (!await confirmCost(action === 'retry' ? '重新生成这一段' : '生成这一段',`预计消耗 ${quote.credits} 积分，确认继续吗？`)) return;
        current();
        if(action==='retry'){const result=await post(`${base}/${project.id}/retry`,{revision:project.revision,unitId:unit.id});current();project=result.project;}
        const task = await post('/api/generations',{viralProjectId:project.id,viralUnitId:unit.id,viralPlanHash:project.planApproval.hash,requestId:project.planApproval.requests[unit.id],expectedPriceVersion:quote.priceVersion});current();
        setCreditBalance(task.balance); tasksOpen = true; await refreshTasks(); current(); render();
        await loadTasks(); current(); scheduleTaskPoll(); toast('已开始生成，可继续制作其他分段或新的内容');
      }
    });
  });
  function reset() { epoch++; visible=false; clearTimeout(taskTimer); clearTimeout(motionTaskTimer); tasks=[]; motionTasks=[]; tasksOpen=false; taskRefreshError=false; motionRefreshError=false; motionOpen=false; motion.imageAssetIds=[]; motion.videoAssetId=''; motion.videoDuration=0; setMotionHeader(false); motionPanel?.replaceChildren(); document.querySelectorAll('.vl-dialog').forEach(d=>d.close());project=null;assets=[];dirty=false;busy=false;root.replaceChildren(); }
  function suspend() { collect(); collectMotion(); visible=false; clearTimeout(taskTimer); clearTimeout(motionTaskTimer); setMotionHeader(false); }
  return { load, resetForAccount:reset, suspend };
}
