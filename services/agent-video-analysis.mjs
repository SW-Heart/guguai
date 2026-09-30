import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const captionFontFile=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../resources/fonts/NotoSansCJKsc-Regular.otf');

export function processMedia(args, timeoutMs=30000, outputLimit=12000, cwd){
  if(!ffmpegPath)throw new Error('当前环境没有可用的视频分析组件');
  return new Promise((resolve,reject)=>{
    const child=spawn(ffmpegPath,['-hide_banner',...args],{stdio:['ignore','ignore','pipe'],cwd});
    let stderr='',settled=false;
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-outputLimit);});
    child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
    child.once('close',code=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(code===0)resolve(stderr);
      else reject(new Error(code===null?'视频分析超时':stderr.slice(-700)||'视频分析失败'));
    });
  });
}

export async function probeVideo(file){
  const output=await processMedia(['-i',file,'-t','0.01','-f','null','-']);
  const duration=output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const video=output.match(/Stream #.*?: Video:.*?(\d{2,5})x(\d{2,5})(?:[^\n]*?([\d.]+) fps)?/i);
  if(!video)throw new Error('这份素材没有可读取的视频画面');
  return {
    durationSeconds:duration?Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3]):null,
    width:Number(video[1]),height:Number(video[2]),frameRate:video[3]?Number(video[3]):null,
    hasAudio:/Stream #.*?: Audio:/i.test(output),
  };
}

