import { VIDEO_UPSCALE_MODEL_ID, videoUpscaleLabel, videoUpscalePlan } from './upscale.js?v=1';

const metadataTimeoutMs = 15_000;
const resumeWindowMs = 25 * 60_000;

function readVideoMetadata(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const cleanup = () => { clearTimeout(timer); video.removeAttribute('src'); video.load(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('暂时无法读取视频信息，请稍后重试')); }, metadataTimeoutMs);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      const metadata = { width:video.videoWidth, height:video.videoHeight, duration:video.duration };
      cleanup();
      resolve(metadata);
    };
    video.onerror = () => { cleanup(); reject(new Error('暂时无法读取视频信息，请稍后重试')); };
    video.src = url;
  });
}

function putWithProgress(upload, body, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(upload.method || 'PUT', upload.url);
    Object.entries(upload.headers || {}).forEach(([name, value]) => request.setRequestHeader(name, value));
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`上传失败（${request.status}）`)));
    request.onerror = () => reject(new Error('网络连接中断'));
    request.ontimeout = () => reject(new Error('上传超时'));
    request.send(body);
  });
}

// The local copy is preferred; the cloud copy only covers a local file that
// cannot be read, for example after it was moved outside the workspace.
async function readSource(asset) {
  for (const url of [...new Set([asset.url, asset.remoteUrl].filter(Boolean))]) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.blob();
    } catch {}
  }
  throw new Error('无法读取视频文件');
}

export function isVideoUpscaleTask(task) {
  return task?.modelId === VIDEO_UPSCALE_MODEL_ID || task?.videoModelId === VIDEO_UPSCALE_MODEL_ID;
}

