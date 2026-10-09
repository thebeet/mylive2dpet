const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "../../..");

/**
 * 相对项目根目录解析路径；已是绝对路径则原样返回。
 * @param {string} [p]
 * @returns {string}
 */
function resolveProjectPath(p) {
  if (!p) return "";
  const s = String(p).trim();
  if (!s) return "";
  if (path.isAbsolute(s)) return path.normalize(s);
  return path.resolve(PROJECT_ROOT, s);
}

module.exports = { PROJECT_ROOT, resolveProjectPath };
