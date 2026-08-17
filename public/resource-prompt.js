const clean = value => String(value || '').trim();

export function buildResourceImagePrompt(resource, { aspectRatio = '9:16' } = {}) {
  const bible = resource?.bible || {};
  const common = [
    `资产名称：${clean(resource?.name) || '未命名资源'}`,
    `核心定义：${clean(resource?.description) || '未补充'}`,
    `身份或空间锚点：${clean(bible.identity) || '未补充'}`,
    `外观或固定陈设：${clean(bible.appearance) || '未补充'}`,
    `服装、材质或状态：${clean(bible.costume) || '未补充'}`,
    `标准视图或标准机位：${clean(bible.canonicalViews) || '未补充'}`,
    clean(bible.stateNotes) ? `连续性备注：${clean(bible.stateNotes)}` : '',
  ].filter(Boolean);

  const instructions = {
    character: [
      '任务：生成可复用的真人短剧角色视觉圣经图，不是剧情截图。',
      '画面要求：以角色身份一致性为最高优先级；完整呈现固定脸型、五官、发型、服装和体态。按照标准视图要求组织角色设定图，主视图清晰、无遮挡。使用简洁中性背景，不加入其他人物、剧情动作或无关道具。',
      '禁止：改变年龄、脸型、发色、服装款式；禁止文字、水印、重复肢体和多余人物。',
    ],
    location: [
      '任务：生成可复用的真人短剧场景视觉圣经图，不是带人物的剧情截图。',
      '画面要求：清楚呈现空间结构、入口、活动区、固定陈设、材质、光线方向和标准机位，便于后续镜头复用。场景中不出现人物。',
      '禁止：改变空间结构、加入无关建筑或物品；禁止文字、水印和人物。',
    ],
    prop: [
      '任务：生成可复用的真人短剧物品视觉圣经图，不是剧情截图。',
      '画面要求：准确呈现物品的比例、结构、材质、颜色、磨损与当前状态，主体完整清晰，使用简洁中性背景，不出现人物或手持动作。',
      '禁止：改变结构、材质和尺度；禁止文字、水印、人物、手部和无关物品。',
    ],
  }[resource?.type] || [];

  return [...instructions, ...common, `输出规格：${aspectRatio}，真人影视级写实质感，真实材质，清晰稳定，适合作为后续图生图和图生视频的一致性参考底图。`].join('\n');
}
