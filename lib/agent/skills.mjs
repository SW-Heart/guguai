import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const builtinRoot = fileURLToPath(new URL('../../agent-skills/', import.meta.url));
const builtinLabels = Object.freeze({
  'creative-review': { title: '作品检查', summary: '找出问题，明确怎么修改' },
  'image-design': { title: '图像设计', summary: '海报、角色、场景和产品图' },
  'short-drama': { title: '短剧创作', summary: '剧本、角色与分镜' },
  'video-production': { title: '视频制作', summary: '策划、生成与剪辑成片' },
  'video-replication': { title: '爆款视频复刻', summary: '分析参考视频，规划你的版本' },
});

// Leave room for JSON escaping and metadata below the model's 6000-character tool preview.
function resourcePage(name, resource, text, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error('读取位置无效');
  const complete = { name, resource, text };
  if (offset === 0 && JSON.stringify(complete).length <= 5500) return complete;
  let end = Math.min(offset + 4500, text.length);
  let page;
  do {
    // Keep UTF-16 surrogate pairs together at page boundaries.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    page = { name, resource, text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length };
    if (JSON.stringify(page).length <= 5500) return page;
    end = offset + Math.floor((end - offset) * 0.8);
  } while (end > offset);
  throw new Error('技能资料路径过长');
}
export function createAgentSkills({ roots = [builtinRoot, ...String(process.env.AGENT_SKILLS_DIRS || '').split(path.delimiter).filter(Boolean)] } = {}) {
  async function catalog() {
    const skills = new Map();
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
        if (skills.has(entry.name)) continue;
        const directory = path.join(root, entry.name);
        const sourceFile = path.join(directory, 'SKILL.md');
        const [resolvedDirectory, resolvedSource] = await Promise.all([realpath(directory).catch(() => ''), realpath(sourceFile).catch(() => '')]);
        if (!resolvedDirectory || !resolvedSource.startsWith(`${resolvedDirectory}${path.sep}`)) continue;
        const source = await readFile(resolvedSource, 'utf8').catch(() => '');
        if (!source || source.length > 40000) continue;
        const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
        if (!frontmatter) continue;
        const field = name => (frontmatter[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
        if (field('name') !== entry.name || !field('description')) continue;
        skills.set(entry.name, { name: entry.name, description: field('description').slice(0, 300), title: builtinLabels[entry.name]?.title || entry.name, summary: builtinLabels[entry.name]?.summary || field('description').slice(0, 120), directory, source });
      }
    }
    return skills;
  }
  async function search(query = '') {
    const normalized = String(query).trim().toLowerCase();
    // Generic task verbs alone should not outrank the subject in a multi-word query.
    const words = normalized.split(/[^\p{L}\p{N}-]+/u).filter(word => word && (word === normalized || !['设计', '制作', '生成', '分析', '检查', '优化'].includes(word)));
    const grams = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(([part]) => [...part].slice(0, -1).map((char, index) => char + part[index + 1]));
    const recommended = normalized ? new Set(await keywordHints(normalized)) : new Set();
    const ranked = [...(await catalog()).values()].map(({ name, description, title, summary }) => {
      const haystack = `${name} ${title} ${description}`.toLowerCase();
      const score = (recommended.has(name) ? 6 : 0) + (normalized && haystack.includes(normalized) ? 10 : 0) + words.filter(word => haystack.includes(word)).length * 3 + grams.filter(gram => haystack.includes(gram)).length;
      return { name, description, title, summary, score };
    });
    const threshold = grams.length >= 2 ? 2 : 1;
    return ranked.filter(item => !normalized || item.score >= threshold).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 30).map(({ score, ...item }) => item);
  }
  async function keywordHints(task) {
    const input = String(task || '').slice(0, 3000);
    const matches = [];
    const add = name => { if (!matches.includes(name)) matches.push(name); };
    if (/(?:审稿|审阅|审查|检查|评估|评价|点评|找问题|质检|复盘|挑毛病).{0,24}(?:作品|剧本|分镜|图片|图像|这张图|这幅图|图稿|视频|成片|海报|提示词)|(?:作品|剧本|分镜|图片|图像|这张图|这幅图|图稿|视频|成片|海报|提示词).{0,24}(?:审稿|审阅|审查|检查|评估|评价|点评|找问题|质检)/i.test(input)) add('creative-review');
    if (/(?:复刻|仿拍|照着|对标).{0,24}(?:视频|短片|原片)|(?:参考视频|原片).{0,24}(?:拆解|分析|复刻|模仿)/i.test(input)) add('video-replication');
    if (/(?:短剧|漫剧|剧本|人物弧|戏剧冲突|分场剧本|小说改编)/i.test(input)) add('short-drama');
    if (/(?:海报|插画|封面|角色设定图|场景图|产品图|图片|图像|这张图|这幅图|图稿|做图|出图|修图|画面设计|视觉设计|品牌视觉|品牌设计|标志设计|包装设计|包装图|电商主图|详情页|信息图|排版|字体搭配|配色|界面设计|界面视觉|网页设计|页面设计)|\b(?:logo|poster|typography|color palette|visual design|brand identity|ui design)\b/i.test(input)) add('image-design');
    if (/(?:视频|短片|宣传片|广告片|分镜|剪辑|成片|运镜|视频模型|视频提示词)/i.test(input) && !matches.includes('video-replication')) add('video-production');
    if (matches.includes('video-replication') && matches.includes('video-production')) matches.splice(matches.indexOf('video-production'), 1);
    if (matches.includes('short-drama') && matches.includes('image-design') && !/(?:图片|图像|做图|出图|海报|插画|封面|设定图|场景图|产品图|修图)/i.test(input)) matches.splice(matches.indexOf('image-design'), 1);
    const available = await catalog();
    return matches.filter(name => available.has(name)).slice(0, 2);
  }
  async function read(name, resource = 'SKILL.md', offset = 0) {
    const skill = (await catalog()).get(name);
    if (!skill) throw new Error('没有找到这个创作技能');
    if (resource === 'SKILL.md') return resourcePage(name, resource, skill.source, offset);
    if (!/^(references|assets)\/[\w./-]+$/.test(resource)) throw new Error('只能读取技能的参考资料和模板');
    const root = await realpath(skill.directory);
    const file = await realpath(path.resolve(root, resource));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('技能资源路径无效');
    const text = await readFile(file, 'utf8');
    if (text.length > 60000) throw new Error('技能资料过长，请拆分为较小文件');
    return resourcePage(name, resource, text, offset);
  }
  return { search, read };
}
