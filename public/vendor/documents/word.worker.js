import { extractRawText } from './word.js?v=1';
self.onmessage=async event=>{
  try{self.postMessage({result:await extractRawText({arrayBuffer:event.data})});}
  catch{self.postMessage({error:true});}
};
