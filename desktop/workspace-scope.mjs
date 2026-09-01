import path from 'node:path';

const accountDirectoryPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeAccountId(value) {
  const accountId = String(value || '').trim();
  if (!accountDirectoryPattern.test(accountId)) throw new Error('账号标识无效');
  return accountId;
}

export function accountWorkspacePath(root, accountId) {
  return path.join(path.resolve(String(root || '')), 'accounts', normalizeAccountId(accountId));
}

export function configuredWorkspaceRoot(settings, fallback) {
  const configured = String(settings?.workspaceRootPath || settings?.workspacePath || fallback || '').trim();
  return path.resolve(configured);
}
