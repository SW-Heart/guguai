import { createOptimizationDither } from './prompt-optimization-loading.js?v=1';

// Adapt the supplied beUI ImageGeneration field to the workbench's video frame.
export function renderVideoGenerationLoading({ progress = null } = {}) {
  const value = Number(progress);
  const percentage = progress !== null && Number.isFinite(value) && value > 0
    ? Math.min(99, Math.round(value)) : null;
  return `<div class="wb-video-generation" aria-busy="true"><div class="wb-video-generation-field" aria-hidden="true"><canvas data-video-generation-dither></canvas></div><div class="wb-video-generation-status" role="status" aria-live="polite"><span class="wb-video-generation-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>视频生成中</span><span data-video-generation-progress ${percentage === null ? 'hidden' : ''}>${percentage === null ? '' : `${percentage}%`}</span></div></div>`;
}

export function updateVideoGenerationProgress(element, progress) {
  const node = element?.querySelector('[data-video-generation-progress]');
  if (!node) return;
  const value = Number(progress);
  const visible = progress !== null && Number.isFinite(value) && value > 0;
  const text = visible ? `${Math.min(99, Math.round(value))}%` : '';
  node.hidden = !visible;
  if (node.textContent !== text) node.textContent = text;
}

export function createVideoGenerationLoadingController({ host = window, createDither = createOptimizationDither } = {}) {
  const fields = new Map();
  let observer;
  const remove = canvas => {
    observer?.unobserve(canvas);
    fields.get(canvas)?.stop();
    fields.delete(canvas);
  };
  return {
    hydrate(scope) {
      for (const canvas of fields.keys()) if (!canvas.isConnected) remove(canvas);
      if (!observer && host.IntersectionObserver) {
        observer = new host.IntersectionObserver(entries => {
          for (const entry of entries) {
            const field = fields.get(entry.target);
            if (!field) continue;
            if (entry.isIntersecting) field.start();
            else field.stop();
          }
        });
      }
      for (const canvas of scope.querySelectorAll('[data-video-generation-dither]')) {
        if (fields.has(canvas)) continue;
        const field = createDither(canvas, host);
        fields.set(canvas, field);
        if (observer) observer.observe(canvas);
        else field.start();
      }
    },
    release(scope) {
      for (const canvas of fields.keys()) if (scope === canvas || scope.contains(canvas)) remove(canvas);
    },
    reset() {
      for (const field of fields.values()) field.stop();
      fields.clear();
      observer?.disconnect();
      observer = null;
    },
  };
}
