import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentTools} from '../lib/agent/tools.mjs';
import {createAgentAssetMetadataSync} from '../public/features/drama/agent-asset-metadata.js';
import {projectAssetGroups} from '../public/features/drama/project-assets.js';

test('reference naming updates real files and categories while preserving IDs and extensions',async()=>{
  const assets=new Map([['person',{id:'person',name:'生成图片.png',kind:'image'}],['room',{id:'room',name:'生成图片2.jpg',kind:'image'}]]);
  const scope={deviceId:'device',workspaceId:'workspace'},writes=[];
  const tools=createAgentTools({findAsset:(user,id,s)=>{assert.equal(user,'user');assert.equal(s,scope);return assets.get(id);},saveAsset:async(user,asset)=>{writes.push(asset);assets.set(asset.id,asset);}});
  const session={userId:'user',scope,doc:{}};
  await tools.execute('references_bind',{references:[{id:'person',label:'林默三视图',category:'character'},{id:'room',label:'旅馆大厅',category:'location'}]},session);
  assert.equal(assets.get('person').name,'林默三视图.png');
  assert.equal(assets.get('room').name,'旅馆大厅.jpg');
  assert.deepEqual(session.doc.referenceBindings.map(item=>[item.id,item.label]),[['person','林默三视图'],['room','旅馆大厅']]);
  assert.equal(writes.length,2);
  const groups=projectAssetGroups([...assets.values()],{});
  assert.deepEqual(groups.find(group=>group.id==='character').items.map(item=>item.id),['person']);
  assert.deepEqual(groups.find(group=>group.id==='location').items.map(item=>item.id),['room']);
  assert.equal(groups.find(group=>group.id==='other').items.length,0);
  await tools.execute('assets_update',{assetId:'person',name:'林默雨衣.png',category:'character'},session);
  assert.equal(assets.get('person').name,'林默雨衣.png');
  assert.equal(session.doc.assetUpdates.person.name,'林默雨衣.png');
  await assert.rejects(tools.execute('assets_update',{assetId:'foreign',name:'另一张图'},session),/不属于当前工作空间/);
  await assert.rejects(tools.execute('assets_update',{assetId:'person',category:'invalid'},session),/只能使用/);
  await assert.rejects(tools.execute('assets_update',{assetId:'person'},session),/请提供/);
  assert.equal(writes.length,3);
  await assert.rejects(tools.execute('references_bind',{references:[{id:'person',label:'角色'}]},session),/缺少 category/);
});

test('desktop metadata sync waits for files, deduplicates polling and preserves subsequent manual renames',async()=>{
  let file=null,calls=0,changes=0,release;
  const sync=createAgentAssetMetadataSync({findFile:()=>file,current:()=>true,onChange:()=>changes++,onError:error=>{throw error;},renameFile:async(asset,name)=>{calls++;await new Promise(resolve=>release=resolve);asset.name=name;}});
  const metadata=[{id:'cloud',name:'林默.png',category:'character'}];
  sync(metadata);assert.equal(calls,0);
  file={id:'cloud',localId:'local',localStatus:'saved',name:'生成图片.png'};
  sync(metadata);sync(metadata);assert.equal(calls,1);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(file.name,'林默.png');assert.equal(changes,1);
  file.name='用户自己的名称.png';sync(metadata);assert.equal(calls,1);
  sync([{...metadata[0],name:'林默雨衣.png'}]);assert.equal(calls,2);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(file.name,'林默雨衣.png');
});
