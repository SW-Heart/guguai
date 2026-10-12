import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read=file=>readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8');

test('project bar and conversation float above a full-bleed canvas', () => {
  const css=read('styles.css');
  assert.match(css,/#agentView \.director-workspace\.agent-space:not\(\.agent-home\)\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/#agentView \.agent-space:not\(\.agent-home\)>\.dw-board\{padding-top:0\}/);
  assert.match(css,/#agentView \.agent-space:not\(\.agent-home\)>\.dw-agent\{grid-area:1\/1\/2\/2;justify-self:end;[^}]*border-radius:20px;[^}]*backdrop-filter/);
  assert.match(css,/#agentView \.agent-space:not\(\.agent-home\)>\.dw-project-chrome\{[^}]*right:calc\(var\(--dw-agent-inset\) \+ var\(--dw-float-gap\)\);[^}]*background:transparent;[^}]*pointer-events:none/);
  assert.match(css,/#agentView \.director-workspace\.agent-space\.agent-collapsed\{--dw-agent-inset:0px\}/);
  // Canvas controls that would sit under the conversation move into the open area.
  assert.match(css,/\.dw-generation-dock\{left:calc\(\(100% - var\(--dw-agent-inset\)\) \/ 2\)/);
  assert.match(css,/\.dw-canvas \.bottom-4\.right-6\{right:calc\(var\(--dw-agent-inset\) \+ 24px\)/);
});

test('fitting and placement ignore the canvas area covered by the conversation', () => {
  const source=read('features/drama/director-workspace.js');
  const helper=source.slice(source.indexOf('  function visibleCanvasWidth('),source.indexOf('  function applyAgentStoryboards('));
  const rect=right=>({getBoundingClientRect:()=>({left:right,right})});
  const surface={clientWidth:1200,getBoundingClientRect:()=>({left:0,right:1200})};
  const run=(chatMode,agentLeft)=>{
    const context=vm.createContext({bridge:{agentMode:true},chatMode,host:{querySelector:()=>agentLeft==null?null:rect(agentLeft)}});
    vm.runInContext(helper,context);
    return context.visibleCanvasWidth(surface);
  };
  assert.equal(run('side',728),728);
  assert.equal(run('minimized',728),1200);
  assert.equal(run('side',null),1200);
  assert.equal(run('side',100),600);
});
