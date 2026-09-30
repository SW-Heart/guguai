import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {composeVideoClips,probeVideo} from '../services/agent-video-analysis.mjs';

test('independent audio track mixes into a composed video',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'gugu-agent-mix-test-'));
  try{
    const video=path.join(directory,'clip.mp4');
    const audio=path.join(directory,'music.m4a');
    for(const args of [
      ['-f','lavfi','-i','color=c=blue:s=160x284:r=30','-f','lavfi','-i','sine=frequency=440:duration=2','-t','2','-c:v','libx264','-c:a','aac','-y',video],
      ['-f','lavfi','-i','sine=frequency=880:duration=2','-c:a','aac','-y',audio],
    ]){
      const result=spawnSync(ffmpeg,['-loglevel','error',...args],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
    }
    const composed=await composeVideoClips([{file:video,startSeconds:0,endSeconds:2}],{
      aspectRatio:'9:16',
      audioTracks:[{file:audio,atSeconds:0.25,sourceStartSeconds:0,sourceEndSeconds:1,gainDb:0,fadeInSeconds:0,fadeOutSeconds:0}],
    });
    const output=path.join(directory,'mixed.mp4');
    await writeFile(output,composed.data);
    const metadata=await probeVideo(output);
    assert.equal(metadata.hasAudio,true);
    assert.ok(metadata.durationSeconds>=1.9);
  }finally{await rm(directory,{recursive:true,force:true});}
});
