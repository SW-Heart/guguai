// Keep input order: row boundaries change, never the order of the files.
export function justifiedRows(ratios, width, { targetHeight = 220, gap = 12 } = {}) {
  if (!(width > 0)) return [];
  const rows = [];
  let start = 0;
  let sum = 0;
  const values = ratios.map(value => Number.isFinite(value) && value > 0 ? value : 1);
  const finish = (end, height) => {
    rows.push({ start, height, widths:values.slice(start, end).map(ratio => ratio * height) });
    start = end;
    sum = 0;
  };
  for (let index = 0; index < values.length; index++) {
    const count = index - start + 1;
    const nextSum = sum + values[index];
    const height = (width - gap * (count - 1)) / nextSum;
    if (height <= targetHeight) {
      const previousHeight = sum ? (width - gap * (count - 2)) / sum : Infinity;
      if (count > 1 && Math.abs(previousHeight - targetHeight) < Math.abs(height - targetHeight)) {
        finish(index, previousHeight);
        index--;
      } else {
        finish(index + 1, height);
      }
    } else {
      sum = nextSum;
    }
  }
  // The incomplete last row keeps its natural size instead of stretching.
  if (start < values.length) finish(values.length, Math.min(targetHeight, (width - gap * (values.length - start - 1)) / sum));
  return rows;
}

export function createJustifiedFileLayout(grid) {
  let frame = 0;
  let lastWidth = 0;
  const dimensions = new WeakMap();
  const posters = new WeakMap();
  let previousCards = [];
  let previousRatios = [];
  let previousWidth = 0;
  let previousGap = 0;
  // The layout restores its own visible anchor when newly discovered sizes
  // change row boundaries. Browser anchoring must not apply a second correction.
  grid.style.overflowAnchor = 'none';
  function readPoster(video, card) {
    const url = video?.getAttribute('poster');
    if (!url || posters.get(video)?.url === url) return;
    const state = { url };
    posters.set(video, state);
    const image = new Image();
    image.onload = () => {
      if (posters.get(video) !== state || !card.contains(video)) return;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        dimensions.set(card, image.naturalWidth / image.naturalHeight);
        schedule();
      }
    };
    // Use the existing cached still frame; never open a video decoder here.
    image.src = url;
  }
  function layout() {
    frame = 0;
    if (!grid.clientWidth) return;
    const cards = [...grid.children].filter(node => node.classList.contains('file-card'));
    grid.classList.toggle('justified-ready', cards.length > 0);
    if (!cards.length) { previousCards = []; return; }
    const style = getComputedStyle(grid);
    const width = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const gap = parseFloat(style.columnGap) || 12;
    const ratios = cards.map(card => {
      const media = card.querySelector('img, video');
      const mediaWidth = media?.naturalWidth || media?.videoWidth;
      const mediaHeight = media?.naturalHeight || media?.videoHeight;
      // Offscreen images are replaced with a 1px GIF to free decoded pixels.
      // Its dimensions are never the dimensions of the actual file. While
      // restoring a source, naturalWidth can also still belong to the GIF.
      const released = media?.dataset?.releasedSrc;
      const placeholder = media?.currentSrc?.startsWith('data:image/gif;base64,R0lGODlhAQABA');
      const ready = media?.tagName !== 'IMG' || media.complete;
      if (!released && !placeholder && ready && mediaWidth > 0 && mediaHeight > 0) dimensions.set(card, mediaWidth / mediaHeight);
      if (media?.tagName === 'VIDEO') readPoster(media, card);
      return dimensions.get(card) || Number(card.dataset.aspectRatio) || 1;
    });
    if (width === previousWidth && gap === previousGap && cards.length === previousCards.length
      && cards.every((card, index) => card === previousCards[index] && ratios[index] === previousRatios[index])) return;
    const gridTop = grid.getBoundingClientRect?.().top;
    const anchor = grid.scrollTop > 0 ? cards.find(card => {
      const rect = card.getBoundingClientRect?.();
      return rect && rect.bottom > gridTop;
    }) : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const rows = justifiedRows(ratios, width, { gap, targetHeight:width < 600 ? 160 : 220 });
    for (const row of rows) {
      row.widths.forEach((cardWidth, offset) => {
        const card = cards[row.start + offset];
        // Leave a fraction of a pixel for flex rounding at the row boundary.
        card.style.width = `${Math.max(0, cardWidth - .02)}px`;
        card.style.height = `${row.height}px`;
      });
    }
    if (anchor) grid.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    previousCards = cards;
    previousRatios = ratios;
    previousWidth = width;
    previousGap = gap;
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(layout);
  }
  grid.addEventListener('load', schedule, true);
  grid.addEventListener('loadedmetadata', schedule, true);
  // Poster-only previews intentionally never load video metadata. Their
  // dimensions must come from the still frame once it has been assigned.
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(schedule);
    observer.observe(grid, { attributes:true, attributeFilter:['poster'], subtree:true });
  }
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (lastWidth === grid.clientWidth) return;
      lastWidth = grid.clientWidth;
      schedule();
    });
    observer.observe(grid);
  } else {
    window.addEventListener('resize', schedule, { passive:true });
  }
  return { schedule };
}
