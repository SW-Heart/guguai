const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const mediaKinds = ['image', 'video', 'audio'];
const labels = {image:'图片', video:'视频', audio:'音频', document:'文档', file:'文件'};
const extensions = {png:'image', jpg:'image', jpeg:'image', webp:'image', gif:'image', avif:'image', svg:'image', mp4:'video', webm:'video', mov:'video', m4v:'video', mp3:'audio', wav:'audio', ogg:'audio', m4a:'audio', aac:'audio', flac:'audio', pdf:'document', docx:'document', txt:'document', md:'document', csv:'document', json:'document', html:'document', rtf:'document'};
const icons = {
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  video:'<path d="m16 13 5 3V8l-5 3"/><rect x="3" y="5" width="13" height="14" rx="2"/>',
  audio:'<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  play:'<path d="m9 5 12 7-12 7Z"/>',
};
const icon = kind => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind] || icons.file}</svg>`;

export function attachmentKind(file) {
  if (mediaKinds.includes(file.kind)) return file.kind;
  const mime = String(file.mimeType || file.type || '').split('/')[0];
  if (mediaKinds.includes(mime)) return mime;
  return extensions[String(file.name || file.title || '').split('.').pop().toLowerCase()] || (file.text || file.kind === 'document' ? 'document' : 'file');
}

function safeUrl(value) {
  const url = String(value || '').trim();
  return /^(https?:\/\/|blob:|gugu-media:\/\/|\/(?!\/))/i.test(url) ? url : '';
}

export function attachmentSource(file) {
  return safeUrl(String(file.url || '').startsWith('gugu-media://') ? file.url : file.previewUrl || file.url);
}

function retryImageSource(image, file) {
  if (!file || image.dataset.attachmentFallbackTried) return false;
  const current = image.getAttribute('src');
  const fallback = [file.url, file.remoteUrl].map(safeUrl).find(url => url && url !== current);
  if (!fallback) return false;
  image.dataset.attachmentFallbackTried = 'true';
  image.src = fallback;
  return true;
}

function metadata(file) {
  const kind = attachmentKind(file), name = file.name || file.title || '';
  const extension = name.includes('.') ? name.split('.').pop().slice(0, 10).toUpperCase() : '';
  const size = Number(file.size || file.byteSize || 0);
  return [extension || labels[kind], size > 0 ? (size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`) : ''].filter(Boolean).join(' · ');
}

export function attachmentCardMarkup(file) {
  const kind = attachmentKind(file), src = attachmentSource(file), name = file.name || file.title || '未命名文件';
  const visual = kind === 'image' || kind === 'video';
  const imageOnly = kind === 'image' && Boolean(src);
  const media = src && kind === 'image' ? `<img src="${escape(src)}" alt="" loading="lazy" decoding="async">`
    : src && kind === 'video' ? `<video src="${escape(src)}" preload="metadata" muted playsinline tabindex="-1"></video>` : '';
  const status = file.status === 'loading' ? '正在读取…' : file.status === 'error' ? '未能读取，请移除后重试' : file.status === 'unavailable' ? '文件已不可用' : metadata(file);
  const snippet = kind === 'document' && file.text ? `<span class="attachment-card-excerpt">${escape(file.text.slice(0, 90))}</span>` : '';
  return `<article class="attachment-card attachment-card--${kind}${visual ? ' attachment-card--visual' : ''}${imageOnly ? ' attachment-card--image-only' : ''}${file.status === 'error' ? ' has-error' : ''}">
    <button type="button" class="attachment-card-open" data-attachment-preview="${escape(file.key)}" aria-label="预览 ${escape(name)}" aria-haspopup="dialog" title="${escape(name)}">
      <span class="attachment-card-art"><span class="attachment-card-symbol">${icon(kind)}<span>${labels[kind]}</span></span>${media}${snippet}${src && (kind === 'video' || kind === 'audio') ? `<span class="attachment-card-play">${icon('play')}<span>${kind === 'audio' ? '试听' : '播放'}</span></span>` : ''}</span>
      ${imageOnly ? '' : `<span class="attachment-card-caption"><span class="attachment-card-name">${escape(name)}</span><span class="attachment-card-meta"${file.status === 'loading' || file.status === 'error' ? ' role="status"' : ''}>${escape(status)}</span></span>`}
    </button>
    ${file.removable === false ? '' : `<button type="button" class="attachment-card-remove" data-attachment-remove="${escape(file.key)}" aria-label="移除 ${escape(name)}" title="移除文件"${file.removeDisabled ? ' disabled' : ''}><span class="gugu-lucide gugu-lucide-x" aria-hidden="true"></span></button>`}
  </article>`;
}

