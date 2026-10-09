export function canvasMediaFiles(snapshot, items = [], hidden = new Set()) {
  const known = new Map(items.map(item => [item.id, item]));
  return (snapshot?.nodes || []).flatMap((node, index) => {
    if (hidden.has(node.id) || node.visible === false) return [];
    const item = known.get(node.id);
    const kind = node.$_type === 'video' || node.$_actualType === 'video' ? 'video'
      : node.$_type === 'image' || node.$_actualType === 'image' ? 'image' : '';
    const url = (kind === 'video' ? node.$_videoUrl : node.$_imageUrl) || item?.media?.url;
    if (!kind || !url) return [];
    const original = item?.media?.url === url;
    return [{id:node.id,kind,url,name:item?.title || `${kind === 'image' ? '图片' : '视频'} ${index + 1}`,
      ...(node.$_assetId ? {assetId:node.$_assetId} : original && item.kind === 'asset' ? {assetId:item.id} : {}),
      ...(original && item.taskId ? {taskId:item.taskId} : {}),
    }];
  });
}

async function mediaBlob(media, fetchImpl) {
  const response = await fetchImpl(media.url).catch(() => {throw new Error('素材读取失败，请重新添加');});
  if (!response.ok) throw new Error('素材读取失败，请重新添加');
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  let mimeType = '';
  if (media.kind === 'video') {
    mimeType = ascii(4, 8) === 'ftyp' ? ascii(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
      : bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ? 'video/webm'
      : ['video/mp4','video/webm','video/quicktime'].includes(blob.type) ? blob.type : '';
    if (!mimeType) throw new Error('暂不支持这种视频格式，请使用 MP4、WebM 或 MOV');
  } else {
    mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
      : bytes[0] === 0x89 && ascii(1, 4) === 'PNG' ? 'image/png'
      : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'image/webp' : '';
  }
  if (mimeType) return new Blob([blob], {type:mimeType});
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('图片读取失败，请重新添加'));
    image.src = media.url;
  });
  const surface = document.createElement('canvas');
  surface.width = image.naturalWidth; surface.height = image.naturalHeight;
  try {
    const context = surface.getContext('2d');
    if (!context) throw new Error();
    context.drawImage(image, 0, 0);
    const converted = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
    if (!converted) throw new Error();
    return converted;
  } catch { throw new Error('这张图片暂时无法保存，请重新上传'); }
  finally { surface.width = 0; surface.height = 0; }
}

// Serialize additions and share pending work for copied nodes with the same
// source. Only completed library records are cached; failures can be retried.
export function createCanvasMediaLibrary({api, findFile, registerFile, isCurrent, fetchImpl = fetch}) {
  const files = new Map(), pending = new Map();
  let queue = Promise.resolve();
  const ensureCurrent = () => {
    if (!isCurrent()) throw Object.assign(new Error('请重新添加素材'), {stale:true});
  };
  async function save(media) {
    ensureCurrent();
    let file = media.assetId || media.taskId ? await findFile(media) : null;
    ensureCurrent();
    const replaced=Boolean(file&&file.url&&![file.url,file.remoteUrl,file.previewUrl].includes(media.url));
    if(replaced)file=null;
    if (!file && media.assetId&&!replaced) {
      file = await api(`/api/files/${encodeURIComponent(media.assetId)}`);
      ensureCurrent();
    }
    if (!file) {
      const blob = await mediaBlob(media, fetchImpl);
      ensureCurrent();
      const extension = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'}[blob.type];
      const name = `${media.name.replace(/\.[^.]+$/, '')}.${extension}`;
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
      ensureCurrent();
      const intent = await api('/api/files/uploads/init', {method:'POST',body:JSON.stringify({mimeType:blob.type,name,size:blob.size,sha256})});
      ensureCurrent();
      file = intent.asset;
      if (!file) {
        const uploaded = await fetchImpl(intent.uploadUrl, {method:'PUT',headers:intent.headers || {},body:blob})
          .catch(() => {throw new Error('素材保存失败，请重试');});
        ensureCurrent();
        if (!uploaded.ok) throw new Error('素材保存失败，请重试');
        file = await api(`/api/files/uploads/${encodeURIComponent(intent.uploadId)}/complete`, {method:'POST',body:'{}'});
        ensureCurrent();
      }
    }
    if (!file?.id || file.kind !== media.kind) throw new Error('素材尚未就绪，请稍后重试');
    file = await registerFile(file) || file;
    ensureCurrent();
    files.set(media.url, file);
    if (file.url) files.set(file.url, file);
    return file;
  }
  return {
    add(media) {
      ensureCurrent();
      if (files.has(media.url)) return Promise.resolve(files.get(media.url));
      if (pending.has(media.url)) return pending.get(media.url);
      const request = queue.then(() => save(media)).finally(() => pending.delete(media.url));
      pending.set(media.url, request);
      queue = request.catch(() => {});
      return request;
    },
  };
}
