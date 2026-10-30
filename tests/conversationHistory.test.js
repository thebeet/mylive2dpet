const test = require("node:test");
const assert = require("node:assert/strict");
const { createConversation } = require("../electron/conversation");
const { createContextProviders } = require("../electron/architecture/contextProviders");
const { MessageBus } = require("../electron/architecture/messageBus");
const { normalizeConfig } = require("../electron/config");
const EVENTS = require("../electron/architecture/events");
const { petPayload } = require("./helpers/petPayload");

const quiet = { info() {}, warn() {}, error() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (content, usage) => {
  try { const parsed = JSON.parse(content); if (Object.hasOwn(parsed, "response")) content = JSON.stringify(petPayload(parsed)); } catch {}
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage }) };
};
const observation = (text, images = 0) => ({ source: "manual-input", role: "user", capturedAt: "2026-10-30T01:00:00Z",
  content: [{ type: "text", text }, ...Array.from({ length: images }, (_, i) => ({ type: "image", path: `/shot-${text}-${i}.jpg` }))] });
const isSummary = (body) => body.messages[0].content.includes("你负责压缩桌宠的一段会话");

function harness(t, { history = {}, fetchImpl, ...dependencies } = {}) {
  const calls = [], encoded = [];
  const conversation = createConversation({
    getConfig: () => ({ conversation: { ai: { endpoint: "https://test.invalid/v1", model: "test", apiKey: "test" }, history } }),
    logger: quiet, writeLog() {}, configureProxy: async () => {},
    encodeImage: (path) => { encoded.push(path); return `encoded-${path}`; },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (fetchImpl) return fetchImpl(body, init);
      if (isSummary(body)) return response('{"summary":"用户正在实现桌宠，下一步验证缓存。"}');
      const hasImages = body.messages.at(-1).content.some(({ type }) => type === "image_url");
      return response(JSON.stringify(petPayload({ response: `reply-${calls.length}`,
        screenSummary: hasImages ? "桌面有项目代码" : "", workSummary: hasImages ? "正在修改桌宠" : "" })));
    }, ...dependencies,
  });
  t.after(() => conversation.dispose());
  return { conversation, calls, encoded };
}

test("all current images are sent; stable text history grows without resending old image bytes", async (t) => {
  const { conversation, calls, encoded } = harness(t);
  const context = [{ id: "memory:fact", title: "长期记忆", text: "用户喜欢简洁回复" }];
  await conversation.decideFromObservations([observation("first", 6)], { context });
  await conversation.decideFromObservations([observation("second", 2)], { context });
  await conversation.decideFromObservations([observation("third")], { context });
  assert.equal(calls[0].messages.at(-1).content.filter(({ type }) => type === "image_url").length, 6);
  assert.equal(calls[1].messages.at(-1).content.filter(({ type }) => type === "image_url").length, 2);
  assert.equal(encoded.length, 8);
  assert.ok(!JSON.stringify(calls[1].messages.slice(0, -1)).includes("encoded-"));
  assert.ok(!JSON.stringify(calls[2]).includes("encoded-"));
  assert.match(JSON.stringify(calls[1].messages.slice(0, -1)), /桌面有项目代码/);
  assert.deepEqual(calls[1].messages.slice(0, -1), calls[2].messages.slice(0, calls[1].messages.length - 1));
  assert.deepEqual(calls.map(({ messages }) => messages.filter(({ role }) => role === "assistant").length), [0, 1, 2]);
  assert.ok(!calls[0].messages[1].content[0].text.includes("当前时间"));
});

test("changed retrieval blocks are not appended again within the same conversation segment", async (t) => {
  const { conversation, calls } = harness(t);
  const first = [{ id: "memory:facts", title: "长期记忆", text: "用户喜欢咖啡" }];
  const changed = [{ id: "memory:facts", title: "长期记忆", text: "用户已纠正：现在喜欢茶" }];
  await conversation.decideFromObservations([observation("first")], { context: first });
  await conversation.decideFromObservations([observation("second")], { context: changed });
  await conversation.decideFromObservations([observation("third")], { context: changed });
  assert.deepEqual(calls[0].messages[1], calls[1].messages[1]);
  assert.deepEqual(calls[0].messages[1], calls[2].messages[1]);
  assert.ok(!JSON.stringify(calls[1].messages.at(-1)).includes("现在喜欢茶"));
  assert.ok(!JSON.stringify(calls[2].messages.at(-1)).includes("现在喜欢茶"));
  assert.ok(!JSON.stringify(calls[2].messages).includes("现在喜欢茶"));
  for (const call of calls) {
    assert.equal(call.messages.filter((m) => JSON.stringify(m.content).includes("# 补充上下文")).length, 1);
    assert.ok(!JSON.stringify(call.messages.at(-1)).includes("# 补充上下文"));
  }
});

