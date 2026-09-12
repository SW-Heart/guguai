import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const builtinRoot = fileURLToPath(new URL('../../agent-skills/', import.meta.url));
export function createAgentSkills({ roots = [builtinRoot, ...String(process.env.AGENT_SKILLS_DIRS || '').split(path.delimiter).filter(Boolean)] } = {}) {
  async function catalog() {
    const skills = new Map();
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
        const directory = path.join(root, entry.name);
        const source = await readFile(path.join(directory, 'SKILL.md'), 'utf8').catch(() => '');
        if (!source || source.length > 40000) continue;
        const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
        if (!frontmatter) continue;
        const field = name => (frontmatter[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
        if (field('name') !== entry.name || !field('description')) continue;
        skills.set(entry.name, { name: entry.name, description: field('description').slice(0, 1024), directory, source });
      }
    }
    return skills;
  }
  async function search(query = '') {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...(await catalog()).values()].map(({ name, description }) => ({ name, description }))
      .sort((a, b) => words.filter(w => `${b.name} ${b.description}`.toLowerCase().includes(w)).length - words.filter(w => `${a.name} ${a.description}`.toLowerCase().includes(w)).length).slice(0, 30);
  }
  async function read(name, resource = 'SKILL.md') {
    const skill = (await catalog()).get(name);
    if (!skill) throw new Error('没有找到这个创作技能');
    if (resource === 'SKILL.md') return { name, resource, text: skill.source };
    if (!/^(references|assets)\/[\w./-]+$/.test(resource)) throw new Error('只能读取技能的参考资料和模板');
    const root = await realpath(skill.directory);
    const file = await realpath(path.resolve(root, resource));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('技能资源路径无效');
    const text = await readFile(file, 'utf8');
    if (text.length > 60000) throw new Error('技能资料过长，请拆分为较小文件');
    return { name, resource, text };
  }
  return { search, read };
}
