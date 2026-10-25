// 错误问题汇总：同一类错误按指纹合并成一条“问题”，记录次数、首次/最近出现时间和处理状态。
//
// 原始记录仍写在 system_events（带 fingerprint 列），问题表只做聚合和状态流转。
// 已解决的问题再次出现会自动重新打开；已忽略的问题只累计次数，不再打扰。
import { createHash } from 'node:crypto';
import { sql, tx } from './db.mjs';

export const ISSUE_LEVELS = new Set(['critical', 'error', 'warning']);
export const ISSUE_STATUSES = new Set(['open', 'resolved', 'ignored']);
export const ISSUE_SOURCES = new Set(['server', 'web', 'desktop']);

const levelRank = `CASE %s WHEN 'critical' THEN 3 WHEN 'error' THEN 2 ELSE 1 END`;

/** 去掉消息里每次都不同的部分（ID、数字、路径、链接），让同一类错误落到同一个指纹。 */
export function normalizeErrorMessage(message) {
  return String(message || '')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+){2,}/g, '<path>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/"[^"]{16,}"|'[^']{16,}'/g, '<str>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** 取堆栈里第一处业务代码的位置；去掉行列号和缓存参数，避免每次发版都变成新问题。 */
export function stackLocation(stack) {
  for (const line of String(stack || '').split('\n').slice(1, 12)) {
    const match = line.match(/at\s+(?:(.+?)\s+\()?(.+?)(?::\d+)?(?::\d+)?\)?\s*$/) || line.match(/^(.*?)@(.+?)(?::\d+)?(?::\d+)?$/);
    if (!match) continue;
    const raw = String(match[2] || '').replace(/[?#].*$/, '').replace(/^[a-z][\w+.-]*:\/\/[^/]*\//i, '');
    const file = raw.match(/(?:^|\/)((?:lib|server|services|providers|repositories|jobs|public|features|desktop)\/.*)$/)?.[1] || raw.split('/').pop();
    if (!file || !/[/.]/.test(raw) || /node:|node_modules|<anonymous>/.test(raw)) continue;
    return `${String(match[1] || '').trim() || '<anonymous>'} ${file}`.trim().slice(0, 200);
  }
  return '';
}

export function errorFingerprint({ source = 'server', category = '', message = '', location = '' }) {
  return createHash('sha256').update([source, category, normalizeErrorMessage(message), location].join('\u0000')).digest('hex').slice(0, 24);
}

/** 写入一次发生记录；必须在调用方的事务或单条语句里执行。 */
export function touchIssue({ fingerprint, source, level, category, message, location = '', eventId = null, userId = null, modelId = null, at }) {
  sql(`
    INSERT INTO error_issues(fingerprint, source, level, category, message, location, status, occurrence_count,
                             first_seen_at, last_seen_at, last_event_id, last_user_id, last_model_id, updated_at)
    VALUES(:fingerprint, :source, :level, :category, :message, :location, 'open', 1,
           :at, :at, :eventId, :userId, :modelId, :at)
    ON CONFLICT(fingerprint) DO UPDATE SET
      occurrence_count = occurrence_count + 1,
      last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
      message = excluded.message,
      level = CASE WHEN ${levelRank.replace('%s', 'excluded.level')} > ${levelRank.replace('%s', 'level')} THEN excluded.level ELSE level END,
      last_event_id = COALESCE(excluded.last_event_id, last_event_id),
      last_user_id = COALESCE(excluded.last_user_id, last_user_id),
      last_model_id = COALESCE(excluded.last_model_id, last_model_id),
      reopened_count = reopened_count + (status = 'resolved'),
      status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
      resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
      resolved_by = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_by END,
      updated_at = excluded.updated_at
  `).run({ fingerprint, source, level, category, message: String(message).slice(0, 1000), location: location || null, eventId, userId, modelId, at });
}

// 同一个问题短时间内大量重复时，只保留前几条原始记录作为样本，次数照常累计。
const SAMPLE_WINDOW_MS = 60_000;
const SAMPLES_PER_WINDOW = 20;
const sampleWindows = new Map();
export function shouldKeepSample(fingerprint, at = Date.now()) {
  const window = sampleWindows.get(fingerprint);
  if (!window || at - window.start >= SAMPLE_WINDOW_MS) {
    if (sampleWindows.size > 5000) sampleWindows.clear();
    sampleWindows.set(fingerprint, { start: at, count: 1 });
    return true;
  }
  window.count += 1;
  return window.count <= SAMPLES_PER_WINDOW;
}
export function resetIssueSampling() { sampleWindows.clear(); }

/* ---------- 后台查询与处理 ---------- */

function issueFilters({ status = 'open', source = '', level = '', query = '' } = {}) {
  const where = [];
  const params = {};
  if (ISSUE_STATUSES.has(status)) { where.push('status = :status'); params.status = status; }
  if (ISSUE_SOURCES.has(source)) { where.push('source = :source'); params.source = source; }
  if (ISSUE_LEVELS.has(level)) { where.push('level = :level'); params.level = level; }
  const keyword = String(query || '').trim().slice(0, 200);
  if (keyword) { where.push("(message LIKE :query ESCAPE '\\' OR category LIKE :query ESCAPE '\\' OR fingerprint = :exact)"); params.query = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`; params.exact = keyword; }
  return { where, params };
}

export function publicIssue(row) {
  if (!row) return null;
  return {
    fingerprint: row.fingerprint, source: row.source, level: row.level, category: row.category, message: row.message,
    location: row.location || '', status: row.status, count: row.occurrence_count, userCount: row.user_count ?? null,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, lastUserId: row.last_user_id, lastUserNickname: row.last_user_nickname || '',
    lastModelId: row.last_model_id, resolvedAt: row.resolved_at, resolvedBy: row.resolved_by, reopenedCount: row.reopened_count,
    note: row.note || '', updatedAt: row.updated_at,
  };
}

export const issueSelect = `fingerprint, source, level, category, message, location, status, occurrence_count, first_seen_at, last_seen_at,
  last_event_id, last_user_id, last_model_id, resolved_at, resolved_by, reopened_count, note, updated_at,
  (SELECT COUNT(DISTINCT e.user_id) FROM system_events e WHERE e.fingerprint = error_issues.fingerprint) AS user_count,
  (SELECT COALESCE(u.nickname, u.username) FROM users u WHERE u.id = error_issues.last_user_id) AS last_user_nickname`;

export { issueFilters };

export function issueCounts({ source = '', level = '', query = '' } = {}) {
  const { where, params } = issueFilters({ status: '', source, level, query });
  const rows = sql(`SELECT status, COUNT(*) AS count FROM error_issues WHERE ${where.length ? where.join(' AND ') : '1=1'} GROUP BY status`).all(params);
  const counts = { open: 0, resolved: 0, ignored: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

export function findIssue(fingerprint) {
  return publicIssue(sql(`SELECT ${issueSelect} FROM error_issues WHERE fingerprint = :fingerprint`).get({ fingerprint: String(fingerprint || '') }));
}

export function issueEvents(fingerprint, limit = 20) {
  return sql(`SELECT e.id, e.level, e.category, e.request_id, e.user_id, COALESCE(u.nickname, u.username) AS user_nickname, e.model_id, e.generation_id, e.message, e.details_json, e.created_at
              FROM system_events e LEFT JOIN users u ON u.id = e.user_id
              WHERE e.fingerprint = :fingerprint ORDER BY e.created_at DESC, e.id ASC LIMIT :limit`).all({ fingerprint, limit })
    .map(row => {
      let details = null;
      try { details = row.details_json ? JSON.parse(row.details_json) : null; } catch {}
      return { id: row.id, level: row.level, category: row.category, requestId: row.request_id, userId: row.user_id, userNickname: row.user_nickname || '', modelId: row.model_id, generationId: row.generation_id, message: row.message, details, createdAt: row.created_at };
    });
}

export function setIssueStatus(fingerprint, { status, note }, { actorUserId = null, at = new Date().toISOString() } = {}) {
  const before = findIssue(fingerprint);
  if (!before) throw Object.assign(new Error('问题不存在'), { statusCode: 404 });
  const nextStatus = status === undefined ? before.status : String(status);
  if (!ISSUE_STATUSES.has(nextStatus)) throw Object.assign(new Error('处理状态无效'), { statusCode: 400 });
  const nextNote = note === undefined ? before.note : String(note || '').slice(0, 2000);
  const resolved = nextStatus === 'resolved';
  sql(`UPDATE error_issues SET status = :status, note = :note,
         resolved_at = CASE WHEN :resolved THEN COALESCE(CASE WHEN status = 'resolved' THEN resolved_at END, :at) ELSE NULL END,
         resolved_by = CASE WHEN :resolved THEN COALESCE(CASE WHEN status = 'resolved' THEN resolved_by END, :actor) ELSE NULL END,
         updated_at = :at
       WHERE fingerprint = :fingerprint`).run({ fingerprint: before.fingerprint, status: nextStatus, note: nextNote, resolved: resolved ? 1 : 0, at, actor: actorUserId });
  return { before, after: findIssue(fingerprint) };
}

/**
 * 一键解决：把当前筛选下、在 before 之前最后出现的未处理问题全部标为已解决。
 * before 取后台加载列表的时间，加载之后才新出现或复发的问题不会被一起关掉。
 */
export function resolveOpenIssues({ before, source = '', level = '', query = '' } = {}, { actorUserId = null, at = new Date().toISOString() } = {}) {
  const cutoff = before && !Number.isNaN(Date.parse(before)) ? new Date(Math.min(Date.parse(before), Date.parse(at))).toISOString() : at;
  const { where, params } = issueFilters({ status: 'open', source, level, query });
  where.push('last_seen_at <= :cutoff');
  const result = sql(`UPDATE error_issues SET status = 'resolved', resolved_at = :at, resolved_by = :actor, updated_at = :at WHERE ${where.join(' AND ')}`)
    .run({ ...params, cutoff, at, actor: actorUserId });
  return { resolved: Number(result.changes) || 0, cutoff };
}

/** 原始记录保留 keepDays 天；问题汇总长期保留，已解决或已忽略且很久没再出现的才清掉。 */
export function pruneErrorHistory({ keepDays = 30, issueKeepDays = 180, at = Date.now() } = {}) {
  const eventCutoff = new Date(at - keepDays * 86400_000).toISOString();
  const issueCutoff = new Date(at - issueKeepDays * 86400_000).toISOString();
  const events = sql('DELETE FROM system_events WHERE fingerprint IS NOT NULL AND created_at < :cutoff').run({ cutoff: eventCutoff });
  const issues = sql("DELETE FROM error_issues WHERE status <> 'open' AND last_seen_at < :cutoff").run({ cutoff: issueCutoff });
  return { events: Number(events.changes) || 0, issues: Number(issues.changes) || 0 };
}

/** 上线前已有的错误记录没有指纹；启动时按时间顺序补齐，让历史错误也出现在问题列表里。 */
export function backfillIssues({ batch = 500 } = {}) {
  let total = 0;
  for (;;) {
    const rows = sql(`SELECT id, level, category, user_id, model_id, message, created_at FROM system_events
                      WHERE fingerprint IS NULL AND level IN ('critical', 'error', 'warning')
                      ORDER BY created_at ASC, id ASC LIMIT :batch`).all({ batch });
    if (!rows.length) return total;
    tx(() => {
      for (const row of rows) {
        const fingerprint = errorFingerprint({ source: 'server', category: row.category, message: row.message });
        sql('UPDATE system_events SET fingerprint = :fingerprint WHERE id = :id').run({ fingerprint, id: row.id });
        touchIssue({ fingerprint, source: 'server', level: row.level, category: row.category, message: row.message, eventId: row.id, userId: row.user_id, modelId: row.model_id, at: row.created_at });
      }
    });
    total += rows.length;
  }
}