export function attachmentDetailMarkup(file) {
  const kind = attachmentKind(file), src = attachmentSource(file), name = file.name || file.title || '未命名文件';
  let content = '';
  if (src && kind === 'image') content = `<img src="${escape(src)}" alt="${escape(name)}">`;
  else if (src && kind === 'video') content = `<video src="${escape(src)}" controls playsinline preload="metadata" aria-label="${escape(name)}"></video>`;
  else if (src && kind === 'audio') content = `<div class="attachment-preview-audio">${icon('audio')}<audio src="${escape(src)}" controls preload="metadata" aria-label="${escape(name)}"></audio></div>`;
  else if (file.text) content = `<pre class="attachment-preview-text">${escape(file.text)}</pre>`;
  else content = `<p class="attachment-preview-notice">${file.status === 'loading' ? '正在读取文件，请稍候。' : file.status === 'error' ? '文件未能读取，请移除后重新添加。' : file.status === 'unavailable' ? '文件已不可用，请重新添加。' : '此文件暂不支持内容预览。'}</p>`;
  return `<header class="attachment-preview-header"><div><h2>${escape(name)}</h2><p>${escape(metadata(file))}</p></div><button type="button" data-attachment-close aria-label="关闭预览" autofocus><span class="gugu-lucide gugu-lucide-x" aria-hidden="true"></span></button></header><div class="attachment-preview-content">${content}<p class="attachment-preview-notice" data-media-error hidden>无法预览此文件，文件格式可能不受支持。</p></div>`;
}

// Keep media elements intact during unrelated conversation polling.
export function mountAttachmentPreviews(container, {signal, onRemove, renderCards = true} = {}) {
  let files = new Map(), markup = '', dialog = null, trigger = null, activeKey = null, activeFile = null;
  const stopMedia = () => dialog?.querySelectorAll('video,audio').forEach(media => {media.pause();media.removeAttribute('src');media.load();});
  const close = () => { if (dialog?.open) dialog.close(); };
  const show = file => {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'attachment-preview-dialog';
      document.body.append(dialog);
      dialog.addEventListener('click', event => {
        if (event.target.closest('[data-attachment-close]')) close();
        else if (event.target === dialog) {
          const bounds = dialog.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
        }
      });
      dialog.addEventListener('close', () => {
        stopMedia();dialog?.replaceChildren();activeKey = null;activeFile = null;
        if (trigger?.isConnected) trigger.focus({preventScroll:true});
      });
    dialog.addEventListener('error', event => {
      if (!event.target.matches('img,video,audio')) return;
      if (event.target.matches('img') && retryImageSource(event.target, activeFile)) return;
      event.target.hidden = true;
      dialog.querySelector('[data-media-error]').hidden = false;
      }, true);
    }
    stopMedia();
    activeKey = file.key;activeFile = file;
    dialog.innerHTML = attachmentDetailMarkup(file);
    dialog.setAttribute('aria-label', `预览 ${file.name || file.title || '文件'}`);
    if (!dialog.open) dialog.showModal();
  };
  container.addEventListener('click', event => {
    const remove = event.target.closest('[data-attachment-remove]');
    if (remove) {
      const file = files.get(remove.dataset.attachmentRemove);
      if (!file || file.removeDisabled || file.removable === false) return;
      if (activeKey === file.key) close();
      onRemove?.(file);
      return;
    }
    const button = event.target.closest('[data-attachment-preview]');
    const file = button && files.get(button.dataset.attachmentPreview);
    if (file) {trigger = button;show(file);}
  }, {signal});
  container.addEventListener('error', event => {
    if (event.target.matches('img') && retryImageSource(event.target, files.get(event.target.closest('[data-attachment-preview]')?.dataset.attachmentPreview))) return;
    if (event.target.matches('img,video')) {
      event.target.hidden = true;
      event.target.closest('.attachment-card')?.classList.add('has-media-error');
    }
  }, {capture:true, signal});
  signal?.addEventListener('abort', () => {close();stopMedia();dialog?.remove();dialog = null;files.clear();}, {once:true});
  return {
    update(items, {uploading = false} = {}) {
      if (signal?.aborted) return;
      files = new Map(items.map(file => [file.key, file]));
      if (activeKey !== null) {
        const next = files.get(activeKey);
        if (!next) close();
        else if (next.status !== activeFile.status || attachmentSource(next) !== attachmentSource(activeFile) || next.text !== activeFile.text) show(next);
      }
      if (!renderCards) return;
      const nextMarkup = items.map(attachmentCardMarkup).join('') + (uploading ? '<span class="attachment-upload-status" role="status">正在上传文件…</span>' : '');
      if (markup !== nextMarkup) {markup = nextMarkup;container.innerHTML = markup;}
    },
  };
}
