import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(root, 'vendor-hypit-skill');
const destination = path.join(root, 'agent-skills/video-replication/references/hypit');
const check = process.argv.includes('--check');
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}
const paths = ['SKILL.md', ...(await files(path.join(source, 'references'), 'references'))];
const entries = [];
for (const relative of paths) {
  const content = await readFile(path.join(source, relative));
  const target = path.join(destination, relative);
  entries.push({ path: relative, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length });
  if (check) {
    if (!content.equals(await readFile(target))) throw new Error(`Hypit source differs: ${relative}`);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
const manifest = JSON.stringify({
  repository: 'https://github.com/hypit-ai/hypit',
  commit: '78d7436071bace1ee2bc9bf662d0b89cc3d84e2f',
  upstreamDirectory: 'skills/hypit',
  localSource: 'vendor-hypit-skill',
  adaptation: 'Original files are byte-for-byte copies. GuGu execution overrides live in ../gugu-tools.md and the active SKILL.md.',
  files: entries,
}, null, 2) + '\n';
const manifestPath = path.join(destination, 'manifest.json');
if (check) {
  if (await readFile(manifestPath, 'utf8') !== manifest) throw new Error('Hypit manifest differs');
} else await writeFile(manifestPath, manifest);
console.log(`${check ? 'Verified' : 'Copied'} ${paths.length} original Hypit skill files.`);
