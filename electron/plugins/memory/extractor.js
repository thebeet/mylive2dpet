/** Parse candidate facts from older portrait-extraction providers. */
/**
 * @param {string} raw
 * @returns {{ type: string, text: string, tags: string[], importance: number }[]}
 */
function parseFactsJson(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("事实提取返回空内容");

  let jsonText = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) jsonText = fenced[1].trim();

  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start >= 0 && end > start) {
    jsonText = jsonText.slice(start, end + 1);
  }

  let arr;
  try {
    arr = JSON.parse(jsonText);
  } catch {
    throw new Error("事实提取返回无效 JSON");
  }
  if (!Array.isArray(arr)) throw new Error("事实提取必须返回 JSON 数组");

  /** @type {{ type: string, text: string, tags: string[], importance: number }[]} */
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const factText = String(item.text || "").trim();
    if (!factText || factText.length < 4) continue;
    const type = ["fact", "preference", "event"].includes(item.type)
      ? item.type
      : "fact";
    const tags = Array.isArray(item.tags)
      ? item.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
      : [];
    let importance = Number(item.importance);
    if (!Number.isFinite(importance)) importance = 2;
    importance = Math.min(5, Math.max(1, Math.round(importance)));
    out.push({ type, text: factText, tags, importance });
  }
  return out.slice(0, 5);
}

module.exports = { parseFactsJson };
