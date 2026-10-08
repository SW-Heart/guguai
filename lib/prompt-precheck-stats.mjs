import { sql } from './db.mjs';
import { contentRejectionSource } from './generation-failure-code.mjs';
import { listPromptPrecheckEvents } from '../repositories/prompt-precheck.mjs';

const shownOutcomes = new Set(['edited', 'submitted_as_is', 'confirmed_banned', 'cancelled']);
const keptOutcomes = new Set(['submitted_as_is', 'confirmed_banned']);
const ratio = (part, whole) => whole ? Math.round(part / whole * 1000) / 10 : null;

export function generationResult(task) {
  if (!task) return 'unknown';
  if (task.status === 'completed') return 'success';
  if (task.status === 'failed') return contentRejectionSource(task.error) === 'input_text' ? 'rejected' : 'other_failure';
  return 'pending';
}

// events: rows from listPromptPrecheckEvents; results: Map(generationId -> success | rejected | other_failure | pending).
// A term counts as a false-positive candidate when people kept it and the work still came out.
export function aggregatePrecheckStats({ events, results, generationTotal = 0, misses = [] }) {
  const outcomeOf = event => {
    const finals = event.generationIds.map(id => results.get(id) || 'unknown');
    if (finals.includes('rejected')) return 'rejected';
    if (finals.length && finals.every(value => value === 'success')) return 'success';
    return finals.length ? 'other' : 'none';
  };
  const summary = { checks:events.length, shown:0, blocked:0, edited:0, kept:0, confirmedRed:0, cancelled:0 };
  const red = { kept:0, rejected:0 }, kept = { finished:0, success:0 };
  const terms = new Map();
  for (const event of events) {
    const result = outcomeOf(event);
    if (shownOutcomes.has(event.outcome)) summary.shown++;
    if (event.outcome === 'blocked') summary.blocked++;
    if (event.outcome === 'edited') summary.edited++;
    if (event.outcome === 'cancelled') summary.cancelled++;
    if (event.outcome === 'confirmed_banned') summary.confirmedRed++;
    if (keptOutcomes.has(event.outcome)) {
      summary.kept++;
      if (['success', 'rejected'].includes(result)) { kept.finished++; if (result === 'success') kept.success++; }
      if (event.banned && ['success', 'rejected'].includes(result)) { red.kept++; if (result === 'rejected') red.rejected++; }
    }
    for (const key of new Set(event.hits.map(hit => `${hit.groupId}\u0000${String(hit.term).toLowerCase()}\u0000${hit.level}`))) {
      const [groupId, term, level] = key.split('\u0000');
      const row = terms.get(key) || { groupId, term, level, triggers:0, edited:0, cancelled:0, kept:0, keptSuccess:0, keptRejected:0 };
      row.triggers++;
      if (event.outcome === 'edited') row.edited++;
      if (event.outcome === 'cancelled') row.cancelled++;
      if (keptOutcomes.has(event.outcome)) { row.kept++; if (result === 'success') row.keptSuccess++; if (result === 'rejected') row.keptRejected++; }
      terms.set(key, row);
    }
  }
  const termRows = [...terms.values()].sort((a, b) => b.triggers - a.triggers || a.term.localeCompare(b.term));
  return {
    summary:{ ...summary, generationTotal, shownRate:ratio(summary.shown, generationTotal) },
    accuracy:{ redKept:red.kept, redRejected:red.rejected, redRejectedRate:ratio(red.rejected, red.kept), keptFinished:kept.finished, keptSuccessRate:ratio(kept.success, kept.finished) },
    terms:termRows.slice(0, 50),
    falsePositives:termRows.filter(row => row.kept >= 3 && row.keptSuccess / row.kept >= 0.8).sort((a, b) => b.kept - a.kept).slice(0, 30),
    misses,
  };
}

function generationsById(ids) {
  const results = new Map();
  for (let index = 0; index < ids.length; index += 400) {
    const chunk = ids.slice(index, index + 400);
    const rows = sql(`SELECT id, doc_json FROM generations WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    for (const row of rows) results.set(row.id, generationResult(JSON.parse(row.doc_json)));
  }
  return results;
}

export function promptPrecheckStats({ days = 7, nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - days * 864e5).toISOString();
  const events = listPromptPrecheckEvents({ since, limit:20_000 });
  const linked = new Set(events.flatMap(event => event.generationIds));
  const results = generationsById([...linked]);
  const generationTotal = sql('SELECT COUNT(*) AS count FROM generations WHERE created_at >= ?').get(since).count;
  // Rejected for their words but never marked: the place to look for missing terms.
  const misses = sql("SELECT id, model_id AS modelId, created_at AS createdAt, doc_json FROM generations WHERE status = 'failed' AND created_at >= ? ORDER BY created_at DESC LIMIT 2000").all(since)
    .map(row => ({ ...row, doc:JSON.parse(row.doc_json) }))
    .filter(row => !linked.has(row.id) && !row.doc.upscale && contentRejectionSource(row.doc.error) === 'input_text')
    .slice(0, 30)
    .map(row => ({ id:row.id, modelId:row.modelId || '', createdAt:row.createdAt, prompt:String(row.doc.prompt || '').replace(/\s+/g, ' ').slice(0, 160), error:String(row.doc.error || '').slice(0, 120) }));
  return { days, since, ...aggregatePrecheckStats({ events, results, generationTotal, misses }) };
}
