const path = require("node:path");

/** Session index is optional; title lookup must never prevent prompt ingress. */
function createSessionTitleReader(fs, sessionsDir, logger) {
  const indexPath = path.join(path.dirname(sessionsDir), "session_index.jsonl");
  let stamp = null, titles = new Map();
  return async function readTitles() {
    let handle;
    try {
      handle = await fs.open(indexPath, "r");
      const stat = await handle.stat();
      const nextStamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (stamp === nextStamp) return titles;
      const nextTitles = new Map();
      const content = await handle.readFile("utf8");
      // Do not cache an unfinished final record as a valid title.
      const lines = content.slice(0, content.lastIndexOf("\n") + 1).split("\n");
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (typeof entry?.id !== "string" || typeof entry.thread_name !== "string") continue;
        // The append-only index can contain renames; its last complete entry wins.
        nextTitles.set(entry.id, entry.thread_name.trim());
      }
      titles = nextTitles;
      stamp = nextStamp;
      return titles;
    } catch (error) {
      titles = new Map();
      stamp = null;
      if (error.code !== "ENOENT") logger?.warn(`Codex 会话标题读取失败: ${error.message}`);
      return titles;
    } finally { await handle?.close(); }
  };
}

module.exports = { createSessionTitleReader };
