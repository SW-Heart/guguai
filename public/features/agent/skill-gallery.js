const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const imageRoot = '/images/skills/';

// Editorial descriptions of the built-in capabilities, never the skill source text.
export const skillExamples = Object.freeze({
  'prompt-optimization': {
    category: '描述优化', summary: '保留你的想法，让文字与画面描述更清晰。',
    introduction: '梳理已有描述里的含糊、重复与冲突，保留你指定的风格、台词和参考内容，改成可以直接使用的版本。',
    scenes: '图像描述、视频描述、文字创作要求、生成被拒后的表达调整',
    input: '提供原来的描述，说明希望达到的效果，以及哪些内容必须保留。',
    output: '可直接复制的改写、关键修改说明，以及必要的素材建议。',
    prompt: '帮我优化这段香水广告描述：梦幻、高级、有质感。改成具体的主体、构图和光线，保留淡紫色，不添加品牌或文字。',
    caption: '封面示意：把模糊的文字草稿整理成清晰的画面。',
    alt: '浅紫色玻璃面板分别呈现文字草稿与香水画面，前景放着一支玻璃笔。',
  },
  'script-writing': {
    category: '剧本创作', summary: '写完整场景、人物行动和可表演的对白。',
    introduction: '把故事写成可以表演和拍摄的剧本，处理人物目标、场景变化与对白。可以从想法开始，也可以改编原文或修改已有场次。',
    scenes: '电影与短片剧本、广告剧情、舞台场景、对白与局部改稿',
    input: '提供故事想法或现有剧本，说明体裁、时长、结尾和需要保留的内容。',
    output: '完整剧本或指定场次、行动与对白，以及必要的改稿说明。',
    prompt: '写一场两分钟的短片剧本：两位旧友在书店归还一本借了十年的书。用动作和对白表现他们的关系变化，不加旁白。',
    caption: '封面示意：灯下的剧本、钢笔与雨夜书店，呈现场景构思。',
    alt: '暖色台灯照亮木桌上的剧本纸页与钢笔，窗外是蓝色雨夜和书店。',
  },
  'character-design': {
    category: '角色设计', summary: '建立人物设定，设计外貌、服装与多视图。',
    introduction: '结合故事和用途，设计有辨识度的角色，把性格、经历与外貌、服装和道具联系起来，保持不同视图和场景中的人物一致。',
    scenes: '人物小传、原创角色、立绘、多视图、表情与服装设计',
    input: '说明角色用途、性格和风格，添加已有设定或参考图，并说明要文字还是图片。',
    output: '角色设定、外貌与服装方案，以及按需制作的立绘和多视图。',
    prompt: '设计一位原创成年飞行信使，短发、浅色飞行夹克、深色长裤和斜挎邮包。先给人物设定，再设计正面、侧面与面部参考，保持外貌一致。',
    caption: '原创角色示例：以正面、侧面与面部视图展示同一位飞行信使。',
    alt: '同一位短发成年女性飞行信使的正面全身、侧面全身与面部视图，穿浅色夹克和深色长裤。',
  },
  'creative-review': {
    category: '作品优化', summary: '检查剧本、画面与成片，给出具体修改建议。',
    introduction: '从你的创作目标出发，找出影响理解、画面表现和前后衔接的问题，说明问题在哪里、为什么要改，以及可以怎么改。',
    scenes: '剧本审阅、海报检查、分镜衔接、成片修改',
    input: '添加要检查的作品，说明作品用途和你最在意的地方。',
    output: '问题清单、对应位置与修改建议；也可以继续局部修改。',
    prompt: '帮我检查这张产品图。希望观众第一眼看到香水瓶，请指出影响主体辨识的地方，并给出修改建议。',
    caption: '构图修改示意：减少遮挡、留出边界，让产品更清晰。',
    alt: '左右对照的香水产品图：左侧枝叶遮挡瓶身，右侧主体完整清晰。',
    labels: ['修改前', '修改方向'],
  },
  'image-design': {
    category: '图像创作', summary: '从画面构思到出图，创作海报、插画和产品图。',
    introduction: '把用途、主体和风格变成清晰的画面设计。可以创作新图，也可以结合参考图调整构图、光线、背景和细节。',
    scenes: '品牌海报、产品展示、插画与场景图、图片修改',
    input: '描述想画什么、用于哪里和需要的画幅，也可以添加参考图。',
    output: '画面方案、可复用的画面描述，以及按需生成或修改的图片。',
    prompt: '为一款淡紫色香水设计横版产品图，用柔和日光突出磨砂玻璃质感，背景简洁，不要文字。',
    caption: '产品图示例：用淡紫色织物、玻璃与日光呈现香水的质感。',
    alt: '淡紫色磨砂玻璃香水瓶置于石台上，背景是柔软织物与弧形玻璃。',
  },
  'short-drama': {
    category: '故事创作', summary: '设计短剧故事、分集节奏与可制作的分镜。',
    introduction: '把故事想法或原作整理成短剧，安排分集推进、人物关系与观看节奏，再写成场次和分镜。也可以继续已有短剧，或局部修改。',
    scenes: '原创短剧、小说改编、漫剧、分集规划与短剧分镜',
    input: '提供故事想法或已有剧本，说明题材、时长和希望保留的内容。',
    output: '故事大纲、人物设定、分场剧本与分镜；需要时再制作角色和场景图片。',
    prompt: '写一段一分钟的悬疑短剧：女孩在旧书店发现一封写给自己的信。先写剧本，再拆成分镜，保持人物和场景一致。',
    caption: '分镜示例：走进书店、发现信封、抬头察觉异样。',
    alt: '三个连续分镜：短发女孩进入旧书店，在书中发现信封，随后惊讶地抬头。',
    labels: ['进入书店', '发现信封', '察觉异样'],
  },
  'seedance-creation-bible': {
    category: '视频创作', summary: '按 Seedance 版本打磨画面、镜头与对白。',
    introduction: '结合 Seedance 2.0 与 2.5 的不同特点，把故事想法和参考素材整理成清晰的视频描述，完善人物动作、镜头顺序、对白与声音。',
    scenes: '视频描述优化、参考素材、编辑与延长、声画排查、生成被拒后的表达调整',
    input: '说明使用 Seedance 2.0 还是 2.5，提供故事或已有视频描述，并添加需要参考的图片、视频或音频。',
    output: '可直接使用的视频描述、素材建议，以及画面和声音问题的修改方法。',
    prompt: '用 Seedance 2.5 优化这段故事：女孩在旧书店把一封信交给男孩。安排十五秒的镜头和对白，保持人物一致，不要字幕和背景音乐。',
    caption: '技能封面：以 Seedance 字标、玻璃镜头框与流动胶片表现视频创作。',
    alt: '浅色背景上的 Seedance 字标与 2.0 / 2.5 版本文字，蓝紫色玻璃镜头框和流动胶片环绕其后。',
  },
  'video-production': {
    category: '视频创作', summary: '从拍法、动作与声音，到生成、续拍和剪辑。',
    introduction: '围绕信息和情绪设计画面，安排运镜、人物动作、光线、声音与节奏。可以讨论创作技巧，也可以生成片段、衔接已有视频并完成剪辑。',
    scenes: '广告与叙事短片、运镜与表演、声音设计、视频续拍和剪辑',
    input: '说明视频主题、用途、时长和画幅，添加已有素材或产品参考图。',
    output: '视频方案、镜头描述、按需生成的视频片段与剪辑成片。',
    prompt: '做一支十五秒的越野跑鞋广告，突出湿地抓地力。先规划三个镜头，画面从山间日出推进到鞋底踩过湿岩。',
    caption: '广告画面示例：以湿岩、水滴和鞋底细节表现越野跑鞋的使用场景。',
    alt: '越野跑鞋踩过湿润山岩，溅起水滴，远处群山映着日出。',
  },
  'video-replication': {
    category: '参考改编', summary: '拆解参考视频的节奏与拍法，创作你的版本。',
    introduction: '分析参考视频怎样开场、怎样组织画面和信息，再根据你的主题，明确保留哪些拍法、替换哪些内容，形成可修改的创作方案。',
    scenes: '广告改编、产品替换、口播仿拍、短视频拍法学习',
    input: '上传参考视频，说明你的主题，以及想保留和替换的内容。',
    output: '参考视频分析、改编方案与镜头安排；确定方案后可继续制作视频。',
    prompt: '参考我上传的咖啡广告，为抹茶饮品设计一个版本。保留倒入杯中的构图和节奏，换成清新的绿色调，先给我改编方案。',
    caption: '改编画面示意：保留倒入饮品的构图，将咖啡主题换成抹茶。',
    alt: '左侧咖啡倒入冰杯，右侧抹茶采用相同的倒入动作与构图。',
    labels: ['参考画面', '改编方向'],
  },
});

