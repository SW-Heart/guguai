import { generationFrames } from '../../public/features/agent/frames.js';
export function createAgentRouteHandler({ repository: repo, runtime, gateway, skills, bodyJson, sendJson, requireUser, requireDesktopWorkspaceScope, loadProject, publicProject, findGeneration, publicGeneration, walletOf }) {
  async function snapshot(session) {
    const { doc } = session;
    const artifacts = session.projectId ? repo.artifacts(session) : {...doc,generations:generationFrames(doc)};
    const messages = doc.messages.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content).map((m, i) => ({ id: `${session.id}-${i}`, role: m.role, text: m.content }));
    for (const input of repo.inputs(session)) messages.push({ id: `input-${input.seq}`, role: 'user', text: input.text });
    const project = session.projectId ? await loadProject(session.userId, session.projectId, session.scope) : null;
    return {
      id: session.id, state: session.state, version: doc.version || 0, settings: session.settings,
      messages, draft: doc.draft || '', activity: doc.activity || '', approval: doc.approval?.decision ? null : doc.approval || null,
      documents: artifacts.documents.map(({ id, title, text, revision, conversationId }) => ({ id, title, text, revision, conversationId })),
      generations: artifacts.generations,
      tasks: artifacts.generations.filter(g => !g.placeholder).map(g => findGeneration(session.userId, g.id, session.scope)).filter(Boolean).map(publicGeneration),
      project: project ? publicProject(project) : null,
      balance: walletOf(session.userId).balance,
    };
  }
  async function settings(input, previous = {}) {
    const result = { model: previous.model || gateway.config.model, autoGenerate: previous.autoGenerate || false, generationBudgetMicro: previous.generationBudgetMicro || 0 };
    if (input.model !== undefined) {
      if (!(await gateway.listModels()).some(m => m.id === input.model)) throw Object.assign(new Error('所选模型不可用'), { statusCode: 400 });
      result.model = input.model;
    }
    if (input.autoGenerate !== undefined) { if (typeof input.autoGenerate !== 'boolean') throw Object.assign(new Error('生成设置无效'), { statusCode: 400 }); result.autoGenerate = input.autoGenerate; }
    if (input.generationBudgetCredits !== undefined) {
      const credits = input.generationBudgetCredits;
      if (!Number.isFinite(credits) || credits < 0 || credits > 10000) throw Object.assign(new Error('生成预算需在 0 到 10000 积分之间'), { statusCode: 400 });
      result.generationBudgetMicro = Math.round(credits * 1000000);
    }
    return result;
  }
  return async function agentRoute(req, res, url) {
    if (!url.pathname.startsWith('/api/agent/')) return false;
    const user = await requireUser(req, res); if (!user) return true;
    const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
    if (url.pathname === '/api/agent/config' && req.method === 'GET') {
      sendJson(res, 200, { configured: gateway.config.configured, defaultModel: gateway.config.model, models: await gateway.listModels(), skills: await skills.search() }); return true;
    }
    if (url.pathname === '/api/agent/sessions' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      if (projectId && !await loadProject(user.id, projectId, scope)) { sendJson(res, 404, { error: '画布不存在' }); return true; }
      sendJson(res, 200, { sessions: repo.list(user.id, scope, projectId) }); return true;
    }
    if (url.pathname === '/api/agent/sessions' && req.method === 'POST') {
      const input = await bodyJson(req);
      const projectId = String(input.projectId || '');
      if (projectId && !await loadProject(user.id, projectId, scope)) { sendJson(res, 404, { error: '画布不存在' }); return true; }
      const session = repo.create(user.id, scope, projectId, await settings(input), { fresh: input.fresh === true });
      sendJson(res, 200, await snapshot(session)); return true;
    }
    const match = url.pathname.match(/^\/api\/agent\/sessions\/([\w-]+)(?:\/(messages|settings|interrupt|resume|approval))?$/);
    if (!match) { sendJson(res, 404, { error: '接口不存在' }); return true; }
    const session = repo.get(match[1], user.id, scope);
    if (!session) { sendJson(res, 404, { error: '对话不存在' }); return true; }
    if (!match[2] && req.method === 'GET') { sendJson(res, 200, await snapshot(session)); return true; }
    if (req.method !== 'POST') { sendJson(res, 405, { error: '请求方式不支持' }); return true; }
    const input = await bodyJson(req);
    if (match[2] === 'messages') {
      const text = String(input.text || '').trim();
      if (!text || text.length > 30000 || !/^[\w-]{8,80}$/.test(input.clientId || '')) { sendJson(res, 400, { error: '消息内容或标识无效' }); return true; }
      const selection = Array.isArray(input.selection) ? input.selection.filter(v => typeof v === 'string' && v.length <= 200).slice(0, 20) : [];
      repo.enqueue(session, { text, clientId: input.clientId, selection });
    } else if (match[2] === 'settings') repo.settings(session, await settings(input, session.settings));
    else if (match[2] === 'interrupt') { repo.control(session, 'interrupt'); runtime.interrupt(session.id); }
    else if (match[2] === 'resume') repo.control(session, 'resume');
    else if (match[2] === 'approval') {
      if (typeof input.accepted !== 'boolean') { sendJson(res, 400, { error: '请选择是否生成' }); return true; }
      repo.approve(session, String(input.approvalId || ''), input.accepted);
    } else { sendJson(res, 404, { error: '接口不存在' }); return true; }
    if (!['settings', 'interrupt'].includes(match[2])) runtime.kick(session.id);
    sendJson(res, 202, await snapshot(repo.get(session.id, user.id, scope))); return true;
  };
}
