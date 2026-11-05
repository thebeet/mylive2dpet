const { assetPath, finite } = require("../avatarShared/options");
function normalizeOptions(plugin = {}) {
  if (plugin.physicsEnabled != null && typeof plugin.physicsEnabled !== "boolean") {
    throw new Error("plugins.avatar-3d.physicsEnabled 必须是布尔值");
  }
  return {
    enabled: plugin.enabled !== false,
    physicsEnabled: plugin.physicsEnabled !== false,
    modelPath: assetPath(plugin.modelPath, "assets/【芙宁娜】/【芙宁娜】.pmx", "modelPath", ".pmx"),
    iconPath: plugin.iconPath ? assetPath(plugin.iconPath, "", "iconPath") : "",
    scale: finite(plugin.scale, 1, 0.1, 5, "scale"),
    verticalOffset: finite(plugin.verticalOffset, 0, -2000, 2000, "verticalOffset"),
    rotationY: finite(plugin.rotationY, 0, -180, 180, "rotationY"),
  };
}
module.exports = { normalizeOptions };
