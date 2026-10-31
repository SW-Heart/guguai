const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const text = value => typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : '';
export function logSummary(item, category) {
  const details = item.details || {};
  const message = text(item.message) || text(details.error) || text(details.errorMessage) || text(details.message) || text(item.note);
  if (message) return message;
  if (category === 'generations') return ({ completed:'生成已完成', failed:'生成失败，查看详情了解原因', running:'任务正在生成', queued:'任务正在排队' })[item.status] || '查看任务记录';
  if (category === 'credits') return `积分变动 ${Number(item.amount) >= 0 ? '+' : ''}${item.amount ?? 0}，变动后余额 ${item.balanceAfter ?? '—'}`;
  if (category === 'client') return item.note || '客户端诊断记录';
  return '查看本次记录的详细信息';
}

export function logDrawerContent({ item, category, record, label, formatDate, statusText }) {
  const fields = [
    ['记录时间', formatDate(item.createdAt)], ['状态', statusText(item.status || item.level)],
    ['用户', item.userNickname || item.actorNickname || item.username], ['模型', item.modelName || item.modelId],
    ['记录 ID', item.id], ['用户 ID', item.userId || item.actorUserId],
    ['更新于', item.updatedAt ? formatDate(item.updatedAt) : ''], ['渠道', item.provider],
    ['操作', item.action], ['分类', item.category], ['请求 ID', item.requestId],
    ['消耗积分', item.creditCost ?? item.charged], ['积分变动', item.amount], ['变动后余额', item.balanceAfter],
    ['版本', item.appVersion], ['平台', item.platform], ['诊断编号', item.reference],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  const block = (title, value, open = false) => `<details class="log-record-block"${open ? ' open' : ''}><summary>${escape(title)}</summary><pre>${escape(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre></details>`;
  const details = item.details || {};
  const content = [
    ['画面描述', details.prompt || details.promptText], ['请求内容', details.request || details.requestBody],
    ['响应内容', details.response || details.responseBody], ['错误堆栈', details.stack || details.error?.stack],
    ['变更前', item.before], ['变更后', item.after],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  return `<section class="log-record-result${item.status === 'failed' || ['error', 'critical'].includes(item.level) ? ' is-error' : ''}"><h3>${item.status === 'failed' ? '失败原因' : '记录摘要'}</h3><p>${escape(logSummary(item, category))}</p></section><section class="log-record-info" aria-label="${escape(label)}基本信息"><h3>基本信息</h3><dl>${fields.map(([name, value]) => `<div><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl></section>${content.map(([name, value]) => block(name, value)).join('')}${block('完整原始记录', record)}`;
}

export function createLogDrawer({ root = document, copy, formatDate, statusText }) {
  const dialog = root.querySelector('#logDetailDrawer');
  const body = root.querySelector('#logDrawerBody');
  const title = root.querySelector('#logDrawerTitle');
  const close = root.querySelector('#closeLogDrawer');
  const copyButton = root.querySelector('#copyLogDrawer');
  let restore = null;
  let record = null;
  close.onclick = () => dialog.close();
  copyButton.onclick = () => copy(JSON.stringify(record, null, 2), '日志详情');
  dialog.addEventListener('click', event => { if (event.target === dialog && event.clientX < dialog.getBoundingClientRect().left) dialog.close(); });
  dialog.addEventListener('close', () => {
    root.body.classList.remove('log-drawer-open');
    body.replaceChildren();
    record = null;
    if (restore?.isConnected) restore.focus({ preventScroll:true });
    restore = null;
  });
  return {
    open({ item, category, data, label, trigger }) {
      restore = trigger || root.activeElement;
      // Keep a stable snapshot while the live list continues to refresh.
      record = JSON.parse(JSON.stringify(data));
      title.textContent = `${label}详情`;
      body.innerHTML = logDrawerContent({ item, category, record, label, formatDate, statusText });
      body.scrollTop = 0;
      root.body.classList.add('log-drawer-open');
      if (!dialog.open) dialog.showModal();
      close.focus({ preventScroll:true });
    },
    close() { if (dialog.open) dialog.close(); },
  };
}

export function bindLogStickyHeader(root, { window:win = window, ResizeObserver:Observer = ResizeObserver } = {}) {
  const region = root.querySelector('.log-table-region');
  const wrap = region?.querySelector('.table-wrap');
  const table = wrap?.querySelector('table');
  const head = table?.querySelector('thead');
  if (!head) return () => {};
  const sticky = root.ownerDocument.createElement('div');
  sticky.className = 'log-sticky-header';
  sticky.setAttribute('aria-hidden', 'true');
  const clone = table.cloneNode(false);
  clone.removeAttribute('aria-label');
  clone.append(table.querySelector('colgroup').cloneNode(true), head.cloneNode(true));
  sticky.append(clone);
  region.prepend(sticky);
  region.classList.add('has-sticky-header');
  const sidebar = root.ownerDocument.querySelector('.sidebar');
  const sync = () => {
    clone.style.width = `${table.getBoundingClientRect().width}px`;
    sticky.style.height = `${head.getBoundingClientRect().height}px`;
    sticky.style.marginBottom = `-${head.getBoundingClientRect().height}px`;
    sticky.style.top = win.matchMedia('(max-width: 900px)').matches ? `${sidebar?.getBoundingClientRect().height || 0}px` : '0px';
    sticky.scrollLeft = wrap.scrollLeft;
  };
  const observer = new Observer(sync);
  observer.observe(table);
  if (sidebar) observer.observe(sidebar);
  wrap.addEventListener('scroll', sync, { passive:true });
  win.addEventListener('resize', sync, { passive:true });
  sync();
  return () => {
    observer.disconnect();
    wrap.removeEventListener('scroll', sync);
    win.removeEventListener('resize', sync);
    sticky.remove();
    region.classList.remove('has-sticky-header');
  };
}
