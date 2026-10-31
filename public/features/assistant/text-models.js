export function textModelName(id='') {
  return String(id).replace(/[-_]/g,' ').split(/\s+/).map(word=>({gpt:'GPT',claude:'Claude',gemini:'Gemini',deepseek:'DeepSeek',qwen:'Qwen',grok:'Grok',llama:'Llama',minimax:'MiniMax',glm:'GLM',kimi:'Kimi',pro:'Pro',flash:'Flash',sonnet:'Sonnet',opus:'Opus',haiku:'Haiku',mini:'Mini',nano:'Nano'}[word.toLowerCase()]||(/^v\d/i.test(word)?word.replace(/^v/i,'V'):word))).join(' ');
}
export function textModelIcon(id='',label='') {
  const value=`${id} ${label}`.toLowerCase();
  for(const [pattern,key] of [[/deepseek/,'deepseek-color'],[/claude|anthropic/,'claude-color'],[/gpt|openai|\bo[134]\b/,'openai'],[/gemini|google/,'gemini-color'],[/qwen|通义/,'qwen-color'],[/grok/,'grok'],[/minimax/,'minimax-color'],[/kimi|moonshot/,'kimi-color'],[/glm|智谱/,'zhipu-color']])if(pattern.test(value))return key;
  return '';
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function textModelLogoMarkup(id,label='') {
  const key=textModelIcon(id,label);
  if(!key)return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></svg>';
  return `<span class="model-logo" aria-hidden="true"><img class="model-logo-day" src="/icons/models/${escape(key)}.svg?v=1" alt="" decoding="async"><img class="model-logo-night" src="/icons/models/${escape(key)}-dark.svg?v=1" alt="" decoding="async"></span>`;
}
