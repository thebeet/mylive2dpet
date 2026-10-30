const test = require("node:test");
const assert = require("node:assert/strict");
const { createConversation } = require("../electron/conversation");
const { extractChatPayload } = require("../electron/conversation/parseChatText");
const { createResponseFormat } = require("../electron/conversation/output");
const { buildSystemPrompt } = require("../electron/conversation/prompt");
const { normalizeConfig } = require("../electron/config");
const { petPayload } = require("./helpers/petPayload");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { registerDecisionModule } = require("../electron/modules/decision");
const EVENTS = require("../electron/architecture/events");
const quiet = { info() {}, warn() {}, error() {} };
const input = [{ source: "manual-input", role: "user", content: [{ type: "text", text: "hello" }] }];
const ok = (content, { finish_reason = "stop", refusal } = {}) => ({ ok: true, status: 200,
  text: async () => JSON.stringify({ choices: [{ finish_reason, message: { content, ...(refusal ? { refusal } : {}) } }] }) });
const failure = (status, message) => ({ ok: false, status, text: async () => JSON.stringify({ error: { message } }) });

function harness(t, fetch, outputFormat = "auto") {
  const calls = [];
  const conversation = createConversation({
    getConfig: () => ({ conversation: { ai: { endpoint: "https://test.invalid/v1", model: "test", apiKey: "test", outputFormat } } }),
    getExpressions: () => ["neutral", "smile"], logger: quiet, configureProxy: async () => {}, writeLog() {},
    retryWait: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return fetch(body, calls.length);
    },
  });
  t.after(() => conversation.dispose());
  return { conversation, calls };
}

test("strict parser accepts the six-field JSON contract without coercing types", () => {
  const payload = petPayload({ expression: "smile", response: "你好" });
  assert.deepEqual(extractChatPayload(JSON.stringify(payload), ["neutral", "smile"]), payload);
  assert.deepEqual(extractChatPayload(JSON.stringify(petPayload({ shouldSpeak: false, response: "" }))),
    petPayload({ shouldSpeak: false, response: "" }));
});

test("strict parser rejects missing fields, wrong types, extra keys and unknown/case-mismatched expressions", () => {
  for (const key of Object.keys(petPayload())) {
    const missing = petPayload(); delete missing[key];
    assert.throws(() => extractChatPayload(JSON.stringify(missing)), /缺少字段/);
    for (const value of [null, [], {}, 1, key === "shouldSpeak" ? "false" : false]) {
      assert.throws(() => extractChatPayload(JSON.stringify(petPayload({ [key]: value }))), /必须是/);
    }
  }
  for (const payload of [petPayload({ reply: "legacy" }), petPayload({ extra: "unexpected" }),
    petPayload({ expression: "SMILE" }), petPayload({ expression: "unknown" })]) {
    assert.throws(() => extractChatPayload(JSON.stringify(payload), ["neutral", "smile"]), /未约定字段|表情列表/);
  }
});

test("strict parser rejects plain text, fences, trailing prose, arrays and incomplete JSON", () => {
  const json = JSON.stringify(petPayload());
  for (const text of ["", "neutral\nhello", "hello", `\`\`\`json\n${json}\n\`\`\``,
    `结果：${json}`, `${json}\n以上是回复`, `${json}${json}`, json.slice(0, -1), "[]", "null", '"reply"']) {
    assert.throws(() => extractChatPayload(text), (error) => error.code === "AI_INVALID_OUTPUT");
  }
});

test("business validation rejects silent user replies and summaries invented without the corresponding observation", () => {
  for (const [payload, context] of [
    [petPayload({ response: "  " }), {}],
    [petPayload({ shouldSpeak: false }), {}],
    [petPayload({ shouldSpeak: false, response: " " }), {}],
    [petPayload({ shouldSpeak: false, response: "" }), { hasUserInput: true }],
    [petPayload({ screenSummary: "invented screen" }), { hasImages: false }],
    [petPayload({ workSummary: "invented task" }), { hasImages: false }],
    [petPayload({ audioSummary: "invented speech" }), { hasAudio: false }],
  ]) assert.throws(() => extractChatPayload(JSON.stringify(payload), ["neutral"], context),
    (error) => error.code === "AI_INVALID_OUTPUT");
});

