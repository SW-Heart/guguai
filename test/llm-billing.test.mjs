import test from 'node:test';
import assert from 'node:assert/strict';
import { conservativeInputTokenUpperBound, creditsToMicro, llmCostMicro, llmRatesFromEnv, llmReservationMicro, microToCredits, normalizeWallet } from '../lib/billing.mjs';
import { analyzeDirectorPlanRecovery, analyzeDirectorShotShortage, buildDirectorPackageRepairPrompt, buildDirectorShotCompletionPrompt, buildDirectorShotRepairPrompt, directorPackageJsonSchema, directorRecoveryDiagnostic, directorShotCompletionJsonSchema, directorShotRepairJsonSchema, mergeDirectorShotCompletion, parseJsonObject, prepareDirectorPackage, replaceDirectorShots, validateDirectorPackage, validateScriptAnalysis, validateStoryboard } from '../lib/drama-analysis.mjs';
import { callLlm, llmConfigFromEnv, normalizeLlmResponse } from '../lib/llm-client.mjs';

const rates = llmRatesFromEnv({
  YUAN_PER_CREDIT: '0.1',
  LLM_INPUT_PRICE_YUAN_PER_MILLION: '3',
  LLM_OUTPUT_PRICE_YUAN_PER_MILLION: '6',
});

test('LLM pricing converts actual tokens to exact integer micro credits', () => {
  assert.equal(rates.inputMicroPerToken, 30);
  assert.equal(rates.outputMicroPerToken, 60);
  assert.equal(llmCostMicro(10_000, 3_000, rates), 480_000);
  assert.equal(microToCredits(480_000), 0.48);
  assert.equal(llmReservationMicro(12_000, 4_096, rates), 605_760);
});

test('legacy integer credit balances migrate without losing value', () => {
  const user = { credits: 50 };
  const wallet = normalizeWallet(user);
  assert.equal(user.creditBalanceMicro, creditsToMicro(50));
  assert.equal(user.creditHeldMicro, 0);
  assert.deepEqual({ balance: wallet.balance, held: wallet.held, available: wallet.available }, { balance: 50, held: 0, available: 50 });
});

test('input reservation fallback is conservative for Chinese UTF-8 text', () => {
  assert.equal(conservativeInputTokenUpperBound('短剧', 'abc'), 9);
});

test('LLM protocols normalize usage fields', () => {
  const anthropic = normalizeLlmResponse('anthropic', { id: 'msg_1', model: 'deepseek-v4-flash', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 12, output_tokens: 4 } });
  assert.deepEqual(anthropic.usage, { inputTokens: 12, outputTokens: 4 });
  const openai = normalizeLlmResponse('openai-compatible', { id: 'chat_1', model: 'deepseek-v4-flash', choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  assert.deepEqual(openai.usage, { inputTokens: 10, outputTokens: 3 });
});

test('Anthropic client uses configured supplier and returns normalized response', async () => {
  const config = llmConfigFromEnv({ LLM_API_BASE: 'https://supplier.example/', LLM_API_KEY: 'test-key', LLM_API_PROTOCOL: 'anthropic', LLM_MODEL: 'deepseek-v4-flash' });
  let request;
  const result = await callLlm({
    system: 'system', prompt: 'script', maxOutputTokens: 100, config,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ id: 'msg_1', model: 'deepseek-v4-flash', content: [{ type: 'text', text: '{"title":"测试"}' }], usage: { input_tokens: 20, output_tokens: 5 } }), { status: 200 });
    },
  });
  assert.equal(request.url, 'https://supplier.example/v1/messages');
  assert.equal(request.options.headers['x-api-key'], 'test-key');
  assert.equal(request.body.model, 'deepseek-v4-flash');
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 5 });
});

test('successful provider responses without usage require reconciliation', async () => {
  const config = llmConfigFromEnv({ LLM_API_BASE: 'https://supplier.example', LLM_API_KEY: 'test-key', LLM_API_PROTOCOL: 'openai-compatible', LLM_MODEL: 'deepseek-v4-flash' });
  await assert.rejects(
    () => callLlm({ system: 'system', prompt: 'script', config, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }) }),
    error => error.billingReconcileRequired === true,
  );
});

