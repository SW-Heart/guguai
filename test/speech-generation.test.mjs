import { createVoiceFilterState,voiceFilterOptions,toggleVoiceFilter,voiceFacets,voiceMatchesFilters,voiceLanguage } from '../public/features/speech/voice-filters.js';
import { speechVoiceGroups } from '../public/features/speech/composer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {closeDatabase,openDatabase,resetForTests,sql} from '../lib/db.mjs';
import {insertUser,findGeneration,saveGenerationRecord} from '../lib/store.mjs';
import {configureLedger,grantSignupBonus,chargeGenerationMicro,walletOf,refundGenerationMicro} from '../lib/ledger.mjs';
import {currentPricing,createPricingVersion,modelPriceFields} from '../lib/pricing.mjs';
import {createSpeechService,speechQuote,validateSpeechInput} from '../services/speech-generation.mjs';
import {generateMinimaxSpeech,decodeSpeechAudio,getMinimaxSystemVoices,normalizeSystemVoices} from '../providers/minimax-speech.mjs';
import {createGenerationRouteHandler} from '../server/routes/generations.mjs';
import {createGenerationRequest,findGenerationRequest} from '../repositories/generation-jobs.mjs';
import {generationRequestFingerprint} from '../lib/generation-service.mjs';
import {speechCharacters,systemVoices} from '../public/features/speech/catalog.js';
import {createCanvasGenerationDraft,canvasGenerationPayload} from '../public/features/drama/canvas-generation.js';
import {normalizeDirectorWorkspace} from '../public/features/drama/director-actions.js';
import {resolveGenerationInputs,generationRequestDraft,linkError} from '../public/features/drama/canvas-links.js';
const input={type:'audio',speechMode:'tts',modelId:'speech-2.8-hd',prompt:'你好，世界。',duration:10,voiceId:'female-tianmei',speed:1,emotion:'auto'};

test('speech validates mode, voice parameters and text before charging',()=>{
  assert.equal(validateSpeechInput(input).duration,undefined);assert.equal(speechCharacters('你好 A!'),7);
  for(const patch of [{speed:Infinity},{speed:3},{emotion:'fake'},{modelId:'gpt-image-2'},{speechMode:'clone'},{prompt:''},{referenceAssetIds:['x']}])assert.throws(()=>validateSpeechInput({...input,...patch}),e=>e.statusCode===400);
  assert.throws(()=>validateSpeechInput({...input,speechMode:'design',modelId:'minimax-voice-design',previewText:''}),/试听文本/);
});

test('canvas speech survives save/reopen and resolves text plus custom voice without uploading trial audio',()=>{
  const draft=createCanvasGenerationDraft('audio',{speech:{enabled:true}});draft.prompt='你好';draft.voiceId='voice-1';draft.duration=30;
  const restored=normalizeDirectorWorkspace({generationDrafts:[draft]}).generationDrafts[0];
  assert.equal(restored.type,'audio');assert.equal(restored.voiceId,'voice-1');assert.equal(canvasGenerationPayload(restored).duration,undefined);
  const links=[{from:'text',to:draft.id},{from:'voice',to:draft.id}];
  const describe=id=>id==='text'?{kind:'text',label:'台词',text:'你好世界'}:{kind:'audio',label:'角色声音',voiceId:'voice-2',file:{id:'trial',kind:'audio'}};
  const resolved=resolveGenerationInputs(draft,links,describe),request=generationRequestDraft(draft,resolved);
  assert.equal(request.voiceId,'voice-2');assert.equal(request.attachments.length,0);assert.equal(request.prompt,'你好世界\n\n你好');
  assert.equal(linkError(draft,{id:'voice',...describe('voice')}),'');
  assert.ok(linkError(draft,{id:'raw',kind:'audio',file:{id:'raw'}}));
});

test('MiniMax requests select the exact TTS model and design fields without inventing duration parameters',async()=>{
  const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,...options,body:JSON.parse(options.body)});return {ok:true,json:async()=>({base_resp:{status_code:0},data:{audio:'0102'},trial_audio:'0304',voice_id:'upstream-private-voice'})};};
  await generateMinimaxSpeech({...input,emotion:'happy'},'owned-voice',{apiKey:'test',fetchImpl});
  assert.equal(calls[0].body.model,input.modelId);assert.equal(calls[0].body.voice_setting.voice_id,'owned-voice');assert.equal(calls[0].body.voice_setting.emotion,'happy');assert.equal(calls[0].body.duration,undefined);
  const result=await generateMinimaxSpeech({...input,id:'test-job',speechMode:'design',previewText:'试听'},'',{apiKey:'test',fetchImpl});
  assert.equal(calls[1].body.preview_text,'试听');assert.equal(calls[1].body.prompt,input.prompt);assert.equal(calls[1].body.model,undefined);assert.equal(result.providerVoiceId,'upstream-private-voice');
  assert.throws(()=>decodeSpeechAudio('not audio'));
  await assert.rejects(generateMinimaxSpeech(input,'owned',{apiKey:'',fetchImpl}),/暂不可用/);
});

