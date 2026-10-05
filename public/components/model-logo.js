const files = Object.freeze({
  'gpt-image-2': 'openai', 'gpt-image-2.5': 'openai', midjourney: 'midjourney', grok: 'grok',
  'minimax-h3-15s': 'minimax-color', 'minimax-h3': 'minimax-color',
  veo: 'gemini-color', oai: 'gemini-color', 'veo-31': 'gemini-color',
  'seedance-2.0-value': 'bytedance-color', 'seedance-2.5-value': 'bytedance-color',
  'seedance-2.0-mini': 'bytedance-color',
  'seedance-2.0': 'bytedance-color', 'seedance-2.5': 'bytedance-color', 'seedance-2.0-fast': 'bytedance-color',
});
const iconKeys = Object.freeze({ openai: 'openai', midjourney: 'midjourney', grok: 'grok', minimax: 'minimax-color', google: 'gemini-color', gemini: 'gemini-color', bytedance: 'bytedance-color' });
const url = file => `/icons/models/${file}.svg?v=1`;
export const modelLogoUrls = Object.freeze(Object.fromEntries(Object.entries(files).map(([id, file]) => [id, url(file)])));
export function modelLogoUrl(modelId, iconKey = '') {
  const file = files[modelId] || iconKeys[String(iconKey).toLowerCase()];
  return file ? url(file) : '';
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function modelLogoMarkup(src, { className = '', lazy = false, generation = false } = {}) {
  if (!Object.values(modelLogoUrls).includes(src)) return '';
  const dark = src.replace('.svg?', '-dark.svg?');
  const attributes = `${lazy ? ' loading="lazy"' : ''}${generation ? ' data-gen-model-icon' : ''}`;
  // CSS selects the variant, including logos mounted after a theme change.
  return `<span class="model-logo ${escape(className)}" aria-hidden="true"><img class="model-logo-day" src="${src}" alt="" decoding="async"${attributes}><img class="model-logo-night" src="${dark}" alt="" decoding="async"${attributes}></span>`;
}
