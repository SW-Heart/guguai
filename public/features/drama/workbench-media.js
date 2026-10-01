export function createWorkbenchMediaController({
  Observer = globalThis.IntersectionObserver,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  releaseDelay = 600,
} = {}) {
  const videos = new Set();
  const timers = new Map();
  let observer = null;

  function cancelRelease(video) {
    if (!timers.has(video)) return;
    clearTimer(timers.get(video));
    timers.delete(video);
  }
  function unload(video) {
    if (!video.getAttribute('src')) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  function forget(video) {
    cancelRelease(video);
    observer?.unobserve(video);
    videos.delete(video);
    unload(video);
  }
  function load(video) {
    const url = video.dataset.wbVideoSrc;
    if (url && video.getAttribute('src') !== url) video.src = url;
  }
  function ensureObserver() {
    if (!Observer || observer) return;
    const next = new Observer(entries => {
      if (observer !== next) return;
      for (const { target:video, isIntersecting } of entries) {
        if (!videos.has(video)) continue;
        if (!video.isConnected) { forget(video); continue; }
        if (isIntersecting) {
          cancelRelease(video);
          load(video);
        } else if (video.getAttribute('src') && !timers.has(video)) {
          timers.set(video, setTimer(() => {
            timers.delete(video);
            if (videos.has(video)) unload(video);
          }, releaseDelay));
        }
      }
    }, { rootMargin:'80px 0px' });
    observer = next;
  }
  function hydrate(scope) {
    ensureObserver();
    for (const video of scope.querySelectorAll('[data-wb-video-src]')) {
      if (videos.has(video)) continue;
      videos.add(video);
      if (observer) observer.observe(video);
      else load(video);
    }
  }
  function release(scope) {
    for (const video of scope.querySelectorAll('video')) forget(video);
  }
  function reset() {
    observer?.disconnect();
    observer = null;
    for (const video of [...videos]) forget(video);
  }
  return { hydrate, release, reset };
}