test("context is retrieved only at segment start and after a successful summary", async (t) => {
  let reads = 0;
  const contextProviders = createContextProviders({ logger: quiet });
  contextProviders.register("memory", () => [{ id: "profiles", title: "人物画像", text: `profile-version-${++reads}` }]);
  const { conversation, calls } = harness(t, { contextProviders, history: { maxTurns: 3, keepTurns: 1 } });
  for (let i = 1; i <= 3; i++) await conversation.decideFromObservations([observation(`turn-${i}`)]);
  assert.equal(reads, 1);
  await conversation.decideFromObservations([observation("turn-4")]);
  assert.equal(reads, 2);
  assert.match(JSON.stringify(calls.at(-1).messages[1]), /profile-version-2/);
  assert.ok(!JSON.stringify(calls.at(-1)).includes("profile-version-1"));
  assert.equal(calls.at(-1).messages.filter((m) => JSON.stringify(m.content).includes("# 补充上下文")).length, 1);
});

test("failed summaries do not refresh retrieval or consume the existing snapshot", async (t) => {
  let reads = 0;
  const contextProviders = createContextProviders({ logger: quiet });
  contextProviders.register("memory", () => [{ id: "profiles", title: "人物画像", text: `profile-version-${++reads}` }]);
  const { conversation, calls } = harness(t, { contextProviders, history: { maxTurns: 3, keepTurns: 1 },
    fetchImpl: async (body) => response(isSummary(body) ? 'invalid-json' : '{"response":"reply","expression":"neutral"}'),
  });
  for (let i = 1; i <= 5; i++) await conversation.decideFromObservations([observation(`turn-${i}`)]);
  assert.equal(reads, 1);
  assert.match(JSON.stringify(calls.at(-1).messages[1]), /profile-version-1/);
  assert.equal(calls.at(-1).messages.filter((m) => JSON.stringify(m.content).includes("# 补充上下文")).length, 1);
});

test("turn limit summarizes old turns, retains the latest complete turn and refreshes the segment snapshot", async (t) => {
  const { conversation, calls } = harness(t, { history: { maxTurns: 3, keepTurns: 1 } });
  for (let i = 1; i <= 4; i++) await conversation.decideFromObservations([observation(`turn-${i}`)], {
    context: [{ id: "memory:fact", title: "记忆", text: `memory-${i}` }],
  });
  assert.equal(calls.length, 5);
  const input = JSON.parse(calls[3].messages[1].content);
  assert.ok(isSummary(calls[3]));
  assert.match(JSON.stringify(input.dialogue), /turn-1/);
  assert.match(JSON.stringify(input.dialogue), /turn-2/);
  assert.ok(!JSON.stringify(input.dialogue).includes("turn-3"));
  const last = calls[4].messages;
  assert.match(JSON.stringify(last[1]), /用户正在实现桌宠/);
  assert.match(JSON.stringify(last[1]), /memory-4/);
  assert.ok(!JSON.stringify(last).includes("turn-1"));
  assert.match(JSON.stringify(last), /turn-3/);
  assert.match(JSON.stringify(last), /turn-4/);
  assert.equal(last.filter(({ role }) => role === "assistant").length, 1);
});

test("successive summaries include the previous summary instead of forgetting older context", async (t) => {
  const { conversation, calls } = harness(t, { history: { maxTurns: 3, keepTurns: 1 } });
  for (let i = 1; i <= 6; i++) await conversation.decideFromObservations([observation(`turn-${i}`)]);
  const summaries = calls.filter(isSummary);
  assert.equal(summaries.length, 2);
  assert.equal(JSON.parse(summaries[0].messages[1].content).previousSummary, "");
  assert.match(JSON.parse(summaries[1].messages[1].content).previousSummary, /用户正在实现桌宠/);
});

test("reported input usage can trigger compaction before the turn ceiling", async (t) => {
  const { conversation, calls } = harness(t, {
    history: { maxTurns: 20, keepTurns: 1, maxInputTokens: 12000, hardInputTokens: 50000 },
    fetchImpl: async (body) => isSummary(body) ? response('{"summary":"保留进度"}') :
      response('{"response":"reply","expression":"neutral"}', { prompt_tokens: 15000 }),
  });
  for (let i = 1; i <= 3; i++) await conversation.decideFromObservations([observation(`turn-${i}`)]);
  assert.equal(calls.filter(isSummary).length, 1);
  assert.equal(calls.at(-1).messages.filter(({ role }) => role === "assistant").length, 1);
});

