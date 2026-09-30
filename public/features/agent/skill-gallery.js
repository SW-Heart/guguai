const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const imageRoot = '/images/skills/';

// Editorial descriptions of the built-in capabilities, never the skill source text.
export const skillExamples = Object.freeze({
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
    category: '图像创作', summary: '从画面构思到出图，设计海报、角色和产品图。',
    introduction: '把用途、主体和风格变成清晰的画面设计。可以创作新图，也可以结合参考图调整构图、光线、背景和细节。',
    scenes: '品牌海报、产品展示、角色设定、插画与场景图',
    input: '描述想画什么、用于哪里和需要的画幅，也可以添加参考图。',
    output: '画面方案、可复用的画面描述，以及按需生成或修改的图片。',
    prompt: '为一款淡紫色香水设计横版产品图，用柔和日光突出磨砂玻璃质感，背景简洁，不要文字。',
    caption: '产品图示例：用淡紫色织物、玻璃与日光呈现香水的质感。',
    alt: '淡紫色磨砂玻璃香水瓶置于石台上，背景是柔软织物与弧形玻璃。',
  },
  'short-drama': {
    category: '故事创作', summary: '把故事想法写成剧本，梳理角色与分镜。',
    introduction: '一起打磨人物动机、剧情推进与对白，再把故事拆成有明确动作和情绪的镜头。也可以接着已有剧本创作，或只修改某一场戏。',
    scenes: '原创短剧、小说改编、漫剧、剧本与分镜修改',
    input: '提供故事想法或已有剧本，说明题材、时长和希望保留的内容。',
    output: '故事大纲、人物设定、分场剧本与分镜；需要时再制作角色和场景图片。',
    prompt: '写一段一分钟的悬疑短剧：女孩在旧书店发现一封写给自己的信。先写剧本，再拆成分镜，保持人物和场景一致。',
    caption: '分镜示例：走进书店、发现信封、抬头察觉异样。',
    alt: '三个连续分镜：短发女孩进入旧书店，在书中发现信封，随后惊讶地抬头。',
    labels: ['进入书店', '发现信封', '察觉异样'],
  },
  'video-production': {
    category: '视频创作', summary: '策划镜头、生成片段，也能用已有素材剪辑成片。',
    introduction: '围绕你想表达的信息和情绪，设计开场、镜头动作与节奏。可以先讨论拍法，也可以生成所需片段，结合已有素材完成剪辑。',
    scenes: '产品广告、品牌宣传、解说视频、叙事短片',
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