test('existing director agent env names are preferred and /v1 is not duplicated', async () => {
  const config = llmConfigFromEnv({ DIRECTOR_AGENT_BASE_URL: 'https://supplier.example/v1', DIRECTOR_AGENT_API_KEY: 'director-key', DIRECTOR_AGENT_MODEL: 'deepseek-v4-flash' });
  let requestedUrl = '';
  await callLlm({
    system: 'system', prompt: 'script', config,
    fetchImpl: async url => { requestedUrl = url; return new Response(JSON.stringify({ id: 'chat_1', model: 'deepseek-v4-flash', choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { status: 200 }); },
  });
  assert.equal(config.protocol, 'openai-compatible');
  assert.equal(config.apiKey, 'director-key');
  assert.equal(requestedUrl, 'https://supplier.example/v1/chat/completions');
});

test('OpenAI-compatible client requests strict JSON output for structured director tasks', async () => {
  const config = llmConfigFromEnv({ LLM_API_BASE:'https://supplier.example', LLM_API_KEY:'test-key', LLM_MODEL:'deepseek-v4-flash' });
  let requestBody;
  await callLlm({ system:'只输出 JSON', prompt:'生成导演方案', jsonMode:true, config, fetchImpl:async (_url,options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{message:{content:'{}'}}], usage:{prompt_tokens:2,completion_tokens:1} }), {status:200});
  }});
  assert.deepEqual(requestBody.response_format, { type:'json_object' });
});

test('structured tasks prefer forced function calls and read tool arguments as output', async () => {
  const config = llmConfigFromEnv({ LLM_API_BASE:'https://supplier.example', LLM_API_KEY:'test-key', LLM_MODEL:'deepseek-v4-flash' });
  let requestBody;
  const result = await callLlm({ system:'导演', prompt:'剧本', outputSchema:directorPackageJsonSchema({requireScript:false}), toolName:'submit_director_package', config, fetchImpl:async (_url,options) => {
    requestBody=JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{type:'function',function:{name:'submit_director_package',arguments:'{"title":"测试"}'}}]}}], usage:{prompt_tokens:3,completion_tokens:2} }), {status:200});
  }});
  assert.equal(requestBody.tool_choice.function.name, 'submit_director_package');
  assert.deepEqual(requestBody.thinking, { type:'disabled' });
  assert.equal(requestBody.response_format, undefined);
  assert.equal(result.text, '{"title":"测试"}');
  assert.equal(result.outputKind, 'tool_call');
});

test('script analysis accepts fenced JSON and validates required collections', () => {
  const value = parseJsonObject('```json\n{"title":"第一集","logline":"冲突","scenes":[],"assets":{"characters":[],"locations":[],"props":[],"costumes":[]}}\n```');
  assert.equal(validateScriptAnalysis(value).title, '第一集');
  assert.throws(() => validateScriptAnalysis({ title: 'x', logline: '', scenes: [], assets: {} }), /characters/);
});

test('storyboard validation fixes shot order and enforces six-second production units', () => {
  const result = validateStoryboard({ shots:[{
    shotNumber:99, sceneNumber:'2', title:'回头', narrativeFunction:'发现追兵', shotSize:'近景', cameraMovement:'快速摇镜',
    characters:['阿青'], action:'阿青停步回头', dialogue:'他们来了。', continuityNotes:'红色围巾在左肩',
    keyframePrompt:'9:16 真人短剧，阿青在雨巷回头，冷色侧光', videoPrompt:'阿青停步后回头，镜头快速摇向巷口，保持人物服装不变',
  }] });
  assert.equal(result.shots[0].shotNumber, 1);
  assert.equal(result.shots[0].sceneNumber, 2);
  assert.equal(result.shots[0].duration, 6);
  assert.throws(() => validateStoryboard({ shots:[{ title:'缺字段' }] }), /narrativeFunction/);
});

test('smart director package keeps production settings and known resource references', () => {
  const result = validateDirectorPackage({ title:'测试短剧', synopsis:'一句话', script:'第一场', resources:[{type:'character',name:'阿青',description:'红围巾',prompt:'阿青定妆照'}], shots:[{title:'回头',script:'阿青回头',prompt:'镜头推进',resourceNames:['阿青','不存在']}] }, { shotCount:1, shotDuration:10, aspectRatio:'9:16' });
  assert.equal(result.shots[0].duration, 10);
  assert.equal(result.shots[0].aspectRatio, '9:16');
  assert.deepEqual(result.shots[0].resourceNames, ['阿青']);
  assert.throws(() => validateDirectorPackage({ title:'x', synopsis:'x', script:'x', resources:[], shots:[] }), /shots/);
});

