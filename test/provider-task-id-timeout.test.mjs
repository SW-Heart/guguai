import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('../server.mjs');

test('uncertain async submission times out five minutes after task creation', () => {
  const createdAt = '2026-08-24T06:44:07.975Z';
  const task = {
    id: 'generation-1', provider: 'cntcn', status: 'running', providerTaskId: '',
    submissionUncertain: true, createdAt,
  };
  const created = Date.parse(createdAt);

  assert.equal(__test.awaitingProviderTaskId(task), true);
  assert.equal(__test.providerTaskIdDeadline(task), created + 5 * 60_000);
  assert.equal(__test.providerTaskIdTimedOut(task, created + 5 * 60_000 - 1), false);
  assert.equal(__test.providerTaskIdTimedOut(task, created + 5 * 60_000), true);
});

test('routed video submission timeout leaves margin for slow channel responses', () => {
  assert.equal(__test.routedVideoSubmitTimeoutMs, 180_000);
});

test('task with an upstream task ID is never treated as a submission timeout', () => {
  const task = {
    provider: 'cntcn', status: 'running', providerTaskId: 'upstream-123',
    submissionUncertain: true, createdAt: '2026-08-24T06:44:07.975Z',
  };

  assert.equal(__test.awaitingProviderTaskId(task), false);
  assert.equal(__test.providerTaskIdTimedOut(task, Date.parse('2026-08-25T06:44:07.975Z')), false);
});

test('startup recovery grace also covers non-durable providers without a task ID', () => {
  const task = {
    id: 'image-generation-1', type: 'image', provider: 'duomi', status: 'running',
    providerTaskId: '', sourceUrl: '', submissionUncertain: true,
    createdAt: '2026-08-24T06:44:07.975Z',
  };

  assert.equal(__test.awaitingProviderTaskId(task), true);
  assert.equal(__test.providerTaskIdTimedOut(task, Date.parse('2026-08-24T06:49:07.974Z')), false);
  assert.equal(__test.providerTaskIdTimedOut(task, Date.parse('2026-08-24T06:49:07.975Z')), true);
});

test('a generation result awaiting archive is not treated as a missing-task-ID timeout', () => {
  const task = {
    provider: 'duomi', status: 'running', providerTaskId: '',
    sourceUrl: 'https://example.com/result.png', submissionUncertain: true,
    createdAt: '2026-08-24T06:44:07.975Z',
  };

  assert.equal(__test.awaitingProviderTaskId(task), false);
});

test('model-unresponsive failures expose the dedicated public failure message', () => {
  const task = {
    status: 'failed', error: '模型无响应：超过5分钟未获得上游任务 ID',
    creditStatus: 'refunded', createdAt: '2026-08-24T06:44:07.975Z',
  };

  assert.equal(__test.generationFailureCode(task), 'MODEL_UNRESPONSIVE');
  const value = __test.publicGeneration(task);
  assert.equal(value.failure.code, 'MODEL_UNRESPONSIVE');
  assert.match(value.error, /^模型无响应。/);
  assert.match(value.error, /预扣积分已退回/);
});

test('a missing reference archive is not misreported as a completed-result archive', () => {
  const task = {
    status:'failed', providerTaskId:'', sourceUrl:'', archivePending:false,
    error:'文件本地缓存缺失，且没有可用的云端归档', creditStatus:'refunded',
  };
  assert.equal(__test.generationFailureCode(task), 'INVALID_REFERENCE');
});

