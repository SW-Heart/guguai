export function createRecordIndexes({ getFiles, getTasks, getHistory = () => ({}) } = {}) {
  let indexedFiles = null;
  let filesById = new Map();
  let indexedTasks = null;
  let tasksById = new Map();
  let tasksByAssetId = new Map();

  function ensureFiles() {
    const files = getFiles();
    if (indexedFiles === files) return;
    indexedFiles = files;
    filesById = new Map(files.map(file => [file.id, file]));
  }
  function ensureTasks() {
    const tasks = getTasks();
    if (indexedTasks === tasks) return;
    indexedTasks = tasks;
    tasksById = new Map();
    tasksByAssetId = new Map();
    tasks.forEach(task => {
      tasksById.set(task.id, task);
      if (task.assetId && !tasksByAssetId.has(task.assetId)) tasksByAssetId.set(task.assetId, task);
    });
  }
  function fileById(id) {
    ensureFiles();
    return filesById.get(id);
  }
  function taskById(id) {
    ensureTasks();
    return tasksById.get(id)
      || Object.values(getHistory() || {}).flatMap(entry => entry?.items || []).find(item => item.id === id)
      || null;
  }
  function taskForAsset(file) {
    ensureTasks();
    return taskById(file?.sourceGenerationId)
      || tasksByAssetId.get(file?.id)
      || Object.values(getHistory() || {}).flatMap(entry => entry?.items || []).find(item => item.assetId === file?.id)
      || null;
  }
  return {
    fileById,
    taskById,
    taskForAsset,
    invalidateFiles: () => { indexedFiles = null; },
    invalidateTasks: () => { indexedTasks = null; },
    invalidateAll: () => { indexedFiles = null; indexedTasks = null; },
  };
}
