// Pre-submit prompt check. The server owns the word list; this module only
// paints the marks it returns, lets the person edit in place and decides what
// to send along with the generation request.

const circleAlertIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>';
const recheckDelayMs = 250;

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);

export function countMarks(hits) {
  return { banned:hits.filter(hit => hit.level === 'banned').length, suspect:hits.filter(hit => hit.level === 'suspect').length };
}

// Keep marks lined up while a fresh check is in flight: marks before or after
// the edited span move with the text, marks touching it are dropped.
export function shiftMarks(hits, before, after) {
  if (before === after) return hits;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const changedEnd = before.length - suffix;
  const delta = after.length - before.length;
  return hits.flatMap(hit => {
    if (hit.end <= prefix) return [hit];
    if (hit.start >= changedEnd) return [{ ...hit, start:hit.start + delta, end:hit.end + delta }];
    return [];
  });
}

export function markedHtml(text, hits) {
  let html = '', cursor = 0;
  for (const hit of [...hits].sort((a, b) => a.start - b.start)) {
    if (hit.start < cursor || hit.end > text.length) continue;
    html += escapeHtml(text.slice(cursor, hit.start));
    html += `<mark class="precheck-mark is-${hit.level === 'banned' ? 'banned' : 'suspect'}">${escapeHtml(text.slice(hit.start, hit.end))}</mark>`;
    cursor = hit.end;
  }
  // A trailing newline needs a character after it or the mirror ends one line short of the textarea.
  return `${html}${escapeHtml(text.slice(cursor))}​`;
}

export function statusText({ banned, suspect }) {
  if (!banned && !suspect) return '未发现可能导致失败的内容';
  return [banned ? `${banned} 处很可能导致失败` : '', suspect ? `${suspect} 处可能被拦截` : ''].filter(Boolean).join(' · ');
}

export function submissionFields({ source, edited, confirmed, hadMarks }) {
  if (!hadMarks) return { precheckSource:source };
  return { precheckSource:source, precheckOutcome:confirmed ? 'confirmed_banned' : edited ? 'edited' : 'submitted_as_is', ...(confirmed ? { precheckConfirmed:true } : {}) };
}

