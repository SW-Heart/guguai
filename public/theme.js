// Theme reveal adapted from https://beui.dev/components/motion/theme-toggle.
// The application shell uses native DOM controls rather than React.
(() => {
  const storageKey = 'gugu_theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const normalize = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  const readPreference = () => {
    try { return normalize(window.localStorage.getItem(storageKey)); }
    catch { return 'system'; }
  };
  let preference = readPreference();
  let transition = null;
  let revision = 0;

  const resolvedTheme = () => preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
  const renderControls = () => {
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      const selected = button.dataset.themeChoice === preference;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  };
  const apply = () => {
    const theme = resolvedTheme();
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
    renderControls();
  };
  const select = (value, animate = false) => {
    preference = normalize(value);
    const currentRevision = ++revision;
    transition?.skipTransition();
    transition = null;
    delete root.dataset.beuiVt;
    renderControls();
    const commit = () => { if (currentRevision === revision) apply(); };
    if (!animate || reducedMotion.matches || typeof document.startViewTransition !== 'function' || root.dataset.theme === resolvedTheme()) {
      commit();
      return;
    }
    root.dataset.beuiVt = 'rect';
    try {
      const nextTransition = document.startViewTransition(commit);
      transition = nextTransition;
      const cleanup = () => {
        if (transition !== nextTransition) return;
        transition = null;
        delete root.dataset.beuiVt;
        commit();
      };
      // Skipped snapshots can reject; the user's latest choice still applies.
      nextTransition.finished.then(cleanup, cleanup);
    } catch {
      delete root.dataset.beuiVt;
      commit();
    }
  };
  const choose = value => {
    try { window.localStorage.setItem(storageKey, normalize(value)); } catch { /* Session-only preference. */ }
    select(value, true);
  };

  // This classic script runs in <head>, before styles and the first paint.
  apply();
  system.addEventListener('change', () => { if (preference === 'system') select('system'); });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) select(readPreference());
  });
  document.addEventListener('DOMContentLoaded', () => {
    renderControls();
    const picker = document.getElementById('accountThemePicker');
    picker?.addEventListener('click', event => {
      const button = event.target.closest('[data-theme-choice]');
      if (button && picker.contains(button)) choose(button.dataset.themeChoice);
    });
    picker?.addEventListener('keydown', event => {
      const choices = [...picker.querySelectorAll('[data-theme-choice]')];
      const index = choices.indexOf(event.target);
      if (index < 0) return;
      let next;
      if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % choices.length;
      else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index + choices.length - 1) % choices.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = choices.length - 1;
      else return;
      event.preventDefault();
      choices[next].focus();
      choose(choices[next].dataset.themeChoice);
    });
  }, { once: true });
})();
