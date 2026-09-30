import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSkills } from '../lib/agent/skills.mjs';
import { createAgentTools } from '../lib/agent/tools.mjs';
import { modelFacingMessage } from '../lib/agent/context.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillRoot = path.join(root, 'agent-skills/video-replication');
const skills = createAgentSkills({ roots: [path.join(root, 'agent-skills')] });
const tools = createAgentTools({ skills });

async function readAll(name, resource, reader = tools) {
  let offset = 0;
  let text = '';
  for (let count = 0; count < 100; count++) {
    const result = await reader.execute('skills_read', { name, resource, offset });
    const message = { role: 'tool', tool_call_id: 'skill-read', content: JSON.stringify(result) };
    assert.equal(modelFacingMessage(message), message, `${resource} must not be truncated`);
    text += result.text;
    if (result.nextOffset == null) return text;
    assert.ok(result.nextOffset > offset);
    assert.equal(result.offset, offset);
    offset = result.nextOffset;
  }
  assert.fail('Skill pagination did not finish');
}

test('every imported Hypit source is byte-identical and fully readable through real skill tools', async () => {
  const manifest = JSON.parse(await readFile(path.join(skillRoot, 'references/hypit/manifest.json'), 'utf8'));
  assert.ok(manifest.files.length > 0);
  for (const file of manifest.files) {
    const original = await readFile(path.join(root, 'vendor-hypit-skill', file.path));
    const imported = await readFile(path.join(skillRoot, 'references/hypit', file.path));
    assert.deepEqual(imported, original, file.path);
    assert.equal(createHash('sha256').update(imported).digest('hex'), file.sha256);
    assert.equal(imported.length, file.bytes);
    assert.equal(await readAll('video-replication', `references/hypit/${file.path}`), original.toString('utf8'));
  }
});

test('original Hypit relative Markdown links resolve inside the imported skill', async () => {
  const manifest = JSON.parse(await readFile(path.join(skillRoot, 'references/hypit/manifest.json'), 'utf8'));
  for (const file of manifest.files.filter(file => file.path.endsWith('.md'))) {
    const resource = `references/hypit/${file.path}`;
    const text = await readFile(path.join(skillRoot, resource), 'utf8');
    for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^\w+:\/\//.test(link) || link.startsWith('#')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(resource), link.split('#')[0]));
      assert.ok(target.startsWith('references/hypit/'), `${resource}: ${link}`);
      assert.ok((await skills.read('video-replication', target)).text, target);
    }
  }
});

test('skill pagination preserves escaped content and Unicode and rejects invalid offsets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gugu-skill-pages-'));
  try {
    await mkdir(path.join(directory, 'long-skill/references'), { recursive: true });
    const entry = '---\nname: long-skill\ndescription: 分页验证\n---\n' + '正文'.repeat(4000);
    const reference = 'a'.repeat(4499) + '🎥' + '\n"\\\u0000\t'.repeat(2500);
    await writeFile(path.join(directory, 'long-skill/SKILL.md'), entry);
    await writeFile(path.join(directory, 'long-skill/references/long.md'), reference);
    const local = createAgentSkills({ roots: [directory] });
    const localTools = createAgentTools({ skills: local });
    assert.equal(await readAll('long-skill', 'SKILL.md', localTools), entry);
    assert.equal(await readAll('long-skill', 'references/long.md', localTools), reference);
    for (const offset of [-1, 0.5, NaN, reference.length + 1]) {
      await assert.rejects(local.read('long-skill', 'references/long.md', offset), /位置/);
    }
    const end = await local.read('long-skill', 'references/long.md', reference.length);
    assert.equal(end.text, '');
    assert.equal(end.nextOffset, null);
    await assert.rejects(localTools.execute('skills_read', { name: 'long-skill', offset: -1 }));
    await assert.rejects(local.read('long-skill', 'references/../../outside.md', 1));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
