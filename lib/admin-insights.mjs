import { sql } from './db.mjs';

const CREDITS_PER_YUAN = 10;
const ratio = (part, whole) => whole ? Math.round(part / whole * 1000) / 10 : null;
const yuan = value => Math.round(Number(value || 0) * 100) / 100;

// Paid orders from both payment providers, one row per order that actually got paid.
const PAID_USERS_SQL = `
  SELECT user_id FROM alipay_payment_orders
   WHERE status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND paid_at IS NOT NULL
  UNION
  SELECT user_id FROM wechat_payment_orders
   WHERE json_extract(doc_json, '$.status') IN ('PAID', 'REFUNDING', 'REFUNDED')
     AND json_extract(doc_json, '$.paidAt') IS NOT NULL`;

// Funnel for people who signed up in the range (all time without a range).
// "Came back" means another generation on day 2–7 after signing up; only
// accounts at least 7 days old can qualify, so they form its denominator.
export function signupFunnel({ from = null, to = null, now = new Date().toISOString() } = {}) {
  const range = from && to ? 'AND u.created_at >= :from AND u.created_at < :to' : '';
  const row = sql(`
    WITH cohort AS (
      SELECT id, created_at FROM users u WHERE u.role = 'user' ${range}
    ), activity AS (
      SELECT c.id,
             c.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', :now, '-7 days') AS mature,
             EXISTS (SELECT 1 FROM generations g WHERE g.user_id = c.id) AS generated,
             EXISTS (SELECT 1 FROM generations g WHERE g.user_id = c.id AND g.status = 'completed') AS succeeded,
             c.id IN (${PAID_USERS_SQL}) AS paid,
             EXISTS (SELECT 1 FROM generations g WHERE g.user_id = c.id
                       AND julianday(g.created_at) - julianday(c.created_at) >= 1
                       AND julianday(g.created_at) - julianday(c.created_at) < 7) AS returned
        FROM cohort c
    )
    SELECT COUNT(*) AS registered,
           COALESCE(SUM(generated), 0) AS generated,
           COALESCE(SUM(succeeded), 0) AS succeeded,
           COALESCE(SUM(paid), 0) AS paid,
           COALESCE(SUM(mature), 0) AS matured,
           COALESCE(SUM(mature AND returned), 0) AS returned
      FROM activity`).get({ ...(from && to ? { from, to } : {}), now });
  const registered = Number(row.registered);
  return {
    registered,
    generated: Number(row.generated),
    succeeded: Number(row.succeeded),
    paid: Number(row.paid),
    generatedRate: ratio(Number(row.generated), registered),
    succeededRate: ratio(Number(row.succeeded), registered),
    paidRate: ratio(Number(row.paid), registered),
    returnEligible: Number(row.matured),
    returned: Number(row.returned),
    returnedRate: ratio(Number(row.returned), Number(row.matured)),
  };
}

// Per-model quality and margin for generations created in the range.
// Revenue is the credits actually kept on completed work (10 credits = 1 yuan,
// gift credits included); cost is the upstream price recorded when the work
// was routed, so models without a recorded cost show revenue only.
export function modelPerformance({ from = null, to = null } = {}) {
  const range = from && to ? 'AND g.created_at >= :from AND g.created_at < :to' : '';
  const rows = sql(`
    SELECT g.model_id AS modelId,
           MIN(g.type) AS type,
           COUNT(*) AS total,
           SUM(g.status = 'completed') AS completed,
           SUM(g.status = 'failed') AS failed,
           SUM(g.status IN ('queued', 'running')) AS pending,
           AVG(CASE WHEN g.status = 'completed' THEN
             (julianday(COALESCE(json_extract(g.doc_json, '$.finishedAt'), g.updated_at)) - julianday(g.created_at)) * 86400 END) AS avgSeconds,
           SUM(CASE WHEN g.status = 'completed' AND g.credit_status = 'charged' THEN COALESCE(g.credit_cost_micro, 0) ELSE 0 END) AS revenueMicro,
           SUM(CASE WHEN g.status = 'completed' AND json_extract(g.pricing_snapshot_json, '$.costYuan') IS NOT NULL THEN 1 ELSE 0 END) AS costedCount,
           SUM(CASE WHEN g.status = 'completed' THEN json_extract(g.pricing_snapshot_json, '$.costYuan') END) AS costYuan,
           SUM(CASE WHEN g.status = 'completed' AND g.credit_status = 'charged' AND json_extract(g.pricing_snapshot_json, '$.costYuan') IS NOT NULL
                    THEN COALESCE(g.credit_cost_micro, 0) ELSE 0 END) AS costedRevenueMicro
      FROM generations g JOIN users u ON u.id = g.user_id
     WHERE u.role = 'user' AND g.model_id IS NOT NULL AND g.model_id <> '' ${range}
     GROUP BY g.model_id
     ORDER BY total DESC, g.model_id`).all(from && to ? { from, to } : {});
  return rows.map(row => {
    const completed = Number(row.completed || 0);
    const failed = Number(row.failed || 0);
    const costedCount = Number(row.costedCount || 0);
    const costedRevenue = Number(row.costedRevenueMicro || 0) / 1_000_000 / CREDITS_PER_YUAN;
    const cost = costedCount ? Number(row.costYuan || 0) : null;
    return {
      modelId: row.modelId,
      type: row.type,
      total: Number(row.total),
      completed,
      failed,
      pending: Number(row.pending || 0),
      successRate: ratio(completed, completed + failed),
      avgSeconds: row.avgSeconds === null ? null : Math.round(Number(row.avgSeconds)),
      revenueYuan: yuan(Number(row.revenueMicro || 0) / 1_000_000 / CREDITS_PER_YUAN),
      costYuan: cost === null ? null : yuan(cost),
      grossProfitYuan: cost === null ? null : yuan(costedRevenue - cost),
      grossMarginRate: cost === null ? null : ratio(costedRevenue - cost, costedRevenue),
      costCoverage: ratio(costedCount, completed),
    };
  });
}

export function adminInsights({ from = null, to = null, now } = {}) {
  return { funnel: signupFunnel({ from, to, now }), models: modelPerformance({ from, to }) };
}
