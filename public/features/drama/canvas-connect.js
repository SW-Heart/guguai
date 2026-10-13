// Drag-to-connect on the canvas. Hovering a node shows a handle on its right
// edge; dragging the handle draws a curve that snaps onto a node accepting the
// input. Everything here is plain DOM above the canvas, so a drag never asks
// the canvas to redraw.
const svgNS='http://www.w3.org/2000/svg';
// The handle sits just outside the node so it never covers the resize handles.
const PORT_GAP=18;
const plusIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

// Screen-space distances stay consistent when the canvas is zoomed.
export function magneticPortPosition(rect,point,reach=56,pull=12){
  const origin={x:rect.left+rect.width+PORT_GAP,y:rect.top+rect.height/2};
  if(!point)return origin;
  const dx=point.x-origin.x,dy=point.y-origin.y,distance=Math.hypot(dx,dy);
  if(distance>=reach||!distance)return origin;
  const offset=Math.min(distance,pull*(1-distance/reach));
  return {x:origin.x+dx/distance*offset,y:origin.y+dy/distance*offset};
}

export function connectionSource(rects,point,canStart,reach=56){
  const direct=rectAt(rects,point.x,point.y,{slack:PORT_GAP+16});
  if(direct)return canStart(direct.id)?direct:null;
  let nearest=null,distance=reach;
  for(let index=rects.length-1;index>=0;index--){
    const rect=rects[index];
    if(!canStart(rect.id))continue;
    const next=Math.hypot(point.x-rect.left-rect.width-PORT_GAP,point.y-rect.top-rect.height/2);
    if(next<distance){nearest=rect;distance=next;}
  }
  return nearest;
}

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

// Keep incompatible nodes under the pointer visible as errors; otherwise snap
// to the nearest compatible card as the pointer approaches its boundary.
export function connectionTarget(rects,x,y,from,check,reach=48){
  const direct=rectAt(rects,x,y,{exclude:from});
  if(direct)return direct;
  let nearest=null,distance=reach;
  for(let index=rects.length-1;index>=0;index--){
    const rect=rects[index];
    if(rect.id===from||check(from,rect.id))continue;
    const dx=Math.max(rect.left-x,0,x-rect.left-rect.width);
    const dy=Math.max(rect.top-y,0,y-rect.top-rect.height);
    const next=Math.hypot(dx,dy);
    if(next<distance){nearest=rect;distance=next;}
  }
  return nearest;
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
  const inputPort=document.createElement('span');
  inputPort.className='dw-link-port dw-link-input-port';inputPort.hidden=true;inputPort.innerHTML=plusIcon;
  inputPort.setAttribute('aria-hidden','true');
  layer.append(svg,outline,hint,port,inputPort);
  container.append(layer);

  let hovered=null,portPoint=null,hoverPoint=null,drag=null,frame=0,pending=null,disposed=false;
  const local=event=>{const box=container.getBoundingClientRect();return {x:event.clientX-box.left,y:event.clientY-box.top};};
  const placePort=(rect,point=null)=>{
    hovered=rect;
    if(!rect){port.hidden=true;portPoint=null;return;}
    port.hidden=false;
    portPoint=magneticPortPosition(rect,point);
    port.style.transform=`translate(${portPoint.x}px,${portPoint.y}px) translate(-50%,-50%)`;
  };
  const hover=point=>{
    if(drag)return;
    hoverPoint=point;
    placePort(connectionSource(rects(),point,canStart),point);
  };
  const schedule=(callback)=>{pending=callback;if(frame)return;frame=requestAnimationFrame(()=>{frame=0;const run=pending;pending=null;if(!disposed)run?.();});};
  const clearTarget=()=>{inputPort.hidden=true;outline.hidden=true;hint.hidden=true;outline.classList.remove('is-valid','is-invalid');};
  const updateDrag=point=>{
    if(!drag)return;
    drag.point=point;
    const target=connectionTarget(rects(),point.x,point.y,drag.from,check);
    drag.target=target;
    drag.error=target?check(drag.from,target.id):'';
    const endpoint=target&&!drag.error?{x:target.left,y:target.top+target.height/2}:point;
    path.setAttribute('d',curvePath(drag.start.x,drag.start.y,endpoint.x,endpoint.y));
    inputPort.hidden=!target||Boolean(drag.error);
    if(!inputPort.hidden)inputPort.style.transform=`translate(${target.left-PORT_GAP}px,${target.top+target.height/2}px) translate(-50%,-50%)`;
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
    const start={...portPoint};
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
    refresh(){if(drag?.point)updateDrag(drag.point);if(hovered&&!drag&&hoverPoint)hover(hoverPoint);},
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
