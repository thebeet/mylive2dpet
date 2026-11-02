const fs = require("node:fs");
const path = require("node:path");
const EVENTS = require("../../architecture/events");

function legacyFiles(directory, pattern) {
  try {
    if (!fs.lstatSync(directory).isDirectory()) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => path.join(directory, entry.name));
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** Stage only files produced by the old logger/capture code; restore them if Storage deletion fails. */
function stageLegacyFiles(projectRoot) {
  if (!projectRoot) return { logs: 0, screenshots: 0, commit() {}, rollback() {} };
  const directory = path.join(projectRoot, "logs");
  try {
    if (!fs.lstatSync(directory).isDirectory()) return { logs: 0, screenshots: 0, commit() {}, rollback() {} };
  } catch (error) {
    if (error.code === "ENOENT") return { logs: 0, screenshots: 0, commit() {}, rollback() {} };
    throw error;
  }
  const logs = legacyFiles(directory, /^openai\.jsonl(?:\.\d+)?$/);
  const screenshots = legacyFiles(path.join(directory, "screenshots"), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?\.jpg$/i);
  const targets = [...logs, ...screenshots];
  if (!targets.length) return { logs: 0, screenshots: 0, commit() {}, rollback() {} };
  const stage = fs.mkdtempSync(path.join(directory, ".raw-log-clear-"));
  const moved = [];
  const rollback = () => {
    for (const file of moved.reverse()) if (fs.existsSync(file.staged)) fs.renameSync(file.staged, file.original);
    if (fs.existsSync(stage)) fs.rmdirSync(stage);
  };
  try {
    for (const [index, original] of targets.entries()) {
      const staged = path.join(stage, String(index));
      fs.renameSync(original, staged);
      moved.push({ original, staged });
    }
  } catch (error) { rollback(); throw error; }
  return { logs: logs.length, screenshots: screenshots.length, rollback,
    commit: () => fs.rmSync(stage, { recursive: true }) };
}

async function clearRawLog(context, repository, storage) {
  const legacy = stageLegacyFiles(context.paths?.projectRoot);
  let result;
  try { result = repository.clear(); }
  catch (error) { legacy.rollback(); throw error; }
  const warnings = [];
  let legacyDeleted = true;
  try { legacy.commit(); }
  catch (error) {
    legacyDeleted = false;
    warnings.push(`部分旧文件未能删除：${error.message}`);
    try { legacy.rollback(); }
    catch (restoreError) { warnings.push(`旧文件恢复失败：${restoreError.message}`); }
  }
  await context.bus.notify(EVENTS.RAW_LOG_CLEARED, result);
  try {
    await context.perception?.discard(observation => observation.content.some(part => {
      const id = /^storage:\/\/screenshots\/([^/?#]+)$/.exec(part.uri || "")?.[1];
      return id && !storage.blobs("screenshots").getMetadata(decodeURIComponent(id));
    }), "raw-log-cleared");
  } catch (error) { warnings.push(`待处理截图未能全部清理：${error.message}`); }
  let compacted = false;
  try { compacted = storage.compact().supported; }
  catch (error) { warnings.push(`日志已清理，但数据库压缩失败：${error.message}`); }
  return { ...result, legacyLogs: legacyDeleted ? legacy.logs : 0,
    legacyScreenshots: legacyDeleted ? legacy.screenshots : 0, compacted, warnings };
}

module.exports = { clearRawLog, stageLegacyFiles };
