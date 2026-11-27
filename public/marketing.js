import { createApiClient } from './api-client.js?v=4';
import { initSiteInteractions } from './site-interactions.js?v=5';
import { modelLogoUrl } from './components/model-logo.js?v=13';
import { escapeHtml, formatDateTime, renderPriceCatalog } from './price-catalog.js?v=1';

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

  // Homepage model families follow the live price list; the static list stays if it cannot load.
  const modelStrip = document.querySelector('[data-model-strip]');
  if (modelStrip) {
    const families = [['bytedance', 'Seedance'], ['kling', 'Kling'], ['minimax', 'MiniMax'], ['openai', 'GPT Image'], ['midjourney', 'Midjourney'], ['qwen', 'Wan'], ['gemini', 'Nano Banana'], ['grok', 'Grok']];
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
  const renderCatalog = payload => {
    const cards = renderPriceCatalog(payload);
    catalog.innerHTML = cards || '<div class="price-empty"><strong>暂时没有可展示的模型价格</strong>价格正在更新，请稍后点击“刷新价格”重试。</div>';
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
