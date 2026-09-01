import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { accountWorkspacePath, configuredWorkspaceRoot, normalizeAccountId } from '../desktop/workspace-scope.mjs';

test('account workspace paths are stable, separate, and confined to the selected root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workspace-scope-'));
  try {
    assert.equal(accountWorkspacePath(root, 'user-a'), path.join(root, 'accounts', 'user-a'));
    assert.notEqual(accountWorkspacePath(root, 'user-a'), accountWorkspacePath(root, 'user-b'));
    assert.equal(configuredWorkspaceRoot({ workspacePath: path.join(root, 'legacy') }, path.join(root, 'default')), path.join(root, 'legacy'));
    assert.equal(configuredWorkspaceRoot({ workspaceRootPath: root, workspacePath: path.join(root, 'legacy') }, path.join(root, 'default')), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('account identifiers cannot escape the account directory', () => {
  assert.equal(normalizeAccountId('account_01'), 'account_01');
  assert.throws(() => normalizeAccountId('../other'), /账号标识无效/);
  assert.throws(() => normalizeAccountId(''), /账号标识无效/);
  assert.throws(() => normalizeAccountId('账号'), /账号标识无效/);
});
