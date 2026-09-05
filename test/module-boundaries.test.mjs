import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function sourceFiles(directory) {
  const files = [];
  async function visit(relativeDirectory) {
    const entries = await fs.readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) files.push(relativePath);
    }
  }
  await visit(directory);
  return files;
}

function importedSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\b(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.add(match[1].split('?')[0]);
  }
  return [...specs];
}

async function moduleGraph(files) {
  const absoluteFiles = new Set(files.map(file => path.resolve(root, file)));
  const graph = new Map();
  for (const file of absoluteFiles) {
    const source = await fs.readFile(file, 'utf8');
    const dependencies = [];
    for (const specifier of importedSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const base = path.resolve(path.dirname(file), specifier);
      const target = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')]
        .find(candidate => absoluteFiles.has(candidate));
      if (target) dependencies.push(target);
    }
    graph.set(file, dependencies);
  }
  return graph;
}

function findModuleCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];
  function visit(file) {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file].map(item => path.relative(root, item)).join(' -> '));
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return cycles;
}

test('extracted backend modules do not import the HTTP entrypoint or persistence internals', async () => {
  const files = [
    ...(await sourceFiles('providers')),
    ...(await sourceFiles('jobs')),
    ...(await sourceFiles('storage')),
    ...(await sourceFiles('services')),
    ...(await sourceFiles('server')),
  ];
  for (const relativePath of files) {
    const source = await fs.readFile(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"][^'"]*server\.mjs['"]/, relativePath);
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"][^'"]*lib\/(?:store|db)\.mjs['"]/, relativePath);
  }
});

test('extracted browser modules do not depend on the server entrypoint', async () => {
  const files = [
    ...(await sourceFiles('public/components')),
    ...(await sourceFiles('public/features')),
    ...(await sourceFiles('public/platform')),
    ...(await sourceFiles('public/state')),
  ];
  for (const relativePath of files) {
    const source = await fs.readFile(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"][^'"]*server\.mjs['"]/, relativePath);
  }
});

test('extracted modules have no relative import cycles', async () => {
  const files = [
    ...(await sourceFiles('providers')),
    ...(await sourceFiles('jobs')),
    ...(await sourceFiles('storage')),
    ...(await sourceFiles('services')),
    ...(await sourceFiles('server')),
    ...(await sourceFiles('public/components')),
    ...(await sourceFiles('public/features')),
    ...(await sourceFiles('public/platform')),
    ...(await sourceFiles('public/state')),
  ];
  const cycles = findModuleCycles(await moduleGraph(files));
  assert.deepEqual(cycles, [], `relative module cycles found: ${cycles.join('; ')}`);
});
