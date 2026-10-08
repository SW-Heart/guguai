// Read-only report that grades the prompt risk lexicon against real outcomes.
// Usage: node scripts/precheck-calibrate.mjs [--db=/path/studio.db] [--days=90] [--json] [--show-unmatched]
// It never writes to the database or the lexicon; a person edits the lexicon from the report.
import { DatabaseSync } from 'node:sqlite';
import { resolveDbFile } from '../lib/db.mjs';
import { contentRejectionSource } from '../lib/generation-failure-code.mjs';
import { loadPromptRiskLexicon, scanPromptRisk } from '../lib/prompt-precheck.mjs';

const arg = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = name => process.argv.includes(`--${name}`);
const dbFile = arg('db') || resolveDbFile();
const days = Number(arg('days') || 90);
const since = new Date(Date.now() - days * 864e5).toISOString();

export function modelFamily(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.includes('seedance')) return 'seedance';
  if (id.includes('gpt-image')) return 'gpt-image';
  if (id.includes('midjourney')) return 'midjourney';
  if (id.includes('minimax')) return 'minimax';
  return id ? 'other' : 'unknown';
}

// One task can contribute several samples: each prompt-repair attempt was a
// rejected prompt, and the final prompt carries the task's own outcome.
export function samplesOf(doc) {
  const samples = [];
  const model = doc.videoModelId || doc.modelId || doc.model;
  for (const attempt of doc.promptRepair?.attempts || []) {
    const source = contentRejectionSource(attempt.rejection);
    if (attempt.prompt && source) samples.push({ prompt:attempt.prompt, outcome:source, model });
  }
  if (!doc.prompt || doc.upscale) return samples;
  if (doc.status === 'completed') samples.push({ prompt:doc.prompt, outcome:'success', model });
  else if (doc.status === 'failed') samples.push({ prompt:doc.prompt, outcome:contentRejectionSource(doc.error) || 'other_failure', model });
  const seen = new Set();
  return samples.filter(sample => { const key = `${sample.outcome}\u0000${sample.prompt}`; return !seen.has(key) && seen.add(key); });
}

export function suggestLevel({ n, k }, baseline) {
  const rate = n ? k / n : 0;
  if (n >= 10 && rate >= 0.5) return 'banned';
  if (n >= 10 && rate >= baseline * 3 && k >= 3) return 'suspect';
  if (n >= 30 && rate <= baseline) return 'off';
  return '';
}

