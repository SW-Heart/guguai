// Agent status line while a reply is being prepared: cycling phrases with
// a continuous text shimmer and a terminal-style loader.
// Motion is CSS-driven (see `.dw-reasoning*` in styles.css); this module only
// updates text in place without restarting motion on each poll.

const THINKING_PHRASES=['正在思考','正在理解你的想法','正在梳理思路','正在组织回复'];
const REPLYING_PHRASE='正在回复';
const LOADER_FRAMES=['|','/','-','\\'];
const MIN_INTERVAL_MS=600;

// Map the agent's current activity to the phrases shown to the user. A generic
// "replying" status cycles through thinking phrases until text starts to
// appear; specific steps (reading files, generating, ...) are shown as-is.
export function reasoningPhrases({activity='',streaming=false}={}) {
  const phrase=String(activity??'').trim().replace(/[…。.\s]+$/u,'');
  if(!phrase||phrase===REPLYING_PHRASE)return streaming?[REPLYING_PHRASE]:[...THINKING_PHRASES];
  return [phrase];
}

export function createReasoningText({interval=3000}={}) {
  const element=document.createElement('div');
  element.className='dw-reasoning';
  element.setAttribute('role','status');
  element.hidden=true;
  element.innerHTML=`<span class="dw-reasoning-indicator" aria-hidden="true"><span>${LOADER_FRAMES.map(frame=>`<i>${frame}</i>`).join('')}</span></span><span class="dw-reasoning-stage" aria-hidden="true"></span><span class="dw-sr-only"></span>`;
  const stage=element.querySelector('.dw-reasoning-stage');
  const announcement=element.querySelector('.dw-sr-only');
  let phrases=[],signature='',index=0,timer=0,current=null;
  function show(phrase) {
    if(!current){
      current=document.createElement('span');
      current.className='dw-reasoning-phrase';
      stage.append(current);
    }
    if(current.dataset.phrase===phrase)return;
    current.dataset.phrase=phrase;
    current.textContent=`${phrase}…`;
  }

  function clearStage() {
    stage.replaceChildren();current=null;
  }

  function stopCycle() {clearInterval(timer);timer=0;}

  function startCycle() {
    stopCycle();
    if(phrases.length<2)return;
    timer=setInterval(()=>{
      index=(index+1)%phrases.length;
      show(phrases[index]);
    },Math.max(MIN_INTERVAL_MS,interval));
  }

  // Idempotent: the conversation panel redraws often, so identical input keeps
  // the running cycle instead of restarting it.
  function update({active=false,phrases:next=[]}={}) {
    const list=active?next.map(item=>String(item??'').trim()).filter(Boolean):[];
    if(!list.length){
      if(element.hidden)return;
      element.hidden=true;signature='';phrases=[];stopCycle();clearStage();announcement.textContent='';
      return;
    }
    const nextSignature=list.join('\n');
    if(nextSignature===signature&&!element.hidden)return;
    const appearing=element.hidden;
    signature=nextSignature;phrases=list;
    // Every phrase sits invisibly in the same grid cell, so the line keeps the
    // width of the longest one and nearby content does not shift while cycling.
    stage.querySelectorAll('.dw-reasoning-measure').forEach(node=>node.remove());
    stage.prepend(...list.map(phrase=>{
      const measure=document.createElement('span');
      measure.className='dw-reasoning-measure';
      measure.textContent=`${phrase}…`;
      return measure;
    }));
    // Announce the status once per change, not on every decorative cycle.
    announcement.textContent=list[0];
    element.hidden=false;
    const kept=list.indexOf(current?.dataset.phrase);
    if(appearing||kept<0){index=0;show(list[0]);}
    else index=kept;
    startCycle();
  }

  function destroy() {stopCycle();clearStage();element.remove();}

  return {element,update,destroy};
}
