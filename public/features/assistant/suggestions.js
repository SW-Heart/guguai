const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const assistantSuggestionGroups=Object.freeze([
  [
    {id:'storyboard',skill:'short-drama',title:'根据剧情梳理分镜',description:'提供剧本和预期时长',text:'请根据以下剧情梳理分镜。\n\n预期总时长：【填写时长，例如60秒】\n剧本或剧情：【粘贴你的内容】'},
    {id:'adapt-story',skill:'short-drama',title:'把故事改成短剧分镜',description:'提供原文和预期时长',text:'请把下面的故事改编成短剧分镜。\n\n原文：【粘贴故事或小说片段】\n预期总时长：【填写时长，例如90秒】'},
    {id:'fight-scene',skill:'fight-choreography',title:'设计一段连贯的打斗分镜',description:'提供人物、场景和胜负结果',text:'请设计一段连贯的打斗分镜。\n\n人物与场景：【填写交手人物、兵器和场景】\n剧情目标：【填写这段打斗要达成的结果】\n预期时长：由你建议'},
    {id:'seedance-prompt',skill:'seedance-creation-bible',title:'编写 Seedance 视频描述',description:'提供画面内容和时长',text:'请为 Seedance 编写视频描述。\n\n画面内容：【填写人物、场景和动作】\n预期时长：【填写时长】\n仅交付描述文字。'},
    {id:'ad-storyboard',skill:'video-production',title:'为产品设计广告分镜',description:'提供产品卖点和受众',text:'请为以下产品设计广告分镜。\n\n产品与卖点：【填写产品和最想突出的卖点】\n目标受众：【填写希望吸引的人群】\n预期时长：由你建议'},
    {id:'continue-shots',skill:'video-production',title:'续写下一段分镜',description:'提供上一段和后续剧情',text:'请承接上一段分镜，设计下一段。\n\n上一段分镜：【粘贴上一段的内容】\n后续剧情：【填写接下来发生的事】\n本段时长：由你建议'},
  ],
  [
    {id:'write-script',skill:'script-writing',title:'根据需求创作剧本',description:'提供题材、人物或核心情节',text:'请根据以下需求创作剧本。\n\n故事需求：【填写题材、主要人物或想表达的情节】\n预期时长：由你建议'},
    {id:'revise-scene',skill:'script-writing',title:'改写一场戏',description:'提供原稿和修改目标',text:'请改写以下这场戏，保留未要求修改的设定。\n\n原稿：【粘贴原稿】\n修改目标：【填写你想改变或加强的地方】'},
    {id:'drama-episodes',skill:'short-drama',title:'把故事梗概拆成短剧分集',description:'提供梗概和集数',text:'请把以下故事梗概拆成短剧分集大纲。\n\n故事梗概：【粘贴你的梗概】\n预期集数：【填写集数，或写“由你建议”】'},
    {id:'review-script',skill:'creative-review',title:'检查剧本里的冲突与逻辑',description:'提供原稿和关注重点',text:'请检查以下剧本的冲突、人物动机和情节逻辑，并提出具体修改建议。\n\n剧本：【粘贴原稿】\n关注重点：优先指出影响理解和人物可信度的问题。'},
    {id:'story-outline',title:'整理故事里的关键情节',description:'提供故事内容',text:'请梳理以下故事里的关键人物、事件顺序和转折。\n\n故事内容：【粘贴你的内容】\n请沿用原文事实，区分已有内容与缺失信息。'},
    {id:'polish-dialogue',skill:'script-writing',title:'润色人物对白',description:'提供原对白和人物关系',text:'请润色以下人物对白，保留剧情意图。\n\n原对白：【粘贴对白】\n人物关系与说话情境：【填写人物关系或当时发生的事】'},
  ],
  [
    {id:'character-sheet',skill:'character-design',title:'设计角色设定图描述',description:'提供角色特征和画面风格',text:'请为以下角色编写设定图描述。\n\n角色描述：【填写年龄、外貌、服装、性格等已知信息】\n画面风格：由你建议'},
    {id:'character-profile',skill:'character-design',title:'完善人物设定',description:'提供已有背景和人物特征',text:'请完善以下人物设定。\n\n现有设定：【填写人物背景、性格或其他已知信息】\n创作用途：用于剧本与分镜，缺少的信息请给出建议'},
    {id:'scene-description',skill:'image-design',title:'编写场景参考图描述',icon:'clapperboard',description:'提供场景与氛围',text:'请为以下场景编写参考图描述。\n\n场景内容：【填写地点、时代和主要物件】\n画面氛围：【填写光线、天气或情绪】\n请交付可独立复制使用的描述。'},
    {id:'prop-description',skill:'image-design',title:'设计故事中的关键道具',icon:'wand-sparkles',description:'提供用途与外观线索',text:'请为故事中的关键道具设计外观，并编写道具图描述。\n\n道具与用途：【填写道具是什么、在剧情中起什么作用】\n外观线索：【填写已有设想，或写“由你建议”】'},
    {id:'polish-prompt',skill:'prompt-optimization',title:'把画面想法整理成提示词',icon:'wand-sparkles',description:'提供画面想法与用途',text:'请把以下画面想法整理成清晰、完整的提示词。\n\n画面想法：【填写你希望出现的内容】\n用途：【填写用于图片还是视频，以及目标模型（如已确定）】'},
    {id:'character-description',skill:'prompt-optimization',title:'优化角色画面描述',description:'提供现有描述和改进方向',text:'请优化以下角色画面描述。\n\n现有描述：【粘贴角色描述】\n期望改进：【填写你想改善的地方】'},
  ],
]);
export const pickAssistantSuggestions=(random=Math.random,previous=[])=>assistantSuggestionGroups.map((group,index)=>{const candidates=group.filter(item=>item.id!==previous[index]?.id);return candidates[Math.floor(random()*candidates.length)];});
const suggestionIcons=new Map(assistantSuggestionGroups.flatMap((group,index)=>group.map(item=>[item.id,item.icon||['clapperboard','book-open-check','user-round'][index]])));
export const renderAssistantSuggestions=items=>items.map(item=>`<button type="button" data-suggestion="${escape(item.id)}"><span class="gugu-lucide gugu-lucide-${suggestionIcons.get(item.id)||'book-open-check'}" aria-hidden="true"></span><span class="assistant-suggestion-label">${escape(item.title)}</span></button>`).join('');

