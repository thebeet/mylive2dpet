const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { createHash } = require("node:crypto");

const hash = value => createHash("sha256").update(value).digest("hex");
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
function text(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if (value["#text"] != null) return String(value["#text"]);
  return Object.entries(value).filter(([key]) => !key.startsWith("@_")).map(([, part]) =>
    array(part).map(text).join(" ")).join(" ");
}
// Preserve mixed XHTML text order while exposing convenient RSS/Atom field lookup.
function orderedValue(nodes, attributes = {}) {
  const result = { ...attributes }, parts = [];
  for (const node of nodes) {
    for (const [name, children] of Object.entries(node)) {
      if (name === ":@" || name.startsWith("?")) continue;
      if (name === "#text") { parts.push(String(children)); continue; }
      const value = orderedValue(children, node[":@"]);
      if (result[name] === undefined) result[name] = value;
      else result[name] = [...array(result[name]), value];
      if (!["script", "style"].includes(name.toLowerCase())) parts.push(text(value));
    }
  }
  result["#text"] = parts.join(" ");
  return Object.keys(result).length === 1 ? result["#text"] : result;
}
function plain(value) {
  return text(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function linkUrl(value, base) {
  if (!value) return "";
  try { const url = new URL(value, base); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; }
  catch { return ""; }
}

function parseFeed(xml, baseUrl) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("RSS 不支持 DTD 或自定义实体");
  // Some GitLab Atom feeds embed HTML void tags without XML self-closing syntax.
  // Keep normal XML parsing first so explicitly paired XHTML tags still work.
  const compatibility = XMLValidator.validate(xml) === true ? {} : { unpairedTags: ["br", "hr", "img", "wbr"] };
  if (XMLValidator.validate(xml, compatibility) !== true) throw new Error("RSS XML 格式无效");
  const doc = orderedValue(new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, preserveOrder: true,
    parseTagValue: false, parseAttributeValue: false, htmlEntities: true, ...compatibility }).parse(xml));
  const atom = doc.feed;
  const root = atom || doc.rss?.channel || doc.RDF?.channel;
  if (!root || typeof root !== "object") throw new Error("不是支持的 RSS／Atom 订阅源");
  const entries = array(atom ? atom.entry : doc.RDF ? doc.RDF.item : root.item);
  const unique = new Set();
  const items = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const alternate = array(entry.link).find(link => typeof link !== "object" ||
      !link["@_rel"] || link["@_rel"] === "alternate");
    const link = linkUrl(typeof alternate === "object" ? alternate["@_href"] || text(alternate) : alternate, baseUrl);
    const title = plain(entry.title);
    const published = text(entry.published || entry.pubDate || entry.date).trim();
    const updated = text(entry.updated).trim();
    const content = plain(entry.encoded || entry.content || entry.description || entry.summary);
    const author = plain(entry.author?.name || entry.author || entry.creator);
    const identity = text(entry.id || entry.guid).trim() || link ||
      (title || published ? `${title}\n${published}` : "");
    if (!identity) continue;
    const id = hash(identity);
    if (unique.has(id)) continue;
    unique.add(id);
    const item = { id, title, link, published, updated, author, content };
    items.push({ ...item, fingerprint: hash(JSON.stringify(item)) });
  }
  return { title: plain(root.title), items };
}

module.exports = { parseFeed, hash };
