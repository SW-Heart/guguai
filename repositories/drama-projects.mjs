export function createDramaProjectRepository({ sql, keysetPage, scopeWhere, parseDoc }) {
  if (typeof sql !== 'function' || typeof keysetPage !== 'function' || typeof scopeWhere !== 'function' || typeof parseDoc !== 'function') {
    throw new TypeError('项目仓储依赖未完整提供');
  }

  function saveDramaProjectRecord(userId, project, { expectedRevision = null, insertOnly = false } = {}) {
    if (expectedRevision !== null) {
      if (!Number.isSafeInteger(Number(expectedRevision))) return { ...project, saved: false };
      const result = sql(`
        UPDATE drama_projects
        SET title = :title, step = :step, status = :status, revision = :revision,
            updated_at = :updatedAt, doc_json = :docJson
        WHERE id = :id AND user_id = :userId AND revision = :expectedRevision`).run({
        id: project.id,
        userId,
        title: project.title ?? null,
        step: project.step ?? null,
        status: project.status ?? null,
        revision: project.revision,
        expectedRevision: Number(expectedRevision),
        updatedAt: project.updatedAt,
        docJson: JSON.stringify(project),
      });
      return { ...project, saved: result.changes > 0 };
    }

    if (insertOnly) {
      sql(`
        INSERT INTO drama_projects(id, user_id, title, step, status, revision, created_at, updated_at, doc_json)
        VALUES(:id, :userId, :title, :step, :status, :revision, :createdAt, :updatedAt, :docJson)`).run({
        id: project.id,
        userId,
        title: project.title ?? null,
        step: project.step ?? null,
        status: project.status ?? null,
        revision: Math.max(1, Number(project.revision) || 1),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        docJson: JSON.stringify(project),
      });
      return { ...project, saved: true };
    }

    sql(`
      INSERT INTO drama_projects(id, user_id, title, step, status, revision, created_at, updated_at, doc_json)
      VALUES(:id, :userId, :title, :step, :status, :revision, :createdAt, :updatedAt, :docJson)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, step = excluded.step, status = excluded.status,
        revision = excluded.revision, updated_at = excluded.updated_at, doc_json = excluded.doc_json`).run({
      id: project.id,
      userId,
      title: project.title ?? null,
      step: project.step ?? null,
      status: project.status ?? null,
      revision: Math.max(1, Number(project.revision) || 1),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      docJson: JSON.stringify(project),
    });
    return project;
  }

  function findDramaProject(userId, id, scope = {}) {
    const scoped = scopeWhere(scope);
    return parseDoc(sql(`SELECT doc_json FROM drama_projects WHERE id = :id AND user_id = :userId ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}`)
      .get({ id, userId, ...scoped.params }));
  }

  function deleteDramaProject(userId, id, scope = {}) {
    const scoped = scopeWhere(scope);
    return sql(`DELETE FROM drama_projects WHERE id = :id AND user_id = :userId ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}`)
      .run({ id, userId, ...scoped.params }).changes > 0;
  }

  function listDramaProjects(userId, { deviceId = '', workspaceId = '', limit = 100, cursor = null } = {}) {
    const scoped = scopeWhere({ deviceId, workspaceId });
    return keysetPage({
      table: 'drama_projects', timeColumn: 'updated_at', scope: 'drama',
      userId, extraWhere: scoped.where, extraParams: scoped.params, limit, cursor,
    });
  }

  function latestDramaProject(userId, scope = {}) {
    const scoped = scopeWhere(scope);
    return parseDoc(sql(`
      SELECT doc_json FROM drama_projects
      WHERE user_id = :userId ${scoped.where.length ? `AND ${scoped.where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id ASC
      LIMIT 1`).get({ userId, ...scoped.params }));
  }

  return Object.freeze({ saveDramaProjectRecord, findDramaProject, deleteDramaProject, listDramaProjects, latestDramaProject });
}
