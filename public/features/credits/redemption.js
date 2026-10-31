export function createCreditRedemptionController({ root = document, api, accountScope, onRedeemed, formatCredits = String }) {
  const find = id => root.querySelector(`#${id}`);
  const tabs = [find('creditBuyTab'), find('creditRedeemTab')];
  const panels = [find('creditBuyPanel'), find('creditRedeemPanel')];
  const input = find('creditRedeemCode');
  const button = find('creditRedeemSubmit');
  const feedback = find('creditRedeemFeedback');
  let busy = false;
  let activeAccount = null;
  let version = 0;
  function select(index) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
  }
  tabs.forEach((tab, i) => {
    tab.onclick = () => select(i);
    tab.onkeydown = event => {
      const index = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 1 - i : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null;
      if (index === null) return;
      event.preventDefault();
      select(index);
      tabs[index].focus();
    };
  });
  function message(text = '', tone = '') {
    feedback.textContent = text;
    feedback.dataset.tone = tone;
    input.setAttribute('aria-invalid', String(tone === 'error'));
  }
  input.oninput = () => { message(); button.disabled = busy || !input.value.trim(); };
  find('creditRedeemForm').onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const code = input.value.trim().toUpperCase();
    if (!/^[A-Z0-9-]{8,40}$/.test(code)) {
      message('请输入有效的兑换码', 'error');
      input.focus();
      return;
    }
    const account = accountScope.snapshot();
    activeAccount = account;
    const requestVersion = ++version;
    busy = true;
    input.disabled = true;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '兑换中…';
    message();
    try {
      const result = await api('/api/credits/redeem', { method:'POST', body:JSON.stringify({ code }) });
      if (!accountScope.isCurrent(account) || version !== requestVersion) return;
      onRedeemed(result);
      input.value = '';
      message(`已兑换 ${formatCredits(result.credits)} 积分，积分已到账`, 'success');
    } catch (error) {
      if (!accountScope.isCurrent(account) || version !== requestVersion) return;
      message(error.message || '兑换失败，请稍后再试', 'error');
    } finally {
      if (version === requestVersion) {
        busy = false;
        input.disabled = false;
        button.disabled = !input.value.trim();
        button.removeAttribute('aria-busy');
        button.textContent = '兑换积分';
      }
    }
  };
  return {
    reset() {
      // Reopening the dialog must not enable a second submission mid-request.
      if (busy && accountScope.isCurrent(activeAccount)) { select(0); return; }
      version++;
      busy = false;
      select(0);
      input.value = '';
      input.disabled = false;
      button.disabled = true;
      button.removeAttribute('aria-busy');
      button.textContent = '兑换积分';
      message();
    },
  };
}