test('historical upstream failures expose actionable public diagnostics', () => {
  const cases = [
    {
      task: { type:'video', error:'400 CD requires 1 to 9 reference images', routeDisplayName:'DIW · CD 720p' },
      code: 'REFERENCE_REQUIRED', message: '当前视频服务要求参考图片', suggestion: /1～9 张参考图片/,
    },
    {
      task: { type:'video', error:'402 {"detail":{"error":"insufficient_credits","required":150,"current":23}}', routeDisplayName:'DIW · ED Fast 720p' },
      code: 'UPSTREAM_BILLING', message: '当前视频生成服务额度不足', suggestion: /稍后重试或联系支持/,
    },
    {
      task: { type:'video', error:'400 prepare CD reference image 2 failed: download CD image failed with status 404' },
      code: 'REFERENCE_UNAVAILABLE', message: '第 2 张参考图暂时无法读取', suggestion: /重新上传第 2 张参考图/,
    },
    {
      task: { type:'video', error:'The input image may contain real person.' },
      code: 'PORTRAIT_RESTRICTED', message: '参考图片未通过真人肖像检查', suggestion: /不接受这张真人参考图.*彩铅.*面部网格/,
    },
    {
      task: { type:'video', error:'模型 11qizhenseedance-2.0 不支持画幅 9:16，可选：16:9。', aspectRatio:'9:16' },
      code: 'UNSUPPORTED_ASPECT_RATIO', message: '当前视频服务不支持 9:16 画幅', suggestion: /16:9/,
    },
    {
      task: { type:'video', error:'Prompt length exceeds the maximum allowed length of 4096' },
      code: 'PROMPT_TOO_LONG', message: '创作描述过长', suggestion: /4096/,
    },
    {
      task: { type:'video', error:'upstream_rejected' },
      code: 'UPSTREAM_REJECTED', message: '生成服务拒绝了本次任务', suggestion: /调整提示词或参考素材/,
    },
    {
      task: { type:'image', error:'任务执行失败: image upload failed, please check the image' },
      code: 'REFERENCE_UPLOAD_FAILED', message: '参考图片上传失败', suggestion: /重新上传或更换图片/,
    },
    {
      task: { type:'video', error:'400 Sora service is unavailable' },
      code: 'SERVICE_UNAVAILABLE', message: '生成服务暂时不可用', suggestion: /稍后重试/,
    },
    {
      task: { type:'image', error:'任务执行失败: API Error: openai returned 451: {"error":{"code":"content_policy_violation","message":"The generated images appear to be unsafe."}}' },
      code: 'CONTENT_REJECTED', message: '内容未通过生成检查', suggestion: /敏感、侵权或高风险/,
    },
  ];

  for (const item of cases) {
    const failure = __test.publicGeneration({ status:'failed', creditStatus:'refunded', ...item.task }).failure;
    assert.equal(failure.code, item.code, item.task.error);
    assert.equal(failure.message, item.message, item.task.error);
    assert.match(failure.suggestion, item.suggestion, item.task.error);
  }
});

test('reference content-policy failures identify the affected image', () => {
  const failure = __test.publicGeneration({
    status:'failed',
    error:'Reference upload failed: image reference 1 blocked: this image was previously flagged by content policy',
  }).failure;
  assert.equal(failure.code, 'CONTENT_REJECTED');
  assert.equal(failure.message, '第 1 张参考图未通过内容安全检查');
  assert.match(failure.suggestion, /第 1 张参考图/);
});

test('customer generation responses do not expose provider or route internals', () => {
  const value = __test.publicGeneration({
    id: 'generation-public-1', type: 'video', status: 'failed',
    modelId: 'seedance-2.0', videoModelId: 'seedance-2.0', prompt: '测试',
    routeId: 'sd20-720-wj-py900', routeDisplayName: 'WJ-seedance特价 · WJ-SD-TJ · sd-2.0-720-900',
    routeAdapter: 'wj-video', routeBaseUrl: 'https://upstream.example/v1', routeCredentialId: 'credential-secret',
    provider: 'wj', providerTaskId: 'upstream-task-123', model: 'sd-2.0-720-900',
    pricingSnapshot: { routeId: 'sd20-720-wj-py900', upstreamModelId: 'sd-2.0-720-900' },
    requestUrl: 'https://upstream.example/v1/videos', rawResponse: { secret: true },
    error: 'WJ-seedance特价 upstream rejected: upstream-task-123', creditStatus: 'refunded',
  });

  assert.equal(value.id, 'generation-public-1');
  for (const field of ['routeId', 'routeDisplayName', 'routeAdapter', 'routeBaseUrl', 'routeCredentialId', 'provider', 'providerTaskId', 'model', 'pricingSnapshot', 'requestUrl', 'rawResponse']) {
    assert.equal(Object.hasOwn(value, field), false, field);
  }
  assert.doesNotMatch(JSON.stringify(value), /WJ-seedance|upstream-task-123|upstream\.example|sd-2\.0-720-900/);
});

