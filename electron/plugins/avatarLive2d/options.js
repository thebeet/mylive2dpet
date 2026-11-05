const { assetPath, finite, text } = require("../avatarShared/options");
function motion(value, fallback, name) {
  if (value === null) return null;
  const item = value ?? fallback;
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${name} 必须是动作对象或 null`);
  const index = finite(item.index, 0, 0, 10000, `${name}.index`);
  if (!Number.isInteger(index)) throw new Error(`${name}.index 必须是整数`);
  return { group: text(item.group, undefined, `${name}.group`), index };
}
function normalizeOptions(plugin = {}) {
  return {
    enabled: plugin.enabled !== false,
    modelPath: assetPath(plugin.modelPath, "assets/Setsuna_v081l_b/setsuna_psd2live_v001.model3.json", "modelPath", ".model3.json"),
    iconPath: plugin.iconPath === "" ? "" : assetPath(plugin.iconPath, "assets/Setsuna_v081l_b/icon.png", "iconPath"),
    scale: finite(plugin.scale, 1.5, 0.1, 5, "scale"),
    verticalOffset: finite(plugin.verticalOffset, 50, -2000, 2000, "verticalOffset"),
    defaultExpression: text(plugin.defaultExpression, "neutral", "defaultExpression"),
    idleMotion: motion(plugin.idleMotion, { group: "Thinking", index: 0 }, "idleMotion"),
    clickMotion: motion(plugin.clickMotion, { group: "ReachStudy", index: 0 }, "clickMotion"),
  };
}
module.exports = { normalizeOptions };
