// Shared project list for the 创作 home (recent projects) and the 项目 page.
// It renders data and reports intent; opening, creating, renaming and deleting
// stay with the canvas and short-drama modules that own each kind of project.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

export const projectTypeLabels = Object.freeze({ canvas:'智能画布', drama:'短剧工作台' });
const projectTypeDescriptions = Object.freeze({
  canvas:'和 GuGu 边聊边创作，自由生成图片、视频和文稿，在画布上整理想法与作品。',
  drama:'围绕剧本安排角色、场景与分镜，逐个镜头生成画面和视频，制作连贯的短剧。',
});
const projectTypeIcons = Object.freeze({ canvas:'layout-dashboard', drama:'clapperboard' });
const filterOptions = Object.freeze([['all', '全部'], ['canvas', projectTypeLabels.canvas], ['drama', projectTypeLabels.drama]]);

export function filterProjects(items, { query = '', type = 'all' } = {}) {
  const normalized = String(query || '').trim().toLocaleLowerCase();
  return (Array.isArray(items) ? items : []).filter(item => {
    if (type !== 'all' && item?.type !== type) return false;
    if (!normalized) return true;
    return [item?.title, projectTypeLabels[item?.type]].some(value => String(value || '').toLocaleLowerCase().includes(normalized));
  });
}

const projectKey = item => `${item.source}:${item.id}`;
const updatedLabel = value => {
  const date = new Date(Number(value) || 0);
  return Number.isNaN(date.getTime()) || !Number(value) ? '' : date.toLocaleDateString('zh-CN');
};

export function projectCardMarkup(item, { menu = true } = {}) {
  const key = escape(projectKey(item));
  const title = escape(item.title || '未命名项目');
  const label = projectTypeLabels[item.type] || projectTypeLabels.canvas;
  const mode = item.type === 'drama' ? 'professional' : 'smart';
  const updated = updatedLabel(item.updatedAt);
  const actions = menu ? `<div class="project-card-menu"><button type="button" class="project-card-menu-trigger" data-project-menu="${key}" aria-label="打开${title}的更多操作" aria-haspopup="menu" aria-expanded="false" title="更多操作"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.35"/><circle cx="12" cy="12" r="1.35"/><circle cx="12" cy="19" r="1.35"/></svg></button><div class="project-card-actions" role="menu" hidden><button type="button" role="menuitem" data-project-rename="${key}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-.8 4.8L8 20 19.2 8.8a2 2 0 0 0-2.8-2.8L5.2 17.2"/><path d="m14.8 7.2 2.8 2.8"/></svg><span>重命名</span></button><button type="button" role="menuitem" class="project-card-delete" data-project-delete="${key}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg><span>删除</span></button></div></div>` : '';
  return `<article class="project-card" data-project-mode="${mode}" data-project-key="${key}"><div class="project-card-art" aria-hidden="true"><i></i><i></i><i></i></div><button type="button" class="project-card-open" data-project-open="${key}" aria-label="打开${label}：${title}"><span>${label}</span><h2>${title}</h2><footer>${updated ? `<time>最新修改：${updated}</time>` : ''}</footer></button>${actions}</article>`;
}

function projectCardSkeleton(count) {
  return Array.from({ length:count }, () => '<article class="project-card loading-skeleton-project" aria-hidden="true"><div class="skeleton-project-content"><i class="skeleton-project-kicker"></i><i class="skeleton-project-title"></i><i class="skeleton-project-title short"></i></div></article>').join('');
}

// Resolves after the closing animation, before the chosen workspace opens.
export async function openProjectTypeDialog(trigger = document.activeElement) {
  const anchor = trigger?.querySelector?.('.create-home-sheet-front .gugu-lucide') || trigger?.querySelector?.('svg') || trigger;
  const getOrigin = () => {
    if (!anchor?.isConnected || !anchor.getBoundingClientRect) return null;
    const rect = anchor.getBoundingClientRect();
    return rect.width && rect.height ? { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } : null;
  };
  const origin = getOrigin();
  const { openProjectTypeModal } = await import('../../vendor/ui/create-project.js?v=5');
  return openProjectTypeModal(['canvas', 'drama'].map(type => ({
    type, label:projectTypeLabels[type], description:projectTypeDescriptions[type], icon:projectTypeIcons[type],
  })), { origin, getOrigin });
}

