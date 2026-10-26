import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkTextMentions, splitTextMentions, textMentionEntries } from '../public/components/prompt-editor.js';

const describe = (text, files) => splitTextMentions(text, textMentionEntries(files)).parts.map(part => typeof part === 'string' ? part : `@${part.label}#${part.file.id}`);

const baseFiles = [
  { id:'a1', name:'小美.png', kind:'image' },
  { id:'a2', name:'小明.mp4', kind:'video' },
  { id:'a3', name:'小美丽.png', kind:'image' },
];

test('pasted @素材名 becomes mentions without needing the file extension', () => {
  assert.deepEqual(describe('@小美在客厅中和@小明对话', baseFiles), ['@小美#a1', '在客厅中和', '@小明#a2', '对话']);
  assert.deepEqual(describe('@XIAO 登场', [{ id:'c1', name:'xiao.png' }]), ['@xiao#c1', ' 登场']);
});

test('the longest asset name wins so shorter names cannot steal a match', () => {
  assert.deepEqual(describe('@小美丽登场', baseFiles), ['@小美丽#a3', '登场']);
  assert.deepEqual(describe('@小美.png 登场', baseFiles), ['@小美.png#a1', ' 登场']);
});

test('unknown names and emails stay plain text', () => {
  assert.deepEqual(describe('@路人甲走过', baseFiles), ['@路人甲走过']);
  assert.deepEqual(describe('联系 zhang@小美.png 确认', baseFiles), ['联系 zhang@小美.png 确认']);
  assert.deepEqual(describe('@小美出场', []), ['@小美出场']);
});

test('duplicate base names are reported instead of guessing an asset', () => {
  const entries = textMentionEntries([{ id:'b1', name:'小刚.png' }, { id:'b2', name:'小刚.jpg' }]);
  const result = splitTextMentions('@小刚在门口', entries);
  assert.deepEqual(result.parts, ['@小刚在门口']);
  assert.deepEqual(result.ambiguous, ['小刚']);
  assert.equal(splitTextMentions('@小刚.jpg在门口', entries).parts[0].file.id, 'b2');
});

// A small DOM: a flat editor of text nodes and chip elements with one selection.
function fakeEditor(text, caretOffset) {
  const selection = { rangeCount:0, isCollapsed:true, anchorNode:null, anchorOffset:0, removeAllRanges() { this.rangeCount = 0; }, addRange(range) { Object.assign(this, { rangeCount:1, anchorNode:range.node, anchorOffset:range.offset }); } };
  const documentRef = {
    defaultView:{ getSelection:() => selection },
    createTextNode:value => textNode(value),
    createRange:() => ({ setStart(node, offset) { Object.assign(this, { node, offset }); }, collapse() {} }),
    createTreeWalker:root => {
      const nodes = root.childNodes.filter(node => node.nodeType === 3);
      let index = -1;
      return { get currentNode() { return nodes[index]; }, nextNode:() => nodes[++index] };
    },
  };
  const editor = { ownerDocument:documentRef, childNodes:[] };
  const textNode = value => ({
    nodeType:3, nodeValue:value, parentElement:{ closest:() => null },
    replaceWith(...nodes) { editor.childNodes.splice(editor.childNodes.indexOf(this), 1, ...nodes); },
  });
  const first = textNode(text);
  editor.childNodes.push(first);
  if (caretOffset !== undefined) selection.addRange({ node:first, offset:caretOffset });
  return { editor, selection };
}
const chip = (file, label) => ({ nodeType:1, label, id:file.id });
const contents = editor => editor.childNodes.map(node => node.nodeType === 3 ? node.nodeValue : `[${node.label}#${node.id}]`);

test('existing text links once the reference is added and the caret stays in place', () => {
  const { editor, selection } = fakeEditor('让@小美走到窗边', 5);
  const result = linkTextMentions(editor, textMentionEntries(baseFiles), { mentionClass:'chip', createChip:chip });
  assert.deepEqual(result.ids, ['a1']);
  assert.deepEqual(contents(editor), ['让', '[小美#a1]', '走到窗边']);
  assert.equal(selection.anchorNode.nodeValue, '走到窗边');
  assert.equal(selection.anchorOffset, 1);
});

test('a caret right after a pasted mention lands in editable text after the chip', () => {
  const { editor, selection } = fakeEditor('参考@小明', 5);
  linkTextMentions(editor, textMentionEntries(baseFiles), { mentionClass:'chip', createChip:chip });
  assert.deepEqual(contents(editor), ['参考', '[小明#a2]', ' ']);
  assert.equal(selection.anchorNode, editor.childNodes[2]);
  assert.equal(selection.anchorOffset, 1);
});

test('text without a matching reference is left untouched', () => {
  const { editor } = fakeEditor('@路人甲 走过');
  const original = editor.childNodes[0];
  assert.deepEqual(linkTextMentions(editor, textMentionEntries(baseFiles), { mentionClass:'chip', createChip:chip }).ids, []);
  assert.equal(editor.childNodes[0], original);
});

test('every prompt editor links pasted text and text written before an upload', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const drama = readFileSync(new URL('../public/drama-studio.js', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../public/features/drama/canvas-generation-editor.js', import.meta.url), 'utf8');
  const director = readFileSync(new URL('../public/features/drama/director-workspace.js', import.meta.url), 'utf8');
  for (const target of ['image', 'video']) assert.match(app, new RegExp(`\\$\\('#${target}Prompt'\\)\\.addEventListener\\('paste'[\\s\\S]{0,120}pastePlainText`));
  const renderReferences = app.slice(app.indexOf('function renderReferences()'), app.indexOf('function setVideoGenerationType('));
  assert.match(renderReferences, /linkImagePromptTextMentions\(\)/);
  assert.match(renderReferences, /linkVideoPromptTextMentions\(\)/);
  assert.match(drama, /richEditor\?\.addEventListener\('paste'[^\n]+\n\s+linkShotEditorMentions\(id,richEditor\);/);
  const patch = drama.slice(drama.indexOf('function patchMountedWorkbenchShot('), drama.indexOf('function renderProfessionalWorkspace('));
  assert.match(patch, /linkShotEditorMentions\(shot\.id,editor\)/);
  assert.match(canvas, /addEventListener\('paste',event=>\{\s+if\(!pastePlainText\(editor,event\)\)return;[\s\S]{0,200}linkTextMentions\(editor/);
  assert.match(director, /mentionFiles:\(\)=>current\(\)\?generationPromptView\(draft\)\.attachments:\[\]/);
});
