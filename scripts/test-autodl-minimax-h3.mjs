import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OSS from 'ali-oss';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const apiBase = 'https://autodl.art';
const workflowId = process.env.AUTODL_MINIMAX_H3_ID || 'minimax_h3_image_audio_to_video_v2_15s';
const resumeTaskId = process.env.AUTODL_TASK_ID || '';
const apiKey = process.env.AUTODL_COMFYUI_KEY;
const duration = 15;
// AutoDL 文档没有 720p 选项，横向最接近的是 768p横。
const resolution = '768p横';
const pollIntervalMs = Number(process.env.AUTODL_POLL_INTERVAL_MS || 10_000);
const maxPolls = Number(process.env.AUTODL_MAX_POLLS || 180);
const outputDir = path.join(rootDir, 'data', 'autodl-tests');

const assetFiles = [
  'data/users/fb6975c7-880c-46f8-8f95-31254e6e1173/assets/563f6bc9-25b5-4d32-b357-6f0a6ec68826.json',
  'data/users/fb6975c7-880c-46f8-8f95-31254e6e1173/assets/77d3a0c6-6312-4480-989d-d554ec7d4034.json',
  'data/users/fb6975c7-880c-46f8-8f95-31254e6e1173/assets/4591774d-63f7-4b5b-ab4e-1102fe60e6a7.json',
  'data/users/fb6975c7-880c-46f8-8f95-31254e6e1173/assets/93c0307e-264c-4f4d-821f-b8957c2dfb2d.json',
].map(file => path.join(rootDir, file));

const prompt = [
  '15-second single continuous cinematic shot, horizontal 16:9, realistic xianxia live-action style.',
  'Use reference image 1 only to lock the white-robed female cultivator’s face, long black hair and white hanfu.',
  'Use reference image 2 only to lock the cliff-top stone platform and sea of clouds.',
  'Use reference image 3 only to lock the half watermelon and silver spoon.',
  'Use reference image 4 only to lock the silver sword with glowing runes.',
  '0-2s: hold the initial composition; the cultivator sits cross-legged at the cliff edge, the sword is planted beside her, and she holds the watermelon.',
  '2-7s: she slowly scoops and eats the watermelon while the camera makes a subtle push-in.',
  '7-11s: she smiles and gently narrows her eyes, keeping the watermelon and sword in the same positions.',
  '11-15s: she stops and holds the satisfied expression as the final frame.',
  'Preserve the same face, costume, cliff geometry, daylight direction, watermelon position and sword design throughout.',
  'One continuous shot, no cuts, no new characters, no aircraft, no rain, no modern objects, no text, no watermark, no deformation.',
].join(' ');

