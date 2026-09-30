// Reader-aware scrolling and message navigation for the existing DOM conversation.
const FOLLOW_THRESHOLD = 56;

const previewText = (node, limit = 56) => {
  const text = (node?.querySelector('.dw-message-content')?.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
};

export function createMessageScroller(viewport, rail, surface = null) {
  let following = true;
  let programmatic = false;
  let scrollFrame = 0;
  let syncFrame = 0;
  let lastTime = 0;
  let signature = '';
  let targets = [];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
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
    let nearest = 0;
    let nearestDistance = Infinity;
    targets.forEach((target, index) => {
      const rect = target.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - middle);
      if (distance < nearestDistance) { nearest = index; nearestDistance = distance; }
    });
    return nearest;
  }

  function markActive() {
    const active = activeItem();
    rail.querySelectorAll('button').forEach((button, index) => {
      if (index === active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    });
  }

  function syncRail() {
    syncFrame = 0;
    targets = [...viewport.querySelectorAll('.dw-message-history .dw-message, .dw-message-draft')];
    const overflowing = viewport.scrollHeight > viewport.clientHeight + 1 && targets.length > 1;
    rail.hidden = !overflowing;
    viewport.classList.toggle('has-message-rail', overflowing);
    if (!overflowing) { signature = ''; rail.replaceChildren(); return; }
    const entries = targets.map((target, index) => {
      const role = target.classList.contains('user') ? '你' : 'GuGu';
      const title = previewText(target) || (role === '你' ? '附件消息' : '回复中');
      const next = role === '你' ? targets.slice(index + 1).find(item => !item.classList.contains('user')) : null;
      return { role, title, description: previewText(next, 88) };
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
      entries.forEach(({ role, title, description }, index) => {
        const button = rail.children[index];
        button.setAttribute('aria-label', `跳转到第 ${index + 1} 条${role}消息：${title}`);
        const preview = button.lastElementChild;
        preview.firstElementChild.textContent = title;
        preview.lastElementChild.textContent = description;
        preview.lastElementChild.hidden = !description;
      });
    }
    markActive();
  }

  function refresh({ reset = false, immediate = false } = {}) {
    if (reset) { stopAnimation(); following = true; signature = ''; }
    if (syncFrame) cancelAnimationFrame(syncFrame);
    syncFrame = requestAnimationFrame(syncRail);
    followEnd(immediate || reset);
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
  surface?.addEventListener('wheel', event => {
    if (viewport.contains(event.target) || !event.deltaY) return;
    if (event.target.closest?.('textarea, input, select, [contenteditable], .attachment-strip, .dw-plan, .dw-agent-options, [popover]')) return;
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
    if (index === targets.length - 1) { following = true; followEnd(true); markActive(); return; }
    following = false;
    programmatic = true;
    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    viewport.scrollTo({
      top: viewport.scrollTop + targetRect.top - viewportRect.top - (viewport.clientHeight - targetRect.height) / 2,
      behavior: reducedMotion.matches ? 'instant' : 'smooth',
    });
    window.setTimeout(() => { programmatic = false; markActive(); }, reducedMotion.matches ? 0 : 350);
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
