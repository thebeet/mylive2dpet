const path = require("node:path");

function assetPath(value, fallback, name, extension) {
  const result = value ?? fallback;
  if (typeof result !== "string" || !result.startsWith("assets/") || result.includes("\\") ||
      result.split("/").some(part => !part || part === "." || part === "..") ||
      (extension && !result.toLowerCase().endsWith(extension))) {
    throw new Error(`${name} 必须是 assets/ 下的相对路径${extension ? `（${extension}）` : ""}`);
  }
  return result;
}
function finite(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${name} 超出允许范围`);
  }
  return result;
}
function text(value, fallback, name) {
  const result = value ?? fallback;
  if (typeof result !== "string" || !result.trim()) throw new Error(`${name} 必须是非空字符串`);
  return result;
}
function modelUrl(modelPath) {
  return `./${modelPath.split("/").map(encodeURIComponent).join("/")}`;
}
function resolveAsset(projectRoot, relative) {
  const root = path.resolve(projectRoot, "assets");
  const resolved = require("node:fs").realpathSync(path.resolve(projectRoot, relative));
  if (!resolved.startsWith(root + path.sep)) throw new Error("形象资源必须位于 assets/ 内");
  return resolved;
}
module.exports = { assetPath, finite, text, modelUrl, resolveAsset };
