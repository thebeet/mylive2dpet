const path = require("path");
const { getPlugin } = require("../registry");
const { createDatabase } = require("./database");

function activate(context) {
  const options = getPlugin(context.config.get(), "storage-sqlite") || {};
  const configuredPath = String(options.path || "pet.sqlite3");
  const filePath = path.isAbsolute(configuredPath) ? configuredPath
    : path.resolve(context.paths.getUserData(), configuredPath);
  const rawTimeout = Number(options.busyTimeoutMs);
  const database = createDatabase(filePath, {
    busyTimeoutMs: Number.isFinite(rawTimeout) ? Math.max(0, Math.min(60000, Math.floor(rawTimeout))) : 5000,
  });
  let unregister;
  try { unregister = context.services.register("database", database.api, { allowWhileStopped: true }); }
  catch (error) { database.close(); throw error; }
  context.logger.info("database opened:", filePath);
  return {
    start() {},
    // Keep the connection available until dependent plugins finish disposing.
    stop() {},
    dispose() { unregister(); database.close(); },
  };
}

module.exports = { activate };