test("invalid or oversized summaries leave history intact and are retried on the next turn", async (t) => {
  let summaries = 0;
  const { conversation, calls } = harness(t, { history: { maxTurns: 3, keepTurns: 1, summaryMaxChars: 256 },
    fetchImpl: async (body) => {
      if (isSummary(body)) return response(++summaries === 1 ? 'invalid-json' :
        summaries === 2 ? JSON.stringify({ summary: "x".repeat(257) }) : '{"summary":"保留进度"}');
      return response('{"response":"reply","expression":"neutral"}');
    },
  });
  for (let i = 1; i <= 5; i++) await conversation.decideFromObservations([observation(`turn-${i}`)]);
  const decisions = calls.filter((body) => !isSummary(body));
  assert.equal(decisions[3].messages.filter(({ role }) => role === "assistant").length, 3);
  assert.equal(decisions[4].messages.filter(({ role }) => role === "assistant").length, 4);
  await conversation.decideFromObservations([observation("turn-6")]);
  assert.equal(summaries, 3);
  assert.equal(calls.at(-1).messages.filter(({ role }) => role === "assistant").length, 1);
});

test("repeated summary failures stop history growth at the hard ceiling without sending another decision", async (t) => {
  const { conversation, calls } = harness(t, { history: { maxTurns: 3, keepTurns: 1 },
    fetchImpl: async (body) => response(isSummary(body) ? 'invalid-json' : '{"response":"reply","expression":"neutral"}'),
  });
  for (let i = 1; i <= 6; i++) await conversation.decideFromObservations([observation(`turn-${i}`)]);
  await assert.rejects(conversation.decideFromObservations([observation("turn-7")]), /硬上限/);
  assert.equal(calls.filter((body) => !isSummary(body)).length, 6);
  conversation.clearHistory();
  await conversation.decideFromObservations([observation("fresh")]);
  assert.equal(calls.at(-1).messages.filter(({ role }) => role === "assistant").length, 0);
});

test("memory clear cancels an in-flight summary and a late result cannot restore history", async (t) => {
  const bus = new MessageBus({ logger: quiet });
  let pending;
  const { conversation, calls } = harness(t, { bus, history: { maxTurns: 3, keepTurns: 1 },
    fetchImpl: async (body, init) => {
      if (isSummary(body)) return new Promise((resolve) => { pending = { init, resolve }; });
      return response('{"response":"reply","expression":"neutral"}');
    },
  });
  for (let i = 1; i <= 3; i++) await conversation.decideFromObservations([observation(`turn-${i}`)]);
  const failed = assert.rejects(conversation.decideFromObservations([observation("turn-4")]), /记忆已清空/);
  await settle();
  assert.ok(pending);
  await bus.notify(EVENTS.MEMORY_CLEARED, {});
  await failed;
  assert.equal(pending.init.signal.aborted, true);
  pending.resolve(response('{"summary":"迟到的旧背景"}'));
  await settle();
  await conversation.decideFromObservations([observation("fresh")]);
  assert.ok(!JSON.stringify(calls.at(-1)).includes("迟到的旧背景"));
  assert.ok(!JSON.stringify(calls.at(-1)).includes("turn-1"));
});

test("concurrent decisions are serialized and each sees the preceding successful reply", async (t) => {
  let release;
  const { conversation, calls } = harness(t, { fetchImpl: (body) => {
    if (calls.length === 1) return new Promise((resolve) => { release = resolve; });
    return response('{"response":"second reply","expression":"neutral"}');
  } });
  const first = conversation.decideFromObservations([observation("first")]);
  const second = conversation.decideFromObservations([observation("second")]);
  await settle();
  assert.equal(calls.length, 1);
  release(response('{"response":"first reply","expression":"neutral"}'));
  await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[1].messages.slice(1, -1)), /first reply/);
});

test("context providers are not asked to duplicate the core multi-turn history", async (t) => {
  let input;
  const contextProviders = createContextProviders({ logger: quiet });
  contextProviders.register("memory", (request) => { input = request; return []; });
  const { conversation } = harness(t, { contextProviders });
  await conversation.decideFromObservations([observation("test")]);
  assert.equal(input.conversationHistory, true);
});

test("history budgets validate configuration and provide immutable defaults for existing configs", () => {
  const defaults = normalizeConfig({}).conversation.history;
  assert.equal(defaults.maxTurns, 32);
  assert.equal(defaults.keepTurns, 4);
  assert.equal(defaults.maxInputTokens, 50000);
  assert.equal(defaults.hardInputTokens, 100000);
  assert.ok(Object.isFrozen(defaults));
  for (const history of [[], { maxTurns: 1 }, { maxTurns: 3, keepTurns: 3 },
    { hardInputTokens: 50000 }, { summaryMaxTokens: 0 }, { maxInputTokens: "invalid" }]) {
    assert.throws(() => normalizeConfig({ conversation: { history } }));
  }
});
