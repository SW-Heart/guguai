import assert from 'node:assert/strict';
import test from 'node:test';

import * as generationJobsRepository from '../repositories/generation-jobs.mjs';
import { createAssetRepository } from '../repositories/assets.mjs';
import { createUploadRepository } from '../repositories/uploads.mjs';
import { createAccountRepository } from '../repositories/accounts.mjs';
import { createDeliveryRepository } from '../repositories/deliveries.mjs';
import { createProjectService } from '../services/projects.mjs';
import { createDirectorService } from '../services/director.mjs';
import * as store from '../lib/store.mjs';

test('generation job repository has a direct entrypoint and a compatible legacy export', () => {
  for (const name of [
    'claimGenerationJobs',
    'completeGenerationJob',
    'createGenerationRequest',
    'enqueueGenerationJob',
    'findGenerationRequest',
    'generationJobLeaseActive',
    'generationQueueStats',
    'renewGenerationJobLease',
    'rescheduleGenerationJob',
  ]) {
    assert.equal(store[name], generationJobsRepository[name], name);
  }
});

test('asset repository exposes a direct factory while the legacy store keeps its exports', () => {
  assert.equal(typeof createAssetRepository, 'function');
  for (const name of [
    'saveAssetRecord', 'findAsset', 'findAssetBySha256', 'deleteAsset', 'listAssets', 'listAssetChanges',
    'listPendingAssetDeliveries', 'markAssetDeliveryPending', 'markAssetDeliveryReady', 'findAssets', 'findCloudAssets',
  ]) assert.equal(typeof store[name], 'function', `${name} should remain exported from lib/store.mjs`);
});

test('upload repository exposes a direct factory while the legacy store keeps its exports', () => {
  assert.equal(typeof createUploadRepository, 'function');
  for (const name of [
    'createUploadIntent', 'findUploadIntent', 'countActiveUploadIntents', 'claimUploadIntent',
    'markUploadIntentFailed', 'completeUploadIntentWithAsset', 'expireUploadIntent',
    'expireUploadIntents', 'listRecoverableUploadIntents',
  ]) assert.equal(typeof store[name], 'function', `${name} should remain exported from lib/store.mjs`);
});

test('account repository exposes a direct factory while the legacy store keeps its exports', () => {
  assert.equal(typeof createAccountRepository, 'function');
  for (const name of [
    'findUserById', 'findUserByUsername', 'findUserByLogin', 'findUserByPhoneNumber', 'loginNameTaken', 'usernameTaken',
    'insertUser', 'createSmsUser', 'updateUserProfile', 'inviteUsed', 'burnInviteCode', 'registerUser',
    'createSessionRecord', 'userForSession', 'deleteSession', 'purgeExpiredSessions',
  ]) assert.equal(typeof store[name], 'function', `${name} should remain exported from lib/store.mjs`);
});

test('delivery repository exposes a direct factory while the legacy store keeps its exports', () => {
  assert.equal(typeof createDeliveryRepository, 'function');
  for (const name of ['listPendingAssetDeliveries', 'markAssetDeliveryPending', 'markAssetDeliveryReady']) {
    assert.equal(typeof store[name], 'function', `${name} should remain exported from lib/store.mjs`);
  }
});

test('project service exposes a direct factory without importing the HTTP entrypoint', () => {
  const service = createProjectService({
    videoAspectRatios: new Set(['9:16']),
    dramaVideoDurations: new Set([20]),
    dramaStepOrder: ['script', 'resources', 'storyboard', 'video'],
    canonicalVideoModelId: value => value,
    publicLlmUsage: value => value,
  });
  const project = service.normalizeDramaProject({ settings: {}, resources: [], shots: [] });
  assert.equal(project.schemaVersion, 5);
  assert.equal(project.settings.aspectRatio, '9:16');
  assert.equal(typeof service.removeGenerationFromDramaProject, 'function');
});

function directorServiceDependencies(overrides = {}) {
  return {
    storyboardEngineVersion: 3,
    llmConfig: { model: 'test-model' },
    llmRates: { inputYuanPerMillion: 1, outputYuanPerMillion: 1, yuanPerCredit: 1 },
    conservativeInputTokenUpperBound: () => 10,
    llmReservationMicro: () => 1,
    reserveLlmCredits: async () => ({ status: 402, error: '积分不足', balance: 0, held: 0, available: 0 }),
    settleLlmCredits: async () => ({ inputTokens: 2, outputTokens: 3, chargedCredits: 1, wallet: { balance: 9, held: 0, available: 9 } }),
    releaseLlmCredits: async () => {},
    markLlmBillingReconcile: async () => {},
    callLlm: async () => ({ text: '{}' }),
    publicLlmUsage: value => value,
    publicDramaProject: value => value,
    normalizeDramaProject: value => value,
    ...overrides,
  };
}

test('director service keeps LLM orchestration independent from the HTTP entrypoint', async () => {
  let persistedProject;
  const service = createDirectorService(directorServiceDependencies({
    reserveLlmCredits: async () => ({ status: 200 }),
    callLlm: async options => {
      assert.equal(options.config.model, 'test-model');
      return { text: JSON.stringify({ title: '第一集', logline: '冲突', scenes: [], assets: { characters: [], locations: [], props: [], costumes: [] } }) };
    },
  }));
  const result = await service.analyzeScript({
    userId: 'user-1',
    script: '女主走进雨夜。',
    scope: { deviceId: 'device-1', workspaceId: 'workspace-1' },
    saveProject: async (_userId, project, options) => {
      assert.deepEqual(options, { create: true });
      persistedProject = project;
    },
  });
  assert.equal(result.project.title, '第一集');
  assert.equal(persistedProject.originWorkspaceId, 'workspace-1');
});

test('director service preserves wallet details when an LLM reservation is rejected', async () => {
  const service = createDirectorService(directorServiceDependencies());
  await assert.rejects(
    service.analyzeScript({ userId: 'missing-user', script: '剧本', saveProject: async () => {} }),
    error => {
      assert.equal(error.statusCode, 402);
      assert.deepEqual(error.publicData, { balance: 0, held: 0, available: 0 });
      return true;
    },
  );
});

test('director agent returns a validated plan without changing project contents', async () => {
  const project={id:'p',resources:[],shots:[{id:'s',duration:8}],directorWorkspace:{lockedIds:[]}};
  const original=JSON.stringify(project);
  const service=createDirectorService(directorServiceDependencies({reserveLlmCredits:async()=>({status:200}),callLlm:async()=>({text:JSON.stringify({summary:'调整时长',actions:[{type:'update_shot',targetId:'s',data:{duration:10}}]})})}));
  const result=await service.planDirectorActions({userId:'u',project,message:'改成10秒'});
  assert.equal(result.plan.actions[0].status,'queued');assert.equal(result.balance,9);assert.equal(JSON.stringify(project),original);
});
test('invalid director output preserves billed usage rather than releasing settled credits', async () => {
  let released=false;
  const service=createDirectorService(directorServiceDependencies({reserveLlmCredits:async()=>({status:200}),releaseLlmCredits:async()=>{released=true;},callLlm:async()=>({text:JSON.stringify({summary:'bad',actions:[{type:'arbitrary_code'}]})})}));
  await assert.rejects(service.planDirectorActions({userId:'u',project:{resources:[],shots:[]},message:'test'}),error=>error.publicData.balance===9);
  assert.equal(released,false);
});