// Filling a suggestion is an edit, never a submit or a replacement for a draft.
export function fillAssistantSuggestion(input,item,{replaceValue}={}){
  if(input.value.trim()&&input.value!==replaceValue)return false;
  input.value=item.text;
  input.focus({preventScroll:true});
  const placeholder=item.text.match(/【[^】]+】/);
  if(placeholder)input.setSelectionRange(placeholder.index,placeholder.index+placeholder[0].length);
  else input.setSelectionRange(item.text.length,item.text.length);
  input.scrollIntoView?.({block:'nearest'});
  input.dispatchEvent(new Event('input',{bubbles:true}));
  return true;
}
export async function applySuggestionSkill(item,{catalog,selected,select}){
  if(!item.skill)return;
  if(!catalog?.some(skill=>skill.name===item.skill))throw new Error('关联技能暂时不可用，请稍后重试');
  if(selected!==item.skill)await select(item.skill);
}
export function mountAssistantSuggestions(container,input,{signal,onDraft=()=>{},onUse,random=Math.random,reduceMotion=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches||false,visibilityTarget=globalThis.document}={}){
  let session='',items=[],disabled=true,lastTemplate='',currentSuggestion='';
  let timer=0,deadline=0,animation=null,transition=0,hovered=false,focused=false,applying=false,disposed=false,useEpoch=0;
  const eligible=()=>!disposed&&!container.hidden&&!disabled&&!hovered&&!focused&&!applying&&!visibilityTarget?.hidden;
  function feedback(){for(const button of container.querySelectorAll('button')){const active=button.dataset.suggestion===currentSuggestion;button.toggleAttribute('data-filled',active);if(active)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');}}
  function draw(next){items=next;container.innerHTML=renderAssistantSuggestions(items);for(const button of container.querySelectorAll('button'))button.disabled=disabled;feedback();}
  function stop(){clearTimeout(timer);timer=0;deadline=0;transition++;animation?.cancel();animation=null;}
  function schedule(){if(!eligible()||timer||animation)return;if(!deadline)deadline=Date.now()+5000;timer=setTimeout(refresh,Math.max(0,deadline-Date.now()));timer.unref?.();}
  function animateRows(frames,options){
    const startTime=visibilityTarget?.timeline?.currentTime;
    const animations=[...container.querySelectorAll('button')].map(row=>row.animate(frames,options));
    if(Number.isFinite(startTime))for(const item of animations)item.startTime=startTime;
    return {finished:Promise.all(animations.map(item=>item.finished)),cancel(){for(const item of animations)item.cancel();}};
  }
  async function refresh(){
    timer=0;if(!eligible())return;deadline=Date.now()+5000;
    const next=pickAssistantSuggestions(random,items),epoch=++transition;
    if(reduceMotion()||![...container.querySelectorAll('button')].every(row=>typeof row.animate==='function')){draw(next);schedule();return;}
    try{
      animation=animateRows([{transform:'perspective(700px) rotateX(0deg)',opacity:1},{transform:'perspective(700px) rotateX(-85deg)',opacity:0}],{duration:180,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'});
      await animation.finished;
      if(epoch!==transition||!eligible())return;
      draw(next);animation.cancel();
      animation=animateRows([{transform:'perspective(700px) rotateX(85deg)',opacity:0},{transform:'perspective(700px) rotateX(0deg)',opacity:1}],{duration:240,easing:'cubic-bezier(0,0,.2,1)',fill:'forwards'});
      await animation.finished;
    }catch{}finally{if(epoch===transition){animation?.cancel();animation=null;schedule();}}
  }
  input.addEventListener('input',()=>{if(!input.value.trim()){lastTemplate='';currentSuggestion='';feedback();}},{signal});
  container.addEventListener('pointerenter',event=>{if(event.pointerType==='touch')return;hovered=true;stop();},{signal});
  container.addEventListener('pointerleave',event=>{if(event.pointerType==='touch')return;hovered=false;schedule();},{signal});
  container.addEventListener('focusin',()=>{focused=true;stop();},{signal});
  container.addEventListener('focusout',event=>{if(container.contains(event.relatedTarget))return;focused=false;schedule();},{signal});
  visibilityTarget?.addEventListener('visibilitychange',()=>{stop();schedule();},{signal});
  container.addEventListener('click',async event=>{
    const button=event.target.closest('[data-suggestion]');
    if(!button||disabled||container.hidden||applying)return;
    const item=items.find(item=>item.id===button.dataset.suggestion);
    if(!item)return;
    if(input.value.trim()&&input.value!==lastTemplate){input.focus({preventScroll:true});onDraft('已保留你正在填写的内容');return;}
    const value=input.value,epoch=++useEpoch;applying=true;stop();
    try{
      if(onUse&&await onUse(item)===false)return;
      if(disposed||epoch!==useEpoch||value!==input.value)return;
      if(fillAssistantSuggestion(input,item,{replaceValue:lastTemplate})){lastTemplate=item.text;currentSuggestion=item.id;feedback();}
    }catch{if(!disposed)onDraft('暂时无法使用此模板，请稍后重试');}
    finally{applying=false;schedule();}
  },{signal});
  const destroy=()=>{disposed=true;useEpoch++;stop();};
  signal?.addEventListener('abort',destroy,{once:true});
  return {update({sessionId,empty,disabled:locked}){
    if(disposed)return;
    if(session!==sessionId){stop();useEpoch++;session=sessionId;items=[];lastTemplate='';currentSuggestion='';hovered=container.matches?.(':hover')||false;focused=container.contains?.(visibilityTarget?.activeElement)||false;}
    container.hidden=!empty;
    disabled=Boolean(locked);
    if(empty&&!items.length)draw(pickAssistantSuggestions(random));
    for(const button of container.querySelectorAll('button'))button.disabled=disabled;
    if(!eligible())stop();else schedule();
  },destroy};
}
