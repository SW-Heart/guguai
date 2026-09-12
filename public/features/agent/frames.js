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

// New batches occupy rows below existing work. Once placed, an object never
// moves automatically; mixed portrait/landscape outputs use fixed-height rows.
export function placeMediaFrames(frames, positions, occupied = []) {
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
