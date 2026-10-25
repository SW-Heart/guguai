import { randomUUID, createHash } from 'node:crypto';
import { sql } from './db.mjs';
import { ISSUE_LEVELS, errorFingerprint, shouldKeepSample, touchIssue } from './error-issues.mjs';

const now = () => new Date().toISOString();
const json = value => value === undefined || value === null ? null : JSON.stringify(value);

export function hashIp(value) {
  return value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 32) : null;
}

export function appendAuditEvent({ actorUserId = null, action, targetType, targetId = null, requestId = null, status = 'succeeded', before = null, after = null, metadata = null, ip = null, userAgent = null, createdAt = now() }) {
  const id = randomUUID();
  sql(`
    INSERT INTO audit_events(id, actor_user_id, action, target_type, target_id, request_id,
                             status, before_json, after_json, metadata_json, ip_hash, user_agent, created_at)
    VALUES(:id, :actorUserId, :action, :targetType, :targetId, :requestId,
           :status, :beforeJson, :afterJson, :metadataJson, :ipHash, :userAgent, :createdAt)
  `).run({
    id, actorUserId, action, targetType, targetId, requestId, status,
    beforeJson: json(before), afterJson: json(after), metadataJson: json(metadata),
    ipHash: hashIp(ip), userAgent: userAgent ? String(userAgent).slice(0, 500) : null, createdAt,
  });
  return { id, actorUserId, action, targetType, targetId, requestId, status, createdAt };
}

// error / critical / warning 级别的记录会同时汇总成“问题”，供后台异常中心集中处理；
// info 级别只是运营记录，不进入问题列表。
export function appendSystemEvent({ level = 'error', category, requestId = null, userId = null, modelId = null, generationId = null, message, details = null, createdAt = now(), source = 'server', location = '' }) {
  const id = randomUUID();
  const text = String(message).slice(0, 1000);
  const tracked = ISSUE_LEVELS.has(level);
  const fingerprint = tracked ? errorFingerprint({ source, category, message: text, location }) : null;
  const keep = !tracked || shouldKeepSample(fingerprint, Date.parse(createdAt) || Date.now());
  if (keep) {
    sql(`
      INSERT INTO system_events(id, level, category, request_id, user_id, model_id, generation_id, message, details_json, created_at, fingerprint)
      VALUES(:id, :level, :category, :requestId, :userId, :modelId, :generationId, :message, :detailsJson, :createdAt, :fingerprint)
    `).run({ id, level, category, requestId, userId, modelId, generationId, message: text, detailsJson: json(details), createdAt, fingerprint });
  }
  if (tracked) touchIssue({ fingerprint, source, level, category, message: text, location, eventId: keep ? id : null, userId, modelId, at: createdAt });
  return { id: keep ? id : null, fingerprint, createdAt };
}
