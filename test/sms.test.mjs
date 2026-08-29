import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSmsVerifyCode, sendSmsVerifyCode, smsConfigFromEnv, __test as smsTest } from '../lib/sms.mjs';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

test('SMS settings use the configured PNVS defaults and ACS3 signs a root RPC request', () => {
  const config = smsConfigFromEnv({
    SMS_ACCESS_KEY_ID: 'access-id',
    SMS_ACCESS_KEY_SECRET: 'access-secret',
    SMS_SIGN_NAME: '速通互联验证码',
    SMS_TEMPLATE_CODE: '100001',
    SMS_SCHEME_NAME: 'AIGC',
  });
  assert.equal(config.configured, true);
  assert.equal(config.endpoint, 'dypnsapi.aliyuncs.com');
  assert.equal(config.signName, '速通互联验证码');
  assert.equal(config.templateCode, '100001');
  assert.equal(config.schemeName, 'AIGC');
  const request = smsTest.signedRequest({
    action: 'CheckSmsVerifyCode',
    parameters: { PhoneNumber: '13800138000', VerifyCode: '123456' },
    config,
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    nonce: 'fixed-nonce',
  });
  assert.equal(new URL(request.url).pathname, '/');
  assert.equal(new URL(request.url).searchParams.get('Format'), 'json');
  assert.match(request.headers.Authorization, /^ACS3-HMAC-SHA256 Credential=access-id,/);
  assert.equal(request.headers['x-acs-action'], 'CheckSmsVerifyCode');
  assert.equal(request.headers['x-acs-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('SMS send delegates code generation to Alibaba and verification checks PASS', async () => {
  const config = smsConfigFromEnv({ SMS_ACCESS_KEY_ID: 'access-id', SMS_ACCESS_KEY_SECRET: 'access-secret' });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return response({ Code: 'OK', Success: true, RequestId: 'send-request', Model: { VerifyCode: '123456', BizId: 'biz-1' } });
    return response({ Code: 'OK', Success: true, RequestId: 'check-request', Model: { VerifyResult: 'PASS' } });
  };
  const sent = await sendSmsVerifyCode({ phone: '13800138000', config, fetchImpl });
  const sendParams = new URL(calls[0].url).searchParams;
  assert.equal(sendParams.get('SchemeName'), 'AIGC');
  assert.equal(sendParams.get('SignName'), '速通互联验证码');
  assert.equal(sendParams.get('TemplateCode'), '100001');
  assert.deepEqual(JSON.parse(sendParams.get('TemplateParam')), { code: '##code##', min: '5' });
  const checked = await checkSmsVerifyCode({ phone: '13800138000', code: '123456', config, fetchImpl });
  assert.equal(checked.verified, true);
  assert.equal(new URL(calls[1].url).searchParams.get('VerifyCode'), '123456');
  assert.equal(calls[0].options.method, 'POST');
});

test('SMS API errors do not leak upstream text and preserve throttling status', async () => {
  const config = smsConfigFromEnv({ SMS_ACCESS_KEY_ID: 'access-id', SMS_ACCESS_KEY_SECRET: 'access-secret' });
  await assert.rejects(
    () => sendSmsVerifyCode({ phone: '13800138000', config, fetchImpl: async () => response({ Code: 'FREQUENCY_FAIL', Message: 'sensitive upstream detail' }, 400) }),
    error => error.statusCode === 429 && error.publicMessage === '请求过于频繁，请稍后再试',
  );
});
