// Drag-to-connect on the canvas. Hovering a node shows a handle on its right
// edge; dragging the handle draws a curve that snaps onto a node accepting the
// input. Everything here is plain DOM above the canvas, so a drag never asks
// the canvas to redraw.
const svgNS='http://www.w3.org/2000/svg';
// The handle sits just outside the node so it never covers the resize handles.
const PORT_GAP=18;
const plusIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

export function curvePath(x1,y1,x2,y2){
  const bend=Math.max(40,Math.min(240,Math.abs(x2-x1)/2+Math.abs(y2-y1)/6));
  return `M${x1} ${y1} C${x1+bend} ${y1} ${x2-bend} ${y2} ${x2} ${y2}`;
}

// Topmost rectangle under a point; later entries are drawn above earlier ones.
export function rectAt(rects,x,y,{exclude='',slack=0}={}){
  for(let index=rects.length-1;index>=0;index--){
    const rect=rects[index];
    if(rect.id===exclude)continue;
    if(x>=rect.left&&x<=rect.left+rect.width+slack&&y>=rect.top&&y<=rect.top+rect.height)return rect;
  }
  return null;
}

export function mountCanvasConnector(container,{rects,canStart,check,connect,dropEmpty,toast}){
  const layer=document.createElement('div');
  layer.className='dw-link-layer';
  const svg=document.createElementNS(svgNS,'svg');svg.setAttribute('class','dw-link-draft');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS(svgNS,'path');svg.append(path);
  const outline=document.createElement('div');outline.className='dw-link-target';outline.hidden=true;
  const hint=document.createElement('div');hint.className='dw-link-hint';hint.hidden=true;hint.setAttribute('role','status');
  const port=document.createElement('button');
  port.type='button';port.className='dw-link-port';port.hidden=true;port.innerHTML=plusIcon;
  port.setAttribute('aria-label','拖动连线，作为生成内容的输入');
  layer.append(svg,outline,hint,port);
  container.append(layer);

  let hovered=null,drag=null,frame=0,pending=null,disposed=false;
  const local=event=>{const box=container.getBoundingClientRect();return {x:event.clientX-box.left,y:event.clientY-box.top};};
  const placePort=rect=>{
    hovered=rect;
    if(!rect){port.hidden=true;return;}
    port.hidden=false;
    port.style.transform=`translate(${rect.left+rect.width+PORT_GAP}px,${rect.top+rect.height/2}px) translate(-50%,-50%)`;
  };
  const hover=point=>{
    if(drag)return;
    const list=rects();
    // Keep the handle while the pointer travels from the node onto it.
    const rect=rectAt(list,point.x,point.y,{slack:PORT_GAP+16});
    placePort(rect&&canStart(rect.id)?rect:null);
  };
  const schedule=(callback)=>{pending=callback;if(frame)return;frame=requestAnimationFrame(()=>{frame=0;const run=pending;pending=null;if(!disposed)run?.();});};
  const clearTarget=()=>{outline.hidden=true;hint.hidden=true;outline.classList.remove('is-valid','is-invalid');};
  const updateDrag=point=>{
    if(!drag)return;
    drag.point=point;
    path.setAttribute('d',curvePath(drag.start.x,drag.start.y,point.x,point.y));
    const target=rectAt(rects(),point.x,point.y,{exclude:drag.from});
    drag.target=target;
    drag.error=target?check(drag.from,target.id):'';
    if(!target){clearTarget();return;}
    Object.assign(outline.style,{transform:`translate(${target.left}px,${target.top}px)`,width:`${target.width}px`,height:`${target.height}px`});
    outline.hidden=false;
    outline.classList.toggle('is-valid',!drag.error);
    outline.classList.toggle('is-invalid',Boolean(drag.error));
    hint.hidden=!drag.error;
    if(drag.error){hint.textContent=drag.error;hint.style.transform=`translate(${point.x+14}px,${point.y+14}px)`;}
  };
  const finish=commit=>{
    if(!drag)return;
    const current=drag;drag=null;
    layer.classList.remove('is-linking');
    path.removeAttribute('d');clearTarget();
    if(!commit)return;
    if(current.target&&!current.error)connect(current.from,current.target.id);
    else if(current.target&&current.error)toast(current.error);
    else if(current.point&&Math.hypot(current.point.x-current.start.x,current.point.y-current.start.y)>24)dropEmpty(current.from,current.client);
  };

  const onMove=event=>{
    if(drag||event.buttons){if(!drag&&!port.hidden)placePort(null);return;}
    const point=local(event);
    schedule(()=>hover(point));
  };
  const onLeave=event=>{if(!drag&&!layer.contains(event.relatedTarget))placePort(null);};
  port.addEventListener('pointerdown',event=>{
    if(event.button!==0||!hovered)return;
    event.preventDefault();event.stopPropagation();
    port.setPointerCapture(event.pointerId);
    const start={x:hovered.left+hovered.width+PORT_GAP,y:hovered.top+hovered.height/2};
    drag={from:hovered.id,start,point:null,target:null,error:'',client:null};
    layer.classList.add('is-linking');
    port.hidden=true;
  });
  port.addEventListener('pointermove',event=>{
    if(!drag)return;
    event.preventDefault();
    drag.client={clientX:event.clientX,clientY:event.clientY};
    const point=local(event);
    schedule(()=>updateDrag(point));
  });
  port.addEventListener('pointerup',event=>{
    if(!drag)return;
    drag.client={clientX:event.clientX,clientY:event.clientY};
    if(frame){cancelAnimationFrame(frame);frame=0;pending=null;}
    updateDrag(local(event));
    finish(true);
  });
  port.addEventListener('pointercancel',()=>finish(false));
  port.addEventListener('lostpointercapture',()=>finish(false));
  const onKey=event=>{if(event.key==='Escape'&&drag){event.preventDefault();finish(false);}};
  container.addEventListener('pointermove',onMove);
  container.addEventListener('pointerleave',onLeave);
  const onWheel=()=>placePort(null);
  container.addEventListener('wheel',onWheel,{passive:true});
  document.addEventListener('keydown',onKey,true);

  return {
    // Viewport and node geometry changed: follow the hovered node.
    refresh(){if(hovered&&!drag){const rect=rects().find(item=>item.id===hovered.id);placePort(rect&&canStart(rect.id)?rect:null);}},
    hide(){if(!drag)placePort(null);},
    get dragging(){return Boolean(drag);},
    dispose(){
      disposed=true;if(frame)cancelAnimationFrame(frame);
      container.removeEventListener('pointermove',onMove);
      container.removeEventListener('pointerleave',onLeave);
      container.removeEventListener('wheel',onWheel);
      document.removeEventListener('keydown',onKey,true);
      layer.remove();
    },
  };
}
