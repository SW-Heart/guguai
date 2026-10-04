import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, tx } from './db.mjs';
import { appendAuditEvent, appendSystemEvent } from './audit.mjs';
import { planSortOrderShift } from './sort-order.mjs';

const CHECK_INTERVAL_MS = Math.max(60_000, Number(process.env.MODEL_ROUTE_CHECK_INTERVAL_MS || 10 * 60_000));
const CHECK_TIMEOUT_MS = Math.max(5_000, Number(process.env.MODEL_ROUTE_CHECK_TIMEOUT_MS || 15_000));
const MARKUP_BASIS_POINTS = 2_000;
const CREDITS_PER_YUAN = 10;
const CREDENTIAL_SECRET_ENV = 'MODEL_ROUTE_CREDENTIAL_SECRET';
export const ROUTE_QUALITIES = Object.freeze(['480p', '720p', '1080p']);

const baseUrls = {
  diw: String(process.env.DIW_API_BASE || 'https://mjnewapi.diwdiw.cn').replace(/\/$/, ''),
  wj: String(process.env.WJ_API_BASE || 'https://www.weijinapi.top').replace(/\/$/, ''),
  cntcn: String(process.env.CNTCN_API_BASE || 'https://api.ai.kbai.cc').replace(/\/$/, ''),
};

const MODEL_ROUTE_CHANNELS = Object.freeze([
  { id: 'diw-main', label: 'DIW · 主 Key', provider: 'diw', adapterType: 'diw-video', baseUrl: baseUrls.diw, envKey: 'DIW_KEY' },
  { id: 'wj-tjwd', label: 'WJ · TJWD Key', provider: 'wj', adapterType: 'wj-video', baseUrl: baseUrls.wj, envKey: 'WJ_TJWD_KEY' },
  { id: 'wj-py900', label: 'WJ · PY900 Key', provider: 'wj', adapterType: 'wj-video', baseUrl: baseUrls.wj, envKey: 'WJ_SD_PY_900_KEY' },
  { id: 'cntcn-main', label: 'CNTCN · 主 Key', provider: 'cntcn', adapterType: 'cntcn-video', baseUrl: baseUrls.cntcn, envKey: 'CNTCN_KEY' },
]);

// Historical IDs remain accepted by API clients and stored jobs.
export const SEEDANCE_ROUTE_MODEL_IDS = Object.freeze({ TEXT: 'seedance-2.0-text', IMAGE: 'seedance-2.0-img' });
const ROUTE_MODEL_ID_ALIASES = Object.freeze(Object.fromEntries([
  'seedance-2.0-text', 'seedance-2.0-img', 'seedance2.0_text', 'seedance2.0_img', 'seedance-2.0_text', 'seedance-2.0_img',
].map(id => [id, 'seedance-2.0'])));

const platformCapabilities = Object.freeze({
  'seedance-2.0': Object.freeze({ duration: 15, ratios: ['16:9', '9:16', '1:1'], image: 9, video: 3, audio: 3 }),
  'seedance-2.0-value': Object.freeze({ duration: 15, ratios: ['16:9', '9:16', '1:1'], image: 9, video: 3, audio: 3 }),
  'seedance-2.5-value': Object.freeze({ duration: 30, ratios: ['16:9', '9:16', '1:1'], image: 30, video: 10, audio: 10 }),
  'seedance-2.0-fast': Object.freeze({ duration: 15, ratios: ['16:9', '9:16', '1:1'], image: 9, video: 3, audio: 3 }),
  'seedance-2.5': Object.freeze({ duration: 30, ratios: ['16:9', '9:16', '1:1'], image: 30, video: 10, audio: 10 }),
});

const route = (id, logicalModelId, displayName, provider, adapterType, baseUrl, credentialId, upstreamModelId, quality, priority, costYuan, capabilities = {}) => ({
  id, logicalModelId, displayName, provider, adapterType, baseUrl, credentialId, upstreamModelId, quality,
  durationSeconds: platformCapabilities[logicalModelId].duration,
  priority,
  costFen: Math.round(Number(costYuan) * 100),
  capabilities: { ...platformCapabilities[logicalModelId], ...capabilities },
});

