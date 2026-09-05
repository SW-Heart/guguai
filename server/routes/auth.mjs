export function createAuthRouteHandler({
  bodyJson,
  sendJson,
  clientIp,
  normalizePhoneNumber,
  captchaStore,
  smsConfig,
  smsSendLimiter,
  smsVerifyLimiter,
  sendSmsVerifyCode,
  checkSmsVerifyCode,
  findUserByPhoneNumber,
  createSmsUser,
  hashPassword,
  randomId,
  randomSecret,
  ensureUserDirs,
  createSession,
  setSessionCookie,
  publicUser,
  now,
  registerUser,
  findUserByLogin,
  loginLimiter,
  verifyPassword,
  currentUser,
  requireUser,
  updateUserProfile,
  parseCookies,
  deleteSession,
  tokenHash,
  clearSessionCookie,
  profileNicknamePattern,
} = {}) {
  return async function handleAuthRoute(req, res, url) {
    if (url.pathname === '/api/auth/captcha' && req.method === 'GET') {
      sendJson(res, 200, captchaStore.issue(clientIp(req)));
      return true;
    }
    if (url.pathname === '/api/auth/sms/send' && req.method === 'POST') {
      const input = await bodyJson(req);
      const phone = normalizePhoneNumber(input.phone);
      if (!phone) { sendJson(res, 400, { error:'请输入正确的手机号' }); return true; }
      const captcha = captchaStore.verify(input.captchaId, input.captchaCode, clientIp(req));
      if (!captcha.ok) { sendJson(res, 400, { error:'人机验证失败，请刷新验证码后重试' }); return true; }
      if (!smsConfig.configured) { sendJson(res, 503, { error:'短信登录服务尚未配置' }); return true; }
      const remainingMs = smsSendLimiter.remainingMs(req, phone);
      if (remainingMs > 0) {
        sendJson(res, 429, { error:`请 ${Math.ceil(remainingMs / 1000)} 秒后再试`, cooldownSeconds:Math.ceil(remainingMs / 1000) });
        return true;
      }
      try {
        await sendSmsVerifyCode({ phone, config:smsConfig });
        smsSendLimiter.record(req, phone);
        sendJson(res, 200, { ok:true, cooldownSeconds:smsConfig.intervalSeconds, expiresIn:smsConfig.validTimeSeconds });
      } catch (error) {
        sendJson(res, error.statusCode || 502, { error:error.publicMessage || '短信服务暂时不可用，请稍后再试' });
      }
      return true;
    }
    if (url.pathname === '/api/auth/sms/login' && req.method === 'POST') {
      const input = await bodyJson(req);
      const phone = normalizePhoneNumber(input.phone);
      const code = String(input.code || '').trim();
      if (!phone) { sendJson(res, 400, { error:'请输入正确的手机号' }); return true; }
      if (!/^\d{4,8}$/.test(code)) { sendJson(res, 400, { error:'请输入短信验证码' }); return true; }
      if (!smsConfig.configured) { sendJson(res, 503, { error:'短信登录服务尚未配置' }); return true; }
      if (smsVerifyLimiter.isBlocked(req, phone)) { sendJson(res, 429, { error:'验证码尝试次数过多，请稍后再试' }); return true; }
      let checked;
      try { checked = await checkSmsVerifyCode({ phone, code, config:smsConfig }); }
      catch (error) { sendJson(res, error.statusCode || 502, { error:error.publicMessage || '短信服务暂时不可用，请稍后再试' }); return true; }
      if (!checked.verified) {
        smsVerifyLimiter.recordFailure(req, phone);
        sendJson(res, 401, { error:'验证码错误或已过期' });
        return true;
      }
      smsVerifyLimiter.reset(req, phone);
      let user = findUserByPhoneNumber(phone);
      if (user?.status === 'disabled') { sendJson(res, 403, { error:'账号已停用，请联系管理员' }); return true; }
      if (!user) {
        const createdAt = now();
        user = createSmsUser({ user:{ id:randomId(), username:phone, phoneNumber:phone, role:'user', status:'active', credits:0, creditBalanceMicro:0, creditHeldMicro:0, passwordHash:await hashPassword(randomSecret()), createdAt, updatedAt:createdAt } });
      }
      if (!user) { sendJson(res, 500, { error:'创建短信账号失败，请稍后再试' }); return true; }
      await ensureUserDirs(user.id);
      const token = createSession(user.id);
      setSessionCookie(res, token);
      sendJson(res, 200, { user:publicUser(user) });
      return true;
    }
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      const input = await bodyJson(req);
      const username = String(input.username || '').trim().toLowerCase();
      const password = String(input.password || '');
      if (!/^[a-z0-9_]{3,24}$/.test(username)) { sendJson(res, 400, { error:'账号需为 3–24 位字母、数字或下划线' }); return true; }
      if (password.length < 8 || password.length > 128) { sendJson(res, 400, { error:'密码长度需为 8–128 位' }); return true; }
      const passwordHash = await hashPassword(password);
      const user = { id:randomId(), username, role:'user', status:'active', credits:0, creditBalanceMicro:0, creditHeldMicro:0, passwordHash, createdAt:now(), updatedAt:now() };
      const result = registerUser({ user });
      if (result.error) { sendJson(res, result.status, { error:result.error }); return true; }
      await ensureUserDirs(result.user.id);
      const token = createSession(result.user.id);
      setSessionCookie(res, token);
      sendJson(res, 201, { user:publicUser(result.user) });
      return true;
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const input = await bodyJson(req);
      const identifier = String(input.username || input.identifier || '').trim();
      if (loginLimiter.isBlocked(req, identifier)) { sendJson(res, 429, { error:'尝试次数过多，请稍后再试' }); return true; }
      const user = findUserByLogin(identifier);
      const valid = user && user.status === 'active' ? await verifyPassword(String(input.password || ''), user.passwordHash) : false;
      if (!valid) {
        loginLimiter.recordFailure(req, identifier);
        sendJson(res, 401, { error:'账号或密码不正确' });
        return true;
      }
      loginLimiter.reset(req, identifier);
      await ensureUserDirs(user.id);
      const token = createSession(user.id);
      setSessionCookie(res, token);
      sendJson(res, 200, { user:publicUser(user) });
      return true;
    }
    if (url.pathname === '/api/auth/profile' && req.method === 'PATCH') {
      const user = requireUser(req, res);
      if (!user) return true;
      const input = await bodyJson(req);
      const hasNickname = Object.prototype.hasOwnProperty.call(input, 'nickname');
      const hasPassword = Object.prototype.hasOwnProperty.call(input, 'password');
      if (!hasNickname && !hasPassword) { sendJson(res, 400, { error:'没有需要保存的设置' }); return true; }
      let nickname;
      if (hasNickname) {
        if (input.nickname !== null && typeof input.nickname !== 'string') { sendJson(res, 400, { error:'昵称格式不正确' }); return true; }
        nickname = input.nickname === null ? '' : input.nickname.trim();
        if (nickname && !profileNicknamePattern.test(nickname)) { sendJson(res, 400, { error:'昵称需为 2–24 位中文、字母、数字、下划线或短横线' }); return true; }
      }
      let passwordHash;
      if (hasPassword) {
        if (typeof input.password !== 'string') { sendJson(res, 400, { error:'密码格式不正确' }); return true; }
        if (input.password && (input.password.length < 8 || input.password.length > 128)) { sendJson(res, 400, { error:'密码长度需为 8–128 位' }); return true; }
        if (input.password) passwordHash = await hashPassword(input.password);
      }
      if (!hasNickname && passwordHash === undefined) { sendJson(res, 400, { error:'请输入新密码' }); return true; }
      try {
        const updated = updateUserProfile(user.id, { nickname, passwordHash, updatedAt:now() });
        sendJson(res, updated ? 200 : 401, updated ? { user:publicUser(updated) } : { error:'登录状态已失效，请重新登录' });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error:error.statusCode === 409 ? error.message : '账号设置保存失败，请稍后重试' });
      }
      return true;
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookies(req.headers.cookie).studio_session;
      if (token) deleteSession(tokenHash(token));
      clearSessionCookie(res);
      sendJson(res, 200, { ok:true });
      return true;
    }
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const user = currentUser(req);
      sendJson(res, user ? 200 : 401, user ? { user:publicUser(user) } : { error:'未登录' });
      return true;
    }
    return false;
  };
}