test('speech admin pricing, ownership, idempotent debit, price changes and refund use the shared ledger',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'speech-test-'));resetForTests();openDatabase({file:path.join(dir,'studio.db')});
  try{
    const now=new Date().toISOString();const user={id:randomUUID(),username:'speech-test',role:'admin',status:'active',passwordHash:'x',credits:0,creditBalanceMicro:0,creditHeldMicro:0,createdAt:now,updatedAt:now};insertUser(user);
    configureLedger({llmRates:{inputMicroPerToken:1,outputMicroPerToken:1},llmProtocol:'test',llmModel:'test'});await grantSignupBonus(user.id,50);
    const service=createSpeechService({sql,currentPricing,configured:()=>true,designEnabled:()=>true});
    const fields=modelPriceFields();for(const id of ['speech-2.8-hd','speech-2.8-turbo','minimax-voice-design']){const field=fields.find(f=>f.modelId===id);assert.equal(field.unit,id==='minimax-voice-design'?'音色（首次配音）':'万字符');assert.equal(field.billingUnit,undefined);}
    const before=service.quote(user.id,input);createPricingVersion({imagePerRequest:1,videoPerSecond:1,modelPrices:{'speech-2.8-hd:标准':25},actorUserId:user.id});
    const quote=service.quote(user.id,input);assert.equal(quote.characters,10);assert.equal(quote.credits,.025);assert.notEqual(before.priceVersion,quote.priceVersion);assert.equal(speechQuote(input,{version:1,modelPrices:{'speech-2.8-hd:标准':0}}).credits,0);
    const task={id:randomUUID(),prompt:'低沉男声',voiceName:'男主',createdAt:now};const voiceId=service.saveVoice(user.id,task,'provider-secret-voice');
    assert.equal(service.voice(user.id,voiceId),'provider-secret-voice');assert.throws(()=>service.voice('someone-else',voiceId),/不可用/);assert.ok(!JSON.stringify(service.voices(user.id)).includes('provider-secret-voice'));
    const scope={deviceId:'test-device',workspaceId:'test-workspace'},queued=[];
    const handler=createGenerationRouteHandler({speech:service,findGeneration,saveGeneration:saveGenerationRecord,createGenerationRequest,findGenerationRequest,generationRequestFingerprint,chargeGenerationMicro,walletOf,randomId:randomUUID,now:()=>now,enqueueGenerationJob:job=>queued.push(job),publicGeneration:t=>({id:t.id,status:t.status,type:t.type,creditCost:t.creditCost}),runtimeMetrics:{idempotencyConflicts:0}});
    const request={...input,requestId:'speech-idempotent-123',expectedPriceVersion:quote.priceVersion};
    const result=await handler.submit({user,scope,input:request});assert.equal(result.status,202);assert.equal(walletOf(user.id).balance,49.975);
    assert.equal((await handler.submit({user,scope,input:request})).status,202);assert.equal(walletOf(user.id).balance,49.975);assert.equal(queued.length,1);
    assert.equal((await handler.submit({user,scope,input:{...request,prompt:'不同台词'}})).status,409);
    assert.equal((await handler.submit({user,scope,input:{...input,expectedPriceVersion:before.priceVersion}})).status,409);assert.equal(walletOf(user.id).balance,49.975);
    await refundGenerationMicro(user.id,result.data.id,quote.costMicro);await refundGenerationMicro(user.id,result.data.id,quote.costMicro);assert.equal(walletOf(user.id).balance,50);
    const customInput={...input,voiceId};
    assert.equal(service.quote(user.id,customInput).voiceCredits,99);
    const activationTask={id:'first-activation',voiceId,activateVoice:true,speechMode:'tts'};
    service.reserveVoice(user.id,activationTask);
    assert.throws(()=>service.quote(user.id,customInput),e=>e.statusCode===409);
    service.releaseVoice(user.id,activationTask);assert.equal(service.quote(user.id,customInput).voiceCredits,99);
    service.reserveVoice(user.id,activationTask);service.activateVoice(user.id,activationTask);
    assert.equal(service.quote(user.id,customInput).voiceCredits,0);
    const closedService=createSpeechService({sql,currentPricing,configured:()=>true});
    assert.throws(()=>closedService.quote(user.id,{...input,speechMode:'design'}),e=>e.statusCode===403);
    const designQuote=service.quote(user.id,{...input,speechMode:'design',modelId:'minimax-voice-design',previewText:'你好'});
    assert.equal(designQuote.characters,4);assert.equal(designQuote.credits,.008);assert.equal(designQuote.voiceCredits,0);
  }finally{closeDatabase({checkpoint:false});rmSync(dir,{recursive:true,force:true});}
});