test('smart director accepts common text aliases and preserves the user script as fallback', () => {
  const base = { projectTitle:'别名标题', logline:'别名梗概', resources:[{type:'character',name:'阿青',description:'红围巾',prompt:'阿青定妆照'}], shots:[{title:'回头',script:'阿青回头',prompt:'镜头推进',resourceNames:['阿青']}] };
  const result = validateDirectorPackage(base, { shotCount:1 }, '用户提供的完整剧本');
  assert.equal(result.title, '别名标题');
  assert.equal(result.synopsis, '别名梗概');
  assert.equal(result.script, '用户提供的完整剧本');
});

test('v3 smart director only accepts beat-grounded shots with a motion timeline', () => {
  const base = {
    workflowVersion:3, title:'测试', synopsis:'一句话', script:'女侠回头。',
    scenes:[{heading:'山路',location:'山路',timeOfDay:'日',dramaticFunction:'发现危险',geography:'道路纵深',lighting:'日光',continuityNotes:'轴线不变',beats:[
      {id:'S01-B01',kind:'action',text:'女侠停步回头。',speaker:'',delivery:''},
      {id:'S01-B02',kind:'dialogue',text:'谁？',speaker:'女侠',delivery:'警惕'},
    ]}],
    resources:[{type:'character',name:'女侠',description:'白衣女侠',prompt:'白衣女侠设定图'}],
    shots:[{title:'回头',sourceBeatIds:['S01-B01','S01-B02'],script:'女侠停步回头，说“谁？”',duration:6,aspectRatio:'9:16',resourceNames:['女侠'],sceneNumber:1,narrativeFunction:'发现身后异常',shotSize:'近景',cameraMovement:'固定',framing:'人物居中',startStateId:'S01-Q0',startState:'背对镜头站立',action:'停步并回头',endStateId:'S01-Q1',endState:'面向镜头警惕观察',continuityNotes:'白衣不变',sound:'脚步停止',negativePrompt:'禁止新增人物',visualDirection:'侧逆光',motionPlan:[{startSecond:0,endSecond:.5,subjectMotion:'保持首帧姿态',cameraMotion:'固定',amplitude:'静止',speed:'静止'},{startSecond:.5,endSecond:2.5,subjectMotion:'双脚停止，肩膀开始向右转',cameraMotion:'固定',amplitude:'小',speed:'慢'},{startSecond:2.5,endSecond:4.5,subjectMotion:'上身和头部转向镜头',cameraMotion:'固定',amplitude:'中',speed:'中'},{startSecond:4.5,endSecond:5.5,subjectMotion:'目光锁定镜头后方',cameraMotion:'固定',amplitude:'微小',speed:'慢'},{startSecond:5.5,endSecond:6,subjectMotion:'停住并定格尾帧',cameraMotion:'固定',amplitude:'静止',speed:'静止'}]}],
  };
  const result = validateDirectorPackage(base, {shotCount:1,shotDuration:6,aspectRatio:'9:16'});
  assert.equal(result.workflowVersion, 3);
  assert.equal(result.productionQuality.passed, true);
  assert.deepEqual(result.shots[0].sourceBeatIds, ['S01-B01','S01-B02']);
  base.shots[0].action = '回头，切到远处追兵';
  assert.throws(() => validateDirectorPackage(base, {shotCount:1,shotDuration:6}), /一次视频生成只能对应一个连续镜头/);
});