test('customer drama project responses do not serialize server-only fields', () => {
  const value = __test.publicDramaProject({
    id: 'project-public-1', title: '测试项目', mode: 'professional',
    originDeviceId: 'device-internal', originWorkspaceId: 'workspace-internal', ownerId: 'user-internal',
    provider: 'wj', routeId: 'sd20-720-wj-py900', routeDisplayName: 'WJ-seedance特价',
    apiKey: 'secret', internalDiagnostics: { upstreamModelId: 'sd-2.0-720-900' },
  });

  assert.equal(value.id, 'project-public-1');
  assert.equal(value.title, '测试项目');
  for (const field of ['ownerId', 'originDeviceId', 'originWorkspaceId', 'provider', 'routeId', 'routeDisplayName', 'apiKey', 'internalDiagnostics']) {
    assert.equal(Object.hasOwn(value, field), false, field);
  }
  assert.doesNotMatch(JSON.stringify(value), /WJ-seedance|sd-2\.0-720-900|device-internal|workspace-internal/);
});

test('generic HTTP errors are sanitized before reaching customers', () => {
  assert.equal(__test.publicHttpErrorMessage(new Error('WJ-seedance特价 · sd-2.0-720-900 请求失败')), '请求无法处理，请稍后重试或联系支持');
  assert.equal(__test.publicHttpErrorMessage(Object.assign(new Error('https://upstream.example failed'), { statusCode: 502 })), '生成服务暂时不可用，请稍后重试');
  assert.equal(__test.publicHttpErrorMessage(new Error('请输入提示词')), '请输入提示词');
});

test('customer credit entries omit ledger and provider internals', () => {
  const value = __test.publicCreditEntry({
    id: 'ledger-internal', userId: 'user-internal', generationId: 'generation-internal', requestId: 'request-internal',
    type: 'generation_charge', amount: -18, amountMicro: -18_000_000, contentType: 'video', modelId: 'seedance-2.0',
    provider: 'wj', model: 'sd-2.0-720-900', pricingVersion: 'sd20-720-wj-py900:3', note: '内部备注',
    createdAt: '2026-08-24T06:44:07.975Z',
  });

  assert.deepEqual(value, { type: 'generation_charge', amount: -18, createdAt: '2026-08-24T06:44:07.975Z', contentType: 'video', modelId: 'seedance-2.0' });
  assert.doesNotMatch(JSON.stringify(value), /ledger-internal|generation-internal|request-internal|wj|sd-2\.0-720-900|pricingVersion|内部备注/);
});

test('customer LLM usage omits internal reconciliation IDs', () => {
  const value = __test.publicLlmUsage({
    inputTokens: 10, outputTokens: 20, chargedCredits: 3,
    requestId: 'request-internal', userId: 'user-internal',
    attempts: [{ type: 'initial', id: 'ledger-internal', requestId: 'request-internal', inputTokens: 10, outputTokens: 20, chargedCredits: 3 }],
  });

  assert.deepEqual(value, {
    inputTokens: 10, outputTokens: 20, chargedCredits: 3,
    attempts: [{ type: 'initial', inputTokens: 10, outputTokens: 20, chargedCredits: 3 }],
  });
  assert.doesNotMatch(JSON.stringify(value), /request-internal|ledger-internal|user-internal/);
});

test('public assets expose authenticated delivery endpoints without leaking upstream URLs', () => {
  const value = __test.publicAsset({
    id: 'generation-1', ownerId: 'user-1', storageName: 'generation-1.mp4',
    sourceUrl: 'https://upstream.example/result.mp4', sourceRequiresAuth: true,
    sourceGenerationId: 'generation-task-1', kind: 'video', mimeType: 'video/mp4',
    size: 42, createdAt: '2026-08-24T06:44:07.975Z', updatedAt: '2026-08-24T06:44:07.975Z',
  });

  assert.equal(value.url, '/api/files/generation-1/content');
  assert.equal(value.directUrl, '/api/files/generation-1/direct');
  assert.equal(value.sourceGenerationId, 'generation-task-1');
  assert.equal(value.sourceUrl, undefined);
  assert.equal(value.sourceRequiresAuth, undefined);
  assert.equal(value.referenceSourceAvailable, true);
});
