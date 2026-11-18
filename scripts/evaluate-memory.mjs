// Synthetic, isolated evaluation. Reads model credentials without logging them or opening user data.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { createAdaptiveMemoryStore } = require("../electron/plugins/storageSqlite/repositories/adaptiveMemory");
const { planMemory } = require("../electron/plugins/memory/planner");
const { retrieve } = require("../electron/plugins/memory/retrieval");
const { createModelClient } = require("../electron/llm/client");

if (!process.argv.includes("--live")) {
  console.log("Run npm run evaluate:memory -- --live to evaluate synthetic scenarios using conversation.ai. Real memory is never opened.");
  process.exit(0);
}
const config = JSON.parse(fs.readFileSync(path.resolve("config.json"), "utf8"));
const ai = config.conversation?.ai;
if (!ai?.endpoint || !ai?.model || !ai?.apiKey) throw new Error("Configure conversation.ai before running live evaluation.");
let agent;
if (ai.proxy) { const { HttpsProxyAgent } = require("https-proxy-agent"); agent = new HttpsProxyAgent(ai.proxy); }
function transport(url, init) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url), client = parsed.protocol === "https:" ? https : http;
    const req = client.request(parsed, { method: init.method, headers: init.headers, signal: init.signal, agent }, res => {
      const chunks = []; res.on("data", b => chunks.push(b)); res.on("error", reject);
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => Buffer.concat(chunks).toString("utf8") }));
    }); req.on("error", reject); req.end(init.body);
  });
}
const client = createModelClient({ getOptions: () => ai, fetchImpl: transport, configureProxy: async () => {}, writeLog() {},
  logger: { info() {}, warn() {} } });
const evaluationTime = Date.parse("2026-11-17T12:00:00+08:00");
function library() {
  const sql = new DatabaseSync(":memory:"); sql.exec("CREATE TABLE migrations(namespace TEXT PRIMARY KEY, version INTEGER)");
  let next = 0;
  const db = { prepare: s => sql.prepare(s), exec: s => sql.exec(s), transaction(fn) {
    const name = `eval_${++next}`; sql.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); sql.exec(`RELEASE ${name}`); return result; }
    catch (error) { sql.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }, migrate(namespace, migrations) { db.transaction(() => { const version = db.prepare("SELECT version FROM migrations WHERE namespace=?").get(namespace)?.version || 0;
    for (let i = version; i < migrations.length; i++) migrations[i](db);
    db.prepare("INSERT OR REPLACE INTO migrations VALUES (?,?)").run(namespace, migrations.length); }); } };
  return { repo: createAdaptiveMemoryStore(db, { now: () => evaluationTime }), close: () => sql.close() };
}
const report = { model: ai.model, evaluatedAt: new Date().toISOString(), synthetic: true, embedding: false,
  note: "This score measures the listed synthetic extraction/recall checks, not overall product quality or longitudinal user satisfaction.", scenarios: [] };
