const element = (id) => document.getElementById(id);
const refresh = element("refresh");
const error = element("error");
const sourceLabel = (source) => ({ screen: "画面", audio: "设备音频", work: "工作观察", "audio-output": "会议／播放转写", user: "用户输入", "user-answer": "用户回答", "user-correction": "用户修正" }[source] || source);
const fieldLabel = (field) => ({ identity: "身份", organization_role: "组织角色", project_role: "项目角色", responsibility: "负责工作", team: "所属团队", collaboration: "协作关系", task: "当前事项", preference: "偏好", communication: "沟通方式" }[field] || field);
const basisLabel = (basis) => ({ user_answer: "用户回答", inference: "暂时猜测", observation: "观察记录" }[basis] || basis);
const typeLabel = (type) => ({ fact: "事实", preference: "偏好", habit: "习惯", event: "事件", user: "用户信息", world: "环境信息" }[type] || type);
const time = (stamp) => new Date(stamp).toLocaleString("zh-CN");
const tabs = [...document.querySelectorAll('[role="tab"]')];
let historyItems = [];
let requestedTab = null;

function selectTab(selected) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    element(tab.getAttribute("aria-controls")).hidden = !active;
  }
  window.scrollTo(0, 0);
}
window.petMemory.onSelectTab((tab) => {
  const selected = element(`${tab}-tab`);
  if (selected) { requestedTab = tab; selectTab(selected); void load(); }
});

function renderQuestionHistory() {
  const search = element("history-search").value.trim().toLowerCase();
  const status = element("history-status").value;
  const filtered = historyItems.filter((q) => (status === "all" || q.status === status) &&
    `${q.prompt} ${q.subject.name} ${q.scope} ${q.records.map((r) => r.value).join(" ")}`.toLowerCase().includes(search));
  element("question-history-info").textContent = `共 ${historyItems.length} 个问过的问题 · 当前显示 ${filtered.length} 个 · 重启后保留`;
  const list = element("question-history"); list.replaceChildren();
  if (!filtered.length) addText(list, "p", "muted", historyItems.length ? "没有匹配的提问记录。" : "还没有问过的问题。选择题弹出后会记录在这里。");
  const actionLabel = { shown: "桌宠提问", answer: "你的回答", unknown: "不清楚", skip: "跳过", defer: "稍后再问" };
  const statusLabel = { answered: "已回答", pending: "待继续询问", dismissed: "已停止询问" };
  for (const q of filtered) {
    const card = addText(list, "article", "", "");
    addText(card, "div", "text", q.prompt);
    addText(card, "div", "muted", `${q.subject.name}${q.scope ? ` · ${q.scope}` : ""} · ${statusLabel[q.status] || q.status}`);
    if (q.reason) addText(card, "div", "muted", q.reason);
    addText(card, "div", "muted", `选项：${q.options.map((o) => o.label).join("／")}`);
    if (q.lastShownAt != null && !q.records.some((r) => r.action === "shown")) addText(card, "div", "muted", `${time(q.lastShownAt)} · 桌宠提问`);
    for (const record of q.records) addText(card, "div", record.action === "answer" ? "text" : "muted", `${time(record.createdAt)} · ${actionLabel[record.action] || record.action}${record.value ? `：${record.value}` : ""}`);
    if (q.status === "pending" && q.nextAt > Date.now()) addText(card, "div", "muted", `延后至 ${time(q.nextAt)}`);
  }
}
element("history-search").addEventListener("input", renderQuestionHistory);
element("history-status").addEventListener("change", renderQuestionHistory);

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    const target = { ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (target == null) return;
    event.preventDefault();
    selectTab(tabs[target]);
    tabs[target].focus();
  });
}

function addText(parent, tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  parent.appendChild(node);
  return node;
}

