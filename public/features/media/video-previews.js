// Card previews retain native decoders even when paused. Keep only a small
// visible set loaded, and release sources when cards leave or are removed.
export function createVideoPreviews({ root, IntersectionObserver, MutationObserver, limit = 8 }) {
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
  const fill = () => {
    for (const video of visible) {
      if (active.size >= limit) break;
      if (active.has(video) || failed.has(video) || !video.isConnected) continue;
      load(video);
    }
  };
  const observer = IntersectionObserver ? new IntersectionObserver(entries => {
    for (const { target:video, isIntersecting } of entries) {
      if (!tracked.has(video)) continue;
      if (isIntersecting && video.isConnected) visible.add(video);
      else { visible.delete(video); release(video); }
    }
    fill();
  }, { rootMargin:'0px' }) : null;
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
