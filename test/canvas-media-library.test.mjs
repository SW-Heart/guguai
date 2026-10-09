import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasMediaFiles,createCanvasMediaLibrary} from '../public/features/drama/canvas-media-library.js';

const png=new Blob([new Uint8Array([0x89,0x50,0x4e,0x47,13,10,26,10])]);
const photo={id:'node',name:'图片',kind:'image',url:'blob:photo'};

test('canvas media includes native and generated images/videos and skips hidden nodes',()=>{
  const media=canvasMediaFiles({nodes:[
    {id:'image',$_type:'image',$_imageUrl:'blob:image'},
    {id:'video',$_type:'video',$_videoUrl:'blob:video'},
    {id:'generated',$_type:'html',$_actualType:'video'},
    {id:'hidden',$_type:'image',$_imageUrl:'blob:hidden'},
    {id:'invisible',$_type:'video',$_videoUrl:'blob:invisible',visible:false},
  ]},[{id:'generated',taskId:'task',title:'生成视频',media:{kind:'video',url:'/video.mp4'}}],new Set(['hidden']));
  assert.deepEqual(media.map(file=>[file.id,file.kind]),[['image','image'],['video','video'],['generated','video']]);
  assert.equal(media[2].taskId,'task');
});

test('dropped images enter the file library once and copied nodes share pending uploads',async()=>{
  let init,uploads=0,registrations=0;
  const library=createCanvasMediaLibrary({isCurrent:()=>true,findFile:()=>null,
    registerFile:async file=>{registrations++;return file;},
    fetchImpl:async(_,request)=>request?(uploads++,{ok:true}):{ok:true,blob:async()=>png},
    api:async(url,request)=>{
      if(url.endsWith('/init')){init=JSON.parse(request.body);return {uploadId:'upload',uploadUrl:'/put'};}
      return {id:'saved',kind:'image',name:'图片.png',url:'/saved.png'};
    },
  });
  const first=library.add(photo),copy=library.add({...photo,id:'copy'});
  assert.equal(first,copy);
  const file=await first;
  assert.equal(file.id,'saved');assert.equal(init.mimeType,'image/png');assert.match(init.sha256,/^[a-f0-9]{64}$/);
  assert.equal(await library.add({...photo,url:file.url}),file);
  assert.equal(uploads,1);assert.equal(registrations,1);
});

test('native video bytes retain MP4 type and register in the same file library',async()=>{
  let init;
  const library=createCanvasMediaLibrary({isCurrent:()=>true,findFile:()=>null,registerFile:file=>file,
    fetchImpl:async()=>({ok:true,blob:async()=>new Blob([new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109])])}),
    api:async(_,request)=>{init=JSON.parse(request.body);return {asset:{id:'video',kind:'video',url:'/video.mp4'}};},
  });
  assert.equal((await library.add({...photo,kind:'video',name:'视频'})).id,'video');
  assert.equal(init.mimeType,'video/mp4');assert.equal(init.name,'视频.mp4');
});

test('existing files are reused while cropped media creates a new library file',async()=>{
  let uploads=0;
  const original={id:'original',kind:'image',url:'/original.png'};
  const library=createCanvasMediaLibrary({isCurrent:()=>true,findFile:()=>original,registerFile:file=>file,
    fetchImpl:async()=>({ok:true,blob:async()=>png}),
    api:async(_,request)=>{assert.ok(request);uploads++;return {asset:{id:'cropped',kind:'image',url:'/cropped.png'}};},
  });
  assert.equal((await library.add({...photo,url:original.url,assetId:original.id})).id,'original');
  assert.equal(uploads,0);
  assert.equal((await library.add({...photo,assetId:original.id})).id,'cropped');
  assert.equal(uploads,1);
});

test('a failed upload can retry and a disposed workspace cannot register a file',async()=>{
  let current=true,fail=true,registered=0;
  const library=createCanvasMediaLibrary({isCurrent:()=>current,findFile:()=>null,
    registerFile:file=>{registered++;return file;},
    fetchImpl:async(_,request)=>request?{ok:!fail}:{ok:true,blob:async()=>png},
    api:async url=>url.endsWith('/init')?{uploadId:'upload',uploadUrl:'/put'}:{id:'saved',kind:'image'},
  });
  await assert.rejects(library.add(photo),/保存失败/);
  fail=false;await library.add(photo);assert.equal(registered,1);
  current=false;assert.throws(()=>library.add({...photo,url:'blob:other'}),error=>error.stale===true);
});

test('desktop saves dropped and cropped canvas media locally without uploading',async()=>{
  const saved=[];
  const library=createCanvasMediaLibrary({isCurrent:()=>true,findFile:()=>null,registerFile:file=>file,
    fetchImpl:async(_,request)=>{assert.equal(request,undefined,'must not upload');return {ok:true,blob:async()=>png};},
    api:async()=>assert.fail('must not create an upload'),
    importLocal:async({name,blob})=>{saved.push([name,blob.type]);return {id:'local_1',kind:'image',url:'gugu-media://local_1',localOnly:true};},
  });
  const file=await library.add(photo);
  assert.equal(file.id,'local_1');
  assert.deepEqual(saved,[['图片.png','image/png']]);
});

test('clients without local saving keep uploading canvas media',async()=>{
  let uploads=0;
  const library=createCanvasMediaLibrary({isCurrent:()=>true,findFile:()=>null,registerFile:file=>file,
    fetchImpl:async()=>({ok:true,blob:async()=>png}),importLocal:async()=>null,
    api:async()=>{uploads++;return {asset:{id:'saved',kind:'image',url:'/saved.png'}};},
  });
  assert.equal((await library.add(photo)).id,'saved');
  assert.equal(uploads,1);
});
