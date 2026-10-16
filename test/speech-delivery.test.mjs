import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase,closeDatabase,sql} from '../lib/db.mjs';
import {insertUser,findGeneration,findAsset,saveGenerationRecord} from '../lib/store.mjs';
import {grantSignupBonus,walletOf,chargeGenerationMicro} from '../lib/ledger.mjs';

function wave(){const samples=6400,rate=32000,data=Buffer.alloc(44+samples*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)data.writeInt16LE(Math.round(2000*Math.sin(i*440*2*Math.PI/rate)),44+i*2);return data;}

test('speech jobs deliver real audio and reusable voices with exact character charges and private provider IDs',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'speech-delivery-'));
  process.env.DATA_DIR=dir;process.env.MINIMAX_API_KEY='test-only';
  const {__test}=await import('../server.mjs');openDatabase({file:path.join(dir,'studio.db')});
  const previousFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{assert.equal(new URL(url).host,'api.minimax.cn');const body=JSON.parse(options.body);if(new URL(url).pathname.endsWith('/get_voice'))return {ok:true,json:async()=>({base_resp:{status_code:0},system_voice:[{voice_id:'female-tianmei',voice_name:'甜美女声'}]})};calls.push(body);return {ok:true,json:async()=>({base_resp:{status_code:0},voice_id:'private-provider-voice',trial_audio:wave().toString('hex'),data:{audio:wave().toString('hex')},extra_info:{audio_length:200,usage_characters:4}})};};
  try {
    const time=new Date().toISOString(),user={id:randomUUID(),username:'audio-delivery',passwordHash:'x',role:'user',status:'active',credits:0,creditBalanceMicro:0,creditHeldMicro:0,createdAt:time,updatedAt:time};insertUser(user);await grantSignupBonus(user.id,200);
    const scope={deviceId:'speech-device',workspaceId:'speech-workspace'};
    const designInput={type:'audio',speechMode:'design',modelId:'minimax-voice-design',prompt:'低沉自然的男声',previewText:'你好',voiceName:'男主',requestId:'speech-design-test'};
    await assert.rejects(__test.generationRoute.submit({user,scope,input:designInput}),e=>e.statusCode===403);
    assert.equal(walletOf(user.id).balance,200);
    // Already accepted jobs remain recoverable while new design requests are closed.
    const task={...designInput,id:'speech-design-test',ownerId:user.id,originDeviceId:scope.deviceId,originWorkspaceId:scope.workspaceId,createdAt:time,updatedAt:time,status:'queued',creditCost:.008,creditCostMicro:8000};
    await chargeGenerationMicro(user.id,task.id,task.creditCostMicro,{onCharged:()=>saveGenerationRecord(user.id,task)});
    await __test.runSpeechGeneration(user.id,task);
    const saved=findGeneration(user.id,task.id,scope),asset=findAsset(user.id,saved.assetId,scope);
    assert.equal(saved.status,'completed');assert.equal(asset.kind,'audio');assert.equal(asset.mimeType,'audio/wav');assert.equal(asset.deliveryStatus,'awaiting_local');assert.equal(asset.duration,.2);
    assert.deepEqual(readFileSync(path.join(dir,'users',user.id,'files',asset.storageName)),wave());
    assert.ok(!JSON.stringify(__test.publicGeneration(saved)).includes('private-provider-voice'));
    assert.ok(sql('SELECT id FROM speech_voices WHERE user_id=:userId').get({userId:user.id}));
    for(let index=0;index<2;index++){
      const result=await __test.generationRoute.submit({user,scope,input:{type:'audio',speechMode:'tts',modelId:'speech-2.8-hd',prompt:'你好',voiceId:saved.voiceId,requestId:`speech-tts-test-${index}`}});
      assert.equal(result.status,202);assert.equal(result.data.creditCost,index===0?99.014:.014);
      await __test.runSpeechGeneration(user.id,findGeneration(user.id,result.data.id,scope));
    }
    assert.equal(calls.length,3);assert.equal(calls[1].voice_setting.voice_id,'private-provider-voice');
    assert.ok(Math.abs(walletOf(user.id).balance-100.964)<.000001);
  }finally{globalThis.fetch=previousFetch;closeDatabase({checkpoint:false});rmSync(dir,{recursive:true,force:true});}
});
