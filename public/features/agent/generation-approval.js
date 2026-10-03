export function mountGenerationApproval(host, {onDecision} = {}) {
  const card = host.ownerDocument.createElement('section');
  card.className = 'dw-agent-approval';
  card.setAttribute('aria-label', '生成确认');
  card.innerHTML = '<strong data-approval-title></strong><p data-approval-summary></p><section class="dw-approval-description"><h3>画面描述</h3><p data-approval-prompt></p></section><p data-approval-references></p><p data-approval-error role="alert" hidden></p><footer><button type="button" data-approval-cancel>取消</button><button type="button" data-approval-generate class="dw-primary">生成</button></footer>';
  const cancel = card.querySelector('[data-approval-cancel]');
  const generate = card.querySelector('[data-approval-generate]');
  const errorText = card.querySelector('[data-approval-error]');
  let current = null, busy = false, signature = '', disposed = false;
  const buttons = () => {cancel.disabled = generate.disabled = busy;generate.textContent = busy ? '正在提交…' : '生成';};
  async function decide(accepted) {
    if (!current || busy) return;
    const id = current.id;
    busy = true; buttons(); errorText.hidden = true;
    try {
      await onDecision(id, accepted);
      if (!disposed && current?.id === id) update(null);
    } catch (error) {
      if (!disposed && current?.id === id) {errorText.textContent = error.message || '操作失败，请重试';errorText.hidden = false;}
    } finally {
      if (!disposed && (!current || current.id === id)) {busy = false;buttons();}
    }
  }
  cancel.addEventListener('click', () => void decide(false));
  generate.addEventListener('click', () => void decide(true));
  function update(approval) {
    if (disposed) return;
    const next = approval ? JSON.stringify(approval) : '';
    if (signature === next) return;
    const changed = current?.id !== approval?.id;
    current = approval; signature = next;
    if (!approval) {card.remove();return;}
    if (changed) {busy = false;errorText.hidden = true;buttons();}
    card.querySelector('[data-approval-title]').textContent = approval.title;
    card.querySelector('[data-approval-summary]').textContent = `${approval.quantity || 1} 个 · ${approval.credits} 积分`;
    card.querySelector('[data-approval-prompt]').textContent = approval.prompt || '';
    const references = card.querySelector('[data-approval-references]');
    references.textContent = (approval.references || []).map(item => `@${item.label}`).join('、');
    references.hidden = !references.textContent;
    if (card.parentNode !== host) host.append(card);
  }
  return {update, destroy() {disposed = true;card.remove();}};
}
