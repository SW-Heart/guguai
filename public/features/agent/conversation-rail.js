// List of agent conversations/projects shown on the left of the agent page.
// It only renders data and reports user intent; routing, dialogs and requests
// for rename/delete stay in app.js.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const chatIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
// Lucide: ellipsis, pencil, trash-2.
const moreIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';
const renameIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
const deleteIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

export function createConversationRail({ root, api, accountSnapshot, isAccountCurrent, onOpen, onRename, onDelete, onVisibilityChange }) {
  const list = root.querySelector('[data-rail-projects]');
  let projects = [];
  let activeId = '';
  let loadedFor = '';
  let status = 'idle';
  let token = 0;
  let menuId = '';
  let menuTrigger = null;
  const accountKey = account => `${account?.epoch ?? ''}:${account?.userId ?? ''}`;
  const projectFor = id => projects.find(item => String(item.id) === String(id)) || null;
  const isVisible = () => projects.length > 0 || status === 'error';

  // One shared menu in <body>, created on first use: the list scrolls, so an
  // in-list popup would be clipped by it.
  let menu = null;
  const menuItems = () => [...(menu?.querySelectorAll('[role="menuitem"]') || [])];

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.className = 'rail-project-menu';
    menu.id = 'railProjectMenu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.innerHTML = `<button type="button" role="menuitem" tabindex="-1" data-rail-menu-rename>${renameIcon}<span>重命名</span></button><button type="button" role="menuitem" tabindex="-1" class="rail-project-menu-delete" data-rail-menu-delete>${deleteIcon}<span>删除</span></button>`;
    document.body.append(menu);
    menu.addEventListener('click', event => {
      const action = event.target.closest('[data-rail-menu-rename]') ? 'rename' : event.target.closest('[data-rail-menu-delete]') ? 'delete' : '';
      if (!action) return;
      const item = projectFor(menuId);
      const trigger = menuTrigger;
      closeMenu();
      if (!item) return;
      // Dialogs restore focus to the "more" button, which stays in the list.
      trigger?.focus();
      if (action === 'rename') onRename?.({ ...item });
      else onDelete?.({ ...item });
    });
    menu.addEventListener('keydown', event => {
      const items = menuItems();
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu({ restoreFocus:true }); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    });
    document.addEventListener('pointerdown', event => {
      if (menu.hidden || menu.contains(event.target) || event.target.closest?.('[data-rail-more]') === menuTrigger) return;
      closeMenu();
    }, true);
    list?.addEventListener?.('scroll', () => closeMenu(), { passive:true });
    window.addEventListener('resize', () => closeMenu());
    window.addEventListener('blur', () => closeMenu());
    return menu;
  }

  function closeMenu({ restoreFocus = false } = {}) {
    if (!menu || menu.hidden) return;
    const trigger = menuTrigger;
    menu.hidden = true;
    menuId = '';
    menuTrigger = null;
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.closest('li')?.classList.remove('is-menu-open');
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }

  function openMenu(id, trigger) {
    closeMenu();
    if (!projectFor(id)) return;
    ensureMenu();
    menuId = String(id);
    menuTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.closest('li')?.classList.add('is-menu-open');
    menu.hidden = false;
    const rect = trigger.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const below = rect.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    requestAnimationFrame(() => menuItems()[0]?.focus());
  }

  function render() {
    onVisibilityChange?.(isVisible());
    if (!list) return;
    closeMenu();
    list.setAttribute('aria-busy', String(status === 'loading'));
    if (status === 'loading' && !projects.length) {
      list.innerHTML = `<li class="rail-project-status" role="status"><span class="rail-sr-only">正在加载对话</span></li>${'<li class="rail-project-skeleton" aria-hidden="true"><i></i><span></span></li>'.repeat(4)}`;
      return;
    }
    if (status === 'error' && !projects.length) {
      list.innerHTML = '<li class="rail-project-note"><span>对话暂时没有加载出来</span><button type="button" class="rail-note-button" data-rail-retry>重试</button></li>';
      return;
    }
    if (!projects.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = projects.map(item => {
      const id = escape(item.id);
      const title = escape(item.title || '新项目');
      const current = String(item.id) === activeId ? ' aria-current="page"' : '';
      return `<li class="rail-project-item"><button type="button" class="rail-project" data-rail-project="${id}" title="${title}"${current}><span class="rail-project-icon">${chatIcon}</span><span class="rail-project-title">${title}</span></button><button type="button" class="rail-project-more" data-rail-more="${id}" aria-label="更多操作：${title}" aria-haspopup="menu" aria-expanded="false" aria-controls="railProjectMenu" title="更多操作">${moreIcon}</button></li>`;
    }).join('');
  }

  async function refresh() {
    const account = accountSnapshot();
    const key = accountKey(account);
    // Never show another account's conversations while the new list loads.
    if (loadedFor !== key) { projects = []; loadedFor = key; }
    const request = ++token;
    if (!projects.length) { status = 'loading'; render(); }
    try {
      const result = await api('/api/agent/projects');
      if (request !== token || !isAccountCurrent(account)) return;
      projects = Array.isArray(result?.projects) ? result.projects : [];
      status = 'ready';
    } catch {
      if (request !== token || !isAccountCurrent(account)) return;
      status = projects.length ? 'ready' : 'error';
    }
    // Keep an open menu when a background refresh returns identical data.
    if (menuId && projectFor(menuId)) return;
    render();
  }

  function setActive(id) {
    activeId = String(id || '');
    list?.querySelectorAll('[data-rail-project]').forEach(button => {
      if (button.dataset.railProject === activeId) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function rename(id, title) {
    const item = projectFor(id);
    if (!item) return;
    item.title = title;
    render();
  }

  function remove(id) {
    const before = projects.length;
    projects = projects.filter(item => String(item.id) !== String(id));
    if (projects.length !== before) render();
  }

  function reset() {
    token += 1;
    closeMenu();
    projects = [];
    loadedFor = '';
    activeId = '';
    status = 'idle';
    if (list) list.innerHTML = '';
    onVisibilityChange?.(false);
  }

  root.addEventListener('click', event => {
    const more = event.target.closest('[data-rail-more]');
    if (more) {
      event.stopPropagation();
      if (menuId === more.dataset.railMore) closeMenu();
      else openMenu(more.dataset.railMore, more);
      return;
    }
    const project = event.target.closest('[data-rail-project]');
    if (project) { onOpen?.(project.dataset.railProject); return; }
    if (event.target.closest('[data-rail-retry]')) void refresh();
  });

  return { refresh, setActive, rename, remove, reset, isVisible };
}
