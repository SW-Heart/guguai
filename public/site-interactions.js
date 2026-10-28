import { initHeroTitle } from './hero-title.js?v=1';
import { initHomeMotion } from './home-motion.js?v=2';

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

  initHeroTitle({ document: doc, window: win });
  initHomeMotion({ document: doc, window: win });
  // Case films play only while on screen; with reduced motion they wait for the viewer.
  const caseVideos = [...doc.querySelectorAll('[data-case-video]')];
  if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) caseVideos.forEach(video => { video.controls = true; });
  else if (caseVideos.length && 'IntersectionObserver' in win) {
    const observer = new win.IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) entry.target.play()?.catch?.(() => {});
      else entry.target.pause();
    }), { threshold: .4 });
    caseVideos.forEach(video => observer.observe(video));
  }
  // The works rows scroll by half their width, so each row repeats its own items once.
  doc.querySelectorAll('[data-works-marquee] .works-row').forEach(row => {
    [...row.children].forEach(item => {
      const copy = item.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      row.append(copy);
    });
  });
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
