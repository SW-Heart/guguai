import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
const autoMentionSource = source.slice(source.indexOf('  const autoMentionWordChar='), source.indexOf('  function pasteIntoRichEditor('));

function makeChipHolder() {
  const holder = { firstElementChild:null };
  Object.defineProperty(holder, 'innerHTML', {
    set(value) {
      const [, id, label] = /^CHIP:([^:]*):(.*)$/.exec(value) || [];
      holder.firstElementChild = id
        ? { nodeType:1, chipId:id, chipLabel:label, classList:{ contains:name => name === 'wb-mention-chip' } }
        : { nodeType:1, classList:{ contains:() => false } };
    },
  });
  return holder;
}

function makeFragment() {
  return {
    nodeType:11,
    childNodes:[],
    lastChild:null,
    append(node) { this.childNodes.push(node); this.lastChild = node; },
  };
}

function autoMentionContext(files) {
  const context = {
    projectAssetIds:files.map(file => file.id),
    asset:id => files.find(file => file.id === id) || null,
    assetSyncing:() => false,
    mentionChipMarkup:mention => `CHIP:${mention.id}:${mention.label}`,
    Node:{ TEXT_NODE:3, ELEMENT_NODE:1 },
    document:{
      createDocumentFragment:makeFragment,
      createTextNode:value => ({ nodeType:3, nodeValue:value }),
      createElement:makeChipHolder,
    },
  };
  vm.createContext(context);
  vm.runInContext(autoMentionSource, context);
  return context;
}

const describeNodes = result => [...result.fragment.childNodes].map(node => node.nodeType === 3 ? node.nodeValue : `@${node.chipLabel}#${node.chipId}`);
const list = values => [...values];

const baseFiles = [
  { id:'a1', name:'小美.png', kind:'image' },
  { id:'a2', name:'小明.mp4', kind:'video' },
  { id:'a3', name:'小美丽.png', kind:'image' },
];

test('pasted @素材名 becomes chips for project assets without needing the file extension', () => {
  const { autoMentionFragment } = autoMentionContext(baseFiles);
  const result = autoMentionFragment('@小美在客厅中和@小明对话');
  assert.deepEqual(describeNodes(result), ['@小美#a1', '在客厅中和', '@小明#a2', '对话']);
  assert.deepEqual(list(result.mentionIds), ['a1', 'a2']);
  assert.deepEqual(list(result.ambiguous), []);
});

test('the longest asset name wins so shorter names cannot steal a match', () => {
  const { autoMentionFragment } = autoMentionContext(baseFiles);
  assert.deepEqual(describeNodes(autoMentionFragment('@小美丽登场')), ['@小美丽#a3', '登场']);
  assert.deepEqual(describeNodes(autoMentionFragment('@小美.png 登场')), ['@小美.png#a1', ' 登场']);
});

test('unknown names, emails and non-project assets stay plain text', () => {
  const { autoMentionFragment } = autoMentionContext(baseFiles);
  assert.deepEqual(describeNodes(autoMentionFragment('@路人甲走过')), ['@路人甲走过']);
  assert.deepEqual(describeNodes(autoMentionFragment('联系 zhang@小美.png 确认')), ['联系 zhang@小美.png 确认']);
  assert.deepEqual(autoMentionFragment('@小美出场').mentionIds.length, 1);
  const syncing = autoMentionContext(baseFiles);
  syncing.assetSyncing = () => true;
  assert.deepEqual(describeNodes(syncing.autoMentionFragment('@小美出场')), ['@小美出场']);
});

test('duplicate base names are reported instead of guessing an asset', () => {
  const { autoMentionFragment } = autoMentionContext([
    { id:'b1', name:'小刚.png', kind:'image' },
    { id:'b2', name:'小刚.jpg', kind:'image' },
  ]);
  const result = autoMentionFragment('@小刚在门口');
  assert.deepEqual(describeNodes(result), ['@小刚在门口']);
  assert.deepEqual(list(result.mentionIds), []);
  assert.deepEqual(list(result.ambiguous), ['小刚']);
  assert.deepEqual(describeNodes(autoMentionFragment('@小刚.jpg在门口')), ['@小刚.jpg#b2', '在门口']);
});

test('newlines survive the paste conversion', () => {
  const { autoMentionFragment } = autoMentionContext(baseFiles);
  assert.deepEqual(describeNodes(autoMentionFragment('第一句\r\n@小美\r第二句')), ['第一句\n', '@小美#a1', '\n第二句']);
});