export function galleryItems(skills = []) {
  return skills.map(skill => {
    const example = Object.hasOwn(skillExamples, skill.name) ? skillExamples[skill.name] : null;
    return {
      name: skill.name, title: skill.title || '创作技能',
      summary: skill.summary || '描述你的想法，开始创作。',
      category: '创作', introduction: skill.summary || '结合你的需求，一起完成创作。',
      input: '描述你的目标，并添加相关参考资料。',
      ...example,
      media: example ? {type: 'image', src: `${imageRoot}${skill.name}-v1.jpg`, thumbnail: `${imageRoot}${skill.name}-thumb-v1.jpg`} : null,
    };
  });
}

export function skillCardMarkup(item) {
  return `<article class="agent-skill-card"><button type="button" class="agent-skill-preview" data-skill-preview="${escape(item.name)}" aria-haspopup="dialog" aria-label="查看${escape(item.title)}的示例与介绍"><span class="agent-skill-cover">${item.media ? `<img src="${escape(item.media.thumbnail)}" width="640" height="360" alt="" loading="lazy" decoding="async">` : '<span class="gugu-lucide gugu-lucide-book-open-check" aria-hidden="true"></span>'}</span><span class="agent-skill-copy"><strong>${escape(item.title)}</strong><span class="agent-skill-summary">${escape(item.summary)}</span><span class="agent-skill-meta">${escape(item.category)}</span></span></button><button type="button" class="agent-skill-quick-use" data-skill-quick-use="${escape(item.name)}" aria-label="使用${escape(item.title)}">使用</button></article>`;
}

