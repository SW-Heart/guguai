import { modelLogoMarkup } from '../../components/model-logo.js?v=1';
import { normalizeModelPreferences, modelPreferenceError } from './model-preferences.js?v=1';
import { canvasGenerationModelIcon } from '../drama/canvas-generation.js?v=6';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = '<span class="gugu-lucide gugu-lucide-layers-2" aria-hidden="true"></span>';

export function mountModelPreferencePicker(anchor, { value, loadCatalog, onSave, onOpen = () => {}, onError = () => {}, onReady = () => {}, signal, scope = '' }) {
  let committed = normalizeModelPreferences(value), preferencesReady = value !== undefined, draft, kind = 'image', catalog = [], loading = false, loadError = '', saving = false, disabled = false, disposed = false, sequence = 0, currentScope = scope;
  const events = new AbortController(), id = `model-preference-${crypto.randomUUID()}`;
  const wrapper = document.createElement('div');
  wrapper.className = 'model-preference-control';
  wrapper.innerHTML = `<button type="button" class="model-preference-trigger" aria-label="模型偏好" title="模型偏好" aria-haspopup="dialog" aria-expanded="false" aria-controls="${id}">${icon}</button>`;
  anchor.insertAdjacentElement('afterend', wrapper);
  const trigger = wrapper.querySelector('button');
  const popup = document.createElement('section');
  popup.id = id; popup.className = 'model-preference-popup'; popup.popover = 'auto';
  popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-labelledby', `${id}-title`);
  popup.innerHTML = `<header class="model-preference-head"><h2 id="${id}-title">模型偏好</h2><button type="button" data-preference-close aria-label="关闭"><span class="gugu-lucide gugu-lucide-x" aria-hidden="true"></span></button></header><div class="model-preference-tabs" role="tablist" aria-label="生成内容"><button type="button" role="tab" id="${id}-image" aria-controls="${id}-panel" data-preference-tab="image">图片</button><button type="button" role="tab" id="${id}-video" aria-controls="${id}-panel" data-preference-tab="video">视频</button></div><div id="${id}-panel" role="tabpanel" class="model-preference-panel"><label class="model-preference-auto"><span><strong>自动选择</strong><small data-preference-help></small></span><input type="checkbox" role="switch" data-preference-auto aria-label="自动选择"><span class="model-preference-switch" aria-hidden="true"></span></label><div class="model-preference-list" data-preference-list></div></div><footer class="model-preference-footer"><p data-preference-error role="status" aria-live="polite"></p><div><button type="button" data-preference-cancel>取消</button><button type="button" class="model-preference-save" data-preference-save>完成</button></div></footer>`;
  document.body.append(popup);
  const open = () => popup.matches(':popover-open');
  const updateTrigger = () => {
    const description = ['image', 'video'].map(kind => `${kind === 'image' ? '图片' : '视频'}：${committed[kind].mode === 'auto' ? '自动选择' : committed[kind].modelIds.map(id => catalog.find(model => model.id === id && model.kind === kind)?.label || '所选模型暂不可用').join('、')}`).join('；');
    trigger.title = `模型偏好 · ${description}`;
    trigger.setAttribute('aria-label', `模型偏好，${description}`);
    trigger.classList.toggle('is-selected', committed.image.mode === 'manual' || committed.video.mode === 'manual');
    trigger.disabled = disabled || saving || (loading && !preferencesReady);
  };
  function position() {
    if (!open()) return;
    const rect = trigger.getBoundingClientRect(), gap = 10, edge = 12;
    const above = rect.top - gap - edge, below = window.innerHeight - rect.bottom - gap - edge;
    const up = above >= Math.min(500, popup.scrollHeight) || above > below;
    popup.style.maxHeight = `${Math.max(0, up ? above : below)}px`;
    popup.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - popup.offsetWidth - edge))}px`;
    popup.style.top = `${Math.max(edge, up ? rect.top - gap - popup.offsetHeight : rect.bottom + gap)}px`;
  }
  function render() {
    if (!draft) return;
    const focusedModel = popup.contains(document.activeElement) ? document.activeElement.dataset.preferenceModel : '';
    const scrollTop = popup.querySelector('[data-preference-list]').scrollTop;
    popup.querySelectorAll('[data-preference-tab]').forEach(tab => {
      const active = tab.dataset.preferenceTab === kind;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; tab.disabled = saving;
    });
    popup.querySelector('[role="tabpanel"]').setAttribute('aria-labelledby', `${id}-${kind}`);
    const entry = draft[kind], automatic = entry.mode === 'auto';
    const auto = popup.querySelector('[data-preference-auto]'); auto.checked = automatic; auto.disabled = saving; auto.setAttribute('aria-label', `自动选择${kind === 'image' ? '图片' : '视频'}模型`);
    popup.querySelector('[data-preference-help]').textContent = automatic ? '根据创作需求选择合适的模型。' : '仅使用你选中的模型，可选一个或多个。';
    const models = catalog.filter(model => model.kind === kind);
    const missing = entry.modelIds.filter(modelId => !models.some(model => model.id === modelId));
    const rows = [...models, ...missing.map(modelId => ({id:modelId, label:'所选模型暂不可用', unavailable:true}))];
    popup.querySelector('[data-preference-list]').innerHTML = loading && !catalog.length ? '<p class="model-preference-empty" role="status">正在加载模型…</p>' : loadError ? `<p class="model-preference-empty" role="status">${escape(loadError)}</p><button type="button" data-preference-retry>重新加载</button>` : rows.length ? rows.map(model => {
      const url = canvasGenerationModelIcon(model.id, model.iconKey), selected = entry.modelIds.includes(model.id);
      return `<label class="model-preference-row${selected && !automatic ? ' is-selected' : ''}${automatic ? ' is-automatic' : ''}"><span class="model-preference-logo" aria-hidden="true">${icon}${url ? modelLogoMarkup(url, {lazy:true}) : ''}</span><span class="model-preference-copy"><strong>${escape(model.label)}</strong>${model.description ? `<small>${escape(model.description)}</small>` : ''}${model.unavailable ? '<small>取消选择或开启自动选择</small>' : ''}</span><input type="checkbox" data-preference-model="${escape(model.id)}" aria-label="${escape(model.label)}" ${selected && !automatic ? 'checked' : ''} ${automatic || saving ? 'disabled' : ''}></label>`;
    }).join('') : '<p class="model-preference-empty">暂时没有可用模型</p>';
    popup.querySelectorAll('.model-preference-logo img').forEach(image => image.addEventListener('error', () => image.remove(), {once:true}));
    popup.querySelector('[data-preference-list]').scrollTop = scrollTop;
    if (focusedModel) [...popup.querySelectorAll('[data-preference-model]')].find(input => input.dataset.preferenceModel === focusedModel)?.focus({preventScroll:true});
    const error = modelPreferenceError(draft, catalog);
    popup.querySelector('[data-preference-error]').textContent = error;
    const save = popup.querySelector('[data-preference-save]'); save.disabled = saving || !preferencesReady || Boolean(error) || (loading && (draft.image.mode === 'manual' || draft.video.mode === 'manual')) || Boolean(loadError && (draft.image.mode === 'manual' || draft.video.mode === 'manual'));
    save.textContent = saving ? '正在保存…' : '完成';
    popup.querySelectorAll('[data-preference-cancel],[data-preference-close]').forEach(button => { button.disabled = saving; });
    updateTrigger(); position();
  }
  async function refresh() {
    const request = ++sequence;
    loading = true; loadError = ''; render(); updateTrigger();
    try {
      const result = await loadCatalog();
      if (disposed || request !== sequence) return;
      const models = Array.isArray(result) ? result : result.models;
      if (!Array.isArray(models)) throw new Error('模型偏好加载失败');
      if (!Array.isArray(result) && Object.hasOwn(result, 'modelPreferences')) {
        committed = normalizeModelPreferences(result.modelPreferences);
        if (!preferencesReady && draft) draft = normalizeModelPreferences(committed);
      }
      preferencesReady = true;
      catalog = models.filter(model => model.enabled !== false && model.availability !== 'coming-soon');
    } catch {
      if (disposed || request !== sequence) return;
      loadError = '模型偏好加载失败，请重试。';
    } finally {
      if (!disposed && request === sequence) { loading = false; render(); updateTrigger(); onReady(preferencesReady); }
    }
  }
  function close(restore = true) {
    if (saving) return;
    if (open()) popup.hidePopover();
    draft = null;
    if (restore) trigger.focus({preventScroll:true});
  }
  trigger.addEventListener('click', () => {
    if (open()) { close(); return; }
    onOpen(); draft = normalizeModelPreferences(committed); render();
    popup.showPopover(); position(); popup.querySelector('[aria-selected="true"]').focus({preventScroll:true});
    void refresh();
  }, {signal:events.signal});
  popup.addEventListener('toggle', event => {
    const active = event.newState === 'open'; trigger.setAttribute('aria-expanded', String(active));
    if (!active && !saving) draft = null;
  }, {signal:events.signal});
  popup.addEventListener('change', event => {
    if (!draft || saving) return;
    if (event.target.matches('[data-preference-auto]')) draft[kind].mode = event.target.checked ? 'auto' : 'manual';
    else if (event.target.matches('[data-preference-model]')) {
      const modelId = event.target.dataset.preferenceModel;
      draft[kind].modelIds = event.target.checked ? [...new Set([...draft[kind].modelIds, modelId])] : draft[kind].modelIds.filter(id => id !== modelId);
    } else return;
    const modelId = event.target.dataset.preferenceModel;
    render();
    if (modelId) [...popup.querySelectorAll('[data-preference-model]')].find(input => input.dataset.preferenceModel === modelId)?.focus({preventScroll:true});
  }, {signal:events.signal});
  popup.addEventListener('click', async event => {
    if (saving || !draft) return;
    const target = event.target.closest('button'); if (!target) return;
    if (target.matches('[data-preference-tab]')) { kind = target.dataset.preferenceTab; render(); }
    else if (target.matches('[data-preference-close],[data-preference-cancel]')) close();
    else if (target.matches('[data-preference-retry]')) void refresh();
    else if (target.matches('[data-preference-save]') && !target.disabled) {
      const next = normalizeModelPreferences(draft), saveScope = currentScope;
      sequence++; loading = false; saving = true; render();
      try {
        await onSave(next);
        if (disposed || saveScope !== currentScope) return;
        committed = next; saving = false; close();
      } catch (error) {
        if (!disposed && saveScope === currentScope) {
          saving = false; render(); popup.querySelector('[data-preference-error]').textContent = error.message || '保存失败，请重试。';
          if (!open()) onError(error);
        }
      } finally {
        if (!disposed && saveScope === currentScope) { saving = false; updateTrigger(); }
      }
    }
  }, {signal:events.signal});
  popup.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.target.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); kind = event.key === 'Home' ? 'image' : event.key === 'End' ? 'video' : kind === 'image' ? 'video' : 'image';
      render(); popup.querySelector('[aria-selected="true"]').focus();
    } else if (event.key === 'Tab') {
      const controls = [...popup.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(element => element.tabIndex >= 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }, {signal:events.signal});
  window.addEventListener('resize', position, {signal:events.signal});
  document.addEventListener('scroll', position, {capture:true, signal:events.signal});
  function dispose() { if (disposed) return; disposed = true; sequence++; events.abort(); popup.remove(); wrapper.remove(); }
  signal?.addEventListener('abort', dispose, {once:true});
  updateTrigger();
  void refresh();
  return {
    getValue: () => normalizeModelPreferences(committed),
    update(options) {
      if (disposed) return;
      if (options.scope !== undefined && options.scope !== currentScope) { saving = false; close(false); currentScope = options.scope; }
      if (Object.hasOwn(options, 'value')) { committed = normalizeModelPreferences(options.value); preferencesReady = true; }
      if (options.disabled !== undefined) disabled = options.disabled;
      updateTrigger();
    },
    dispose,
  };
}
