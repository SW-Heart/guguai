// The canvas engine redraws every node on each pan and zoom frame, including
// pictures far outside the window. Skip those only when painting the live
// layer; exports and cached renders pass their own canvas or target node and
// still draw everything. Nothing here touches node attributes or saved state.
const patched = Symbol('guguOffscreenCulling');

export function isOffscreen(rect, width, height, margin = 200) {
  if (!rect || !(width > 0) || !(height > 0)) return false;
  return rect.x > width + margin || rect.y > height + margin || rect.x + rect.width < -margin || rect.y + rect.height < -margin;
}

function liveOffscreen(shape, canvas, top) {
  if (top) return false;
  const layer = shape.getLayer?.();
  if (!layer || (canvas && canvas !== layer.getCanvas?.() && canvas !== layer.getHitCanvas?.())) return false;
  const stage = shape.getStage?.();
  if (!stage) return false;
  return isOffscreen(shape.getClientRect(), stage.width(), stage.height());
}

export function cullOffscreenImages(shape) {
  const proto = shape && Object.getPrototypeOf(shape);
  if (!proto || proto[patched] || typeof proto.drawScene !== 'function') return false;
  const drawScene = proto.drawScene, drawHit = proto.drawHit;
  proto.drawScene = function (canvas, top, ...rest) {
    return liveOffscreen(this, canvas, top) ? this : drawScene.call(this, canvas, top, ...rest);
  };
  if (typeof drawHit === 'function') proto.drawHit = function (canvas, top, ...rest) {
    return liveOffscreen(this, canvas, top) ? this : drawHit.call(this, canvas, top, ...rest);
  };
  proto[patched] = true;
  return true;
}
