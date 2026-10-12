export function bindProjectTitleEditor(heading, { title, save, toast }) {
  const form = document.createElement('form');
  form.className = 'dw-project-title-editor';
  form.hidden = true;
  form.innerHTML = '<input type="text" maxlength="80" aria-label="项目名称" autocomplete="off"><button type="submit">保存</button><button type="button" data-title-cancel>取消</button>';
  heading.after(form);
  const input = form.querySelector('input');
  const buttons = form.querySelectorAll('button');
  let saving = false;
  heading.tabIndex = 0;
  heading.setAttribute('role', 'button');
  heading.setAttribute('aria-label', '修改项目名称');
  heading.title = '点击修改名称';
  const close = () => {
    form.hidden = true;
    heading.hidden = false;
    heading.focus({ preventScroll: true });
  };
  const open = () => {
    if (saving || !form.hidden) return;
    input.value = title();
    heading.hidden = true;
    form.hidden = false;
    input.focus({ preventScroll: true });
    input.select();
  };
  heading.onclick = open;
  heading.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      open();
    }
  };
  form.querySelector('[data-title-cancel]').onclick = close;
  form.onkeydown = event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!saving) close();
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    const name = input.value.trim();
    if (!name) { toast('请输入项目名称'); input.focus(); return; }
    if (name === title()) { close(); return; }
    saving = true;
    input.disabled = true;
    buttons.forEach(button => { button.disabled = true; });
    buttons[0].textContent = '保存中…';
    try {
      const saved = await save(name);
      if (!form.isConnected) return;
      heading.textContent = saved || name;
      close();
    } catch (error) {
      if (!form.isConnected) return;
      toast(error.message || '名称保存失败，请重试');
    } finally {
      saving = false;
      input.disabled = false;
      buttons.forEach(button => { button.disabled = false; });
      buttons[0].textContent = '保存';
      if (form.isConnected && !form.hidden) input.focus();
    }
  };
}
