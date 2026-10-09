const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "../config.json");

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

module.exports = { CONFIG_PATH, loadConfig };
