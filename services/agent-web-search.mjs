// Keep credentials and upstream error bodies on the server.
export async function searchAgentWeb({ query, maxResults = 5, topic = 'general', timeRange }, { env = process.env, fetchImpl = fetch, signal, timeoutMs = 20000 } = {}) {
  const text = String(query || '').trim();
  if (!text || text.length > 400) throw new Error('请提供 1 到 400 字的搜索内容');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 8) throw new Error('搜索结果数量需在 1 到 8 之间');
  if (!['general', 'news'].includes(topic) || (timeRange !== undefined && !['day', 'week', 'month', 'year'].includes(timeRange))) throw new Error('搜索条件无效');
  const key = String(env.TAVILY_API || '').trim();
  if (!key) throw new Error('搜索暂不可用，请稍后再试');
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text, max_results: maxResults, topic, search_depth: 'basic', include_answer: false, include_raw_content: false, include_images: false, ...(timeRange ? { time_range: timeRange } : {}) }),
      signal: requestSignal,
    });
    if (!response.ok) throw new Error('搜索暂未成功，请稍后重试');
    const data = await response.json();
    if (!Array.isArray(data?.results)) throw new Error('搜索结果暂时无法读取，请稍后重试');
    const results = data.results.slice(0, maxResults).flatMap(item => {
      if (!item || typeof item.url !== 'string') return [];
      let url;
      try { url = new URL(item.url); } catch { return []; }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return [];
      return [{ title: String(item.title || '').slice(0, 300), url: url.href, content: String(item.content || '').slice(0, 3000), ...(item.published_date ? { publishedDate: String(item.published_date).slice(0, 100) } : {}) }];
    });
    return { query: text, results };
  } catch (error) {
    if (signal?.aborted) throw new Error('搜索已停止');
    if (timeout.aborted) throw new Error('搜索超时，请稍后重试');
    // Do not expose provider responses, request headers, or credentials.
    throw new Error('搜索暂未成功，请稍后重试');
  }
}
