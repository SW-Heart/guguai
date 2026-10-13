export function canvasContextPoint(client, rect, viewport = {}) {
  const scale = Math.max(.01, Number(viewport.scale) || 1);
  return { x: (client.x - rect.left - (Number(viewport.x) || 0)) / scale,
    y: (client.y - rect.top - (Number(viewport.y) || 0)) / scale };
}

export function mountCanvasContextMenu(surface, { layer, icons, ready, view, onSelect, onError }) {
  const controller = new AbortController();
  const { signal } = controller;
  const menu = document.createElement('div');
  menu.className = 'dw-gen-menu dw-canvas-context-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '画布操作');
  menu.innerHTML = [['upload', '上传素材'], ['image', '图像生成'], ['video', '视频生成']]
    .map(([action, label]) => `<button type="button" role="menuitem" data-canvas-action="${action}">${icons[action]}<span>${label}</span></button>`).join('');
  layer.append(menu);
  let point = null;
  let previousFocus = null;
  const buttons = () => [...menu.querySelectorAll('button')];
  const close = (restoreFocus = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    point = null;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  surface.addEventListener('contextmenu', event => {
    if (!ready() || event.target.closest('input, textarea, [contenteditable="true"], button, [role="menu"]')) return;
    event.preventDefault();
    event.stopPropagation();
    const { rect, viewport } = view();
    point = canvasContextPoint({ x: event.clientX, y: event.clientY }, rect, viewport);
    previousFocus = document.activeElement;
    menu.hidden = false;
    const size = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - size.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - size.height - 8))}px`;
    buttons()[0]?.focus({ preventScroll: true });
  }, { capture: true, signal });
  menu.addEventListener('click', event => {
    const button = event.target.closest('[data-canvas-action]');
    if (!button || !menu.contains(button) || !point) return;
    const location = { ...point };
    close();
    if (!ready()) return;
    try { Promise.resolve(onSelect(button.dataset.canvasAction, location)).catch(onError); }
    catch (error) { onError(error); }
  }, { signal });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = buttons(), index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }, { signal });
  document.addEventListener('keydown', event => {
    if (menu.hidden || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }, { capture: true, signal });
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) close();
  }, { capture: true, signal });
  window.addEventListener('resize', () => close(), { signal });
  document.addEventListener('scroll', event => {
    if (!menu.contains(event.target)) close();
  }, { capture: true, signal });
  return { close, destroy() { controller.abort(); menu.remove(); } };
}
