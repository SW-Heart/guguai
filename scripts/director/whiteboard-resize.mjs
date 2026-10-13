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

// GuGu paints canvas pictures from a display-sized copy (see director-workspace).
// Image records keep the original URL for crop, export and persistence.
export function patchWhiteboardImageSource(source) {
  // Only the image node loader; video covers use the same shape on this.cover.
  const loader = /(?:let|const) (\w+)\s*=\s*new Image(?:\(\))?;?\s*\1\.crossOrigin\s*=\s*"anonymous",\s*\1\.src\s*=\s*(\w+),(?=\s*\1\.onload\s*=\s*\(\)\s*=>\s*\{\s*this\.getElement\(\)\.image\(\1\))/g;
  if ([...source.matchAll(loader)].length !== 1) {
    throw new Error('Unable to locate the whiteboard image loader');
  }
  return source.replace(loader, (_, image, url) =>
    `const ${image} = new Image(), guguDisplayUrl = globalThis.guguCanvasImageUrl?.(${url}) ?? ${url};\n    ${image}.crossOrigin = "anonymous", guguDisplayUrl !== ${url} && (${image}.dataset.guguThumbnail = "1"), ${image}.src = guguDisplayUrl,`);
}