test('director recovery recognizes a safe 3/5 prefix and appends exactly two shots', () => {
  const beat = (id, text) => ({ id, kind:'action', text, speaker:'', delivery:'' });
  const motionPlan = action => [
    {startSecond:0,endSecond:1,subjectMotion:'保持首帧姿态',cameraMotion:'固定',amplitude:'静止',speed:'静止'},
    {startSecond:1,endSecond:3,subjectMotion:action,cameraMotion:'固定',amplitude:'小',speed:'慢'},
    {startSecond:3,endSecond:5,subjectMotion:`继续${action}`,cameraMotion:'固定',amplitude:'小',speed:'慢'},
    {startSecond:5,endSecond:6,subjectMotion:'停住并定格尾帧',cameraMotion:'固定',amplitude:'静止',speed:'静止'},
  ];
  const shot = (index, beatId, startStateId, endStateId) => ({
    title:`镜头${index}`, sourceBeatIds:[beatId], script:`动作${index}`, duration:6, aspectRatio:'9:16', resourceNames:['女侠'], sceneNumber:1,
    narrativeFunction:`推进${index}`, shotSize:'中景', cameraMovement:'固定', framing:'人物居中', startStateId, startState:`状态${index-1}`,
    action:`女侠执行动作${index}`, endStateId, endState:`状态${index}`, continuityNotes:'白衣不变', sound:'环境声', negativePrompt:'禁止新增人物', visualDirection:'日光中景', motionPlan:motionPlan(`女侠向前移动${index}步`),
  });
  const base = {
    workflowVersion:3, title:'测试', synopsis:'一句话', script:'连续五个动作',
    scenes:[{heading:'山路',location:'山路',timeOfDay:'日',dramaticFunction:'前进',geography:'道路纵深',lighting:'日光',continuityNotes:'轴线不变',beats:[1,2,3,4,5].map(index => beat(`S01-B0${index}`, `女侠执行动作${index}`))}],
    resources:[{type:'character',name:'女侠',description:'白衣女侠',prompt:'白衣女侠设定图'}],
    shots:[shot(1,'S01-B01','S01-Q0','S01-Q1'),shot(2,'S01-B02','S01-Q1','S01-Q2'),shot(3,'S01-B03','S01-Q2','S01-Q3')],
  };
  const settings = {shotCount:5,shotDuration:6,aspectRatio:'9:16'};
  const prepared = prepareDirectorPackage(base, settings);
  const shortage = analyzeDirectorShotShortage(prepared, settings);
  assert.equal(shortage.recoverable, true);
  assert.equal(shortage.missingShotCount, 2);
  assert.deepEqual(shortage.unclaimedBeatIds, ['S01-B04','S01-B05']);
  const schema = directorShotCompletionJsonSchema(2);
  assert.equal(schema.properties.shots.minItems, 2);
  assert.equal(schema.properties.shots.maxItems, 2);
  const prompt = buildDirectorShotCompletionPrompt(prepared, settings, shortage);
  assert.match(prompt, /requiredNewShotCount/);
  assert.match(prompt, /S01-B04/);
  const merged = mergeDirectorShotCompletion(prepared, {shots:[shot(4,'S01-B04','S01-Q3','S01-Q4'),shot(5,'S01-B05','S01-Q4','S01-Q5')]}, settings);
  assert.equal(merged.shots.length, 5);
  assert.deepEqual(merged.shots.slice(0,3).map(item => item.title), ['镜头1','镜头2','镜头3']);
  assert.equal(merged.productionQuality.passed, true);
  assert.throws(() => mergeDirectorShotCompletion(prepared, {shots:[shot(4,'S01-B04','S01-Q3','S01-Q4')]}, settings), /应生成 2 个分镜/);
});

test('director recovery refuses append-only completion when no beat remains per missing shot', () => {
  const base = {
    workflowVersion:3, title:'测试', synopsis:'一句话', script:'三个动作',
    scenes:[{heading:'山路',location:'山路',timeOfDay:'日',dramaticFunction:'前进',geography:'道路',lighting:'日光',continuityNotes:'轴线不变',beats:[1,2,3].map(index => ({id:`S01-B0${index}`,kind:'action',text:`动作${index}`,speaker:'',delivery:''}))}],
    resources:[{type:'character',name:'女侠',description:'白衣女侠',prompt:'女侠设定图'}],
    shots:[1,2,3].map(index => ({title:`镜头${index}`,sourceBeatIds:[`S01-B0${index}`],script:`动作${index}`,resourceNames:['女侠'],sceneNumber:1,narrativeFunction:`推进${index}`,shotSize:'中景',cameraMovement:'固定',framing:'居中',startStateId:`Q${index-1}`,startState:`状态${index-1}`,action:`女侠动作${index}`,endStateId:`Q${index}`,endState:`状态${index}`,continuityNotes:'白衣不变',sound:'环境声',negativePrompt:'禁止新增人物',visualDirection:'日光',motionPlan:[{startSecond:0,endSecond:2,subjectMotion:'保持首帧姿态',cameraMotion:'固定',amplitude:'静止',speed:'静止'},{startSecond:2,endSecond:4,subjectMotion:`女侠动作${index}`,cameraMotion:'固定',amplitude:'小',speed:'慢'},{startSecond:4,endSecond:6,subjectMotion:'停住并定格尾帧',cameraMotion:'固定',amplitude:'静止',speed:'静止'}] })),
  };
  const prepared = prepareDirectorPackage(base, {shotCount:5,shotDuration:6});
  const shortage = analyzeDirectorShotShortage(prepared, {shotCount:5,shotDuration:6});
  assert.equal(shortage.recoverable, false);
  assert.match(shortage.reason, /不足以生成/);
});

