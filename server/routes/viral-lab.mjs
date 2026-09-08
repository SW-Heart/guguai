import { randomUUID } from 'node:crypto';
import { createViralProject, findViralProject, listViralProjects, saveViralProject, viralGenerationRecords } from '../../repositories/viral-projects.mjs';
import { normalizeViralInput, assetSnapshot, assetApprovalHash, planApprovalHash, assertViralReady, viralError, fingerprint, viralPlanSystem } from '../../lib/viral-lab.mjs';

export function createViralLabRouteHandler({ bodyJson, sendJson, requireUser, requireDesktopWorkspaceScope, findAsset, publicAsset, publicGeneration,
  llmConfig, isLlmConfigured, callLlm, llmRates, conservativeInputTokenUpperBound, llmReservationMicro, reserveLlmCredits, settleLlmCredits, releaseLlmCredits, markLlmBillingReconcile }) {
  const activePlans = new Set();
  const snapshot = (userId, scope, project) => assetSnapshot(project, id => findAsset(userId, id, scope));
  function get(userId, scope, id) {
    const project = findViralProject(userId, id, scope);
    if (!project) throw viralError('实验项目不存在', 404);
    return project;
  }
  function planQuote(project) {
    const prompt = JSON.stringify({ type: project.type, productName: project.productName, brief: project.brief, sourceNotes: project.sourceNotes, materials: project.materials, units: project.units });
    const maxOutputTokens = 6000;
    const maxMicro = llmReservationMicro(conservativeInputTokenUpperBound(viralPlanSystem, prompt), maxOutputTokens, llmRates);
    return { prompt, maxOutputTokens, maxMicro, quoteId: fingerprint({ revision: project.revision, prompt, maxMicro, model: llmConfig.model }) };
  }
  function prepareGeneration(userId, scope, input) {
    const project = get(userId, scope, String(input.viralProjectId));
    assertViralReady(project, snapshot(userId, scope, project), { forGeneration: true });
    const unit = project.units.find(unit => unit.id === input.viralUnitId);
    if (!unit || input.viralPlanHash !== project.planApproval.hash) throw viralError('分段或确认版本已变化，请刷新后重新确认', 409);
    if (project.planning) throw viralError('方案正在整理，请稍候', 409);
    const requestId = project.planApproval.requests[unit.id];
    if (input.requestId !== requestId) throw viralError('本次生成授权已失效，请刷新项目', 409);
    return { type: 'video', quantity: 1, ...unit, videoModel: unit.modelId, referenceCounts: undefined, deferReferenceUpload: false,
      generationType: 'REFERENCE', requestId, viralProjectId: project.id, viralUnitId: unit.id, viralPlanHash: project.planApproval.hash,
      dramaProjectId: '', dramaShotId: '' };
  }
  async function route(req, res, url) {
    if (!url.pathname.startsWith('/api/viral-lab/')) return false;
    const user = await requireUser(req, res); if (!user) return true;
    const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
    const path = url.pathname.slice('/api/viral-lab/'.length);
    if (path === 'projects' && req.method === 'GET') {
      sendJson(res, 200, { projects: listViralProjects(user.id, scope).map(p => ({ id: p.id, title: p.title, type: p.type, updatedAt: p.updatedAt, unitCount: p.units.length, approved: Boolean(p.planApproval) })), capabilities: { aiPlan: isLlmConfigured(llmConfig), automaticSourceAnalysis: false, identityReview: false } });
      return true;
    }
    if (path === 'projects' && req.method === 'POST') {
      const input = normalizeViralInput(await bodyJson(req), { allowDraft: true });
      snapshot(user.id, scope, input);
      sendJson(res, 201, { project: createViralProject(user.id, scope, input) }); return true;
    }
    const match = path.match(/^projects\/([\w-]+)(?:\/(assets-confirm|plan-confirm|plan-quote|plan|retry))?$/);
    if (!match) { sendJson(res, 404, { error: '接口不存在' }); return true; }
    let project = get(user.id, scope, match[1]);
    const action = match[2];
    if (!action && req.method === 'GET') {
      const assets = [project.sourceAssetId, ...project.materials.map(m => m.assetId)].filter(Boolean).map(id => findAsset(user.id, id, scope)).filter(Boolean).map(publicAsset);
      sendJson(res, 200, { project, assets, tasks: viralGenerationRecords(user.id, project.id, scope).map(task => ({ ...publicGeneration(task), viralUnitId: task.viralUnitId, viralPlanHash: task.viralPlanHash })) }); return true;
    }
    if (!['PATCH', 'POST'].includes(req.method) || (!action && req.method !== 'PATCH') || (action && req.method !== 'POST')) { sendJson(res, 405, { error: '请求方法不支持' }); return true; }
    const input = await bodyJson(req);
    if (Number(input.revision) !== project.revision) throw viralError('项目版本已更新，请重新打开后操作；当前输入未覆盖服务器版本', 409);
    if (project.planning) throw viralError(activePlans.has(project.planning) ? 'AI 正在整理方案，请等待完成' : '上次 AI 请求已中断，请保留当前项目并联系支持核对计费；已有方案仍可导出', 409);
    if (!action) {
      const next = { ...project, ...normalizeViralInput(input, { allowDraft: true }) };
      if (next.type !== project.type) throw viralError('创建后不能改变实验类型，请新建项目');
      const refs = snapshot(user.id, scope, next);
      if (next.assetApproval?.hash !== assetApprovalHash(next, refs)) next.assetApproval = null;
      if (next.planApproval && next.planApproval.hash !== planApprovalHash(next, refs, { allowDraft: true })) next.planApproval = null;
      project = saveViralProject(user.id, scope, next, project.revision);
    } else if (action === 'assets-confirm') {
      if (!project.sourceAssetId || !project.materials.length) throw viralError('先添加原片和素材再确认');
      project.assetApproval = { hash: assetApprovalHash(project, snapshot(user.id, scope, project)), confirmedAt: new Date().toISOString(), review: 'user_visual_review' };
      project.planApproval = null;
      project = saveViralProject(user.id, scope, project, project.revision);
    } else if (action === 'plan-confirm') {
      const refs = snapshot(user.id, scope, project);
      assertViralReady(project, refs);
      if (project.units.some(unit => /待补充/.test(unit.prompt))) throw viralError('方案仍有待补充内容，请完善后确认');
      const hash = planApprovalHash(project, refs);
      // Reconfirming an unchanged plan must not create another paid submission scope.
      if (project.planApproval?.hash !== hash) project.planApproval = { hash, confirmedAt: new Date().toISOString(), requests: Object.fromEntries(project.units.map(unit => [unit.id, randomUUID()])) };
      project = saveViralProject(user.id, scope, project, project.revision);
    } else if (action === 'retry') {
      assertViralReady(project, snapshot(user.id, scope, project), { forGeneration: true });
      const id = project.planApproval.requests[input.unitId];
      const attempts = viralGenerationRecords(user.id, project.id, scope).filter(task => task.viralUnitId === input.unitId && task.viralPlanHash === project.planApproval.hash);
      const previous = attempts.find(task => task.id === id);
      if (!previous || previous.status !== 'failed' || attempts.length >= 2) throw viralError('仅失败分段可定向重试一次；再次失败请先修改具体方案');
      project.planApproval.requests[input.unitId] = randomUUID();
      project = saveViralProject(user.id, scope, project, project.revision);
    } else {
      if (!isLlmConfigured(llmConfig)) throw viralError('AI 方案服务暂不可用，你仍可填写或粘贴已有完整提示词', 503);
      if (!project.sourceNotes || !project.units.length || project.assetApproval?.hash !== assetApprovalHash(project, snapshot(user.id, scope, project))) throw viralError('请先确认资产、填写原片拆解并添加分段');
      const quote = planQuote(project);
      if (action === 'plan-quote') { sendJson(res, 200, { quoteId: quote.quoteId, maxCredits: quote.maxMicro / 1000000 }); return true; }
      if (input.quoteId !== quote.quoteId) throw viralError('AI 方案报价已变化，请重新查看费用', 409);
      const requestId = randomUUID();
      project = saveViralProject(user.id, scope, { ...project, planning: requestId, planError: '' }, project.revision);
      activePlans.add(requestId);
      let held = false; let settled = false;
      try {
        const reserved = await reserveLlmCredits(user.id, requestId, quote.maxMicro, { projectId: project.id, skillName: 'viral-plan', skillVersion: project.workflowVersion });
        if (reserved.error) throw viralError(reserved.error, reserved.status);
        held = true;
        const result = await callLlm({ system: viralPlanSystem, prompt: quote.prompt, maxOutputTokens: quote.maxOutputTokens, jsonMode: true, config: llmConfig });
        const billing = await settleLlmCredits(user.id, requestId, result, { projectId: project.id, skillName: 'viral-plan', skillVersion: project.workflowVersion });
        settled = true;
        const parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        if (!Array.isArray(parsed.units) || parsed.units.length !== project.units.length) throw viralError('AI 返回的分段数量不一致，已保留原方案；本次模型调用已按实际用量结算', 502);
        const units = project.units.map((unit, i) => ({ ...unit, prompt: parsed.units[i].prompt }));
        if (units.some(unit => typeof unit.prompt !== 'string' || !unit.prompt.trim())) throw viralError('AI 返回的提示词不完整，已保留原方案', 502);
        project = saveViralProject(user.id, scope, { ...project, ...normalizeViralInput({ ...project, units }), planning: null, planApproval: null, planError: '', planUsage: { chargedCredits: billing.chargedCredits } }, project.revision);
        sendJson(res, 200, { project, balance: billing.wallet.balance }); return true;
      } catch (error) {
        if (held && !settled) {
          if (error.billingReconcileRequired) await markLlmBillingReconcile(user.id, requestId, error);
          else await releaseLlmCredits(user.id, requestId, error.message);
        }
        saveViralProject(user.id, scope, { ...project, planning: null, planError: settled ? '本次 AI 调用已结算，但结果未形成有效方案，原稿已保留。' : 'AI 方案未完成，原稿已保留。' }, project.revision);
        throw error;
      } finally { activePlans.delete(requestId); }
    }
    sendJson(res, 200, { project }); return true;
  }
  return { route, prepareGeneration };
}
