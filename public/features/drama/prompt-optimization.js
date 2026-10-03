import { createOptimizationDither } from './prompt-optimization-loading.js?v=1';

const wandIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.21 1.21 0 0 0 1.72 0L21.64 5.36a1.21 1.21 0 0 0 0-1.72M14 7l3 3M5 6v4M3 8h4M19 14v4M17 16h4"/></svg>';
const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg>';
const refreshIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.4 6.4L3 16M8 16H3v5"/></svg>';
const suggestionsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 6 2 2 4-4M13 6h8M13 12h8M13 18h8m-18-6 2 2 4-4M3 18h.01"/></svg>';

export function promptOptimizationButton(shot, locked = false) {
  return `<button type="button" class="wb-optimize-button" data-wb-optimize="${shot.id}" title="优化分镜内容" aria-haspopup="dialog" aria-expanded="false" ${locked || !shot.script?.trim() ? 'disabled' : ''}>${wandIcon}<span>AI 优化</span></button>`;
}

let morphScrollLocks = 0;
let morphPreviousOverflow;

// beUI Center Morph Modal, adapted to the native dialog used by this workspace.
// The native top layer owns focus containment and background inertness.
export function createCenterMorphDialog(dialog, { canDismiss = () => true, onDismiss, onClosed = () => {} } = {}) {
  let surface, animation, revision = 0, closing = false, locked = false, trigger;
  const reduceMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const folded = 'inset(48% 48% 48% 48% round 30px)';
  const unfolded = 'inset(0% 0% 0% 0% round 30px)';
  function release() {
    if (!locked) return;
    locked = false;
    if (--morphScrollLocks === 0) document.body.style.overflow = morphPreviousOverflow;
    if (trigger?.getAttribute('aria-haspopup') === 'dialog') {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
    }
    if (trigger?.isConnected) trigger.focus({ preventScroll:true });
    trigger = undefined;
    onClosed();
  }
  function resetAnimation() {
    revision++;
    animation?.cancel(); animation = undefined;
    dialog.classList.remove('is-morph-opening', 'is-morph-closing');
  }
  function finishClose() {
    resetAnimation();
    if (surface) surface.inert = false;
    closing = false;
    if (dialog.open) dialog.close();
    release();
  }
  function close({ immediate = false } = {}) {
    if (!dialog.open) { release(); return; }
    if (immediate) { finishClose(); return; }
    if (closing) return;
    // Capture the opening frame so a quick dismissal folds without a jump.
    const currentClip = globalThis.getComputedStyle?.(surface).clipPath || unfolded;
    const currentOpacity = globalThis.getComputedStyle?.(surface).opacity || '1';
    resetAnimation(); closing = true; surface.inert = true;
    dialog.classList.add('is-morph-closing');
    const token = revision;
    const reduce = reduceMotion();
    animation = surface.animate?.(reduce ? [{ opacity:currentOpacity }, { opacity:0 }] : [{ clipPath:currentClip }, { clipPath:folded }], {
      duration:reduce ? 140 : 430, easing:reduce ? 'cubic-bezier(.16,1,.3,1)' : 'cubic-bezier(.2,0,.2,1)', fill:'both',
    });
    if (!animation) { finishClose(); return; }
    animation.finished.then(() => { if (token === revision) finishClose(); }, () => {});
  }
  function dismiss() {
    if (!closing && canDismiss()) { if (onDismiss) onDismiss(); else close(); }
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  let backdropPress = false;
  const outside = event => {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  dialog.addEventListener('pointerdown', event => { backdropPress = event.target === dialog && outside(event); });
  dialog.addEventListener('pointercancel', () => { backdropPress = false; });
  dialog.addEventListener('click', event => {
    if (backdropPress && event.target === dialog && outside(event)) dismiss();
    backdropPress = false;
  });
  dialog.addEventListener('close', () => { if (!dialog.open) finishClose(); });
  return {
    close,
    show() {
      close({ immediate:true });
      surface = dialog.querySelector('[data-center-morph-surface]');
      surface.inert = false;
      trigger = document.activeElement;
      dialog.showModal();
      if (morphScrollLocks++ === 0) { morphPreviousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
      locked = true;
      if (trigger?.getAttribute('aria-haspopup') === 'dialog') {
        trigger.setAttribute('aria-expanded', 'true');
        if (dialog.id) trigger.setAttribute('aria-controls', dialog.id);
      }
      dialog.classList.add('is-morph-opening');
      const reduce = reduceMotion();
      const token = revision;
      animation = surface.animate?.(reduce ? [{ opacity:0 }, { opacity:1 }] : [{ clipPath:folded }, { clipPath:unfolded }], {
        duration:reduce ? 140 : 430, easing:reduce ? 'cubic-bezier(.16,1,.3,1)' : 'cubic-bezier(.2,0,.2,1)', fill:'both',
      });
      const complete = () => { if (token === revision) resetAnimation(); };
      if (animation) animation.finished.then(complete, () => {}); else complete();
    },
  };
}

// Keep drafts separate from the project until the user accepts a version.
export function createPromptOptimizationSession({ original, maxLength = 4096, request, isCurrent = () => true, onBalance = () => {}, onChange = () => {} }) {
  const state = { original, draft:'', suggestions:[], busy:false, ready:false, error:'', maxLength, closed:false };
  let sequence = 0;
  const canConfirm = () => !state.closed && !state.busy && state.ready && Boolean(state.draft.trim()) && Array.from(state.draft.trim()).length <= maxLength;
  return {
    state, canConfirm,
    edit(value) { if (!state.closed && !state.busy) { state.draft = value; onChange(state); } },
    close() { state.closed = true; sequence++; },
    async optimize(direction = '') {
      if (state.closed || state.busy || !isCurrent()) return false;
      const source = state.ready ? state.draft.trim() : original.trim();
      if (!source || Array.from(source).length > maxLength) {
        state.error = source ? `请将优化内容缩短至 ${maxLength} 字以内` : '请先填写优化内容';
        onChange(state); return false;
      }
      const token = ++sequence;
      state.busy = true; state.error = ''; onChange(state);
      try {
        const result = await request({ originalPrompt:original, prompt:source, direction });
        if (isCurrent() && Number.isFinite(result.balance)) onBalance(result.balance);
        if (state.closed || token !== sequence || !isCurrent()) return false;
        if (typeof result.prompt !== 'string' || !result.prompt.trim() || Array.from(result.prompt.trim()).length > maxLength || !Array.isArray(result.suggestions) || !result.suggestions.length || result.suggestions.some(item => typeof item !== 'string')) throw new Error('未获得完整的优化结果，请再次优化');
        state.draft = result.prompt; state.suggestions = result.suggestions; state.ready = true;
        return true;
      } catch (error) {
        if (isCurrent() && Number.isFinite(error.balance)) onBalance(error.balance);
        if (!state.closed && token === sequence && isCurrent()) state.error = error.message || '优化失败，请再次尝试';
        return false;
      } finally {
        if (!state.closed && token === sequence) { state.busy = false; onChange(state); }
      }
    },
  };
}

export function createPromptOptimizationDialog({ api, esc, setCreditBalance, onClose = () => {} }) {
  let dialog, directionDialog, session, context, dither, morph, directionMorph;
  const close = (options) => {
    dither?.stop();
    session?.close();
    directionMorph?.close({ immediate:true });
    morph?.close(options);
  };
  function update(state) {
    if (!dialog?.open || session?.state !== state) return;
    const editor = dialog.querySelector('[data-optimized-prompt]');
    if (editor.value !== state.draft) editor.value = state.draft;
    editor.disabled = state.busy || !state.ready;
    const optimizing = state.busy && !state.applying;
    dialog.classList.toggle('is-optimizing', optimizing);
    const loading = dialog.querySelector('[data-optimize-loading]');
    loading.hidden = !optimizing;
    loading.querySelector('[data-loading-title]').textContent = state.ready ? '正在再次优化' : '正在优化分镜内容';
    if (optimizing) dither.start(); else dither.stop();
    editor.placeholder = state.ready ? '' : '暂未获得优化结果，请再次尝试';
    dialog.querySelector('[data-optimize-again]').disabled = state.busy;
    dialog.querySelector('[data-optimize-confirm]').disabled = !session.canConfirm();
    dialog.querySelector('[data-optimize-confirm]').textContent = state.applying ? '正在确认…' : '确认版本';
    dialog.querySelectorAll('[data-optimize-close]').forEach(button => { button.disabled = Boolean(state.applying); });
    const count = Array.from(state.draft.trim()).length;
    dialog.querySelector('[data-optimize-count]').textContent = optimizing ? '优化中' : state.ready ? `${count} / ${state.maxLength} 字 · 可编辑` : '等待优化';
    const status = dialog.querySelector('[data-optimize-status]');
    status.textContent = state.error || (state.applying ? '正在确认版本…' : count > state.maxLength ? `内容超过 ${state.maxLength} 字，请适当缩短` : '');
    status.classList.toggle('is-error', Boolean(state.error || count > state.maxLength));
    status.hidden = !status.textContent;
    const suggestions = dialog.querySelector('[data-optimize-suggestions]');
    const markup = state.suggestions.length ? `<ul>${state.suggestions.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : `<p>${optimizing ? '正在整理改动建议…' : '优化完成后，查看具体改动。'}</p>`;
    if (suggestions.innerHTML !== markup) suggestions.innerHTML = markup;
    dialog.querySelector('[data-optimize-comparison]').setAttribute('aria-busy', String(state.busy));
  }
  function openDirection() {
    if (!session || session.state.closed || session.state.busy) return;
    if (!directionDialog) {
      directionDialog = document.createElement('dialog');
      directionDialog.className = 'prompt-direction-dialog';
      directionDialog.id = 'promptDirectionDialog';
      directionDialog.setAttribute('aria-labelledby', 'promptDirectionTitle');
      directionDialog.innerHTML = `<header class="dialog-head"><h2 id="promptDirectionTitle">再次优化</h2><button type="button" data-direction-cancel aria-label="关闭">${closeIcon}</button></header><div class="prompt-direction-body"><p>是否提供改进方向？可以填写你的想法，也可以留空直接优化。</p><label for="promptDirectionInput">改进方向（可选）</label><textarea id="promptDirectionInput" maxlength="1000" rows="4" placeholder="例如：让人物动作更自然，突出紧张感，减少镜头切换"></textarea></div><footer><button type="button" class="secondary-button" data-direction-cancel>返回</button><button type="button" class="gradient-button" data-direction-confirm>继续优化</button></footer>`;
      directionDialog.innerHTML = `<div class="prompt-morph-surface" data-center-morph-surface>${directionDialog.innerHTML}</div>`;
      directionMorph = createCenterMorphDialog(directionDialog);
      directionDialog.querySelectorAll('[data-direction-cancel]').forEach(button => button.onclick = () => directionMorph.close());
      directionDialog.querySelector('[data-direction-confirm]').onclick = () => {
        const direction = directionDialog.querySelector('textarea').value.trim();
        directionMorph.close(); void session?.optimize(direction);
      };
      document.body.append(directionDialog);
    }
    directionDialog.querySelector('textarea').value = '';
    directionMorph.show();
  }
  function open(options) {
    close({ immediate:true }); context = options;
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'shotPromptOptimizationDialog'; dialog.className = 'prompt-optimization-dialog';
      dialog.setAttribute('aria-labelledby', 'shotPromptOptimizationTitle');
      morph = createCenterMorphDialog(dialog, { canDismiss:() => !session?.state.applying, onDismiss:close,
        onClosed:() => { dither?.stop(); session?.close(); directionMorph?.close({ immediate:true }); onClose(); } });
      document.body.append(dialog);
    }
    dialog.innerHTML = `<header class="dialog-head"><div class="prompt-optimization-heading"><span class="prompt-optimization-emblem">${wandIcon}</span><div><h2 id="shotPromptOptimizationTitle">AI 优化分镜内容</h2><p>优化按实际用量消耗积分，结果可编辑。</p></div></div><button type="button" data-optimize-close aria-label="关闭">${closeIcon}</button></header>
      <div class="prompt-optimization-body"><div class="prompt-optimization-comparison" data-optimize-comparison>
        <section class="prompt-optimization-original"><div class="prompt-optimization-column-head"><label for="shotPromptOriginal">原始内容</label><small>${Array.from(options.original.trim()).length} 字</small></div><textarea id="shotPromptOriginal" readonly aria-label="原始分镜内容">${esc(options.original)}</textarea></section>
        <section class="prompt-optimization-result"><div class="prompt-optimization-column-head"><label for="shotPromptOptimized">优化后内容</label><small data-optimize-count>等待优化</small></div><div class="prompt-optimization-editor"><textarea id="shotPromptOptimized" data-optimized-prompt aria-label="优化后的分镜内容，可编辑" spellcheck="false"></textarea>
          <div class="prompt-optimization-loading" data-optimize-loading hidden><canvas aria-hidden="true"></canvas><div class="prompt-optimization-loading-caption" role="status" aria-live="polite"><span class="prompt-dither-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span data-loading-title>正在优化分镜内容</span><span class="prompt-loading-detail">稍等片刻，正在打磨画面细节</span></div></div>
        </div></section>
      </div><section class="prompt-optimization-suggestions" aria-labelledby="shotPromptSuggestionsTitle"><h3 id="shotPromptSuggestionsTitle">${suggestionsIcon}改动建议</h3><div data-optimize-suggestions></div></section><p class="prompt-optimization-status" data-optimize-status role="status" aria-live="polite" hidden></p></div>
      <footer><button type="button" class="secondary-button" data-optimize-close>取消</button><div><button type="button" class="secondary-button" data-optimize-again aria-haspopup="dialog" aria-expanded="false">${refreshIcon}<span>再次优化</span></button><button type="button" class="gradient-button" data-optimize-confirm>确认版本</button></div></footer>`;
    dialog.innerHTML = `<div class="prompt-morph-surface" data-center-morph-surface>${dialog.innerHTML}</div>`;
    dither = createOptimizationDither(dialog.querySelector('[data-optimize-loading] canvas'));
    const activeContext = context;
    session = createPromptOptimizationSession({ original:options.original, maxLength:options.maxLength, isCurrent:options.isCurrent, onBalance:setCreditBalance, onChange:update,
      request:async body => {
        await activeContext.prepare?.();
        if (!activeContext.isCurrent() || session !== activeSession || activeSession.state.closed) throw new Error('已取消优化');
        const references = activeContext.referencesFor?.(body.prompt) || {referenceFiles:activeContext.referenceFiles};
        return api(`/api/drama/projects/${activeContext.projectId}/shots/${activeContext.shotId}/optimize-prompt`, { method:'POST', timeoutMs:200000, body:JSON.stringify({ ...body, ...references, modelId:activeContext.modelId, mentionLabels:activeContext.mentionLabels }) });
      } });
    const activeSession = session;
    dialog.querySelectorAll('[data-optimize-close]').forEach(button => button.onclick = () => close());
    dialog.querySelector('[data-optimize-again]').onclick = openDirection;
    dialog.querySelector('[data-optimized-prompt]').oninput = event => activeSession.edit(event.target.value);
    dialog.querySelector('[data-optimize-confirm]').onclick = async () => {
      if (!activeSession.canConfirm() || !activeContext.isCurrent()) return;
      activeSession.state.busy = true; activeSession.state.applying = true; update(activeSession.state);
      try {
        await activeContext.apply(activeSession.state.draft.trim());
        if (session === activeSession && !activeSession.state.closed) close();
      } catch (error) {
        if (!activeSession.state.closed) { activeSession.state.error = error.message; activeSession.state.busy = false; activeSession.state.applying = false; update(activeSession.state); }
      }
    };
    morph.show(); void session.optimize();
  }
  return { open, close };
}
