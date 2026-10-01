export const CREDIT_MICRO_FACTOR = 1_000_000;

function safeNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} 必须是非负安全整数`);
  return number;
}

export function creditsToMicro(credits) {
  const value = Number(credits);
  const micro = Math.round(value * CREDIT_MICRO_FACTOR);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(micro)) throw new Error('积分金额无效');
  return micro;
}

export function microToCredits(micro) {
  return safeNonNegativeInteger(micro, '微积分') / CREDIT_MICRO_FACTOR;
}

export function normalizeWallet(user) {
  if (!user || typeof user !== 'object') throw new Error('用户钱包不存在');
  const legacyCredits = Number.isFinite(Number(user.credits)) && Number(user.credits) >= 0 ? Number(user.credits) : 0;
  if (!Number.isSafeInteger(user.creditBalanceMicro) || user.creditBalanceMicro < 0) user.creditBalanceMicro = creditsToMicro(legacyCredits);
  if (!Number.isSafeInteger(user.creditHeldMicro) || user.creditHeldMicro < 0) user.creditHeldMicro = 0;
  if (user.creditHeldMicro > user.creditBalanceMicro) user.creditHeldMicro = user.creditBalanceMicro;
  user.credits = microToCredits(user.creditBalanceMicro);
  return walletSnapshot(user);
}

export function walletSnapshot(user) {
  const balanceMicro = safeNonNegativeInteger(user.creditBalanceMicro, '余额');
  const heldMicro = safeNonNegativeInteger(user.creditHeldMicro, '冻结余额');
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

export function llmRatesFromEnv(env = process.env) {
  const yuanPerCredit = Number(env.YUAN_PER_CREDIT || 0.1);
  const inputYuanPerMillion = Number(env.LLM_INPUT_PRICE_YUAN_PER_MILLION || 3);
  const outputYuanPerMillion = Number(env.LLM_OUTPUT_PRICE_YUAN_PER_MILLION || 6);
  const cacheReadYuanPerMillion = Number(env.LLM_CACHE_READ_PRICE_YUAN_PER_MILLION ?? inputYuanPerMillion);
  const cacheCreationYuanPerMillion = Number(env.LLM_CACHE_CREATION_PRICE_YUAN_PER_MILLION ?? inputYuanPerMillion);
  if (![yuanPerCredit, inputYuanPerMillion, outputYuanPerMillion].every(value => Number.isFinite(value) && value > 0)) throw new Error('LLM 计费环境变量必须是正数');
  if (![cacheReadYuanPerMillion, cacheCreationYuanPerMillion].every(value => Number.isFinite(value) && value >= 0)) throw new Error('LLM 缓存单价必须是非负数字');
  const inputMicroPerToken = Math.round((inputYuanPerMillion / yuanPerCredit) * CREDIT_MICRO_FACTOR / 1_000_000);
  const outputMicroPerToken = Math.round((outputYuanPerMillion / yuanPerCredit) * CREDIT_MICRO_FACTOR / 1_000_000);
  if (!inputMicroPerToken || !outputMicroPerToken) throw new Error('LLM Token 单价精度不足');
  return { yuanPerCredit, inputYuanPerMillion, outputYuanPerMillion, inputMicroPerToken, outputMicroPerToken,
    cacheReadYuanPerMillion, cacheCreationYuanPerMillion,
    cacheReadMicroPerToken: cacheReadYuanPerMillion / yuanPerCredit,
    cacheCreationMicroPerToken: cacheCreationYuanPerMillion / yuanPerCredit };
}

export function llmCostMicro(inputTokens, outputTokens, rates = llmRatesFromEnv(), usage = {}) {
  const input = safeNonNegativeInteger(inputTokens, '输入 Token');
  const output = safeNonNegativeInteger(outputTokens, '输出 Token');
  const cacheRead = safeNonNegativeInteger(usage.cacheReadTokens ?? 0, '缓存读取 Token');
  const cacheCreation = safeNonNegativeInteger(usage.cacheCreationTokens ?? 0, '缓存创建 Token');
  if (!Number.isSafeInteger(cacheRead + cacheCreation) || cacheRead + cacheCreation > input) throw new Error('缓存 Token 数量超过输入总量');
  const cost = Math.round((input - cacheRead - cacheCreation) * rates.inputMicroPerToken + output * rates.outputMicroPerToken
    + cacheRead * (rates.cacheReadMicroPerToken ?? rates.inputMicroPerToken)
    + cacheCreation * (rates.cacheCreationMicroPerToken ?? rates.inputMicroPerToken));
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error('LLM 费用超出安全范围');
  return cost;
}

export function llmReservationMicro(inputTokenUpperBound, maxOutputTokens, rates = llmRatesFromEnv()) {
  const inputMicroPerToken = Math.max(rates.inputMicroPerToken, rates.cacheReadMicroPerToken ?? rates.inputMicroPerToken, rates.cacheCreationMicroPerToken ?? rates.inputMicroPerToken);
  return llmCostMicro(inputTokenUpperBound, maxOutputTokens, { ...rates, inputMicroPerToken });
}

export function conservativeInputTokenUpperBound(...values) {
  return values.reduce((sum, value) => sum + Buffer.byteLength(String(value || ''), 'utf8'), 0);
}
