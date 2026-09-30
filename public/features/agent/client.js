export function createCreativeAgentClient({ api, projectId, agentProjectId = '', initialSessionId = '', initialSkill = '', onState, onError, onHistory = () => {} }) {
  let sessionId = '', stopped = false, timer, state, pendingSend, config, epoch = 0, sequence = 0, accepted = 0;
  const current = token => !stopped && token === epoch;
  function accept(value, token, request) {
    if (current(token) && request >= accepted) { accepted = request; state = value; onState(value, config); }
    return value;
  }
  function schedule(token) {
    clearTimeout(timer);
    if (current(token)) timer = setTimeout(() => poll(token), ['running','queued','waiting_job'].includes(state?.state) ? 500 : 1200);
  }
  async function poll(token) {
    if (!current(token) || !sessionId) return;
    const request = ++sequence;
    try { accept(await api(`/api/agent/sessions/${sessionId}`), token, request); }
    catch (error) { if (current(token)) onError(error); }
    finally { schedule(token); }
  }
  async function history() {
    const token = epoch;
    const result = await api(`/api/agent/sessions?${agentProjectId?`agentProjectId=${encodeURIComponent(agentProjectId)}`:`projectId=${encodeURIComponent(projectId)}`}`);
    if (current(token)) onHistory(result.sessions);
    return result.sessions;
  }
  async function open(id = '', fresh = false, ready = Promise.resolve()) {
    const token = ++epoch, request = ++sequence;
    clearTimeout(timer);
    let session;
    try {
      [session] = await Promise.all([
        api(id ? `/api/agent/sessions/${id}` : '/api/agent/sessions', id ? undefined : { method:'POST', body:JSON.stringify({projectId,...(agentProjectId?{agentProjectId}:{}), fresh, ...(!fresh&&initialSkill?{skill:initialSkill}:{}), ...(fresh&&agentProjectId&&sessionId?{previousSessionId:sessionId}:{})}) }),
        ready,
      ]);
    } catch (error) {
      // A failed navigation leaves the previous conversation open and live.
      if (current(token) && sessionId) schedule(token);
      throw error;
    }
    if (!current(token)) return;
    // A new session in the same project can reuse the already loaded workspace.
    if (session.workspaceUnchanged) {
      session = {...state, ...session};
      delete session.workspaceUnchanged;
    }
    sessionId = session.id; pendingSend = null;
    accept(session, token, request); schedule(token);
    void history().catch(error => { if (current(token)) onError(error); });
  }
  async function start() {
    if (stopped) return;
    // Fetch configuration and saved content together, but publish only when
    // both are available so a partial response cannot reveal an empty canvas.
    const ready = api('/api/agent/config').then(value=>{if(!stopped)config=value;});
    try{await open(initialSessionId,false,ready);}
    catch(error){await ready;if(!stopped&&initialSessionId&&error.status===404)await open();else throw error;}
  }
  async function action(name, body = {}) {
    if (!sessionId) throw new Error('对话正在连接，请稍后重试');
    const token = epoch, request = ++sequence;
    const result = accept(await api(`/api/agent/sessions/${sessionId}/${name}`, { method:'POST', body:JSON.stringify(body) }), token, request);
    return result;
  }
  return {
    start, history, open: id => open(id), newConversation: () => open('', true),
    async send(text, selection = [], documents = []) {
      const next={text,selection,documents};
      if (!pendingSend || JSON.stringify({text:pendingSend.text,selection:pendingSend.selection,documents:pendingSend.documents||[]}) !== JSON.stringify(next)) pendingSend = { clientId:crypto.randomUUID(), ...next };
      const result = await action('messages', pendingSend); pendingSend = null;
      void history().catch(() => {}); return result;
    },
    settings: value => action('settings', value), interrupt: () => action('interrupt'), resume: () => action('resume'),
    approve: (approvalId, accepted) => action('approval', { approvalId, accepted }),
    dispose() { stopped = true; epoch++; clearTimeout(timer); },
  };
}
