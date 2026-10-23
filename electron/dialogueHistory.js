const fs = require("fs");
const path = require("path");

const HISTORY_PATH = path.join(__dirname, "../logs/dialogue-history.jsonl");

function append(entry) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.appendFileSync(
      HISTORY_PATH,
      `${JSON.stringify({
        t: Number(entry.t) || Date.now(),
        petSaid: String(entry.petSaid || "").trim(),
        expression: String(entry.expression || "neutral"),
        screenSummary: String(entry.screenSummary || "").trim(),
        trigger: String(entry.trigger || ""),
      })}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn(
      "[dialogue-history] append failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Return the newest entries first. Invalid lines are ignored. */
function list(limit = 500) {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const max = Math.max(1, Math.floor(Number(limit) || 500));
    const lines = fs.readFileSync(HISTORY_PATH, "utf8").split(/\r?\n/);
    const entries = [];

    for (let i = lines.length - 1; i >= 0 && entries.length < max; i--) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry && typeof entry.petSaid === "string" && entry.petSaid.trim()) {
          entries.push(entry);
        }
      } catch {
        // Ignore malformed lines so one damaged entry does not hide history.
      }
    }
    return entries;
  } catch (error) {
    console.warn(
      "[dialogue-history] read failed:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

module.exports = { append, list };
