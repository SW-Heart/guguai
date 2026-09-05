export function createSupportLogController({ api, toast, closeNotifications = () => {}, getClientInfo = () => ({}), getSyncInfo = () => ({}) } = {}) {
  let restoreFocus = null;

  const $ = selector => document.querySelector(selector);
  const toggleHidden = (element, hidden) => element?.classList.toggle('hidden', hidden);

  function setError(message = '') {
    const element = $('#supportLogError');
    if (!element) return;
    element.textContent = message;
    toggleHidden(element, !message);
  }

  function setResult(message = '') {
    const element = $('#supportLogResult');
    if (!element) return;
    element.textContent = message;
    toggleHidden(element, !message);
  }

  function closeDialog() {
    const dialog = $('#supportLogDialog');
    if (dialog?.open) dialog.close();
  }

  function openDialog() {
    const dialog = $('#supportLogDialog');
    if (!dialog || dialog.open) return;
    restoreFocus = $('#accountButton');
    closeNotifications();
    $('#accountMenu')?.classList.add('hidden');
    $('#supportLogNote').value = '';
    setError();
    setResult();
    $('#submitSupportLog').disabled = false;
    $('#submitSupportLog').textContent = '上传日志';
    dialog.showModal();
    requestAnimationFrame(() => $('#supportLogNote')?.focus());
  }

  async function uploadBundle(note) {
    const bridge = window.guguDesktop;
    if (!bridge?.logs?.collect) throw new Error('当前客户端版本不支持日志上传，请先更新客户端');
    const bundle = await bridge.logs.collect();
    if (!bundle?.bytes?.length) throw new Error('本机暂无可上传的日志');
    const query = new URLSearchParams();
    const clientInfo = getClientInfo() || {};
    const syncInfo = getSyncInfo() || {};
    if (note) query.set('note', note);
    if (clientInfo.version) query.set('version', clientInfo.version);
    if (clientInfo.platform) query.set('platform', `${clientInfo.platform}-${clientInfo.arch || ''}`);
    if (syncInfo.deviceId) query.set('deviceId', syncInfo.deviceId);
    return api(`/api/support/logs?${query}`, { method:'POST', body:new Blob([bundle.bytes], { type:bundle.mimeType }), headers:{ 'Content-Type':bundle.mimeType } });
  }

  function init(bridge) {
    const button = $('#supportLogButton');
    const dialog = $('#supportLogDialog');
    if (!button || !dialog || !bridge?.logs?.collect) return;
    button.classList.remove('hidden');
    if (dialog.dataset.bound === 'true') return;
    button.onclick = event => { event.stopPropagation(); openDialog(); };
    $('#closeSupportLog').onclick = closeDialog;
    $('#openSupportLogFolder').onclick = async () => {
      try {
        const opened = await bridge.logs.openFolder();
        if (!opened) setError('日志文件夹暂不可用');
      } catch (error) { setError(`打开日志文件夹失败：${error.message}`); }
    };
    $('#supportLogForm').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = $('#submitSupportLog');
      setError();
      setResult();
      submit.disabled = true;
      submit.textContent = '上传中…';
      try {
        const result = await uploadBundle($('#supportLogNote').value.trim());
        setResult(`上传成功，日志编号 ${result.reference}（${Math.max(1, Math.round((result.size || 0) / 1024))} KB）。请把这个编号告诉客服。`);
        submit.textContent = '已上传';
        toast(`诊断日志已上传，编号 ${result.reference}`);
      } catch (error) {
        setError(error.message);
        submit.disabled = false;
        submit.textContent = '上传日志';
      }
    });
    dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener('close', () => {
      const restore = restoreFocus;
      restoreFocus = null;
      setError();
      setResult();
      requestAnimationFrame(() => { if (restore?.isConnected && !restore.disabled) restore.focus(); });
    });
    dialog.dataset.bound = 'true';
  }

  function initRendererLogForwarding(bridge) {
    const append = bridge?.logs?.append;
    if (typeof append !== 'function' || document.body.dataset.desktopLogForwardBound === 'true') return;
    const forward = (level, message) => { void Promise.resolve(append({ level, message })).catch(() => {}); };
    window.addEventListener('error', event => {
      forward('error', `${event.message || '页面脚本异常'} @ ${event.filename || '未知文件'}:${event.lineno || 0}:${event.colno || 0}\n${event.error?.stack || ''}`);
    });
    window.addEventListener('unhandledrejection', event => {
      const reason = event.reason;
      forward('error', `未处理的 Promise 异常：${reason?.stack || reason?.message || reason}`);
    });
    document.body.dataset.desktopLogForwardBound = 'true';
  }

  return Object.freeze({ init, initRendererLogForwarding });
}
