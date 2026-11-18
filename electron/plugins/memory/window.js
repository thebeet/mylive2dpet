const api = window.petMemory;
const $ = id => document.getElementById(id);
let active = "memories", offset = 0, total = 0, serial = 0, timer;
const tabs = ["memories", "recent", "timeline", "questions"];
const stamp = value => new Date(value).toLocaleString("zh-CN");
function node(tag, text, className) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; }
function error(err) { $("error").hidden = false; $("error").textContent = err.message || String(err); }
function button(label, action, className) {
  const b = node("button", label, className); b.type = "button";
  b.addEventListener("click", async () => { b.disabled = true; try { await action(); } catch (err) { error(err); } finally { b.disabled = false; } }); return b;
}
function empty(container, message) { container.replaceChildren(node("p", message, "muted")); }
function selectTab(tab) {
  if (tab === "question-history") tab = "questions";
  if (!tabs.includes(tab)) tab = "memories";
  active = tab;
  tabs.forEach(t => { $(`${t}-tab`).setAttribute("aria-selected", String(t === tab)); $(`${t}-tab`).tabIndex = t === tab ? 0 : -1; $(`${t}-panel`).hidden = t !== tab; });
}
tabs.forEach((t, i) => {
  $(`${t}-tab`).addEventListener("click", () => selectTab(t));
  $(`${t}-tab`).addEventListener("keydown", event => {
    let next = i;
    if (event.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (i + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault(); selectTab(tabs[next]); $(`${tabs[next]}-tab`).focus();
  });
});
function editor(article, entry) {
  const form = node("form"), textarea = node("textarea"); textarea.value = entry.text; textarea.maxLength = 4000; textarea.setAttribute("aria-label", "修正记忆内容");
  const label = node("label", " 经常需要记住"), pinned = node("input"); pinned.type = "checkbox"; pinned.checked = entry.pinned; label.prepend(pinned);
  const actions = node("div", null, "row"), save = node("button", "保存修正"); save.type = "submit";
  actions.append(save, button("取消", () => form.remove())); form.append(textarea, label, actions); article.append(form); textarea.focus();
  form.addEventListener("submit", async event => { event.preventDefault(); save.disabled = true; try { await api.correctMemory(entry.id, textarea.value, pinned.checked); await refresh(); } catch (err) { error(err); save.disabled = false; } });
}
function memory(entry) {
  const article = node("article"), title = node("h2", entry.title), chips = node("div", null, "chips");
  entry.topics.forEach(topic => { const b = button(topic, () => { $("topic").value = topic; offset = 0; return refresh(); }, "chip"); chips.append(b); });
  const basis = { user: "用户陈述", observation: "观察记录", inference: "尚待确认" }[entry.basis] || "来源记录";
  const historical = entry.status !== "active" || entry.expiresAt != null && entry.expiresAt <= Date.now();
  article.append(title, chips, node("p", `${basis} · ${stamp(entry.observedAt)}${entry.pinned ? " · 经常需要记住" : ""}${historical ? " · 历史状态" : ""}`, "muted"), node("div", entry.text, "text"));
  const actions = node("div", null, "row actions");
  actions.append(button("修正", () => { if (!article.querySelector("form")) editor(article, entry); }), button("忘记", async () => { await api.forgetMemory(entry.id); await refresh(); }, "danger")); article.append(actions);
  const details = node("details"), summary = node("summary", "查看来源与变化"), content = node("div"); details.append(summary, content); article.append(details);
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    loaded = true; content.textContent = "正在读取…";
    try {
      const full = await api.readMemory(entry.id); content.replaceChildren();
      for (const s of full.sources) { const block = node("div", null, "source"); block.append(node("p", `${s.role === "user" ? "直接表达" : "观察／旧记录"} · ${stamp(s.capturedAt)}`, "muted"), node("div", s.text, "text")); content.append(block); }
      if (entry.aliases.length) content.append(node("p", `别称与相关表达：${entry.aliases.join("、")}`, "muted"));
      if (entry.links.length) content.append(node("p", `关联：${entry.links.map(l => l.relation).join("、")}`, "muted"));
      for (const h of full.history) { const block = node("details"), header = node("summary", `${stamp(h.changedAt)} · ${h.reason}`); block.append(header); if (h.before) block.append(node("div", h.before.text, "text")); content.append(block); }
    } catch (err) { loaded = false; content.textContent = err.message || "读取失败"; }
  });
  return article;
}
async function refresh(initial = false) {
  const request = ++serial; $("error").hidden = true;
  try {
    const snapshot = await api.getSnapshot({ query: $("search").value, topic: $("topic").value, includeArchived: $("archived").checked, offset, limit: 50 });
    if (request !== serial) return;
    if (initial) selectTab(snapshot.viewTab);
    const store = snapshot.store, topic = $("topic").value;
    $("topic").replaceChildren(new Option("全部主题", ""), ...store.topics.map(t => new Option(t, t))); $("topic").value = topic;
    total = store.total || 0;
    $("status").textContent = `${store.entries ? store.entries.length : 0} 条显示 · ${store.pending || 0} 条待整理${snapshot.maintaining || snapshot.organizing ? " · 正在整理" : ""}${store.enabled ? "" : " · 持久记忆已关闭"}`;
    if (store.error || snapshot.lastError) error(new Error(store.error || snapshot.lastError));
    $("memory-info").textContent = "主题会随着交流逐渐形成。你可以修正内容、调整常用背景，或让桌宠忘记。";
    $("memories").replaceChildren(...store.entries.map(memory)); if (!store.entries.length) empty($("memories"), "还没有符合条件的记忆。");
    $("page").textContent = total ? `${offset + 1}–${Math.min(offset + 50, total)} / ${total}` : "0 条";
    $("prev").disabled = offset === 0; $("next").disabled = offset + 50 >= total;
    $("recent").replaceChildren(...snapshot.shortTerm.turns.slice().reverse().map(t => { const a = node("article"); a.append(node("p", stamp(t.t), "muted")); if (t.userMessage) a.append(node("div", `你：${t.userMessage}`, "text")); if (t.reply) a.append(node("div", `桌宠：${t.reply}`, "text")); for (const s of Object.values(t.summaries || {})) if (s) a.append(node("p", s, "muted")); return a; }));
    if (!snapshot.shortTerm.turns.length) empty($("recent"), "本次启动还没有交流记录。");
    $("timeline").replaceChildren(...store.events.map(s => { const a = node("article"); a.append(node("p", `${stamp(s.capturedAt)} · ${s.role === "user" ? "直接表达" : "活动观察"}${s.processed ? "" : " · 待整理"}`, "muted"), node("div", s.text, "text")); return a; }));
    if (!store.events.length) empty($("timeline"), "还没有保存的来源。");
    $("questions").replaceChildren(...store.questions.map(q => {
      const a = node("article"); a.append(node("h2", q.prompt), node("p", `${q.topic || q.scope || ""} · ${{ pending: "待提问", answered: "已回答", dismissed: "已停止询问" }[q.status] || q.status}`, "muted"), node("p", q.reason, "muted"));
      for (const answer of q.answers || []) { const row = node("div", null, "row"); row.append(node("p", `${stamp(answer.createdAt)} · ${answer.value || answer.outcome}`, "muted"), button("删除记录", async () => { await api.deleteAnswer(q.id, answer.id); await refresh(); })); a.append(row); }
      a.append(button("删除提问", async () => { await api.deleteQuestion(q.id); await refresh(); })); return a;
    }));
    if (!store.questions.length) empty($("questions"), "没有提问记录。");
  } catch (err) { if (request === serial) error(err); }
}
$("refresh").addEventListener("click", () => void refresh());
$("search").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; void refresh(); }, 200); });
for (const id of ["topic", "archived"]) $(id).addEventListener("change", () => { offset = 0; void refresh(); });
$("prev").addEventListener("click", () => { offset = Math.max(0, offset - 50); void refresh(); });
$("next").addEventListener("click", () => { if (offset + 50 < total) { offset += 50; void refresh(); } });
const unsubscribe = api.onSelectTab?.(selectTab); window.addEventListener("beforeunload", () => { clearTimeout(timer); unsubscribe?.(); });
void refresh(true);
