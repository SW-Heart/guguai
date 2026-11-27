import { modelLogoUrl } from './components/model-logo.js?v=13';

// Price cards are rendered by the server for the first paint (and for search engines),
// then refreshed in the browser from the same live price list.
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
export const formatNumber = (value, digits = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
// The server passes Asia/Shanghai; browsers show their own local time.
export const formatDateTime = (value, timeZone = undefined) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
};
const units = { request: '次', second: '秒', ten_thousand_characters: '万字' };
export const unitText = unit => units[unit] || '次';

const iconMarkup = (modelId, kind = '') => {
  // Speech models are MiniMax voices.
  const logo = modelLogoUrl(modelId, kind === 'audio' ? 'minimax' : '');
  if (logo) return `<img src="${logo}" alt="" width="22" height="22" decoding="async">`;
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="M12 7v5l3.5 2"/></svg>';
};
const modelInitial = label => escapeHtml(String(label || 'AI').trim().slice(0, 1).toUpperCase());
const isValueModel = label => /特价/.test(String(label || ''));

const renderCard = (model, rows, description = '') => {
  const rowHtml = rows.map(item => {
    const unit = unitText(item.unit);
    const hasDuration = item.duration !== null && item.duration !== undefined && Number.isFinite(Number(item.duration));
    const duration = hasDuration ? Number(item.duration) : null;
    const maxDuration = hasDuration && Number(item.maxDuration) > duration ? Number(item.maxDuration) : duration;
    const range = (min, max, digits) => min === max ? formatNumber(min, digits) : `${formatNumber(min, digits)}–${formatNumber(max, digits)}`;
    const durationText = hasDuration ? `${range(duration, maxDuration, 0)} 秒视频` : `按${unit}计费`;
    const total = hasDuration && item.unit === 'second' && Number.isFinite(Number(item.yuan)) ? ` · ${range(Number(item.yuan) * duration, Number(item.yuan) * maxDuration)} 元 / ${range(duration, maxDuration, 0)} 秒` : '';
    return `<div class="price-row"><div class="price-row-label"><b>${escapeHtml(item.quality || '标准')}</b><small>${durationText}${total}</small></div><div class="price-row-value"><strong>¥${formatNumber(item.yuan)}<span>/ ${unit}</span></strong><small>${formatNumber(item.credits, 2)} 积分 / ${unit}</small></div></div>`;
  }).join('');
  const modelLabel = model?.label || rows[0]?.label || rows[0]?.modelId || '未命名模型';
  const badge = isValueModel(modelLabel) ? '特价' : '当前可用';
  return `<article class="price-card"><header class="price-card-head"><div class="price-card-title"><span class="price-model-icon">${iconMarkup(rows[0]?.modelId, rows[0]?.kind)}<span hidden>${modelInitial(modelLabel)}</span></span><div><h2>${escapeHtml(modelLabel)}</h2><p class="price-card-description">${escapeHtml(description || model?.description || '当前可用模型')}</p></div></div><span class="price-badge">${badge}</span></header><div class="price-rows">${rowHtml}</div><p class="price-card-note">价格会随服务状态更新，开始生成前会再次确认。</p></article>`;
};
const renderUnavailableCard = model => `<article class="price-card"><header class="price-card-head"><div class="price-card-title"><span class="price-model-icon">${iconMarkup(model.id)}</span><div><h2>${escapeHtml(model.label)}</h2><p class="price-card-description">${escapeHtml(model.description || '模型能力正在准备中')}</p></div></div><span class="price-badge is-coming">${model.availability === 'coming-soon' ? '即将上线' : '暂不可用'}</span></header><div class="price-empty">当前没有可展示的实时价格</div><p class="price-card-note">服务恢复后，价格会自动出现在这里。</p></article>`;

export const pricedItems = payload => (Array.isArray(payload?.items) ? payload.items : []).filter(item => item?.available !== false && Number.isFinite(Number(item?.yuan)));

// Returns '' when there is nothing to show, so the caller can pick its own empty state.
export function renderPriceCatalog(payload) {
  const items = pricedItems(payload);
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const groups = new Map();
  items.forEach(item => {
    const key = String(item.modelId || item.label || 'unknown');
    const group = groups.get(key) || { rows: [], label: item.label, modelId: key };
    group.rows.push(item);
    groups.set(key, group);
  });
  const cards = [...groups.values()].map(group => {
    const model = models.find(item => item.id === group.modelId);
    return renderCard(model, group.rows, model?.description || '');
  });
  models.filter(model => !groups.has(model.id) && model.id !== 'gpt-image-2').forEach(model => cards.push(renderUnavailableCard(model)));
  return cards.join('');
}

// Lowest current prices per kind of work, used in the page summary and search snippet.
export function priceHighlights(payload) {
  const items = pricedItems(payload);
  const lowest = list => list.length ? Math.min(...list.map(item => Number(item.yuan))) : null;
  const names = list => [...new Set(list.map(item => String(item.label || '').replace(/\s*特价$/, '').trim()).filter(Boolean))];
  const hasDuration = item => item.duration !== null && item.duration !== undefined;
  const videos = items.filter(item => item.kind !== 'audio' && (item.unit === 'second' || hasDuration(item)));
  const images = items.filter(item => item.kind !== 'audio' && item.unit === 'request' && !hasDuration(item));
  return {
    video: lowest(videos.filter(item => item.unit === 'second')),
    image: lowest(images),
    hasValueModels: items.some(item => isValueModel(item.label)),
    videoNames: names(videos),
    imageNames: names(images),
    yuanValues: items.map(item => Number(item.yuan)),
  };
}
