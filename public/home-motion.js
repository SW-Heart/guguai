export function initHomeMotion({ document: doc, window: win, tabs, activate }) {
  const hero = doc.querySelector('[data-home-motion]');
  if (!hero?.dataset.homeMotion || tabs.length < 2) return;

  const stage = hero.querySelector('.product-stage');
  const productWindow = hero.querySelector('#product-window');
  const toggle = hero.querySelector('[data-motion-toggle]');
  const label = hero.querySelector('[data-motion-label]');
  const pauseIcon = hero.querySelector('[data-motion-pause]');
  const playIcon = hero.querySelector('[data-motion-play]');
  const motionPreference = win.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = win.matchMedia('(pointer: fine)');
  let reduced = motionPreference.matches;
  let manuallyPaused = reduced;
  let hovered = false;
  let focused = false;
  let visible = true;
  let timer = 0;
  let frame = 0;

  const stop = () => {
    win.clearTimeout(timer);
    timer = 0;
  };
  const sync = () => {
    stop();
    const paused = manuallyPaused || reduced;
    const suspended = paused || hovered || focused || !visible || doc.hidden;
    hero.dataset.motionPaused = String(suspended);
    if (toggle) toggle.setAttribute('aria-label', paused ? '播放预览动画' : '暂停预览动画');
    if (label) label.textContent = paused ? '播放动画' : '暂停动画';
    if (pauseIcon) pauseIcon.hidden = paused;
    if (playIcon) playIcon.hidden = !paused;
    if (suspended) return;
    timer = win.setTimeout(() => {
      timer = 0;
      const current = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
      activate(tabs[(current + 1) % tabs.length]);
      sync();
    }, 5200);
  };
  const resetTilt = () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    productWindow?.style.setProperty('--tilt-x', '0deg');
    productWindow?.style.setProperty('--tilt-y', '0deg');
  };
  toggle?.addEventListener('click', () => {
    // Reduced motion always remains static, including after using this control.
    if (reduced) return;
    manuallyPaused = !manuallyPaused;
    if (manuallyPaused) resetTilt();
    sync();
  });
  if (toggle) toggle.hidden = reduced;
  stage?.addEventListener('pointerenter', () => { hovered = true; sync(); });
  stage?.addEventListener('pointerleave', () => { hovered = false; resetTilt(); sync(); });
  stage?.addEventListener('focusin', () => { focused = true; sync(); });
  stage?.addEventListener('focusout', event => {
    if (!stage.contains(event.relatedTarget)) { focused = false; sync(); }
  });
  tabs.forEach(tab => tab.addEventListener('pointerdown', () => {
    // Touch selection stays on the chosen screenshot until animation is resumed.
    manuallyPaused = true;
    sync();
  }));
  productWindow?.addEventListener('pointermove', event => {
    if (reduced || manuallyPaused || !finePointer.matches || event.pointerType === 'touch' || frame) return;
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
  doc.addEventListener('visibilitychange', () => { resetTilt(); sync(); });
  motionPreference.addEventListener?.('change', event => {
    reduced = event.matches;
    if (reduced) manuallyPaused = true;
    if (toggle) toggle.hidden = reduced;
    resetTilt();
    sync();
  });
  if ('IntersectionObserver' in win) {
    const observer = new win.IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (!visible) resetTilt();
      sync();
    });
    observer.observe(hero);
  }
  sync();
}
