import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('history retry and remix bring back the original reference images', () => {
  assert.match(app, /if \(action === 'retry' \|\| action === 'continue'\) \{ void regenerateFromTask\(task\); return; \}/);
  assert.match(app, /if \(action === 'regenerate'\) \{ void regenerateFromTask\(task\); return; \}/);
  const body = app.slice(app.indexOf('async function regenerateFromTask'), app.indexOf('async function deleteGenerationTask'));
  assert.match(body, /taskReferenceIds\(task\)/);
  assert.match(body, /await loadFilesByIds\(ids\)/);
  assert.match(body, /continueFromTask\(task, task\.type, true, \{ replaceReferences:true, restoreMentions:true \}\)/);
});

test('remix only reports carried references when they were actually restored', () => {
  assert.match(app, /const carriedReference = includeReference && addTaskReference\(/);
  assert.match(app, /toast\(includeReference && \(carriedReference \|\| !carryPrompt\)/);
});
