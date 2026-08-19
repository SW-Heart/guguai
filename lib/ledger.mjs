/**
 * Credit accounting on SQLite.
 *
 * Every operation updates the wallet and appends its ledger entry inside one
 * transaction, so the invariant `balance == SUM(entries.amount_micro)` holds
 * even if the process dies mid-operation. The old implementation wrote
 * users.json and the ledger file separately and unwound by hand, which left a
 * window where a crash produced a balance with no matching entry.
 *
 * Idempotency is enforced by the UNIQUE(user_id, idempotency_key) constraint on
 * credit_entries: replaying `charge-{generationId}` can never double-charge.
 *
 * The transaction bodies are deliberately synchronous. node:sqlite is a
 * synchronous API, and awaiting inside a transaction would let unrelated work
 * interleave on the shared connection.
 */
import { randomUUID } from 'node:crypto';
import { sql, tx } from './db.mjs';
import { withUserLock } from './user-lock.mjs';
import { creditsToMicro, llmCostMicro, microToCredits } from './billing.mjs';

let config = { llmRates: null, llmProtocol: 'openai-compatible', llmModel: '' };

export function configureLedger({ llmRates, llmProtocol, llmModel }) {
  config = { llmRates, llmProtocol, llmModel };
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------- wallet

function selectUser(userId) {
  return sql(`
    SELECT id, username, role, credit_balance_micro AS balanceMicro,
           credit_held_micro AS heldMicro, doc_json
    FROM users WHERE id = :userId`).get({ userId });
}

function snapshot(balanceMicro, heldMicro) {
  const availableMicro = Math.max(0, balanceMicro - heldMicro);
  return {
    balance: microToCredits(balanceMicro),
    held: microToCredits(heldMicro),
    available: microToCredits(availableMicro),
    balanceMicro,
    heldMicro,
    availableMicro,
  };
}

/** Writes both wallet columns in one statement so the CHECK constraints never
 *  observe an intermediate state where held > balance. */
function writeWallet(userId, balanceMicro, heldMicro) {
  const row = sql('SELECT doc_json FROM users WHERE id = :userId').get({ userId });
  const doc = row ? JSON.parse(row.doc_json) : {};
  doc.creditBalanceMicro = balanceMicro;
  doc.creditHeldMicro = heldMicro;
  doc.credits = microToCredits(balanceMicro);
  sql(`
    UPDATE users
    SET credit_balance_micro = :balanceMicro,
        credit_held_micro    = :heldMicro,
        doc_json             = :docJson
    WHERE id = :userId`).run({ userId, balanceMicro, heldMicro, docJson: JSON.stringify(doc) });
}

function appendEntry(userId, idempotencyKey, entry) {
  const amountMicro = entry.amountMicro ?? 0;
  const record = {
    id: randomUUID(),
    userId,
    ...entry,
    amount: microToCredits(Math.abs(amountMicro)) * (amountMicro < 0 ? -1 : 1),
    amountMicro,
    createdAt: now(),
  };
  sql(`
    INSERT INTO credit_entries(id, user_id, actor_user_id, idempotency_key, type, reason_code, note, external_ref,
                               amount_micro, balance_after_micro, generation_id, request_id, created_at, doc_json)
    VALUES(:id, :userId, :actorUserId, :idempotencyKey, :type, :reasonCode, :note, :externalRef,
           :amountMicro, :balanceAfterMicro, :generationId, :requestId, :createdAt, :docJson)`).run({
    id: record.id,
    userId,
    actorUserId: record.actorUserId ?? null,
    idempotencyKey,
    type: record.type,
    reasonCode: record.reasonCode ?? null,
    note: record.note ?? null,
    externalRef: record.externalRef ?? null,
    amountMicro,
    balanceAfterMicro: record.balanceAfterMicro,
    generationId: record.generationId ?? null,
    requestId: record.requestId ?? null,
    createdAt: record.createdAt,
    docJson: JSON.stringify(record),
  });
  return record;
}

function findEntry(userId, idempotencyKey) {
  const row = sql(`
    SELECT doc_json FROM credit_entries
    WHERE user_id = :userId AND idempotency_key = :idempotencyKey`).get({ userId, idempotencyKey });
  return row ? JSON.parse(row.doc_json) : null;
}

export function walletOf(userId) {
  const user = selectUser(userId);
  return user ? snapshot(user.balanceMicro, user.heldMicro) : null;
}

// ---------------------------------------------------------------- holds

function selectHold(userId, id) {
  const row = sql('SELECT doc_json FROM billing_holds WHERE user_id = :userId AND id = :id')
    .get({ userId, id });
  return row ? JSON.parse(row.doc_json) : null;
}

function writeHold(userId, hold) {
  sql(`
    INSERT INTO billing_holds(id, user_id, type, status, reserved_micro, charged_micro,
                              created_at, updated_at, doc_json)
    VALUES(:id, :userId, :type, :status, :reservedMicro, :chargedMicro,
           :createdAt, :updatedAt, :docJson)
    ON CONFLICT(user_id, id) DO UPDATE SET
      status         = excluded.status,
      charged_micro  = excluded.charged_micro,
      updated_at     = excluded.updated_at,
      doc_json       = excluded.doc_json`).run({
    id: hold.id,
    userId,
    type: hold.type ?? 'llm',
    status: hold.status,
    reservedMicro: hold.reservedMicro,
    chargedMicro: hold.chargedMicro ?? null,
    createdAt: hold.createdAt,
    updatedAt: hold.updatedAt,
    docJson: JSON.stringify(hold),
  });
}

function writeLlmUsage(userId, usage) {
  sql(`
    INSERT INTO llm_usage(id, user_id, status, model, input_tokens, output_tokens,
                          charged_micro, created_at, doc_json)
    VALUES(:id, :userId, :status, :model, :inputTokens, :outputTokens,
           :chargedMicro, :createdAt, :docJson)
    ON CONFLICT(user_id, id) DO UPDATE SET
      status        = excluded.status,
      model         = excluded.model,
      input_tokens  = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      charged_micro = excluded.charged_micro,
      doc_json      = excluded.doc_json`).run({
    id: usage.id,
    userId,
    status: usage.status ?? null,
    model: usage.model ?? null,
    inputTokens: Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : null,
    outputTokens: Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : null,
    chargedMicro: Number.isSafeInteger(usage.chargedMicro) ? usage.chargedMicro : null,
    createdAt: usage.createdAt,
    docJson: JSON.stringify(usage),
  });
}

export function llmUsageOf(userId, id) {
  const row = sql('SELECT doc_json FROM llm_usage WHERE user_id = :userId AND id = :id')
    .get({ userId, id });
  return row ? JSON.parse(row.doc_json) : null;
}

// ---------------------------------------------------------------- operations

export function chargeGenerationMicro(userId, generationId, costMicro, metadata = {}) {
  return withUserLock(userId, () => tx(() => {
    const key = `charge-${generationId}`;
    const replay = findEntry(userId, key);
    const user = selectUser(userId);
    if (!user) return { status: 401, error: '账号不存在' };
    if (replay) return snapshot(user.balanceMicro, user.heldMicro);
    if (!Number.isSafeInteger(costMicro) || costMicro < 0) throw new Error('生成费用无效');

    const availableMicro = Math.max(0, user.balanceMicro - user.heldMicro);
    if (availableMicro < costMicro) {
      return {
        status: 402,
        error: `积分不足，本次需要 ${microToCredits(costMicro)} 积分，当前可用 ${microToCredits(availableMicro)} 积分`,
        balance: microToCredits(user.balanceMicro),
        available: microToCredits(availableMicro),
      };
    }

    const balanceMicro = user.balanceMicro - costMicro;
    writeWallet(userId, balanceMicro, user.heldMicro);
    const { onCharged, ...entryMetadata } = metadata;
    appendEntry(userId, key, {
      type: 'generation_charge', amountMicro: -costMicro,
      balanceAfter: microToCredits(balanceMicro), balanceAfterMicro: balanceMicro,
      generationId, ...entryMetadata, note: entryMetadata.note || '生成任务预扣费',
    });
    onCharged?.();
    return snapshot(balanceMicro, user.heldMicro);
  }));
}

export function chargeGeneration(userId, generationId, cost) {
  return Promise.resolve().then(() => chargeGenerationMicro(userId, generationId, creditsToMicro(cost)));
}

export function refundGenerationMicro(userId, generationId, costMicro, metadata = {}) {
  return withUserLock(userId, () => tx(() => {
    const key = `refund-${generationId}`;
    const user = selectUser(userId);
    if (!user) throw new Error('退款账号不存在');
    if (findEntry(userId, key)) return microToCredits(user.balanceMicro);
    if (!Number.isSafeInteger(costMicro) || costMicro < 0) throw new Error('退款金额无效');

    const balanceMicro = user.balanceMicro + costMicro;
    writeWallet(userId, balanceMicro, user.heldMicro);
    appendEntry(userId, key, {
      type: 'generation_refund', amountMicro: costMicro,
      balanceAfter: microToCredits(balanceMicro), balanceAfterMicro: balanceMicro,
      generationId, ...metadata, note: metadata.note || '生成失败自动退回',
    });
    return microToCredits(balanceMicro);
  }));
}

export function refundGeneration(userId, generationId, cost) {
  return Promise.resolve().then(() => refundGenerationMicro(userId, generationId, creditsToMicro(cost)));
}

/** Adds or removes credits through the same locked, transactional ledger path. */
export function adjustCredits(userId, amountMicro, { actorUserId, idempotencyKey, reasonCode, note = '', externalRef = null, onAudit = null } = {}) {
  return withUserLock(userId, () => tx(() => {
    if (!Number.isSafeInteger(amountMicro) || amountMicro === 0) throw Object.assign(new Error('调账金额必须是非零安全整数'), { statusCode: 400 });
    if (!idempotencyKey) throw Object.assign(new Error('调账幂等键不能为空'), { statusCode: 400 });
    const existing = findEntry(userId, idempotencyKey);
    if (existing) return { ...snapshot(selectUser(userId).balanceMicro, selectUser(userId).heldMicro), entry: existing, replay: true };
    const user = selectUser(userId);
    if (!user) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    const balanceMicro = user.balanceMicro + amountMicro;
    if (balanceMicro < user.heldMicro || balanceMicro < 0) throw Object.assign(new Error('调账后余额不能低于冻结积分'), { statusCode: 409 });
    writeWallet(userId, balanceMicro, user.heldMicro);
    const entry = appendEntry(userId, idempotencyKey, {
      type: 'admin_credit_adjustment', amountMicro, balanceAfter: microToCredits(balanceMicro),
      balanceAfterMicro: balanceMicro, actorUserId, reasonCode, note: String(note).slice(0, 500), externalRef,
    });
    onAudit?.({ before: snapshot(user.balanceMicro, user.heldMicro), after: snapshot(balanceMicro, user.heldMicro), entry });
    return { ...snapshot(balanceMicro, user.heldMicro), entry, replay: false };
  }));
}

export function reserveLlmCredits(userId, requestId, reservedMicro, metadata = {}) {
  return withUserLock(userId, () => tx(() => {
    const existing = selectHold(userId, requestId);
    if (existing) return existing;

    const user = selectUser(userId);
    if (!user) return { status: 401, error: '账号不存在' };

    const availableMicro = Math.max(0, user.balanceMicro - user.heldMicro);
    if (availableMicro < reservedMicro) {
      return {
        status: 402,
        error: `积分不足，本次最多需要 ${microToCredits(reservedMicro)} 积分，当前可用 ${microToCredits(availableMicro)} 积分`,
        ...snapshot(user.balanceMicro, user.heldMicro),
      };
    }

    const heldMicro = user.heldMicro + reservedMicro;
    const hold = {
      id: requestId, userId, type: 'llm', status: 'held', reservedMicro,
      ...metadata, createdAt: now(), updatedAt: now(),
    };
    writeWallet(userId, user.balanceMicro, heldMicro);
    writeHold(userId, hold);
    appendEntry(userId, `hold-${requestId}`, {
      type: 'llm_hold',
      amountMicro: 0,
      heldMicro: reservedMicro,
      balanceAfter: microToCredits(user.balanceMicro),
      balanceAfterMicro: user.balanceMicro,
      requestId,
      note: 'LLM 调用额度冻结',
    });
    return { ...hold, wallet: snapshot(user.balanceMicro, heldMicro) };
  }));
}

export function settleLlmCredits(userId, requestId, result, metadata = {}) {
  return withUserLock(userId, () => tx(() => {
    const hold = selectHold(userId, requestId);
    if (!hold) throw new Error('LLM 计费冻结记录不存在');
    if (hold.status === 'settled') return llmUsageOf(userId, requestId);
    if (hold.status !== 'held') throw new Error(`LLM 计费记录状态不允许结算：${hold.status}`);

    const actualMicro = llmCostMicro(result.usage.inputTokens, result.usage.outputTokens, config.llmRates);
    if (actualMicro > hold.reservedMicro) {
      throw Object.assign(new Error('LLM 实际费用超过预授权额度，需人工核账'), { billingReconcileRequired: true });
    }

    const user = selectUser(userId);
    if (!user) throw new Error('账号不存在');
    if (user.balanceMicro < actualMicro || user.heldMicro < hold.reservedMicro) {
      throw new Error('LLM 结算余额状态异常');
    }

    const balanceMicro = user.balanceMicro - actualMicro;
    const heldMicro = user.heldMicro - hold.reservedMicro;
    const usage = {
      id: requestId, userId, status: 'settled',
      provider: config.llmProtocol, providerRequestId: result.providerRequestId,
      configuredModel: config.llmModel, model: result.model || config.llmModel,
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      inputRateYuanPerMillion: config.llmRates.inputYuanPerMillion,
      outputRateYuanPerMillion: config.llmRates.outputYuanPerMillion,
      chargedMicro: actualMicro, chargedCredits: microToCredits(actualMicro),
      ...metadata, createdAt: now(), settledAt: now(),
    };

    writeWallet(userId, balanceMicro, heldMicro);
    writeLlmUsage(userId, usage);
    writeHold(userId, {
      ...hold,
      status: 'settled',
      chargedMicro: actualMicro,
      updatedAt: now(),
      settledAt: now(),
    });
    appendEntry(userId, `capture-${requestId}`, {
      type: 'llm_capture',
      amountMicro: -actualMicro,
      releasedHoldMicro: hold.reservedMicro,
      balanceAfter: microToCredits(balanceMicro),
      balanceAfterMicro: balanceMicro,
      requestId,
      model: usage.model,
      note: 'LLM 实际 Token 结算',
    });
    return { ...usage, wallet: snapshot(balanceMicro, heldMicro) };
  }));
}

export function releaseLlmCredits(userId, requestId, reason) {
  return withUserLock(userId, () => tx(() => {
    const hold = selectHold(userId, requestId);
    if (!hold || hold.status === 'released') return null;
    if (hold.status !== 'held') return hold;

    const user = selectUser(userId);
    if (!user) throw new Error('账号不存在');

    const heldMicro = Math.max(0, user.heldMicro - hold.reservedMicro);
    const released = {
      ...hold,
      status: 'released',
      reason: String(reason || '调用未完成').slice(0, 500),
      updatedAt: now(),
      releasedAt: now(),
    };

    writeWallet(userId, user.balanceMicro, heldMicro);
    writeHold(userId, released);
    appendEntry(userId, `release-${requestId}`, {
      type: 'llm_release',
      amountMicro: 0,
      releasedHoldMicro: hold.reservedMicro,
      balanceAfter: microToCredits(user.balanceMicro),
      balanceAfterMicro: user.balanceMicro,
      requestId,
      note: 'LLM 未完成，释放冻结额度',
    });
    return { ...released, wallet: snapshot(user.balanceMicro, heldMicro) };
  }));
}

/**
 * Parks a hold for manual reconciliation when actual cost exceeded the
 * reservation. The held amount is released so the user is not left with funds
 * frozen indefinitely, but no charge is taken: the discrepancy needs a human.
 */
export function markLlmBillingReconcile(userId, requestId, error) {
  return withUserLock(userId, () => tx(() => {
    const hold = selectHold(userId, requestId);
    if (!hold) return null;

    const user = selectUser(userId);
    if (!user) throw new Error('账号不存在');

    const wasHeld = hold.status === 'held';
    const heldMicro = wasHeld ? Math.max(0, user.heldMicro - hold.reservedMicro) : user.heldMicro;

    const marked = {
      ...hold,
      status: 'billing_reconcile_required',
      error: String(error?.message || error).slice(0, 500),
      updatedAt: now(),
    };

    if (wasHeld) {
      writeWallet(userId, user.balanceMicro, heldMicro);
      appendEntry(userId, `release-${requestId}`, {
        type: 'llm_release',
        amountMicro: 0,
        releasedHoldMicro: hold.reservedMicro,
        balanceAfter: microToCredits(user.balanceMicro),
        balanceAfterMicro: user.balanceMicro,
        requestId,
        note: 'LLM 费用超出预授权，冻结额度已释放并转人工核账',
      });
    }
    writeHold(userId, marked);
    writeLlmUsage(userId, {
      id: requestId, userId, status: marked.status,
      provider: config.llmProtocol, configuredModel: config.llmModel,
      error: marked.error, createdAt: hold.createdAt, updatedAt: now(),
    });
    return marked;
  }));
}

/** Grants the signup bonus inside the same transaction that creates the user. */
export function grantSignupBonus(userId, credits) {
  const bonusMicro = creditsToMicro(credits);
  if (findEntry(userId, 'signup-bonus')) return walletOf(userId);
  const user = selectUser(userId);
  if (!user) throw new Error('账号不存在');
  const balanceMicro = user.balanceMicro + bonusMicro;
  writeWallet(userId, balanceMicro, user.heldMicro);
  appendEntry(userId, 'signup-bonus', {
    type: 'signup_bonus',
    amountMicro: bonusMicro,
    balanceAfter: microToCredits(balanceMicro),
    balanceAfterMicro: balanceMicro,
    note: '新注册赠送积分',
  });
  return snapshot(balanceMicro, user.heldMicro);
}

/** Most recent ledger entries, newest first. Reads at most `limit` rows. */
export function recentCreditEntries(userId, limit = 20) {
  return sql(`
    SELECT doc_json FROM credit_entries
    WHERE user_id = :userId
    ORDER BY created_at DESC, id ASC
    LIMIT :limit`).all({ userId, limit }).map(row => {
    const entry = JSON.parse(row.doc_json);
    if (entry.type === 'llm_capture' && !entry.model && entry.requestId) {
      const usageRow = sql(`SELECT model, doc_json FROM llm_usage WHERE user_id = :userId AND id = :requestId`)
        .get({ userId, requestId: entry.requestId });
      let usage = null;
      try { usage = usageRow ? JSON.parse(usageRow.doc_json) : null; } catch {}
      if (usageRow?.model || usage?.configuredModel || usage?.model) return { ...entry, model: usageRow.model || usage.model || usage.configuredModel };
    }
    return entry;
  });
}