function render(snapshot) {
  if (snapshot.viewTab && snapshot.viewTab !== requestedTab) {
    requestedTab = snapshot.viewTab;
    const selected = element(`${requestedTab}-tab`);
    if (selected) selectTab(selected);
  }
  element("status").textContent = `${snapshot.enabled ? "记忆已启用" : "记忆已关闭"} · 本次运行 ${snapshot.totalTurns} 轮对话 · ${snapshot.clearing ? "正在清空" : snapshot.maintaining ? "正在整理记忆" : "整理空闲"} · ${time(Date.now())}`;
  const { shortTerm, summary, longTerm } = snapshot;
  element("recent-info").textContent = `${shortTerm.enabled ? "参与对话" : "对话注入已关闭"} · 当前 ${shortTerm.turns.length} / ${shortTerm.maxTurns} 轮 · 保留 ${Math.round(shortTerm.ttlMs / 60000)} 分钟`;
  const recent = element("recent");
  recent.replaceChildren();
  if (!shortTerm.turns.length) addText(recent, "p", "muted", "暂无近期对话。");
  for (const turn of [...shortTerm.turns].reverse()) {
    const card = addText(recent, "article", "", "");
    addText(card, "div", "muted", time(turn.t));
    if (turn.userMessage) addText(card, "div", "text", `你：${turn.userMessage}`);
    addText(card, "div", "text", turn.reply ? `桌宠：${turn.reply}` : "桌宠安静观察了一会儿");
    for (const [source, text] of Object.entries(turn.summaries || {})) {
      if (text) addText(card, "div", "text muted", `${sourceLabel(source)}摘要：${text}`);
    }
  }
  element("summary-info").textContent = summary.enabled ? `已启用 · ${snapshot.work?.enabled ? "摘要在本地保存，重启后恢复" : "仅保留本次运行的摘要"}` : "摘要已关闭";
  const summaryContent = element("summary");
  summaryContent.replaceChildren();
  addText(summaryContent, "div", summary.text ? "text" : "muted", summary.text || "暂无会话摘要。");
  element("long-info").textContent = `${longTerm.enabled ? "已启用" : "长期记忆已关闭"} · ${longTerm.error ? "读取失败" : `已保存 ${longTerm.entries.length} 条，容量 ${longTerm.maxEntries} 条`} · 待提取 ${snapshot.pendingFacts} 轮对话`;
  const long = element("long");
  long.replaceChildren();
  if (longTerm.error) addText(long, "p", "error", longTerm.error);
  else if (!longTerm.entries.length) addText(long, "p", "muted", "暂无长期记忆。");
  for (const entry of longTerm.entries) {
    const card = addText(long, "article", "", "");
    addText(card, "div", "muted", `${typeLabel(entry.type)} · 重要性 ${entry.importance} / 5 · ${time(entry.createdAt)}`);
    addText(card, "div", "text", entry.text);
    if (entry.tags.length) addText(card, "div", "muted", `标签：${entry.tags.join("、")}`);
  }
  const work = snapshot.work || { enabled: false, profiles: [], questions: [], recentEvidence: [] };
  historyItems = work.questionHistory || [];
  renderQuestionHistory();
  element("work-info").textContent = work.error || (work.enabled ? `已启用 · ${work.profiles.length} 条当前画像关系 · ${work.pending} 条观察待整理` : "工作记忆已关闭");
  const profiles = element("profiles"); profiles.replaceChildren();
  if (!work.profiles.length) addText(profiles, "p", "muted", "还在了解你和同事们，工作信息会逐渐整理到这里。");
  const grouped = new Map();
  for (const profile of work.profiles) {
    let card = grouped.get(profile.entityId);
    if (!card) {
      card = addText(profiles, "article", "", "");
      addText(card, "h2", "", profile.subject.name);
      if (profile.aliases.length) addText(card, "p", "muted", `别名：${profile.aliases.join("、")}`);
      grouped.set(profile.entityId, card);
    }
    addText(card, "div", "text", `${profile.scope ? `【${profile.scope}】` : ""}${fieldLabel(profile.field)}：${profile.value}`);
    addText(card, "div", "muted", `${basisLabel(profile.basis)} · ${time(profile.updatedAt)}`);
    const edit = addText(card, "button", "profile-edit", "修正"); edit.type = "button";
    edit.addEventListener("click", () => {
      edit.hidden = true;
      const form = document.createElement("form"); form.className = "profile-form";
      const input = document.createElement("textarea"); input.maxLength = 600; input.value = profile.value; input.setAttribute("aria-label", `修正${profile.subject.name}的${fieldLabel(profile.field)}`);
      form.appendChild(input);
      const save = addText(form, "button", "", "保存"); save.type = "submit";
      const cancel = addText(form, "button", "", "取消"); cancel.type = "button";
      cancel.addEventListener("click", () => { form.remove(); edit.hidden = false; });
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); save.disabled = true;
        try { await window.petMemory.correctProfile(profile.id, input.value); await load(); }
        catch (cause) { error.textContent = cause.message || "保存失败"; error.hidden = false; save.disabled = false; }
      });
      card.appendChild(form); input.focus();
    });
    if (profile.evidence?.length) {
      const details = document.createElement("details"); card.appendChild(details);
      addText(details, "summary", "muted", "看看来源");
      for (const evidence of profile.evidence) addText(details, "div", "text muted", `${sourceLabel(evidence.source)} · ${time(evidence.capturedAt)}\n${evidence.text}`);
    }
  }
  const questions = element("questions"); questions.replaceChildren();
  const pending = work.questions.filter((q) => q.status === "pending");
  if (!pending.length) addText(questions, "p", "muted", "暂无待提问。也可以在右键菜单中选择「桌宠提问 → 回答一个问题」。");
  for (const question of pending) {
    const card = addText(questions, "article", "", "");
    addText(card, "div", "text", question.prompt);
    addText(card, "div", "muted", `${question.reason} · ${question.nextAt > Date.now() ? `延后至 ${time(question.nextAt)}` : "等待合适时机"}`);
  }
  const evidence = element("evidence"); evidence.replaceChildren();
  if (!work.recentEvidence.length) addText(evidence, "p", "muted", "暂无工作观察。");
  for (const item of work.recentEvidence) {
    const card = addText(evidence, "article", "", "");
    addText(card, "div", "muted", `${sourceLabel(item.source)} · ${time(item.capturedAt)} · ${item.processed ? "已整理" : "待整理"}`);
    addText(card, "div", "text", item.text);
  }
}

async function load() {
  if (refresh.disabled) return;
  refresh.disabled = true;
  error.hidden = true;
  try { render(await window.petMemory.getSnapshot()); }
  catch (cause) {
    error.textContent = `读取记忆失败：${cause.message || cause}`;
    error.hidden = false;
  } finally { refresh.disabled = false; }
}

refresh.addEventListener("click", () => void load());
void load();
