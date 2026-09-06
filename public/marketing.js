import { createApiClient } from './api-client.js?v=3';

(() => {
  const { request: api } = createApiClient({ responseShapeFor: () => 'object' });
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const isHomePage = document.body.dataset.page === 'home';
  if (!isHomePage) {
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

  const loginDestination = credits => `/login?next=${encodeURIComponent(credits ? `/pricing?purchase=${credits}` : '/pricing')}`;
  const pricePage = document.querySelector('[data-price-page]');
  const siteAccountMenu = document.querySelector('#siteAccountMenu');
  const siteAccountDropdown = document.querySelector('#siteAccountDropdown');
  const siteAccountSummary = document.querySelector('#siteAccountSummary');
  const siteLogoutButton = document.querySelector('#siteLogoutButton');
  const siteLoginLink = document.querySelector('#siteLoginLink');
  const siteLoginText = document.querySelector('#siteLoginText');
  const renderSiteAccount = user => {
    const signedIn = Boolean(user);
    const identity = user?.nickname || user?.displayName || user?.username || '账号';
    const identityText = signedIn ? `${identity} · ${formatNumber(user.credits, 0)} 积分` : '';
    siteAccountMenu?.classList.toggle('is-signed-in', signedIn);
    if (siteLoginText) siteLoginText.textContent = signedIn ? identity : '登录';
    if (siteLoginLink) {
      siteLoginLink.href = signedIn ? '#' : loginDestination();
      siteLoginLink.setAttribute('aria-label', signedIn ? `当前账号：${identityText}` : '登录');
      siteLoginLink.setAttribute('aria-expanded', 'false');
    }
    if (siteAccountSummary) siteAccountSummary.textContent = signedIn ? identityText : '';
    siteAccountDropdown?.setAttribute('aria-hidden', String(!signedIn));
  };
  const loadSiteAccount = async () => {
    try {
      const payload = await api('/api/auth/me', { cache:'no-store' });
      renderSiteAccount(payload.user);
      return payload.user || null;
    } catch {
      renderSiteAccount(null);
      return null;
    }
  };
  const setAccountMenuOpen = open => siteLoginLink?.setAttribute('aria-expanded', String(Boolean(open)));
  siteAccountMenu?.addEventListener('pointerenter', () => setAccountMenuOpen(true));
  siteAccountMenu?.addEventListener('pointerleave', () => setAccountMenuOpen(false));
  siteAccountMenu?.addEventListener('focusin', () => setAccountMenuOpen(true));
  siteAccountMenu?.addEventListener('focusout', event => {
    if (!siteAccountMenu.contains(event.relatedTarget)) setAccountMenuOpen(false);
  });
  siteLoginLink?.addEventListener('click', event => {
    if (siteAccountMenu?.classList.contains('is-signed-in')) event.preventDefault();
  });
  let siteLogoutConfirmation = null;
  const confirmSiteLogout = () => {
    if (!siteLogoutConfirmation) {
      const dialog = document.createElement('dialog');
      dialog.id = 'siteLogoutConfirmDialog';
      dialog.className = 'site-confirm-dialog';
      dialog.setAttribute('aria-labelledby', 'siteLogoutConfirmTitle');
      dialog.setAttribute('aria-describedby', 'siteLogoutConfirmMessage');
      dialog.innerHTML = `<div class="site-confirm-card"><span class="site-confirm-kicker">账号操作</span><h2 id="siteLogoutConfirmTitle">确认退出登录</h2><p id="siteLogoutConfirmMessage">退出后需要重新登录才能继续购买积分或进入创作工作台。</p><footer><button class="secondary-button" data-site-logout-cancel type="button">取消</button><button class="primary-button" data-site-logout-confirm type="button">确认退出</button></footer></div>`;
      document.body.append(dialog);
      const state = { resolver:null, restoreFocus:null };
      const settle = confirmed => {
        const resolver = state.resolver;
        const restoreFocus = state.restoreFocus;
        state.resolver = null;
        state.restoreFocus = null;
        if (dialog.open) dialog.close();
        resolver?.(confirmed);
        window.requestAnimationFrame(() => { if (restoreFocus?.isConnected && !restoreFocus.disabled) restoreFocus.focus(); });
      };
      dialog.querySelector('[data-site-logout-cancel]').addEventListener('click', () => settle(false));
      dialog.querySelector('[data-site-logout-confirm]').addEventListener('click', () => settle(true));
      dialog.addEventListener('cancel', event => { event.preventDefault(); settle(false); });
      dialog.addEventListener('click', event => { if (event.target === dialog) settle(false); });
      siteLogoutConfirmation = () => {
        if (state.resolver) settle(false);
        state.restoreFocus = document.activeElement;
        return new Promise(resolve => {
          state.resolver = resolve;
          dialog.showModal();
          window.requestAnimationFrame(() => dialog.querySelector('[data-site-logout-confirm]').focus());
        });
      };
    }
    return siteLogoutConfirmation();
  };
  siteLogoutButton?.addEventListener('click', async () => {
    if (!await confirmSiteLogout()) return;
    siteLogoutButton.disabled = true;
    try {
      await api('/api/auth/logout', { method:'POST', body:'{}' });
      window.location.assign('/');
    } catch (error) {
      if (siteAccountSummary) siteAccountSummary.textContent = error.message || '退出登录失败，请稍后重试';
    } finally {
      siteLogoutButton.disabled = false;
    }
  });
  if (!pricePage) {
    void loadSiteAccount();
    return;
  }
  const catalog = document.querySelector('#priceCatalog');
  const status = document.querySelector('#priceStatus');
  const updated = document.querySelector('#priceUpdated');
  const refresh = document.querySelector('#priceRefresh');
  const purchaseAccount = document.querySelector('#purchaseAccount');
  const purchaseAccountText = document.querySelector('#purchaseAccountText');
  const purchaseLoginLink = document.querySelector('#purchaseLoginLink');
  const paymentTracker = document.querySelector('#paymentTracker');
  const paymentTrackerTitle = document.querySelector('#paymentTrackerTitle');
  const paymentTrackerMessage = document.querySelector('#paymentTrackerMessage');
  const paymentRefresh = document.querySelector('#paymentRefresh');
  const purchaseButtons = [...document.querySelectorAll('[data-buy-credits]')];
  const orderFromUrl = new URLSearchParams(window.location.search).get('order') || '';
  const paymentOrderStorageKey = user => `gugu_alipay_order:${encodeURIComponent(String(user?.id || user?.username || 'anonymous'))}`;
  let pendingOrderNo = /^[A-Za-z0-9_-]+$/.test(orderFromUrl) ? orderFromUrl : '';
  let purchaseUser = null;
  let purchaseSessionReady = false;
  let paymentPollTimer = 0;
  let loading = false;

  const showPurchaseAccount = user => {
    purchaseUser = user || null;
    if (!orderFromUrl) pendingOrderNo = user ? sessionStorage.getItem(paymentOrderStorageKey(user)) || '' : '';
    purchaseSessionReady = true;
    const signedIn = Boolean(user);
    const identityText = user ? `${user.nickname || user.displayName || user.username || '已登录'} · ${formatNumber(user.credits, 0)} 积分` : '购买前需要登录';
    purchaseAccount?.classList.toggle('is-signed-in', signedIn);
    if (purchaseAccountText) purchaseAccountText.textContent = identityText;
    if (purchaseLoginLink) purchaseLoginLink.textContent = signedIn ? '已登录' : '登录后购买';
    renderSiteAccount(user);
  };
  const loadPurchaseAccount = async () => {
    const user = await loadSiteAccount();
    showPurchaseAccount(user);
    return user;
  };
  const setPaymentTracker = (title, message, tone = '') => {
    if (!paymentTracker) return;
    paymentTracker.hidden = false;
    paymentTracker.classList.toggle('is-paid', tone === 'paid');
    paymentTrackerTitle.textContent = title;
    paymentTrackerMessage.textContent = message;
    if (paymentRefresh) paymentRefresh.hidden = tone === 'paid';
  };
  const stopPaymentPolling = () => { window.clearTimeout(paymentPollTimer); paymentPollTimer = 0; };
  const submitPaymentForm = paymentHtml => {
    const container = document.createElement('div');
    container.hidden = true;
    container.innerHTML = String(paymentHtml || '');
    const form = container.querySelector('form');
    if (!form) throw new Error('支付宝支付表单无效');
    form.target = '_self';
    document.body.appendChild(container);
    form.submit();
  };
  const schedulePaymentPolling = () => {
    stopPaymentPolling();
    if (!pendingOrderNo) return;
    paymentPollTimer = window.setTimeout(() => { void refreshPayment({ polling:true }); }, 3000);
  };
  const refreshPayment = async ({ polling = false } = {}) => {
    if (!pendingOrderNo) return;
    paymentRefresh.disabled = true;
    if (!polling) setPaymentTracker('正在确认支付结果', '正在向支付宝查询这笔订单，请稍候。');
    try {
      const result = await api(`/api/payments/alipay/orders/${encodeURIComponent(pendingOrderNo)}/query`, { method:'POST', body:'{}' });
      if (result.order?.status === 'PAID') {
        stopPaymentPolling();
        sessionStorage.removeItem(paymentOrderStorageKey(purchaseUser));
        pendingOrderNo = '';
        setPaymentTracker('积分已经到账', `${formatNumber(result.order.credits, 0)} 积分已加入你的账户。`, 'paid');
        await loadPurchaseAccount();
      } else if (result.order?.status === 'CLOSED') {
        stopPaymentPolling();
        setPaymentTracker('订单已关闭', '这笔订单没有完成付款，可以重新选择积分包。');
      } else {
        setPaymentTracker('等待扫码付款', '请使用支付宝扫描二维码，支付后积分会自动到账。');
        schedulePaymentPolling();
      }
    } catch (error) {
      if (error.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent(`/pricing?order=${pendingOrderNo}`)}`);
        return;
      }
      setPaymentTracker('暂时无法确认订单', error.message || '请稍后再试。');
    } finally {
      paymentRefresh.disabled = false;
    }
  };
  const purchaseCredits = async (credits, button) => {
    button.disabled = true;
    try {
      const result = await api('/api/payments/alipay/orders', { method:'POST', body:JSON.stringify({ credits }) });
      pendingOrderNo = result.order.outTradeNo;
      sessionStorage.setItem(paymentOrderStorageKey(purchaseUser), pendingOrderNo);
      setPaymentTracker('正在进入支付宝收银台', `将在当前页面展示 ¥${result.order.totalAmount} 的支付宝扫码入口。`);
      submitPaymentForm(result.paymentHtml);
    } catch (error) {
      if (error.status === 401) {
        window.location.assign(loginDestination(credits));
        return;
      }
      setPaymentTracker('支付订单创建失败', error.message || '请稍后再试。');
    } finally {
      button.disabled = false;
    }
  };
  purchaseButtons.forEach(button => button.addEventListener('click', () => {
    const credits = Number(button.dataset.buyCredits);
    if (purchaseSessionReady && !purchaseUser) {
      window.location.assign(loginDestination(credits));
      return;
    }
    void purchaseCredits(credits, button);
  }));
  paymentRefresh?.addEventListener('click', () => { void refreshPayment(); });

  const requestedCredits = Number(new URLSearchParams(window.location.search).get('purchase'));
  const requestedCard = document.querySelector(`[data-credit-package="${requestedCredits}"]`);
  if (requestedCard) {
    requestedCard.classList.add('is-requested');
    requestAnimationFrame(() => requestedCard.scrollIntoView({ behavior:reducedMotion ? 'auto' : 'smooth', block:'center' }));
  }
  const purchaseSessionPromise = loadPurchaseAccount();
  void purchaseSessionPromise.then(() => {
    if (!pendingOrderNo) return;
    setPaymentTracker('发现一笔待确认订单', '完成付款后，可以在这里刷新支付状态。');
    if (orderFromUrl) void refreshPayment();
  });

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
      const durationText = hasDuration ? `${formatNumber(duration, 0)} 秒视频` : `按${unit}计费`;
      const total = hasDuration && Number.isFinite(Number(item.totalYuan)) ? ` · ${formatNumber(item.totalYuan)} 元 / ${formatNumber(duration, 0)} 秒` : '';
      return `<div class="price-row"><div class="price-row-label"><b>${escapeHtml(item.quality || '标准')}</b><small>${durationText}${total}</small></div><div class="price-row-value"><strong>¥${formatNumber(item.yuan)}<span>/ ${unit}</span></strong><small>${formatNumber(item.credits, 2)} 积分 / ${unit}</small></div></div>`;
    }).join('');
    const modelLabel = model?.label || rows[0]?.label || rows[0]?.modelId || '未命名模型';
    return `<article class="price-card reveal in-view"><header class="price-card-head"><div class="price-card-title"><span class="price-model-icon">${iconMarkup(rows[0]?.modelId)}<span hidden>${modelInitial(modelLabel)}</span></span><div><h2>${escapeHtml(modelLabel)}</h2><p class="price-card-description">${escapeHtml(description || model?.description || '当前可用模型')}</p></div></div><span class="price-badge">当前可用</span></header><div class="price-rows">${rowHtml}</div><p class="price-card-note">价格会随服务状态更新，提交任务前仍会再次确认。</p></article>`;
  };
  const renderUnavailableCard = model => `<article class="price-card reveal in-view"><header class="price-card-head"><div class="price-card-title"><span class="price-model-icon">${iconMarkup(model.id)}</span><div><h2>${escapeHtml(model.label)}</h2><p class="price-card-description">${escapeHtml(model.description || '模型能力正在准备中')}</p></div></div><span class="price-badge is-coming">${model.availability === 'coming-soon' ? '即将上线' : '暂不可用'}</span></header><div class="price-empty" style="padding:24px 14px;border:0;background:rgba(255,255,255,.36)">当前没有可展示的实时价格</div><p class="price-card-note">服务恢复后，价格会自动出现在这里。</p></article>`;

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
      refresh?.removeAttribute('aria-busy');
      if (refresh) refresh.disabled = false;
    }
  };

  refresh?.addEventListener('click', loadPrices);
  void loadPrices();
  window.setInterval(() => { if (!document.hidden) void loadPrices(); }, 60_000);
})();
