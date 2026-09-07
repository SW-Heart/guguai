export function validateDownloadedMedia(prefix, size, { kind, contentType = '' } = {}) {
  if (!size) throw new Error('下载内容为空，请重试');
  const type = contentType.split(';')[0].trim().toLowerCase();
  const text = prefix.toString('utf8').trimStart();
  if (/html|json|xml/.test(type) || /^(?:<!doctype|<html|<\?xml|\{|\[)/i.test(text)) {
    throw new Error('下载源返回了错误页面，未保存为媒体文件');
  }
  if (kind === 'video') {
    const atom = prefix.toString('ascii', 4, 8);
    const mp4 = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(atom);
    const webm = prefix.length >= 4 && prefix.readUInt32BE(0) === 0x1a45dfa3;
    if (!mp4 && !webm) throw new Error('下载内容不是有效的视频文件');
    return webm ? 'video/webm' : type === 'video/quicktime' ? type : 'video/mp4';
  }
}
