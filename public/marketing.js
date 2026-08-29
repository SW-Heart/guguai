(() => {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const header = document.querySelector('#site-header');
  const setHeaderState = () => header?.classList.toggle('is-scrolled', window.scrollY > 16);
  setHeaderState();
  window.addEventListener('scroll', setHeaderState, { passive: true });

  const page = document.body.dataset.page;
  document.querySelectorAll('[data-page-link]').forEach(link => {
    link.classList.toggle('is-active', link.dataset.pageLink === page);
  });

  const reveals = [...document.querySelectorAll('.reveal')];
  if ('IntersectionObserver' in window && !reducedMotion) {
    const observer = new IntersectionObserver((entries, activeObserver) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in-view');
        activeObserver.unobserve(entry.target);
      });
    }, { threshold: .12, rootMargin: '0px 0px -30px' });
    reveals.forEach(node => observer.observe(node));
  } else {
    reveals.forEach(node => node.classList.add('in-view'));
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
  const iconMarkup = modelId => {
    if (modelId === 'gpt-image-2') return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="2.5"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 4"/></svg>';
    if (String(modelId).startsWith('seedance')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 14 7-14 7V5Z"/><path d="M9 9.5 15 12l-6 2.5"/></svg>';
    if (String(modelId).includes('veo') || modelId === 'oai') return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9 9.5 15 12l-6 2.5V9.5Z"/></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="M12 7v5l3.5 2"/></svg>';
  };

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
      const duration = Number(item.duration);
      const durationText = Number.isFinite(duration) ? `${formatNumber(duration, 0)} 秒视频` : `按${unit}计费`;
      const total = Number.isFinite(Number(item.totalYuan)) ? ` · ${formatNumber(item.totalYuan)} 元 / ${formatNumber(duration, 0)} 秒` : '';
      return `<div class="price-row"><div class="price-row-label"><b>${escapeHtml(item.quality || '标准')}</b><small>${durationText}${total}</small></div><div class="price-row-value"><strong>¥${formatNumber(item.yuan)}<span>/ ${unit}</span></strong><small>${formatNumber(item.credits, 2)} 积分 / ${unit}</small></div></div>`;
    }).join('');
    const modelLabel = model?.label || rows[0]?.label || rows[0]?.modelId || '未命名模型';
    return `<article class="price-card reveal in-view"><header class="price-card-head"><div class="price-card-title"><span class="price-model-icon">${iconMarkup(rows[0]?.modelId)}<span hidden>${modelInitial(modelLabel)}</span></span><div><h2>${escapeHtml(modelLabel)}</h2><p class="price-card-description">${escapeHtml(description || model?.description || '当前可用模型')}</p></div></div><span class="price-badge">当前可用</span></header><div class="price-rows">${rowHtml}</div><p class="price-card-note">价格随当前可用线路实时计算，提交任务前仍会再次确认。</p></article>`;
  };
  const renderUnavailableCard = model => `<article class="price-card reveal in-view"><header class="price-card-head"><div class="price-card-title"><span class="price-model-icon">${iconMarkup(model.id)}</span><div><h2>${escapeHtml(model.label)}</h2><p class="price-card-description">${escapeHtml(model.description || '模型能力正在准备中')}</p></div></div><span class="price-badge is-coming">${model.availability === 'coming-soon' ? '即将上线' : '暂不可用'}</span></header><div class="price-empty" style="padding:24px 14px;border:0;background:rgba(255,255,255,.36)">当前没有可展示的实时价格</div><p class="price-card-note">线路恢复后，价格会自动出现在这里。</p></article>`;

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
      catalog.innerHTML = '<div class="price-empty"><strong>暂时没有可展示的模型价格</strong>价格服务正在同步，请稍后点击“刷新价格”重试。</div>';
      return;
    }
    catalog.innerHTML = cards.join('');
    catalog.querySelectorAll('.reveal').forEach(node => requestAnimationFrame(() => node.classList.add('in-view')));
  };

  const loadPrices = async () => {
    if (loading) return;
    loading = true;
    refresh?.setAttribute('aria-busy', 'true');
    if (refresh) refresh.disabled = true;
    setStatus('正在获取最新价格…');
    if (!catalog.children.length || catalog.querySelector('.price-loading')) catalog.innerHTML = '<div class="price-loading">正在同步今日模型价格</div>';
    try {
      const response = await fetch('/api/public/model-prices', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || !Array.isArray(payload.items)) throw new Error(payload?.error || '价格服务暂时不可用');
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
      refresh?.removeAttribute('aria-busy');
      if (refresh) refresh.disabled = false;
    }
  };

  refresh?.addEventListener('click', loadPrices);
  void loadPrices();
  window.setInterval(() => { if (!document.hidden) void loadPrices(); }, 60_000);
})();
