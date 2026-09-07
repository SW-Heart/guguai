import { randomUUID } from 'node:crypto';

import { sql, tx } from '../lib/db.mjs';

function parseGenerationRequestRow(row) {
  if (!row) return null;
  let generationIds;
  try { generationIds = JSON.parse(row.generation_ids_json); } catch { generationIds = []; }
  return {
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    generationIds: Array.isArray(generationIds) ? generationIds.map(String) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findGenerationRequest(userId, idempotencyKey) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return null;
  return parseGenerationRequestRow(sql(`
    SELECT user_id, idempotency_key, request_hash, generation_ids_json, created_at, updated_at
    FROM generation_requests
    WHERE user_id = :userId AND idempotency_key = :idempotencyKey
  `).get({ userId, idempotencyKey: key }));
}

export function createGenerationRequest({ userId, idempotencyKey, requestHash, generationIds } = {}) {
  const key = String(idempotencyKey || '').trim();
  const hash = String(requestHash || '').trim();
  const ids = [...new Set((Array.isArray(generationIds) ? generationIds : []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!key || !hash || !ids.length) throw new Error('生成幂等记录参数无效');
  return tx(() => {
    const timestamp = Date.now();
    sql(`
      INSERT INTO generation_requests(
        user_id, idempotency_key, request_hash, generation_ids_json, created_at, updated_at
      ) VALUES(:userId, :idempotencyKey, :requestHash, :generationIdsJson, :createdAt, :updatedAt)
      ON CONFLICT(user_id, idempotency_key) DO NOTHING
    `).run({
      userId,
      idempotencyKey: key,
      requestHash: hash,
      generationIdsJson: JSON.stringify(ids),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const saved = findGenerationRequest(userId, key);
    if (!saved) throw new Error('生成幂等记录保存失败');
    if (saved.requestHash !== hash || JSON.stringify(saved.generationIds) !== JSON.stringify(ids)) {
      throw Object.assign(new Error('同一个幂等键不能用于不同请求'), { statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    return saved;
  });
}

export function generationJobLeaseActive({ id, owner, leaseToken, now = Date.now() } = {}) {
  return Boolean(sql(`
    SELECT 1
    FROM generation_jobs
    WHERE id = :id
      AND state = 'leased'
      AND lease_owner = :owner
      AND lease_token = :leaseToken
      AND lease_until > :now
  `).get({ id, owner, leaseToken, now }));
}

export function generationQueueStats(now = Date.now()) {
  const jobs = sql(`
    SELECT
      SUM(state = 'pending') AS pendingJobs,
      SUM(state = 'leased') AS leasedJobs,
      SUM(state = 'leased' AND lease_until <= :now) AS expiredLeases,
      SUM(state = 'manual_review') AS manualReviewJobs
    FROM generation_jobs`).get({ now });
  const generations = sql(`
    SELECT
      SUM(status IN ('queued', 'running')) AS pendingGenerations,
      SUM(status = 'failed' AND credit_status IN ('refund_failed', 'billing_reconcile_required')) AS refundPendingGenerations
    FROM generations`).get();
  return {
    pendingJobs: Number(jobs?.pendingJobs || 0),
    leasedJobs: Number(jobs?.leasedJobs || 0),
    expiredLeases: Number(jobs?.expiredLeases || 0),
    manualReviewJobs: Number(jobs?.manualReviewJobs || 0),
    pendingGenerations: Number(generations?.pendingGenerations || 0),
    refundPendingGenerations: Number(generations?.refundPendingGenerations || 0),
  };
}

export function enqueueGenerationJob({ userId, generationId, kind = 'generation', nextRunAt = Date.now(), preserveScheduledTime = false }) {
  const timestamp = Date.now();
  const jobId = randomUUID();
  tx(() => {
    sql(`
      INSERT INTO generation_jobs(
        id, user_id, generation_id, kind, state, next_run_at, attempt_count,
        lease_owner, lease_token, lease_until, last_error_code, last_error_message,
        created_at, updated_at
      )
      VALUES(:id, :userId, :generationId, :kind, 'pending', :nextRunAt, 0,
             NULL, 0, NULL, NULL, NULL, :createdAt, :updatedAt)
      ON CONFLICT(generation_id, kind) DO UPDATE SET
        state = CASE WHEN generation_jobs.state = 'leased' THEN 'leased' ELSE 'pending' END,
        next_run_at = CASE WHEN generation_jobs.state = 'leased'
                                OR (generation_jobs.state = 'pending' AND :preserveScheduledTime = 1)
                           THEN generation_jobs.next_run_at
                           ELSE MIN(generation_jobs.next_run_at, excluded.next_run_at)
                      END,
        lease_owner = CASE WHEN generation_jobs.state = 'leased' THEN generation_jobs.lease_owner ELSE NULL END,
        lease_until = CASE WHEN generation_jobs.state = 'leased' THEN generation_jobs.lease_until ELSE NULL END,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = excluded.updated_at`).run({
      id: jobId,
      userId,
      generationId,
      kind,
      nextRunAt: Math.max(0, Math.floor(Number(nextRunAt) || timestamp)),
      preserveScheduledTime: preserveScheduledTime ? 1 : 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  return sql(`
    SELECT id, user_id AS userId, generation_id AS generationId, kind, state,
           next_run_at AS nextRunAt, attempt_count AS attemptCount,
           lease_owner AS leaseOwner, lease_token AS leaseToken, lease_until AS leaseUntil
    FROM generation_jobs
    WHERE user_id = :userId AND generation_id = :generationId AND kind = :kind`).get({ userId, generationId, kind });
}

export function claimGenerationJobs({ owner, now = Date.now(), limit = 4, leaseMs = 300_000, excludeGenerationIds = [] } = {}) {
  const normalizedOwner = String(owner || '').trim();
  if (!normalizedOwner) throw new Error('任务执行器标识不能为空');
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 1)));
  const normalizedLeaseMs = Math.max(1_000, Math.floor(Number(leaseMs) || 1_000));
  const excluded = [...new Set((Array.isArray(excludeGenerationIds) ? excludeGenerationIds : []).map(value => String(value || '')).filter(Boolean))];
  const excludedParams = Object.fromEntries(excluded.map((value, index) => [`excludedGenerationId${index}`, value]));
  const excludedWhere = excluded.length ? `AND generation_id NOT IN (${excluded.map((_, index) => `:excludedGenerationId${index}`).join(', ')})` : '';
  const candidateLimit = normalizedLimit * 5;
  return tx(() => {
    const candidates = sql(`
      SELECT id, user_id AS userId, generation_id AS generationId, kind,
             next_run_at AS nextRunAt, attempt_count AS attemptCount, lease_token AS leaseToken
      FROM generation_jobs
      WHERE ((state = 'pending' AND next_run_at <= :now)
         OR (state = 'leased' AND lease_until <= :now))
        AND NOT EXISTS (
          SELECT 1
          FROM generation_jobs AS active
          WHERE active.generation_id = generation_jobs.generation_id
            AND active.state = 'leased'
            AND active.lease_until > :now
        )
        ${excludedWhere}
      ORDER BY next_run_at ASC, created_at ASC, id ASC
      LIMIT :limit`).all({ now, limit: candidateLimit, ...excludedParams });
    const claimed = [];
    const claimedGenerationIds = new Set();
    for (const candidate of candidates) {
      if (claimedGenerationIds.has(candidate.generationId)) continue;
      const leaseToken = Number(candidate.leaseToken) + 1;
      const result = sql(`
        UPDATE generation_jobs
        SET state = 'leased', lease_owner = :owner, lease_token = :leaseToken,
            lease_until = :leaseUntil, attempt_count = attempt_count + 1,
            updated_at = :updatedAt
        WHERE id = :id
          AND ((state = 'pending' AND next_run_at <= :now)
            OR (state = 'leased' AND lease_until <= :now))`).run({
        id: candidate.id,
        owner: normalizedOwner,
        leaseToken,
        leaseUntil: now + normalizedLeaseMs,
        updatedAt: now,
        now,
      });
      if (!result.changes) continue;
      claimed.push({ ...candidate, state: 'leased', leaseOwner: normalizedOwner, leaseToken, leaseUntil: now + normalizedLeaseMs, attemptCount: Number(candidate.attemptCount) + 1 });
      claimedGenerationIds.add(candidate.generationId);
      if (claimed.length >= normalizedLimit) break;
    }
    return claimed;
  });
}

export function renewGenerationJobLease({ id, owner, leaseToken, leaseUntil = Date.now() + 300_000, now = Date.now() } = {}) {
  const currentTime = Math.max(0, Math.floor(Number(now)));
  const normalizedLeaseUntil = Math.max(0, Math.floor(Number(leaseUntil) || 0));
  if (normalizedLeaseUntil <= currentTime) return false;
  return sql(`
    UPDATE generation_jobs
    SET lease_until = :leaseUntil, updated_at = :updatedAt
    WHERE id = :id AND state = 'leased' AND lease_owner = :owner AND lease_token = :leaseToken
      AND lease_until > :now
  `).run({ id, owner, leaseToken, leaseUntil: normalizedLeaseUntil, now: currentTime, updatedAt: currentTime }).changes > 0;
}

export function completeGenerationJob({ id, owner, leaseToken, now = Date.now() } = {}) {
  const currentTime = Math.max(0, Math.floor(Number(now)));
  return sql(`
    UPDATE generation_jobs
    SET state = 'done', lease_owner = NULL, lease_until = NULL, updated_at = :updatedAt
    WHERE id = :id AND state = 'leased' AND lease_owner = :owner AND lease_token = :leaseToken
      AND lease_until > :now
  `).run({ id, owner, leaseToken, now: currentTime, updatedAt: currentTime }).changes > 0;
}

export function rescheduleGenerationJob({ id, owner, leaseToken, kind = null, nextRunAt = null, errorCode = null, errorMessage = null, now = Date.now() } = {}) {
  const currentTime = Math.max(0, Math.floor(Number(now)));
  const dueAt = Math.max(0, Math.floor(Number(nextRunAt) || currentTime));
  const normalizedErrorCode = errorCode ? String(errorCode).slice(0, 100) : null;
  const normalizedErrorMessage = errorMessage ? String(errorMessage).slice(0, 1000) : null;
  return tx(() => {
    const current = sql('SELECT generation_id, kind, state, lease_owner, lease_token, lease_until FROM generation_jobs WHERE id = :id').get({ id });
    if (!current || current.state !== 'leased' || current.lease_owner !== owner || Number(current.lease_token) !== Number(leaseToken) || Number(current.lease_until) <= currentTime) return false;
    const nextKind = String(kind || current.kind || 'generation');
    const conflict = sql(`
      SELECT id, state, next_run_at AS nextRunAt
      FROM generation_jobs
      WHERE generation_id = :generationId AND kind = :kind AND id != :id
    `).get({ generationId:current.generation_id, kind:nextKind, id });
    if (conflict) {
      if (conflict.state !== 'leased') {
        sql(`
          UPDATE generation_jobs
          SET state = 'pending', next_run_at = MIN(next_run_at, :nextRunAt),
              last_error_code = :errorCode, last_error_message = :errorMessage, updated_at = :updatedAt
          WHERE id = :id
        `).run({ id:conflict.id, nextRunAt:dueAt, errorCode:normalizedErrorCode, errorMessage:normalizedErrorMessage, updatedAt:currentTime });
      }
      return sql(`
        UPDATE generation_jobs
        SET state = 'done', lease_owner = NULL, lease_until = NULL, updated_at = :updatedAt
        WHERE id = :id AND state = 'leased' AND lease_owner = :owner AND lease_token = :leaseToken
          AND lease_until > :now
      `).run({ id, owner, leaseToken, now:currentTime, updatedAt:currentTime }).changes > 0;
    }
    return sql(`
      UPDATE generation_jobs
      SET state = 'pending', kind = :kind, next_run_at = :nextRunAt, lease_owner = NULL, lease_until = NULL,
          last_error_code = :errorCode, last_error_message = :errorMessage, updated_at = :updatedAt
      WHERE id = :id AND state = 'leased' AND lease_owner = :owner AND lease_token = :leaseToken
        AND lease_until > :now
    `).run({
      id, owner, leaseToken, kind:nextKind, nextRunAt:dueAt,
      errorCode:normalizedErrorCode, errorMessage:normalizedErrorMessage, updatedAt:currentTime, now:currentTime,
    }).changes > 0;
  });
}
