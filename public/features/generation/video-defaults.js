const modelDurations = Object.freeze({
  'minimax-h3-15s': 10,
  'seedance-2.0': 15,
  'seedance-2.5': 30,
});

export function defaultVideoDuration(modelId, durations = [], fallback = durations[0] || 0) {
  const preferred = modelDurations[modelId] ?? fallback;
  return durations.some(value => Number(value) === Number(preferred)) ? Number(preferred) : Number(durations[0] || 0);
}
