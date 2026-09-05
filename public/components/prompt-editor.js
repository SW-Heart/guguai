export function createPromptEditorCodec({ mentionClass, mentionSelector, labelAttribute, emptyChar = '' } = {}) {
  function serialize(editor) {
    if (!editor) return '';
    const visit = (node, isRoot = false) => {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (node.classList.contains(mentionClass)) return `@${node.dataset[labelAttribute] || node.textContent.trim()}`;
      if (node.nodeName === 'BR') return '\n';
      const text = [...node.childNodes].map(child => visit(child)).join('');
      return !isRoot && /^(DIV|P)$/.test(node.nodeName) ? `${text}\n` : text;
    };
    return visit(editor, true).replace(/\u00a0/g, ' ').replace(emptyChar ? new RegExp(emptyChar, 'g') : /$^/g, '');
  }
  function mentions(editor) {
    if (!editor) return [];
    return [...editor.querySelectorAll(mentionSelector)]
      .map(node => ({
        id: String(node.dataset[`${labelAttribute.slice(0, -5)}Id`] || ''),
        label: String(node.dataset[labelAttribute] || '').replace(/^@/, '').trim(),
        kind: node.dataset[`${labelAttribute.slice(0, -5)}Kind`] || 'image',
      }))
      .filter(item => item.id && item.label)
      .filter((item, index, list) => list.findIndex(other => other.id === item.id && other.label === item.label) === index)
      .slice(0, 40);
  }
  function mentionAtCaret(editor, direction) {
    const selection = editor?.ownerDocument?.defaultView?.getSelection?.();
    if (!editor || !selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    const offset = range.startOffset;
    const element = container.nodeType === 1 ? container : container.parentElement;
    const inside = element?.closest(`.${mentionClass}`);
    if (inside && editor.contains(inside)) return inside;
    const isMention = node => node?.nodeType === 1 && node.classList.contains(mentionClass);
    if (container.nodeType === 3) {
      const value = container.nodeValue || '';
      if (direction === 'backward' && offset === 0 && isMention(container.previousSibling)) return container.previousSibling;
      if (direction === 'backward' && offset === value.length && value === ' ' && isMention(container.previousSibling)) return container.previousSibling;
      if (direction === 'forward' && offset === value.length && isMention(container.nextSibling)) return container.nextSibling;
    } else if (container.nodeType === 1) {
      const adjacent = container.childNodes[direction === 'backward' ? offset - 1 : offset];
      if (isMention(adjacent)) return adjacent;
    }
    return null;
  }
  function setCaret(editor, node, offset = 0) {
    if (!editor?.isConnected) return;
    editor.focus({ preventScroll: true });
    const documentRef = editor.ownerDocument;
    const range = documentRef.createRange();
    if (node?.isConnected && editor.contains(node)) {
      range.setStart(node, Math.max(0, Math.min(offset, node.nodeValue?.length || 0)));
      range.collapse(true);
    } else {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const selection = documentRef.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function normalizeEmpty(editor) {
    if (!editor) return;
    if (serialize(editor).trim()) { editor.dataset.empty = 'false'; return; }
    editor.replaceChildren();
    editor.dataset.empty = 'true';
  }
  return { serialize, mentions, mentionAtCaret, setCaret, normalizeEmpty };
}
