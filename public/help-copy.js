export async function copyHelpText(text, { document: doc = globalThis.document, clipboard = globalThis.navigator?.clipboard } = {}) {
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Older browsers or restricted clipboard permissions can still allow a user-initiated copy.
    }
  }
  const activeElement = doc.activeElement;
  const selection = doc.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const field = doc.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:-9999px;font-size:16px;';
  try {
    doc.body.appendChild(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    if (!doc.execCommand?.('copy')) throw new Error('Copy unavailable');
  } finally {
    field.remove();
    activeElement?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach(range => selection.addRange(range));
    }
  }
}

export function initHelpCopies(doc = globalThis.document, { copy = copyHelpText } = {}) {
  doc.querySelectorAll('[data-copy-example]').forEach(button => {
    const example = doc.getElementById(button.getAttribute('data-copy-example'));
    const status = button.closest('.article-example').querySelector('[data-copy-status]');
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute('data-copy-state', 'pending');
      button.setAttribute('title', '正在复制…');
      status.textContent = '正在复制…';
      status.removeAttribute('data-copy-error');
      try {
        await copy(example.textContent, { document: doc });
        status.textContent = '已复制，可粘贴使用';
        button.setAttribute('data-copy-state', 'copied');
        button.setAttribute('title', '已复制');
      } catch {
        status.textContent = '复制未完成，请选中示例文字手动复制。';
        status.setAttribute('data-copy-error', '');
        button.setAttribute('data-copy-state', 'idle');
        button.setAttribute('title', '重新复制');
      } finally {
        button.disabled = false;
      }
    });
  });
  doc.documentElement.classList.add('help-copy-ready');
}
