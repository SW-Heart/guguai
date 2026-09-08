import { validateDirectorPlan } from '../public/features/drama/director-actions.js';
import { randomUUID } from 'node:crypto';

import {
  analyzeDirectorPlanRecovery,
  buildDirectorPackageRepairPrompt,
  buildDirectorShotCompletionPrompt,
  buildDirectorShotRepairPrompt,
  directorPackageJsonSchema,
  directorPackageRepairSystemPrompt,
  directorPackageSystemPrompt,
  directorRecoveryDiagnostic,
  directorShotCompletionJsonSchema,
  directorShotCompletionSystemPrompt,
  directorShotRepairJsonSchema,
  directorShotRepairSystemPrompt,
  mergeDirectorShotCompletion,
  parseJsonObject,
  prepareDirectorPackage,
  replaceDirectorShots,
  scriptAnalysisSystemPrompt,
  storyboardSystemPrompt,
  validateDirectorPackage,
  validateScriptAnalysis,
  validateStoryboard,
} from '../lib/drama-analysis.mjs';

export function createDirectorService({
  now = () => new Date().toISOString(),
  randomId = randomUUID,
  storyboardEngineVersion,
  llmConfig,
  conservativeInputTokenUpperBound,
  llmReservationMicro,
  llmRates,
  reserveLlmCredits,
  settleLlmCredits,
  releaseLlmCredits,
  markLlmBillingReconcile,
  callLlm,
  publicLlmUsage,
  publicDramaProject,
  normalizeDramaProject,
} = {}) {
  const requiredFunctions = {
    randomId,
    conservativeInputTokenUpperBound,
    llmReservationMicro,
    reserveLlmCredits,
    settleLlmCredits,
    releaseLlmCredits,
    markLlmBillingReconcile,
    callLlm,
    publicLlmUsage,
    publicDramaProject,
    normalizeDramaProject,
  };
  for (const [name, dependency] of Object.entries(requiredFunctions)) {
    if (typeof dependency !== 'function') throw new TypeError(`导演服务缺少 ${name} 依赖`);
  }
  if (!storyboardEngineVersion || !llmConfig || !llmRates) throw new TypeError('导演服务缺少配置依赖');

  function throwReservationError(reserved, includeWallet = false) {
    const error = Object.assign(new Error(reserved.error), { statusCode: reserved.status });
    error.publicData = {
      balance: reserved.balance,
      ...(includeWallet ? { held: reserved.held, available: reserved.available } : {}),
    };
    throw error;
  }

  function usageSummary(settlements, state) {
    return publicLlmUsage({
      inputTokens: settlements.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: settlements.reduce((sum, item) => sum + item.outputTokens, 0),
      chargedCredits: settlements.reduce((sum, item) => sum + item.chargedCredits, 0),
      attemptCount: state.attemptCount,
      maxAttemptCount: state.maxDirectorAttempts,
      recoveryAttempts: state.recoveryAttemptCount,
      maxRecoveryRounds: state.maxRecoveryRounds,
      initialReturnedCount: state.initialShotCount,
      recoveredShotCount: state.recoveredShotCount,
      completionCount: state.appendedShotCount,
      recoveryMode: state.recoveryMode,
      correctedProblemCount: state.recoveryMode === 'replace' ? state.recoveryProblemCount : 0,
      autoCompleted: state.recoveryHistory.includes('append') && state.appendedShotCount > 0,
      autoRegenerated: state.recoveryHistory.includes('regenerate'),
      autoCorrected: state.recoveryHistory.includes('replace') && state.recoveryAttemptCount > 0,
      attempts: settlements.map(item => ({
        type: item.attemptType,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        chargedCredits: item.chargedCredits,
      })),
    });
  }

  async function runSmartDirector({ userId, project, input = {}, saveProject }) {
    if (typeof saveProject !== 'function') throw new TypeError('导演服务缺少 saveProject 依赖');
    const baseRevision = Number(project.revision);
    project.input = String(input.input ?? project.input).trim();
    if (!project.input) throw Object.assign(new Error('请输入一句话创意或剧本'), { statusCode: 400 });
    project.settings = { ...project.settings, ...(input.settings || {}) };
    normalizeDramaProject(project);
    const inputIsScript = project.input.length >= 200 || /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\d+[-–—]\d+秒|场景|第[一二三四五六七八九十\d]+场|[A-Z]+\s*[：:])/m.test(project.input);
    const prompt = `制作参数：${JSON.stringify(project.settings)}\n生产协议版本：${storyboardEngineVersion}\n输入类型：${inputIsScript ? '完整剧本，必须保留原稿，不需要在结果中重复 script' : '故事创意，需要生成完整 script'}\n用户输入：\n${project.input}`;
    const maxOutputTokens = 12_000;
    const state = {
      maxDirectorAttempts: 4,
      maxRecoveryRounds: 3,
      initialShotCount: 0,
      recoveredShotCount: 0,
      appendedShotCount: 0,
      attemptCount: 0,
      recoveryAttemptCount: 0,
      recoveryMode: '',
      recoveryProblemCount: 0,
      latestFailureKind: '',
      latestGateIds: [],
      failureBalance: undefined,
      recoveryHistory: [],
    };
    const settlements = [];
    const initialRequestId = randomId();
    let activeRequestId = initialRequestId;
    let activeRequestHeld = false;
    const reservedMicro = llmReservationMicro(
      conservativeInputTokenUpperBound(directorPackageSystemPrompt, prompt),
      maxOutputTokens,
      llmRates,
    );
    const reserved = await reserveLlmCredits(userId, initialRequestId, reservedMicro, {
      projectId: project.id,
      skillName: 'smart-director',
      skillVersion: '6.0.0',
      attemptType: 'initial',
    });
    if (reserved.error) throwReservationError(reserved);
    activeRequestHeld = true;

    try {
      state.attemptCount += 1;
      const initialResult = await callLlm({
        system: directorPackageSystemPrompt,
        prompt,
        maxOutputTokens,
        outputSchema: directorPackageJsonSchema({ requireScript: !inputIsScript, shotCount: project.settings.shotCount }),
        toolName: 'submit_director_package',
        config: llmConfig,
      });
      settlements.push({
        ...await settleLlmCredits(userId, initialRequestId, initialResult, {
          projectId: project.id,
          skillName: 'smart-director',
          skillVersion: '6.0.0',
          attemptType: 'initial',
        }),
        attemptType: 'initial',
      });
      activeRequestHeld = false;
      let candidate;
      let pack;
      let prepared;
      let validationError;
      try {
        candidate = parseJsonObject(initialResult.text);
        state.initialShotCount = Array.isArray(candidate.shots) ? candidate.shots.length : 0;
        pack = validateDirectorPackage(candidate, project.settings, project.input);
      } catch (error) {
        validationError = error;
        if (candidate) {
          try { prepared = prepareDirectorPackage(candidate, project.settings, project.input); }
          catch (prepareError) { validationError = prepareError; }
        }
      }

      while (!pack && !prepared && state.attemptCount < state.maxDirectorAttempts) {
        const recoveryRound = state.recoveryAttemptCount + 1;
        state.recoveryMode = 'regenerate';
        const feedback = directorRecoveryDiagnostic(validationError, {
          requestedShotCount: project.settings.shotCount,
          returnedShotCount: state.initialShotCount,
        });
        state.latestFailureKind = feedback.kind;
        state.latestGateIds = (feedback.gateIds || []).slice(0, 7);
        state.recoveryProblemCount = Math.max(state.recoveryProblemCount, (feedback.problems || []).length);
        const recoveryPrompt = buildDirectorPackageRepairPrompt(prompt, project.settings, feedback, {
          round: recoveryRound,
          requireScript: !inputIsScript,
        });
        const recoveryRequestId = randomId();
        activeRequestId = recoveryRequestId;
        const attemptType = `package-repair-${recoveryRound}`;
        const recoveryReservedMicro = llmReservationMicro(
          conservativeInputTokenUpperBound(directorPackageRepairSystemPrompt, recoveryPrompt),
          maxOutputTokens,
          llmRates,
        );
        const recoveryReserved = await reserveLlmCredits(userId, recoveryRequestId, recoveryReservedMicro, {
          projectId: project.id,
          skillName: 'smart-director-package-repair',
          skillVersion: '1.0.0',
          attemptType,
          parentRequestId: initialRequestId,
          recoveryRound,
        });
        if (recoveryReserved.error) {
          state.failureBalance = recoveryReserved.balance;
          throw Object.assign(new Error(`第 ${recoveryRound} 轮自动重建导演方案所需积分不足：${recoveryReserved.error}`), { statusCode: recoveryReserved.status });
        }
        activeRequestHeld = true;
        state.recoveryAttemptCount = recoveryRound;
        state.recoveryHistory.push('regenerate');
        state.attemptCount += 1;
        const recoveryResult = await callLlm({
          system: directorPackageRepairSystemPrompt,
          prompt: recoveryPrompt,
          maxOutputTokens,
          outputSchema: directorPackageJsonSchema({ requireScript: !inputIsScript, shotCount: project.settings.shotCount }),
          toolName: 'submit_director_package',
          config: llmConfig,
        });
        settlements.push({
          ...await settleLlmCredits(userId, recoveryRequestId, recoveryResult, {
            projectId: project.id,
            skillName: 'smart-director-package-repair',
            skillVersion: '1.0.0',
            attemptType,
            parentRequestId: initialRequestId,
            recoveryRound,
          }),
          attemptType,
        });
        activeRequestHeld = false;
        let regenerated;
        try {
          regenerated = parseJsonObject(recoveryResult.text);
          state.recoveredShotCount = Array.isArray(regenerated.shots) ? regenerated.shots.length : 0;
          pack = validateDirectorPackage(regenerated, project.settings, project.input);
        } catch (error) {
          validationError = error;
          if (regenerated) {
            try { prepared = prepareDirectorPackage(regenerated, project.settings, project.input); }
            catch (prepareError) { validationError = prepareError; }
          }
        }
      }

      if (!pack && !prepared) throw validationError || new Error('智能导演未形成可修复的完整方案');
      if (!pack) {
        let recovery = analyzeDirectorPlanRecovery(prepared, project.settings);
        if (recovery.mode === 'none') throw validationError;
        let mode = recovery.mode;
        let base = prepared;
        let feedback = directorRecoveryDiagnostic(validationError, {
          requestedShotCount: project.settings.shotCount,
          returnedShotCount: state.initialShotCount,
        });
        let candidateShots = base.shots;

        while (!pack && state.attemptCount < state.maxDirectorAttempts) {
          const recoveryRound = state.recoveryAttemptCount + 1;
          state.recoveryMode = mode;
          state.latestFailureKind = feedback.kind;
          state.latestGateIds = (feedback.gateIds || []).slice(0, 7);
          state.recoveryProblemCount = Math.max(state.recoveryProblemCount, (feedback.problems || []).length);
          const append = mode === 'append';
          const replaceRecovery = append
            ? recovery
            : { ...recovery, mode: 'replace', requestedShotCount: project.settings.shotCount, failedGates: validationError?.gates?.filter(gate => !gate.ok) || recovery.failedGates || [] };
          const recoveryPrompt = append
            ? buildDirectorShotCompletionPrompt(base, project.settings, recovery.shortage)
            : buildDirectorShotRepairPrompt(base, project.settings, replaceRecovery, { feedback, round: recoveryRound, candidateShots });
          const recoverySystem = append ? directorShotCompletionSystemPrompt : directorShotRepairSystemPrompt;
          const recoverySchema = append ? directorShotCompletionJsonSchema(recovery.shortage.missingShotCount) : directorShotRepairJsonSchema(project.settings.shotCount);
          const recoveryCount = append ? recovery.shortage.missingShotCount : project.settings.shotCount;
          const recoveryMaxOutputTokens = Math.min(12_000, Math.max(2048, recoveryCount * 1800));
          const recoveryRequestId = randomId();
          activeRequestId = recoveryRequestId;
          const attemptType = append ? 'completion' : `quality-repair-${recoveryRound}`;
          const skillName = append ? 'smart-director-completion' : 'smart-director-quality-repair';
          const recoveryReservedMicro = llmReservationMicro(
            conservativeInputTokenUpperBound(recoverySystem, recoveryPrompt),
            recoveryMaxOutputTokens,
            llmRates,
          );
          const recoveryReserved = await reserveLlmCredits(userId, recoveryRequestId, recoveryReservedMicro, {
            projectId: project.id,
            skillName,
            skillVersion: '2.0.0',
            attemptType,
            parentRequestId: initialRequestId,
            recoveryRound,
          });
          if (recoveryReserved.error) {
            state.failureBalance = recoveryReserved.balance;
            throw Object.assign(new Error(`已有导演方案通过基础校验，但第 ${recoveryRound} 轮自动${append ? '补全' : '校正'}所需积分不足：${recoveryReserved.error}`), { statusCode: recoveryReserved.status });
          }
          activeRequestHeld = true;
          state.recoveryAttemptCount = recoveryRound;
          state.recoveryHistory.push(mode);
          state.attemptCount += 1;
          const recoveryResult = await callLlm({
            system: recoverySystem,
            prompt: recoveryPrompt,
            maxOutputTokens: recoveryMaxOutputTokens,
            outputSchema: recoverySchema,
            toolName: append ? 'submit_director_shot_completion' : 'submit_director_shot_repair',
            config: llmConfig,
          });
          settlements.push({
            ...await settleLlmCredits(userId, recoveryRequestId, recoveryResult, {
              projectId: project.id,
              skillName,
              skillVersion: '2.0.0',
              attemptType,
              parentRequestId: initialRequestId,
              recoveryRound,
            }),
            attemptType,
          });
          activeRequestHeld = false;
          let recoveryCandidate;
          try {
            recoveryCandidate = parseJsonObject(recoveryResult.text);
            state.recoveredShotCount = Array.isArray(recoveryCandidate.shots) ? recoveryCandidate.shots.length : 0;
            if (append) state.appendedShotCount = state.recoveredShotCount;
            const combinedShots = append
              ? [...base.shots, ...(Array.isArray(recoveryCandidate.shots) ? recoveryCandidate.shots : [])]
              : recoveryCandidate.shots;
            candidateShots = Array.isArray(combinedShots) ? combinedShots : candidateShots;
            pack = append
              ? mergeDirectorShotCompletion(base, recoveryCandidate, project.settings, project.input)
              : replaceDirectorShots(base, recoveryCandidate, project.settings, project.input);
          } catch (error) {
            validationError = error;
            feedback = directorRecoveryDiagnostic(error, {
              requestedShotCount: project.settings.shotCount,
              returnedShotCount: state.recoveredShotCount,
            });
            state.latestFailureKind = feedback.kind;
            state.latestGateIds = (feedback.gateIds || []).slice(0, 7);
            state.recoveryProblemCount = Math.max(state.recoveryProblemCount, (feedback.problems || []).length);
            if (Array.isArray(candidateShots) && candidateShots.length) {
              try { base = prepareDirectorPackage({ ...base, shots: candidateShots }, project.settings, project.input); }
              catch {}
            }
            mode = 'replace';
            recovery = {
              ...analyzeDirectorPlanRecovery(base, project.settings),
              mode: 'replace',
              requestedShotCount: project.settings.shotCount,
              failedGates: error?.gates?.filter(gate => !gate.ok) || [],
            };
          }
        }
        if (!pack) throw validationError || new Error('导演方案未通过最终生产校验');
      }

      const usage = usageSummary(settlements, state);
      project.workflowVersion = pack.workflowVersion;
      project.title = pack.title;
      project.synopsis = pack.synopsis;
      project.script = pack.script;
      project.scenes = pack.scenes.map(item => ({ id: randomId(), ...item }));
      project.resources = pack.resources.map(item => ({ id: randomId(), ...item, versions: [], selectedTaskId: '' }));
      const byName = new Map(project.resources.map(item => [item.name, item.id]));
      project.shots = pack.shots.map(item => ({
        id: randomId(),
        ...item,
        sceneId: project.scenes[Math.max(0, item.sceneNumber - 1)]?.id || project.scenes[0]?.id || '',
        resourceIds: item.resourceNames.map(name => byName.get(name)).filter(Boolean),
        referenceAssetIds: [],
        generation: { type: 'TEXT', firstFrameAssetId: '', lastFrameAssetId: '', referenceAssetIds: [], quality: '720p', count: 1 },
        videoVersions: [],
        selectedVideoTaskId: '',
        tailFrameAssetId: '',
      }));
      project.productionQuality = pack.productionQuality;
      project.status = 'designed';
      project.directorUsage = usage;
      normalizeDramaProject(project);
      await saveProject(userId, project, { expectedRevision: baseRevision });
      console.info('smart-director', JSON.stringify({
        projectId: project.id,
        attemptCount: usage.attemptCount,
        maxAttemptCount: state.maxDirectorAttempts,
        recoveryAttempts: state.recoveryAttemptCount,
        recoveryMode: state.recoveryMode,
        recoveryHistory: state.recoveryHistory,
        initialShotCount: state.initialShotCount,
        recoveredShotCount: state.recoveredShotCount,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        chargedCredits: usage.chargedCredits,
        status: 'succeeded',
      }));
      return { project: publicDramaProject(project), usage, balance: settlements.at(-1).wallet.balance };
    } catch (error) {
      if (activeRequestHeld) {
        if (error.billingReconcileRequired) await markLlmBillingReconcile(userId, activeRequestId, error);
        else await releaseLlmCredits(userId, activeRequestId, error.message).catch(releaseError => console.error('释放智能导演 LLM 冻结额度失败', releaseError));
        activeRequestHeld = false;
      }
      if (state.recoveryAttemptCount || settlements.length) {
        const usage = usageSummary(settlements, state);
        error.publicData = {
          directorRecovery: {
            attempted: state.recoveryAttemptCount > 0,
            mode: state.recoveryMode,
            history: state.recoveryHistory,
            round: state.recoveryAttemptCount,
            maxRounds: state.maxRecoveryRounds,
            exhausted: state.attemptCount >= state.maxDirectorAttempts,
            requestedShotCount: project.settings.shotCount,
            initialShotCount: state.initialShotCount,
            recoveredShotCount: state.recoveredShotCount,
            problemCount: state.recoveryProblemCount,
            lastFailureKind: state.latestFailureKind,
            lastGateIds: state.latestGateIds,
          },
          usage,
          balance: state.failureBalance ?? settlements.at(-1)?.wallet?.balance,
        };
        if (state.recoveryAttemptCount && !/^(?:已有导演方案通过基础校验，但第 \d+ 轮自动(?:补全|校正)|第 \d+ 轮自动重建导演方案)所需积分不足/.test(error.message)) {
          const recoveryLabel = state.recoveryHistory.includes('regenerate')
            ? '重建并校正'
            : state.recoveryMode === 'append' ? '补全' : '校正';
          error.message = `系统已自动${recoveryLabel} ${state.recoveryAttemptCount} 轮，但仍未形成可制作方案`;
        }
        console.info('smart-director', JSON.stringify({
          projectId: project.id,
          attemptCount: usage.attemptCount,
          maxAttemptCount: state.maxDirectorAttempts,
          recoveryAttempts: state.recoveryAttemptCount,
          recoveryMode: state.recoveryMode,
          recoveryHistory: state.recoveryHistory,
          initialShotCount: state.initialShotCount,
          recoveredShotCount: state.recoveredShotCount,
          lastFailureKind: state.latestFailureKind,
          lastGateIds: state.latestGateIds,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          chargedCredits: usage.chargedCredits,
          status: 'failed',
          category: error.code || (error.billingReconcileRequired ? 'billing_reconcile' : 'validation'),
        }));
      }
      throw error;
    }
  }

  async function analyzeScript({ userId, script, scope = {}, saveProject }) {
    if (typeof saveProject !== 'function') throw new TypeError('导演服务缺少 saveProject 依赖');
    const maxOutputTokens = 4096;
    const requestId = randomId();
    const inputTokenUpperBound = conservativeInputTokenUpperBound(scriptAnalysisSystemPrompt, script);
    const reservedMicro = llmReservationMicro(inputTokenUpperBound, maxOutputTokens, llmRates);
    const reserved = await reserveLlmCredits(userId, requestId, reservedMicro, { skillName: 'script-structure', skillVersion: '1.0.0' });
    if (reserved.error) throwReservationError(reserved, true);
    try {
      const result = await callLlm({ system: scriptAnalysisSystemPrompt, prompt: script, maxOutputTokens, jsonMode: true, config: llmConfig });
      const analysis = validateScriptAnalysis(parseJsonObject(result.text));
      const settled = await settleLlmCredits(userId, requestId, result, { skillName: 'script-structure', skillVersion: '1.0.0' });
      const project = {
        id: randomId(),
        ownerId: userId,
        originDeviceId: scope.deviceId,
        originWorkspaceId: scope.workspaceId,
        title: analysis.title,
        script,
        analysis,
        storyboard: null,
        status: 'analysis_complete',
        analysisRequestId: requestId,
        analysisUsage: { inputTokens: settled.inputTokens, outputTokens: settled.outputTokens, chargedCredits: settled.chargedCredits },
        createdAt: now(),
        updatedAt: now(),
      };
      await saveProject(userId, project, { create: true });
      return {
        project: publicDramaProject(project),
        analysis,
        usage: project.analysisUsage,
        balance: settled.wallet.balance,
        held: settled.wallet.held,
        available: settled.wallet.available,
      };
    } catch (error) {
      if (error.billingReconcileRequired) await markLlmBillingReconcile(userId, requestId, error);
      else await releaseLlmCredits(userId, requestId, error.message).catch(releaseError => console.error('释放 LLM 冻结额度失败', releaseError));
      throw error;
    }
  }

  async function createStoryboard({ userId, project, saveProject }) {
    if (typeof saveProject !== 'function') throw new TypeError('导演服务缺少 saveProject 依赖');
    const baseRevision = Number(project.revision);
    const maxOutputTokens = 8_000;
    const requestId = randomId();
    const prompt = `原始剧本：\n${project.script}\n\n已确认分析：\n${JSON.stringify(project.analysis)}`;
    const inputTokenUpperBound = conservativeInputTokenUpperBound(storyboardSystemPrompt, prompt);
    const reservedMicro = llmReservationMicro(inputTokenUpperBound, maxOutputTokens, llmRates);
    const reserved = await reserveLlmCredits(userId, requestId, reservedMicro, { projectId: project.id, skillName: 'shot-director', skillVersion: '1.0.0' });
    if (reserved.error) throwReservationError(reserved, true);
    try {
      const result = await callLlm({ system: storyboardSystemPrompt, prompt, maxOutputTokens, jsonMode: true, config: llmConfig });
      const storyboard = validateStoryboard(parseJsonObject(result.text));
      storyboard.shots = storyboard.shots.map(shot => ({ id: randomId(), ...shot, keyframeTaskId: '', videoTaskId: '' }));
      const settled = await settleLlmCredits(userId, requestId, result, { projectId: project.id, skillName: 'shot-director', skillVersion: '1.0.0' });
      project.storyboard = storyboard;
      project.status = 'storyboard_ready';
      project.storyboardRequestId = requestId;
      project.storyboardUsage = { inputTokens: settled.inputTokens, outputTokens: settled.outputTokens, chargedCredits: settled.chargedCredits };
      await saveProject(userId, project, { expectedRevision: baseRevision });
      return {
        project: publicDramaProject(project),
        usage: project.storyboardUsage,
        balance: settled.wallet.balance,
        held: settled.wallet.held,
        available: settled.wallet.available,
      };
    } catch (error) {
      if (error.billingReconcileRequired) await markLlmBillingReconcile(userId, requestId, error);
      else await releaseLlmCredits(userId, requestId, error.message).catch(releaseError => console.error('释放分镜 LLM 冻结额度失败', releaseError));
      throw error;
    }
  }

  async function planDirectorActions({ userId, project, message }) {
    const system = `你是短剧导演控制器。只返回 JSON {summary,actions:[{type,targetId,label,data}]}。summary 是给用户的简短决策摘要，不包含思考过程或逐步日志。
允许操作：design_story(data.input 创作目标，data.settings 包含 shotCount,totalDuration,shotDuration,aspectRatio；按用户要求设置总长与镜头数量，shotDuration 使用8/10/15/20秒，仅在空项目使用)，add_resource/update_resource(data: name,type character/location/prop,description,prompt,bible)，add_shot/update_shot(data: title,script,prompt,duration,resourceIds,generation)，generate_resource，generate_video，read_tail(读取目标镜头尾帧用于下一镜)，check_continuity，assemble。
更新或生成必须引用已有 targetId。新增内容与生成分两轮计划，不能编造 ID。尊重 lockedIds；保留已有台词、已选版本和用户指定首尾帧。修改只提交变化字段。没有必要操作时 actions 可为空。
用户委托剩余制作时：先补齐故事，再为缺失素材生成角色与场景图，然后生成未完成镜头，检查并拼接；不要重复生成已完成内容。单次最多 80 个操作。所有模型调用与生成会按项目现有积分规则计费。画布项目数据是唯一事实来源。`;
    const prompt = JSON.stringify({message,project});
    const requestId=randomId(); const maxOutputTokens=6000;
    const reserved=await reserveLlmCredits(userId,requestId,llmReservationMicro(conservativeInputTokenUpperBound(system,prompt),maxOutputTokens,llmRates),{projectId:project.id,skillName:'director-agent',skillVersion:'1.0.0'});
    if(reserved.error)throwReservationError(reserved,true);
    let settled;
    try {
      const result=await callLlm({system,prompt,maxOutputTokens,jsonMode:true,config:llmConfig});
      settled=await settleLlmCredits(userId,requestId,result,{projectId:project.id,skillName:'director-agent',skillVersion:'1.0.0'});
      return {plan:validateDirectorPlan(parseJsonObject(result.text),project),balance:settled.wallet.balance};
    } catch(error) {
      if(!settled) { if(error.billingReconcileRequired)await markLlmBillingReconcile(userId,requestId,error); else await releaseLlmCredits(userId,requestId,error.message); }
      if(settled)error.publicData={balance:settled.wallet.balance};
      throw error;
    }
  }
  return { runSmartDirector, analyzeScript, createStoryboard, planDirectorActions };

}
