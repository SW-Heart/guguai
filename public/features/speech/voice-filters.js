import { officialVoiceLanguages } from './voice-metadata.js?v=1';
const languageAliases={'日文':'日语','韩文':'韩语','法文':'法语','德文':'德语','西班牙文':'西班牙语','葡萄牙文':'葡萄牙语','印尼文':'印尼语','俄文':'俄语','意大利文':'意大利语','荷兰文':'荷兰语','阿拉伯文':'阿拉伯语','土耳其文':'土耳其语','乌克兰文':'乌克兰语','越南文':'越南语','印地文':'印地语','希腊文':'希腊语','捷克文':'捷克语','波兰文':'波兰语','泰文':'泰语','罗马尼亚文':'罗马尼亚语','芬兰文':'芬兰语'};
export function voiceLanguage(voice){const value=voice.language||officialVoiceLanguages[voice.id.trim()]||'未注明';return languageAliases[value]||value;}
export function createVoiceFilterState(){return {open:false,query:'',selected:{language:null}};}
export function voiceFacets(voice,recommendedIds=[]){return {language:voiceLanguage(voice),source:voice.type==='custom'?'custom':'system',recommendation:recommendedIds.includes(voice.id)?'recommended':'other',description:voice.description?.trim()?'yes':'no'};}
export function voiceFilterOptions(voices){
  const languages=[...new Set(voices.map(voiceLanguage))].sort((a,b)=>{const order=['普通话','粤语','英语','日语','韩语'];return (order.includes(a)?order.indexOf(a):99)-(order.includes(b)?order.indexOf(b):99)||a.localeCompare(b,'zh-CN');});
  return {language:{label:'语言',options:languages.map(v=>[v,v])}};
}
export function toggleVoiceFilter(state,key,value,options){
  const current=new Set(state.selected[key]??options.map(([id])=>id));
  if(current.has(value))current.delete(value);else current.add(value);
  state.selected[key]=current.size===options.length?null:[...current];
}
export function voiceMatchesFilters(facets,selected){return Object.entries(selected).every(([key,values])=>values===null||values.includes(facets[key]));}
