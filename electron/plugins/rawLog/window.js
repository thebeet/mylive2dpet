const requestsEl = document.getElementById("requests");
const messagesEl = document.getElementById("messages");
const metaEl = document.getElementById("meta");
const errorEl = document.getElementById("error");
const moreEl = document.getElementById("more");
const countEl = document.getElementById("count");
const labels = { "ai:vision": "感知与对话", "ai:text": "文本 / 记忆整理" };
const roles = { system: "系统提示词", developer: "开发者指令", user: "用户 / 感知输入", assistant: "模型", tool: "工具" };
let entries = [];
let nextCursor = null;
let selectedId = null;
let selectionVersion = 0;
let loading = false;

function addText(parent, tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  parent.appendChild(node);
  return node;
}

function statusText(entry) {
  return entry.finishedAt === null ? "发送中…" : entry.error ? "失败" : "成功";
}

const tokenText = (count) => count == null ? "未提供" : count.toLocaleString("zh-CN");
function renderUsage(parent, usage, pending = false) {
  if (!usage) { addText(parent, "span", "usage-summary", pending ? "Token 用量：等待返回" : "Token 用量：接口未提供"); return; }
  addText(parent, "span", "usage-summary", `输入 ${tokenText(usage.inputTokens)} · 输出 ${tokenText(usage.outputTokens)} · 合计 ${tokenText(usage.totalTokens)} token`);
  addText(parent, "span", "usage-summary", `输入缓存：命中 ${tokenText(usage.cachedTokens)} · 未命中 ${tokenText(usage.uncachedTokens)}`);
  if (usage.cacheWriteTokens != null) addText(parent, "span", "usage-summary", `缓存写入 ${tokenText(usage.cacheWriteTokens)} token`);
  if (usage.reasoningTokens != null) addText(parent, "span", "usage-summary", `输出中推理 ${tokenText(usage.reasoningTokens)} token`);
}

function renderList() {
  requestsEl.replaceChildren();
  countEl.textContent = `已显示 ${entries.length} 次请求 · 每 2 秒自动更新`;
  if (!entries.length) addText(requestsEl, "div", "empty", "还没有请求。下次发送给模型的完整内容会显示在这里。");
  let sessionId;
  for (const entry of entries) {
    if (sessionId !== entry.sessionId) {
      sessionId = entry.sessionId;
      addText(requestsEl, "div", "session", `运行会话 ${sessionId.slice(0, 8)}`);
    }
    const button = document.createElement("button");
    button.className = "request";
    button.setAttribute("aria-pressed", String(entry.id === selectedId));
    addText(button, "span", "", `#${entry.sequence} · ${labels[entry.label] || entry.label}`);
    addText(button, "time", "muted", new Date(entry.t).toLocaleString("zh-CN"));
    addText(button, "span", "muted", `${entry.model} · ${statusText(entry)}`);
    renderUsage(button, entry.usage, entry.finishedAt === null);
    button.addEventListener("click", () => void select(entry));
    requestsEl.appendChild(button);
  }
  moreEl.hidden = !nextCursor;
}

function renderContent(parent, content) {
  if (typeof content === "string") {
    addText(parent, "div", "content", content);
    return;
  }
  if (!Array.isArray(content)) {
    if (content !== null && content !== undefined) addText(parent, "div", "content", JSON.stringify(content, null, 2));
    return;
  }
  for (const part of content) {
    if (typeof part === "string" || typeof part?.text === "string") {
      addText(parent, "div", "content", typeof part === "string" ? part : part.text);
    } else if (part?.type === "image_url") {
      const url = part.image_url?.url || "";
      if (/^data:image\/(jpeg|png|webp|gif);base64,/i.test(url)) {
        const image = document.createElement("img");
        image.src = url;
        image.alt = "本次发送给模型的图片";
        image.loading = "lazy";
        parent.appendChild(image);
      } else {
        addText(parent, "div", "content", `图片 URL：${url}`);
      }
      const detail = document.createElement("details");
      addText(detail, "summary", "", "原始图片字段");
      addText(detail, "div", "content", JSON.stringify(part, null, 2));
      parent.appendChild(detail);
    } else {
      addText(parent, "div", "content", JSON.stringify(part, null, 2));
    }
  }
}

