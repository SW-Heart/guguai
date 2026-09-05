export function createGenerationPresentation({ escapeHtml } = {}) {
  const esc = escapeHtml || (value => String(value));

  function taskProgress(task) {
    if (!Object.prototype.hasOwnProperty.call(task || {}, 'progress')) return null;
    const progress = Number(task.progress);
    return Number.isFinite(progress) && progress >= 0 && progress <= 100 ? Math.round(progress) : null;
  }

  function videoProgressLabel(task) {
    return ({
      submitting: '正在提交视频',
      provider_processing: '正在生成视频',
      polling_retry: '正在重试获取进度',
      archiving: '正在整理成品',
      awaiting_reconciliation: '正在确认任务',
    })[task.progressStage] || '正在生成视频';
  }

  function videoProgressMarkup(task) {
    if (task.type !== 'video' || !['queued', 'running'].includes(task.status)) return '';
    const progress = taskProgress(task);
    if (progress === null) return '';
    return `<div class="skeleton-progress" role="status" aria-live="polite" aria-label="视频生成进度 ${progress}%"><div class="skeleton-progress-head"><span><i aria-hidden="true"></i>${esc(videoProgressLabel(task))}</span><b>${progress}%</b></div><div class="skeleton-progress-track" aria-hidden="true"><i style="--progress:${progress}%"></i></div></div>`;
  }

  function generationPreparationMarkup(task) {
    if (!task?.localPreparation && !task?.awaitingReferences) return '';
    const label = ({ preparing_references: '正在准备素材…', confirming_price: '正在确认价格…', submitting: '正在提交生成…' })[task.progressStage] || '正在准备生成…';
    return `<div class="skeleton-progress" role="status" aria-live="polite" aria-label="${label}"><div class="skeleton-progress-head"><span><i aria-hidden="true"></i>${label}</span></div></div>`;
  }

  return Object.freeze({ taskProgress, videoProgressLabel, videoProgressMarkup, generationPreparationMarkup });
}
