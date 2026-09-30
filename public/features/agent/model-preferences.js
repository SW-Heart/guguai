export const modelPreferenceKinds = ['image', 'video'];

export function normalizeModelPreferences(value) {
  return Object.fromEntries(modelPreferenceKinds.map(kind => {
    const entry = value?.[kind];
    return [kind, {
      mode: entry?.mode === 'manual' ? 'manual' : 'auto',
      modelIds: [...new Set(Array.isArray(entry?.modelIds) ? entry.modelIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200) : [])],
    }];
  }));
}

export function modelPreferenceSummary(value, catalog = []) {
  const preferences = normalizeModelPreferences(value);
  const manual = modelPreferenceKinds.filter(kind => preferences[kind].mode === 'manual');
  if (!manual.length) return '自动';
  if (manual.length === 1) {
    const kind = manual[0], ids = preferences[kind].modelIds;
    const label = ids.length === 1 ? catalog.find(model => model.id === ids[0] && model.kind === kind)?.label : '';
    if (label && label.length <= 18) return label;
    return `${kind === 'image' ? '图片' : '视频'} ${ids.length} 个`;
  }
  return `图片 ${preferences.image.modelIds.length} 个 · 视频 ${preferences.video.modelIds.length} 个`;
}

export function modelPreferenceError(value, catalog) {
  const preferences = normalizeModelPreferences(value);
  for (const kind of modelPreferenceKinds) {
    const entry = preferences[kind], label = kind === 'image' ? '图片' : '视频';
    if (entry.mode !== 'manual') continue;
    if (!entry.modelIds.length) return `请选择至少一个${label}模型，或开启自动选择。`;
    if (entry.modelIds.some(id => !catalog.some(model => model.id === id && model.kind === kind && model.enabled !== false && model.availability !== 'coming-soon'))) {
      return `所选${label}模型暂不可用，请调整选择或开启自动选择。`;
    }
  }
  return '';
}