test("request schema requires all six fields and uses the same expression enum as the prompt", async (t) => {
  const { conversation, calls } = harness(t, () => ok(JSON.stringify(petPayload())));
  await conversation.decideFromObservations(input);
  const format = calls[0].response_format;
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
  assert.equal(format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(format.json_schema.schema.required, Object.keys(petPayload()));
  assert.deepEqual(format.json_schema.schema.properties.expression.enum, ["neutral", "smile"]);
  assert.match(calls[0].messages[0].content, /六个字段必须全部提供/);
  const defaults = createResponseFormat("json_schema").json_schema.schema.properties.expression.enum;
  assert.deepEqual(defaults, ["neutral", "smile", "thinking"]);
  assert.ok(buildSystemPrompt().includes(defaults.join(", ")));
});

test("invalid JSON is retried without becoming a reply or a history message", async (t) => {
  const { conversation, calls } = harness(t, (_body, count) => ok(count <= 2 ?
    (count === 1 ? "unstructured text" : JSON.stringify({ response: "incomplete" })) : JSON.stringify(petPayload({ response: "accepted" }))));
  assert.equal((await conversation.decideFromObservations(input)).reply, "accepted");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].messages, calls[1].messages);
  assert.deepEqual(calls[1].messages, calls[2].messages);
  await conversation.decideFromObservations(input);
  const history = calls.at(-1).messages.slice(1, -1);
  assert.ok(!JSON.stringify(history).includes("unstructured text"));
  assert.ok(!JSON.stringify(history).includes("incomplete"));
  assert.match(JSON.stringify(history), /accepted/);
});

test("exhausted validation failures never emit completion/output or enter memory and are not requeued for another retry cycle", async (t) => {
  const { conversation, calls } = harness(t, () => ok("bad reply"));
  const bus = new MessageBus({ logger: quiet });
  const perception = createPerceptionService(bus);
  let completed = 0, presented = 0, error;
  bus.subscribe(EVENTS.DECISION_COMPLETED, () => { completed++; });
  bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => { error = event; });
  t.after(registerDecisionModule(bus, { perception,
    decide: (observations) => conversation.decideFromObservations(observations),
    presentDecision: async () => { presented++; },
  }));
  await perception.submit(input[0]);
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(calls.length, 4);
  assert.equal(completed, 0);
  assert.equal(presented, 0);
  assert.equal(error.error.code, "AI_INVALID_OUTPUT");
  assert.equal(error.retried, 0);
  assert.equal(error.rejected, 1);
});

test("refusals and output truncation are rejected immediately even when the text looks like valid JSON", async (t) => {
  for (const [details, code] of [[{ refusal: "refused" }, "AI_REFUSAL"],
    [{ finish_reason: "content_filter" }, "AI_REFUSAL"], [{ finish_reason: "length" }, "AI_OUTPUT_TRUNCATED"]]) {
    const { conversation, calls } = harness(t, () => ok(JSON.stringify(petPayload()), details));
    await assert.rejects(conversation.decideFromObservations(input), (error) => error.code === code && !error.retryable);
    assert.equal(calls.length, 1);
  }
});

test("auto negotiates unsupported generation formats once while keeping strict local validation", async (t) => {
  const { conversation, calls } = harness(t, (body) => body.response_format ?
    failure(400, `${body.response_format.type} response_format is not supported`) : ok(JSON.stringify(petPayload())));
  await conversation.decideFromObservations(input);
  assert.deepEqual(calls.map((body) => body.response_format?.type), ["json_schema", "json_object", undefined]);
  await conversation.decideFromObservations(input);
  assert.equal(calls.at(-1).response_format, undefined);
});

test("fallback never accepts plain text and never hides authentication or invalid-schema failures", async (t) => {
  const unsupported = harness(t, (body) => body.response_format ?
    failure(400, "response_format is not supported") : ok("plain text"));
  await assert.rejects(unsupported.conversation.decideFromObservations(input), /JSON 不符合约定/);
  for (const [status, message] of [[401, "authentication failed"], [400, "Invalid schema for response_format"]]) {
    const { conversation, calls } = harness(t, () => failure(status, message));
    await assert.rejects(conversation.decideFromObservations(input), /API/);
    assert.equal(calls.length, 1);
  }
});

test("explicit output formats do not negotiate and configuration rejects unknown modes", async (t) => {
  for (const mode of ["json_schema", "json_object", "prompt"]) {
    const { conversation, calls } = harness(t, () => ok(JSON.stringify(petPayload())), mode);
    await conversation.decideFromObservations(input);
    assert.equal(calls[0].response_format?.type, mode === "prompt" ? undefined : mode);
  }
  const { conversation, calls } = harness(t, () => failure(400, "json_schema response_format not supported"), "json_schema");
  await assert.rejects(conversation.decideFromObservations(input), /not supported/);
  assert.equal(calls.length, 1);
  assert.equal(normalizeConfig({}).conversation.ai.outputFormat, "auto");
  assert.throws(() => normalizeConfig({ conversation: { ai: { outputFormat: "unknown" } } }), /outputFormat/);
});
