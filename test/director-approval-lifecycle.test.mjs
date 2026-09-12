import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/features/drama/director-workspace.js',import.meta.url),'utf8');
const render=source.slice(source.indexOf('    const approval=agentState?.approval;'),source.indexOf("    const sendButton=root.querySelector"));
function setup(approval){
  let details={open:true},html='previous approval';
  const plan={dataset:{approvalSignature:'previous'},get innerHTML(){return html;},set innerHTML(value){html=value;details=value?{open:false,setAttribute(){this.open=true;}}:null;},querySelector(selector){return selector==='details'?details:null;}};
  const context={agentState:{approval},root:{querySelector:()=>plan},escape:String};
  vm.createContext(context);
  return {plan,run:()=>vm.runInContext(`(function(){${render}})()`,context)};
}
test('removing an expanded approval after confirmation, cancellation or navigation does not throw',()=>{
  for(const approval of [null,undefined]){
    const {plan,run}=setup(approval);
    assert.doesNotThrow(run);
    assert.equal(plan.innerHTML,'');assert.equal(plan.querySelector('details'),null);
    assert.doesNotThrow(run);
  }
});
test('updating an existing approval preserves its expanded description',()=>{
  const {plan,run}=setup({id:'approval',title:'生成图片',prompt:'new description'});
  run();assert.equal(plan.querySelector('details').open,true);
});
