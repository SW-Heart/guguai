import { randomUUID } from 'node:crypto';

export function createAccountRepository({ sql, tx, parseUserRow } = {}) {
  for (const [name, dependency] of Object.entries({ sql, tx, parseUserRow })) {
    if (typeof dependency !== 'function') throw new TypeError(`账号仓储缺少 ${name} 依赖`);
  }

  function findUserById(userId) {
    return parseUserRow(sql('SELECT * FROM users WHERE id = :userId').get({ userId }));
  }

  function findUserByUsername(username) {
    return parseUserRow(sql('SELECT * FROM users WHERE username = :username')
      .get({ username: String(username).toLowerCase() }));
  }

  function findUserByLogin(identifier) {
    const value = String(identifier ?? '').trim();
    if (!value) return null;
    return parseUserRow(sql(`
      SELECT * FROM users
      WHERE username = :identifier COLLATE NOCASE
         OR nickname = :identifier COLLATE NOCASE
      LIMIT 1`).get({ identifier: value }));
  }

  function findUserByPhoneNumber(phoneNumber) {
    return parseUserRow(sql('SELECT * FROM users WHERE phone_number = :phoneNumber')
      .get({ phoneNumber: String(phoneNumber) }));
  }

  function loginNameTaken(loginName, { excludeUserId = null } = {}) {
    const value = String(loginName ?? '').trim();
    if (!value) return false;
    const exclusion = excludeUserId ? 'id <> :excludeUserId AND ' : '';
    return sql(`
      SELECT 1 AS hit FROM users
      WHERE ${exclusion}(username = :loginName COLLATE NOCASE OR nickname = :loginName COLLATE NOCASE)
      LIMIT 1`).get({ loginName: value, ...(excludeUserId ? { excludeUserId } : {}) }) !== undefined;
  }

  function usernameTaken(username) {
    return loginNameTaken(username);
  }

  function insertUser(user) {
    const username = String(user.username).toLowerCase();
    const nickname = user.nickname === null || user.nickname === undefined
      ? null
      : String(user.nickname).trim() || null;
    if (loginNameTaken(username) || (nickname && loginNameTaken(nickname))) {
      throw Object.assign(new Error('登录名已被占用'), { statusCode: 409 });
    }
    sql(`
      INSERT INTO users(id, username, phone_number, nickname, password_hash, role, status, invite_code, admin_note,
                        disabled_at, disabled_by, updated_at, credit_balance_micro, credit_held_micro, created_at, doc_json)
      VALUES(:id, :username, :phoneNumber, :nickname, :passwordHash, :role, :status, :inviteCode, :adminNote,
             :disabledAt, :disabledBy, :updatedAt, :balanceMicro, :heldMicro, :createdAt, :docJson)`).run({
      id: user.id,
      username,
      phoneNumber: user.phoneNumber ?? null,
      nickname,
      passwordHash: user.passwordHash,
      role: user.role ?? 'user',
      status: user.status ?? 'active',
      inviteCode: user.inviteCode ?? null,
      adminNote: user.adminNote ?? null,
      disabledAt: user.disabledAt ?? null,
      disabledBy: user.disabledBy ?? null,
      updatedAt: user.updatedAt ?? user.createdAt,
      balanceMicro: user.creditBalanceMicro ?? 0,
      heldMicro: user.creditHeldMicro ?? 0,
      createdAt: user.createdAt,
      docJson: JSON.stringify({ ...user, username, nickname }),
    });
    return user;
  }

  function createSmsUser({ user }) {
    return tx(() => {
      const existing = findUserByPhoneNumber(user.phoneNumber);
      if (existing) return existing;
      try {
        insertUser(user);
      } catch (error) {
        if (!String(error?.message || '').includes('UNIQUE constraint failed')) throw error;
      }
      return findUserByPhoneNumber(user.phoneNumber) || findUserById(user.id);
    });
  }

  function updateUserProfile(userId, { nickname, passwordHash, updatedAt } = {}) {
    return tx(() => {
      const current = findUserById(userId);
      if (!current) return null;
      const nextNickname = nickname === undefined ? (current.nickname || null) : (String(nickname || '').trim() || null);
      if (nextNickname && loginNameTaken(nextNickname, { excludeUserId: userId })) {
        throw Object.assign(new Error('昵称已被占用'), { statusCode: 409 });
      }
      const next = { ...current, nickname: nextNickname, updatedAt: updatedAt || new Date().toISOString() };
      if (passwordHash !== undefined) next.passwordHash = passwordHash;
      sql(`
        UPDATE users
        SET nickname = :nickname,
            password_hash = :passwordHash,
            updated_at = :updatedAt,
            doc_json = :docJson
        WHERE id = :userId`).run({
        userId,
        nickname: nextNickname,
        passwordHash: next.passwordHash,
        updatedAt: next.updatedAt,
        docJson: JSON.stringify(next),
      });
      return findUserById(userId);
    });
  }

  function inviteUsed(code) {
    return sql('SELECT 1 AS hit FROM invite_uses WHERE code = :code').get({ code }) !== undefined;
  }

  function burnInviteCode(code, { userId, username, usedAt }) {
    const changes = sql(`
      INSERT INTO invite_uses(code, user_id, username, used_at)
      VALUES(:code, :userId, :username, :usedAt)
      ON CONFLICT(code) DO NOTHING`).run({ code, userId, username, usedAt }).changes;
    return changes > 0;
  }

  function consumeConfiguredInvite(code, { userId, username, usedAt }) {
    const invite = sql('SELECT * FROM invite_codes WHERE code = :code').get({ code });
    if (!invite) return { error: '邀请码无效', status: 400 };
    const nowIso = usedAt || new Date().toISOString();
    if (!invite.enabled) return { error: '邀请码已停用', status: 409 };
    if (invite.expires_at && invite.expires_at <= nowIso) return { error: '邀请码已过期', status: 409 };
    const updated = sql(`
      UPDATE invite_codes
      SET used_count = used_count + 1, updated_at = :updatedAt
      WHERE code = :code AND enabled = 1 AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > :nowIso)
    `).run({ code, updatedAt: nowIso, nowIso }).changes;
    if (updated !== 1) return { error: '邀请码已达到使用上限', status: 409 };
    const bonusMicro = Number(invite.signup_bonus_micro) || 0;
    return { invite, bonusMicro, usedAt: nowIso };
  }

  function registerUser({ user, inviteCode, signupBonus = null, grantBonus }) {
    return tx(() => {
      if (usernameTaken(user.username)) return { status: 409, error: '账号已存在' };
      let consumed;
      if (inviteCode) {
        consumed = consumeConfiguredInvite(inviteCode, {
          userId: user.id, username: user.username, usedAt: user.createdAt,
        });
        if (consumed.error) return consumed;
        user.inviteCode = inviteCode;
      }
      insertUser(user);
      if (consumed) {
        sql(`INSERT INTO invite_code_uses(id, code, user_id, username_snapshot, bonus_micro, used_at)
             VALUES(:id, :code, :userId, :username, :bonusMicro, :usedAt)`).run({ id: randomUUID(), code: inviteCode, userId: user.id, username: user.username, bonusMicro: consumed.bonusMicro, usedAt: consumed.usedAt });
      }
      const bonus = consumed ? consumed.bonusMicro / 1_000_000 : Number(signupBonus || 0);
      const wallet = bonus > 0 ? grantBonus(user.id, bonus) : null;
      return { user: findUserById(user.id), wallet, invite: consumed?.invite || null };
    });
  }

  function createSessionRecord({ tokenHash, userId, scope = 'user', csrfTokenHash = null, expiresAt, createdAt }) {
    sql(`
      INSERT INTO sessions(token_hash, user_id, scope, csrf_token_hash, expires_at, created_at)
      VALUES(:tokenHash, :userId, :scope, :csrfTokenHash, :expiresAt, :createdAt)`)
      .run({ tokenHash, userId, scope, csrfTokenHash, expiresAt, createdAt });
  }

  function deleteSession(tokenHash) {
    sql('DELETE FROM sessions WHERE token_hash = :tokenHash').run({ tokenHash });
  }

  function userForSession(tokenHash, nowIso) {
    const row = sql(`
      SELECT s.expires_at AS expiresAt, s.scope, s.csrf_token_hash AS csrfTokenHash,
             u.*
      FROM sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = :tokenHash`).get({ tokenHash });
    if (!row || !row.doc_json || row.expiresAt <= nowIso || row.status === 'disabled') {
      if (row) deleteSession(tokenHash);
      return null;
    }
    return { ...parseUserRow(row), sessionScope: row.scope, csrfTokenHash: row.csrfTokenHash };
  }

  function purgeExpiredSessions(nowIso) {
    return sql('DELETE FROM sessions WHERE expires_at <= :now').run({ now: nowIso }).changes;
  }

  return {
    findUserById,
    findUserByUsername,
    findUserByLogin,
    findUserByPhoneNumber,
    loginNameTaken,
    usernameTaken,
    insertUser,
    createSmsUser,
    updateUserProfile,
    inviteUsed,
    burnInviteCode,
    registerUser,
    createSessionRecord,
    userForSession,
    deleteSession,
    purgeExpiredSessions,
  };
}
