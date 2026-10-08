import { randomUUID } from 'node:crypto';
import { sql } from '../lib/db.mjs';

// Only the lexicon terms that matched are kept; the full prompt already lives
// on the generation row and is joined through generation_ids_json.
export function recordPromptPrecheckEvent({ userId, source, modelId, lexiconVersion, mode, outcome, hits, generationIds = [] }) {
  const id = randomUUID();
  sql(`INSERT INTO prompt_precheck_events(id,user_id,created_at,source,model_id,lexicon_version,mode,outcome,banned,suspect,hits_json,generation_ids_json)
    VALUES(:id,:userId,:createdAt,:source,:modelId,:lexiconVersion,:mode,:outcome,:banned,:suspect,:hits,:generationIds)`).run({
    id, userId, createdAt:new Date().toISOString(), source, modelId:modelId || '', lexiconVersion, mode, outcome,
    banned:hits.filter(hit => hit.level === 'banned').length, suspect:hits.filter(hit => hit.level === 'suspect').length,
    hits:JSON.stringify(hits.map(({ groupId, combo, level, term }) => ({ groupId, combo, level, term }))),
    generationIds:JSON.stringify(generationIds),
  });
  return id;
}

export function listPromptPrecheckEvents({ since, limit = 5000 } = {}) {
  return sql(`SELECT id, user_id AS userId, created_at AS createdAt, source, model_id AS modelId, lexicon_version AS lexiconVersion,
    mode, outcome, banned, suspect, hits_json AS hits, generation_ids_json AS generationIds
    FROM prompt_precheck_events WHERE created_at >= :since ORDER BY created_at DESC, id LIMIT :limit`)
    .all({ since:since || '1970-01-01T00:00:00.000Z', limit })
    .map(row => ({ ...row, hits:JSON.parse(row.hits), generationIds:JSON.parse(row.generationIds) }));
}
