import test from 'node:test';
import assert from 'node:assert/strict';
import {generationPromptMarkup,generationPromptSegments,generationPromptCodec,generationSegmentsText,generationSelection,restoreGenerationSelection} from '../public/features/drama/canvas-generation-editor.js';
import {normalizeDirectorWorkspace} from '../public/features/drama/director-actions.js';
import {canvasGenerationPayload} from '../public/features/drama/canvas-generation.js';

const text=value=>({nodeType:3,nodeValue:value});
const element=(nodeName,children=[],dataset={},mention=false)=>({nodeType:1,nodeName,childNodes:children,dataset,classList:{contains:name=>mention&&name==='video-prompt-mention'}});

test('legacy references render image/video thumbnails using the existing inline label classes',()=>{
  const draft={prompt:'参考 @猫.png 与 @动作.mp4',attachments:[{id:'cat',name:'猫.png',kind:'image',url:'/cat.png'},{id:'motion',name:'动作.mp4',kind:'video',url:'/motion.mp4'}]};
  const html=generationPromptMarkup(draft);
  assert.match(html,/class="video-prompt-mention"/);assert.match(html,/<img src="\/cat.png"/);assert.match(html,/<video src="\/motion.mp4"/);
  assert.match(html,/contenteditable="false"/);assert.match(html,/data-video-prompt-mention-id="motion"/);
});

test('inline labels serialize as plain references while preserving IDs, line breaks and surrounding text',()=>{
  const chip=element('SPAN',[],{videoPromptMentionId:'cat',videoPromptMentionLabel:'猫.png'},true);
  const editor=element('DIV',[text('参考 '),chip,element('BR'),element('DIV',[text('镜头\u00a0推进')])]);
  const segments=generationPromptSegments(editor);
  assert.equal(generationSegmentsText(segments),'参考 @猫.png\n镜头 推进\n');
  assert.equal(generationPromptCodec.serialize(editor),generationSegmentsText(segments));
  assert.deepEqual(segments[1],{id:'cat',label:'猫.png'});
});

test('saved labels preserve duplicate file names and reference order across reopening',()=>{
  const draft={id:'canvas-gen-labels',type:'video',modelId:'video',mode:'REFERENCE',aspect:'16:9',quality:'720p',duration:5,
    prompt:'@参考.png 然后 @参考.png',promptSegments:[{id:'second',label:'参考.png'},' 然后 ',{id:'first',label:'参考.png'}],
    attachments:[{id:'first',name:'参考.png',kind:'image',url:'/first.png'},{id:'second',name:'参考.png',kind:'image',url:'/second.png'}]};
  const restored=normalizeDirectorWorkspace({generationDrafts:[draft]}).generationDrafts[0];
  const html=generationPromptMarkup(restored);
  assert.ok(html.indexOf('id="second"')<html.indexOf('id="first"'));
  const mode={generationType:'REFERENCE',aspectRatios:['16:9'],qualityOptions:['720p'],durations:[5],referenceLimits:{image:2,total:2}};
  assert.equal(canvasGenerationPayload(restored,{videoCapabilities:{models:[{id:'video',modes:[mode]}]}}).prompt,'Image2 然后 Image1');
});

test('removed files and untrusted text cannot introduce executable editor markup',()=>{
  const draft={prompt:'<script> @<猫>',promptSegments:['<script> ',{id:'cat',label:'<猫>'}],attachments:[]};
  assert.equal(generationPromptMarkup(draft),'&lt;script&gt; @&lt;猫&gt;');
  draft.attachments=[{id:'cat',name:'<猫>',kind:'image',url:'/cat.png" onerror="alert(1)'}];
  const html=generationPromptMarkup(draft);
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes(' onerror="'));assert.match(html,/&quot; onerror=&quot;/);
});

test('caret bookmarks inside paragraphs and after labels preserve their exact text position',()=>{
  const chip=element('SPAN',[],{videoPromptMentionId:'cat',videoPromptMentionLabel:'猫'},true);
  const following=text(' 然后 @');
  const paragraph=element('DIV',[chip,following]);
  const editor=element('DIV',[text('开头'),element('BR'),paragraph]);
  const wire=node=>{node.childNodes?.forEach(child=>{child.parentNode=node;wire(child);});};wire(editor);
  const selection={rangeCount:1,anchorNode:following,focusNode:following,getRangeAt:()=>({startContainer:following,startOffset:5,endContainer:following,endOffset:5}),removeAllRanges(){},addRange(range){this.restored=range;}};
  editor.contains=()=>true;editor.focus=()=>{};
  editor.ownerDocument={defaultView:{getSelection:()=>selection},createRange:()=>({setStart(node,offset){this.start=[node,offset];},setEnd(node,offset){this.end=[node,offset];}})};
  const offsets=generationSelection(editor);
  assert.deepEqual(offsets,[10,10]);
  restoreGenerationSelection(editor,offsets);
  assert.deepEqual(selection.restored.start,[following,5]);
  assert.deepEqual(selection.restored.end,[following,5]);
});
