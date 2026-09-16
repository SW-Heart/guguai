const clean = value => String(value || '').trim();

export function buildResourceImagePrompt(resource, { aspectRatio = '9:16' } = {}) {
  const bible = resource?.bible || {};
  const common = [
    `素材名称：${clean(resource?.name) || '未命名素材'}`,
    `素材说明：${clean(resource?.description) || '未补充'}`,
    `身份或空间：${clean(bible.identity) || '未补充'}`,
    `外观或固定陈设：${clean(bible.appearance) || '未补充'}`,
    `服装、材质或状态：${clean(bible.costume) || '未补充'}`,
    `参考角度：${clean(bible.canonicalViews) || '未补充'}`,
    clean(bible.stateNotes) ? `连续性备注：${clean(bible.stateNotes)}` : '',
  ].filter(Boolean);

  const instructions = {
    character: [
      '请生成一张用于保持角色外观一致的角色图片，不要做成剧情截图。',
      '画面要求：优先保持角色外观一致；完整呈现固定脸型、五官、发型、服装和体态。按参考角度展示角色，主体清晰、无遮挡。使用简洁中性背景，不加入其他人物、剧情动作或无关道具。',
      '禁止：改变年龄、脸型、发色、服装款式；禁止文字、水印、重复肢体和多余人物。',
    ],
    location: [
      '请生成一张用于保持场景外观一致的场景参考图，不要带人物或剧情动作。',
      '画面要求：清楚呈现空间结构、入口、活动区、固定陈设、材质、光线方向和常用拍摄角度，方便后续镜头保持一致。场景中不出现人物。',
      '禁止：改变空间结构、加入无关建筑或物品；禁止文字、水印和人物。',
    ],
    prop: [
      '请生成一张用于保持物品外观一致的物品参考图，不要做成剧情截图。',
      '画面要求：准确呈现物品的比例、结构、材质、颜色、磨损与当前状态，主体完整清晰，使用简洁中性背景，不出现人物或手持动作。',
      '禁止：改变结构、材质和尺度；禁止文字、水印、人物、手部和无关物品。',
    ],
  }[resource?.type] || [];

  return [...instructions, ...common, `画面比例：${aspectRatio}；真人影视级写实质感，真实材质，清晰稳定，适合作为后续创作的参考图片。`].join('\n');
}
