#!/usr/bin/env node

/*
 * Direct Cloudflare R2 S3 API benchmark. It intentionally uses only Node's
 * built-in modules, so it can be copied to another machine without installing
 * an SDK. Run with: node --env-file=.env scripts/benchmark-r2.mjs
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

const args = new Map(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=') || 'true'];
}));
const sizeMiB = positiveInt(args.get('size-mib') || 32, 1, 512);
const runs = positiveInt(args.get('runs') || 1, 1, 10);
const timeoutMs = positiveInt(args.get('timeout-ms') || 120_000, 5_000, 900_000);
const cleanupTimeoutMs = Math.min(timeoutMs, 30_000);
const keep = args.get('keep') === 'true';

const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const endpointText = String(process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
const bucket = String(process.env.R2_BUCKET || '').trim();
const region = String(process.env.R2_REGION || 'auto').trim() || 'auto';
if (!accessKeyId || !secretAccessKey || !endpointText || !bucket) {
  throw new Error('缺少 R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_ENDPOINT/R2_BUCKET');
}
const endpoint = new URL(endpointText);
if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('R2_ENDPOINT 必须是 http(s) URL');

const payloadSize = sizeMiB * 1024 * 1024;
const payload = randomBytes(payloadSize);
const keyPrefix = `bench/r2-speed-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;

function positiveInt(value, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`参数必须是 ${min}-${max} 的整数`);
  return parsed;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function hmac(key, value) { return createHmac('sha256', key).update(value).digest(); }
function awsEncode(value) { return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function canonicalPath(key) { return `/${awsEncode(bucket)}/${String(key).split('/').map(awsEncode).join('/')}`; }
function signingKey(dateStamp) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function signedRequest(method, key, body = null, contentType = '') {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const host = endpoint.host;
  const payloadDigest = body === null ? 'UNSIGNED-PAYLOAD' : sha256(body);
  const headers = {
    host,
    'x-amz-content-sha256': payloadDigest,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map(name => `${name}:${String(headers[name]).trim()}\n`).join('');
  const canonicalRequest = [
    method,
    canonicalPath(key),
    '',
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadDigest,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(dateStamp)).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
  return { url: new URL(canonicalPath(key), endpoint).toString(), headers };
}

async function request(method, key, body = null, contentType = '', requestTimeoutMs = timeoutMs) {
  const signed = signedRequest(method, key, body, contentType);
  const response = await fetch(signed.url, {
    method,
    headers: signed.headers,
    body,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return response;
}

function mibPerSecond(bytes, milliseconds) { return bytes / 1024 / 1024 / (milliseconds / 1000); }
function elapsedMs(start) { return Number(process.hrtime.bigint() - start) / 1e6; }
function resultLine(label, bytes, milliseconds, status) {
  console.log(`${label}: HTTP ${status}, ${bytes} bytes, ${milliseconds.toFixed(0)} ms, ${mibPerSecond(bytes, milliseconds).toFixed(2)} MiB/s`);
}

async function consume(response, onProgress = null) {
  if (!response.body) return 0;
  let bytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    onProgress?.(bytes);
  }
  return bytes;
}

console.log(`R2 benchmark: ${endpoint.host}, bucket=${bucket}, size=${sizeMiB} MiB, runs=${runs}`);
console.log(`Payload generation excluded from timings; operation timeout=${timeoutMs} ms.`);
console.log(keep ? 'Temporary objects will be kept (--keep).' : 'Each temporary object is deleted afterwards, including after a failed run.');
const uploadRates = [];
const downloadRates = [];
let failures = 0;

for (let index = 1; index <= runs; index += 1) {
  const key = `${keyPrefix}-${index}.bin`;
  console.log(`run ${index}/${runs} key=${key}`);
  try {
    let start = process.hrtime.bigint();
    const upload = await request('PUT', key, payload, 'application/octet-stream');
    const uploadMs = elapsedMs(start);
    if (!upload.ok) throw new Error(`PUT ${upload.status}: ${await upload.text()}`);
    uploadRates.push(mibPerSecond(payload.length, uploadMs));
    resultLine(`run ${index} upload`, payload.length, uploadMs, upload.status);

    start = process.hrtime.bigint();
    const download = await request('GET', key);
    let lastProgressAt = Date.now();
    const downloaded = await consume(download, bytes => {
      if (Date.now() - lastProgressAt < 5_000) return;
      lastProgressAt = Date.now();
      console.log(`run ${index} download progress: ${(bytes / 1024 / 1024).toFixed(1)} / ${sizeMiB} MiB`);
    });
    const downloadMs = elapsedMs(start);
    if (!download.ok) throw new Error(`GET ${download.status}: ${await download.text()}`);
    if (downloaded !== payload.length) throw new Error(`GET size mismatch: ${downloaded} != ${payload.length}`);
    downloadRates.push(mibPerSecond(downloaded, downloadMs));
    resultLine(`run ${index} download`, downloaded, downloadMs, download.status);

    const head = await request('HEAD', key);
    if (!head.ok) throw new Error(`HEAD ${head.status}`);
    console.log(`run ${index} head: HTTP ${head.status}, content-length=${head.headers.get('content-length') || 'unknown'}, content-type=${head.headers.get('content-type') || 'unknown'}`);
  } catch (error) {
    failures += 1;
    const detail = error?.name === 'TimeoutError'
      ? `timeout after ${timeoutMs} ms`
      : (error?.message || String(error));
    console.error(`run ${index} failed: ${detail}`);
  } finally {
    if (!keep) {
      // Try deletion even when PUT timed out: the server may have committed the
      // object before the client lost the response.
      const deleted = await request('DELETE', key, null, '', cleanupTimeoutMs).catch(error => ({ ok: false, status: 'network', error }));
      if (!deleted.ok) console.warn(`cleanup failed for ${key}: HTTP ${deleted.status || deleted.error?.message || 'unknown'}`);
    } else {
      console.log(`kept object: ${key}`);
    }
  }
}

function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function summary(values) { return values.length ? `avg=${average(values).toFixed(2)} MiB/s, min=${Math.min(...values).toFixed(2)} MiB/s, samples=${values.length}` : 'no successful samples'; }
console.log(`summary upload: ${summary(uploadRates)}`);
console.log(`summary download: ${summary(downloadRates)}`);
console.log(`summary runs: ${runs - failures}/${runs} succeeded, ${failures} failed`);
if (failures) process.exitCode = 1;
