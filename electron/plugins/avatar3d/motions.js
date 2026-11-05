const fs = require("node:fs");
const path = require("node:path");
const { modelUrl, resolveAsset } = require("../avatarShared/options");

function readGeneratedMotions(projectRoot, modelPath) {
  const directory = path.posix.join(path.posix.dirname(modelPath), "motions");
  const catalogPath = `${directory}/catalog.json`;
  if (!fs.existsSync(path.resolve(projectRoot, catalogPath))) return null;
  const catalog = JSON.parse(fs.readFileSync(resolveAsset(projectRoot, catalogPath), "utf8"));
  if (catalog.version !== 1 || !Array.isArray(catalog.models) || !Array.isArray(catalog.motions)) {
    throw new Error("3D 动作目录格式无效");
  }
  if (!catalog.models.includes(path.posix.basename(modelPath))) return null;
  const ids = new Set();
  const motions = catalog.motions.map(motion => {
    if (!motion || typeof motion.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(motion.id) || ids.has(motion.id) ||
        typeof motion.label !== "string" || !motion.label.trim() ||
        typeof motion.file !== "string" || !/^[a-z][a-z0-9_]*\.motion\.json$/.test(motion.file) ||
        typeof motion.loop !== "boolean") throw new Error("3D 动作目录包含无效条目");
    ids.add(motion.id);
    resolveAsset(projectRoot, `${directory}/${motion.file}`);
    return { id: motion.id, label: motion.label, loop: motion.loop, url: modelUrl(`${directory}/${motion.file}`) };
  });
  if (!motions.some(motion => motion.id === "idle" && motion.loop)) throw new Error("3D 动作目录缺少循环待机动作");
  return motions;
}

module.exports = { readGeneratedMotions };
