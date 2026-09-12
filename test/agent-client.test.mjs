import test from 'node:test';
import assert from 'node:assert/strict';
import {createCreativeAgentClient} from '../public/features/agent/client.js';

test('conversation navigation discards responses from a previously open conversation',async()=>{
  const states=[];let releaseOld;
  const client=createCreativeAgentClient({projectId:'p',onState:s=>{if(s)states.push(s.id);},onError:()=>{},api:async(url,options)=>{
    if(url==='/api/agent/config')return {models:[{id:'m'}],configured:true};
    if(url.startsWith('/api/agent/sessions?'))return {sessions:[]};
    if(url==='/api/agent/sessions')return {id:'first',state:'idle',settings:{model:'m'}};
    if(url.endsWith('/old'))return new Promise(resolve=>{releaseOld=resolve;});
    if(url.endsWith('/new'))return {id:'new',state:'idle',settings:{model:'m'}};
    throw new Error(url);
  }});
  try{
    await client.start();
    const old=client.open('old');await client.open('new');releaseOld({id:'old',state:'idle'});await old;
    assert.deepEqual(states,['first','new']);
  }finally{client.dispose();}
});

test('new conversation explicitly creates a fresh session using selected model',async()=>{
  const bodies=[];
  const client=createCreativeAgentClient({projectId:'p',onState:()=>{},onError:()=>{},api:async(url,options)=>{
    if(url==='/api/agent/config')return {models:[{id:'m'}],configured:true};
    if(url.startsWith('/api/agent/sessions?'))return {sessions:[]};
    bodies.push(JSON.parse(options.body));return {id:`session-${bodies.length}`,state:'idle',settings:{model:'m'}};
  }});
  try{await client.start();await client.newConversation();assert.deepEqual(bodies[1],{projectId:'p',fresh:true,model:'m'});}finally{client.dispose();}
});
