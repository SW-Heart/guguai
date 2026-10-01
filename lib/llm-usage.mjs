// inputTokens is the total input, including both cache categories.
export function normalizeLlmUsage(protocol, usage) {
  const cacheReadTokens = Number(usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0);
  const cacheCreationTokens = Number(usage?.cache_creation_input_tokens ?? usage?.prompt_tokens_details?.cache_creation_tokens ?? 0);
  const rawInput = usage?.prompt_tokens ?? usage?.input_tokens;
  const rawOutput = usage?.completion_tokens ?? usage?.output_tokens;
  const parsedInput = rawInput == null ? NaN : Number(rawInput);
  const inputTokens = Number.isSafeInteger(parsedInput) && parsedInput >= 0 ? parsedInput : NaN;
  return {
    inputTokens: protocol === 'anthropic' ? inputTokens + cacheReadTokens + cacheCreationTokens : inputTokens,
    outputTokens: rawOutput == null ? NaN : Number(rawOutput),
    cacheReadTokens,
    cacheCreationTokens,
  };
}

export function isValidLlmUsage(usage) {
  return Object.values(usage).every(value => Number.isSafeInteger(value) && value >= 0)
    && Number.isSafeInteger(usage.cacheReadTokens + usage.cacheCreationTokens)
    && usage.cacheReadTokens + usage.cacheCreationTokens <= usage.inputTokens;
}
