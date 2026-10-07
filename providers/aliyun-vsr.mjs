import { createHmac, randomUUID } from 'node:crypto';

// Alibaba Cloud video super-resolution (videoenhan SuperResolveVideo).
// The service only reads inputs from OSS in cn-shanghai, so clients upload
// sources straight into a dedicated temporary bucket and this adapter hands
// the service a short-lived signed URL. Both OSS and the RPC API use the
// HMAC-SHA1 signatures documented by Alibaba Cloud; no SDK is required.

const rpcVersion = '2020-03-20';
const terminalStatuses = new Set(['PROCESS_FAILED', 'TIMEOUT_FAILED', 'LIMIT_RETRY_FAILED']);
const throttledCodes = /^(Throttling|ServiceUnavailable|InternalError)/i;

function percent(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}
function xmlValues(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(match => match[1]);
}
function decodeXml(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function aliyunVsrFailureMessage(detail) {
  const text = String(detail || '');
  if (/分辨率超出范围|resolution or size of input video is beyond/i.test(text)) return '视频分辨率超出可放大范围';
  if (/时长|duration/i.test(text)) return '视频时长超出可放大范围';
  if (/文件内容不合法|格式|format|decode/i.test(text)) return '视频文件无法读取，请确认文件完整后重试';
  return '高清放大失败，请稍后重试';
}

export function createAliyunVsrProvider({
  accessKeyId = '',
  accessKeySecret = '',
  bucket = '',
  region = 'oss-cn-shanghai',
  prefix = 'video-upscale',
  endpoint = 'https://videoenhan.cn-shanghai.aliyuncs.com/',
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  minRequestIntervalMs = 550,
  requestTimeoutMs = 30_000,
  inputUrlExpiresSeconds = 3 * 3600,
  uploadUrlExpiresSeconds = 30 * 60,
  maxPollDurationMs = 2 * 3600_000,
  providerName = 'aliyun-vsr',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('阿里云视频增强适配器缺少 fetchImpl 依赖');
  const configured = Boolean(accessKeyId && accessKeySecret && bucket);
  const host = `${bucket}.${region}.aliyuncs.com`;
  const keyPrefix = String(prefix || '').replace(/^\/+|\/+$/g, '');

  function sign(text) {
    return createHmac('sha1', accessKeySecret).update(text).digest('base64');
  }
  function sourceKey(userId, taskId) {
    return `${keyPrefix}/${String(userId).replace(/[^\w-]/g, '_')}/${String(taskId).replace(/[^\w-]/g, '_')}.mp4`;
  }
  function presignedObjectUrl(key, { method = 'GET', contentType = '', expiresSeconds = inputUrlExpiresSeconds } = {}) {
    const expires = Math.floor(now() / 1000) + expiresSeconds;
    const signature = sign(`${method}\n\n${contentType}\n${expires}\n/${bucket}/${key}`);
    return `https://${host}/${encodeKey(key)}?OSSAccessKeyId=${percent(accessKeyId)}&Expires=${expires}&Signature=${percent(signature)}`;
  }
  function uploadTarget(key) {
    const contentType = 'video/mp4';
    return {
      url: presignedObjectUrl(key, { method:'PUT', contentType, expiresSeconds:uploadUrlExpiresSeconds }),
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(now() + uploadUrlExpiresSeconds * 1000).toISOString(),
    };
  }
  async function ossRequest(method, resource, url) {
    const date = new Date(now()).toUTCString();
    const response = await fetchImpl(url, {
      method,
      headers: { Date: date, Authorization: `OSS ${accessKeyId}:${sign(`${method}\n\n\n${date}\n${resource}`)}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return response;
  }
  async function headSource(key) {
    const response = await ossRequest('HEAD', `/${bucket}/${key}`, `https://${host}/${encodeKey(key)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error(`读取上传文件信息失败（${response.status}）`), { upstreamStatus:response.status });
    return { size:Number(response.headers.get('content-length')) || 0, contentType:response.headers.get('content-type') || '' };
  }
  async function deleteSource(key) {
    if (!key) return;
    const response = await ossRequest('DELETE', `/${bucket}/${key}`, `https://${host}/${encodeKey(key)}`);
    if (!response.ok && response.status !== 404) throw Object.assign(new Error(`删除临时文件失败（${response.status}）`), { upstreamStatus:response.status });
  }
  // OSS lifecycle rules only expire whole days, so a sweeper enforces the
  // shorter retention window for abandoned uploads and failed tasks.
  async function sweepExpiredSources({ maxAgeMs }) {
    let marker = '';
    let deleted = 0;
    for (let page = 0; page < 100; page++) {
      const query = `prefix=${percent(`${keyPrefix}/`)}&max-keys=1000${marker ? `&marker=${percent(marker)}` : ''}`;
      const response = await ossRequest('GET', `/${bucket}/`, `https://${host}/?${query}`);
      const xml = await response.text();
      if (!response.ok) throw Object.assign(new Error(`列出临时文件失败（${response.status}）`), { upstreamStatus:response.status });
      for (const entry of xmlValues(xml, 'Contents')) {
        const key = decodeXml(xmlValues(entry, 'Key')[0] || '');
        const modifiedAt = Date.parse(xmlValues(entry, 'LastModified')[0] || '');
        if (!key || !Number.isFinite(modifiedAt) || now() - modifiedAt < maxAgeMs) continue;
        await deleteSource(key);
        deleted++;
      }
      if (xmlValues(xml, 'IsTruncated')[0] !== 'true') break;
      marker = decodeXml(xmlValues(xml, 'NextMarker')[0] || '');
      if (!marker) break;
    }
    return { deleted };
  }

  // The service allows two requests per second per account. Submissions and
  // status queries share one queue so concurrent tasks never exceed it.
  let rpcQueue = Promise.resolve();
  let lastRequestAt = 0;
  function throttled(callback) {
    const run = rpcQueue.then(async () => {
      const wait = lastRequestAt + minRequestIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      return callback();
    });
    rpcQueue = run.catch(() => {});
    return run;
  }
  async function rpc(action, params, { attempts = 3 } = {}) {
    for (let attempt = 1; ; attempt++) {
      const query = {
        Format: 'JSON', Version: rpcVersion, AccessKeyId: accessKeyId, SignatureMethod: 'HMAC-SHA1',
        Timestamp: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'), SignatureVersion: '1.0',
        SignatureNonce: randomUUID(), Action: action, ...params,
      };
      const canonical = Object.keys(query).sort().map(key => `${percent(key)}=${percent(String(query[key]))}`).join('&');
      const signature = createHmac('sha1', `${accessKeySecret}&`).update(`POST&${percent('/')}&${percent(canonical)}`).digest('base64');
      const response = await throttled(() => fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `${canonical}&Signature=${percent(signature)}`,
        signal: AbortSignal.timeout(requestTimeoutMs),
      }));
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body;
      const error = Object.assign(new Error(`阿里云视频增强请求失败：${body.Code || response.status} ${body.Message || ''}`.trim()), {
        upstreamStatus: response.status,
        upstreamCode: String(body.Code || ''),
        upstreamMessage: String(body.Message || ''),
      });
      if (attempt >= attempts || !(throttledCodes.test(error.upstreamCode) || response.status >= 500)) throw error;
      await sleep(1000 * attempt);
    }
  }

  async function submit(task, hooks = {}) {
    if (!configured) throw Object.assign(new Error('高清放大服务尚未配置'), { upstreamTerminal:true });
    const upscale = task.upscale || {};
    if (!upscale.sourceKey) throw Object.assign(new Error('原视频尚未上传完成'), { upstreamTerminal:true, retryable:false });
    let created;
    try {
      created = await rpc('SuperResolveVideo', {
        VideoUrl: presignedObjectUrl(upscale.sourceKey),
        BitRate: upscale.bitRate || 10,
      });
    } catch (error) {
      // Transport failures leave no job id behind. Resubmitting costs a few
      // cents at most, so treat them as a retryable upstream rejection.
      throw Object.assign(error, { provider:providerName, upstreamTerminal:true });
    }
    const jobId = String(created.RequestId || '').trim();
    if (!jobId) throw Object.assign(new Error('高清放大服务没有返回任务编号'), { provider:providerName, upstreamTerminal:true });
    await hooks.onSubmitted?.({ provider:providerName, taskId:jobId });
    if (hooks.deferPolling) return { pending:true, provider:providerName, taskId:jobId };
    return poll({ ...task, providerTaskId:jobId }, hooks);
  }

  async function poll(task, hooks = {}, { pollOnce = false, pollIntervalMs = 10_000 } = {}) {
    const jobId = String(task.providerTaskId || '');
    const startedAt = Date.parse(task.submittedAt || '') || now();
    for (;;) {
      let state;
      try {
        state = await rpc('GetAsyncJobResult', { JobId: jobId });
        await hooks.onPollRecovered?.();
      } catch (error) {
        if ([400, 401, 403, 404].includes(Number(error.upstreamStatus)) && !throttledCodes.test(error.upstreamCode)) {
          throw Object.assign(error, { provider:providerName, providerTaskId:jobId, upstreamTerminal:true });
        }
        await hooks.onPollError?.({ consecutiveErrors:1, detail:error.message });
        if (pollOnce) return { pending:true, provider:providerName, taskId:jobId };
        await sleep(pollIntervalMs);
        continue;
      }
      const data = state.Data || {};
      const status = String(data.Status || '').toUpperCase();
      if (status === 'PROCESS_SUCCESS') {
        let result = {};
        try { result = JSON.parse(data.Result || '{}'); } catch {}
        const url = String(result.VideoUrl || '').trim();
        if (!url) throw Object.assign(new Error('高清放大已完成，但没有返回视频地址'), { provider:providerName, providerTaskId:jobId, upstreamTerminal:true });
        if (task.upscale?.sourceKey) await deleteSource(task.upscale.sourceKey).catch(error => console.warn('[upscale] 临时文件删除失败，将由定时清理处理', { generationId:task.id, message:error.message }));
        return { provider:providerName, taskId:jobId, url };
      }
      if (terminalStatuses.has(status)) {
        const detail = [data.ErrorCode, data.ErrorMessage].filter(Boolean).join(' ');
        const message = aliyunVsrFailureMessage(detail);
        throw Object.assign(new Error(message), {
          provider:providerName,
          providerTaskId:jobId,
          upstreamTerminal:true,
          upstreamMessage:detail,
          retryable:message === '高清放大失败，请稍后重试',
        });
      }
      if (now() - startedAt > maxPollDurationMs) {
        throw Object.assign(new Error('高清放大处理超时，请稍后重试'), { provider:providerName, providerTaskId:jobId, upstreamTerminal:true, pollTimedOut:true });
      }
      if (pollOnce) return { pending:true, provider:providerName, taskId:jobId };
      await sleep(pollIntervalMs);
    }
  }

  return Object.freeze({ configured, sourceKey, uploadTarget, presignedObjectUrl, headSource, deleteSource, sweepExpiredSources, submit, poll, rpc });
}
