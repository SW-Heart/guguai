// Long libraries keep every card in the DOM. Swap pictures far outside the
// scrolling area for a 1px placeholder so their decoded pixels can be freed,
// and restore the same URL before they scroll back into view.
export const placeholderImage = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

export function scrollContainer(element, getStyle) {
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    if (/(auto|scroll)/.test(getStyle(node).overflowY || '')) return node;
  }
  return null;
}

export function createOffscreenImages({ root, selector = 'img', IntersectionObserver, MutationObserver, getComputedStyle, margin = '1200px' }) {
  const tracked = new Set();
  let observer = null;
  let observerRoot;
  const release = image => {
    const src = image.getAttribute('src');
    if (!src || src === placeholderImage) return;
    image.dataset.releasedSrc = src;
    image.setAttribute('src', placeholderImage);
  };
  const restore = image => {
    const src = image.dataset.releasedSrc;
    if (!src) return;
    delete image.dataset.releasedSrc;
    image.setAttribute('src', src);
  };
  const connect = () => {
    // Clipping by an inner scroller ignores the viewport margin, so observe
    // against whichever element actually scrolls the cards right now.
    const scroller = getComputedStyle ? scrollContainer(root, getComputedStyle) : null;
    if (observer && scroller === observerRoot) return;
    observer?.disconnect();
    observerRoot = scroller;
    observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (!tracked.has(target)) continue;
        if (isIntersecting) restore(target);
        else release(target);
      }
    }, { root:scroller, rootMargin:`${margin} 0px` });
    tracked.forEach(image => observer.observe(image));
  };
  function scan() {
    if (!IntersectionObserver) return;
    connect();
    for (const image of tracked) {
      if (image.isConnected && root.contains(image)) continue;
      observer.unobserve(image);
      tracked.delete(image);
    }
    for (const image of root.querySelectorAll(selector)) {
      if (tracked.has(image)) continue;
      tracked.add(image);
      observer.observe(image);
    }
  }
  const mutations = MutationObserver ? new MutationObserver(scan) : null;
  mutations?.observe(root, { childList:true, subtree:true });
  return {
    scan,
    dispose() {
      mutations?.disconnect();
      observer?.disconnect();
      tracked.forEach(restore);
      tracked.clear();
    },
  };
}
