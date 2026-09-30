const finite=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;

// World-space bounds include flips and rotation, so placement uses the space
// the user actually sees rather than the node's untransformed dimensions.
export function canvasNodeBounds(node={}) {
  const x=finite(node.x),y=finite(node.y),sx=finite(node.scaleX,1),sy=finite(node.scaleY,1);
  const angle=finite(node.rotation)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const width=Math.max(1,finite(node.width,280)),height=Math.max(1,finite(node.height,228));
  let corners=[[0,0],[width,0],[0,height],[width,height]];
  if(Array.isArray(node.points)&&node.points.length>=4){
    corners=[];
    for(let i=0;i+1<node.points.length;i+=2)corners.push([finite(node.points[i]),finite(node.points[i+1])]);
  }
  const points=corners.map(([dx,dy])=>[x+dx*sx*c-dy*sy*s,y+dx*sx*s+dy*sy*c]);
  return {left:Math.min(...points.map(p=>p[0])),right:Math.max(...points.map(p=>p[0])),top:Math.min(...points.map(p=>p[1])),bottom:Math.max(...points.map(p=>p[1]))};
}

const content=node=>node?.id&&!String(node.id).startsWith('edge-')&&node.visible!==false;
const intersects=(a,b,gap)=>a.left<b.right+gap&&a.right>b.left-gap&&a.top<b.bottom+gap&&a.bottom>b.top-gap;
const distance=(rect,point)=>Math.hypot(Math.max(rect.left-point.x,0,point.x-rect.right),Math.max(rect.top-point.y,0,point.y-rect.bottom));

function viewCenter(view={}) {
  view=view||{};
  const scale=Math.max(.01,finite(view.viewport?.scale,1));
  return {x:(finite(view.width,800)/2-finite(view.viewport?.x))/scale,y:(finite(view.height,600)/2-finite(view.viewport?.y))/scale};
}

// Add beside nearby content with aligned edges and one consistent gap. Saved
// positions and existing nodes are never moved. Every accepted node becomes
// an obstacle for the rest of the batch; the outer candidate guarantees room
// even when the canvas is densely occupied.
export function placeCanvasNodes(nodes,positions={},occupied=[],view=null,gap=32) {
  if(!nodes.some(node=>content(node)&&!positions[node.id]))return {};
  const obstacles=occupied.filter(content).map(canvasNodeBounds);
  const occupiedIds=new Set(occupied.map(node=>node.id));
  for(const node of nodes){
    if(positions[node.id]&&!occupiedIds.has(node.id))obstacles.push(canvasNodeBounds({...node,...positions[node.id]}));
  }
  const center=viewCenter(view),result={};
  const anchor=obstacles.length?obstacles.reduce((best,rect)=>distance(rect,center)<distance(best,center)?rect:best):null;
  const target=anchor?{x:(anchor.left+anchor.right)/2,y:(anchor.top+anchor.bottom)/2}:center;
  for(const node of nodes){
    if(!content(node)||positions[node.id])continue;
    const local=canvasNodeBounds({...node,x:0,y:0}),width=local.right-local.left,height=local.bottom-local.top;
    const candidates=[];
    const add=(left,top,order)=>candidates.push({left,top,right:left+width,bottom:top+height,order});
    if(!obstacles.length)add(center.x-width/2,center.y-height/2,0);
    for(const rect of obstacles){
      const ys=[rect.top,rect.bottom-height,(rect.top+rect.bottom-height)/2];
      const xs=[rect.left,rect.right-width,(rect.left+rect.right-width)/2];
      ys.forEach(y=>{add(rect.right+gap,y,0);add(rect.left-gap-width,y,2);});
      xs.forEach(x=>{add(x,rect.bottom+gap,1);add(x,rect.top-gap-height,3);});
    }
    if(obstacles.length)add(Math.max(...obstacles.map(rect=>rect.right))+gap,target.y-height/2,4);
    candidates.sort((a,b)=>{
      const score=rect=>Math.hypot((rect.left+rect.right)/2-target.x,(rect.top+rect.bottom)/2-target.y);
      return score(a)-score(b)||a.order-b.order||a.top-b.top||a.left-b.left;
    });
    const chosen=candidates.find(rect=>!obstacles.some(obstacle=>intersects(rect,obstacle,gap)));
    result[node.id]={x:chosen.left-local.left,y:chosen.top-local.top,width:finite(node.width,280),height:finite(node.height,228)};
    obstacles.push(chosen);
  }
  return result;
}

// Center only the new content and preserve the current zoom unless it needs
// to shrink to show the entire batch. Ordinary polling never calls this.
export function focusCanvasViewport(nodes,view,padding=64) {
  const rects=nodes.filter(content).map(canvasNodeBounds);
  if(!rects.length||!(view?.width>0&&view?.height>0))return null;
  const left=Math.min(...rects.map(rect=>rect.left)),right=Math.max(...rects.map(rect=>rect.right));
  const top=Math.min(...rects.map(rect=>rect.top)),bottom=Math.max(...rects.map(rect=>rect.bottom));
  const margin=Math.min(padding,view.width/4,view.height/4);
  const scale=Math.max(.01,Math.min(Math.max(.01,finite(view.viewport?.scale,1)),(view.width-2*margin)/Math.max(1,right-left),(view.height-2*margin)/Math.max(1,bottom-top)));
  return {x:view.width/2-(left+right)/2*scale,y:view.height/2-(top+bottom)/2*scale,scale};
}
