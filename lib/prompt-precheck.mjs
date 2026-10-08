import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The lexicon lives with the agent skills so the prompt optimizer and the
// pre-submit check read the same words. It is matched in code only; the raw
// list is never handed to a model or shipped to the browser.
export const promptRiskLexiconPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../agent-skills/prompt-optimization/references/prompt-risk-lexicon.json');

const levels = ['off', 'suspect', 'banned'];
const rank = level => levels.indexOf(level);
const zeroWidth = /[​-‍⁠﻿­]/u;
const cjk = /[㐀-鿿豈-﫿]/u;
const asciiWord = /[a-z0-9]/;
// Separators people drop between Chinese characters to slip past a filter ("血 腥", "血*腥").
// Punctuation that ends a phrase (，、。 and line breaks) is kept, so "李，强" never reads as a name.
const cjkSeparator = /[ \t\u3000*·•\-_|/\\~+＊'"`^]/u;
const sentenceEnd = /[。！？!?；;\n.]/u;
// Only the characters the lexicon needs; a full converter is not worth the dependency.
const traditional = { '體':'体', '陰':'阴', '強':'强', '姦':'奸', '亂':'乱', '倫':'伦', '殺':'杀', '屍':'尸', '槍':'枪', '彈':'弹', '藥':'药', '賭':'赌', '獨':'独', '輪':'轮', '黨':'党', '習':'习', '澤':'泽', '濤':'涛', '鄧':'邓', '襲':'袭', '擊':'击', '頭':'头', '腦':'脑', '漿':'浆', '臟':'脏', '絲':'丝', '襪':'袜', '內':'内', '戲':'戏', '學':'学', '兒':'儿', '窺':'窥', '攝':'摄', '華':'华', '鋒':'锋', '鵬':'鹏', '溫':'温', '錦':'锦', '劉':'刘', '曉':'晓', '臺':'台', '灣':'湾', '達':'达', '賴':'赖', '販':'贩', '製':'制', '殘':'残', '斬':'斩', '腸':'肠', '機':'机', '褻':'亵', '賣':'卖', '戀':'恋', '恥':'耻', '癮':'瘾', '煙':'烟', '賤':'贱', '莖':'茎' };

function normalize(text) {
  const chars = []; const map = [];
  let index = 0;
  for (const char of text) {
    const width = char.length;
    if (!zeroWidth.test(char)) {
      for (let out of char.normalize('NFKC').toLowerCase()) {
        out = traditional[out] || out;
        if (/\s/u.test(out)) out = ' ';
        chars.push(out); map.push([index, index + width]);
      }
    }
    index += width;
  }
  // Drop separators sitting between two CJK characters, and collapse spaces.
  const keep = chars.map(() => true);
  for (let i = 0; i < chars.length; i++) {
    if (!cjkSeparator.test(chars[i])) continue;
    let left = i - 1; while (left >= 0 && !keep[left]) left--;
    let right = i + 1; while (right < chars.length && cjkSeparator.test(chars[right])) right++;
    if (left >= 0 && right < chars.length && cjk.test(chars[left]) && cjk.test(chars[right])) keep[i] = false;
    else if (chars[i] === ' ' && left >= 0 && chars[left] === ' ' && keep[left]) keep[i] = false;
  }
  const text2 = []; const map2 = [];
  chars.forEach((char, i) => { if (keep[i]) { text2.push(char); map2.push(map[i]); } });
  return { chars: text2, map: map2 };
}

const normalizeTerm = term => normalize(String(term)).chars.join('').trim();

export function validatePromptRiskLexicon(lexicon) {
  const problems = [];
  if (lexicon?.schemaVersion !== 2) problems.push('schemaVersion 必须为 2');
  const ids = new Set();
  for (const group of lexicon?.groups || []) {
    if (!group.id || ids.has(group.id)) problems.push(`分组 id 无效或重复：${group.id}`);
    ids.add(group.id);
    if (!levels.includes(group.precheck)) problems.push(`${group.id} 的 precheck 无效`);
    const terms = [...group.zh, ...group.en];
    const normalized = new Set(terms.map(normalizeTerm));
    for (const [term, level] of Object.entries(group.overrides || {})) {
      if (!levels.includes(level)) problems.push(`${group.id} 覆盖级别无效：${term}`);
      if (!normalized.has(normalizeTerm(term))) problems.push(`${group.id} 覆盖了不存在的词：${term}`);
    }
    for (const phrase of group.allow || []) {
      const value = normalizeTerm(phrase);
      if (![...normalized].some(term => value.includes(term))) problems.push(`${group.id} 的放行短语不含本组词：${phrase}`);
    }
    if (!group.label || !Array.isArray(group.models) || !group.models.length) problems.push(`${group.id} 缺少 label 或 models`);
    for (const [family, level] of Object.entries(group.modelCaps || {})) if (!levels.includes(level)) problems.push(`${group.id} 的模型上限无效：${family}`);
    for (const code of group.risk || []) if (!lexicon.riskTaxonomy?.[code]) problems.push(`${group.id} 的风险编号无效：${code}`);
    for (const id of group.sourceIds || []) if (!lexicon.sources.some(source => source.id === id)) problems.push(`${group.id} 引用了不存在的来源：${id}`);
  }
  for (const combo of lexicon?.combos || []) {
    if (!levels.includes(combo.precheck) || combo.precheck === 'off') problems.push(`组合 ${combo.id} 级别无效`);
    if (!Array.isArray(combo.all) || combo.all.length < 2) problems.push(`组合 ${combo.id} 至少需要两个分组`);
    for (const id of combo.all || []) if (!ids.has(id)) problems.push(`组合 ${combo.id} 引用了不存在的分组：${id}`);
  }
  return problems;
}

export function compilePromptRiskLexicon(lexicon, version = '') {
  const problems = validatePromptRiskLexicon(lexicon);
  if (problems.length) throw new Error(`风险词表无效：${problems.join('；')}`);
  const root = new Map();
  const add = (word, entry) => {
    let node = root;
    for (const char of word) { if (!node.has(char)) node.set(char, new Map()); node = node.get(char); }
    (node.payload ||= []).push(entry);
  };
  for (const group of lexicon.groups) {
    const overrides = new Map(Object.entries(group.overrides || {}).map(([term, level]) => [normalizeTerm(term), level]));
    for (const term of new Set([...group.zh, ...group.en])) {
      const word = normalizeTerm(term);
      if (word) add([...word], { kind:'term', group, term, level:overrides.get(word) || group.precheck });
    }
    for (const phrase of group.allow || []) add([...normalizeTerm(phrase)], { kind:'allow', group });
  }
  return { lexicon, root, version, combos:lexicon.combos || [] };
}

let cached = null;
export function loadPromptRiskLexicon({ file = promptRiskLexiconPath, reload = false } = {}) {
  if (cached && !reload && cached.file === file) return cached.compiled;
  const text = readFileSync(file, 'utf8');
  const compiled = compilePromptRiskLexicon(JSON.parse(text), createHash('sha256').update(text).digest('hex').slice(0, 12));
  cached = { file, compiled };
  return compiled;
}

const familyMatches = (family, modelId) => String(modelId).toLowerCase().includes(family.toLowerCase());
const modelMatches = (group, modelId) => !modelId || group.models.includes('*') || group.models.some(family => familyMatches(family, modelId));

// Upstreams differ: the same undressing scene Seedance refused went through on
// MiniMax, and GPT Image judges meaning rather than words. A group can cap its
// level per model family so a lenient model does not inherit a strict one's red.
function capLevel(hit, modelId) {
  // Child-safety combos are strict on every upstream, so no model loosens them.
  if (!modelId || hit.combo?.ignoreCaps) return hit;
  for (const [family, cap] of Object.entries(hit.group.modelCaps || {})) {
    if (familyMatches(family, modelId) && rank(hit.level) > rank(cap)) hit.level = cap;
  }
  return hit;
}

function rawMatches(prompt, compiled, modelId) {
  const { chars, map } = normalize(prompt);
  const terms = []; const allows = [];
  const isWord = i => i >= 0 && i < chars.length && asciiWord.test(chars[i]);
  for (let start = 0; start < chars.length; start++) {
    let node = compiled.root;
    for (let end = start; end < chars.length; end++) {
      node = node.get(chars[end]);
      if (!node) break;
      for (const entry of node.payload || []) {
        if (!modelMatches(entry.group, modelId)) continue;
        // Latin words need word edges so "gun" never fires inside "Burgundy".
        if (asciiWord.test(chars[start]) && isWord(start - 1)) continue;
        if (asciiWord.test(chars[end]) && isWord(end + 1)) continue;
        const span = { start:map[start][0], end:map[end][1], group:entry.group };
        if (entry.kind === 'allow') allows.push(span);
        else terms.push({ ...span, level:entry.level, term:entry.term });
      }
    }
  }
  return terms.filter(hit => !allows.some(allow => allow.group === hit.group && allow.start <= hit.start && allow.end >= hit.end));
}

function sentenceOf(prompt, index) {
  let start = index; while (start > 0 && !sentenceEnd.test(prompt[start - 1])) start--;
  let end = index; while (end < prompt.length && !sentenceEnd.test(prompt[end])) end++;
  return `${start}:${end}`;
}

function applyCombos(prompt, hits, combos) {
  const bySentence = new Map();
  for (const hit of hits) {
    const key = sentenceOf(prompt, hit.start);
    if (!bySentence.has(key)) bySentence.set(key, []);
    bySentence.get(key).push(hit);
  }
  for (const sentence of bySentence.values()) {
    for (const combo of combos) {
      const parts = sentence.filter(hit => combo.all.includes(hit.group.id));
      if (!combo.all.every(id => parts.some(hit => hit.group.id === id))) continue;
      for (const hit of parts) {
        if (rank(combo.precheck) < rank(hit.level)) continue;
        hit.level = combo.precheck; hit.combo = combo;
      }
    }
  }
  return hits;
}

// Overlapping hits collapse to the strongest, then the longest, so each
// character of the prompt carries at most one mark.
function resolveOverlaps(hits) {
  const ordered = [...hits].sort((a, b) => rank(b.level) - rank(a.level) || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const accepted = [];
  for (const hit of ordered) if (!accepted.some(other => hit.start < other.end && hit.end > other.start)) accepted.push(hit);
  return accepted.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function scanPromptRisk(prompt, { modelId = '', includeOff = false, lexicon = loadPromptRiskLexicon() } = {}) {
  const text = String(prompt ?? '');
  const hits = resolveOverlaps(applyCombos(text, rawMatches(text, lexicon, modelId), lexicon.combos).map(hit => capLevel(hit, modelId)))
    .filter(hit => includeOff || hit.level !== 'off')
    .map(hit => ({
      start:hit.start, end:hit.end, level:hit.level, term:text.slice(hit.start, hit.end),
      label:hit.combo?.label || hit.group.label, category:hit.group.category, groupId:hit.group.id, combo:hit.combo?.id || '',
      review:hit.combo?.context || hit.group.context, sourceIds:hit.group.sourceIds, risk:hit.group.risk || [],
    }));
  const counts = { banned:hits.filter(hit => hit.level === 'banned').length, suspect:hits.filter(hit => hit.level === 'suspect').length };
  return { lexiconVersion:lexicon.version, hits, counts };
}