test('director package schema can require the exact requested shot count', () => {
  const schema = directorPackageJsonSchema({requireScript:false,shotCount:5});
  assert.equal(schema.properties.shots.minItems, 5);
  assert.equal(schema.properties.shots.maxItems, 5);
});

test('director quality failures select full shot replacement and keep fixed foundations', () => {
  const motion = (index, start='保持首帧姿态', end='停住并定格尾帧') => [
    {startSecond:0,endSecond:2,subjectMotion:start,cameraMotion:'固定',amplitude:'静止',speed:'静止'},
    {startSecond:2,endSecond:4,subjectMotion:`女侠执行动作${index}`,cameraMotion:'固定',amplitude:'小',speed:'慢'},
    {startSecond:4,endSecond:6,subjectMotion:end,cameraMotion:'固定',amplitude:'静止',speed:'静止'},
  ];
  const shot = (index, beatId, options={}) => ({title:`镜头${index}`,sourceBeatIds:[beatId],script:`动作${index}`,duration:6,aspectRatio:'9:16',resourceNames:['女侠'],sceneNumber:1,narrativeFunction:`推进${index}`,shotSize:'中景',cameraMovement:'固定',framing:'居中',startStateId:`Q${index-1}`,startState:`状态${index-1}`,action:`女侠执行动作${index}`,endStateId:`Q${index}`,endState:`状态${index}`,continuityNotes:'白衣不变',sound:'环境声',negativePrompt:'禁止新增人物',visualDirection:'日光',motionPlan:motion(index),...options});
  const beats = [1,2,3,4,5].map(index=>({id:`S01-B0${index}`,kind:'action',text:`动作${index}`,speaker:'',delivery:''}));
  const base = {workflowVersion:3,title:'测试',synopsis:'一句话',script:'五个动作',scenes:[{heading:'山路',location:'山路',timeOfDay:'日',dramaticFunction:'前进',geography:'道路',lighting:'日光',continuityNotes:'轴线不变',beats}],resources:[{type:'character',name:'女侠',description:'白衣女侠',prompt:'女侠设定图'}],shots:[shot(1,'S01-B01'),shot(2,'S01-B02',{sourceBeatIds:['S01-B02','S01-B04']}),shot(3,'S01-B04'),shot(4,'S01-B05',{motionPlan:motion(4,'女侠立即迈步','继续行走')}),shot(5,'S01-B05')]};
  const settings={shotCount:5,shotDuration:6,aspectRatio:'9:16'};
  const prepared=prepareDirectorPackage(base,settings);
  const recovery=analyzeDirectorPlanRecovery(prepared,settings);
  assert.equal(recovery.mode,'replace');
  assert.ok(recovery.failedGates.some(gate=>gate.id==='source-coverage'));
  assert.ok(recovery.failedGates.some(gate=>gate.id==='motion-timeline'));
  const schema=directorShotRepairJsonSchema(5);
  assert.equal(schema.properties.shots.minItems,5);
  assert.match(buildDirectorShotRepairPrompt(prepared,settings,recovery),/source-coverage/);
  const repaired=replaceDirectorShots(prepared,{shots:[1,2,3,4,5].map(index=>shot(index,`S01-B0${index}`))},settings);
  assert.equal(repaired.productionQuality.passed,true);
  assert.equal(repaired.script,prepared.script);
  assert.deepEqual(repaired.scenes.map(scene=>scene.heading),prepared.scenes.map(scene=>scene.heading));
  assert.throws(()=>replaceDirectorShots(prepared,{shots:[shot(1,'S01-B01')]},settings),/应返回 5 个分镜/);
});

