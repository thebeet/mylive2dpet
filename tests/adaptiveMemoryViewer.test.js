const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, seed } = require("./helpers/adaptiveMemory");
test("viewer uses dynamic topics, pagination and validated IPC senders", t => {
  const h = harness(t); for (let i = 0; i < 4; i++) seed(h.repo, `看剧记录 ${i}`, { topics: [i % 2 ? "我的片单" : "最近在看"] });
  h.menu()[0].click(); const win = h.windows.windows[0], event = { sender: win.webContents };
  const snapshot = h.handlers.get("snapshot")(event, { topic: "我的片单", limit: 1 });
  assert.equal(snapshot.store.total, 2); assert.equal(snapshot.store.entries.length, 1); assert.equal(snapshot.viewTab, "memories");
  assert.deepEqual(snapshot.store.topics, ["我的片单", "最近在看"]);
  assert.throws(() => h.handlers.get("snapshot")({ sender: {} }), /来源无效/);
  assert.throws(() => h.handlers.get("snapshot")(event, { query: [] }), /筛选无效/);
  assert.throws(() => h.handlers.get("read-memory")({ sender: {} }, snapshot.store.entries[0].id), /来源无效/);
});
test("viewer corrections preserve versions and confirmed forgetting clears evidence", async t => {
  const h = harness(t, { dialog: async () => ({ response: 1 }) }), e = seed(h.repo, "看到第五集", { topics: ["追剧"] });
  h.menu()[0].click(); const event = { sender: h.windows.windows[0].webContents };
  h.handlers.get("correct-memory")(event, { id: e.id, text: "看到第六集", pinned: true });
  const full = h.handlers.get("read-memory")(event, e.id); assert.equal(full.basis, "user"); assert.equal(full.history.length, 2); assert.equal(full.pinned, true);
  await h.handlers.get("forget-memory")(event, e.id); assert.equal(h.repo.list().length, 0); assert.equal(h.repo.events({ limit: 10 }).filter(s => !s.forgotten).length, 0);
});
test("cancelled or obsolete delete confirmations preserve memory", async t => {
  let resolve; const h = harness(t, { dialog: () => new Promise(done => { resolve = done; }) }), e = seed(h.repo, "重要回忆");
  h.menu()[0].click(); const event = { sender: h.windows.windows[0].webContents };
  const pending = h.handlers.get("forget-memory")(event, e.id); h.plugin.correct(e.id, "修正后的重要回忆"); resolve({ response: 1 });
  await assert.rejects(pending, /已更新/); assert.equal(h.repo.list().length, 1);
});
test("stop closes viewer, removes IPC on disposal and rejects late readiness", async t => {
  const h = harness(t); h.menu()[0].click(); const win = h.windows.windows[0]; await h.plugin.stop(); win.emit("ready-to-show");
  assert.ok(win.destroyed); assert.equal(win.shows, 0); assert.throws(() => h.handlers.get("snapshot")({ sender: win.webContents }), /已关闭/);
  h.plugin.start(); h.menu()[0].click(); assert.equal(h.windows.windows.length, 2); await h.plugin.dispose(); assert.equal(h.handlers.size, 0);
});
