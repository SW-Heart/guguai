function query(selector) {
  return globalThis.document?.querySelector?.(selector) || null;
}

// Unread messages are shown one after another in a single dialog, at most this many at a time.
const MAX_DIALOG_MESSAGES = 4;

export function createNotificationController({ state, api, esc, toast, accountSnapshot, isAccountCurrent, render:renderOverride = null }) {
  let closeTimer = 0;
  // Messages that arrive while the app is open wait for the next page switch,
  // so they never interrupt work on the current page.
  let knownAccount = null;
  let knownIds = new Set();
  let arrivedIds = new Set();

  function countText(count) {
    return Number(count) > 99 ? '99+' : String(Math.max(0, Number(count) || 0));
  }

  function dateText(value) {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime())
      ? date.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false })
      : '—';
  }

  function previewText(item) {
    return String(item?.contentText || item?.content || '').replace(/\r\n?/g, '\n').trim();
  }

  function contentMarkup(item) {
    if (item?.contentHtml) return String(item.contentHtml);
    return `<p>${esc(item?.content || '').replace(/\n/g, '<br>')}</p>`;
  }

  let notificationDialogRestoreFocus = null;
  let openNotificationId = '';
  let dialogQueue = [];
  let dialogIndex = 0;

  function closeNotificationDialog() {
    const dialog = query('#notificationDialog');
    if (dialog?.open) dialog.close();
  }

  function showDialogMessage(item) {
    const body = query('#notificationDialogBody');
    openNotificationId = item.id;
    query('#notificationDialogTitle').textContent = item.title || '消息通知';
    query('#notificationDialogTime').textContent = dateText(item.publishedAt);
    body.innerHTML = contentMarkup(item);
    body.scrollTop = 0;
    if (item.summary && !item.contentHtml) void loadFullNotification(item, body);
    const multiple = dialogQueue.length > 1;
    const last = dialogIndex >= dialogQueue.length - 1;
    const step = query('#notificationDialogStep');
    if (step) {
      step.hidden = !multiple;
      step.textContent = multiple ? `${dialogIndex + 1} / ${dialogQueue.length}` : '';
    }
    const done = query('#notificationDialogDone');
    if (done) done.textContent = last ? '知道了' : '下一条';
    const later = query('#notificationDialogLater');
    if (later) later.hidden = last;
    markRead(item.id);
  }

  function openNotifications(items, trigger) {
    const [item] = items;
    if (!item) return;
    const dialog = query('#notificationDialog');
    if (!dialog || !query('#notificationDialogTitle') || !query('#notificationDialogTime') || !query('#notificationDialogBody')) { markRead(item.id); return; }
    notificationDialogRestoreFocus = trigger || globalThis.document?.activeElement || null;
    dialogQueue = items.slice(0, MAX_DIALOG_MESSAGES);
    dialogIndex = 0;
    showDialogMessage(item);
    dialog.hidden = false;
    dialog.setAttribute('aria-hidden', 'false');
    if (!dialog.open) dialog.showModal();
  }

  function openNotification(item, trigger) {
    if (item) openNotifications([item], trigger);
  }

  function showNextNotification() {
    if (dialogIndex >= dialogQueue.length - 1) {
      closeNotificationDialog();
      return;
    }
    dialogIndex += 1;
    showDialogMessage(dialogQueue[dialogIndex]);
  }

  // Background refreshes only carry previews; the full message is fetched when it is opened.
  async function loadFullNotification(item, body) {
    const requestAccount = accountSnapshot();
    try {
      const result = await api(`/api/notifications/${encodeURIComponent(item.id)}`);
      const full = result?.item;
      if (!full?.contentHtml || !isAccountCurrent(requestAccount)) return;
      Object.assign(item, { contentHtml:full.contentHtml, contentText:full.contentText, summary:false });
      if (openNotificationId === item.id && query('#notificationDialog')?.open) body.innerHTML = contentMarkup(item);
    } catch {}
  }

  function canOpenDialog(items) {
    const dialog = query('#notificationDialog');
    return Boolean(items.length && dialog && !dialog.open && query('#notificationDialogTitle') && query('#notificationDialogTime') && query('#notificationDialogBody'));
  }

  function openLatestUnread() {
    const items = state.notifications.filter(notification => !notification.isRead);
    if (!canOpenDialog(items)) return false;
    openNotifications(items);
    return true;
  }

  function openArrivedUnread() {
    const items = state.notifications.filter(notification => !notification.isRead && arrivedIds.has(notification.id));
    if (!canOpenDialog(items)) return false;
    arrivedIds = new Set();
    openNotifications(items);
    return true;
  }

  function trackArrivals(requestAccount) {
    const ids = state.notifications.map(item => item.id);
    if (!knownAccount || !isAccountCurrent(knownAccount)) {
      knownAccount = requestAccount;
      knownIds = new Set(ids);
      arrivedIds = new Set();
      return;
    }
    for (const item of state.notifications) {
      if (!knownIds.has(item.id) && !item.isRead) arrivedIds.add(item.id);
    }
    knownIds = new Set(ids);
    arrivedIds = new Set([...arrivedIds].filter(id => knownIds.has(id)));
  }

  function render() {
    if (renderOverride) {
      renderOverride();
      return;
    }
    const count = Math.max(0, Number(state.unreadNotifications) || 0);
    const unreadText = countText(count);
    const countElement = query('#notificationCount');
    const avatarBadge = query('#avatarNotificationBadge');
    const summary = query('#notificationSummary');
    const list = query('#notificationList');
    if (!list) return;
    countElement.textContent = unreadText;
    countElement.classList.toggle('hidden', count === 0);
    avatarBadge.textContent = unreadText;
    avatarBadge.setAttribute('aria-label', `${count} 条未读消息`);
    avatarBadge.classList.toggle('hidden', count === 0);
    summary.textContent = count ? `${unreadText} 条未读消息 · 共 ${state.notifications.length} 条历史` : `共 ${state.notifications.length} 条历史消息`;
    query('#markAllNotifications').disabled = count === 0;
    if (!state.notifications.length) {
      list.innerHTML = '<div class="notification-empty"><span aria-hidden="true">—</span><b>暂无消息</b><small>新的公告会出现在这里。</small></div>';
      return;
    }
    list.innerHTML = state.notifications.map(item => `<article class="notification-item ${item.isRead ? '' : 'is-unread'}"><button type="button" data-notification-id="${esc(item.id)}" aria-label="查看消息：${esc(item.title)}"><span class="notification-item-top"><strong>${esc(item.title)}</strong><time datetime="${esc(item.publishedAt || '')}">${esc(dateText(item.publishedAt))}</time></span><span class="notification-item-content">${esc(previewText(item))}</span><span class="notification-item-more">查看全文</span>${item.isRead ? '' : '<i class="notification-unread-dot" aria-label="未读"></i>'}</button></article>`).join('');
  }

  function setPanelOpen(open) {
    const item = query('.notification-menu-item');
    const panel = query('#notificationPanel');
    const trigger = query('#notificationMenuButton');
    if (!item || !panel || !trigger) return;
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    item.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    trigger.setAttribute('aria-expanded', String(open));
    // focusin opens this panel during mouse-down. Re-rendering here removes
    // the pressed button before mouse-up, preventing its click from firing.
  }

  function schedulePanelClose() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      closeTimer = 0;
      const item = query('.notification-menu-item');
      if (!item?.matches(':hover') && !item?.matches(':focus-within')) setPanelOpen(false);
    }, 180);
  }

  async function load() {
    const requestAccount = accountSnapshot();
    try {
      const result = await api('/api/notifications?limit=200&view=summary');
      if (!isAccountCurrent(requestAccount)) return;
      const loaded = new Map(state.notifications.filter(item => item.contentHtml).map(item => [item.id, item]));
      state.notifications = (Array.isArray(result.items) ? result.items : []).map(item => {
        const previous = loaded.get(item.id);
        return item.summary && previous?.updatedAt === item.updatedAt ? { ...item, contentHtml:previous.contentHtml, contentText:previous.contentText, summary:false } : item;
      });
      state.unreadNotifications = Number(result.unreadCount) || 0;
      trackArrivals(requestAccount);
      render();
    } catch (error) {
      if (isAccountCurrent(requestAccount) && error.status === 401) location.reload();
    }
  }

  async function markRead(id) {
    const notifications = state.notifications;
    const item = state.notifications.find(notification => notification.id === id);
    if (!item || item.isRead) return;
    item.isRead = true;
    state.unreadNotifications = Math.max(0, state.unreadNotifications - 1);
    render();
    const requestAccount = accountSnapshot();
    try {
      await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method:'POST', body:'{}' });
    } catch {
      if (!isAccountCurrent(requestAccount) || state.notifications !== notifications) return;
      item.isRead = false;
      state.unreadNotifications += 1;
      render();
      toast('消息状态更新失败，请稍后重试');
    }
  }

  async function markAllRead() {
    if (!state.unreadNotifications) return;
    const notifications = state.notifications;
    const previous = state.notifications.map(item => item.isRead);
    state.notifications.forEach(item => { item.isRead = true; });
    state.unreadNotifications = 0;
    render();
    const requestAccount = accountSnapshot();
    try {
      await api('/api/notifications/read-all', { method:'POST', body:'{}' });
    } catch {
      if (!isAccountCurrent(requestAccount) || state.notifications !== notifications) return;
      state.notifications.forEach((item, index) => { item.isRead = previous[index]; });
      state.unreadNotifications = state.notifications.filter(item => !item.isRead).length;
      render();
      toast('消息状态更新失败，请稍后重试');
    }
  }

  query('#notificationList')?.addEventListener('click', event => {
    const button = event.target?.closest?.('[data-notification-id]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    openNotification(state.notifications.find(item => item.id === button.dataset.notificationId), button);
  });
  query('#closeNotificationDialog')?.addEventListener('click', closeNotificationDialog);
  query('#notificationDialogDone')?.addEventListener('click', showNextNotification);
  query('#notificationDialogLater')?.addEventListener('click', closeNotificationDialog);
  query('#notificationDialog')?.addEventListener('click', event => { if (event.target === event.currentTarget) closeNotificationDialog(); });
  query('#notificationDialog')?.addEventListener('cancel', event => { event.preventDefault(); closeNotificationDialog(); });
  query('#notificationDialog')?.addEventListener('close', () => {
    const dialog = query('#notificationDialog');
    dialog?.setAttribute('aria-hidden', 'true');
    openNotificationId = '';
    dialogQueue = [];
    dialogIndex = 0;
    requestAnimationFrame(() => { if (notificationDialogRestoreFocus?.isConnected && !notificationDialogRestoreFocus.disabled) notificationDialogRestoreFocus.focus(); });
    notificationDialogRestoreFocus = null;
  });

  return { load, render, setPanelOpen, schedulePanelClose, markRead, markAllRead, openNotification, openLatestUnread, openArrivedUnread, closeNotificationDialog };
}
