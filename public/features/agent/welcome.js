import { canvasIcon } from '../drama/canvas-icons.js?v=1';

export const creativePresets = Object.freeze([
  { id: 'character', icon: 'user-round', title: '设计一个角色', description: '外形、服装与三视图', text: '帮我设计一个[角色主题]角色，用于[短剧 / 动画 / 品牌形象]。先一起确定外形、服装、配色和性格，再整理正面、侧面、背面三视图的画面描述，保持人物一致。' },
  { id: 'storyboard', icon: 'clapperboard', title: '把故事变成分镜', description: '从故事梗概到镜头画面', text: '我想把这个故事做成一段短片：[故事梗概]。请先完善开场、冲突和结尾，再拆成6个分镜，写清每个镜头的画面、景别、人物动作、台词和时长，保持角色与场景连贯。' },
  { id: 'product', icon: 'package', title: '策划产品宣传片', description: '卖点、脚本与拍摄画面', text: '为[产品名称]策划一条15秒竖屏宣传短片，面向[目标人群]，突出[核心卖点]。请先给我3个创意方向，再展开我选中的方向，写出镜头画面、产品动作、字幕和节奏。' },
  { id: 'reference', icon: 'image', title: '从参考图延展创意', description: '保留喜欢的风格，创造新画面', text: '请根据我添加的参考图，设计[新的场景或主题]。保留参考图中我喜欢的[角色 / 配色 / 质感]，先分析画面特点，再给我3个不同构图的创意方案和对应的画面描述。' },
]);

export const agentLogoMarkup = '<span class="brand-gem gugu-agent-logo" aria-hidden="true"></span>';

export function agentWelcomeHeroMarkup(heading = 'h2') {
  const tag = heading === 'h1' ? 'h1' : 'h2';
  return `<div class="agent-welcome-hero">${agentLogoMarkup}<${tag}>让灵感，成为作品</${tag}></div>`;
}

export function creativePresetsMarkup() {
  return `<div class="agent-creative-presets" role="group" aria-label="快捷创作问题">${creativePresets.map(item => `<button type="button" data-agent-preset="${item.id}"><span class="agent-preset-icon" aria-hidden="true">${canvasIcon(item.icon)}</span><span class="agent-preset-copy"><strong>${item.title}</strong><small>${item.description}</small></span></button>`).join('')}</div>`;
}

export function bindCreativePresets(root, input, { signal, isDisabled = () => false } = {}) {
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-agent-preset]');
    if (!button || !root.contains(button) || isDisabled() || input.disabled) return;
    const preset = creativePresets.find(item => item.id === button.dataset.agentPreset);
    if (!preset) return;
    input.value = preset.text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
    const placeholder = preset.text.match(/\[[^\]]+\]/);
    if (placeholder) input.setSelectionRange(placeholder.index, placeholder.index + placeholder[0].length);
  }, { signal });
}
