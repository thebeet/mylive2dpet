const element = (id) => document.getElementById(id);
const refresh = element("refresh");
const error = element("error");
const sourceLabel = (source) => ({ screen: "画面内容", audio: "设备音频", work: "工作内容", "audio-output": "会议／播放转写", user: "用户对话", "manual-input": "用户对话", "user-answer": "提问回答", "user-correction": "手动修正" }[source] || source);
const fieldLabel = (field) => ({ identity: "身份", organization_role: "组织角色", project_role: "项目角色", responsibility: "负责工作", team: "所属团队", collaboration: "协作关系", relationship: "人际关系", task: "当前事项", preference: "偏好", communication: "沟通方式" }[field] || field);
const basisLabel = (basis) => ({ user_answer: "用户确认", inference: "暂时猜测", observation: "根据来源提取" }[basis] || basis);
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
  element("question-history-info").textContent = `共 ${historyItems.length} 个问题 · ${historyItems.filter((q) => q.status === "pending").length} 个待提问 · 当前显示 ${filtered.length} 个 · 重启后保留`;
  const list = element("question-history"); list.replaceChildren();
  if (!filtered.length) addText(list, "p", "muted", historyItems.length ? "没有匹配的提问记录。" : "暂无待提问或提问记录。也可以在右键菜单中选择「桌宠提问 → 回答一个问题」。");
  const actionLabel = { shown: "桌宠提问", answer: "你的回答", unknown: "不清楚", skip: "跳过", defer: "稍后再问" };
  const statusLabel = { answered: "已回答", pending: "待提问", dismissed: "已停止询问" };
  for (const q of filtered) {
    const card = addText(list, "article", "", "");
    addText(card, "div", "text", q.prompt);
    const removeQuestion = addText(card, "button", "profile-edit", "删除问题及记录");
    removeQuestion.type = "button";
    removeQuestion.addEventListener("click", () => void deleteHistory(removeQuestion, () => window.petMemory.deleteQuestion(q.id)));
    addText(card, "div", "muted", `${q.subject.name}${q.scope ? ` · ${q.scope}` : ""} · ${statusLabel[q.status] || q.status}`);
    if (q.reason) addText(card, "div", "muted", q.reason);
    addText(card, "div", "muted", `选项：${q.options.map((o) => o.label).join("／")}`);
    if (q.lastShownAt != null && !q.records.some((r) => r.action === "shown")) addText(card, "div", "muted", `${time(q.lastShownAt)} · 桌宠提问`);
    for (const record of q.records) {
      const row = addText(card, "div", record.action === "answer" ? "text" : "muted", `${time(record.createdAt)} · ${actionLabel[record.action] || record.action}${record.value ? `：${record.value}` : ""}`);
      if (record.action === "answer") {
        const removeAnswer = addText(row, "button", "profile-edit", "删除答案");
        removeAnswer.type = "button";
        removeAnswer.addEventListener("click", () => void deleteHistory(removeAnswer, () => window.petMemory.deleteAnswer(q.id, record.id)));
      }
    }
    if (q.status === "pending" && q.nextAt > Date.now()) addText(card, "div", "muted", `延后至 ${time(q.nextAt)}`);
    else if (q.status === "pending") addText(card, "div", "muted", "等待合适时机询问");
  }
}
async function deleteHistory(button, remove) {
  button.disabled = true;
  error.hidden = true;
  try { await remove(); await load(); }
  catch (cause) { error.textContent = cause.message || "删除失败，请重试"; error.hidden = false; button.disabled = false; }
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

const projectStatusLabel = { active: "进行中", blocked: "遇到阻塞", completed: "已完成", paused: "暂停", unknown: "待确认" };
const lessonStatusLabel = { attempted: "尝试过，未验证", verified: "已有验证来源", failed: "失败记录" };
function renderPractice(practice = { enabled: false, projects: [], lessons: [], sources: [], history: [], pending: 0 }) {
  const byId = new Map(practice.sources.map(source => [source.id, source]));
  function showSources(card, entry) {
    const details = addText(card, "details", "", "");
    addText(details, "summary", "muted", "查看信息来源");
    for (const id of entry.sourceIds || []) {
      const source = byId.get(id);
      if (!source) continue;
      addText(details, "div", "muted", `${sourceLabel(source.source)} · ${time(source.capturedAt)}`);
      addText(details, "div", "text", source.text);
    }
  }
  function body(entry) {
    return entry.name ? `目标：${entry.goal}\n已完成：${entry.completed.join("；") || "暂无确认记录"}\n未完成／待验证：${entry.pending.join("；") || "暂无记录"}\n阻塞：${entry.blockers.join("；") || "暂无记录"}\n下一步：${entry.nextSteps.join("；") || "待确认"}`
      : `适用条件：${entry.condition}\n处理方法：${entry.steps.join("；")}\n结果：${entry.outcome}`;
  }
  for (const kind of ["projects", "lessons"]) {
    const items = practice[kind];
    element(`${kind}-info`).textContent = practice.error || `${practice.enabled ? "已启用" : "自动更新已关闭"} · ${items.length} 条记录 · 待整理 ${practice.pending} 条来源 · 来源与历史重启后保留`;
    const container = element(kind); container.replaceChildren();
    if (!items.length) addText(container, "p", "muted", kind === "projects" ? "有明确项目线索后，会记录目标、进展与下一步。" : "有具体处理方法和结果后，会记录可复用经验。");
    for (const entry of items) {
      const card = addText(container, "article", "", "");
      addText(card, "h3", "", `${entry.name || entry.title}${entry.scope ? ` · ${entry.scope}` : ""}`);
      addText(card, "div", "muted", `${(kind === "projects" ? projectStatusLabel : lessonStatusLabel)[entry.status]} · 最后来源 ${time(entry.observedAt)} · 整理于 ${time(entry.updatedAt)}`);
      if (kind === "projects" && Date.now() - entry.observedAt > practice.staleAfterMs) addText(card, "p", "muted", "该项目已久未更新，当前进展需要重新确认。");
      addText(card, "div", "text", body(entry));
      if (entry.verification) addText(card, "div", "text muted", `验证来源摘录：${entry.verification.quote}`);
      showSources(card, entry);
      const history = practice.history.filter(record => record.entryId === entry.id && record.before);
      if (history.length) {
        const details = addText(card, "details", "", "");
        addText(details, "summary", "muted", "查看之前的状态与内容");
        for (const record of history) {
          addText(details, "div", "muted", `${time(record.updatedAt)} · 更新前 · ${(kind === "projects" ? projectStatusLabel : lessonStatusLabel)[record.before.status]}`);
          addText(details, "div", "text", body(record.before));
        }
      }
    }
  }
}

function render(snapshot) {
  if (snapshot.viewTab && snapshot.viewTab !== requestedTab) {
    requestedTab = snapshot.viewTab;
    const selected = element(`${requestedTab}-tab`);
    if (selected) selectTab(selected);
  }
  element("status").textContent = `${snapshot.enabled ? "记忆已启用" : "记忆已关闭"} · 本次运行 ${snapshot.totalTurns} 轮对话 · ${snapshot.clearing ? "正在清空" : snapshot.maintaining ? "正在整理记忆" : "整理空闲"} · ${time(Date.now())}`;
  renderPractice(snapshot.practice);
  const { shortTerm, longTerm } = snapshot;
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
  element("long-info").textContent = `${longTerm.enabled ? "已启用" : "长期记忆已关闭"} · ${longTerm.error ? "读取失败" : `已保存 ${longTerm.entries.length} 条，容量 ${longTerm.maxEntries} 条`} · 每 ${longTerm.updateEveryNTurns || 20} 轮对话更新 · 待更新 ${snapshot.pendingFacts} 轮对话`;
  const long = element("long");
  long.replaceChildren();
  if (longTerm.error) addText(long, "p", "error", longTerm.error);
  else if (!longTerm.entries.length) addText(long, "p", "muted", "暂无长期记忆。");
  for (const entry of longTerm.entries) {
    const card = addText(long, "article", "", "");
    addText(card, "div", "muted", `${typeLabel(entry.type)} · 重要性 ${entry.importance} / 5 · ${time(entry.createdAt)}${entry.metadata?.updatedAt ? ` · 更新于 ${time(entry.metadata.updatedAt)}` : ""}`);
    addText(card, "div", "text", entry.text);
    if (entry.tags.length) addText(card, "div", "muted", `标签：${entry.tags.join("、")}`);
  }
  const organizationHistory = longTerm.organizationHistory || [];
  if (organizationHistory.length) addText(long, "h3", "", "整理记录（原始记忆）");
  for (const record of organizationHistory) {
    const details = addText(long, "details", "", "");
    addText(details, "summary", "muted", `${time(record.organizedAt)} · ${record.reason === "基于对话更新已有记忆" ? "更新" : record.replacementId ? "合并" : "归档"} · ${record.reason}`);
    for (const original of record.originals) {
      addText(details, "div", "text", original.text);
      addText(details, "div", "muted", `${typeLabel(original.type)} · ${time(original.createdAt)}`);
    }
  }
  const work = snapshot.work || { enabled: false, profiles: [], questions: [] };
  const allQuestions = new Map((work.questionHistory || []).map((q) => [q.id, q]));
  for (const q of work.questions || []) {
    if (q.status === "pending" && !allQuestions.has(q.id)) allQuestions.set(q.id, { ...q, records: [] });
  }
  historyItems = [...allQuestions.values()].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  renderQuestionHistory();
  element("work-info").textContent = work.error || (work.enabled ? `已启用 · ${work.profiles.length} 条人物信息` : "人物画像已关闭");
  const profiles = element("profiles"); profiles.replaceChildren();
  if (!work.profiles.length) addText(profiles, "p", "muted", "你的身份、习惯、偏好与人际关系会逐渐整理到这里。");
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
      addText(details, "summary", "muted", "信息来源");
      for (const evidence of profile.evidence) addText(details, "div", "text muted", `${sourceLabel(evidence.source)} · ${time(evidence.capturedAt)}\n${evidence.text}`);
    }
  }
  const profileHistory = work.organizationHistory || [];
  if (profileHistory.length) addText(profiles, "h3", "", "画像整理记录（原始内容）");
  for (const record of profileHistory) {
    const details = addText(profiles, "details", "", "");
    addText(details, "summary", "muted", `${time(record.organizedAt)} · ${record.replacementId ? "合并" : "归档"} · ${record.reason}`);
    for (const original of record.originals) {
      addText(details, "div", "text", `${original.subject.name}${original.scope ? `【${original.scope}】` : ""} ${fieldLabel(original.field)}：${original.value}`);
      addText(details, "div", "muted", `${basisLabel(original.basis)} · ${time(original.updatedAt)}`);
    }
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
