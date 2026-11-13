const { readPluginOptions } = require("../registry");
const { number, validateOptions } = require("../../architecture/configValidation");

function normalizeOptions(plugin = {}) {
  validateOptions(plugin, { objects: ["changeDetect"], toggles: ["changeDetect"] });
  if (plugin.deviceId != null && typeof plugin.deviceId !== "string") throw new Error("camera.deviceId 必须是字符串");
  if (plugin.devicePath != null && (typeof plugin.devicePath !== "string" || (plugin.devicePath && !/^\/dev\/video\d+$/.test(plugin.devicePath)))) throw new Error("camera.devicePath 必须是 /dev/videoN 设备路径");
  if (plugin.label != null && (typeof plugin.label !== "string" || !plugin.label.trim() || plugin.label.length > 100)) throw new Error("camera.label 必须是非空字符串且不超过 100 字符");
  if (plugin.devicePath && plugin.deviceId) throw new Error("camera.devicePath 与 deviceId 不能同时指定");
  return {
    enabled: plugin.enabled !== false,
    deviceId: plugin.deviceId || "",
    devicePath: plugin.devicePath || "",
    label: plugin.label?.trim() || "摄像头画面",
    interval_ms: number(plugin.interval_ms, 5000, 0, 86400000, "camera.interval_ms"),
    observationTtlMs: number(plugin.observationTtlMs, 60000, 1000, 86400000, "camera.observationTtlMs"),
    width: number(plugin.width, 640, 160, 1920, "camera.width"),
    height: number(plugin.height, 480, 120, 1080, "camera.height"),
    maxPendingObservations: number(plugin.maxPendingObservations, 6, 1, 32, "camera.maxPendingObservations"),
    changeDetect: {
      enabled: plugin.changeDetect?.enabled !== false,
      hashSize: number(plugin.changeDetect?.hashSize, 8, 1, 64, "camera.changeDetect.hashSize"),
      threshold: number(plugin.changeDetect?.threshold, 4, 0, 4096, "camera.changeDetect.threshold"),
    },
  };
}

const getOptions = config => readPluginOptions(config, "camera-perception", normalizeOptions);
module.exports = { normalizeOptions, getOptions };