export function skillDetailMarkup(item) {
  const media = item.media ? `<figure class="agent-skill-example"><div class="agent-skill-media">${item.media.type === 'video' ? `<video controls playsinline preload="metadata" poster="${escape(item.media.thumbnail)}" src="${escape(item.media.src)}" aria-label="${escape(item.alt || item.title)}"></video>` : `<img src="${escape(item.media.src)}" width="1536" height="864" alt="${escape(item.alt || item.title)}">`}${item.labels ? `<div class="agent-skill-image-labels">${item.labels.map(label => `<span>${escape(label)}</span>`).join('')}</div>` : ''}</div><figcaption>${escape(item.caption)}</figcaption></figure>` : '';
  const rows = [['介绍', item.introduction], ['适合创作', item.scenes], ['如何使用', item.input], ['你会得到', item.output]];
  return `<header class="agent-skill-detail-header"><h2 id="agentSkillDetailTitle">${escape(item.title)}</h2><div class="agent-skill-detail-actions"><button type="button" class="agent-skill-use" data-skill-use>使用此技能</button><button type="button" class="agent-skill-close" data-skill-close aria-label="关闭技能详情" autofocus><span class="gugu-lucide gugu-lucide-x" aria-hidden="true"></span></button></div></header><div class="agent-skill-dialog-body">${media}<section class="agent-skill-description" aria-label="技能介绍"><h3>技能介绍</h3><dl>${rows.filter(([, value]) => value).map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl></section>${item.prompt ? `<section class="agent-skill-prompt"><h3>试试这样说</h3><p>${escape(item.prompt)}</p></section>` : ''}</div>`;
}

export function mountSkillGallery(host, {signal, onChoose, onRetry}) {
  const section = document.createElement('section');
  section.className = 'agent-skill-gallery';
  section.setAttribute('aria-label', '创作技能');
  section.innerHTML = '<header><h2>创作技能</h2></header><div class="agent-skill-grid" aria-busy="true"></div><dialog class="agent-skill-dialog" aria-labelledby="agentSkillDetailTitle"></dialog>';
  host.append(section);
  const grid = section.querySelector('.agent-skill-grid'), dialog = section.querySelector('dialog');
  let items = [], active = null, trigger = null;
  const showStatus = (message, retry = false) => {
    grid.setAttribute('aria-busy', 'false');
    grid.innerHTML = `<div class="agent-skill-status" role="status">${escape(message)}${retry ? '<button type="button" data-skill-retry>重新加载</button>' : ''}</div>`;
  };
  showStatus('正在加载创作技能…');
  grid.setAttribute('aria-busy', 'true');
  section.addEventListener('click', event => {
    const quickUse = event.target.closest('[data-skill-quick-use]');
    if (quickUse) {
      const selected = items.find(item => item.name === quickUse.dataset.skillQuickUse);
      if (selected) onChoose(selected.name);
      return;
    }
    const button = event.target.closest('[data-skill-preview]');
    if (button) {
      active = items.find(item => item.name === button.dataset.skillPreview);
      if (!active) return;
      trigger = button;
      dialog.innerHTML = skillDetailMarkup(active);
      dialog.showModal();
      dialog.querySelector('.agent-skill-dialog-body').scrollTop = 0;
    } else if (event.target.closest('[data-skill-close]')) dialog.close();
    else if (event.target.closest('[data-skill-use]') && active) {
      const selected = active;
      trigger = null;
      dialog.close();
      onChoose(selected.name);
    } else if (event.target.closest('[data-skill-retry]')) {
      showStatus('正在加载创作技能…');
      grid.setAttribute('aria-busy', 'true');
      onRetry();
    }
  }, {signal});
  const outside = event => {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  let backdropPress = false;
  dialog.addEventListener('pointerdown', event => {backdropPress = outside(event);}, {signal});
  dialog.addEventListener('click', event => {if (backdropPress && outside(event)) dialog.close(); backdropPress = false;}, {signal});
  dialog.addEventListener('close', () => {
    dialog.querySelectorAll('video').forEach(video => video.pause());
    if (trigger?.isConnected) trigger.focus({preventScroll: true});
    active = null;
  }, {signal});
  signal.addEventListener('abort', () => {dialog.querySelectorAll('video').forEach(video => video.pause()); if (dialog.open) dialog.close(); section.remove();}, {once: true});
  return {
    update(skills) {
      if (signal.aborted) return;
      items = galleryItems(skills);
      grid.setAttribute('aria-busy', 'false');
      if (!items.length) showStatus('暂时没有可用的创作技能，你可以直接输入想法开始创作。');
      else grid.innerHTML = items.map(skillCardMarkup).join('');
    },
    error() {if (!signal.aborted) showStatus('创作技能未能加载，请重试。', true);},
  };
}
