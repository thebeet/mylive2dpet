const fs = require("node:fs");
const path = require("node:path");
const { normalizeOptions } = require("./options");
const { activateAvatar } = require("../avatarShared");
const { modelUrl, resolveAsset } = require("../avatarShared/options");

function readCatalog(filename) {
  const references = JSON.parse(fs.readFileSync(filename, "utf8")).FileReferences || {};
  const expressions = (references.Expressions || []).map(item => item.Name)
    .filter(name => typeof name === "string" && name && !name.startsWith("_"));
  const motions = Object.entries(references.Motions || {}).flatMap(([group, items]) =>
    group.startsWith("_") ? [] : items.flatMap((item, index) =>
      path.basename(item.File || "").startsWith("_") ? [] : [{
        id: `${group}:${index}`, group, index,
        label: `${group} / ${path.basename(item.File || String(index), ".motion3.json")}`,
      }]));
  return { expressions, motions };
}
function activate(context) {
  const options = normalizeOptions(context.config.getPluginOptions("avatar-live2d"));
  const catalog = readCatalog(resolveAsset(context.paths.projectRoot, options.modelPath));
  if (!catalog.expressions.includes(options.defaultExpression)) throw new Error("默认表情不在 Live2D 模型中");
  for (const key of ["idleMotion", "clickMotion"]) {
    const item = options[key];
    if (item && !catalog.motions.some(m => m.group === item.group && m.index === item.index)) {
      throw new Error(`${key} 不在 Live2D 模型中`);
    }
  }
  return activateAvatar(context, { renderer: "live2d", ...options, ...catalog,
    modelUrl: modelUrl(options.modelPath),
    iconPath: options.iconPath ? resolveAsset(context.paths.projectRoot, options.iconPath) : "",
  });
}
module.exports = { activate, readCatalog };
