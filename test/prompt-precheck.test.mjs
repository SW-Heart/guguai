import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compilePromptRiskLexicon, loadPromptRiskLexicon, promptRiskLexiconPath, scanPromptRisk, validatePromptRiskLexicon } from '../lib/prompt-precheck.mjs';
import { contentRejectionSource } from '../lib/generation-failure-code.mjs';
import { calibrate, samplesOf, suggestLevel } from '../scripts/precheck-calibrate.mjs';

const marks = (prompt, options = {}) => scanPromptRisk(prompt, options).hits.map(hit => [hit.term, hit.level]);

test('the shipped lexicon is valid and every group cites a known source', () => {
  const lexicon = JSON.parse(readFileSync(promptRiskLexiconPath, 'utf8'));
  assert.deepEqual(validatePromptRiskLexicon(lexicon), []);
  assert.match(loadPromptRiskLexicon().version, /^[0-9a-f]{12}$/);
  assert.ok(lexicon.groups.some(group => group.precheck === 'banned'));
});

test('explicit content is marked red and context words stay quiet', () => {
  assert.deepEqual(marks('她一丝不挂地站在窗边'), [['一丝不挂', 'banned']]);
  assert.deepEqual(marks('斩首的画面'), [['斩首', 'banned']]);
  assert.deepEqual(marks('习近平出席会议'), [['习近平', 'banned']]);
  assert.deepEqual(marks('李强推开办公室的门'), [['李强', 'suspect']]);
  assert.deepEqual(marks('律师查看合同', { modelId:'seedance-2.5' }), []);
  assert.deepEqual(marks('律师查看合同', { modelId:'seedance-2.5', includeOff:true }).map(([term]) => term), ['律师', '合同']);
});

test('allow phrases remove cross-word false positives', () => {
  for (const prompt of ['蓝色情绪的女孩', '个性交流活动', '路口交通拥堵', '舞台独白', '过程中共同努力', '乌龟头部特写', '水乳交融', '做爱心便当',
    '新疆独特的风景', '向东突然转身', 'nude makeup look', 'naked eye view', 'rape flowers in spring', '鸦片战争纪录片', '大麻花'])
    assert.deepEqual(marks(prompt), [], prompt);
  assert.deepEqual(marks('血橙汁', { modelId:'seedance', includeOff:true }), []);
  assert.deepEqual(marks('杀青宴', { modelId:'seedance', includeOff:true }), []);
});

test('normalization catches spacing, symbols, full width and traditional characters', () => {
  assert.deepEqual(marks('血 腥 场面'), [['血 腥', 'suspect']]);
  assert.deepEqual(marks('一*丝*不*挂'), [['一*丝*不*挂', 'banned']]);
  assert.deepEqual(marks('陰莖特寫'), [['陰莖', 'banned']]);
  assert.deepEqual(marks('ＮＳＦＷ art'), [['ＮＳＦＷ', 'banned']]);
  assert.deepEqual(marks('一​丝不挂'), [['一​丝不挂', 'banned']]);
});

test('latin words need word edges', () => {
  assert.deepEqual(marks('Burgundy wine, method acting, unisex coat', { includeOff:true }), []);
  assert.deepEqual(marks('a naked figure'), [['naked', 'banned']]);
  assert.deepEqual(marks('character sheet, sex: female'), [['sex', 'suspect']]);
});

test('combos raise ordinary words that appear together in one sentence', () => {
  assert.deepEqual(marks('小学生穿着比基尼摆拍'), [['小学生', 'banned'], ['比基尼', 'banned']]);
  assert.deepEqual(marks('小学生在操场跑步。她穿着比基尼'), []);
  const [hit] = scanPromptRisk('小学生穿着比基尼').hits;
  assert.equal(hit.combo, 'minor-sexual-suggestive');
  assert.equal(hit.label, '未成年人与性暗示');
});

test('ranges index the original string, including surrogate pairs', () => {
  const prompt = '😀 一丝不挂';
  const [hit] = scanPromptRisk(prompt).hits;
  assert.equal(prompt.slice(hit.start, hit.end), '一丝不挂');
});

test('overlapping hits keep the strongest mark', () => {
  const { hits, counts } = scanPromptRisk('偷拍裙底');
  assert.deepEqual(hits.map(hit => [hit.term, hit.level]), [['偷拍裙底', 'banned']]);
  assert.deepEqual(counts, { banned:1, suspect:0 });
});

test('invalid lexicons are refused before matching', () => {
  const lexicon = { schemaVersion:2, sources:[{ id:'gugu' }], groups:[{ id:'a', label:'A', precheck:'banned', models:['*'], zh:['词'], en:[], overrides:{ 不存在:'off' }, allow:['无关短语'], sourceIds:['gugu'] }], combos:[{ id:'c', precheck:'banned', all:['a', 'missing'] }] };
  const problems = validatePromptRiskLexicon(lexicon);
  assert.equal(problems.length, 3);
  assert.throws(() => compilePromptRiskLexicon(lexicon), /风险词表无效/);
});

test('scanning a long prompt stays fast', () => {
  const prompt = '夜晚的城市街头，人群穿过路口，霓虹灯映在湿润的地面上，镜头缓慢推进。'.repeat(150);
  const started = performance.now();
  for (let i = 0; i < 20; i++) scanPromptRisk(prompt, { includeOff:true });
  assert.ok((performance.now() - started) / 20 < 50);
});

