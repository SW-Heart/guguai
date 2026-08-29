import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { closeDatabase, openDatabase, resetForTests, sql } from '../lib/db.mjs';
import { findUserByLogin, insertUser, registerUser, updateUserProfile } from '../lib/store.mjs';

function makeUser(username, nickname = null) {
  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(), username, nickname, role: 'user', status: 'active',
    passwordHash: 'scrypt:x:y', credits: 0, creditBalanceMicro: 0,
    creditHeldMicro: 0, createdAt, updatedAt: createdAt,
  };
}

beforeEach(() => {
  resetForTests();
  openDatabase({ file: ':memory:' });
});

afterEach(() => closeDatabase({ checkpoint: false }));

test('usernames and nicknames share one case-insensitive login-name namespace', () => {
  const first = makeUser('creator_account');
  const second = makeUser('phone_account');
  insertUser(first);
  insertUser(second);

  assert.throws(
    () => updateUserProfile(second.id, { nickname: 'creator_account' }),
    error => error.statusCode === 409 && error.message === '昵称已被占用',
  );
  updateUserProfile(second.id, { nickname: '创意伙伴' });
  assert.equal(findUserByLogin('创意伙伴').id, second.id);

  assert.throws(
    () => updateUserProfile(first.id, { nickname: '创意伙伴' }),
    error => error.statusCode === 409 && error.message === '昵称已被占用',
  );
  assert.throws(
    () => updateUserProfile(first.id, { nickname: 'PHONE_ACCOUNT' }),
    error => error.statusCode === 409 && error.message === '昵称已被占用',
  );

  // Keep the database trigger as a final guard for callers that do not use
  // the store helper.
  assert.throws(
    () => sql('UPDATE users SET nickname = :nickname WHERE id = :id').run({ nickname: 'phone_account', id: first.id }),
    /登录名已被占用/,
  );
});

test('legacy registration rejects a username that matches another nickname', () => {
  insertUser(makeUser('phone_account', 'existing_nickname'));
  const result = registerUser({ user: makeUser('existing_nickname') });
  assert.deepEqual(result, { status: 409, error: '账号已存在' });
  assert.equal(sql('SELECT COUNT(*) AS count FROM users').get().count, 1);
});