export function createProjectLibrary({ api, accountSnapshot, isAccountCurrent, toast, onOpen, onCreate, onRename, onDelete, onShowAll }) {
  let projects = null;
  let loadedFor = null;
  let loading = null;
  let query = '';
  let type = 'all';
  let pageRoot = null;
  let menuKey = '';
  const accountKey = account => `${account?.epoch ?? ''}:${account?.userId ?? ''}`;
  const projectFor = key => projects?.find(item => projectKey(item) === key) || null;

  function fetchProjects({ force = false } = {}) {
    const account = accountSnapshot();
    if (!force && projects && loadedFor === accountKey(account)) return Promise.resolve(projects);
    if (loading && loading.account === accountKey(account)) return loading.promise;
    const promise = api('/api/projects').then(result => {
      if (!isAccountCurrent(account)) return null;
      projects = Array.isArray(result?.projects) ? result.projects : [];
      loadedFor = accountKey(account);
      return projects;
    }).finally(() => { if (loading?.promise === promise) loading = null; });
    loading = { account:accountKey(account), promise };
    return promise;
  }

  function closeMenu({ restoreFocus = false } = {}) {
    if (!pageRoot) return;
    const trigger = menuKey ? [...pageRoot.querySelectorAll('[data-project-menu]')].find(button => button.dataset.projectMenu === menuKey) : null;
    menuKey = '';
    pageRoot.querySelectorAll('.project-card-menu').forEach(menu => {
      menu.querySelector('[data-project-menu]')?.setAttribute('aria-expanded', 'false');
      menu.querySelector('[role="menu"]')?.setAttribute('hidden', '');
    });
    if (restoreFocus) trigger?.focus();
  }
  function toggleMenu(trigger) {
    const key = trigger.dataset.projectMenu;
    const shouldOpen = menuKey !== key;
    closeMenu();
    if (!shouldOpen) return;
    const menu = trigger.closest('.project-card-menu')?.querySelector('[role="menu"]');
    if (!menu) return;
    menuKey = key;
    trigger.setAttribute('aria-expanded', 'true');
    menu.removeAttribute('hidden');
    menu.querySelector('[role="menuitem"]')?.focus({ preventScroll:true });
  }
  document.addEventListener('pointerdown', event => {
    if (menuKey && !event.target?.closest?.('.project-library-grid .project-card-menu')) closeMenu();
  });

  function drawCards() {
    if (!pageRoot?.isConnected) return;
    closeMenu();
    const grid = pageRoot.querySelector('.project-library-grid');
    const count = pageRoot.querySelector('.project-library-count');
    if (!projects) {
      grid.setAttribute('aria-busy', 'true');
      grid.classList.add('loading-skeleton');
      grid.innerHTML = projectCardSkeleton(7);
      count.textContent = '';
      return;
    }
    const visible = filterProjects(projects, { query, type });
    const filtered = query.trim() || type !== 'all';
    count.textContent = filtered ? `${visible.length} / ${projects.length} 个项目` : `${projects.length} 个项目`;
    const empty = filtered
      ? '<div class="project-library-empty"><b>没有找到匹配的项目</b><p>换个关键词或类型试试，也可以创建一个新项目。</p></div>'
      : '<div class="project-library-empty"><b>还没有项目</b><p>创建一个项目，开始你的创作。</p></div>';
    grid.setAttribute('aria-busy', 'false');
    grid.classList.remove('loading-skeleton');
    grid.innerHTML = `<button type="button" class="create-project-card" data-project-create><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span><b>创建项目</b></button>${visible.map(item => projectCardMarkup(item)).join('') || empty}`;
  }

  function renderPage(root) {
    pageRoot = root;
    menuKey = '';
    root.innerHTML = `<div class="project-library-toolbar"><label class="project-library-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg><span class="sr-only">搜索项目</span><input type="search" value="${escape(query)}" placeholder="搜索项目" autocomplete="off" data-project-search></label><div class="project-library-filter" role="radiogroup" aria-label="项目类型">${filterOptions.map(([value, label]) => `<button type="button" role="radio" data-project-filter="${value}" aria-checked="${value === type}" tabindex="${value === type ? 0 : -1}">${label}</button>`).join('')}</div><span class="project-library-count"></span></div><div class="project-library-grid" aria-busy="true"></div>`;
    root.querySelector('[data-project-search]').oninput = event => { query = event.target.value; drawCards(); };
    const filter = root.querySelector('.project-library-filter');
    const choose = button => {
      type = button.dataset.projectFilter;
      filter.querySelectorAll('[data-project-filter]').forEach(item => { const active = item === button; item.setAttribute('aria-checked', String(active)); item.tabIndex = active ? 0 : -1; });
      drawCards();
    };
    filter.onclick = event => { const button = event.target.closest('[data-project-filter]'); if (button) choose(button); };
    filter.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...filter.querySelectorAll('[data-project-filter]')];
      const next = buttons[(buttons.indexOf(document.activeElement) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
      next.focus();
      choose(next);
    };
    root.onclick = event => {
      const target = event.target;
      if (target.closest('[data-project-create]')) { onCreate?.(); return; }
      const menuTrigger = target.closest('[data-project-menu]');
      if (menuTrigger) { event.stopPropagation(); toggleMenu(menuTrigger); return; }
      const rename = target.closest('[data-project-rename]');
      if (rename) { const item = projectFor(rename.dataset.projectRename); const trigger = rename.closest('.project-card-menu')?.querySelector('[data-project-menu]'); closeMenu(); if (item) onRename?.({ ...item }, trigger); return; }
      const remove = target.closest('[data-project-delete]');
      if (remove) { const item = projectFor(remove.dataset.projectDelete); closeMenu(); if (item) onDelete?.({ ...item }); return; }
      const open = target.closest('[data-project-open]');
      if (open) { const item = projectFor(open.dataset.projectOpen); if (item) onOpen?.({ ...item }); }
    };
    root.onkeydown = event => {
      if (!menuKey) return;
      if (event.key === 'Escape') { event.preventDefault(); closeMenu({ restoreFocus:true }); return; }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const items = [...root.querySelectorAll('.project-card-actions:not([hidden]) [role="menuitem"]')];
      if (!items.length) return;
      event.preventDefault();
      items[(items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    };
    drawCards();
    // Show the last list at once, then refresh it in the background.
    void fetchProjects({ force:true }).then(list => { if (list && pageRoot === root) drawCards(); }).catch(error => {
      if (pageRoot !== root || !root.isConnected) return;
      if (!projects) { const grid = root.querySelector('.project-library-grid'); grid.classList.remove('loading-skeleton'); grid.setAttribute('aria-busy', 'false'); grid.innerHTML = `<div class="project-library-empty"><b>项目列表未能加载</b><p>${escape(error.message || '请稍后重试。')}</p></div>`; }
      else toast?.(error.message);
    });
  }

  async function renderRecent(root, { limit = 4, signal } = {}) {
    const draw = list => {
      if (signal?.aborted || !root.isConnected) return;
      const items = (list || []).slice(0, limit);
      root.hidden = Boolean(list) && !items.length;
      if (root.hidden) { root.replaceChildren(); return; }
      root.innerHTML = `<header><h2>最近项目</h2><button type="button" class="create-home-link" data-project-all>全部项目</button></header><div class="create-home-recent-row${list ? '' : ' loading-skeleton'}" ${list ? '' : 'aria-busy="true"'}>${list ? items.map(item => projectCardMarkup(item, { menu:false })).join('') : projectCardSkeleton(limit)}</div>`;
    };
    root.onclick = event => {
      if (event.target.closest('[data-project-all]')) { onShowAll?.(); return; }
      const open = event.target.closest('[data-project-open]');
      const item = open && projectFor(open.dataset.projectOpen);
      if (item) onOpen?.({ ...item });
    };
    const account = accountSnapshot();
    draw(projects && loadedFor === accountKey(account) ? projects : null);
    try { draw(await fetchProjects({ force:true })); }
    catch { if (!projects) { root.hidden = true; root.replaceChildren(); } }
  }

  return {
    renderPage,
    renderRecent,
    // Keep the visible list in step with changes made by the owning module.
    renamed(source, id, title) { const item = projects?.find(entry => entry.source === source && entry.id === String(id)); if (item) { item.title = title; drawCards(); } },
    removed(source, id) { if (projects) { projects = projects.filter(entry => !(entry.source === source && entry.id === String(id))); drawCards(); } },
    refresh() { if (pageRoot?.isConnected) renderPage(pageRoot); else { projects = null; loadedFor = null; } },
    reset() { projects = null; loadedFor = null; loading = null; query = ''; type = 'all'; pageRoot = null; menuKey = ''; },
  };
}