test('content rejections are traced to the side the upstream named', () => {
  assert.equal(contentRejectionSource('InputTextSensitiveContentDetected: The request failed'), 'input_text');
  assert.equal(contentRejectionSource('输入的提示词包含违禁词'), 'input_text');
  assert.equal(contentRejectionSource('OutputVideoSensitiveContentDetected'), 'output');
  assert.equal(contentRejectionSource('参考图审核未通过'), 'reference');
  assert.equal(contentRejectionSource('400 CD requires 1 to 9 reference images'), '');
  assert.equal(contentRejectionSource('返回错误码 710082022，疑似包含侵权/违规内容'), 'input_text');
  assert.equal(contentRejectionSource('提示词有问题，请修改提示词。'), 'input_text');
  assert.equal(contentRejectionSource('content_policy_violation'), 'unknown');
  assert.equal(contentRejectionSource('503 service unavailable'), '');
});

test('calibration reads repair attempts and grades terms only on prompt-text outcomes', () => {
  const doc = { prompt:'深红色灯光', status:'completed', modelId:'seedance-2.5', promptRepair:{ attempts:[{ prompt:'血红色灯光', rejection:'输入的提示词包含违禁词' }] } };
  assert.deepEqual(samplesOf(doc).map(sample => sample.outcome), ['input_text', 'success']);
  assert.equal(suggestLevel({ n:12, k:8 }, 0.05), 'banned');
  assert.equal(suggestLevel({ n:12, k:3 }, 0.05), 'suspect');
  assert.equal(suggestLevel({ n:40, k:1 }, 0.05), 'off');
  const rows = [
    ...Array.from({ length:10 }, () => ({ prompt:'李强推开门', status:'failed', error:'InputTextSensitiveContentDetected', modelId:'seedance-2.5' })),
    ...Array.from({ length:30 }, () => ({ prompt:'街头人群', status:'completed', modelId:'seedance-2.5' })),
    { prompt:'普通描述', status:'failed', error:'OutputVideoSensitiveContentDetected', modelId:'seedance-2.5' },
  ];
  rows.push({ prompt:'街头人群', status:'failed', error:'返回错误码 710082022，疑似包含侵权/违规内容', modelId:'seedance-2.0' });
  const [all] = calibrate(rows);
  assert.equal(all.outcomes.transient, 1);
  assert.equal(all.outcomes.output, 1);
  assert.equal(all.recall, 100);
  assert.equal(all.popupRate, 0);
  assert.deepEqual(all.changes.map(term => [term.term, term.level, term.suggested]), [['李强', 'suspect', 'banned']]);
});

test('findings from production rejections stay covered', () => {
  // Phrase-ending punctuation is a real boundary, not a separator to drop.
  assert.deepEqual(marks('小李，强调一下'), []);
  assert.deepEqual(marks('裸露原木横梁的柴房'), []);
  // Seedance refused an undressing scene in every phrasing tried, even with "不呈现裸露".
  assert.deepEqual(marks('她拉开婚纱背后的拉链，镜头顺着她的身体下移', { modelId:'seedance-2.0' }).map(([, level]) => level), ['banned', 'banned']);
  assert.deepEqual(marks('白色婚纱从她身上滑落', { modelId:'seedance-2.0' }), [['从她身上滑落', 'suspect']]);
  // Written safety disclaimers still carry the literal words the upstream filters on.
  assert.deepEqual(marks('不生成色情内容', { modelId:'seedance-2.0' }), [['色情', 'banned']]);
});

test('model caps keep lenient upstreams from inheriting strict marks', () => {
  const scene = '她拉开婚纱背后的拉链，镜头顺着她的身体下移';
  assert.ok(scanPromptRisk(scene, { modelId:'minimax-h3-15s' }).hits.every(hit => hit.level === 'suspect'));
  assert.deepEqual(marks('mysterious and seductive mood', { modelId:'gpt-image-2' }), []);
  assert.deepEqual(marks('mysterious and seductive mood', { modelId:'seedance-2.0' }), [['seductive', 'suspect']]);
  assert.deepEqual(marks('不露点', { modelId:'gpt-image-2.5' }), [['露点', 'suspect']]);
  assert.deepEqual(marks('习近平出席', { modelId:'minimax-h3' }), [['习近平', 'banned']]);
});

test('standard risk codes, copyright characters and slap scenes', () => {
  const lexicon = JSON.parse(readFileSync(promptRiskLexiconPath, 'utf8'));
  assert.ok(lexicon.groups.every(group => Array.isArray(group.risk)));
  const [hit] = scanPromptRisk('皮卡丘在草地上奔跑').hits;
  assert.deepEqual([hit.term, hit.level, hit.risk], ['皮卡丘', 'suspect', ['A.3.1']]);
  assert.deepEqual(marks('超人气餐厅'), []);
  assert.deepEqual(marks('a woman in a one piece swimsuit'), []);
  assert.deepEqual(marks('她一巴掌扇向那个胖女人', { modelId:'seedance-2.0' }).map(([, level]) => level), ['banned', 'banned', 'banned']);
  assert.deepEqual(marks('她一巴掌扇向他', { modelId:'gpt-image-2' }), []);
  assert.deepEqual(marks('伪造身份证的特写'), [['伪造身份证', 'suspect']]);
});