export function createPromptPrecheck({ api, documentRef = globalThis.document, timeoutMs = 1500, delay = recheckDelayMs } = {}) {
  let dialog = null;
  let confirmDialog = null;
  let busy = false;

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = documentRef.createElement('dialog');
    dialog.className = 'desktop-restart-dialog prompt-precheck-dialog';
    dialog.setAttribute('aria-labelledby', 'promptPrecheckTitle');
    dialog.setAttribute('aria-describedby', 'promptPrecheckMessage');
    dialog.innerHTML = `<div class="desktop-restart-card prompt-precheck-card">
      <span class="desktop-restart-icon prompt-precheck-icon" aria-hidden="true">${circleAlertIcon}</span>
      <h2 id="promptPrecheckTitle">描述中有内容可能无法通过审核</h2>
      <p id="promptPrecheckMessage">标黄的内容可能被拦截，标红的内容很可能导致生成失败。可以直接在下方修改。</p>
      <p class="prompt-precheck-scope" hidden>这里的修改只用于本次生成，不会改动原来的内容。</p>
      <div class="prompt-precheck-items"></div>
      <footer class="desktop-restart-actions prompt-precheck-actions">
        <button class="desktop-restart-later" type="button" data-precheck-cancel>取消</button>
        <button class="gradient-button" type="button" data-precheck-submit>提交</button>
      </footer>
    </div>`;
    documentRef.body.append(dialog);
    return dialog;
  }

  // Confirming red marks opens its own dialog above the editor instead of
  // growing the editor dialog.
  function ensureConfirmDialog() {
    if (confirmDialog) return confirmDialog;
    confirmDialog = documentRef.createElement('dialog');
    confirmDialog.className = 'desktop-restart-dialog prompt-precheck-confirm-dialog';
    confirmDialog.setAttribute('role', 'alertdialog');
    confirmDialog.setAttribute('aria-labelledby', 'promptPrecheckConfirmTitle');
    confirmDialog.setAttribute('aria-describedby', 'promptPrecheckConfirmText');
    confirmDialog.innerHTML = `<div class="desktop-restart-card">
      <span class="desktop-restart-icon prompt-precheck-confirm-icon" aria-hidden="true">${circleAlertIcon}</span>
      <h2 id="promptPrecheckConfirmTitle">确定仍然提交吗？</h2>
      <p id="promptPrecheckConfirmText"></p>
      <footer class="desktop-restart-actions prompt-precheck-actions">
        <button class="desktop-restart-later prompt-precheck-anyway" type="button" data-precheck-anyway>仍然提交</button>
        <button class="gradient-button" type="button" data-precheck-back>返回修改</button>
      </footer>
    </div>`;
    documentRef.body.append(confirmDialog);
    return confirmDialog;
  }

  async function scan(prompts, modelId, signal) {
    return api('/api/prompt-precheck', { method:'POST', body:JSON.stringify({ modelId, prompts }), timeoutMs, signal });
  }

  function recordCancel({ source, modelId, prompt }) {
    api('/api/prompt-precheck/events', { method:'POST', body:JSON.stringify({ outcome:'cancelled', source, modelId, prompt }), timeoutMs }).catch(() => {});
  }

  function openDialog({ items, modelId, scopeNote }) {
    const root = ensureDialog();
    root.querySelector('.prompt-precheck-scope').hidden = !scopeNote;
    const list = root.querySelector('.prompt-precheck-items');
    list.innerHTML = '';
    const confirm = ensureConfirmDialog();
    let sequence = 0;

    const views = items.map((item, index) => {
      const wrap = documentRef.createElement('section');
      wrap.className = 'prompt-precheck-item';
      wrap.innerHTML = `${item.label ? `<h3>${escapeHtml(item.label)}</h3>` : ''}
        <div class="prompt-precheck-editor"><div class="prompt-precheck-mirror" aria-hidden="true"></div><textarea spellcheck="false" aria-label="${escapeHtml(item.label || '创作描述')}"></textarea></div>
        <div class="prompt-precheck-meta"><span class="prompt-precheck-status" aria-live="polite"></span><ul class="prompt-precheck-list"></ul></div>`;
      list.append(wrap);
      const view = { item, index, text:item.text, hits:item.hits, textarea:wrap.querySelector('textarea'), mirror:wrap.querySelector('.prompt-precheck-mirror'),
        status:wrap.querySelector('.prompt-precheck-status'), list:wrap.querySelector('.prompt-precheck-list'), timer:null, composing:false };
      view.textarea.value = item.text;
      paint(view);
      view.textarea.addEventListener('scroll', () => { view.mirror.scrollTop = view.textarea.scrollTop; });
      view.textarea.addEventListener('compositionstart', () => { view.composing = true; clearTimeout(view.timer); });
      view.textarea.addEventListener('compositionend', () => { view.composing = false; onInput(view); });
      view.textarea.addEventListener('input', () => onInput(view));
      view.list.addEventListener('click', event => {
        const button = event.target.closest('button[data-start]');
        if (!button) return;
        view.textarea.focus();
        view.textarea.setSelectionRange(Number(button.dataset.start), Number(button.dataset.end));
      });
      return view;
    });

    function paint(view) {
      view.mirror.innerHTML = markedHtml(view.text, view.hits);
      view.mirror.scrollTop = view.textarea.scrollTop;
      view.status.textContent = statusText(countMarks(view.hits));
      view.status.classList.toggle('is-clear', !view.hits.length);
      view.list.innerHTML = view.hits.map(hit => `<li><button type="button" class="is-${hit.level === 'banned' ? 'banned' : 'suspect'}" data-start="${hit.start}" data-end="${hit.end}">${escapeHtml(view.text.slice(hit.start, hit.end))}<span>${escapeHtml(hit.label)}</span></button></li>`).join('');
    }

    function onInput(view) {
      const next = view.textarea.value;
      view.hits = shiftMarks(view.hits, view.text, next);
      view.text = next;
      paint(view);
      clearTimeout(view.timer);
      if (view.composing) return;
      view.timer = setTimeout(async () => {
        const current = ++sequence; const text = view.text;
        try {
          const response = await scan([text], modelId);
          if (current !== sequence || text !== view.text) return;
          view.hits = response.results[0].hits;
          paint(view);
        } catch { /* keep the shifted marks; the server checks again on submit */ }
      }, delay);
    }

    return new Promise(resolve => {
      const totals = () => views.reduce((sum, view) => { const counts = countMarks(view.hits); return { banned:sum.banned + counts.banned, suspect:sum.suspect + counts.suspect }; }, { banned:0, suspect:0 });
      const finish = result => {
        views.forEach(view => clearTimeout(view.timer));
        root.removeEventListener('cancel', onEscape);
        root.removeEventListener('click', onClick);
        confirm.removeEventListener('cancel', onConfirmEscape);
        confirm.removeEventListener('click', onConfirmClick);
        if (confirm.open) confirm.close();
        if (root.open) root.close();
        resolve(result);
      };
      const submit = confirmed => finish({ action:'submit', confirmed, prompts:views.map(view => view.text), edited:views.some(view => view.text !== view.item.text) });
      const backToEdit = () => { if (confirm.open) confirm.close(); views[0].textarea.focus(); };
      const onEscape = event => { event.preventDefault(); finish({ action:'cancel' }); };
      const onConfirmEscape = event => { event.preventDefault(); backToEdit(); };
      const onConfirmClick = event => {
        if (event.target.closest('[data-precheck-back]')) return backToEdit();
        if (event.target.closest('[data-precheck-anyway]')) return submit(true);
      };
      const onClick = event => {
        if (event.target.closest('[data-precheck-cancel]')) return finish({ action:'cancel' });
        if (event.target.closest('[data-precheck-submit]')) {
          if (views.some(view => !view.text.trim())) { views.find(view => !view.text.trim()).textarea.focus(); return; }
          const { banned } = totals();
          if (!banned) return submit(false);
          confirm.querySelector('#promptPrecheckConfirmText').textContent = `还有 ${banned} 处内容很可能导致生成失败，失败后积分会退回。`;
          confirm.showModal();
          confirm.querySelector('[data-precheck-back]').focus();
        }
      };
      root.addEventListener('cancel', onEscape);
      root.addEventListener('click', onClick);
      confirm.addEventListener('cancel', onConfirmEscape);
      confirm.addEventListener('click', onConfirmClick);
      root.showModal();
      views[0].textarea.focus();
      views[0].textarea.setSelectionRange(0, 0);
    });
  }

  // Resolves { action:'cancel' } or { action:'submit', prompts, fields }.
  // A failed or slow check never blocks creation; the server checks again.
  async function check({ prompts, modelId = '', source, labels = [], scopeNote = false }) {
    const pass = { action:'submit', prompts, fields:submissionFields({ source, hadMarks:false }) };
    if (busy) return { action:'cancel' };
    busy = true;
    try {
      let response;
      try { response = await scan(prompts, modelId); } catch { return pass; }
      if (response.mode !== 'enforce') return pass;
      const items = prompts.map((text, index) => ({ text, label:labels[index] || '', hits:response.results[index]?.hits || [] }));
      if (!items.some(item => item.hits.length)) return pass;
      const marked = items.filter(item => item.hits.length);
      const result = await openDialog({ items:marked, modelId, scopeNote });
      if (result.action === 'cancel') {
        marked.forEach(item => recordCancel({ source, modelId, prompt:item.text }));
        return result;
      }
      const edits = new Map(marked.map((item, index) => [item, result.prompts[index]]));
      return { action:'submit', prompts:items.map(item => edits.get(item) ?? item.text),
        fields:submissionFields({ source, edited:result.edited, confirmed:result.confirmed, hadMarks:true }) };
    } finally { busy = false; }
  }

  return { check };
}
