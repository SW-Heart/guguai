// One recent-first list over both kinds of creative projects. Canvas projects
// (agent projects, plus older short dramas that were built on the canvas) and
// short-drama workbenches keep their own storage; this only merges summaries.
export const PROJECT_TYPES = Object.freeze({ CANVAS:'canvas', DRAMA:'drama' });

const time = value => {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export function projectSummaries({ canvasProjects = [], dramaProjects = [], limit = Infinity } = {}) {
  const canvas = canvasProjects.map(item => ({
    id:String(item.id), type:PROJECT_TYPES.CANVAS, source:'canvas',
    title:String(item.title || '新项目'), updatedAt:time(item.updatedAt || item.createdAt),
  }));
  const drama = dramaProjects.map(item => {
    const legacyCanvas = item.mode === 'smart';
    return {
      id:String(item.id), type:legacyCanvas ? PROJECT_TYPES.CANVAS : PROJECT_TYPES.DRAMA, source:'drama',
      title:String(item.title || (legacyCanvas ? '未命名项目' : '未命名短剧')), updatedAt:time(item.updatedAt || item.createdAt),
    };
  });
  return [...canvas, ...drama]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function createProjectListRouteHandler({ sendJson, requireUser, requireDesktopWorkspaceScope, listCanvasProjects, listDramaProjects }) {
  return async function projectListRoute(req, res, url) {
    if (url.pathname !== '/api/projects') return false;
    if (req.method !== 'GET') { sendJson(res, 405, { error:'不支持的请求' }); return true; }
    const user = await requireUser(req, res); if (!user) return true;
    const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
    const raw = url.searchParams.get('limit');
    const limit = raw === null || raw === '' ? Infinity : Number(raw);
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1 || limit > 200)) { sendJson(res, 400, { error:'limit 必须是 1 到 200 之间的整数' }); return true; }
    const dramaProjects = listDramaProjects(user.id, { deviceId:scope.deviceId, workspaceId:scope.workspaceId, limit:200 }).items;
    const canvasProjects = listCanvasProjects(user.id, scope);
    sendJson(res, 200, { projects:projectSummaries({ canvasProjects, dramaProjects, limit }) });
    return true;
  };
}
