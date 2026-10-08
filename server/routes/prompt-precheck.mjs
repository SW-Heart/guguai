const outcomes = new Set(['cancelled']);
const sources = new Set(['image', 'video', 'drama']);

// Only what the dialog needs to paint marks: positions, level and a user-facing
// label. Group ids, review notes and sources stay on the server.
export const publicPrecheckHits = hits => hits.map(({ start, end, level, label }) => ({ start, end, level, label }));

export function createPromptPrecheckRouteHandler({ bodyJson, sendJson, requireUser, promptPrecheck, now = Date.now, limit = 40, windowMs = 10_000 }) {
  const attempts = new Map();
  function rateAllowed(userId) {
    const current = attempts.get(userId);
    if (!current || now() - current.startedAt >= windowMs) { attempts.set(userId, { startedAt:now(), count:1 }); return true; }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }
  const text = (value, max) => typeof value === 'string' && value.length <= max ? value : null;

  return async function promptPrecheckRoute(req, res, url) {
    if (!['/api/prompt-precheck', '/api/prompt-precheck/events'].includes(url.pathname) || req.method !== 'POST') return false;
    const user = await requireUser(req, res); if (!user) return true;
    if (!rateAllowed(user.id)) return sendJson(res, 429, { error:'检查过于频繁，请稍后再试' }), true;
    const input = await bodyJson(req, 300_000);
    const modelId = text(input.modelId ?? '', 120);
    if (modelId === null) return sendJson(res, 400, { error:'模型参数无效' }), true;
    if (url.pathname === '/api/prompt-precheck') {
      const prompts = Array.isArray(input.prompts) && input.prompts.length >= 1 && input.prompts.length <= 20 ? input.prompts.map(value => text(value, 20_000)) : null;
      if (!prompts || prompts.includes(null)) return sendJson(res, 400, { error:'请提供要检查的描述' }), true;
      const results = prompts.map(prompt => promptPrecheck.scan(prompt, { modelId }));
      return sendJson(res, 200, {
        mode:promptPrecheck.mode(), lexiconVersion:results[0].lexiconVersion,
        results:results.map(result => ({ counts:result.counts, hits:publicPrecheckHits(result.hits) })),
      }), true;
    }
    // A cancelled dialog never reaches the submit route, so it is reported here.
    const prompt = text(input.prompt, 20_000);
    if (!outcomes.has(input.outcome) || !sources.has(input.source) || !prompt) return sendJson(res, 400, { error:'记录参数无效' }), true;
    const result = promptPrecheck.scan(prompt, { modelId });
    if (result.hits.length) promptPrecheck.record({ userId:user.id, source:input.source, modelId, lexiconVersion:result.lexiconVersion, mode:promptPrecheck.mode(), outcome:input.outcome, hits:result.hits });
    return sendJson(res, 200, { ok:true }), true;
  };
}