export function createVideoUpscaleController({
  $,
  api,
  toast,
  creditText,
  getBalance,
  setCreditBalance,
  fileById,
  taskById,
  onTasksChanged,
  observeTaskFailure,
} = {}) {
  const uploadProgress = new Map();
  const inFlight = new Set();
  const resumeAttempted = new Set();
  let session = null;

  const dialog = () => $('#videoUpscaleDialog');
  const sizeText = (width, height) => (width && height ? `${width} × ${height}` : '—');

  function canUpscale(task) {
    if (task?.type !== 'video' || task.status !== 'completed') return false;
    const output = task.upscale;
    if (output?.outputWidth) return videoUpscalePlan({ width:output.outputWidth, height:output.outputHeight }).eligible;
    return !['1080p', '2k', '4k'].includes(String(task.quality || '').toLowerCase());
  }

  function renderDialog({ source = '—', target = '—', credits = '—', balance = getBalance(), error = '', ready = false, busy = false } = {}) {
    $('#videoUpscaleSource').textContent = source;
    $('#videoUpscaleTarget').textContent = target;
    $('#videoUpscaleCredits').textContent = credits;
    $('#videoUpscaleBalance').textContent = `${creditText(balance)} 积分`;
    const errorNode = $('#videoUpscaleError');
    errorNode.textContent = error;
    errorNode.classList.toggle('hidden', !error);
    const confirm = $('#confirmVideoUpscale');
    confirm.disabled = !ready || busy;
    confirm.textContent = busy ? '正在提交…' : '开始放大';
    confirm.toggleAttribute('aria-busy', busy);
  }

  function renderQuote(quote, extra = {}) {
    const balance = Number(quote.balance ?? getBalance());
    const enough = balance >= Number(quote.credits);
    renderDialog({
      source:sizeText(quote.sourceWidth, quote.sourceHeight),
      target:`${sizeText(quote.outputWidth, quote.outputHeight)} · ${quote.label}`,
      credits:`${creditText(quote.credits)} 积分`,
      balance,
      error:extra.error || (enough ? '' : `积分不足，本次需要 ${creditText(quote.credits)} 积分`),
      ready:enough,
    });
  }

  async function open(task) {
    if (!canUpscale(task)) return toast('这个视频已经是高清画质，无需再放大');
    const asset = fileById(task.assetId);
    if (!asset?.url || asset.localStatus !== 'saved') return toast('视频还在下载到本地，完成后再放大');
    const current = { task, asset, quote:null, metadata:null };
    session = current;
    renderDialog({ source:'正在读取…', target:'正在计算…' });
    if (!dialog().open) dialog().showModal();
    try {
      const metadata = await readVideoMetadata(asset.url);
      if (session !== current) return;
      const plan = videoUpscalePlan(metadata);
      if (!plan.eligible) return renderDialog({ source:sizeText(metadata.width, metadata.height), error:plan.reason });
      current.metadata = metadata;
      renderDialog({ source:sizeText(plan.sourceWidth, plan.sourceHeight), target:`${sizeText(plan.outputWidth, plan.outputHeight)} · ${plan.label}`, credits:'正在计算…' });
      current.quote = await api('/api/generations/upscale/quote', { method:'POST', body:JSON.stringify(requestBody(current)) });
      if (session !== current) return;
      renderQuote(current.quote);
    } catch (error) {
      if (session === current) renderDialog({ source:$('#videoUpscaleSource').textContent, error:error.message });
    }
  }

  function requestBody({ task, asset, metadata }) {
    return { sourceGenerationId:task.id, width:metadata.width, height:metadata.height, duration:metadata.duration, size:Number(asset.size) || undefined };
  }

  function close() {
    session = null;
    if (dialog().open) dialog().close();
  }

  async function confirm() {
    const current = session;
    if (!current?.quote) return;
    renderDialog({ ...dialogValues(), ready:true, busy:true });
    try {
      const result = await api('/api/generations/upscale', { method:'POST', body:JSON.stringify({ ...requestBody(current), requestId:crypto.randomUUID(), expectedCredits:current.quote.credits }) });
      if (session !== current) return;
      close();
      setCreditBalance(result.balance);
      onTasksChanged([result.task]);
      toast(`已开始高清放大，消耗 ${creditText(result.task.creditCost)} 积分`);
      void upload(result.task, result.upload, current.asset);
    } catch (error) {
      if (session !== current) return;
      if (error.code === 'PRICE_CHANGED' && error.quote) {
        current.quote = { ...error.quote, balance:getBalance() };
        return renderQuote(current.quote, { error:'价格已更新，请确认后再开始' });
      }
      renderQuote(current.quote, { error:error.message });
    }
  }

  function dialogValues() {
    return { source:$('#videoUpscaleSource').textContent, target:$('#videoUpscaleTarget').textContent, credits:$('#videoUpscaleCredits').textContent };
  }

  function setUploadProgress(taskId, progress) {
    uploadProgress.set(taskId, progress);
    const card = document.querySelector(`[data-record-id="${CSS.escape(taskId)}"] .skeleton-progress`);
    if (!card) return;
    card.querySelector('b')?.replaceChildren(`${progress}%`);
    card.querySelector('.skeleton-progress-track i')?.style.setProperty('--progress', `${progress}%`);
    card.setAttribute('aria-label', `正在上传视频 ${progress}%`);
  }

  async function upload(task, target, asset) {
    if (!target?.url || inFlight.has(task.id)) return;
    inFlight.add(task.id);
    setUploadProgress(task.id, 0);
    onTasksChanged([]);
    try {
      await putWithProgress(target, await readSource(asset), progress => setUploadProgress(task.id, progress));
      const result = await api('/api/generations/upscale/complete', { method:'POST', body:JSON.stringify({ taskId:task.id }) });
      uploadProgress.delete(task.id);
      onTasksChanged([result.task]);
    } catch (error) {
      uploadProgress.delete(task.id);
      await cancel(task, error.message);
    } finally {
      inFlight.delete(task.id);
    }
  }

  async function cancel(task, reason) {
    try {
      const cancelled = await api('/api/generations/references/cancel', { method:'POST', body:JSON.stringify({ taskIds:[task.id], error:`视频上传未完成：${reason}` }) });
      const tasks = Array.isArray(cancelled.tasks) ? cancelled.tasks : [];
      tasks.forEach(item => observeTaskFailure(item, taskById(item.id) || null, { force:true }));
      onTasksChanged(tasks);
      setCreditBalance(cancelled.balance);
    } catch (error) {
      console.warn('[upscale] 上传失败后的退款请求未完成', error);
      onTasksChanged([]);
    }
  }

  // A client restart interrupts the upload. Pick it up again while the
  // source is still on this device; otherwise refund right away instead of
  // waiting for the server-side expiry.
  function resumePendingUploads(tasks) {
    for (const task of tasks) {
      if (!isVideoUpscaleTask(task) || !task.awaitingReferences || task.status !== 'queued') continue;
      if (inFlight.has(task.id) || resumeAttempted.has(task.id)) continue;
      resumeAttempted.add(task.id);
      const source = taskById(task.upscale?.sourceGenerationId);
      const asset = fileById(source?.assetId);
      const recent = Date.now() - Date.parse(task.createdAt || '') < resumeWindowMs;
      if (!recent || !asset?.url || asset.localStatus !== 'saved') {
        void cancel(task, '原视频不在本机');
        continue;
      }
      void api('/api/generations/upscale', { method:'POST', body:JSON.stringify({ sourceGenerationId:source.id, requestId:task.id }) })
        .then(result => (result.upload ? upload(result.task, result.upload, asset) : onTasksChanged([result.task])))
        .catch(error => console.warn('[upscale] 恢复上传失败', error));
    }
  }

  function preparationProgress(task) {
    return isVideoUpscaleTask(task) && task.awaitingReferences ? uploadProgress.get(task.id) ?? null : null;
  }

  function resolutionText(task) {
    const output = task?.upscale;
    if (!output?.outputWidth) return task?.quality || '—';
    return `${output.outputWidth} × ${output.outputHeight} · ${videoUpscaleLabel(output.outputWidth, output.outputHeight)}`;
  }

  $('#cancelVideoUpscale').addEventListener('click', close);
  $('#confirmVideoUpscale').addEventListener('click', () => { void confirm(); });
  dialog().addEventListener('close', () => { session = null; });

  return Object.freeze({ open, close, canUpscale, resumePendingUploads, preparationProgress, resolutionText });
}
