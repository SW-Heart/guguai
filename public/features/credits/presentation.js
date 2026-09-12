export function createCreditPresentation({ getState, escapeHtml, formatFullDate } = {}) {
  const readState = getState || (() => ({}));
  const esc = escapeHtml || (value => String(value));
  const fullDateText = formatFullDate || (value => String(value || '—'));

  function creditText(balance) {
    return (Number(balance) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  }

  function creditEntryAmount(entry) {
    const amount = Number(entry?.amount);
    if (Number.isFinite(amount)) return amount;
    const amountMicro = Number(entry?.amountMicro);
    return Number.isFinite(amountMicro) ? amountMicro / 1_000_000 : 0;
  }

  function creditDateText(value) {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? fullDateText(value) : '—';
  }

  function creditModelName(entry, task = null) {
    const modelId = entry?.modelId || task?.modelId || entry?.model || entry?.modelName;
    if (!modelId) return '—';
    if (modelId === 'gpt-image-2') return 'GPT-Image-2';
    const catalog = readState().config?.videoCapabilities?.models || [];
    return catalog.find(model => model.id === modelId)?.label || String(modelId);
  }

  function creditGenerationType(entry) {
    const task = entry?.generationId ? readState().tasks?.find(item => item.id === entry.generationId) : null;
    if (entry?.contentType === 'image' || task?.type === 'image' || entry?.modelId === 'gpt-image-2') return '图像生成';
    if (entry?.contentType === 'video' || task?.type === 'video') return '视频生成';
    return '视频生成';
  }

  function creditSpendType(entry) {
    if (entry?.type === 'llm_capture') return '文本生成';
    if (entry?.type === 'admin_credit_adjustment') return '后台扣减';
    return creditGenerationType(entry);
  }

  function creditEarnType(entry) {
    if (entry?.type === 'generation_refund') return '任务失败退款';
    if (entry?.type === 'alipay_purchase') return '支付宝充值';
    if (entry?.type === 'signup_bonus') return '赠送积分';
    if (entry?.type === 'admin_credit_adjustment') return '充值（后台操作增加积分）';
    return '积分获取';
  }

  function creditEntryStatus(entry, task) {
    if (entry?.type === 'generation_refund' || task?.creditStatus === 'refunded') return { key: 'refunded', label: '已退款' };
    if (['queued', 'running'].includes(task?.status) || (task?.status === 'failed' && task?.creditStatus !== 'refunded')) return { key: 'pending', label: '进行中' };
    return { key: 'completed', label: '已完成' };
  }

  function signedCreditAmount(amount) {
    return `${amount < 0 ? '-' : '+'}${creditText(Math.abs(amount))}`;
  }

  function renderCreditRows(entries, direction) {
    if (!entries.length) return `<tr><td colspan="${direction === 'spend' ? 5 : 3}"><div class="credit-empty">暂无${direction === 'spend' ? '积分消耗' : '积分获取'}记录</div></td></tr>`;
    return entries.map(entry => {
      const amount = creditEntryAmount(entry);
      const task = entry.generationId ? readState().tasks?.find(item => item.id === entry.generationId) : null;
      const model = direction === 'spend' ? `<td>${esc(creditModelName(entry, task))}</td>` : '';
      const type = direction === 'spend' ? creditSpendType(entry) : creditEarnType(entry);
      const status = direction === 'spend' ? creditEntryStatus(entry, task) : null;
      const statusCell = status ? `<td><span class="credit-status credit-status-${status.key}">${esc(status.label)}</span></td>` : '';
      return `<tr><td><time datetime="${esc(entry.createdAt || '')}">${esc(creditDateText(entry.createdAt))}</time></td><td>${esc(type)}</td>${model}<td class="${direction === 'spend' ? 'credit-spend' : 'credit-earn'}">${esc(signedCreditAmount(amount))}</td>${statusCell}</tr>`;
    }).join('');
  }

  return Object.freeze({
    creditText,
    creditEntryAmount,
    creditDateText,
    creditModelName,
    creditGenerationType,
    creditSpendType,
    creditEarnType,
    creditEntryStatus,
    signedCreditAmount,
    renderCreditRows,
  });
}
