function query(selector) {
  return document.querySelector(selector);
}

export function createNotificationController({ state, api, esc, toast, accountSnapshot, isAccountCurrent, render:renderOverride = null }) {
  let closeTimer = 0;

  function countText(count) {
    return Number(count) > 99 ? '99+' : String(Math.max(0, Number(count) || 0));
  }

  function dateText(value) {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' })
      : '—';
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
    list.innerHTML = state.notifications.map(item => `<article class="notification-item ${item.isRead ? '' : 'is-unread'}"><button type="button" data-notification-id="${esc(item.id)}"><span class="notification-item-top"><strong>${esc(item.title)}</strong><time datetime="${esc(item.publishedAt || '')}">${esc(dateText(item.publishedAt))}</time></span><span class="notification-item-content">${esc(item.content)}</span>${item.isRead ? '' : '<i class="notification-unread-dot" aria-label="未读"></i>'}</button></article>`).join('');
    list.querySelectorAll('[data-notification-id]').forEach(button => button.onclick = () => markRead(button.dataset.notificationId));
  }

  function setPanelOpen(open) {
    const item = document.querySelector('.notification-menu-item');
    const panel = query('#notificationPanel');
    const trigger = query('#notificationMenuButton');
    if (!item || !panel || !trigger) return;
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    item.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    trigger.setAttribute('aria-expanded', String(open));
    if (open) render();
  }

  function schedulePanelClose() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      closeTimer = 0;
      const item = document.querySelector('.notification-menu-item');
      if (!item?.matches(':hover') && !item?.matches(':focus-within')) setPanelOpen(false);
    }, 180);
  }

  async function load() {
    const requestAccount = accountSnapshot();
    try {
      const result = await api('/api/notifications?limit=200');
      if (!isAccountCurrent(requestAccount)) return;
      state.notifications = Array.isArray(result.items) ? result.items : [];
      state.unreadNotifications = Number(result.unreadCount) || 0;
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

  return { load, render, setPanelOpen, schedulePanelClose, markRead, markAllRead };
}
