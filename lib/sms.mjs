import { createHash, createHmac, randomUUID } from 'node:crypto';

const DEFAULT_ENDPOINT = 'dypnsapi.aliyuncs.com';
const API_VERSION = '2017-05-25';
const DEFAULT_VALID_TIME_SECONDS = 300;
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_CODE_LENGTH = 6;

function stringValue(value) {
  return String(value ?? '').trim();
}

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

/** Reads SMS settings without exposing credentials to the browser. */
export function smsConfigFromEnv(env = process.env) {
  const accessKeyId = stringValue(env.SMS_ACCESS_KEY_ID);
  const accessKeySecret = stringValue(env.SMS_ACCESS_KEY_SECRET);
  const endpoint = stringValue(env.SMS_ENDPOINT || DEFAULT_ENDPOINT).replace(/^https?:\/\//i, '').replace(/\/+$/, '') || DEFAULT_ENDPOINT;
  const validTimeSeconds = positiveInteger(env.SMS_VALID_TIME_SECONDS, DEFAULT_VALID_TIME_SECONDS, 60, 900);
  const intervalSeconds = positiveInteger(env.SMS_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS, 30, 600);
  const codeLength = positiveInteger(env.SMS_CODE_LENGTH, DEFAULT_CODE_LENGTH, 4, 8);
  const baseUrl = stringValue(env.SMS_API_BASE) || `https://${endpoint}`;
  return Object.freeze({
    accessKeyId,
    accessKeySecret,
    endpoint,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    signName: stringValue(env.SMS_SIGN_NAME || '速通互联验证码'),
    templateCode: stringValue(env.SMS_TEMPLATE_CODE || '100001'),
    schemeName: stringValue(env.SMS_SCHEME_NAME || 'AIGC'),
    validTimeSeconds,
    intervalSeconds,
    codeLength,
    configured: Boolean(accessKeyId && accessKeySecret),
  });
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(parameters) {
  return Object.entries(parameters)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Builds an Alibaba Cloud ACS3 request for RPC-style APIs. */
function signedRequest({ action, parameters, config, timestamp = new Date(), nonce = randomUUID() }) {
  const base = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`);
  const host = base.host;
  const query = canonicalQuery({ Format: 'json', ...parameters });
  const date = timestamp.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const contentHash = sha256('');
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-content-sha256': contentHash,
    'x-acs-date': date,
    'x-acs-signature-nonce': nonce,
    'x-acs-version': API_VERSION,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map(key => `${key}:${canonicalHeaderValue(headers[key])}`)
    .join('\n');
  const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n\n${signedHeaders}\n${contentHash}`;
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256(canonicalRequest)}`;
  const signature = createHmac('sha256', config.accessKeySecret).update(stringToSign).digest('hex');
  const url = new URL(base);
  url.search = query;
  return {
    url,
    headers: {
      ...headers,
      Authorization: `ACS3-HMAC-SHA256 Credential=${config.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
      accept: 'application/json',
    },
  };
}

function smsErrorMessage(code) {
  return ({
    BUSINESS_LIMIT_CONTROL: '短信发送次数已达上限，请稍后再试',
    FREQUENCY_FAIL: '请求过于频繁，请稍后再试',
    MOBILE_NUMBER_ILLEGAL: '手机号格式不正确',
    INVALID_PARAMETERS: '短信服务参数无效',
    FUNCTION_NOT_OPENED: '短信认证服务尚未开通',
    'isv.BUSINESS_LIMIT_CONTROL': '短信发送次数已达上限，请稍后再试',
    'isv.MOBILE_NUMBER_ILLEGAL': '手机号格式不正确',
  })[code] || '短信服务暂时不可用，请稍后再试';
}

function errorStatus(code, fallback = 502) {
  return ['BUSINESS_LIMIT_CONTROL', 'FREQUENCY_FAIL', 'isv.BUSINESS_LIMIT_CONTROL'].includes(code) ? 429 : fallback;
}

async function aliyunRequest({ action, parameters, config = smsConfigFromEnv(), fetchImpl = globalThis.fetch, timestamp, nonce }) {
  if (!config.configured) throw Object.assign(new Error('短信登录服务尚未配置'), { statusCode: 503, publicMessage: '短信登录服务尚未配置' });
  const request = signedRequest({ action, parameters, config, timestamp, nonce });
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined,
    });
  } catch (error) {
    throw Object.assign(new Error('阿里云短信服务请求失败'), { statusCode: 502, publicMessage: '短信服务暂时不可用，请稍后再试', cause: error });
  }
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = {}; }
  const code = stringValue(payload.Code || payload.code);
  const ok = response.ok && (payload.Success === true || payload.success === true || code === 'OK');
  if (!ok) {
    const error = Object.assign(new Error(smsErrorMessage(code)), {
      statusCode: errorStatus(code),
      publicMessage: smsErrorMessage(code),
      upstreamCode: code,
      requestId: payload.RequestId || payload.requestId || '',
    });
    throw error;
  }
  return payload;
}

export async function sendSmsVerifyCode({ phone, env = process.env, config = smsConfigFromEnv(env), fetchImpl = globalThis.fetch } = {}) {
  const outId = randomUUID();
  const payload = await aliyunRequest({
    action: 'SendSmsVerifyCode',
    config,
    fetchImpl,
    parameters: {
      SchemeName: config.schemeName,
      CountryCode: '86',
      PhoneNumber: phone,
      SignName: config.signName,
      TemplateCode: config.templateCode,
      TemplateParam: JSON.stringify({ code: '##code##', min: String(Math.ceil(config.validTimeSeconds / 60)) }),
      CodeLength: config.codeLength,
      ValidTime: config.validTimeSeconds,
      DuplicatePolicy: 1,
      Interval: config.intervalSeconds,
      CodeType: 1,
      OutId: outId,
    },
  });
  const model = payload.Model || payload.model || {};
  return {
    requestId: payload.RequestId || payload.requestId || model.RequestId || model.requestId || '',
    bizId: model.BizId || model.bizId || '',
    outId,
  };
}

export async function checkSmsVerifyCode({ phone, code, env = process.env, config = smsConfigFromEnv(env), fetchImpl = globalThis.fetch } = {}) {
  const outId = randomUUID();
  let payload;
  try {
    payload = await aliyunRequest({
      action: 'CheckSmsVerifyCode',
      config,
      fetchImpl,
      parameters: {
        SchemeName: config.schemeName,
        CountryCode: '86',
        PhoneNumber: phone,
        VerifyCode: code,
        CaseAuthPolicy: 1,
        OutId: outId,
      },
    });
  } catch (error) {
    // PNVS may report a bad, expired, or superseded code as an API error
    // instead of returning Model.VerifyResult=UNKNOWN. It is a normal
    // verification failure, not an unavailable SMS service.
    if (error?.upstreamCode === 'isv.ValidateFail') {
      return { verified: false, requestId: error.requestId || '' };
    }
    throw error;
  }
  const model = payload.Model || payload.model || {};
  return {
    verified: String(model.VerifyResult || model.verifyResult || '').toUpperCase() === 'PASS',
    requestId: payload.RequestId || payload.requestId || model.RequestId || model.requestId || '',
  };
}

export const __test = { canonicalQuery, signedRequest, percentEncode, smsErrorMessage };