test('full system voice catalog refreshes once, validates new official IDs, falls back and never shares upstream custom voices',async()=>{
  assert.ok(systemVoices.length>=303);assert.equal(new Set(systemVoices.map(v=>v.id)).size,systemVoices.length);
  let payload;
  const fetched=await getMinimaxSystemVoices({apiKey:'test',fetchImpl:async(url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({base_resp:{status_code:0},system_voice:[{voice_id:'new-official-voice',voice_name:'新版音色',description:['清亮','自然']}],voice_generation:[{voice_id:'another-users-private-voice'}]})};}});
  assert.equal(payload.voice_type,'system');assert.equal(fetched.length,1);assert.equal(fetched[0].description,'清亮；自然');
  assert.deepEqual(normalizeSystemVoices([{voice_id:''},{voice_id:'a',voice_name:'甲'},{voice_id:'a',voice_name:'重复'}]).map(v=>v.name),['甲']);
  const dir=mkdtempSync(path.join(os.tmpdir(),'speech-catalog-'));resetForTests();openDatabase({file:path.join(dir,'studio.db')});
  try{
    let calls=0,time=0,fail=false;
    const service=createSpeechService({sql,currentPricing,configured:()=>true,clock:()=>time,loadSystemVoices:async()=>{calls++;if(fail)throw new Error('offline');return fetched;}});
    await Promise.all([service.refreshVoices(),service.refreshVoices()]);assert.equal(calls,1);
    assert.equal(service.voice('user','new-official-voice'),'new-official-voice');assert.equal(service.voices('user').length,1);
    assert.ok(!JSON.stringify(service.voices('user')).includes('another-users-private-voice'));
    await service.refreshVoices();assert.equal(calls,1);
    time=16*60*1000;fail=true;await service.refreshVoices();assert.equal(calls,2);assert.equal(service.voice('user','new-official-voice'),'new-official-voice');
    const fallback=createSpeechService({sql,currentPricing,loadSystemVoices:async()=>{throw new Error('offline');}});await fallback.refreshVoices();assert.equal(fallback.voices('user').length,systemVoices.length);
  }finally{closeDatabase({checkpoint:false});rmSync(dir,{recursive:true,force:true});}
});

test('voice groups put curated common voices first, keep custom voices separate and include every official voice once',()=>{
  const custom={id:'voice-personal',name:'我的角色',description:'已保存的角色声音',type:'custom'};
  const groups=speechVoiceGroups([...systemVoices,custom,systemVoices[0]]);
  assert.equal(groups[0].label,'热门推荐');assert.equal(groups[0].voices[0].id,'Chinese (Mandarin)_News_Anchor');
  assert.equal(groups[1].label,'我的音色');assert.equal(groups[1].voices[0].id,custom.id);
  const ids=groups.flatMap(group=>group.voices.map(voice=>voice.id));assert.equal(ids.length,systemVoices.length+1);assert.equal(new Set(ids).size,ids.length);
  assert.ok(groups.find(group=>group.label==='粤语').voices.every(voice=>voice.id.startsWith('Cantonese_')));
  assert.ok(groups.find(group=>group.label==='韩语').voices.every(voice=>voice.id.startsWith('Korean_')));
});

test('voice filters offer languages only, default to all and allow deselecting every language',()=>{
  const state=createVoiceFilterState(),options=voiceFilterOptions(systemVoices);
  assert.ok(systemVoices.every(voice=>voiceMatchesFilters(voiceFacets(voice),state.selected)));
  assert.ok(systemVoices.every(voice=>voiceLanguage(voice)!=='未注明'));
  toggleVoiceFilter(state,'language','英语',options.language.options);
  const english=systemVoices.find(voice=>voiceLanguage(voice)==='英语'),chinese=systemVoices.find(voice=>voiceLanguage(voice)==='普通话');
  assert.equal(voiceMatchesFilters(voiceFacets(english),state.selected),false);assert.equal(voiceMatchesFilters(voiceFacets(chinese),state.selected),true);
  toggleVoiceFilter(state,'language','英语',options.language.options);assert.equal(state.selected.language,null);
  assert.deepEqual(Object.keys(options),['language']);assert.deepEqual(Object.keys(state.selected),['language']);
  for(const [language] of options.language.options)toggleVoiceFilter(state,'language',language,options.language.options);
  assert.deepEqual(state.selected.language,[]);
  assert.ok(systemVoices.every(voice=>!voiceMatchesFilters(voiceFacets(voice),state.selected)));
  const groups=speechVoiceGroups(systemVoices);const flat=groups.flatMap(group=>group.voices);
  const firstMissing=flat.findIndex(voice=>!voice.description);assert.ok(flat.slice(0,firstMissing).every(voice=>voice.description));assert.ok(flat.slice(firstMissing).every(voice=>!voice.description));
});
