// Tuzi occasionally returns an image URL on a storage host that cannot serve it.
// Keep the path and signature intact and try only its known alternate host.
export function tuziImageRetryUrl(value,kind){
  let url;try{url=new URL(value);}catch{return null;}
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='apioss3.sydney-ai.com')return null;
  if(kind!=='image'&&(kind||! /\.(?:png|jpe?g|webp|gif|avif)$/i.test(url.pathname)))return null;
  url.hostname='apioss4.sydney-ai.com';return url.toString();
}