export async function readVideoFrames(file,times){
  const metadata=await probeVideo(file);
  const unique=[...new Set(times.map(value=>Math.round(Number(value)*1000)/1000))];
  if(!unique.length||unique.length>6||unique.some(value=>!Number.isFinite(value)||value<0||value>3600||(metadata.durationSeconds!==null&&value>=metadata.durationSeconds)))throw new Error('取帧时间无效，请选择视频范围内的 1 到 6 个时间点');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gugu-agent-frames-'));
  try{
    const frames=[];
    for(let index=0;index<unique.length;index++){
      const target=path.join(directory,`frame-${index}.jpg`);
      await processMedia(['-loglevel','error','-ss',String(unique[index]),'-i',file,'-frames:v','1','-vf','scale=768:-2','-q:v','7','-y',target],30000);
      const data=await fs.readFile(target);
      if(data.length>1_000_000)throw new Error('取出的画面过大，请缩小取帧范围');
      frames.push({timeSeconds:unique[index],imageUrl:`data:image/jpeg;base64,${data.toString('base64')}`});
    }
    return {metadata,frames};
  }finally{await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}

export async function detectVideoBoundaries(file,{threshold=0.35,maxSeconds=300}={}){
  const metadata=await probeVideo(file);
  const seconds=Math.min(maxSeconds,metadata.durationSeconds||maxSeconds);
  if(!Number.isFinite(threshold)||threshold<0.1||threshold>0.9)throw new Error('画面变化灵敏度无效');
  if(!Number.isFinite(seconds)||seconds<=0||seconds>600)throw new Error('分析时长无效');
  const filter=`select=gt(scene\\,${threshold.toFixed(3)}),showinfo`;
  const output=await processMedia(['-loglevel','info','-i',file,'-t',String(seconds),'-an','-vf',filter,'-f','null','-'],Math.min(180000,30000+seconds*400),240000);
  const times=[...output.matchAll(/pts_time:([\d.]+)/g)].map(match=>Number(match[1])).filter(Number.isFinite);
  return {durationSeconds:metadata.durationSeconds,scannedSeconds:seconds,threshold,boundaries:[...new Set(times.map(time=>Math.round(time*1000)/1000))].slice(0,200)};
}

export async function extractSourceAudio(file,{startSeconds=0,endSeconds}={}){
  const metadata=await probeVideo(file);
  if(!metadata.hasAudio)throw new Error('这份视频没有音轨');
  const end=endSeconds===undefined?metadata.durationSeconds:endSeconds;
  if(!Number.isFinite(startSeconds)||startSeconds<0||!Number.isFinite(end)||end<=startSeconds||end-startSeconds>300||(metadata.durationSeconds!==null&&end>metadata.durationSeconds+0.05))throw new Error('请选择视频范围内最多 300 秒的音频');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gugu-agent-audio-'));
  try{
    const target=path.join(directory,'source.m4a');
    await processMedia(['-loglevel','error','-ss',String(startSeconds),'-i',file,'-t',String(end-startSeconds),'-map','0:a:0','-vn','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-y',target],Math.min(180000,30000+(end-startSeconds)*400));
    const data=await fs.readFile(target);
    if(!data.length||data.length>20_000_000)throw new Error('提取的音频大小超出限制');
    return {data,mimeType:'audio/mp4',startSeconds,endSeconds:end};
  }finally{await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}

export async function probeAudioTrack(file){
  const output=await processMedia(['-i',file,'-t','0.01','-f','null','-']);
  const duration=output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  return {durationSeconds:duration?Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3]):null,hasAudio:/Stream #.*?: Audio:/i.test(output)};
}

export async function prepareSpeechAudio(file,{startSeconds=0,endSeconds}={}){
  const metadata=await probeAudioTrack(file);
  if(!metadata.hasAudio)throw new Error('这份素材没有可识别的声音');
  if(metadata.durationSeconds===null)throw new Error('无法确认声音时长，请换一份素材');
  const end=endSeconds===undefined?Math.min(metadata.durationSeconds,startSeconds+300):endSeconds;
  if(!Number.isFinite(startSeconds)||!Number.isFinite(end)||startSeconds<0||end<=startSeconds||end-startSeconds>300||(metadata.durationSeconds!==null&&end>metadata.durationSeconds+0.05))throw new Error('请选择素材范围内最多 300 秒的声音');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gugu-agent-asr-'));
  try{
    const target=path.join(directory,'speech.mp3');
    await processMedia(['-loglevel','error','-ss',String(startSeconds),'-i',file,'-t',String(end-startSeconds),'-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','64k','-y',target],Math.min(180000,30000+(end-startSeconds)*500));
    const stat=await fs.stat(target);
    if(!stat.size||stat.size>8_000_000)throw new Error('声音文件过大，请缩短识别范围');
    return {data:await fs.readFile(target),startSeconds,endSeconds:end,durationSeconds:metadata.durationSeconds};
  }finally{await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}

export async function inspectVideoAudio(file,{startSeconds=0,endSeconds}={}){
  const metadata=await probeVideo(file);
  if(!metadata.hasAudio)return {hasAudio:false,durationSeconds:metadata.durationSeconds,checkedSeconds:0,peakDb:null,meanDb:null,silentRanges:[]};
  const end=endSeconds===undefined?Math.min(metadata.durationSeconds??startSeconds+120,startSeconds+120):endSeconds;
  if(!Number.isFinite(startSeconds)||startSeconds<0||!Number.isFinite(end)||end<=startSeconds||end-startSeconds>120||(metadata.durationSeconds!==null&&end>metadata.durationSeconds+0.05))throw new Error('请选择视频范围内最多 120 秒的声音');
  const output=await processMedia(['-loglevel','info','-ss',String(startSeconds),'-i',file,'-t',String(end-startSeconds),'-map','0:a:0','-vn','-af','silencedetect=noise=-45dB:d=0.4,volumedetect','-f','null','-'],Math.min(120000,30000+(end-startSeconds)*500),40000);
  const volume=label=>{
    const match=output.match(new RegExp(`${label}:\\s*(-?\\d+(?:\\.\\d+)?|-inf)\\s*dB`));
    return !match||match[1]==='-inf'?null:Number(match[1]);
  };
  const silentRanges=[],events=[...output.matchAll(/silence_(start|end):\s*([\d.]+)/g)];
  let opened=null;
  for(const [,kind,raw] of events){
    const time=Math.max(startSeconds,Math.min(end,startSeconds+Number(raw)));
    if(kind==='start')opened=time;
    else if(opened!==null){silentRanges.push({startSeconds:Math.round(opened*1000)/1000,endSeconds:Math.round(time*1000)/1000});opened=null;}
  }
  if(opened!==null)silentRanges.push({startSeconds:Math.round(opened*1000)/1000,endSeconds:Math.round(end*1000)/1000});
  return {hasAudio:true,durationSeconds:metadata.durationSeconds,checkedSeconds:Math.round((end-startSeconds)*1000)/1000,startSeconds,endSeconds:end,peakDb:volume('max_volume'),meanDb:volume('mean_volume'),silentRanges:silentRanges.slice(0,100),note:'音量与静音区间只能检查技术状态，不能确认台词、音乐或音效是否正确。'};
}

export async function composeVideoClips(clips,{aspectRatio='9:16',audioTracks=[]}={}){
  const sizes={'9:16':[720,1280],'16:9':[1280,720],'1:1':[960,960]};
  if(!sizes[aspectRatio])throw new Error('请选择支持的成片画幅');
  if(!Array.isArray(clips)||clips.length<1||clips.length>20)throw new Error('成片需要 1 到 20 段视频');
  if(!Array.isArray(audioTracks)||audioTracks.length>8)throw new Error('成片最多添加 8 条独立音轨');
  const prepared=[];
  let totalSeconds=0;
  for(const clip of clips){
    const metadata=await probeVideo(clip.file);
    const startSeconds=clip.startSeconds??0,endSeconds=clip.endSeconds??metadata.durationSeconds;
    if(!Number.isFinite(startSeconds)||!Number.isFinite(endSeconds)||startSeconds<0||endSeconds<=startSeconds||endSeconds-startSeconds>120||(metadata.durationSeconds!==null&&endSeconds>metadata.durationSeconds+0.05))throw new Error('片段时间超出视频范围');
    totalSeconds+=endSeconds-startSeconds;
    if(totalSeconds>300)throw new Error('成片最多 300 秒');
    const sourceAudioGainDb=clip.sourceAudioGainDb??0;
    if(!Number.isFinite(sourceAudioGainDb)||sourceAudioGainDb< -60||sourceAudioGainDb>12)throw new Error('视频原声音量超出范围');
    prepared.push({...clip,startSeconds,endSeconds,hasAudio:metadata.hasAudio&&!clip.muteSourceAudio,sourceAudioGainDb});
  }
  for(const track of audioTracks){
    const metadata=await probeAudioTrack(track.file);
    const length=track.sourceEndSeconds-track.sourceStartSeconds;
    if(!metadata.hasAudio||metadata.durationSeconds===null||!Number.isFinite(track.atSeconds)||!Number.isFinite(length)||!Number.isFinite(track.gainDb)||!Number.isFinite(track.fadeInSeconds)||!Number.isFinite(track.fadeOutSeconds)||track.sourceStartSeconds<0||length<=0||track.sourceEndSeconds>metadata.durationSeconds+0.05||track.atSeconds<0||track.atSeconds+length>totalSeconds+0.05||track.gainDb< -60||track.gainDb>12||track.fadeInSeconds<0||track.fadeOutSeconds<0||track.fadeInSeconds+track.fadeOutSeconds>length)throw new Error('独立音轨的时间或音量超出成片范围');
  }
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gugu-agent-compose-'));
  const [width,height]=sizes[aspectRatio];
  try{
    for(let index=0;index<prepared.length;index++){
      const clip=prepared[index],duration=clip.endSeconds-clip.startSeconds;
      const inputs=['-ss',String(clip.startSeconds),'-i',clip.file];
      if(!clip.hasAudio)inputs.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000');
      await processMedia(['-loglevel','error',...inputs,'-t',String(duration),'-map','0:v:0','-map',clip.hasAudio?'0:a:0':'1:a:0','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`,...(clip.hasAudio?['-af',`volume=${clip.sourceAudioGainDb}dB,aresample=async=1:first_pts=0,apad`]:[]),'-c:v','libx264','-preset','veryfast','-crf','22','-threads','2','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-y',path.join(directory,`clip-${index}.mp4`)],Math.min(300000,30000+duration*1500));
    }
    const list=path.join(directory,'clips.txt');
    await fs.writeFile(list,prepared.map((_,index)=>`file 'clip-${index}.mp4'`).join('\n'));
    const output=path.join(directory,'finished.mp4');
    await processMedia(['-loglevel','error','-safe','0','-f','concat','-i',list,'-c','copy','-movflags','+faststart','-y',output],120000);
    let finished=output;
    if(audioTracks.length){
      const inputs=['-i',output];
      const filters=[];
      for(let index=0;index<audioTracks.length;index++){
        const track=audioTracks[index],length=track.sourceEndSeconds-track.sourceStartSeconds;
        inputs.push('-ss',String(track.sourceStartSeconds),'-t',String(length),'-i',track.file);
        const chain=[`[${index+1}:a:0]aresample=48000`,`aformat=channel_layouts=stereo`,'asetpts=PTS-STARTPTS',`volume=${track.gainDb}dB`];
        if(track.fadeInSeconds)chain.push(`afade=t=in:st=0:d=${track.fadeInSeconds}`);
        if(track.fadeOutSeconds)chain.push(`afade=t=out:st=${Math.max(0,length-track.fadeOutSeconds)}:d=${track.fadeOutSeconds}`);
        chain.push(`adelay=${Math.round(track.atSeconds*1000)}:all=1`,'apad',`atrim=duration=${totalSeconds}`);
        filters.push(`${chain.join(',')}[track${index}]`);
      }
      filters.push(`[0:a:0]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${totalSeconds}[source]`);
      filters.push(`${['[source]',...audioTracks.map((_,index)=>`[track${index}]`)].join('')}amix=inputs=${audioTracks.length+1}:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,alimiter=limit=0.95[mixed]`);
      finished=path.join(directory,'mixed.mp4');
      await processMedia(['-loglevel','error',...inputs,'-filter_complex',filters.join(';'),'-map','0:v:0','-map','[mixed]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart','-t',String(totalSeconds),'-y',finished],Math.min(300000,60000+totalSeconds*1000));
    }
    const stat=await fs.stat(finished);
    if(!stat.size||stat.size>200_000_000)throw new Error('成片大小超出限制');
    return {data:await fs.readFile(finished),mimeType:'video/mp4',durationSeconds:Math.round(totalSeconds*1000)/1000,aspectRatio,width,height};
  }finally{await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}

const assTime=seconds=>{
  const centiseconds=Math.max(0,Math.round(seconds*100));
  return `${Math.floor(centiseconds/360000)}:${String(Math.floor(centiseconds/6000)%60).padStart(2,'0')}:${String(Math.floor(centiseconds/100)%60).padStart(2,'0')}.${String(centiseconds%100).padStart(2,'0')}`;
};
const assText=value=>String(value||'').replace(/\\/g,'／').replace(/[{}]/g,'').replace(/\r\n?|\n/g,'\\N').replace(/\u0000/g,'');
function karaokeText(cue){
  const words=(cue.words||[]).filter(word=>word.endSeconds>cue.startSeconds&&word.startSeconds<cue.endSeconds&&word.text).sort((a,b)=>a.startSeconds-b.startSeconds);
  if(!words.length)return assText(cue.text);
  let output='';
  for(let index=0;index<words.length;index++){
    const word=words[index],next=words[index+1];
    const end=Math.min(cue.endSeconds,next?.startSeconds??cue.endSeconds);
    const duration=Math.max(1,Math.round((end-Math.max(cue.startSeconds,word.startSeconds))*100));
    const value=String(word.text);
    const separator=output&&/[A-Za-z0-9]$/.test(String(words[index-1].text))&&/^[A-Za-z0-9]/.test(value)?' ':'';
    output+=`${separator}{\\k${duration}}${assText(value)}`;
  }
  return output;
}

export async function burnVideoCaptions(file,cues,{style='plain'}={}){
  const metadata=await probeVideo(file);
  if(!['plain','karaoke'].includes(style))throw new Error('字幕样式不可用');
  if(!Array.isArray(cues)||!cues.length||cues.length>1000)throw new Error('请选择 1 到 1000 条字幕');
  const visible=cues.map(cue=>({
    ...cue,startSeconds:Number(cue.startSeconds),endSeconds:Number(cue.endSeconds),text:String(cue.text||'').trim(),
  })).sort((a,b)=>a.startSeconds-b.startSeconds);
  if(visible.some(cue=>!Number.isFinite(cue.startSeconds)||!Number.isFinite(cue.endSeconds)||cue.startSeconds<0||cue.endSeconds<=cue.startSeconds||cue.endSeconds>(metadata.durationSeconds??3600)+0.05||cue.text.length>160||!cue.text))throw new Error('字幕文字或时间超出视频范围');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gugu-agent-captions-'));
  try{
    const width=metadata.width,height=metadata.height;
    const fontSize=Math.max(28,Math.round(width*0.055));
    const margin=Math.round(height*0.075);
    const dialogue=visible.map(cue=>`Dialogue: 0,${assTime(cue.startSeconds)},${assTime(cue.endSeconds)},Default,,0,0,0,,${style==='karaoke'?karaokeText(cue):assText(cue.text)}`).join('\n');
    const ass=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,${fontSize},&H00FFFFFF,&H0000D9FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,${Math.round(width*0.05)},${Math.round(width*0.05)},${margin},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${dialogue}\n`;
    await fs.writeFile(path.join(directory,'captions.ass'),ass,'utf8');
    await fs.mkdir(path.join(directory,'fonts'));
    await fs.copyFile(captionFontFile,path.join(directory,'fonts','NotoSansCJKsc-Regular.otf'));
    const output=path.join(directory,'captioned.mp4');
    await processMedia(['-loglevel','error','-i',file,'-vf','ass=filename=captions.ass:fontsdir=fonts','-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','22','-threads','2','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart','-y',output],Math.min(600000,60000+(metadata.durationSeconds??300)*1500),12000,directory);
    const stat=await fs.stat(output);
    if(!stat.size||stat.size>200_000_000)throw new Error('字幕成片大小超出限制');
    return {data:await fs.readFile(output),mimeType:'video/mp4',durationSeconds:metadata.durationSeconds,width,height,captionCount:visible.length,style};
  }finally{await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}
