const path = require("node:path");
const { createHash } = require("node:crypto");

const MAX_LINE_BYTES = 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");

// Use one record family only: event_msg can repeat the same response_item message.
// Modern desktop records explicitly identify user.text; older CLI records need wrapper filtering.
function userText(record) {
  const message = record?.payload;
  if (record?.type !== "response_item" || message?.type !== "message" || message.role !== "user") return null;
  const kinds = message.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts.filter((part, index) => part?.type === "input_text" && typeof part.text === "string" &&
    (!Array.isArray(kinds) || kinds[index] === "user.text")).map(part => part.text).join("\n").trim();
  if (!text || (!Array.isArray(kinds) &&
      /^(?:<environment_context>|<turn_aborted>|<permissions instructions>|<subagent_notification>|<INSTRUCTIONS>|# AGENTS\.md instructions\b)/i.test(text))) return null;
  return text;
}

async function sessionFiles(fs, directory, depth = 0) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && depth < 3) files.push(...await sessionFiles(fs, target, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
  }
  return files.sort();
}

async function readMetadata(handle, size) {
  const chunks = [];
  let position = 0, complete = false;
  while (position < Math.min(size, MAX_LINE_BYTES)) {
    const buffer = Buffer.alloc(Math.min(65536, size - position, MAX_LINE_BYTES - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    chunks.push(buffer.subarray(0, end < 0 ? bytesRead : end));
    if (end >= 0) { complete = true; break; }
    position += bytesRead;
  }
  if (!complete) return null;
  let record;
  try { record = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
  if (record.type !== "session_meta") return null;
  const meta = record.payload || {};
  return { sessionId: meta.id || meta.session_id || "", cwd: typeof meta.cwd === "string" ? meta.cwd : "",
    // Agent sessions can inherit the user's prompt and must not generate duplicate observations.
    subagent: (meta.source && typeof meta.source === "object" && "subagent" in meta.source) ||
      meta.thread_source === "subagent" };
}

function projectMatches(cwd, projects) {
  return !projects.length || (!!cwd && projects.some(project => {
    const relative = path.relative(project, path.resolve(cwd));
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  }));
}

module.exports = { MAX_LINE_BYTES, hash, userText, sessionFiles, readMetadata, projectMatches };
