// Card previews retain native decoders even when paused. Load every card the
// user can see (plus a short look-ahead so covers are ready while scrolling)
// and release sources as soon as cards leave the view or are removed. What is
// loaded is bounded by the screen, so no fixed count can hide visible covers.
// When `coverUrl` yields a still frame, cards show it as the poster and never
// open the video; players with controls load the source only when pressed.
// A frame that fails to load falls back to opening the video as before.
export function createVideoPreviews({ root, IntersectionObserver, MutationObserver, limit = Infinity, coverUrl = () => '', Image = globalThis.Image }) {
  const covers = new WeakMap();
  const tracked = new Set();
  const visible = new Set();
  const active = new Set();
  const failed = new WeakSet();
  const positions = new WeakMap();
  const resumeHandlers = new Map();
  const release = video => {
    if (!active.delete(video)) return;
    if (Number.isFinite(video.currentTime) && video.currentTime > 0) positions.set(video, video.currentTime);
    const resume = resumeHandlers.get(video);
    if (resume) video.removeEventListener('loadedmetadata', resume);
    resumeHandlers.delete(video);
    video.pause();
    video.removeAttribute('src');
    video.preload = 'none';
    video.load();
  };
  const load = video => {
    active.add(video);
    const position = positions.get(video);
    if (position) {
      const resume = () => {
        resumeHandlers.delete(video);
        if (active.has(video)) video.currentTime = Number.isFinite(video.duration) ? Math.min(position, video.duration) : position;
      };
      resumeHandlers.set(video, resume);
      video.addEventListener('loadedmetadata', resume, { once:true });
    }
    video.preload = 'metadata';
    video.src = video.dataset.previewSrc;
  };
  const showCover = video => {
    const cover = coverUrl(video.dataset.previewSrc);
    const state = cover && Image ? covers.get(video) : 'none';
    if (state === 'none') return false;
    if (state === 'ready') {
      if (video.getAttribute('poster') !== cover) video.setAttribute('poster', cover);
      return true;
    }
    if (!state) {
      covers.set(video, 'pending');
      const probe = new Image();
      probe.onload = () => { covers.set(video, 'ready'); if (visible.has(video)) showCover(video); };
      probe.onerror = () => { covers.set(video, 'none'); fill(); };
      probe.src = cover;
    }
    return true;
  };
  const hideCover = video => { if (video.getAttribute('poster')) video.removeAttribute('poster'); };
  const fill = () => {
    for (const video of visible) {
      if (active.has(video) || failed.has(video) || !video.isConnected) continue;
      if (showCover(video)) continue;
      if (active.size >= limit) break;
      load(video);
    }
  };
  const observer = IntersectionObserver ? new IntersectionObserver(entries => {
    for (const { target:video, isIntersecting } of entries) {
      if (!tracked.has(video)) continue;
      if (isIntersecting && video.isConnected) visible.add(video);
      else { visible.delete(video); release(video); hideCover(video); }
    }
    fill();
  }, { rootMargin:'200px 0px' }) : null;
  function scan() {
    for (const video of tracked) {
      if (video.isConnected && root.contains(video)) continue;
      observer?.unobserve(video);
      visible.delete(video);
      release(video);
      tracked.delete(video);
    }
    for (const video of root.querySelectorAll('video[data-preview-src]')) {
      if (tracked.has(video)) continue;
      tracked.add(video);
      observer?.observe(video);
    }
    // Without visibility observation, leave a placeholder instead of eagerly
    // opening every file. Explicit playback uses a separate detail element.
    fill();
  }
  const containsPreview = node => node.matches?.('video[data-preview-src]') || node.querySelector?.('video[data-preview-src]');
  const mutations = MutationObserver ? new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(containsPreview))) scan();
  }) : null;
  mutations?.observe(root, { childList:true, subtree:true });
  // A visible player beyond the preview budget must still respond to its
  // controls. Prefer freeing a paused card, then restore the selected source.
  const activate = event => {
    const video = event.target.closest?.('video[data-preview-src]');
    if (!video || !root.contains(video) || active.has(video)) return;
    // A covered card is opened through its own detail view, not in place.
    if (covers.get(video) === 'ready' && !video.controls) return;
    scan();
    if (active.has(video)) return;
    failed.delete(video);
    if (active.size >= limit) release([...active].find(item => item.paused !== false) || active.values().next().value);
    load(video);
  };
  root.addEventListener?.('pointerdown', activate, true);
  root.addEventListener?.('focusin', activate, true);
  return {
    scan,
    fail(video) {
      if (!tracked.has(video)) return;
      failed.add(video);
      visible.delete(video);
      release(video);
      fill();
    },
    dispose() {
      root.removeEventListener?.('pointerdown', activate, true);
      root.removeEventListener?.('focusin', activate, true);
      mutations?.disconnect();
      observer?.disconnect();
      for (const video of active) release(video);
      tracked.clear();
      visible.clear();
    },
  };
}
