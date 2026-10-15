import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {tuziImageRetryUrl} from '../desktop/media-retry.mjs';
import {downloadMediaToFile,fetchRemoteMedia} from '../desktop/media-download.mjs';
import {createWriteStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {validateDownloadedMedia} from '../desktop/media-integrity.mjs';
const source='https://apioss3.sydney-ai.com/ximg/18c9.tp.mdc.360x360/0e1030ac-6f99-40d6-8424-b9ddfd1363c5/gi25-e1791964293.png?signature=abc%2F123';
const alternate=source.replace('apioss3.','apioss4.');
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40)]);
test('only Tuzi image storage host changes; path and signed parameters are preserved',()=>{
  assert.equal(tuziImageRetryUrl(source,'image'),alternate);
  assert.equal(tuziImageRetryUrl(source),alternate);
  for(const [url,kind] of [[source,'video'],[source,'audio'],[alternate,'image'],[source.replace('sydney-ai.com','example.com'),'image'],['bad-url','image']])assert.equal(tuziImageRetryUrl(url,kind),null);
});
test('desktop retries network, HTTP and invalid-file failures with the alternate image host',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tuzi-retry-'));
  try{
    for(const failure of ['network','http','invalid']){
      const calls=[],target=path.join(dir,failure);
      await downloadMediaToFile({},source,target,{kind:'image',headers:{Cookie:'private'},fetchMedia:async(_session,url,options)=>{
        calls.push({url,headers:options.sameOriginHeaders});
        if(url===source){if(failure==='network')throw new Error('connection failed');return new Response('<html>error</html>',{status:failure==='http'?404:200,headers:{'content-type':'text/html'}});}
        return new Response(png,{headers:{'content-type':'image/png'}});
      }});
      assert.deepEqual(calls.map(item=>item.url),[source,alternate]);assert.deepEqual(calls[1].headers,{});
      assert.deepEqual(await readFile(target),png);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('successful original downloads and unrelated hosts do not trigger extra requests',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tuzi-original-'));
  try{
    let calls=0;await downloadMediaToFile({},source,path.join(dir,'ok'),{kind:'image',fetchMedia:async()=>{calls++;return new Response(png);}});assert.equal(calls,1);
    calls=0;await assert.rejects(downloadMediaToFile({},'https://example.com/image.png',path.join(dir,'bad'),{kind:'image',fetchMedia:async()=>{calls++;throw new Error('failed');}}));assert.equal(calls,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('desktop retries a failed Tuzi storage hop reached through an authenticated redirect without copying credentials',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tuzi-redirect-')),calls=[];
  try{
    await downloadMediaToFile({fetch:async url=>{calls.push(url);throw new Error('network failed');}},'https://studio.example.com/api/files/id/direct',path.join(dir,'image'),{kind:'image',headers:{Cookie:'private'},fetchMedia:(session,url,options)=>fetchRemoteMedia(session,url,{...options,sameOriginFetch:async(target,request)=>{
      if(target===alternate){assert.ok(!request.headers.Cookie);calls.push(target);return new Response(png);}
      return new Response(null,{status:302,headers:{location:source}});
    }})});
    assert.deepEqual(calls,[source,alternate]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('server download retries use the alternate host after the first failure within the existing attempt budget',async()=>{
  const code=await readFile(new URL('../server.mjs',import.meta.url),'utf8'),dir=await mkdtemp(path.join(tmpdir(),'tuzi-server-')),calls=[];
  const context=vm.createContext({tuziImageRetryUrl,AbortSignal,Buffer,createHash,Transform,Readable,createWriteStream,pipeline,fs,validateDownloadedMedia,sleep:async()=>{},downloadErrorDetail:error=>error.message,fetch:async(url,options)=>{calls.push({url,headers:options.headers});return url===source?new Response('missing',{status:404}):new Response(png);}});
  try{
    vm.runInContext(code.slice(code.indexOf('async function downloadToFile('),code.indexOf('\nfunction assertGenerationJobLease(')),context);
    const target=path.join(dir,'image');await context.downloadToFile(source,target,4,{kind:'image',headers:{Authorization:'secret'}});
    assert.deepEqual(calls.map(call=>call.url),[source,alternate]);assert.ok(!calls[1].headers.Authorization);assert.deepEqual(await readFile(target),png);
  }finally{await rm(dir,{recursive:true,force:true});}
});
