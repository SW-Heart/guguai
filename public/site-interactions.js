import { initHomeMotion } from './home-motion.js?v=1';

export function initSiteInteractions({ document: doc = document, window: win = window } = {}) {
  const header = doc.querySelector('#site-header');
  const menu = header?.querySelector('.menu-toggle');
  const nav = header?.querySelector('.site-nav');
  if (menu && nav) {
    header.classList.add('has-menu');
    const setOpen = open => {
      header.classList.toggle('menu-open', open);
      menu.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', open ? '收起导航' : '展开导航');
    };
    menu.addEventListener('click', () => setOpen(menu.getAttribute('aria-expanded') !== 'true'));
    nav.addEventListener('click', event => {
      const link = event.target.closest('a');
      if (link && link.getAttribute('href') !== '#' && !event.defaultPrevented) setOpen(false);
    });
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        menu.focus();
      }
    });
    doc.addEventListener('click', event => { if (!header.contains(event.target)) setOpen(false); });
    win.matchMedia('(min-width: 861px)').addEventListener?.('change', () => setOpen(false));
  }

  const tabs = [...doc.querySelectorAll('[data-preview-tab]')];
  const activate = tab => {
    tabs.forEach(item => {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      const panel = doc.getElementById(item.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      activate(tabs[next]);
      tabs[next].focus();
    });
  });
  initHomeMotion({ document: doc, window: win, tabs, activate });
  const platform = String(win.navigator.userAgentData?.platform || win.navigator.platform || win.navigator.userAgent || '');
  // Mobile devices keep both installers equally available.
  const preferred = /iphone|ipad|android/i.test(platform) ? '' : /mac/i.test(platform) ? 'mac' : /win/i.test(platform) ? 'windows' : '';
  doc.querySelectorAll('.download-option').forEach(link => {
    if (link.dataset.platform !== preferred) return;
    link.classList.add('is-recommended');
    const note = doc.createElement('span');
    note.className = 'download-recommendation';
    note.textContent = '适合你的电脑';
    link.append(note);
  });
  doc.querySelectorAll('.hero-download-choice').forEach(choice => {
    if (choice.dataset.platform !== preferred) return;
    const button = choice.querySelector('.hero-download-button');
    button?.classList.add('is-recommended');
    button?.setAttribute('aria-label', `${button.textContent.trim()}，适配当前系统`);
  });
}
