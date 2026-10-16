import { voiceLanguage,voiceFacets,voiceFilterOptions,createVoiceFilterState } from './voice-filters.js?v=2';
import { speechModels,speechCharacters,speechEmotions,systemVoices } from './catalog.js?v=2';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const recommendedVoiceIds=[
  'Chinese (Mandarin)_News_Anchor','Chinese (Mandarin)_Male_Announcer','Chinese (Mandarin)_Radio_Host',
  'Chinese (Mandarin)_Gentleman','Chinese (Mandarin)_Warm_Bestie','Chinese (Mandarin)_Sweet_Lady',
  'Chinese (Mandarin)_Reliable_Executive','Chinese (Mandarin)_Gentle_Youth','Chinese (Mandarin)_Warm_Girl',
  'female-tianmei','male-qn-qingse','female-chengshu',
];
const voiceLanguages={'Chinese (Mandarin)':'普通话','Cantonese':'粤语','English':'英语','Japanese':'日语','Korean':'韩语','Portuguese':'葡萄牙语','Spanish':'西班牙语','Indonesian':'印尼语','Russian':'俄语','French':'法语','Italian':'意大利语','German':'德语','Dutch':'荷兰语','Arabic':'阿拉伯语','Turkish':'土耳其语','Ukrainian':'乌克兰语','Vietnamese':'越南语'};
export function speechVoiceGroups(voices){
  const unique=[...new Map(voices.map(voice=>[voice.id,voice])).values()],byId=new Map(unique.map(voice=>[voice.id,voice]));
  const recommended=recommendedVoiceIds.map(id=>byId.get(id)).filter(voice=>voice?.type==='system'),picked=new Set(recommended.filter(voice=>voice.description?.trim()).map(voice=>voice.id));
  const groups=[{label:'热门推荐',voices:recommended.filter(voice=>voice.description?.trim())},{label:'我的音色',voices:unique.filter(voice=>voice.type==='custom')}];
  const languages=new Map(Object.values(voiceLanguages).map(label=>[label,{label,voices:[]}]));languages.set('未注明',{label:'更多音色',voices:[]});
  for(const voice of unique){
    if(voice.type==='custom'||picked.has(voice.id))continue;
    const language=voiceLanguage(voice);if(!languages.has(language))languages.set(language,{label:language,voices:[]});
    languages.get(language).voices.push(voice);
  }
  const missing={label:'无描述音色',voices:[]};
  for(const group of [...groups,...languages.values()]){missing.voices.push(...group.voices.filter(voice=>!voice.description?.trim()));group.voices=group.voices.filter(voice=>voice.description?.trim());}
  return [...groups,...[...languages.values()].map(group=>({...group,voices:group.voices.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))})),missing].filter(group=>group.voices.length);
}
export function speechVoiceMenuMarkup(voices,selected,{check='',filter='',state=createVoiceFilterState()}={}){
  const groups=speechVoiceGroups(voices);
  const active=Object.values(state.selected).some(value=>value!==null);
  return `<div class="dw-speech-voice-search"><div class="dw-speech-search-row"><input type="search" data-speech-voice-search aria-label="搜索音色" aria-controls="canvasSpeechVoices" placeholder="搜索名称、特点或语言" autocomplete="off" value="${esc(state.query)}"><button type="button" class="dw-speech-filter-toggle${active?' is-active':''}" data-speech-filter-toggle aria-label="筛选语言" aria-expanded="${state.open}" aria-controls="canvasSpeechVoiceFilters" title="筛选语言">${filter}${active?'<i aria-hidden="true"></i>':''}</button></div></div><div id="canvasSpeechVoices" class="dw-gen-option-list" role="listbox" aria-label="音色">${groups.map(group=>`<section class="dw-speech-voice-group" data-speech-voice-group role="group" aria-label="${esc(group.label)}"><h4>${esc(group.label)}<span data-speech-group-count>${group.voices.length}</span></h4>${group.voices.map(voice=>{const facets=voiceFacets(voice,recommendedVoiceIds);return `<button type="button" class="dw-gen-option" role="option" aria-selected="${voice.id===selected}" data-gen-set="voiceId" data-speech-voice-option ${Object.entries(facets).map(([key,value])=>`data-filter-${key}="${esc(value)}"`).join(' ')} data-search="${esc(`${voice.name} ${voice.description||''} ${voice.id} ${group.label} ${voiceLanguage(voice)} ${voiceLanguage(voice)==='普通话'?'中文 国语':''}`.toLocaleLowerCase())}" data-value="${esc(voice.id)}" data-focus-key="voiceId:${esc(voice.id)}"><span class="dw-gen-option-copy"><b>${esc(voice.name)}</b><small>${esc(voiceLanguage(voice))}${voice.description?` · ${esc(voice.description)}`:''}</small></span><span class="dw-gen-option-check">${check}</span></button>`;}).join('')}</section>`).join('')}</div><p class="dw-speech-voice-empty" data-speech-voice-empty hidden>没有匹配的音色，请调整搜索或筛选条件</p>`;
}
export function speechLanguageFilterMarkup(voices,state){
  return `<div class="dw-speech-filter-heading"><b>语言</b><button type="button" data-speech-filter-all="language">全选</button></div><div class="dw-speech-language-list">${voiceFilterOptions(voices).language.options.map(([value,label])=>`<label><input type="checkbox" data-speech-filter="language" value="${esc(value)}" ${state.selected.language===null||state.selected.language.includes(value)?'checked':''}><span>${esc(label)}</span></label>`).join('')}</div>`;
}
export function speechParameterOptions(field,voices=systemVoices){
  return {
    voiceId:{label:'音色',options:voices.map(v=>[v.id,`${v.type==='custom'?'我的音色 · ':''}${v.name}`,v.description||''])},
    modelId:{label:'模型',options:speechModels.map(v=>[v.id,v.label])},
    speed:{label:'语速',options:[[.5,'0.5 倍'],[.8,'0.8 倍'],[1,'正常'],[1.2,'1.2 倍'],[1.5,'1.5 倍'],[2,'2 倍']]},
    emotion:{label:'情绪',options:Object.entries(speechEmotions)},
  }[field];
}
export function speechComposerMarkup(draft,{voices=systemVoices,results=[],selectedResult='',linked=[],busy=false,enabled=true,icons={}}={}) {
  const parameter=(field,config,value)=>{
    const name=config.options.find(([id])=>String(id)===String(value))?.[1]||'选择音色';
    const shortName=field==='modelId'?name.replace('MiniMax Speech ',''):name;
    return `<button type="button" class="dw-gen-chip dw-speech-param" data-gen-menu="speech-${field}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(config.label)}：${esc(name)}" title="${esc(name)}"><span class="dw-speech-param-label">${esc(config.label)}</span><span class="dw-gen-chip-label">${esc(shortName)}</span><span class="dw-gen-chip-caret" aria-hidden="true">${icons.chevron||''}</span></button>`;
  };
  const voiceLink=linked.find(item=>item.voiceId),texts=linked.filter(item=>item.kind==='text');
  const characters=speechCharacters([...texts.map(t=>t.text?.trim()),draft.prompt.trim()].filter(Boolean).join('\n\n'));
  return `<div class="dw-speech-form">
    ${results.length>1?`<div class="dw-speech-history">${parameter('primaryId',{label:'生成结果',options:results.map((item,index)=>[item.id,`第 ${index+1} 个`])},selectedResult)}</div>`:''}
    ${linked.length?`<div class="dw-speech-linked">${linked.map(item=>`<span>${esc(item.label)}<button type="button" data-gen-unlink="${esc(item.id)}" aria-label="移除${esc(item.label)}">×</button></span>`).join('')}</div>`:''}
    ${texts.length?`<div class="dw-speech-source">${texts.map(item=>esc(item.text)).join('<br>')}</div>`:''}
    <label class="dw-sr-only" for="canvasSpeechText">配音文本</label>
    <div class="dw-gen-input dw-speech-editor"><textarea id="canvasSpeechText" data-speech-field="prompt" rows="3" maxlength="4000" placeholder="输入需要朗读的台词……">${esc(draft.prompt)}</textarea><span class="dw-speech-count" title="汉字计 2 字符，其他文字、标点和空格计 1 字符"><span data-speech-count>${characters}</span> 字符</span></div>
    <div class="dw-gen-toolbar dw-speech-toolbar"><div class="dw-gen-options dw-speech-params" role="group" aria-label="配音参数">${voiceLink?`<span class="dw-speech-voice-label" title="${esc(voiceLink.label)}"><span class="dw-speech-param-label">音色</span><span>${esc(voiceLink.label)}</span></span>`:parameter('voiceId',speechParameterOptions('voiceId',voices),draft.voiceId)}${['modelId','speed','emotion'].map(field=>parameter(field,speechParameterOptions(field),draft[field])).join('')}</div>
    <button type="button" class="dw-gen-submit" data-gen-submit ${busy||!enabled||(!draft.prompt.trim()&&!texts.some(t=>t.text?.trim()))?'disabled':''} ${busy?'aria-busy="true"':''}>${busy?icons.loader||'':icons.sparkles||''}<span class="dw-gen-submit-label">${busy?'正在开始':'生成配音'}</span><span class="dw-gen-price" data-gen-cost aria-live="polite">估算中…</span></button></div>
    ${enabled?'':'<p class="dw-speech-help">语音服务暂不可用，请稍后重试。</p>'}</div>`;
}