function required(name, value) {
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeResponse(value) {
  return value?.data && typeof value.data === 'object' ? value.data : value;
}

function taskStatus(value) {
  const data = normalizeResponse(value);
  return String(data?.status || value?.status || '').trim().toLowerCase();
}

function taskIdFrom(value) {
  const data = normalizeResponse(value);
  const id = data?.task_id || data?.taskId || value?.task_id || value?.taskId;
  return id === undefined || id === null ? '' : String(id);
}

function resultList(value) {
  const data = normalizeResponse(value);
  return Array.isArray(data?.results) ? data.results : [];
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`AutoDL 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const message = body?.msg || body?.message || body?.error || `HTTP ${response.status}`;
    throw new Error(`AutoDL 请求失败：${message}`);
  }
  if (body?.code && String(body.code).toLowerCase() !== 'success' && body.code !== 200) {
    throw new Error(`AutoDL 请求失败：${body.msg || body.code}`);
  }
  return body;
}

async function loadReferenceUrls() {
  const assets = await Promise.all(assetFiles.map(file => fs.readFile(file, 'utf8').then(JSON.parse)));
  const canSignOss = process.env.ALIYUN_ACCESS_KEY_ID
    && process.env.ALIYUN_ACCESS_KEY_SECRET
    && process.env.ALIYUN_OSS_BUCKET
    && process.env.ALIYUN_OSS_ENDPOINT;

  if (!canSignOss) {
    throw new Error('缺少 OSS 配置，无法上传本地参考图并生成公网 URL');
  }

  const client = new OSS({
    region: process.env.ALIYUN_OSS_ENDPOINT.replace(/^oss-/, '').replace(/\.aliyuncs\.com$/, ''),
    endpoint: process.env.ALIYUN_OSS_ENDPOINT,
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
    bucket: process.env.ALIYUN_OSS_BUCKET,
    secure: true,
  });
  const uploadPrefix = `autodl-tests/${Date.now()}`;

  return Promise.all(assets.map(async asset => {
    if (!asset.storageName) throw new Error(`资产 ${asset.id} 没有本地文件名`);
    const localFile = path.join(rootDir, 'data', 'users', asset.ownerId, 'files', asset.storageName);
    await fs.access(localFile);
    const key = `${uploadPrefix}/${asset.storageName}`;
    await client.put(key, localFile, { headers: { 'Content-Type': asset.mimeType || 'image/png' } });
    // Bucket objects are public; use an unsigned URL because AutoDL validates URLs with HEAD.
    return client.generateObjectUrl(key);
  }));
}

function authHeaders() {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function main() {
  required('AUTODL_COMFYUI_KEY', apiKey);
  required('AUTODL_MINIMAX_H3_ID', workflowId);
  await fs.mkdir(outputDir, { recursive: true });

  const startedAt = new Date();
  const startedMs = Date.now();
  let referenceImages = [];
  let payload = { seed: null, prompt, duration, resolution };
  let submitted;
  let taskId;
  let firstStatus;
  let latest;

  if (resumeTaskId) {
    taskId = resumeTaskId;
    console.log(`[autodl] resume task_id=${taskId}`);
    latest = await fetchJson(`${apiBase}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`, {
      headers: authHeaders(),
    });
    firstStatus = taskStatus(latest);
    submitted = { code: latest?.code || 'Success', msg: 'resumed existing task', data: { task_id: taskId, status: firstStatus } };
  } else {
    referenceImages = await loadReferenceUrls();
    payload = {
      seed: Math.floor(Math.random() * 2_147_483_647),
      prompt,
      duration,
      resolution,
      ref_image_0: referenceImages[0],
      ref_image_1: referenceImages[1],
      ref_image_2: referenceImages[2],
      ref_image_3: referenceImages[3],
    };
    const submitUrl = `${apiBase}/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`;
    console.log(`[autodl] submit workflow=${workflowId} duration=${duration}s resolution=${resolution} refs=${referenceImages.length}`);
    submitted = await fetchJson(submitUrl, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    taskId = taskIdFrom(submitted);
    if (!taskId) throw new Error('AutoDL 提交响应没有返回 task_id');
    firstStatus = taskStatus(submitted);
  }

  console.log(`[autodl] task_id=${taskId} status=${firstStatus || 'unknown'}`);
  if (!latest) latest = submitted;
  let polls = 0;
  let finalStatus = firstStatus;

  while (!['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(finalStatus)) {
    if (polls >= maxPolls) throw new Error(`轮询超时：已等待 ${Math.round((Date.now() - startedMs) / 1000)} 秒`);
    await sleep(pollIntervalMs);
    polls++;
    try {
      latest = await fetchJson(`${apiBase}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`, {
        headers: authHeaders(),
      });
    } catch (error) {
      console.error(`[autodl] poll=${polls} transient error: ${error.message}; retrying`);
      continue;
    }
    finalStatus = taskStatus(latest);
    console.log(`[autodl] poll=${polls} status=${finalStatus || 'unknown'} elapsed=${Math.round((Date.now() - startedMs) / 1000)}s`);
  }

  const elapsedMs = Date.now() - startedMs;
  const data = normalizeResponse(latest);
  const serviceDurationSeconds = Number.isFinite(Number(data?.duration)) ? Number(data.duration) : null;
  const record = {
    workflowId,
    taskId,
    status: finalStatus,
    duration,
    serviceDurationSeconds,
    requestedResolution: resolution,
    referenceCount: referenceImages.length || 4,
    seed: payload.seed,
    polls,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs,
    results: resultList(latest),
    requestId: latest?.request_id || submitted?.request_id || '',
    submitResponse: {
      code: submitted?.code || '',
      msg: submitted?.msg || '',
      status: taskStatus(submitted),
    },
    resultResponse: {
      code: latest?.code || '',
      msg: latest?.msg || '',
      data: {
        status: data?.status || '',
        task_id: taskId,
        results: resultList(latest),
      },
    },
  };
  const resultFile = path.join(outputDir, `minimax-h3-${taskId}.json`);
  await fs.writeFile(resultFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    status: finalStatus,
    taskId,
    elapsedSeconds: Number((elapsedMs / 1000).toFixed(1)),
    serviceDurationSeconds: record.serviceDurationSeconds,
    results: record.results,
    resultFile: path.relative(rootDir, resultFile),
  }, null, 2));

  if (!['completed', 'success', 'succeeded'].includes(finalStatus)) process.exitCode = 2;
}

main().catch(error => {
  console.error(`[autodl] ${error.message}`);
  process.exitCode = 1;
});
