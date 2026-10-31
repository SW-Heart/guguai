// Keep ZIP/XML parsing off the conversation thread and stop stalled readers.
export function extractRawText({arrayBuffer}){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('../../vendor/documents/word.worker.js?v=1',import.meta.url),{type:'module'});
    const finish=(error,result)=>{clearTimeout(timer);worker.terminate();if(error)reject(new Error('无法读取这份 Word 文档，请确认文件未损坏后重试'));else resolve(result);};
    const timer=setTimeout(()=>finish(true),30_000);
    worker.onmessage=event=>finish(event.data.error,event.data.result);
    worker.onerror=()=>finish(true);
    worker.postMessage(arrayBuffer,[arrayBuffer]);
  });
}
