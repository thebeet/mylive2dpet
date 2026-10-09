const fs = require("fs");
const path = require("path");

const MODEL3_PATH = path.join(
  __dirname,
  "../assets/Setsuna_v081l_b/setsuna_psd2live_v001.model3.json",
);

/**
 * 从 model3.json 读取表情名。
 * @param {{ includeInternal?: boolean }} [opts]
 */
function loadExpressionNames(opts = {}) {
  const includeInternal = opts.includeInternal === true;
  const raw = fs.readFileSync(MODEL3_PATH, "utf8");
  const model = JSON.parse(raw);
  const list = model?.FileReferences?.Expressions || [];
  const names = list
    .map((e) => e?.Name)
    .filter((n) => typeof n === "string" && n.length > 0);

  if (includeInternal) return names;
  // 给模型选用的「对外」表情：去掉 _ 开头的内部/桥接表情
  return names.filter((n) => !n.startsWith("_"));
}

module.exports = { MODEL3_PATH, loadExpressionNames };