export function calibrate(rows, lexicon = loadPromptRiskLexicon()) {
  const families = new Map();
  const family = name => {
    if (!families.has(name)) families.set(name, { outcomes:{}, terms:new Map(), flagged:{ banned:{ success:0, input_text:0, unknown:0 }, any:{ success:0, input_text:0, unknown:0 } }, unmatched:[] });
    return families.get(name);
  };
  // A rejection whose exact prompt later succeeded on the same model family was
  // the upstream wobbling, not the words; it is counted as 'transient'.
  const promptKey = sample => `${modelFamily(sample.model)}\u0000${sample.prompt.replace(/\s+/g, '')}`;
  const samples = rows.flatMap(samplesOf);
  const passed = new Set(samples.filter(sample => sample.outcome === 'success').map(promptKey));
  for (const sample of samples) if (['input_text', 'unknown'].includes(sample.outcome) && passed.has(promptKey(sample))) sample.outcome = 'transient';
  {
    for (const sample of samples) {
      for (const stats of [family('all'), family(modelFamily(sample.model))]) {
        stats.outcomes[sample.outcome] = (stats.outcomes[sample.outcome] || 0) + 1;
        // 'unknown' is a content-review rejection that did not say which side it
        // judged (Seedance's 710082022). It is reported apart and never grades a term.
        if (!['success', 'input_text', 'unknown'].includes(sample.outcome)) continue;
        const { hits } = scanPromptRisk(sample.prompt, { modelId:sample.model, includeOff:true, lexicon });
        const shown = hits.filter(hit => hit.level !== 'off');
        if (shown.some(hit => hit.level === 'banned')) stats.flagged.banned[sample.outcome]++;
        if (shown.length) stats.flagged.any[sample.outcome]++;
        else if (sample.outcome === 'input_text') stats.unmatched.push(sample.prompt);
        for (const key of new Set(hits.map(hit => `${hit.groupId}\u0000${hit.term.toLowerCase()}\u0000${hit.level}`))) {
          const term = stats.terms.get(key) || { n:0, k:0, unknown:0 };
          if (sample.outcome === 'unknown') term.unknown++;
          else { term.n++; if (sample.outcome === 'input_text') term.k++; }
          stats.terms.set(key, term);
        }
      }
    }
  }
  return [...families].map(([name, stats]) => {
    const success = stats.outcomes.success || 0, rejected = stats.outcomes.input_text || 0, unknown = stats.outcomes.unknown || 0;
    const baseline = success + rejected ? rejected / (success + rejected) : 0;
    const ratio = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
    const terms = [...stats.terms].map(([key, value]) => {
      const [groupId, term, level] = key.split('\u0000');
      return { groupId, term, level, ...value, rate:ratio(value.k, value.n), suggested:suggestLevel(value, baseline) };
    }).sort((a, b) => b.n - a.n);
    return {
      family:name, outcomes:stats.outcomes, baselineRejectionRate:ratio(rejected, success + rejected),
      redPrecision:ratio(stats.flagged.banned.input_text, stats.flagged.banned.input_text + stats.flagged.banned.success),
      popupRate:ratio(stats.flagged.any.success, success), recall:ratio(stats.flagged.any.input_text, rejected),
      unknownFlagRate:ratio(stats.flagged.any.unknown, unknown),
      terms, changes:terms.filter(term => term.suggested && term.suggested !== term.level), unmatched:stats.unmatched,
    };
  });
}

function report(results, lexicon) {
  const lines = [`# 风险词表校准报告`, '', `词表版本 ${lexicon.version} · 近 ${days} 天 · ${dbFile}`, ''];
  for (const item of results) {
    lines.push(`## ${item.family}`, '', `样本：${JSON.stringify(item.outcomes)}`,
      `输入文字被拒基线 ${item.baselineRejectionRate ?? '-'}% · 红色精确率 ${item.redPrecision ?? '-'}% · 弹窗率 ${item.popupRate ?? '-'}% · 召回率 ${item.recall ?? '-'}%`,
      `来源不明的审核拒绝中被标出 ${item.unknownFlagRate ?? '-'}%（只供参考，不参与定级）`, '');
    if (item.changes.length) {
      lines.push('| 分组 | 词 | 当前 | 建议 | 出现 | 被拒 | 被拒率 |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const term of item.changes) lines.push(`| ${term.groupId} | ${term.term} | ${term.level} | ${term.suggested} | ${term.n} | ${term.k} | ${term.rate}% |`);
      lines.push('');
    } else lines.push('暂无级别调整建议（样本不足或与当前级别一致）。', '');
    lines.push(`未命中任何词却因输入文字被拒：${item.unmatched.length} 条`, '');
    if (flag('show-unmatched')) for (const prompt of item.unmatched.slice(0, 50)) lines.push(`- ${prompt.replace(/\s+/g, ' ').slice(0, 200)}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(dbFile, { readOnly:true });
  const rows = db.prepare('SELECT doc_json FROM generations WHERE created_at >= ? ORDER BY created_at').all(since).map(row => JSON.parse(row.doc_json));
  db.close();
  const lexicon = loadPromptRiskLexicon();
  const results = calibrate(rows, lexicon);
  if (flag('json')) process.stdout.write(`${JSON.stringify({ lexiconVersion:lexicon.version, days, results:results.map(item => ({ ...item, unmatched:item.unmatched.length })) }, null, 1)}\n`);
  else process.stdout.write(`${report(results, lexicon)}\n`);
}
