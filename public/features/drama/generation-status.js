import { canvasIcon } from './canvas-icons.js?v=1';

export const generationVisualStates=Object.freeze(['draft','submitting','waiting_approval','queued','running','processing','saving','completed','failed','cancelled']);
const presentation={
  draft:{label:'等待生成',icon:'image'},
  // Every in-progress phase looks the same to users; the phases are internal.
  submitting:{label:'生成中…',icon:'sparkles'},
  waiting_approval:{label:'等待确认',icon:'clock'},
  queued:{label:'生成中…',icon:'sparkles'},
  running:{label:'生成中…',icon:'sparkles'},
  processing:{label:'生成中…',icon:'sparkles'},
  saving:{label:'生成中…',icon:'sparkles'},
  completed:{label:'已完成',icon:'circle-check'},
  failed:{label:'生成失败',icon:'circle-alert'},
  cancelled:{label:'已取消',icon:'ban'},
};
// Phases that report measurable progress; the others never show a bar value.
const measured=new Set(['running','processing','saving']);
// Phases where work is under way, shown with a moving track when no value is known.
const busy=new Set(['submitting','running','processing','saving']);

// A retried job goes back to the queue on the server, but the user already saw
// it running; keep showing it as running instead of jumping back to queued.
export function generationTaskStatus(task){
  return task?.status==='queued'&&task.progressStage==='retrying'?'running':task?.status;
}

export function generationFrameState(status,hasMedia=false){
  if(hasMedia)return 'completed';
  if(status==='completed')return 'saving';
  return Object.hasOwn(presentation,status)?status:'queued';
}

export function renderGenerationPlaceholder(state,{kind='image',progress=null}={}){
  const phase=Object.hasOwn(presentation,state)?state:'queued';
  const {label,icon}=presentation[phase];
  const glyph=canvasIcon(phase==='draft'?(kind==='audio'?'music':kind==='video'?'video':'image'):icon);
  const value=Number(progress);
  const percentage=measured.has(phase)&&Number.isFinite(value)&&value>0?Math.min(99,Math.round(value)):null;
  const meter=percentage!==null
    ?`<progress max="100" value="${percentage}" aria-label="生成进度"></progress>`
    :busy.has(phase)?'<span class="dw-frame-meter" aria-hidden="true"></span>':'';
  return `<div class="dw-frame-placeholder" data-phase="${phase}" role="${phase==='failed'?'alert':'status'}"><span class="dw-frame-aura" aria-hidden="true"></span><span class="dw-frame-state-icon" aria-hidden="true">${glyph}</span><span class="dw-frame-state-text"><span class="dw-frame-state-label">${label}</span>${percentage===null?'':`<span class="dw-frame-progress-label">${percentage}%</span>`}</span>${meter}</div>`;
}
