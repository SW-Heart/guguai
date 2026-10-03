import { helpArticles, helpCategories } from './help-content.js?v=7';
import { searchHelp, highlightHelp, escapeHelpHtml as escape, resolveHelpLocation } from './help-search.js?v=3';
import { initHelpCopies } from './help-copy.js?v=2';

const search = document.querySelector('#help-search');
const results = document.querySelector('#help-results');
const articleContainer = document.querySelector('#help-articles');
const articleElements = [...document.querySelectorAll('.help-article')];
const readingNav = document.querySelector('.help-reading-nav');
const toc = document.querySelector('.help-toc');
const mobileNav = document.querySelector('#help-mobile-nav');
const clearButton = document.querySelector('.search-clear');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let observer;
let currentArticle;

function setQueryUrl(query) {
  const url = new URL(window.location.href);
  if (query) url.searchParams.set('q', query); else url.searchParams.delete('q');
  window.history.replaceState(null, '', url);
}
function scrollToTarget(target, focus = false) {
  window.requestAnimationFrame(() => {
    const element = document.getElementById(target);
    element?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'instant' : 'smooth' });
    if (focus && currentArticle) document.getElementById(`${currentArticle.id}-title`)?.focus({ preventScroll: true });
  });
}
function showArticle({ scroll = false, focus = false } = {}) {
  const { article, target } = resolveHelpLocation(helpArticles, window.location.hash);
  currentArticle = article;
  articleContainer.hidden = false;
  results.hidden = true;
  readingNav.hidden = false;
  toc.hidden = false;
  articleElements.forEach(element => { element.hidden = element.id !== article.id; });
  document.querySelectorAll('#help-nav a').forEach(link => {
    if (link.getAttribute('href') === `#${article.id}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  mobileNav.value = article.id;
  const position = helpArticles.indexOf(article);
  [['prev', -1, '上一篇'], ['next', 1, '下一篇']].forEach(([direction, delta, label]) => {
    const link = readingNav.querySelector(`[data-help-${direction}]`);
    const neighbor = helpArticles[position + delta];
    link.hidden = !neighbor;
    if (neighbor) {
      link.href = `#${neighbor.id}`;
      link.innerHTML = `<span>${label}</span>${escape(neighbor.title)}`;
    } else link.removeAttribute('href');
  });
  toc.querySelector('nav').innerHTML = article.sections.map((section, index) => `<a href="#${article.id}--${index}">${escape(section.title)}</a>`).join('');
  document.title = `${article.title} · GuGu AI 帮助文档`;
  observer?.disconnect();
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      const visible = entries.find(entry => entry.isIntersecting);
      if (!visible) return;
      toc.querySelectorAll('a').forEach(link => {
        if (link.getAttribute('href') === `#${visible.target.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-112px 0px -55% 0px', threshold: 0 });
    document.getElementById(article.id).querySelectorAll('section').forEach(section => observer.observe(section));
  }
  if (scroll) scrollToTarget(target, focus);
}
function showSearch() {
  const query = search.value.trim().slice(0, 200);
  clearButton.hidden = !query;
  setQueryUrl(query);
  if (!query) { showArticle(); return; }
  observer?.disconnect();
  results.hidden = false;
  articleContainer.hidden = true;
  readingNav.hidden = true;
  toc.hidden = true;
  const matches = searchHelp(helpArticles, query);
  const count = results.querySelector('.results-count');
  count.textContent = `找到 ${matches.length} 篇与「${query}」相关的文档`;
  results.querySelector('.results-list').innerHTML = matches.length ? matches.map(({ article, snippet }) => {
    const category = helpCategories.find(item => item.id === article.category);
    return `<a class="result-card" href="#${article.id}"><span>${escape(category.title)}</span><h3>${highlightHelp(article.title, query)}</h3><p>${highlightHelp(snippet, query)}</p></a>`;
  }).join('') : '<div class="search-empty"><strong>暂时没有找到相关文档</strong>试试更短的关键词，例如「视频」「分镜」或「积分」，也可以从文档目录浏览。</div>';
  document.title = '搜索帮助文档 · GuGu AI';
}
function clearSearch({ focus = false } = {}) {
  search.value = '';
  clearButton.hidden = true;
  setQueryUrl('');
  showArticle();
  if (focus) search.focus();
}
search.maxLength = 200;
search.addEventListener('input', showSearch);
search.form.addEventListener('submit', event => { event.preventDefault(); showSearch(); });
clearButton.addEventListener('click', () => clearSearch({ focus: true }));
document.querySelector('[data-exit-search]').addEventListener('click', () => clearSearch({ focus: true }));
document.querySelectorAll('[data-search-term]').forEach(button => button.addEventListener('click', () => {
  search.value = button.dataset.searchTerm;
  showSearch();
  search.focus();
}));
mobileNav.addEventListener('change', () => {
  const selected = mobileNav.value;
  clearSearch();
  if (window.location.hash === `#${selected}`) showArticle({ scroll: true });
  else window.location.hash = selected;
});
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]');
  if (!link) return;
  const hash = link.getAttribute('href');
  if (!helpArticles.some(article => hash === `#${article.id}` || hash.startsWith(`#${article.id}--`))) return;
  if (search.value) clearSearch();
  if (hash === window.location.hash) { event.preventDefault(); showArticle({ scroll: true, focus: true }); }
});
window.addEventListener('hashchange', () => {
  if (window.location.hash === '#main') return;
  search.value = new URLSearchParams(window.location.search).get('q') || '';
  clearButton.hidden = !search.value;
  if (search.value) showSearch();
  else showArticle({ scroll: true, focus: true });
});
window.addEventListener('popstate', () => {
  search.value = new URLSearchParams(window.location.search).get('q') || '';
  showSearch();
});
document.addEventListener('keydown', event => {
  const editable = event.target.closest('input, textarea, select, [contenteditable="true"]');
  if (event.key === '/' && !editable && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    search.focus();
  } else if (event.key === 'Escape' && document.activeElement === search) clearSearch({ focus: true });
});
document.documentElement.classList.add('help-enhanced');
initHelpCopies(document);
showArticle({ scroll: Boolean(window.location.hash && window.location.hash !== '#main') });
search.value = new URLSearchParams(window.location.search).get('q') || '';
if (search.value) showSearch();
