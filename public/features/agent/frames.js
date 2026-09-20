export function mediaFrameSize(value = {}) {
  const width=Number(value.width),height=Number(value.height);
  const parts=String(value.aspectRatio||value.size||'1:1').split(/[:x×]/).map(Number);
  const ratio=width>0&&height>0?width/height:parts.length===2&&parts[0]>0&&parts[1]>0?parts[0]/parts[1]:1;
  return ratio>=1?{width:320,height:320/ratio}:{width:320*ratio,height:320};
}

export function generationFrames(doc) {
  const frames=[...(doc.generations||[])];
  for(const [id,p] of Object.entries(doc.prepared||{})){
    if(p.result)continue;
    for(let index=0;index<Math.min(10,Number(p.quote.quantity)||1);index++)frames.push({id:`${id}-${index}`,canvasId:`${id}-${index}`,batchId:id,type:p.input.type,title:p.input.prompt.slice(0,100),modelId:p.input.modelId,aspectRatio:p.input.midjourneyOptions?.aspectRatio||p.input.aspectRatio||p.input.size||p.quote.size,createdAt:p.createdAt,index,status:p.status||'waiting_approval',placeholder:true});
  }
  return frames.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)||(a.index||0)-(b.index||0)||a.id.localeCompare(b.id));
}

function nodeRect(node) {
  const scaleX=Math.abs(Number(node?.scaleX)||1),scaleY=Math.abs(Number(node?.scaleY)||1);
  const width=Math.max(1,Number(node?.width)||320)*scaleX;
  const height=Math.max(1,Number(node?.height)||320)*scaleY;
  const left=Number(node?.x)||0,top=Number(node?.y)||0;
  return {left,top,right:left+width,bottom:top+height};
}

function visibleCanvasBounds(view) {
  const width=Number(view?.width),height=Number(view?.height);
  const viewport=view?.viewport||{};
  const scale=Number(viewport.scale);
  if(!(width>0&&height>0&&scale>0)||!Number.isFinite(viewport.x)||!Number.isFinite(viewport.y))return null;
  // Keep a small breathing room from the canvas edge. Coordinates are in the
  // canvas world, so the inset must be converted from screen pixels.
  const inset=12/scale;
  const left=(-viewport.x)/scale+inset,top=(-viewport.y)/scale+inset;
  const right=(width-viewport.x)/scale-inset,bottom=(height-viewport.y)/scale-inset;
  return {left:Math.min(left,right),top:Math.min(top,bottom),right:Math.max(left,right),bottom:Math.max(top,bottom)};
}

function overlaps(a,b,gap=20) {
  return a.left<b.right+gap&&a.right>b.left-gap&&a.top<b.bottom+gap&&a.bottom>b.top-gap;
}

function axisCandidates(min,max,base,step,center) {
  const values=[];
  const add=value=>{
    const next=Math.max(min,Math.min(max,value));
    if(!values.some(item=>Math.abs(item-next)<.5))values.push(next);
  };
  const radius=Math.max(4,Math.ceil((max-min)/Math.max(1,step))+2);
  for(let i=0;i<=radius;i++){
    add(base+i*step);
    if(i) add(base-i*step);
  }
  add(min);add(max);
  return values.sort((a,b)=>Math.abs(a-center)-Math.abs(b-center));
}

function placeFrameInViewport(size, occupied, bounds) {
  const centerX=(bounds.left+bounds.right)/2,centerY=(bounds.top+bounds.bottom)/2;
  const minX=bounds.left,maxX=Math.max(minX,bounds.right-size.width);
  const minY=bounds.top,maxY=Math.max(minY,bounds.bottom-size.height);
  const baseX=Math.max(minX,Math.min(maxX,centerX-size.width/2));
  const baseY=Math.max(minY,Math.min(maxY,centerY-size.height/2));
  const xs=axisCandidates(minX,maxX,baseX,size.width+40,centerX-size.width/2);
  const ys=axisCandidates(minY,maxY,baseY,size.height+40,centerY-size.height/2);
  const candidates=[];
  for(const x of xs)for(const y of ys)candidates.push({x,y,distance:Math.hypot(x+size.width/2-centerX,y+size.height/2-centerY)});
  candidates.sort((a,b)=>a.distance-b.distance);
  for(const candidate of candidates){
    const rect={left:candidate.x,top:candidate.y,right:candidate.x+size.width,bottom:candidate.y+size.height};
    if(!occupied.some(item=>overlaps(rect,item,8)))return {x:candidate.x,y:candidate.y,...size};
  }
  // If the visible area is completely filled, still keep the new item inside
  // the current view. The next sync can place later items around it.
  return {x:baseX,y:baseY,...size};
}

// New batches prefer the current viewport center. Once placed, an object
// never moves automatically; mixed portrait/landscape outputs use fixed-size
// gaps and existing user positions remain untouched.
export function placeMediaFrames(frames, positions, occupied = [], view = null) {
  const bounds=visibleCanvasBounds(view);
  if(bounds){
    const placed=[];
    for(const frame of frames){
      const id=frame.canvasId||frame.id;
      if(positions[id])continue;
      const size=mediaFrameSize(frame);
      const position=placeFrameInViewport(size,[...occupied.map(nodeRect),...placed.map(nodeRect)],bounds);
      placed.push({id,...position});
    }
    return Object.fromEntries(placed.map(({id,...position})=>[id,position]));
  }

  // Without a measurable viewport (for example while the canvas is mounting),
  // retain the previous deterministic fallback and retry on the next sync.
  const result={};let bottom=occupied.reduce((y,n)=>Math.max(y,(Number(n.y)||0)+(Number(n.height)||228)*(Number(n.scaleY)||1)),0);
  for(const frame of frames){const p=positions[frame.canvasId||frame.id];if(p)bottom=Math.max(bottom,p.y+(p.height||320)+48);}
  let batch='',column=0,y=bottom+64;
  for(const frame of frames){
    const id=frame.canvasId||frame.id;if(positions[id])continue;
    const key=frame.batchId||frame.id;
    if(batch&&key!==batch){y+=384;column=0;}batch=key;
    if(column===4){y+=384;column=0;}
    result[id]={x:40+column*368,y,...mediaFrameSize(frame)};column++;
  }
  return result;
}
