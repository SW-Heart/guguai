// Keep the visible scene anchored to the surface's top-left corner. The
// upstream observer recenters the viewport whenever the chat column changes.
export function resizeCanvasSurface(core, entries) {
  const stage = core.getStage();
  for (const { contentRect } of entries) {
    stage.width(contentRect.width);
    stage.height(contentRect.height);
  }
  core.getCanvasTransformer().emitPositionChange();
}

export function patchWhiteboardResize(source) {
  const observer = /new ResizeObserver\(\(e\) => \{\s*for \(const n of e\) \{\s*const \{ width:[\s\S]*?this\._updateViewport\([\s\S]*?\n    \}\n  \}\)/g;
  if ([...source.matchAll(observer)].length !== 1) {
    throw new Error('Unable to locate the whiteboard surface resize observer');
  }
  return source.replace(observer, () =>
    `new ResizeObserver(entries => (${resizeCanvasSurface.toString()})(this, entries))`);
}
