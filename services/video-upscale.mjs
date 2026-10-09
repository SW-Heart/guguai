import { visibleGenerationPrompt } from '../lib/drama-style.mjs';
import {
  VIDEO_UPSCALE_CREDITS_PER_SECOND,
  VIDEO_UPSCALE_LIMITS,
  VIDEO_UPSCALE_MODEL_ID,
  VIDEO_UPSCALE_PRICE_QUALITY,
  VIDEO_UPSCALE_PROVIDER,
  videoUpscaleBitRate,
  videoUpscalePlan,
} from '../public/features/generation/upscale.js';

// An upscale task is charged before the client uploads the source video, the
// same way deferred reference uploads work. A task whose upload never
// finishes is refunded once the signed upload URL can no longer be used.
const uploadExpiryGraceMs = 2 * 3600_000;

function httpError(statusCode, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

export function createVideoUpscaleService({
  provider,
  findGeneration,
  saveGeneration,
  enqueueGenerationJob,
  failGeneration,
  chargeGenerationMicro,
  walletOf,
  currentPricing,
  pricingSnapshot,
  creditsToMicro,
  modelPrice,
  publicGeneration,
  safeId,
  now = () => new Date().toISOString(),
} = {}) {
  for (const [name, dependency] of Object.entries({ findGeneration, saveGeneration, enqueueGenerationJob, failGeneration, chargeGenerationMicro, walletOf, currentPricing, pricingSnapshot, creditsToMicro, modelPrice, publicGeneration, safeId })) {
    if (typeof dependency !== 'function') throw new TypeError(`高清放大服务缺少 ${name} 依赖`);
  }
  if (!provider) throw new TypeError('高清放大服务缺少 provider 依赖');

  function sourceTask(userId, scope, sourceGenerationId) {
    const id = safeId(sourceGenerationId);
    const task = id ? findGeneration(userId, id, scope) : null;
    if (!task || task.userDeleted) throw httpError(404, '要放大的视频不存在，请刷新后重试');
    if (task.type !== 'video' || task.status !== 'completed' || !task.assetId) throw httpError(409, '只能放大已完成的视频');
    return task;
  }

  function quoteFor(source, input) {
    const measured = Number(input.duration);
    const plan = videoUpscalePlan({ width:input.width, height:input.height, duration:measured });
    if (!plan.eligible) throw httpError(409, plan.reason);
    const size = Number(input.size);
    if (Number.isFinite(size) && size > VIDEO_UPSCALE_LIMITS.maxBytes) throw httpError(409, '视频文件超过 1GB，暂不支持放大');
    const recorded = Number(source.duration);
    if (Number.isFinite(recorded) && recorded > 0 && measured > recorded + 2) throw httpError(409, '视频时长与作品记录不一致，请刷新后重试');
    // The work record is the billing floor; the measured file length can only
    // raise it, so a client cannot lower the price by under-reporting.
    const billedSeconds = Math.max(Number.isFinite(recorded) && recorded > 0 ? Math.ceil(recorded) : 0, plan.billedSeconds);
    if (billedSeconds > VIDEO_UPSCALE_LIMITS.maxDurationSeconds) throw httpError(409, `视频超过 ${VIDEO_UPSCALE_LIMITS.maxDurationSeconds} 秒，暂不支持放大`);
    const pricing = currentPricing();
    const creditsPerSecond = Number(modelPrice(pricing, VIDEO_UPSCALE_MODEL_ID, VIDEO_UPSCALE_PRICE_QUALITY, VIDEO_UPSCALE_CREDITS_PER_SECOND));
    const snapshot = pricingSnapshot({ ...pricing, videoPerSecondMicro:creditsToMicro(creditsPerSecond) }, 'video', billedSeconds);
    return { plan:{ ...plan, billedSeconds }, creditsPerSecond, snapshot };
  }

  function publicQuote({ plan, creditsPerSecond, snapshot }) {
    return {
      sourceWidth:plan.sourceWidth,
      sourceHeight:plan.sourceHeight,
      outputWidth:plan.outputWidth,
      outputHeight:plan.outputHeight,
      label:plan.label,
      billedSeconds:plan.billedSeconds,
      creditsPerSecond,
      credits:snapshot.total,
    };
  }

  function quote({ user, scope, input }) {
    if (!provider.configured) throw httpError(503, '高清放大暂时不可用，请稍后重试');
    const source = sourceTask(user.id, scope, input.sourceGenerationId);
    return { ...publicQuote(quoteFor(source, input)), balance:walletOf(user.id).balance };
  }

  async function create({ user, scope, input }) {
    if (!provider.configured) throw httpError(503, '高清放大暂时不可用，请稍后重试');
    const requestId = String(input.requestId || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw httpError(400, '请求编号无效');
    const replay = findGeneration(user.id, requestId, scope);
    if (replay) {
      if (replay.modelId !== VIDEO_UPSCALE_MODEL_ID || replay.upscale?.sourceGenerationId !== safeId(input.sourceGenerationId)) throw httpError(409, '同一个请求编号不能用于不同操作');
      const upload = replay.awaitingReferences && replay.status === 'queued' ? provider.uploadTarget(replay.upscale.sourceKey) : null;
      return { task:publicGeneration(replay), upload, balance:walletOf(user.id).balance };
    }
    const source = sourceTask(user.id, scope, input.sourceGenerationId);
    const priced = quoteFor(source, input);
    if (input.expectedCredits !== undefined && Number(input.expectedCredits) !== priced.snapshot.total) {
      throw httpError(409, '价格已变化，请重新确认', { code:'PRICE_CHANGED', quote:publicQuote(priced) });
    }
    const { plan, snapshot } = priced;
    const createdAt = now();
    const task = {
      id:requestId, ownerId:user.id, originDeviceId:scope.deviceId, originWorkspaceId:scope.workspaceId,
      type:'video', prompt:String(visibleGenerationPrompt(source) || ''), referenceAssetIds:[],
      provider:VIDEO_UPSCALE_PROVIDER, model:'SuperResolveVideo', modelId:VIDEO_UPSCALE_MODEL_ID, videoModelId:VIDEO_UPSCALE_MODEL_ID,
      size:`${plan.outputWidth}x${plan.outputHeight}`, quality:plan.label, aspectRatio:source.aspectRatio || '', duration:plan.billedSeconds,
      upscale:{
        sourceGenerationId:source.id,
        sourceAssetId:source.assetId,
        sourceWidth:plan.sourceWidth,
        sourceHeight:plan.sourceHeight,
        outputWidth:plan.outputWidth,
        outputHeight:plan.outputHeight,
        bitRate:videoUpscaleBitRate(plan.outputWidth, plan.outputHeight),
        sourceKey:provider.sourceKey(user.id, requestId),
      },
      requestId,
      creditCost:snapshot.total, creditCostMicro:snapshot.totalMicro,
      pricingVersion:snapshot.version, pricingSnapshot:snapshot,
      creditStatus:'charged', status:'queued', providerTaskId:'', assetId:'', error:'',
      awaitingReferences:true, progressStage:'preparing_references',
      createdAt, updatedAt:createdAt, finishedAt:null,
    };
    const charged = await chargeGenerationMicro(user.id, task.id, task.creditCostMicro, {
      modelId:VIDEO_UPSCALE_MODEL_ID, contentType:'video', provider:VIDEO_UPSCALE_PROVIDER, pricingVersion:task.pricingVersion,
      onCharged:() => saveGeneration(user.id, task),
    });
    if (charged.error) throw httpError(charged.status, charged.error, { balance:charged.balance });
    const saved = findGeneration(user.id, task.id, scope) || task;
    return { task:publicGeneration(saved), upload:provider.uploadTarget(task.upscale.sourceKey), balance:charged.balance };
  }

  async function complete({ user, scope, input }) {
    const task = findGeneration(user.id, safeId(input.taskId), scope);
    if (!task || task.modelId !== VIDEO_UPSCALE_MODEL_ID) throw httpError(404, '高清放大任务不存在');
    if (!task.awaitingReferences || task.status !== 'queued') return { task:publicGeneration(task), balance:walletOf(user.id).balance };
    const uploaded = await provider.headSource(task.upscale.sourceKey);
    if (!uploaded?.size) throw httpError(409, '视频还没有上传完成，请重试');
    if (uploaded.size > VIDEO_UPSCALE_LIMITS.maxBytes) throw httpError(409, '视频文件超过 1GB，暂不支持放大');
    task.upscale = { ...task.upscale, sourceBytes:uploaded.size, uploadedAt:now() };
    task.awaitingReferences = false;
    task.progressStage = 'submitting';
    task.updatedAt = now();
    saveGeneration(user.id, task);
    enqueueGenerationJob({ userId:user.id, generationId:task.id });
    return { task:publicGeneration(task), balance:walletOf(user.id).balance };
  }

  function uploadExpired(task, at = Date.now()) {
    if (task?.modelId !== VIDEO_UPSCALE_MODEL_ID || !task.awaitingReferences || task.status !== 'queued') return false;
    const createdAt = Date.parse(task.createdAt || '');
    return Number.isFinite(createdAt) && at - createdAt > uploadExpiryGraceMs;
  }

  async function expireUpload(userId, task) {
    task.awaitingReferences = false;
    await failGeneration(userId, task, new Error('视频上传未完成，请重新发起高清放大'));
    task.finishedAt = now();
    saveGeneration(userId, task);
    await provider.deleteSource(task.upscale?.sourceKey).catch(() => {});
  }

  return Object.freeze({ quote, create, complete, uploadExpired, expireUpload });
}
