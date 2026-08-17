import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionPlan, normalizeProductionScenes, storyboardGateReport } from '../lib/storyboard-engine.mjs';
import { buildShotVideoPrompt } from '../public/video-prompt.js';

function validPlan() {
  const scenes = normalizeProductionScenes([{ heading:'山巅', beats:[
    { id:'S01-B01', kind:'action', text:'女侠盘坐在悬崖边吃西瓜。', speaker:'', delivery:'' },
    { id:'S01-B02', kind:'dialogue', text:'还是西瓜好吃。', speaker:'女侠', delivery:'满足' },
    { id:'S01-B03', kind:'action', text:'女侠听见轰鸣后抬头。', speaker:'', delivery:'' },
  ] }]);
  const shots = [
    { sceneNumber:1, sourceBeatIds:['S01-B01','S01-B02'], duration:6, narrativeFunction:'建立悠闲状态', action:'女侠舀起一勺西瓜并吃下', startStateId:'S01-Q0', startState:'盘坐持瓜', endStateId:'S01-Q1', endState:'咽下西瓜', resourceNames:['女侠'], motionPlan:[{startSecond:0,endSecond:.5,subjectMotion:'保持首帧姿态',cameraMotion:'固定',amplitude:'静止',speed:'静止'},{startSecond:.5,endSecond:2,subjectMotion:'右手抬起勺子十厘米',cameraMotion:'缓慢推进',amplitude:'小',speed:'慢'},{startSecond:2,endSecond:4,subjectMotion:'将勺子送入口中并咀嚼',cameraMotion:'继续缓慢推进',amplitude:'中',speed:'中'},{startSecond:4,endSecond:5.5,subjectMotion:'右手放下勺子并咽下',cameraMotion:'减速停止',amplitude:'小',speed:'慢'},{startSecond:5.5,endSecond:6,subjectMotion:'停住并定格尾帧',cameraMotion:'固定',amplitude:'静止',speed:'静止'}] },
    { sceneNumber:1, sourceBeatIds:['S01-B03'], duration:6, narrativeFunction:'异常声音打破平静', action:'女侠停止动作并抬头', startStateId:'S01-Q1', startState:'咽下西瓜', endStateId:'S01-Q2', endState:'抬头望向天空', resourceNames:['女侠'], motionPlan:[{startSecond:0,endSecond:.5,subjectMotion:'保持首帧姿态',cameraMotion:'固定',amplitude:'静止',speed:'静止'},{startSecond:.5,endSecond:2.5,subjectMotion:'停止咀嚼，眼睛向上移动',cameraMotion:'固定',amplitude:'微小',speed:'慢'},{startSecond:2.5,endSecond:4.5,subjectMotion:'下巴抬起十五度',cameraMotion:'缓慢推进',amplitude:'小',speed:'慢'},{startSecond:4.5,endSecond:5.5,subjectMotion:'目光锁定天空',cameraMotion:'停止',amplitude:'微小',speed:'极慢'},{startSecond:5.5,endSecond:6,subjectMotion:'停住并定格尾帧',cameraMotion:'固定',amplitude:'静止',speed:'静止'}] },
  ];
  return { scenes, shots };
}

test('production gates require exact beat coverage and continuity tokens', () => {
  const plan = validPlan();
  assert.doesNotThrow(() => assertProductionPlan(plan));
  plan.shots[1].sourceBeatIds = ['S01-B02','S01-B03'];
  plan.shots[1].startStateId = 'S01-WRONG';
  const failed = storyboardGateReport(plan).filter(gate => !gate.ok);
  assert.ok(failed.find(gate => gate.id === 'source-coverage').problems.some(problem => problem.includes('重复认领')));
  assert.ok(failed.find(gate => gate.id === 'continuity').problems.some(problem => problem.includes('不一致')));
});

test('production gates reject multi-cut instructions inside one generated clip', () => {
  const plan = validPlan();
  plan.shots[0].action = '女侠吃一口西瓜，切到战斗机，再切回女侠';
  assert.throws(() => assertProductionPlan(plan), /一次视频生成只能对应一个连续镜头/);
});

test('video compiler emits an executable motion timeline and ignores raw prompt text', () => {
  const plan = validPlan();
  const scene = { ...plan.scenes[0], heading:'山巅', location:'悬崖边', timeOfDay:'白天', lighting:'午后侧光' };
  const shot = { ...plan.shots[0], shotNumber:1, title:'吃瓜', shotSize:'中景', cameraMovement:'固定', aspectRatio:'9:16', prompt:'错误的旧提示词：站在仙境山巅', visualDirection:'人物位于画面下部；切到无关宫殿', sound:'山风', negativePrompt:'禁止新增人物', generation:{type:'TEXT'} };
  const prompt = buildShotVideoPrompt({ project:{workflowVersion:3,title:'测试'}, shot, scene, resources:[] });
  assert.match(prompt, /还是西瓜好吃/);
  assert.match(prompt, /人物位于画面下部/);
  assert.match(prompt, /0.5–2s｜主体：右手抬起勺子十厘米｜幅度：小｜速度：慢｜摄影机：缓慢推进/);
  assert.match(prompt, /尾帧 6.0s：咽下西瓜/);
  assert.doesNotMatch(prompt, /错误的旧提示词/);
  assert.doesNotMatch(prompt, /无关宫殿/);
  assert.match(prompt, /中途切镜/);
});

test('first-last compiler lets images own appearance instead of dumping the full character bible', () => {
  const plan = validPlan();
  const shot = { ...plan.shots[1], shotNumber:2, title:'抬头', shotSize:'近景', cameraMovement:'缓推', aspectRatio:'16:9', generation:{type:'FIRST&LAST'} };
  const resources = [{type:'character',name:'女侠',description:'闭关三百年',bible:{appearance:'杏眼长发',costume:'白色仙侠长袍',stateNotes:'发簪固定'}}];
  const prompt = buildShotVideoPrompt({project:{workflowVersion:3},shot,scene:plan.scenes[0],resources});
  assert.match(prompt, /首帧为唯一动作起点/);
  assert.match(prompt, /参考图锁定：女侠/);
  assert.doesNotMatch(prompt, /杏眼长发/);
  assert.doesNotMatch(prompt, /白色仙侠长袍/);
  assert.doesNotMatch(prompt, /发簪固定/);
});
