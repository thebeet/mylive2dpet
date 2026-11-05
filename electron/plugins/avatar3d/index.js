const fs = require("node:fs");
const { Parser } = require("mmd-parser");
const { normalizeOptions } = require("./options");
const { activateAvatar } = require("../avatarShared");
const { modelUrl, resolveAsset } = require("../avatarShared/options");
const { readGeneratedMotions } = require("./motions");

// Semantic expressions used by conversation; the model's raw vertex morphs remain available in the menu.
const FURINA_EXPRESSIONS = {
  neutral: {}, smile: { "にこり": 0.6, "口角上げ": 0.6 },
  smile_closed: { "笑い": 0.8, "口角上げ": 0.6 },
  sad: { "悲しむ": 0.7, "困る": 0.5, "口角下げ": 0.5 },
  angry: { "怒り": 0.8, "怒り目": 0.5 },
  surprised: { "びっくり": 0.8, "お": 0.4 },
  shy: { "恥ずかしい": 0.6, "口角上げ": 0.3 },
  thinking: { "じと目": 0.4, "真面目": 0.3 },
  worry: { "困る": 0.7, "口角下げ": 0.3 },
};
function readCatalog(filename) {
  const buffer = fs.readFileSync(filename);
  const data = new Parser().parsePmx(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), true);
  const morphs = data.morphs.filter(m => m.type === 1).map(m => m.name);
  const expressionMorphs = Object.fromEntries(Object.entries(FURINA_EXPRESSIONS)
    .filter(([, weights]) => Object.keys(weights).every(name => morphs.includes(name))));
  for (const name of morphs) if (!Object.hasOwn(expressionMorphs, name)) expressionMorphs[name] = { [name]: 1 };
  return { expressionMorphs, expressions: Object.keys(expressionMorphs),
    motions: [{ id: "idle", label: "待机" }, { id: "wave", label: "招手" }] };
}
function activate(context) {
  const options = normalizeOptions(context.config.getPluginOptions("avatar-3d"));
  const catalog = readCatalog(resolveAsset(context.paths.projectRoot, options.modelPath));
  catalog.motions = readGeneratedMotions(context.paths.projectRoot, options.modelPath) || catalog.motions;
  return activateAvatar(context, { renderer: "mmd", controls: ["resetRotation"], ...options, ...catalog,
    modelUrl: modelUrl(options.modelPath),
    iconPath: options.iconPath ? resolveAsset(context.paths.projectRoot, options.iconPath) : "",
  });
}
module.exports = { activate, readCatalog };