function renderMessage(message) {
  const card = document.createElement("article");
  card.className = "message";
  if (["user", "assistant"].includes(message.role)) card.classList.add(message.role);
  addText(card, "div", "role", `${roles[message.role] || message.role || "消息"}${message.name ? ` · ${message.name}` : ""}`);
  renderContent(card, message.content);
  const extra = Object.fromEntries(Object.entries(message).filter(([key]) => !["role", "content", "name"].includes(key)));
  if (Object.keys(extra).length) addText(card, "div", "content", JSON.stringify(extra, null, 2));
  messagesEl.appendChild(card);
}

async function select(entry, preserveScroll = false) {
  const version = ++selectionVersion;
  selectedId = entry.id;
  renderList();
  try {
    const result = await window.rawLog.get(entry.id);
    if (version !== selectionVersion) return;
    errorEl.textContent = "";
    metaEl.replaceChildren();
    const elapsed = entry.finishedAt === null ? "" : ` · ${Math.max(0, entry.finishedAt - entry.t)} ms`;
    addText(metaEl, "div", "", `#${entry.sequence} · ${new Date(entry.t).toLocaleString("zh-CN")} · ${statusText(entry)}${entry.status ? ` · HTTP ${entry.status}` : ""}${elapsed}`);
    renderUsage(metaEl, result.usage, entry.finishedAt === null);
    const parameters = Object.fromEntries(Object.entries(result.request).filter(([key]) => key !== "messages"));
    const details = document.createElement("details");
    addText(details, "summary", "", "请求参数");
    addText(details, "div", "content", JSON.stringify(parameters, null, 2));
    metaEl.appendChild(details);
    messagesEl.replaceChildren();
    for (const message of result.request.messages || []) renderMessage(message);
    if (result.response) {
      addText(messagesEl, "div", "muted", "模型返回内容");
      if (result.response.choices?.length) {
        for (const choice of result.response.choices) if (choice.message) renderMessage(choice.message);
      } else {
        renderMessage({ role: "assistant", content: typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2) });
      }
    }
    if (entry.error) addText(messagesEl, "div", "error", entry.error);
    if (!preserveScroll) document.querySelector("main").scrollTop = 0;
  } catch (error) {
    if (version === selectionVersion) errorEl.textContent = `读取请求失败：${error.message || error}`;
  }
}

async function load(mode = "update") {
  if (loading) return;
  loading = true;
  moreEl.disabled = true;
  try {
    const result = await window.rawLog.list({ before: mode === "more" ? nextCursor : null });
    const oldSelected = entries.find(({ id }) => id === selectedId);
    if (mode === "reset" || !entries.length) {
      entries = result.entries;
      nextCursor = result.nextCursor;
    } else {
      const merged = new Map(entries.map((entry) => [entry.id, entry]));
      for (const entry of result.entries) merged.set(entry.id, entry);
      entries = [...merged.values()].sort((a, b) => b.sequence - a.sequence);
      if (mode === "more") nextCursor = result.nextCursor;
    }
    errorEl.textContent = "";
    renderList();
    const selected = entries.find(({ id }) => id === selectedId) || entries[0];
    if (selected && (!oldSelected || selected.id !== selectedId || selected.finishedAt !== oldSelected.finishedAt || mode === "reset")) {
      await select(selected, mode === "update");
    }
  } catch (error) {
    errorEl.textContent = `读取日志失败：${error.message || error}`;
  } finally { loading = false; moreEl.disabled = false; }
}

document.getElementById("refresh").addEventListener("click", () => void load("reset"));
moreEl.addEventListener("click", () => void load("more"));
const timer = setInterval(() => void load(), 2000);
window.addEventListener("beforeunload", () => clearInterval(timer));
void load();