export const DEFAULT_MODEL_ROUTES = Object.freeze([
  route('sd20-480-diw-nd', 'seedance-2.0', 'DIW · ND 480p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'nd-seedance-2.0 480p', '480p', 1, 2.15),
  route('sd20-480-wj-select-value', 'seedance-2.0', 'WJ · Select Value 480p', 'wj', 'wj-video', baseUrls.wj, 'wj-tjwd', 'seedance2.0-select-value-480p', '480p', 2, 2.8, { ratios: ['16:9', '9:16'] }),
  route('sd20-480-diw-pd', 'seedance-2.0', 'DIW · PD 933 480p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'pd-seedance-2.0 480P 933', '480p', 3, 2.8),
  route('sd20-480-diw-ud', 'seedance-2.0', 'DIW · UD 480p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'ud-seedance 2.0-480p', '480p', 4, 2.5),
  route('sd20-480-wj-stable-full', 'seedance-2.0', 'WJ · Stable Full 480p', 'wj', 'wj-video', baseUrls.wj, 'wj-tjwd', 'seedance2.0-stable-full-480p', '480p', 5, 3.5),

  // CD accepts reference-driven generation only. Keep it out of text-mode
  // selection so the provider does not reject a valid text request later.
  route('sd20-720-diw-cd', 'seedance-2.0', 'DIW · CD 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'cd-seedance 2.0 720p', '720p', 1, 2, { minImage: 1 }),
  route('sd20-720-diw-md', 'seedance-2.0', 'DIW · MD 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'md-seedance-2.0-720p', '720p', 2, 2),
  route('sd20-720-diw-vd', 'seedance-2.0', 'DIW · VD 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'vd-seedance-2.0-720p', '720p', 3, 2.5),
  route('sd20-720-diw-ed', 'seedance-2.0', 'DIW · ED 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'ed-seedance 2.0 720p', '720p', 4, 3),
  route('sd20-720-diw-nd', 'seedance-2.0', 'DIW · ND 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'nd-seedance-2.0 720p', '720p', 5, 3.5),
  route('sd20-720-wj-py900', 'seedance-2.0', 'WJ · PY 900', 'wj', 'wj-video', baseUrls.wj, 'wj-py900', 'seedance2.0-900-3', '720p', 6, 1.8, { ratios: ['16:9', '9:16', '1:1'], image: 9, video: 0, audio: 0 }),
  route('sd20-720-wj-stable-900', 'seedance-2.0', 'WJ · Stable 900 720p', 'wj', 'wj-video', baseUrls.wj, 'wj-tjwd', 'seedance2.0-stable-900-720p', '720p', 7, 3.4, { ratios: ['16:9', '9:16'], image: 9, video: 0, audio: 0 }),
  route('sd20-720-wj-select-full', 'seedance-2.0', 'WJ · Select Full 720p', 'wj', 'wj-video', baseUrls.wj, 'wj-tjwd', 'seedance2.0-select-full-720p', '720p', 8, 3.5),
  route('sd20-720-diw-ud', 'seedance-2.0', 'DIW · UD 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'ud-seedance 2.0-720p', '720p', 9, 3.5),
  route('sd20-720-cntcn-c', 'seedance-2.0', 'CNTCN · 933 C', 'cntcn', 'cntcn-video', baseUrls.cntcn, 'cntcn-main', '933qudao-c', '720p', 10, 4.2),
  route('sd20-720-cntcn-e', 'seedance-2.0', 'CNTCN · 933 E', 'cntcn', 'cntcn-video', baseUrls.cntcn, 'cntcn-main', '933qudao-e', '720p', 11, 4.5),

  route('sd20-fast-720-diw-ed', 'seedance-2.0-fast', 'DIW · ED Fast 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'ed-seedance 2.0 fast 720p', '720p', 1, 1.5),

  route('sd25-480-diw-vd', 'seedance-2.5', 'DIW · VD 480p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'vd-seedance-2.5-480p', '480p', 1, 4.5),
  route('sd25-480-diw-yd', 'seedance-2.5', 'DIW · YD 480p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'yd-seedance-2.5-480p', '480p', 2, 13.5),
  route('sd25-480-wj-30s', 'seedance-2.5', 'WJ · Stable 30s 480p', 'wj', 'wj-video', baseUrls.wj, 'wj-tjwd', 'seedance2.5-stable-480p-30s', '480p', 3, 12),
  route('sd25-480-wj-stable', 'seedance-2.5', 'WJ · Stable 480p', 'wj', 'wj-video', baseUrls.wj, 'wj-tjwd', 'seedance2.5-stable-480p', '480p', 4, 16.8),

  route('sd25-720-diw-vd', 'seedance-2.5', 'DIW · VD 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'vd-seedance-2.5-720p', '720p', 1, 6),
  route('sd25-720-wj-facefree', 'seedance-2.5', 'WJ · Facefree 30s 720p', 'wj', 'wj-video', baseUrls.wj, 'wj-tjwd', 'seedance2.5-stable-max-facefree-30s-720p', '720p', 2, 17, { ratios: ['16:9', '9:16'] }),
  route('sd25-720-wj-stable-max', 'seedance-2.5', 'WJ · Stable Max 720p', 'wj', 'wj-video', baseUrls.wj, 'wj-tjwd', 'seedance2.5-stable-max-720p', '720p', 3, 23.1, { ratios: ['16:9', '9:16'] }),
  route('sd25-720-diw-yd', 'seedance-2.5', 'DIW · YD 720p', 'diw', 'diw-video', baseUrls.diw, 'diw-main', 'yd-seedance-2.5-720p', '720p', 4, 27),
]);

const defaultsById = new Map(DEFAULT_MODEL_ROUTES.map(item => [item.id, item]));

function publicRouteModelId(logicalModelId) {
  return normalizeRouteModelId(logicalModelId);
}

function modelRouteQualities(logicalModelId) {
  const supports1080p = ['seedance-2.0', 'seedance-2.5', 'seedance-2.0-value', 'seedance-2.5-value'].includes(publicRouteModelId(logicalModelId));
  return ROUTE_QUALITIES.filter(quality => quality !== '1080p' || supports1080p);
}

function normalizeRouteModelId(logicalModelId) {
  const requested = String(logicalModelId || '').trim().toLowerCase();
  return ROUTE_MODEL_ID_ALIASES[requested] || requested;
}

function credentialSecret() {
  // MEDIA_PROXY_SECRET is already a required server-side secret in deployed
  // environments; the dedicated variable is preferred for key isolation.
  return String(process.env[CREDENTIAL_SECRET_ENV] || process.env.MEDIA_PROXY_SECRET || '').trim();
}

function credentialCryptoKey() {
  const secret = credentialSecret();
  if (!secret) throw Object.assign(new Error(`未配置 ${CREDENTIAL_SECRET_ENV}，无法保存渠道 API Key`), { statusCode: 503 });
  return createHash('sha256').update(`gugu:model-route-credential:${secret}`).digest();
}

function encryptCredential(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialCryptoKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value)), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptCredential(value) {
  const [version, ivText, tagText, ciphertextText] = String(value || '').split(':');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', credentialCryptoKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function keyHint(value) {
  const key = String(value || '');
  return key ? `${'•'.repeat(Math.max(0, Math.min(12, key.length - 4)))}${key.slice(-4)}` : '';
}

function credentialFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, channelName: row.channel_name, label: row.label, provider: row.provider,
    adapterType: row.adapter_type, baseUrl: row.base_url, envKey: row.env_key || '',
    enabled: Boolean(row.enabled), version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at,
    configured: Boolean((row.api_key_ciphertext && decryptCredential(row.api_key_ciphertext)) || (row.env_key && process.env[row.env_key])),
    keyHint: row.api_key_hint || (row.env_key && process.env[row.env_key] ? keyHint(process.env[row.env_key]) : ''),
  };
}

function credentialRow(id) {
  return sql('SELECT * FROM model_route_credentials WHERE id = :id').get({ id });
}

export function routeCredential(credentialId, env = process.env) {
  const row = credentialRow(credentialId);
  if (row) {
    const stored = decryptCredential(row.api_key_ciphertext);
    if (stored) return stored.trim();
    return row.env_key ? String(env[row.env_key] || '').trim() : '';
  }
  const registry = {
    'diw-main': env.DIW_KEY,
    'wj-tjwd': env.WJ_TJWD_KEY,
    'wj-py900': env.WJ_SD_PY_900_KEY,
    'cntcn-main': env.CNTCN_KEY,
  };
  return String(registry[credentialId] || '').trim();
}

function now() { return new Date().toISOString(); }
function parseJson(value, fallback = null) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
// 成本（分） × 1.2 ÷ 0.1 元/积分 = 积分售价，再换算为 microcredits。
function saleMicroFromCostFen(costFen) { return Math.round(costFen * (10_000 + MARKUP_BASIS_POINTS) * CREDITS_PER_YUAN); }
function saleMicroFromFen(salePriceFen) { return Math.round(salePriceFen * 100_000); }

function channelById(id) {
  const row = credentialRow(id);
  if (row) return { id: row.id, label: `${row.channel_name} · ${row.label}`, provider: row.provider, adapterType: row.adapter_type, baseUrl: row.base_url, envKey: row.env_key || '' };
  return MODEL_ROUTE_CHANNELS.find(item => item.id === id) || null;
}

function requiredText(value, label, maxLength = 300) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) throw Object.assign(new Error(`${label}不能为空且不能超过 ${maxLength} 个字符`), { statusCode: 400 });
  return text;
}

function routeNumbers({ priority, costYuan, salePriceYuan }, { requireSalePrice = false } = {}) {
  const normalizedPriority = priority === undefined ? undefined : Number(priority);
  const normalizedCost = costYuan === undefined ? undefined : Number(costYuan);
  const normalizedSale = salePriceYuan === undefined || salePriceYuan === null || salePriceYuan === '' ? null : Number(salePriceYuan);
  if (normalizedPriority === undefined) throw Object.assign(new Error('优先级不能为空'), { statusCode: 400 });
  if (normalizedCost === undefined) throw Object.assign(new Error('成本价格不能为空'), { statusCode: 400 });
  if (normalizedPriority !== undefined && (!Number.isSafeInteger(normalizedPriority) || normalizedPriority < 1 || normalizedPriority > 1000)) throw Object.assign(new Error('优先级必须是 1–1000 的整数'), { statusCode: 400 });
  if (normalizedCost !== undefined && (!Number.isFinite(normalizedCost) || normalizedCost < 0 || normalizedCost > 100000)) throw Object.assign(new Error('成本价格无效'), { statusCode: 400 });
  if (requireSalePrice && normalizedSale === null) throw Object.assign(new Error('用户价格不能为空'), { statusCode: 400 });
  if (normalizedSale !== null && (!Number.isFinite(normalizedSale) || normalizedSale < 0 || normalizedSale > 100000)) throw Object.assign(new Error('用户价格无效'), { statusCode: 400 });
  return {
    priority: normalizedPriority,
    costYuan: normalizedCost,
    costFen: normalizedCost === undefined ? undefined : Math.round(normalizedCost * 100_000_000) / 1_000_000,
    salePriceYuan: normalizedSale,
    salePriceFen: normalizedSale === null ? null : Math.round(normalizedSale * 100_000_000) / 1_000_000,
  };
}

function normalizeDurations(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.trim().split(/[，,、\s]+/) : [];
  if (!values.length || values.some(item => !Number.isSafeInteger(Number(item)) || Number(item) <= 0 || Number(item) > 3600)) throw Object.assign(new Error('请填写 1～3600 之间的整数秒数，多个秒数用逗号分隔'), { statusCode: 400 });
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

function rowToRoute(row) {
  if (!row) return null;
  const fallback = defaultsById.get(row.id)?.capabilities || platformCapabilities[normalizeRouteModelId(row.logical_model_id)] || {};
  const details = parseJson(row.catalog_details_json, null);
  const liveCapabilities = details ? {
    duration: Array.isArray(details.durations_seconds) && details.durations_seconds.length ? null : undefined,
    durations: details.durations_seconds,
    ratios: details.ratios,
    image: details.max_images,
    video: details.max_videos,
    audio: details.max_audios,
    audioRequiresImage: details.audio_requires_image,
  } : null;
  const capabilities = { ...fallback };
  if (liveCapabilities) {
    if (Array.isArray(liveCapabilities.durations)) capabilities.durations = liveCapabilities.durations.map(Number);
    if (Array.isArray(liveCapabilities.ratios)) capabilities.ratios = fallback.ratios.filter(item => liveCapabilities.ratios.includes(item));
    for (const field of ['image', 'video', 'audio']) if (Number.isFinite(Number(liveCapabilities[field]))) capabilities[field] = Math.min(Number(fallback[field]), Number(liveCapabilities[field]));
    if (typeof liveCapabilities.audioRequiresImage === 'boolean') capabilities.audioRequiresImage = liveCapabilities.audioRequiresImage;
  }
  capabilities.durations = normalizeDurations(parseJson(row.durations_json, null) || (capabilities.durations?.length ? capabilities.durations : [row.duration_seconds]));
  const divisor = row.billing_unit === 'second' ? 1 : row.duration_seconds;
  const salePriceConfigured = row.sale_price_fen !== null && row.sale_price_fen !== undefined;
  const salePriceMicro = salePriceConfigured ? saleMicroFromFen(Number(row.sale_price_fen) / divisor) : saleMicroFromCostFen(row.cost_fen / divisor);
  const salePriceCredits = salePriceConfigured ? Number(row.sale_price_fen) / divisor / 10 : saleMicroFromCostFen(row.cost_fen) / divisor / 1_000_000;
  const salePriceYuan = salePriceConfigured ? Number(row.sale_price_fen) / divisor / 100 : salePriceCredits / CREDITS_PER_YUAN;
  return {
    id: row.id, logicalModelId: row.logical_model_id, routeModelId: row.logical_model_id,
    publicModelId: publicRouteModelId(row.logical_model_id),
    inputMode: '',
    displayName: row.display_name,
    provider: row.provider, adapterType: row.adapter_type, baseUrl: row.base_url,
    credentialId: row.credential_id, upstreamModelId: row.upstream_model_id,
    quality: row.quality, durationSeconds: row.duration_seconds, priority: row.priority,
    costFen: row.cost_fen / divisor, costYuan: row.cost_fen / divisor / 100,
    durations: capabilities.durations, billingUnit: 'second',
    salePriceConfigured, salePriceMicro, salePriceCredits, salePriceYuan,
    adminEnabled: Boolean(row.admin_enabled), catalogStatus: row.catalog_status,
    catalogMessage: row.catalog_message || '', catalogDetails: details,
    catalogCheckedAt: row.catalog_checked_at, consecutiveFailures: row.consecutive_failures,
    runtimeFailures: Number(row.runtime_failures || 0),
    autoDisabled: !row.admin_enabled && Boolean(row.auto_disabled_at),
    autoDisabledAt: row.auto_disabled_at || null, autoDisabledReason: row.auto_disabled_reason || '',
    version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at,
    capabilities,
  };
}

export function listModelRouteChannels() {
  const rows = sql('SELECT * FROM model_route_credentials ORDER BY channel_name, id').all();
  return rows.length ? rows.map(row => ({
    id: row.id, label: `${row.channel_name} · ${row.label}`, channelName: row.channel_name,
    provider: row.provider, adapterType: row.adapter_type, baseUrl: row.base_url, envKey: row.env_key || '',
    enabled: Boolean(row.enabled), configured: Boolean(routeCredential(row.id)), keyHint: credentialFromRow(row)?.keyHint || '', version: row.version,
  })) : MODEL_ROUTE_CHANNELS.map(item => ({ id: item.id, label: item.label, channelName: item.label.split(' · ')[0], provider: item.provider, adapterType: item.adapterType, baseUrl: item.baseUrl, envKey: item.envKey, enabled: true, configured: Boolean(routeCredential(item.id)), keyHint: keyHint(process.env[item.envKey]) }));
}

function normalizeHttpUrl(value) {
  const text = requiredText(value, 'API Base URL', 500).replace(/\/$/, '');
  let parsed;
  try { parsed = new URL(text); } catch { throw Object.assign(new Error('API Base URL 格式无效'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('API Base URL 必须使用 HTTP 或 HTTPS'), { statusCode: 400 });
  return text;
}

function credentialInput(input, { partial = false } = {}) {
  const result = {};
  if (!partial || input.channelName !== undefined) result.channelName = requiredText(input.channelName, '渠道名称', 100);
  if (!partial || input.label !== undefined) result.label = requiredText(input.label, 'Key 名称', 100);
  if (!partial || input.provider !== undefined) result.provider = requiredText(input.provider, 'Provider', 80).toLowerCase();
  if (!partial || input.adapterType !== undefined) {
    result.adapterType = requiredText(input.adapterType, '接口适配类型', 80);
    if (!['diw-video', 'wj-video', 'cntcn-video'].includes(result.adapterType)) throw Object.assign(new Error('接口适配类型暂不支持'), { statusCode: 400 });
  }
  if (!partial || input.baseUrl !== undefined) result.baseUrl = normalizeHttpUrl(input.baseUrl);
  if (!partial || input.enabled !== undefined) {
    result.enabled = input.enabled === undefined ? true : input.enabled;
    if (typeof result.enabled !== 'boolean') throw Object.assign(new Error('启用状态无效'), { statusCode: 400 });
  }
  if (!partial || input.apiKey !== undefined) {
    const key = String(input.apiKey ?? '').trim();
    if (!partial && !key) throw Object.assign(new Error('API Key 不能为空'), { statusCode: 400 });
    if (key) { if (key.length > 2000) throw Object.assign(new Error('API Key 过长'), { statusCode: 400 }); result.apiKey = key; }
  }
  return result;
}

export function createModelRouteCredential(input, { actorUserId, audit = {} } = {}) {
  return tx(() => {
    const values = credentialInput(input);
    const id = `credential-${randomUUID()}`;
    const updatedAt = now();
    sql(`INSERT INTO model_route_credentials(id, channel_name, label, provider, adapter_type, base_url, api_key_ciphertext, api_key_hint, enabled, updated_by, updated_at)
      VALUES(:id, :channelName, :label, :provider, :adapterType, :baseUrl, :ciphertext, :hint, :enabled, :actorUserId, :updatedAt)`).run({
      id, channelName: values.channelName, label: values.label, provider: values.provider, adapterType: values.adapterType,
      baseUrl: values.baseUrl, ciphertext: encryptCredential(values.apiKey), hint: keyHint(values.apiKey), enabled: values.enabled ? 1 : 0, actorUserId: actorUserId || null, updatedAt,
    });
    const after = credentialFromRow(credentialRow(id));
    appendAuditEvent({ actorUserId, action: 'model_route_credential.create', targetType: 'model_route_credential', targetId: id, after, ...audit });
    return after;
  });
}

export function updateModelRouteCredential(id, patch, { actorUserId, expectedVersion = null, audit = {} } = {}) {
  return tx(() => {
    const beforeRow = credentialRow(id);
    if (!beforeRow) throw Object.assign(new Error('渠道 Key 不存在'), { statusCode: 404 });
    if (expectedVersion !== null && Number(expectedVersion) !== beforeRow.version) throw Object.assign(new Error('渠道 Key 已被其他管理员修改，请刷新后重试'), { statusCode: 409 });
    const values = credentialInput(patch, { partial: true });
    const merged = {
      channelName: values.channelName ?? beforeRow.channel_name, label: values.label ?? beforeRow.label,
      provider: values.provider ?? beforeRow.provider, adapterType: values.adapterType ?? beforeRow.adapter_type,
      baseUrl: values.baseUrl ?? beforeRow.base_url, enabled: values.enabled ?? Boolean(beforeRow.enabled),
    };
    const changedConnection = merged.baseUrl !== beforeRow.base_url || merged.provider !== beforeRow.provider || merged.adapterType !== beforeRow.adapter_type;
    const ciphertext = values.apiKey ? encryptCredential(values.apiKey) : beforeRow.api_key_ciphertext;
    const hint = values.apiKey ? keyHint(values.apiKey) : beforeRow.api_key_hint;
    const updatedAt = now();
    sql(`UPDATE model_route_credentials SET channel_name=:channelName, label=:label, provider=:provider, adapter_type=:adapterType, base_url=:baseUrl,
      api_key_ciphertext=:ciphertext, api_key_hint=:hint, enabled=:enabled, version=version+1, updated_by=:actorUserId, updated_at=:updatedAt WHERE id=:id`).run({
      id, ...merged, ciphertext, hint, enabled: merged.enabled ? 1 : 0, actorUserId: actorUserId || null, updatedAt,
    });
    if (changedConnection) sql(`UPDATE model_routes SET provider=:provider, adapter_type=:adapterType, base_url=:baseUrl, catalog_status='unknown', catalog_message=NULL, catalog_details_json=NULL, catalog_checked_at=NULL, consecutive_failures=0, version=version+1, updated_at=:updatedAt WHERE credential_id=:id`).run({ id, provider: merged.provider, adapterType: merged.adapterType, baseUrl: merged.baseUrl, updatedAt });
    const after = credentialFromRow(credentialRow(id));
    appendAuditEvent({ actorUserId, action: 'model_route_credential.update', targetType: 'model_route_credential', targetId: id, before: credentialFromRow(beforeRow), after, ...audit });
    return after;
  });
}

function consolidateSeedanceRoutes(updatedAt) {
  const rows = sql("SELECT * FROM model_routes WHERE logical_model_id LIKE 'seedance%' ORDER BY updated_by IS NOT NULL DESC, updated_at DESC, version DESC, priority, id").all();
  const retained = new Map();
  const replacements = new Map();
  const changedPools = new Set();
  for (const row of rows) {
    const modelId = normalizeRouteModelId(row.logical_model_id);
    const pool = `${modelId}:${row.quality}`;
    const key = JSON.stringify([modelId, row.quality, row.credential_id, row.upstream_model_id]);
    const existing = retained.get(key);
    if (existing) {
      replacements.set(row.id, existing.id);
      changedPools.add(pool);
    } else {
      retained.set(key, row);
    }
    if (modelId !== row.logical_model_id) {
      changedPools.add(pool);
      sql('UPDATE model_routes SET logical_model_id=:modelId, version=version+1, updated_at=:updatedAt WHERE id=:id').run({ modelId, updatedAt, id: row.id });
    }
  }
  // Redirect foreign keys before removing duplicates. Keep their configuration
  // in the audit log and tombstone default IDs so startup cannot restore them.
  for (const [id, retainedId] of replacements) {
    sql('UPDATE model_route_policies SET forced_route_id=:retainedId, version=version+1, updated_at=:updatedAt WHERE forced_route_id=:id').run({ id, retainedId, updatedAt });
    appendAuditEvent({ action: 'model_route.consolidate', targetType: 'model_route', targetId: id, before: rows.find(row => row.id === id), after: { retainedId } });
    sql('INSERT INTO deleted_model_routes(id, deleted_at) VALUES(:id, :updatedAt) ON CONFLICT(id) DO NOTHING').run({ id, updatedAt });
    sql('DELETE FROM model_routes WHERE id=:id').run({ id });
  }
  const policies = sql("SELECT * FROM model_route_policies WHERE logical_model_id LIKE 'seedance%' ORDER BY updated_at DESC, version DESC, logical_model_id").all();
  for (const quality of ROUTE_QUALITIES) {
    const candidates = policies.filter(row => normalizeRouteModelId(row.logical_model_id) === 'seedance-2.0' && row.quality === quality);
    const legacy = candidates.filter(row => row.logical_model_id !== 'seedance-2.0');
    if (!legacy.length) continue;
    const selected = candidates.find(row => row.forced_route_id) || candidates[0];
    sql(`INSERT INTO model_route_policies(logical_model_id, quality, forced_route_id, version, updated_by, updated_at)
      VALUES('seedance-2.0', :quality, :forcedRouteId, :version, :updatedBy, :updatedAt)
      ON CONFLICT(logical_model_id, quality) DO UPDATE SET forced_route_id=excluded.forced_route_id, version=excluded.version, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run({ quality, forcedRouteId: selected.forced_route_id, version: Math.max(...candidates.map(row => row.version)) + 1, updatedBy: selected.updated_by, updatedAt });
    for (const row of legacy) {
      appendAuditEvent({ action: 'model_route_policy.consolidate', targetType: 'model', targetId: `${row.logical_model_id}:${quality}`, before: row, after: { logicalModelId: 'seedance-2.0' } });
      sql('DELETE FROM model_route_policies WHERE logical_model_id=:modelId AND quality=:quality').run({ modelId: row.logical_model_id, quality });
    }
  }
  for (const pool of changedPools) {
    const [modelId, quality] = pool.split(':');
    const routes = sql('SELECT id, priority FROM model_routes WHERE logical_model_id=:modelId AND quality=:quality ORDER BY priority, id').all({ modelId, quality });
    routes.forEach((row, index) => {
      if (row.priority !== index + 1) sql('UPDATE model_routes SET priority=:priority, version=version+1, updated_at=:updatedAt WHERE id=:id').run({ id: row.id, priority: index + 1, updatedAt });
    });
  }
}

export function consolidateSeedanceModelRoutes() {
  return tx(() => consolidateSeedanceRoutes(now()));
}

export function ensureDefaultModelRoutes() {
  const credentialInsert = sql(`INSERT INTO model_route_credentials(id, channel_name, label, provider, adapter_type, base_url, env_key, enabled, updated_at)
    VALUES(:id, :channelName, :label, :provider, :adapterType, :baseUrl, :envKey, 1, :updatedAt)
    ON CONFLICT(id) DO NOTHING`);
  const insert = sql(`INSERT INTO model_routes(id, logical_model_id, display_name, provider, adapter_type, base_url, credential_id, upstream_model_id, quality, duration_seconds, priority, cost_fen, admin_enabled, catalog_status, updated_at)
    VALUES(:id, :logicalModelId, :displayName, :provider, :adapterType, :baseUrl, :credentialId, :upstreamModelId, :quality, :durationSeconds, :priority, :costFen, 1, 'unknown', :updatedAt)
    ON CONFLICT(id) DO NOTHING`);
  const createdAt = now();
  tx(() => {
    for (const item of MODEL_ROUTE_CHANNELS) credentialInsert.run({ id: item.id, channelName: item.label.split(' · ')[0], label: item.label.split(' · ').slice(1).join(' · ') || item.label, provider: item.provider, adapterType: item.adapterType, baseUrl: item.baseUrl, envKey: item.envKey, updatedAt: createdAt });
    for (const item of DEFAULT_MODEL_ROUTES.filter(item => !sql('SELECT id FROM deleted_model_routes WHERE id = :id').get({ id: item.id }))) insert.run({
      id: item.id, logicalModelId: item.logicalModelId, displayName: item.displayName,
      provider: item.provider, adapterType: item.adapterType, baseUrl: item.baseUrl,
      credentialId: item.credentialId, upstreamModelId: item.upstreamModelId,
      quality: item.quality, durationSeconds: item.durationSeconds, priority: item.priority,
      costFen: item.costFen, updatedAt: createdAt,
    });
    consolidateSeedanceRoutes(createdAt);
    for (const logicalModelId of Object.keys(platformCapabilities)) for (const quality of modelRouteQualities(logicalModelId)) {
      sql(`INSERT INTO model_route_policies(logical_model_id, quality, forced_route_id, version, updated_at) VALUES(:logicalModelId, :quality, NULL, 1, :updatedAt) ON CONFLICT(logical_model_id, quality) DO NOTHING`).run({ logicalModelId, quality, updatedAt: createdAt });
    }
  });
}

export function listModelRoutes() {
  return sql('SELECT * FROM model_routes ORDER BY logical_model_id, quality, priority, id').all().map(rowToRoute);
}

export function modelRoute(id) { return rowToRoute(sql('SELECT * FROM model_routes WHERE id = :id').get({ id })); }

// Keeps priorities unique inside one (model pool, quality) group: the route
// being created or edited takes the requested priority and the others make
// room. Must run inside the caller's transaction.
function shiftRoutePriorities({ logicalModelId, quality, excludeId, from, to, actorUserId, updatedAt }) {
  const siblings = sql('SELECT id, priority FROM model_routes WHERE logical_model_id = :logicalModelId AND quality = :quality AND id <> :excludeId')
    .all({ logicalModelId, quality, excludeId })
    .map(row => ({ id: row.id, order: row.priority }));
  const reordered = planSortOrderShift(siblings, { from, to, max: 1000 });
  const shift = sql('UPDATE model_routes SET priority = :priority, version = version + 1, updated_by = :actorUserId, updated_at = :updatedAt WHERE id = :id');
  for (const item of reordered) shift.run({ id: item.id, priority: item.to, actorUserId: actorUserId || null, updatedAt });
  return reordered;
}

export function createModelRoute({ logicalModelId, quality, credentialId, upstreamModelId, priority, costYuan, salePriceYuan, adminEnabled = true, displayName = '', durations }, { actorUserId, audit = {} } = {}) {
  return tx(() => {
    const logicalId = normalizeRouteModelId(logicalModelId);
    if (!platformCapabilities[logicalId]) throw Object.assign(new Error('模型类型不支持新增调用线路'), { statusCode: 400 });
    const normalizedQuality = String(quality || '');
    if (!modelRouteQualities(logicalId).includes(normalizedQuality)) throw Object.assign(new Error('分辨率无效'), { statusCode: 400 });
    const channelId = requiredText(credentialId, '渠道');
    const channel = channelById(channelId);
    if (!channel) throw Object.assign(new Error('所选渠道不存在'), { statusCode: 400 });
    const upstream = requiredText(upstreamModelId, '上游模型 ID');
    const numbers = routeNumbers({ priority, costYuan, salePriceYuan }, { requireSalePrice: true });
    if (typeof adminEnabled !== 'boolean') throw Object.assign(new Error('启用状态无效'), { statusCode: 400 });
    const duplicate = sql(`SELECT id FROM model_routes WHERE logical_model_id=:logicalModelId AND quality=:quality AND credential_id=:credentialId AND upstream_model_id=:upstreamModelId`).get({ logicalModelId: logicalId, quality: normalizedQuality, credentialId: channel.id, upstreamModelId: upstream });
    if (duplicate) throw Object.assign(new Error('该渠道已经配置了相同的上游模型 ID'), { statusCode: 409 });
    const id = `route-${randomUUID()}`;
    const updatedAt = now();
    const label = requiredText(displayName || `${channel.label} · ${upstream}`, '线路名称', 200);
    const reordered = shiftRoutePriorities({ logicalModelId: logicalId, quality: normalizedQuality, excludeId: id, from: null, to: numbers.priority, actorUserId, updatedAt });
    sql(`INSERT INTO model_routes(id, logical_model_id, display_name, provider, adapter_type, base_url, credential_id, upstream_model_id, quality, duration_seconds, priority, cost_fen, sale_price_fen, admin_enabled, catalog_status, updated_by, updated_at)
         VALUES(:id, :logicalModelId, :displayName, :provider, :adapterType, :baseUrl, :credentialId, :upstreamModelId, :quality, :durationSeconds, :priority, :costFen, :salePriceFen, :adminEnabled, 'unknown', :actorUserId, :updatedAt)`).run({ id, logicalModelId: logicalId, displayName: label, provider: channel.provider, adapterType: channel.adapterType, baseUrl: channel.baseUrl, credentialId: channel.id, upstreamModelId: upstream, quality: normalizedQuality, durationSeconds: platformCapabilities[logicalId].duration, priority: numbers.priority, costFen: numbers.costFen, salePriceFen: numbers.salePriceFen, adminEnabled: adminEnabled ? 1 : 0, actorUserId: actorUserId || null, updatedAt });
    const durationOptions = normalizeDurations(durations === undefined ? [platformCapabilities[logicalId].duration] : durations);
    sql("UPDATE model_routes SET durations_json=:durations, billing_unit='second' WHERE id=:id").run({ id, durations: JSON.stringify(durationOptions) });
    const after = modelRoute(id);
    appendAuditEvent({ actorUserId, action: 'model_route.create', targetType: 'model_route', targetId: id, after, metadata: reordered.length ? { reordered } : null, ...audit });
    return after;
  });
}

export function routePolicy(logicalModelId, quality) {
  const normalizedModelId = normalizeRouteModelId(logicalModelId);
  const row = sql('SELECT * FROM model_route_policies WHERE logical_model_id = :logicalModelId AND quality = :quality').get({ logicalModelId: normalizedModelId, quality });
  return row ? { logicalModelId: row.logical_model_id, quality: row.quality, forcedRouteId: row.forced_route_id || '', version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at } : null;
}

export function listRoutePolicies() {
  return sql('SELECT * FROM model_route_policies ORDER BY logical_model_id, quality').all().map(row => ({
    logicalModelId: row.logical_model_id,
    quality: row.quality,
    forcedRouteId: row.forced_route_id || '',
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }));
}

function routeUsable(route, request = {}) {
  const credential = credentialRow(route.credentialId);
  if (!route.adminEnabled || (credential && !credential.enabled) || !routeCredential(route.credentialId)) return false;
  if (route.catalogStatus === 'missing' || route.catalogStatus === 'credential_error') return false;
  if (route.catalogStatus === 'probe_error' && route.consecutiveFailures >= 2) return false;
  const caps = route.capabilities || {};
  if (request.duration && Array.isArray(caps.durations) && !caps.durations.includes(Number(request.duration))) return false;
  if (request.duration && !caps.durations && Number(request.duration) !== Number(route.durationSeconds)) return false;
  if (request.aspectRatio && Array.isArray(caps.ratios) && !caps.ratios.includes(request.aspectRatio)) return false;
  const counts = request.referenceCounts || {};
  if (Number(counts.image || 0) < Number(caps.minImage || 0)) return false;
  if (Number(counts.image || 0) > Number(caps.image || 0) || Number(counts.video || 0) > Number(caps.video || 0) || Number(counts.audio || 0) > Number(caps.audio || 0)) return false;
  if (caps.audioRequiresImage && Number(counts.audio || 0) && !Number(counts.image || 0)) return false;
  return true;
}

export function selectModelRoute({ logicalModelId, quality, duration, aspectRatio, referenceCounts = {}, excludeRouteIds = [], afterPriority, availableOnly = false }) {
  const routeModelId = normalizeRouteModelId(logicalModelId);
  const routes = listModelRoutes().filter(item => item.logicalModelId === routeModelId && item.quality === quality && (!availableOnly || item.catalogStatus === 'available'));
  const policy = routePolicy(routeModelId, quality);
  const ordered = policy?.forcedRouteId
    ? [...routes.filter(item => item.id === policy.forcedRouteId), ...routes.filter(item => item.id !== policy.forcedRouteId)]
    : routes;
  const excluded = new Set(excludeRouteIds);
  const isFallback = excluded.size > 0 || Number.isFinite(afterPriority);
  // Older persisted jobs do not have a priority snapshot. In that case use
  // the current priority of their previous channel instead of returning to it
  // or selecting a higher-priority channel as a fallback.
  const previousPriority = Number.isFinite(afterPriority) ? afterPriority
    : Math.max(...routes.filter(item => excluded.has(item.id)).map(item => item.priority));
  const candidates = isFallback ? routes : ordered;
  const selected = candidates.find(item => !excluded.has(item.id)
    && (!Number.isFinite(previousPriority) || item.priority > previousPriority)
    && routeUsable(item, { aspectRatio, referenceCounts, ...(isFallback ? { duration } : {}) }));
  return selected && (!duration || selected.durations.includes(Number(duration))) ? selected : null;
}

export function availableModelRouteQualities(logicalModelId, { referenceCounts = {}, aspectRatios = ['16:9', '9:16', '1:1'] } = {}) {
  const duration = platformCapabilities[logicalModelId]?.duration;
  if (!duration) return [];
  return ROUTE_QUALITIES.filter(quality => aspectRatios.some(aspectRatio =>
    selectModelRoute({ logicalModelId, quality, aspectRatio, referenceCounts })));
}

export function modelRouteCharge(route, duration) {
  const seconds = Number(duration);
  if (!route.durations.includes(seconds)) throw Object.assign(new Error('当前模型不支持所选时长，请重新选择'), { statusCode: 400 });
  const totalMicro = Math.round(route.salePriceCredits * seconds * 1_000_000);
  return { billingUnit:'second', quantity:seconds, unitPriceMicro:route.salePriceMicro, unitPrice:route.salePriceCredits, totalMicro, total:totalMicro / 1_000_000, unitCostYuan:route.costYuan, costYuan:Number((route.costYuan * seconds).toFixed(8)), salePriceYuan:totalMicro / 10_000_000 };
}

// Customer-facing price checks must not reveal route IDs or route versions.
// Keep the token deterministic so a quote can be verified on submit while
// remaining opaque outside the route selector.
export function publicRoutePriceVersion(route) {
  if (!route?.id || !Number.isFinite(Number(route.version))) return '';
  return `v1-${createHash('sha256').update(`gugu-route-price:${route.id}:${route.version}`).digest('hex').slice(0, 32)}`;
}

export function publicModelPrices() {
  const publicModelIds = Object.keys(platformCapabilities);
  return publicModelIds.flatMap(logicalModelId => modelRouteQualities(logicalModelId).map(quality => {
    const route = selectModelRoute({ logicalModelId, quality, aspectRatio: '16:9', referenceCounts: {}, availableOnly:true });
    const label = { 'seedance-2.0-value': 'Seedance 2.0 特价', 'seedance-2.5-value': 'Seedance 2.5 特价', 'seedance-2.0': 'Seedance 2.0', 'seedance-2.0-fast': 'Seedance 2.0 Fast', 'seedance-2.5': 'Seedance 2.5' }[logicalModelId] || logicalModelId;
    return { modelId: logicalModelId, label, quality, duration: route?.durations[0] || platformCapabilities[logicalModelId].duration, unit: 'second', available: Boolean(route), credits: route?.salePriceCredits ?? null, yuan: route?.salePriceYuan ?? null, selectedRouteId: route?.id || '', selectedRouteName: route?.displayName || '', priceVersion: publicRoutePriceVersion(route) };
  }));
}

export function deleteModelRoute(id, { actorUserId, expectedVersion = null, audit = {} } = {}) {
  return tx(() => {
    const before = modelRoute(id);
    if (!before) throw Object.assign(new Error('调用线路不存在'), { statusCode: 404 });
    if (expectedVersion === null || Number(expectedVersion) !== before.version) throw Object.assign(new Error('线路配置已被其他管理员修改，请刷新后重试'), { statusCode: 409 });
    const updatedAt = now();
    sql(`UPDATE model_route_policies SET forced_route_id=NULL, version=version+1, updated_by=:actorUserId, updated_at=:updatedAt WHERE forced_route_id=:id`).run({ id, actorUserId: actorUserId || null, updatedAt });
    sql('INSERT INTO deleted_model_routes(id, deleted_at) VALUES(:id, :updatedAt)').run({ id, updatedAt });
    sql('DELETE FROM model_routes WHERE id=:id').run({ id });
    appendAuditEvent({ actorUserId, action: 'model_route.delete', targetType: 'model_route', targetId: id, before, after: null, ...audit });
    return { id };
  });
}

export function updateModelRoute(id, patch, { actorUserId, expectedVersion = null, audit = {} } = {}) {
  return tx(() => {
    const before = modelRoute(id);
    if (!before) throw Object.assign(new Error('调用线路不存在'), { statusCode: 404 });
    if (expectedVersion !== null && Number(expectedVersion) !== before.version) throw Object.assign(new Error('线路配置已被其他管理员修改，请刷新后重试'), { statusCode: 409 });
    const logicalModelId = normalizeRouteModelId(patch.logicalModelId ?? before.logicalModelId);
    if (!platformCapabilities[logicalModelId]) throw Object.assign(new Error('模型类型不支持'), { statusCode: 400 });
    if (!modelRouteQualities(logicalModelId).includes(before.quality)) throw Object.assign(new Error('分辨率无效'), { statusCode: 400 });
    const adminEnabled = patch.adminEnabled === undefined ? before.adminEnabled : patch.adminEnabled;
    const credentialId = patch.credentialId === undefined ? before.credentialId : requiredText(patch.credentialId, '渠道');
    const channel = channelById(credentialId);
    if (!channel) throw Object.assign(new Error('所选渠道不存在'), { statusCode: 400 });
    const upstreamModelId = patch.upstreamModelId === undefined ? before.upstreamModelId : requiredText(patch.upstreamModelId, '上游模型 ID');
    const numbers = routeNumbers({ priority: patch.priority === undefined ? before.priority : patch.priority, costYuan: patch.costYuan === undefined ? before.costYuan : patch.costYuan, salePriceYuan: patch.salePriceYuan === undefined ? (before.salePriceConfigured ? before.salePriceYuan : null) : patch.salePriceYuan });
    const keepAutomaticSalePrice = patch.salePriceYuan === undefined && !before.salePriceConfigured;
    if (typeof adminEnabled !== 'boolean') throw Object.assign(new Error('启用状态无效'), { statusCode: 400 });
    if ((logicalModelId !== before.logicalModelId || credentialId !== before.credentialId || upstreamModelId !== before.upstreamModelId) && sql(`SELECT id FROM model_routes WHERE logical_model_id=:logicalModelId AND quality=:quality AND credential_id=:credentialId AND upstream_model_id=:upstreamModelId AND id <> :id`).get({ logicalModelId, quality: before.quality, credentialId, upstreamModelId, id })) throw Object.assign(new Error('该渠道已经配置了相同的上游模型 ID'), { statusCode: 409 });
    const identityChanged = logicalModelId !== before.logicalModelId || credentialId !== before.credentialId || upstreamModelId !== before.upstreamModelId;
    const updatedAt = now();
    // Moving to another pool counts as joining it; otherwise only a changed
    // priority makes the other routes of the same pool make room.
    const joinsNewGroup = logicalModelId !== before.logicalModelId;
    const reordered = joinsNewGroup || numbers.priority !== before.priority
      ? shiftRoutePriorities({ logicalModelId, quality: before.quality, excludeId: id, from: joinsNewGroup ? null : before.priority, to: numbers.priority, actorUserId, updatedAt })
      : [];
    sql(`UPDATE model_routes SET logical_model_id=:logicalModelId, duration_seconds=:durationSeconds, provider=:provider, adapter_type=:adapterType, base_url=:baseUrl, credential_id=:credentialId, upstream_model_id=:upstreamModelId, admin_enabled=:adminEnabled, priority=:priority, cost_fen=:costFen, sale_price_fen=:salePriceFen, catalog_status=CASE WHEN :identityChanged THEN 'unknown' ELSE catalog_status END, catalog_message=CASE WHEN :identityChanged THEN NULL ELSE catalog_message END, catalog_details_json=CASE WHEN :identityChanged THEN NULL ELSE catalog_details_json END, catalog_checked_at=CASE WHEN :identityChanged THEN NULL ELSE catalog_checked_at END, consecutive_failures=CASE WHEN :identityChanged THEN 0 ELSE consecutive_failures END, runtime_failures=CASE WHEN :identityChanged OR :reenabled THEN 0 ELSE runtime_failures END, auto_disabled_at=CASE WHEN :adminEnabled THEN NULL ELSE auto_disabled_at END, auto_disabled_reason=CASE WHEN :adminEnabled THEN NULL ELSE auto_disabled_reason END, version=version+1, updated_by=:actorUserId, updated_at=:updatedAt WHERE id=:id`).run({ id, logicalModelId, durationSeconds: platformCapabilities[logicalModelId].duration, provider: channel.provider, adapterType: channel.adapterType, baseUrl: channel.baseUrl, credentialId, upstreamModelId, adminEnabled: adminEnabled ? 1 : 0, priority: numbers.priority, costFen: numbers.costFen, salePriceFen: keepAutomaticSalePrice ? null : numbers.salePriceFen, identityChanged: identityChanged ? 1 : 0, reenabled: !before.adminEnabled && adminEnabled ? 1 : 0, actorUserId: actorUserId || null, updatedAt });
    const durationOptions = normalizeDurations(patch.durations === undefined ? before.durations : patch.durations);
    sql("UPDATE model_routes SET durations_json=:durations, billing_unit='second' WHERE id=:id").run({ id, durations: JSON.stringify(durationOptions) });
    const after = modelRoute(id);
    appendAuditEvent({ actorUserId, action: 'model_route.update', targetType: 'model_route', targetId: id, before, after, metadata: reordered.length ? { reordered } : null, ...audit });
    return after;
  });
}

export function updateRoutePolicy(logicalModelId, quality, forcedRouteId, { actorUserId, expectedVersion = null, audit = {} } = {}) {
  return tx(() => {
    const normalizedModelId = normalizeRouteModelId(logicalModelId);
    const before = routePolicy(normalizedModelId, quality);
    if (!before) throw Object.assign(new Error('路由策略不存在'), { statusCode: 404 });
    if (expectedVersion !== null && Number(expectedVersion) !== before.version) throw Object.assign(new Error('路由策略已被其他管理员修改，请刷新后重试'), { statusCode: 409 });
    const value = String(forcedRouteId || '');
    if (value) {
      const selected = modelRoute(value);
      if (!selected || selected.logicalModelId !== normalizedModelId || selected.quality !== quality) throw Object.assign(new Error('所选线路不属于当前模型和分辨率'), { statusCode: 400 });
    }
    sql(`UPDATE model_route_policies SET forced_route_id=:forcedRouteId, version=version+1, updated_by=:actorUserId, updated_at=:updatedAt WHERE logical_model_id=:logicalModelId AND quality=:quality`).run({ logicalModelId: normalizedModelId, quality, forcedRouteId: value || null, actorUserId: actorUserId || null, updatedAt: now() });
    const after = routePolicy(normalizedModelId, quality);
    appendAuditEvent({ actorUserId, action: 'model_route.update_policy', targetType: 'model', targetId: `${normalizedModelId}:${quality}`, before, after, ...audit });
    return after;
  });
}

function modelsUrl(baseUrl) { return /\/v1$/i.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`; }
function modelList(value) { return Array.isArray(value?.data) ? value.data : Array.isArray(value?.models) ? value.models : Array.isArray(value) ? value : []; }

async function fetchCatalog(baseUrl, key, fetchImpl = fetch) {
  const response = await fetchImpl(modelsUrl(baseUrl), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = { raw: text }; }
  if (!response.ok) throw Object.assign(new Error(String(value?.error?.message || value?.message || text).slice(0, 240) || `HTTP ${response.status}`), { status: response.status });
  return modelList(value);
}

export async function checkModelRoutes({ routeIds = null, fetchImpl = fetch } = {}) {
  const selected = listModelRoutes().filter(item => !routeIds || routeIds.includes(item.id));
  const groups = new Map();
  for (const item of selected) {
    const key = `${item.baseUrl}\n${item.credentialId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const checkedAt = now();
  const results = [];
  for (const routes of groups.values()) {
    const key = routeCredential(routes[0].credentialId);
    if (!key) {
      for (const item of routes) results.push(updateCatalogState(item, { status: 'credential_error', message: 'API Key 尚未配置', checkedAt }));
      continue;
    }
    try {
      const catalog = await fetchCatalog(routes[0].baseUrl, key, fetchImpl);
      const records = new Map(catalog.map(item => [String(typeof item === 'string' ? item : item?.id || item?.model || item?.name), item]));
      for (const item of routes) {
        const record = records.get(item.upstreamModelId);
        results.push(updateCatalogState(item, record
          ? { status: 'available', message: '', details: typeof record === 'string' ? { id: record } : record, checkedAt }
          : { status: 'missing', message: '当前 API Key 的模型目录中不存在该模型', checkedAt }));
      }
    } catch (error) {
      const status = [401, 403].includes(Number(error.status)) ? 'credential_error' : 'probe_error';
      for (const item of routes) results.push(updateCatalogState(item, { status, message: error.message, checkedAt }));
    }
  }
  return results;
}

function updateCatalogState(before, { status, message, details = null, checkedAt }) {
  const failures = status === 'probe_error' ? before.consecutiveFailures + 1 : 0;
  sql(`UPDATE model_routes SET catalog_status=:status, catalog_message=:message, catalog_details_json=:details, catalog_checked_at=:checkedAt, consecutive_failures=:failures, updated_at=:checkedAt WHERE id=:id`).run({ id: before.id, status, message: String(message || '').slice(0, 500), details: details ? JSON.stringify(details) : null, checkedAt, failures });
  const after = modelRoute(before.id);
  if (before.catalogStatus !== after.catalogStatus) appendSystemEvent({ level: status === 'available' ? 'info' : 'warning', category: 'model_route.catalog_status', modelId: after.logicalModelId, message: `${after.displayName}：${status}`, details: { routeId: after.id, before: before.catalogStatus, after: status, catalogMessage: after.catalogMessage } });
  return after;
}

let monitor = null;
export function startModelRouteMonitor() {
  if (monitor || process.env.NODE_ENV === 'test') return monitor;
  setTimeout(() => checkModelRoutes().catch(error => console.error('[model-routes] initial check failed', error.message)), 250).unref();
  monitor = setInterval(() => checkModelRoutes().catch(error => console.error('[model-routes] scheduled check failed', error.message)), CHECK_INTERVAL_MS);
  monitor.unref();
  return monitor;
}

export const __test = { saleMicroFromCostFen, routeUsable, fetchCatalog, platformCapabilities };