test('safe director shortage remains append recovery rather than replacement', () => {
  const makeShot=(index)=>({title:`镜头${index}`,sourceBeatIds:[`S01-B0${index}`],script:`动作${index}`,resourceNames:[],sceneNumber:1,narrativeFunction:'推进',shotSize:'中景',cameraMovement:'固定',framing:'居中',startStateId:`Q${index-1}`,startState:'状态',action:`动作${index}`,endStateId:`Q${index}`,endState:'状态',continuityNotes:'',sound:'',negativePrompt:'禁止变化',visualDirection:'日光',motionPlan:[{startSecond:0,endSecond:2,subjectMotion:'保持首帧姿态',cameraMotion:'固定',amplitude:'静止',speed:'静止'},{startSecond:2,endSecond:4,subjectMotion:`执行动作${index}`,cameraMotion:'固定',amplitude:'小',speed:'慢'},{startSecond:4,endSecond:6,subjectMotion:'停住并定格尾帧',cameraMotion:'固定',amplitude:'静止',speed:'静止'}]});
  const base={workflowVersion:3,title:'测试',synopsis:'一句话',script:'五个动作',scenes:[{heading:'室内',location:'室内',timeOfDay:'日',dramaticFunction:'推进',geography:'房间',lighting:'日光',continuityNotes:'轴线不变',beats:[1,2,3,4,5].map(index=>({id:`S01-B0${index}`,kind:'action',text:`动作${index}`,speaker:'',delivery:''}))}],resources:[],shots:[1,2,3].map(makeShot)};
  const prepared=prepareDirectorPackage(base,{shotCount:5,shotDuration:6});
  assert.equal(analyzeDirectorPlanRecovery(prepared,{shotCount:5,shotDuration:6}).mode,'append');
});

test('director package foundation failures produce full-package repair feedback', () => {
  const invalid={workflowVersion:3,title:'测试',synopsis:'一句话',script:'动作',scenes:[{heading:'室内',beats:[]}],resources:[],shots:[{title:'镜头1'}]};
  let error;
  try { prepareDirectorPackage(invalid,{shotCount:1,shotDuration:6}); } catch (caught) { error=caught; }
  const diagnostic=directorRecoveryDiagnostic(error,{requestedShotCount:1,returnedShotCount:1});
  assert.equal(diagnostic.kind,'structure');
  assert.equal(diagnostic.code,'DIRECTOR_SCENE_BEATS_MISSING');
  assert.equal(diagnostic.problems[0].field,'scenes.beats');
  assert.equal(diagnostic.problems[0].sceneNumber,1);
  const prompt=buildDirectorPackageRepairPrompt('制作参数：{"shotCount":1}\n用户输入：测试故事',{shotCount:1,shotDuration:6,aspectRatio:'9:16'},diagnostic,{round:1,requireScript:true});
  assert.match(prompt,/完整 workflow v3 导演包/);
  assert.match(prompt,/每个 scene 必须包含非空 beats/);
  assert.match(prompt,/"requiredShotCount":1/);
  assert.match(prompt,/DIRECTOR_SCENE_BEATS_MISSING/);
  assert.match(prompt,/测试故事/);
  assert.doesNotMatch(prompt,/"candidateShots"/);
});

test('director recovery diagnostics expose safe structure feedback for repeated repair', () => {
  let error;
  try { prepareDirectorPackage({workflowVersion:3,title:'测试',synopsis:'一句话',script:'动作',scenes:[{heading:'室内',beats:[{id:'S01-B01',kind:'action',text:'动作',speaker:'',delivery:''}]}],resources:[],shots:[{title:'镜头1',script:'动作',narrativeFunction:'推进',action:'动作',startState:'起点',endState:'终点'}]},{shotCount:1,shotDuration:6}); }
  catch (caught) { error=caught; }
  const diagnostic=directorRecoveryDiagnostic(error,{requestedShotCount:1,returnedShotCount:1});
  assert.equal(diagnostic.kind,'structure');
  assert.equal(diagnostic.problems[0].shotNumber,1);
  assert.equal(diagnostic.problems[0].field,'visualDirection');
  assert.doesNotMatch(JSON.stringify(diagnostic),/candidateShots|用户输入/);
  let parseError;
  try { parseJsonObject('{"shots": [oops}'); } catch (caught) { parseError=caught; }
  const parseDiagnostic=directorRecoveryDiagnostic(parseError,{requestedShotCount:5,returnedShotCount:0});
  assert.equal(parseDiagnostic.kind,'parse');
  assert.equal(parseDiagnostic.returnedShotCount,undefined);
  const countDiagnostic=directorRecoveryDiagnostic(new Error('wrong count'),{requestedShotCount:5,returnedShotCount:4});
  assert.deepEqual({kind:countDiagnostic.kind,expected:countDiagnostic.expectedShotCount,returned:countDiagnostic.returnedShotCount},{kind:'count',expected:5,returned:4});
});

