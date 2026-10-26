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

// Text such as `@小美` becomes a reference as soon as a reference with that name
// exists, whether the text was pasted before or after the upload. A name may omit
// its extension (`@小美` matches 小美.png). An ASCII word character right before
// `@` (an email address) never links; Chinese text before `@` does.
const mentionWordChar = /[A-Za-z0-9._%+-]/;
const mentionKey = text => String(text || '').trim().toLocaleLowerCase('zh-CN');
const mentionBaseName = name => String(name || '').trim().replace(/\.[A-Za-z0-9]{1,8}$/, '').trim();

export function textMentionEntries(files) {
  const index = new Map();
  (Array.isArray(files) ? files : []).forEach(file => {
    const name = String(file?.name || '').trim();
    if (!file?.id || !name) return;
    new Set([name, mentionBaseName(name) || name]).forEach(text => {
      const key = mentionKey(text);
      if (!key) return;
      const entry = index.get(key) || { key, label: text, files: [] };
      if (!entry.files.some(item => String(item.id) === String(file.id))) entry.files.push(file);
      index.set(key, entry);
    });
  });
  // Longest first so `@小美丽` is not taken by `@小美`.
  return [...index.values()].sort((a, b) => b.key.length - a.key.length);
}

// Splits text into strings and `{ file, label, length, text }` mentions. Names shared
// by several references stay as text and are reported as ambiguous.
export function splitTextMentions(text, entries) {
  const source = String(text || '');
  const parts = [];
  const ambiguous = [];
  if (!source.includes('@') || !entries?.length) return { parts: source ? [source] : [], ambiguous };
  let buffer = '';
  let position = 0;
  while (position < source.length) {
    const boundary = position === 0 || !mentionWordChar.test(source[position - 1]);
    const match = source[position] === '@' && boundary
      ? entries.find(entry => mentionKey(source.slice(position + 1, position + 1 + entry.key.length)) === entry.key)
      : null;
    if (!match) { buffer += source[position]; position += 1; continue; }
    const length = 1 + match.key.length;
    if (match.files.length > 1) { buffer += source.slice(position, position + length); ambiguous.push(match.label); position += length; continue; }
    if (buffer) parts.push(buffer);
    buffer = '';
    parts.push({ file: match.files[0], label: match.label, length, text: source.slice(position, position + length) });
    position += length;
  }
  if (buffer) parts.push(buffer);
  return { parts, ambiguous: [...new Set(ambiguous)] };
}

// Turns matching `@name` text inside an editor into mention chips in place and
// keeps the caret where it was. `createChip(file, label)` returns the chip
// element, or nothing to leave the text unchanged.
export function linkTextMentions(editor, entries, { mentionClass, createChip, skipSelector = '' } = {}) {
  const result = { ids: [], ambiguous: [] };
  if (!editor || !entries?.length) return result;
  const documentRef = editor.ownerDocument;
  const skip = node => {
    const element = node.parentElement;
    return element?.closest(`.${mentionClass}`) || (skipSelector && element?.closest(skipSelector));
  };
  const walker = documentRef.createTreeWalker(editor, 4);
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes('@') && !skip(walker.currentNode)) nodes.push(walker.currentNode);
  const selection = documentRef.defaultView.getSelection();
  const caret = selection?.rangeCount && selection.isCollapsed ? { node: selection.anchorNode, offset: selection.anchorOffset } : null;
  let nextCaret = null;
  nodes.forEach(node => {
    const { parts, ambiguous } = splitTextMentions(node.nodeValue, entries);
    result.ambiguous.push(...ambiguous);
    if (!parts.some(part => typeof part !== 'string')) return;
    const items = [];
    let position = 0;
    parts.forEach(part => {
      const { length } = part;
      const chip = typeof part === 'string' ? null : createChip(part.file, part.label);
      if (chip) result.ids.push(String(part.file.id));
      const text = typeof part === 'string' ? part : part.text;
      const previous = items.at(-1);
      // A chip that cannot be built stays as text, merged with its neighbours.
      if (!chip && previous && !previous.chip) { previous.text += text; previous.end = position + length; }
      else items.push(chip ? { chip, start: position, end: position + length } : { text, start: position, end: position + length });
      position += length;
    });
    items.forEach(item => { item.node = item.chip || documentRef.createTextNode(item.text); });
    if (caret?.node === node) {
      const offset = caret.offset;
      const text = items.find(item => !item.chip && offset >= item.start && offset <= item.end);
      const chipIndex = text ? -1 : items.findIndex(item => item.chip && offset > item.start && offset <= item.end);
      if (text) nextCaret = { node: text.node, offset: Math.min(offset - text.start, text.node.nodeValue.length) };
      else if (chipIndex >= 0) {
        // Keep the caret in a text node after the chip so the next IME
        // composition starts inside the editable text.
        const after = items[chipIndex + 1];
        if (after && !after.chip) nextCaret = { node: after.node, offset: 0 };
        else {
          const spacer = { node: documentRef.createTextNode(' ') };
          items.splice(chipIndex + 1, 0, spacer);
          nextCaret = { node: spacer.node, offset: 1 };
        }
      }
    }
    node.replaceWith(...items.map(item => item.node));
  });
  if (nextCaret) {
    const range = documentRef.createRange();
    range.setStart(nextCaret.node, nextCaret.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  result.ambiguous = [...new Set(result.ambiguous)];
  return result;
}

// Pastes clipboard text without its formatting at the caret and leaves the
// caret after it. Returns false when the caret is outside the editor.
export function pastePlainText(editor, event) {
  const documentRef = editor?.ownerDocument;
  const selection = documentRef?.defaultView?.getSelection();
  const text = event?.clipboardData?.getData('text/plain');
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || typeof text !== 'string') return false;
  event.preventDefault();
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = documentRef.createTextNode(text.replace(/\r\n?/g, '\n'));
  range.insertNode(node);
  range.setStart(node, node.nodeValue.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
