// Homepage product film: chapters follow playback, the window tilts toward the pointer.
export function initHomeMotion({ document: doc, window: win }) {
  const hero = doc.querySelector('[data-home-motion]');
  const video = hero?.querySelector('[data-hero-film]');
  if (!video) return;

  const productWindow = hero.querySelector('#product-window');
  const toggle = hero.querySelector('[data-motion-toggle]');
  const label = hero.querySelector('[data-motion-label]');
  const pauseIcon = hero.querySelector('[data-motion-pause]');
  const playIcon = hero.querySelector('[data-motion-play]');
  const chapters = [...hero.querySelectorAll('[data-film-chapter]')];
  const starts = chapters.map(chapter => Number(chapter.dataset.start) || 0);
  const motionPreference = win.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = win.matchMedia('(pointer: fine)');
  let reduced = motionPreference.matches;
  // Reduced motion never starts the film by itself; the play button still works.
  let manuallyPaused = reduced;
  let visible = true;
  let frame = 0;

  const chapterAt = time => starts.reduce((found, start, index) => time >= start ? index : found, 0);
  const renderChapters = () => {
    const time = Number(video.currentTime) || 0;
    const duration = Number(video.duration) || 0;
    const current = chapterAt(time);
    chapters.forEach((chapter, index) => {
      const active = index === current;
      chapter.classList.toggle('is-active', active);
      if (active) chapter.setAttribute('aria-current', 'true');
      else chapter.removeAttribute('aria-current');
      const end = starts[index + 1] ?? duration;
      const progress = active && end > starts[index] ? (time - starts[index]) / (end - starts[index]) : index < current ? 1 : 0;
      chapter.style?.setProperty('--progress', String(Math.max(0, Math.min(1, progress))));
    });
  };
  const sync = () => {
    const paused = manuallyPaused;
    const suspended = paused || !visible || doc.hidden;
    hero.dataset.motionPaused = String(suspended);
    if (toggle) toggle.setAttribute('aria-label', paused ? '播放演示视频' : '暂停演示视频');
    if (label) label.textContent = paused ? '播放' : '暂停';
    if (pauseIcon) pauseIcon.hidden = paused;
    if (playIcon) playIcon.hidden = !paused;
    if (suspended) video.pause();
    else video.play()?.catch?.(() => {
      // Autoplay can be refused (e.g. data saver); fall back to the play button.
      manuallyPaused = true;
      sync();
    });
  };
  const resetTilt = () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    productWindow?.style.setProperty('--tilt-x', '0deg');
    productWindow?.style.setProperty('--tilt-y', '0deg');
  };

  toggle?.addEventListener('click', () => {
    manuallyPaused = !manuallyPaused;
    sync();
  });
  chapters.forEach((chapter, index) => chapter.addEventListener('click', () => {
    video.currentTime = starts[index];
    renderChapters();
    if (!reduced) {
      manuallyPaused = false;
      sync();
    }
  }));
  video.addEventListener('timeupdate', renderChapters);
  video.addEventListener('loadedmetadata', renderChapters);
  productWindow?.addEventListener('pointermove', event => {
    if (reduced || !finePointer.matches || event.pointerType === 'touch' || frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      const bounds = productWindow.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const x = Math.max(-.5, Math.min(.5, (event.clientX - bounds.left) / bounds.width - .5));
      const y = Math.max(-.5, Math.min(.5, (event.clientY - bounds.top) / bounds.height - .5));
      productWindow.style.setProperty('--tilt-x', `${y * -3.2}deg`);
      productWindow.style.setProperty('--tilt-y', `${x * 4.2}deg`);
    });
  });
  productWindow?.addEventListener('pointerleave', resetTilt);
  doc.addEventListener('visibilitychange', sync);
  motionPreference.addEventListener?.('change', event => {
    reduced = event.matches;
    if (reduced) {
      manuallyPaused = true;
      resetTilt();
    }
    sync();
  });
  if ('IntersectionObserver' in win) {
    const observer = new win.IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      sync();
    });
    observer.observe(video);
  }
  renderChapters();
  sync();
}
