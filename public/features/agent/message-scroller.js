// Reader-aware scrolling and message navigation for the existing DOM conversation.
const FOLLOW_THRESHOLD = 56;

const previewText = (node, limit = 56) => {
  const text = (node?.querySelector('.dw-message-content')?.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
};

// A user message starts a turn; tool-loop replies and the live draft belong
// to that same turn until the next user message arrives.
export function groupMessageTurns(nodes) {
  const turns = [];
  for (const node of nodes) {
    if (node.classList.contains('user') || !turns.length) turns.push({ start: node, end: node, replies: [] });
    const turn = turns.at(-1);
    turn.end = node;
    if (!node.classList.contains('user')) turn.replies.push(node);
  }
  return turns;
}

// Turns follow document order. Find the visible turn without measuring every
// message on each scroll event, including long conversation histories.
export function nearestMessageTurn(targets, middle) {
  if (!targets.length) return -1;
  let low = 0, high = targets.length;
  while (low < high) {
    const index = (low + high) >>> 1;
    if (targets[index].start.getBoundingClientRect().top <= middle) low = index + 1;
    else high = index;
  }
  const previous = Math.max(0, low - 1);
  if (!low || low === targets.length) return previous;
  const bottom = targets[previous].end.getBoundingClientRect().bottom;
  const nextTop = targets[low].start.getBoundingClientRect().top;
  return middle - bottom <= nextTop - middle ? previous : low;
}

export function createMessageScroller(viewport, rail, surface = null, jumpButton = null) {
  let following = true;
  let programmatic = false;
  let scrollFrame = 0;
  let syncFrame = 0;
  let lastTime = 0;
  let signature = '';
  let targets = [];
  let hoveredButton = null;
  let focusedButton = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hoverCapable = window.matchMedia('(any-hover: hover)');
  const controller = new AbortController();
  const { signal } = controller;
  const distanceFromEnd = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);

  function stopAnimation() {
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    lastTime = 0;
    programmatic = false;
  }

  function followFrame(time) {
    scrollFrame = 0;
    if (!following) { programmatic = false; return; }
    const gap = distanceFromEnd();
    if (gap <= 0.5) { programmatic = false; return; }
    const elapsed = Math.min(64, lastTime ? time - lastTime : 16);
    lastTime = time;
    programmatic = true;
    viewport.scrollTop += reducedMotion.matches || gap > 600 ? gap : Math.max(1, gap * (1 - Math.exp(-elapsed / 110)));
    scrollFrame = requestAnimationFrame(followFrame);
  }

  function followEnd(immediate = false) {
    if (!following) return;
    if (immediate || reducedMotion.matches) {
      stopAnimation();
      programmatic = true;
      viewport.scrollTop = viewport.scrollHeight;
      requestAnimationFrame(() => { programmatic = false; });
    } else if (!scrollFrame) scrollFrame = requestAnimationFrame(followFrame);
  }

  function activeItem() {
    if (!targets.length) return -1;
    if (viewport.scrollTop <= FOLLOW_THRESHOLD) return 0;
    if (distanceFromEnd() <= FOLLOW_THRESHOLD) return targets.length - 1;
    const middle = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
    return nearestMessageTurn(targets, middle);
  }

  // Offer a way back once the reader has left the latest message.
  function syncJump() {
    if (!jumpButton) return;
    const away = !following && distanceFromEnd() > FOLLOW_THRESHOLD;
    jumpButton.classList.toggle('is-visible', away);
    jumpButton.inert = !away;
  }

  function markActive() {
    syncJump();
    const active = activeItem();
    const buttons = [...rail.querySelectorAll('button')];
    const hovered = buttons.indexOf(hoveredButton);
    const focused = buttons.indexOf(focusedButton);
    const peak = hovered >= 0 ? hovered : focused >= 0 ? focused : active;
    buttons.forEach((button, index) => {
      if (index === active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
      // beUI PreviewRail's distance falloff: 1, .68, .44, .25.
      const distance = peak < 0 ? Infinity : Math.abs(index - peak);
      button.setAttribute('data-wave', distance === 0 ? 'peak' : distance === 1 ? 'near' : distance === 2 ? 'far' : 'rest');
    });
  }

  function syncRail() {
    syncFrame = 0;
    targets = groupMessageTurns(viewport.querySelectorAll('.dw-message-history .dw-message, .dw-message-draft'));
    const overflowing = viewport.scrollHeight > viewport.clientHeight + 1 && targets.length > 0;
    rail.hidden = !overflowing;
    viewport.classList.toggle('has-message-rail', overflowing);
    if (!overflowing) { signature = ''; rail.replaceChildren(); return; }
    const entries = targets.map(target => {
      const user = target.start.classList.contains('user');
      const title = previewText(target.start) || (user ? '附件消息' : '回复中');
      const reply = target.replies.map(node => previewText(node, 88)).filter(Boolean).join(' ');
      const description = user ? (reply.length > 88 ? `${reply.slice(0, 88).trim()}…` : reply) : '';
      return { title, description };
    });
    const nextSignature = JSON.stringify(entries);
    if (signature !== nextSignature) {
      signature = nextSignature;
      if (rail.children.length !== entries.length) {
        rail.replaceChildren(...entries.map(() => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'dw-message-tick';
          const line = document.createElement('span');
          line.className = 'dw-message-tick-line';
          line.setAttribute('aria-hidden', 'true');
          const preview = document.createElement('span');
          preview.className = 'dw-message-preview';
          preview.setAttribute('aria-hidden', 'true');
          preview.append(document.createElement('strong'), document.createElement('span'));
          button.append(line, preview);
          return button;
        }));
      }
      entries.forEach(({ title, description }, index) => {
        const button = rail.children[index];
        button.setAttribute('aria-label', `跳转到第 ${index + 1} 轮对话：${title}`);
        const preview = button.lastElementChild;
        preview.firstElementChild.textContent = title;
        preview.lastElementChild.textContent = description;
        preview.lastElementChild.hidden = !description;
      });
    }
    markActive();
  }

  function refresh({ reset = false, immediate = false, follow = false } = {}) {
    if (reset) { stopAnimation(); following = true; signature = ''; }
    else if (follow && !following) { stopAnimation(); following = true; }
    if (syncFrame) cancelAnimationFrame(syncFrame);
    syncFrame = requestAnimationFrame(syncRail);
    followEnd(immediate || reset);
    syncJump();
  }

  function readerInput(event) {
    if (event.type === 'wheel' && event.deltaY >= 0) return;
    if (event.type === 'keydown' && !['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) return;
    stopAnimation();
    following = false;
  }

  viewport.addEventListener('scroll', () => {
    if (!programmatic) following = distanceFromEnd() <= FOLLOW_THRESHOLD;
    markActive();
  }, { passive: true, signal });
  viewport.addEventListener('wheel', readerInput, { passive: true, signal });
  viewport.addEventListener('touchstart', readerInput, { passive: true, signal });
  viewport.addEventListener('keydown', readerInput, { signal });
  viewport.addEventListener('load', () => refresh(), { capture: true, signal });
  rail.addEventListener('pointerover', event => {
    if (!hoverCapable.matches || event.pointerType === 'touch' || event.buttons !== 0) return;
    const button = event.target.closest('button');
    if (!button || !rail.contains(button) || button === hoveredButton) return;
    hoveredButton = button;
    markActive();
  }, { signal });
  rail.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return;
    hoveredButton = null;
    markActive();
  }, { signal });
  rail.addEventListener('focusin', event => {
    const button = event.target.closest('button');
    focusedButton = button?.matches(':focus-visible') && rail.contains(button) ? button : null;
    markActive();
  }, { signal });
  rail.addEventListener('focusout', () => {
    focusedButton = null;
    markActive();
  }, { signal });
  surface?.addEventListener('wheel', event => {
    if (viewport.contains(event.target) || !event.deltaY) return;
    if (event.target.closest?.('textarea, input, select, [contenteditable], .attachment-strip, .dw-plan, .dw-agent-options, .dw-skill-menu, [popover]')) return;
    event.preventDefault();
    stopAnimation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    viewport.scrollTop += event.deltaY * unit;
    following = distanceFromEnd() <= FOLLOW_THRESHOLD;
    markActive();
  }, { passive: false, signal });
  rail.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !rail.contains(button)) return;
    const index = [...rail.children].indexOf(button);
    const target = targets[index];
    if (!target) return;
    stopAnimation();
    following = false;
    programmatic = true;
    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = target.start.getBoundingClientRect();
    viewport.scrollTo({
      top: Math.max(0, viewport.scrollTop + targetRect.top - viewportRect.top - 12),
      behavior: reducedMotion.matches ? 'instant' : 'smooth',
    });
    window.setTimeout(() => { programmatic = false; markActive(); }, reducedMotion.matches ? 0 : 350);
  }, { signal });

  jumpButton?.addEventListener('click', () => {
    refresh({ follow: true });
    viewport.focus({ preventScroll: true });
  }, { signal });

  const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => refresh());
  mutationObserver?.observe(viewport, { childList: true, characterData: true, subtree: true });
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => refresh());
  resizeObserver?.observe(viewport);
  refresh({ immediate: true });
  return {
    refresh,
    destroy() {
      controller.abort();
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      stopAnimation();
      if (syncFrame) cancelAnimationFrame(syncFrame);
    },
  };
}
