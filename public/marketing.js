import { createApiClient } from './api-client.js?v=4';
import { initSiteInteractions } from './site-interactions.js?v=5';
import { modelLogoUrl } from './components/model-logo.js?v=11';

initSiteInteractions();

(() => {
  const { request: api } = createApiClient({ responseShapeFor: () => 'object' });
  const detectedPlatform = String(window.navigator.userAgentData?.platform || window.navigator.platform || window.navigator.userAgent || '');
  const preferredDownloadPlatform = /iphone|ipad|android/i.test(detectedPlatform) ? '' : /mac/i.test(detectedPlatform) ? 'mac' : /win/i.test(detectedPlatform) ? 'windows' : '';
  if (preferredDownloadPlatform) {
    document.querySelectorAll('.nav-download, .nav-cta').forEach(link => {
      const href = link.getAttribute('href') || '';
      if (href === '#download' || href === '/#download') link.setAttribute('href', `/downloads/${preferredDownloadPlatform}`);
    });
  }
  {
    const page = document.body.dataset.page;
    document.querySelectorAll('[data-page-link]').forEach(link => {
      const active = link.dataset.pageLink === page;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
  const formatNumber = (value, digits = 2) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return number.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  const formatDateTime = value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '刚刚';
    return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  };
  const unitText = unit => unit === 'request' ? '次' : '秒';
  const iconMarkup = (modelId, kind = '') => {
    // Speech models are MiniMax voices.
    const logo = modelLogoUrl(modelId, kind === 'audio' ? 'minimax' : '');
    if (logo) return `<img src="${logo}" alt="" width="22" height="22" decoding="async">`;
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="M12 7v5l3.5 2"/></svg>';
  };

  // Homepage model families follow the live price list; the static list stays if it cannot load.
  const modelStrip = document.querySelector('[data-model-strip]');
  if (modelStrip) {
    const families = [['bytedance', 'Seedance'], ['kling', 'Kling'], ['minimax', 'MiniMax'], ['openai', 'GPT Image'], ['midjourney', 'Midjourney'], ['qwen', 'Wan'], ['gemini', 'Veo'], ['grok', 'Grok']];
    api('/api/public/model-prices', { responseShape: data => Boolean(data && Array.isArray(data.models)) }).then(payload => {
      const logos = new Set(payload.models.map(model => modelLogoUrl(model.id)).filter(Boolean));
      const items = families.map(([key, name]) => [[...logos].find(logo => logo.includes(`/${key}`)), name]).filter(([logo]) => logo);
      if (items.length) modelStrip.innerHTML = items.map(([logo, name]) => `<li><img src="${logo}" alt="" width="28" height="28">${escapeHtml(name)}</li>`).join('');
    }).catch(() => {});
  }

  const pricePage = document.querySelector('[data-price-page]');
  if (!pricePage) return;
  const catalog = document.querySelector('#priceCatalog');
  const status = document.querySelector('#priceStatus');
  const updated = document.querySelector('#priceUpdated');
  const refresh = document.querySelector('#priceRefresh');
  let loading = false;

  const setStatus = (message, state = '') => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-live', state === 'live');
    status.classList.toggle('is-error', state === 'error');
  };
  const modelInitial = label => escapeHtml(String(label || 'AI').trim().slice(0, 1).toUpperCase());
  const renderCard = (model, rows, description = '') => {
    const rowHtml = rows.map(item => {
      const unit = unitText(item.unit);
      const hasDuration = item.duration !== null && item.duration !== undefined && Number.isFinite(Number(item.duration));
      const duration = hasDuration ? Number(item.duration) : null;
      const maxDuration = hasDuration && Number(item.maxDuration) > duration ? Number(item.maxDuration) : duration;
      const range = (min, max, digits) => min === max ? formatNumber(min, digits) : `${formatNumber(min, digits)}–${formatNumber(max, digits)}`;
      const durationText = hasDuration ? `${range(duration, maxDuration, 0)} 秒视频` : `按${unit}计费`;
      const total = hasDuration && item.unit !== 'request' && Number.isFinite(Number(item.yuan)) ? ` · ${range(Number(item.yuan) * duration, Number(item.yuan) * maxDuration)} 元 / ${range(duration, maxDuration, 0)} 秒` : '';
      return `<div class="price-row"><div class="price-row-label"><b>${escapeHtml(item.quality || '标准')}</b><small>${durationText}${total}</small></div><div class="price-row-value"><strong>¥${formatNumber(item.yuan)}<span>/ ${unit}</span></strong><small>${formatNumber(item.credits, 2)} 积分 / ${unit}</small></div></div>`;
    }).join('');
    const modelLabel = model?.label || rows[0]?.label || rows[0]?.modelId || '未命名模型';
    return `<article class="price-card"><header class="price-card-head"><div class="price-card-title"><span class="price-model-icon">${iconMarkup(rows[0]?.modelId, rows[0]?.kind)}<span hidden>${modelInitial(modelLabel)}</span></span><div><h2>${escapeHtml(modelLabel)}</h2><p class="price-card-description">${escapeHtml(description || model?.description || '当前可用模型')}</p></div></div><span class="price-badge">当前可用</span></header><div class="price-rows">${rowHtml}</div><p class="price-card-note">价格会随服务状态更新，开始生成前会再次确认。</p></article>`;
  };
  const renderUnavailableCard = model => `<article class="price-card"><header class="price-card-head"><div class="price-card-title"><span class="price-model-icon">${iconMarkup(model.id)}</span><div><h2>${escapeHtml(model.label)}</h2><p class="price-card-description">${escapeHtml(model.description || '模型能力正在准备中')}</p></div></div><span class="price-badge is-coming">${model.availability === 'coming-soon' ? '即将上线' : '暂不可用'}</span></header><div class="price-empty">当前没有可展示的实时价格</div><p class="price-card-note">服务恢复后，价格会自动出现在这里。</p></article>`;

  const renderCatalog = payload => {
    const items = Array.isArray(payload?.items) ? payload.items.filter(item => item?.available !== false && Number.isFinite(Number(item?.yuan))) : [];
    const models = Array.isArray(payload?.models) ? payload.models : [];
    const groups = new Map();
    items.forEach(item => {
      const key = String(item.modelId || item.label || 'unknown');
      const group = groups.get(key) || { rows: [], label: item.label, modelId: key };
      group.rows.push(item);
      groups.set(key, group);
    });
    const cards = [...groups.values()].map(group => {
      const model = models.find(item => item.id === group.modelId);
      return renderCard(model, group.rows, model?.description || '');
    });
    models.filter(model => !groups.has(model.id) && model.id !== 'gpt-image-2').forEach(model => cards.push(renderUnavailableCard(model)));
    if (!cards.length) {
      catalog.innerHTML = '<div class="price-empty"><strong>暂时没有可展示的模型价格</strong>价格正在更新，请稍后点击“刷新价格”重试。</div>';
      return;
    }
    catalog.innerHTML = cards.join('');
  };

  const loadPrices = async () => {
    if (loading) return;
    loading = true;
    catalog.setAttribute('aria-busy', 'true');
    refresh?.setAttribute('aria-busy', 'true');
    if (refresh) refresh.disabled = true;
    setStatus('正在获取最新价格…');
    if (!catalog.children.length || catalog.querySelector('.price-loading')) catalog.innerHTML = '<div class="price-loading">正在更新今日模型价格</div>';
    try {
      const payload = await api('/api/public/model-prices', { cache:'no-store', responseShape: data => Boolean(data && typeof data === 'object' && Array.isArray(data.items)) });
      renderCatalog(payload);
      setStatus('实时价格已更新', 'live');
      if (updated) updated.textContent = `更新时间：${formatDateTime(payload.generatedAt)}`;
      pricePage.dataset.loaded = 'true';
    } catch (error) {
      setStatus('价格获取失败，请稍后重试', 'error');
      if (updated && !pricePage.dataset.loaded) updated.textContent = '暂时无法确认更新时间';
      if (!pricePage.dataset.loaded) catalog.innerHTML = `<div class="price-empty"><strong>价格暂时无法获取</strong>${escapeHtml(error.message || '请稍后重试，或检查网络连接。')}</div>`;
    } finally {
      loading = false;
      catalog.setAttribute('aria-busy', 'false');
      refresh?.removeAttribute('aria-busy');
      if (refresh) refresh.disabled = false;
    }
  };

  refresh?.addEventListener('click', loadPrices);
  void loadPrices();
  window.setInterval(() => { if (!document.hidden) void loadPrices(); }, 60_000);
})();