test('director repair prompt carries prior-round diagnostics and exact requirements', () => {
  const motionPlan=[{startSecond:0,endSecond:2,subjectMotion:'保持首帧姿态',cameraMotion:'固定',amplitude:'静止',speed:'静止'},{startSecond:2,endSecond:4,subjectMotion:'角色抬手',cameraMotion:'固定',amplitude:'小',speed:'慢'},{startSecond:4,endSecond:6,subjectMotion:'停住并定格尾帧',cameraMotion:'固定',amplitude:'静止',speed:'静止'}];
  const base={workflowVersion:3,title:'测试',synopsis:'一句话',script:'角色抬手',scenes:[{heading:'室内',location:'室内',timeOfDay:'日',dramaticFunction:'推进',geography:'房间',lighting:'日光',continuityNotes:'不变',beats:[{id:'S01-B01',kind:'action',text:'角色抬手',speaker:'',delivery:''}]}],resources:[],shots:[{title:'镜头1',sourceBeatIds:['S01-B01'],script:'角色抬手',resourceNames:[],sceneNumber:1,narrativeFunction:'推进',shotSize:'中景',cameraMovement:'固定',framing:'居中',startStateId:'Q0',startState:'手垂下',action:'角色抬手',endStateId:'Q1',endState:'手抬起',continuityNotes:'',sound:'',negativePrompt:'禁止变化',visualDirection:'日光',motionPlan}]};
  const settings={shotCount:1,shotDuration:6,aspectRatio:'9:16'};
  const prepared=prepareDirectorPackage(base,settings);
  const feedback={kind:'structure',code:'DIRECTOR_SHOT_FIELD_MISSING',problems:[{shotNumber:1,field:'visualDirection',message:'分镜 1 缺少 visualDirection'}]};
  const prompt=buildDirectorShotRepairPrompt(prepared,settings,{mode:'replace',requestedShotCount:1,gates:[],failedGates:[]},{round:2,feedback});
  assert.match(prompt,/"repairRound":2/);
  assert.match(prompt,/visualDirection/);
  assert.match(prompt,/"requiredShotCount":1/);
  assert.match(prompt,/previousFailure/);
});

test('JSON parser repairs duplicate commas reported as invalid property names', () => {
  assert.deepEqual(parseJsonObject('{"title":"测试","shots":[{"title":"一",,"duration":6},{"title":"二", ,"duration":6}],,"ok":true}'), {
    title:'测试', shots:[{title:'一',duration:6},{title:'二',duration:6}], ok:true,
  });
});

test('JSON parser repairs unquoted ASCII property names reported by the runtime', () => {
  assert.deepEqual(parseJsonObject('{workflowVersion:3,"title":"测试",shot_count:5}'), { workflowVersion:3,title:'测试',shot_count:5 });
});

test('JSON parser repairs missing commas before compact array elements and object properties', () => {
  assert.deepEqual(parseJsonObject('{"items":[{"id":1}{"id":2}],"meta":{"title":"测试""count":2}}'), { items:[{id:1},{id:2}], meta:{title:'测试',count:2} });
});

test('JSON parser keeps commas inside generated strings unchanged while repairing structure', () => {
  assert.deepEqual(parseJsonObject('{"items":["甲,乙" "丙"]}'), { items:['甲,乙','丙'] });
});

test('JSON parser repairs common missing commas between generated array objects', () => {
  assert.deepEqual(parseJsonObject('{"items":[{"id":1}\n{"id":2},]}'), { items:[{id:1},{id:2}] });
});