const allChecks = [];
async function run(name, batches, checks) {
  const lib = library();
  try {
    const plans = [];
    for (const [batchIndex, sources] of batches.entries()) {
      for (const [i, source] of sources.entries()) lib.repo.ingest({ id: `${name}:${batchIndex}:${i}`, source: source.role === "user" ? "manual-input" : "screen-summary",
        role: source.role, text: source.text, capturedAt: evaluationTime + batchIndex * 1000 });
      const snapshot = lib.repo.snapshot();
      const plan = await planMemory({ snapshot, topics: [...new Set(lib.repo.list().flatMap(e => e.topics))], now: evaluationTime,
        callChat: client.generateText, maxTokens: 8192 });
      lib.repo.apply(plan, snapshot); plans.push(plan);
    }
    const entries = lib.repo.list(), body = entries.map(e => e.text).join("\n");
    const results = checks.map(([label, check]) => ({ label, passed: Boolean(check({ entries, body, repo: lib.repo, plans })) }));
    allChecks.push(...results); report.scenarios.push({ name, checks: results, entries });
    console.log(`${name}: ${results.filter(r => r.passed).length}/${results.length}`);
  } catch (error) {
    // A failed request/invalid plan is a failed scenario, not silently skipped.
    const results = checks.map(([label]) => ({ label, passed: false })); allChecks.push(...results);
    report.scenarios.push({ name, checks: results, error: error.message.replace(/API \d+:[\s\S]*/, "Model request failed") });
    console.log(`${name}: failed`);
  } finally { lib.close(); }
}
const user = text => ({ role: "user", text });
const observed = text => ({ role: "context", text });
const recall = (repo, query, pattern) => retrieve(repo.candidates(query), query, { now: evaluationTime }).some(r => pattern.test(r.entry.text));
await run("drama", [[user("我在追《迷雾》，刚看完第5集。不要告诉我后面的情节。"), user("我喜欢里面的林队长，因为他做事谨慎。"), observed("电视剧角色的台词是：我是警察，今年三十岁。")]], [
  ["remembers viewing progress", ({ body }) => /第\s*5\s*集|第五集/.test(body)],
  ["remembers spoiler boundary", ({ body }) => /剧透|(?:不要|不能|避免|禁止).{0,8}(?:透露|告诉).{0,30}(?:之后|后面|后续|未看|剧情|情节)/.test(body)],
  ["remembers character preference", ({ body }) => /林队长/.test(body) && /谨慎/.test(body)],
  ["does not attribute fictional identity to user", ({ entries }) => !entries.some(e => e.basis === "user" && /用户.{0,8}(警察|三十岁)/.test(e.text))],
  ["paraphrased viewing question recalls progress", ({ repo }) => recall(repo, "那部剧我看到哪了", /第\s*5\s*集|第五集/)],
]);
await run("gaming", [[user("我最近常玩星露谷，和朋友小林联机。昨晚我们终于修好了温室，我高兴得睡不着。")]], [
  ["remembers game", ({ body }) => /星露谷/.test(body)],
  ["remembers gaming companion", ({ body }) => /小林/.test(body)],
  ["remembers shared milestone", ({ body }) => /温室/.test(body) && /修好|修复|完成/.test(body)],
  ["does not require a software project template", ({ entries }) => entries.some(e => e.topics.length && !e.topics.every(t => /软件项目|人物画像/.test(t)))],
  ["natural recall finds shared experience", ({ repo }) => recall(repo, "联机时让我们开心的事", /温室/)],
]);
await run("learning", [[user("我在准备下个月的英语考试。背单词时先听例句再写下来，对我很有用。")]], [
  ["remembers learning goal", ({ body }) => /英语/.test(body) && /考试/.test(body)],
  ["remembers effective method", ({ body }) => /例句/.test(body) && /写/.test(body)],
  ["recalls method using different wording", ({ repo }) => recall(repo, "怎样记词汇更适合我", /例句/)],
]);
await run("daily-companionship", [[user("团子是我养的猫，周六要去复诊。平时聊天我更喜欢你简短回应，不要每次都连续问我很多问题。")]], [
  ["remembers pet", ({ body }) => /团子/.test(body) && /猫/.test(body)],
  ["remembers upcoming event", ({ body }) => /周六/.test(body) && /复诊/.test(body)],
  ["remembers communication preference", ({ body }) => /简短/.test(body)],
  ["appropriate background can be pinned", ({ entries }) => entries.some(e => e.pinned && /简短|问题/.test(e.text))],
]);
await run("changing-progress", [[user("我追《迷雾》，看到了第5集。")], [user("更新一下，我已经看到第8集了；刚才的第5集是旧进度。")]], [
  ["new progress becomes current", ({ body }) => /第\s*8\s*集|第八集/.test(body)],
  ["preserves version history", ({ repo, entries }) => entries.some(e => repo.history(e.id).length > 1)],
  ["does not retain conflicting current progress", ({ entries }) => !entries.some(e => /第\s*5\s*集|第五集/.test(e.text) && !/旧|之前|曾|原|历史/.test(e.text))],
]);
await run("passive-observation", [[observed("屏幕正在播放《城市医院》，角色说：我是医生，我最喜欢手术。我只是从截图里看到这些台词，无法确定查看者身份或偏好。")]], [
  ["does not create confirmed user identity from screen", ({ entries }) => !entries.some(e => e.basis === "user")],
  ["does not infer favorite show from one frame", ({ entries }) => !entries.some(e => /用户.{0,10}(最喜欢|喜欢).{0,10}城市医院/.test(e.text))],
]);
await run("forgetting", [[user("我在玩星露谷，联机朋友叫小林。")], [user("请忘记我们之前提到的小林，以及一起联机的那段记录。")]], [
  ["removes requested memory", ({ body }) => !/小林/.test(body)],
  ["clears source-backed searchable copy", ({ repo }) => repo.candidates("小林").length === 0],
]);
report.passed = allChecks.filter(c => c.passed).length; report.total = allChecks.length;
report.score = Math.round(report.passed / report.total * 100);
const reportArg = process.argv.indexOf("--report");
const output = path.resolve(reportArg >= 0 ? process.argv[reportArg + 1] : "docs/memory-evaluation.json");
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Synthetic checks: ${report.passed}/${report.total} (${report.score}/100). Report: ${output}`);
if (report.score < 90) process.exitCode = 1;
