import test from 'node:test';
import assert from 'node:assert/strict';
import {importedImageBounds} from '../public/features/agent/image-bounds.js';
test('imported images preserve natural proportions including very narrow images',()=>{
 for(const [width,height] of [[1920,1080],[1080,1920],[5000,100],[100,5000],[40,40]]){
  const bounds=importedImageBounds({width,height});
  assert.ok(Math.abs(bounds.width/bounds.height-width/height)<1e-10);
  assert.ok(bounds.width<=280&&bounds.height<=220);
 }
});
test('persisted placeholder dimensions are corrected after image decoding',()=>{
 assert.deepEqual(importedImageBounds({width:1920,height:1080},{width:280,height:220}),{width:280,height:157.5});
 assert.deepEqual(importedImageBounds({width:1000,height:2000},{width:400,height:220}),{width:400,height:800});
});
