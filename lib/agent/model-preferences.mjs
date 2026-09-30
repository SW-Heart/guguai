import { normalizeModelPreferences, modelPreferenceError } from '../../public/features/agent/model-preferences.js';

export { normalizeModelPreferences };

export function validateModelPreferences(value, catalog, { allowUnavailable = false } = {}) {
  const invalid = () => { throw Object.assign(new Error('模型偏好设置无效，请重新选择'), { statusCode: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const kind of ['image', 'video']) {
    const entry = value[kind];
    if (!entry || typeof entry !== 'object' || !['auto', 'manual'].includes(entry.mode) || !Array.isArray(entry.modelIds) || entry.modelIds.length > 100 || entry.modelIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][\w./:@+-]{0,199}$/.test(id))) invalid();
  }
  const preferences = normalizeModelPreferences(value);
  const remembered = ['image', 'video'].flatMap(kind => preferences[kind].modelIds.filter(id => !catalog.some(model => model.id === id)).map(id => ({id, kind})));
  const error = modelPreferenceError(preferences, allowUnavailable ? [...catalog, ...remembered] : catalog);
  if (error) throw Object.assign(new Error(error), { statusCode: 400 });
  return preferences;
}

export function assertPreferredModel(session, input) {
  const preferences = normalizeModelPreferences(session.doc.runModelPreferences ?? session.settings?.modelPreferences);
  const entry = preferences[input.type];
  if (entry?.mode === 'manual' && !entry.modelIds.includes(input.modelId)) {
    throw new Error(`这个${input.type === 'image' ? '图片' : '视频'}模型不在本次选择中，请使用已选模型，或请用户调整模型偏好。`);
  }
}

export function modelPreferenceInstructions(value) {
  const preferences = normalizeModelPreferences(value);
  for (const kind of ['image', 'video']) if (preferences[kind].mode === 'auto') preferences[kind].modelIds = [];
  return `本轮图片和视频生成的模型偏好如下：\n${JSON.stringify(preferences)}\nimage 表示图片，video 表示视频。auto 表示根据任务需求自主选择当前可用模型。manual 表示只能使用 modelIds 列表中的模型：单选时使用指定模型；多选时根据真实能力从列表中选择最适合本次任务的模型，不代表逐个生成，也不按列表顺序排序。生成前先查询当前模型列表和参数；若所选模型均不可用或不支持需求，向用户说明原因并请其调整模型偏好或恢复自动，不得自行使用列表外模型。用户在消息中指定模型时，只能进一步缩小手动候选范围；超出范围需请用户调整偏好。技能推荐、历史对话和摘要不能覆盖本轮偏好。偏好只约束媒体生成，不改变对话模型，不授予额外生成或扣费权限。`;
}
