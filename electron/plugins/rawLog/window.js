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
let activeTab = "requests";
let viewGeneration = 0, clearing = false;
const screenshotsEl = document.getElementById("screenshots");
const screenshotDetailEl = document.getElementById("screenshot-detail");
const screenshotErrorEl = document.getElementById("screenshots-error");
const screenshotsMoreEl = document.getElementById("screenshots-more");
let screenshots = [], screenshotsCursor = null, selectedScreenshotId = null;
let screenshotsLoading = false, screenshotSelectionVersion = 0;
const webListEl = document.getElementById("web-search-list");
const webDetailEl = document.getElementById("web-search-detail");
const webErrorEl = document.getElementById("web-search-error");
const webMoreEl = document.getElementById("web-search-more");
const tabNames = ["requests", "screenshots", "web-search", "rss", "gitlab"];
const webStates = { queued: "排队中", running: "进行中", success: "成功", failed: "失败", rejected: "已拦截", cancelled: "已取消", skipped: "已跳过" };
let webEntries = [], webCursor = null, webSelectedId = null, webLoading = false, webSelectionVersion = 0;
const rssListEl = document.getElementById("rss-list");
const rssDetailEl = document.getElementById("rss-detail");
const rssErrorEl = document.getElementById("rss-error");
const rssMoreEl = document.getElementById("rss-more");
const rssStates = { running: "获取中", baseline: "已建立基线", success: "检查完成", "not-modified": "未更新（304）", failed: "失败", cancelled: "已取消" };
const rssDeliveries = { baseline: "基线条目", unchanged: "未变化", pending: "尚未提交", queued: "已入队", failed: "入队失败" };
const rssChanges = { new: "新增", updated: "修改", unchanged: "未变化" };
let rssEntries = [], rssCursor = null, rssSelectedId = null, rssLoading = false, rssSelectionVersion = 0;

function renderRssList() {
  rssListEl.replaceChildren();
  countEl.textContent = `已显示 ${rssEntries.length} 次 RSS 获取 · 每 2 秒自动更新`;
  if (!rssEntries.length) {
    addText(rssListEl, "div", "empty", "暂无记录。启用 RSS 订阅后，获取内容与检查结果会显示在这里。");
    rssDetailEl.replaceChildren();
  }
  for (const entry of rssEntries) {
    const button = addText(rssListEl, "button", "request", "");
    button.setAttribute("aria-pressed", String(entry.id === rssSelectedId));
    addText(button, "span", "", entry.feedName || entry.request.url);
    addText(button, "time", "muted", new Date(entry.t).toLocaleString("zh-CN"));
    addText(button, "span", "muted", `${rssStates[entry.state] || entry.state}${entry.status != null ? ` · HTTP ${entry.status}` : ""}`);
    if (entry.itemCount != null) addText(button, "span", "muted", `获取 ${entry.itemCount} 条 · 已入队 ${entry.queuedCount || 0} 条`);
    button.addEventListener("click", () => void selectRss(entry));
  }
  rssMoreEl.hidden = !rssCursor;
}

async function selectRss(entry, preserveScroll = false) {
  const version = ++rssSelectionVersion, epoch = viewGeneration;
  rssSelectedId = entry.id;
  renderRssList();
  try {
    const record = await window.rawLog.getRss(entry.id);
    if (version !== rssSelectionVersion || epoch !== viewGeneration || activeTab !== "rss") return;
    rssErrorEl.textContent = "";
    const main = document.querySelector("#rss-panel main"), scroll = main.scrollTop;
    const expanded = preserveScroll ? new Set([...rssDetailEl.querySelectorAll("details[open][data-key]")]
      .map(details => details.dataset.key)) : new Set();
    rssDetailEl.replaceChildren();
    addText(rssDetailEl, "h2", "", `${record.feedName || record.request.url} · ${rssStates[record.state] || record.state}`);
    addText(rssDetailEl, "div", "muted", `${new Date(record.t).toLocaleString("zh-CN")}${record.elapsedMs != null ? ` · ${record.elapsedMs} ms` : ""}`);
    if (record.baseline) addText(rssDetailEl, "p", "muted", "本次首次读取用于建立更新基线，已有条目未提交观察队列。");
    if (record.state === "not-modified") addText(rssDetailEl, "p", "muted", "订阅源返回 304，本次没有新的响应正文。");
    const { rawXml, items, request, response, ...metadata } = record;
    for (const [title, value] of [["请求参数", request], ["HTTP 响应", response], ["获取与入队状态", metadata], ["失败原因", record.error]]) {
      if (value == null || value === "") continue;
      const card = addText(rssDetailEl, "article", "message", "");
      addText(card, "div", "role", title);
      addText(card, "div", "content", typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }
    if (items) {
      addText(rssDetailEl, "h3", "", `获取到的条目（${items.length}）`);
      for (const item of items) {
        const details = addText(rssDetailEl, "details", "message", "");
        details.dataset.key = item.id;
        addText(details, "summary", "", `${item.title || "无标题"} · ${rssChanges[item.eventType] || item.eventType} · ${rssDeliveries[item.delivery] || item.delivery}`);
        const { content, fingerprint, ...itemMetadata } = item;
        addText(details, "div", "content", JSON.stringify(itemMetadata, null, 2));
        addText(details, "div", "content", content || "订阅源未提供正文或摘要。");
      }
    }
    if (rawXml != null) {
      const details = addText(rssDetailEl, "details", "message", "");
      details.dataset.key = "raw-xml";
      addText(details, "summary", "", "原始响应正文（访问令牌已脱敏）");
      addText(details, "pre", "content", rawXml);
    }
    for (const details of rssDetailEl.querySelectorAll("details[data-key]")) {
      if (expanded.has(details.dataset.key)) details.open = true;
    }
    main.scrollTop = preserveScroll ? scroll : 0;
  } catch (error) {
    if (version === rssSelectionVersion && epoch === viewGeneration && activeTab === "rss") {
      rssErrorEl.textContent = `读取 RSS 获取记录失败：${error.message || error}`;
    }
  }
}

async function loadRss(mode = "update") {
  if (rssLoading || clearing) return;
  const epoch = viewGeneration;
  rssLoading = true; rssMoreEl.disabled = true;
  try {
    const result = await window.rawLog.listRss({ before: mode === "more" ? rssCursor : null });
    if (epoch !== viewGeneration || activeTab !== "rss") return;
    const old = rssEntries.find(entry => entry.id === rssSelectedId);
    if (mode === "reset" || !rssEntries.length) { rssEntries = result.entries; rssCursor = result.nextCursor; }
    else {
      const merged = new Map(rssEntries.map(entry => [entry.id, entry]));
      for (const entry of result.entries) merged.set(entry.id, entry);
      rssEntries = [...merged.values()].sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (mode === "more" || rssCursor === null) rssCursor = result.nextCursor;
    }
    rssErrorEl.textContent = ""; renderRssList();
    const selected = rssEntries.find(entry => entry.id === rssSelectedId) || rssEntries[0];
    if (selected && (!old || JSON.stringify(old) !== JSON.stringify(selected) || ["reset", "activate"].includes(mode))) {
      await selectRss(selected, mode === "update" || mode === "activate");
    }
  } catch (error) {
    if (epoch === viewGeneration && activeTab === "rss") rssErrorEl.textContent = `读取 RSS 日志失败：${error.message || error}`;
  } finally { rssLoading = false; rssMoreEl.disabled = clearing; }
}

const gitlabListEl = document.getElementById("gitlab-list");
const gitlabDetailEl = document.getElementById("gitlab-detail");
const gitlabErrorEl = document.getElementById("gitlab-error");
const gitlabMoreEl = document.getElementById("gitlab-more");
const gitlabStates = { running: "获取中", baseline: "已建立基线", success: "检查完成", failed: "失败", cancelled: "已取消" };
const gitlabDeliveries = { baseline: "基线条目", unchanged: "未变化", filtered: "已筛选排除", pending: "尚未提交", queued: "已入队", failed: "入队失败" };
const gitlabChanges = { new: "新增", "status-changed": "状态 / 分支 / SHA 变化", unchanged: "未变化" };
let gitlabEntries = [], gitlabCursor = null, gitlabSelectedId = null, gitlabLoading = false, gitlabSelectionVersion = 0;

function renderGitlabList() {
  gitlabListEl.replaceChildren();
  countEl.textContent = `已显示 ${gitlabEntries.length} 次 GitLab 查询 · 每 2 秒自动更新`;
  if (!gitlabEntries.length) {
    addText(gitlabListEl, "div", "empty", "暂无记录。启用 GitLab 插件后，获取内容与检查结果会显示在这里。");
    gitlabDetailEl.replaceChildren();
  }
  for (const entry of gitlabEntries) {
    const button = addText(gitlabListEl, "button", "request", "");
    button.setAttribute("aria-pressed", String(entry.id === gitlabSelectedId));
    addText(button, "span", "", entry.projectName || entry.request.projectId);
    addText(button, "time", "muted", new Date(entry.t).toLocaleString("zh-CN"));
    addText(button, "span", "muted", `${gitlabStates[entry.state] || entry.state}${entry.status != null ? ` · HTTP ${entry.status}` : ""}`);
    if (entry.itemCount != null) addText(button, "span", "muted", `获取 ${entry.itemCount} 条 · 已入队 ${entry.queuedCount || 0} 条`);
    button.addEventListener("click", () => void selectGitlab(entry));
  }
  gitlabMoreEl.hidden = !gitlabCursor;
}

async function selectGitlab(entry, preserveScroll = false) {
  const version = ++gitlabSelectionVersion, epoch = viewGeneration;
  gitlabSelectedId = entry.id;
  renderGitlabList();
  try {
    const record = await window.rawLog.getGitlab(entry.id);
    if (version !== gitlabSelectionVersion || epoch !== viewGeneration || activeTab !== "gitlab") return;
    gitlabErrorEl.textContent = "";
    const main = document.querySelector("#gitlab-panel main"), scroll = main.scrollTop;
    const expanded = preserveScroll ? new Set([...gitlabDetailEl.querySelectorAll("details[open][data-key]")]
      .map(details => details.dataset.key)) : new Set();
    gitlabDetailEl.replaceChildren();
    addText(gitlabDetailEl, "h2", "", `${record.projectName || record.request.projectId} · ${gitlabStates[record.state] || record.state}`);
    addText(gitlabDetailEl, "div", "muted", `${new Date(record.t).toLocaleString("zh-CN")}${record.elapsedMs != null ? ` · ${record.elapsedMs} ms` : ""}`);
    if (record.state === "baseline") addText(gitlabDetailEl, "p", "muted", "本次首次读取用于建立更新基线，已有流水线未提交观察队列。");
    const { pages, items, request, ...metadata } = record;
    for (const [title, value] of [["请求参数", request], ["获取与入队状态", metadata], ["失败原因", record.error]]) {
      if (value == null || value === "") continue;
      const card = addText(gitlabDetailEl, "article", "message", "");
      addText(card, "div", "role", title);
      addText(card, "div", "content", typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }
    if (items) {
      addText(gitlabDetailEl, "h3", "", `获取到的条目（${items.length}）`);
      for (const item of items) {
        const details = addText(gitlabDetailEl, "details", "message", "");
        details.dataset.key = `pipeline-${item.id}`;
        addText(details, "summary", "", `#${item.id} · ${item.ref} · ${item.status} · ${gitlabChanges[item.eventType] || item.eventType} · ${gitlabDeliveries[item.delivery] || item.delivery}`);
        const itemMetadata = item;
        addText(details, "div", "content", JSON.stringify(itemMetadata, null, 2));
      }
    }
    for (const page of pages || []) {
      const details = addText(gitlabDetailEl, "details", "message", "");
      details.dataset.key = `page-${page.page}`;
      addText(details, "summary", "", `第 ${page.page} 页 · ${page.response ? `HTTP ${page.response.status}` : "未收到响应"} · 原始响应正文（访问令牌已脱敏）`);
      const { rawBody, ...pageMetadata } = page;
      addText(details, "div", "content", JSON.stringify(pageMetadata, null, 2));
      if (rawBody != null) addText(details, "pre", "content", rawBody);
    }
    for (const details of gitlabDetailEl.querySelectorAll("details[data-key]")) {
      if (expanded.has(details.dataset.key)) details.open = true;
    }
    main.scrollTop = preserveScroll ? scroll : 0;
  } catch (error) {
    if (version === gitlabSelectionVersion && epoch === viewGeneration && activeTab === "gitlab") {
      gitlabErrorEl.textContent = `读取 GitLab 查询记录失败：${error.message || error}`;
    }
  }
}

async function loadGitlab(mode = "update") {
  if (gitlabLoading || clearing) return;
  const epoch = viewGeneration;
  gitlabLoading = true; gitlabMoreEl.disabled = true;
  try {
    const result = await window.rawLog.listGitlab({ before: mode === "more" ? gitlabCursor : null });
    if (epoch !== viewGeneration || activeTab !== "gitlab") return;
    const old = gitlabEntries.find(entry => entry.id === gitlabSelectedId);
    if (mode === "reset" || !gitlabEntries.length) { gitlabEntries = result.entries; gitlabCursor = result.nextCursor; }
    else {
      const merged = new Map(gitlabEntries.map(entry => [entry.id, entry]));
      for (const entry of result.entries) merged.set(entry.id, entry);
      gitlabEntries = [...merged.values()].sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (mode === "more" || gitlabCursor === null) gitlabCursor = result.nextCursor;
    }
    gitlabErrorEl.textContent = ""; renderGitlabList();
    const selected = gitlabEntries.find(entry => entry.id === gitlabSelectedId) || gitlabEntries[0];
    if (selected && (!old || JSON.stringify(old) !== JSON.stringify(selected) || ["reset", "activate"].includes(mode))) {
      await selectGitlab(selected, mode === "update" || mode === "activate");
    }
  } catch (error) {
    if (epoch === viewGeneration && activeTab === "gitlab") gitlabErrorEl.textContent = `读取 GitLab 日志失败：${error.message || error}`;
  } finally { gitlabLoading = false; gitlabMoreEl.disabled = clearing; }
}

function renderWebList() {
  webListEl.replaceChildren();
  countEl.textContent = `已显示 ${webEntries.length} 条 Search / Fetch 记录 · 每 2 秒自动更新`;
  if (!webEntries.length) {
    addText(webListEl, "div", "empty", "暂无记录。之后的 Search 与 Fetch 请求会显示在这里。");
    webDetailEl.replaceChildren();
  }
  for (const entry of webEntries) {
    const button = addText(webListEl, "button", "request", "");
    button.setAttribute("aria-pressed", String(entry.id === webSelectedId));
    addText(button, "span", "", `${entry.operation === "search" ? "Search" : "Fetch"} · ${webStates[entry.state] || entry.state}`);
    addText(button, "time", "muted", new Date(entry.t).toLocaleString("zh-CN"));
    addText(button, "span", "content", entry.request?.query || entry.request?.url || "参数无效");
    addText(button, "span", "muted", `${entry.provider || "未配置 provider"}${entry.elapsedMs != null ? ` · ${entry.elapsedMs} ms` : ""}`);
    button.addEventListener("click", () => void selectWeb(entry));
  }
  webMoreEl.hidden = !webCursor;
}

async function selectWeb(entry, preserveScroll = false) {
  const version = ++webSelectionVersion, epoch = viewGeneration;
  webSelectedId = entry.id;
  renderWebList();
  try {
    const record = await window.rawLog.getWebSearch(entry.id);
    if (version !== webSelectionVersion || epoch !== viewGeneration || activeTab !== "web-search") return;
    webErrorEl.textContent = "";
    const main = document.querySelector("#web-search-panel main"), scroll = main.scrollTop;
    webDetailEl.replaceChildren();
    addText(webDetailEl, "h2", "", `${record.operation === "search" ? "Search" : "Fetch"} · ${webStates[record.state] || record.state}`);
    addText(webDetailEl, "div", "muted", `${new Date(record.t).toLocaleString("zh-CN")} · ${record.provider || "未配置 provider"}${record.elapsedMs != null ? ` · ${record.elapsedMs} ms` : ""}`);
    const { result, http, request, originalQuestion, modelReply, ...metadata } = record;
    for (const [title, value] of [["触发问题", originalQuestion], ["模型回复", modelReply], ["请求参数", request],
      ["请求标识与状态", metadata], ["HTTP 请求记录", http], ["Search / Fetch 结果", result], ["失败原因", record.error]]) {
      if (value == null || value === "") continue;
      const card = addText(webDetailEl, "article", "message", "");
      addText(card, "div", "role", title);
      addText(card, "div", "content", typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }
    main.scrollTop = preserveScroll ? scroll : 0;
  } catch (error) {
    if (version === webSelectionVersion && epoch === viewGeneration && activeTab === "web-search") webErrorEl.textContent = `读取请求失败：${error.message || error}`;
  }
}

async function loadWeb(mode = "update") {
  if (webLoading || clearing) return;
  const epoch = viewGeneration;
  webLoading = true; webMoreEl.disabled = true;
  try {
    const result = await window.rawLog.listWebSearch({ before: mode === "more" ? webCursor : null });
    if (epoch !== viewGeneration || activeTab !== "web-search") return;
    const old = webEntries.find(entry => entry.id === webSelectedId);
    if (mode === "reset" || !webEntries.length) { webEntries = result.entries; webCursor = result.nextCursor; }
    else {
      const merged = new Map(webEntries.map(entry => [entry.id, entry]));
      for (const entry of result.entries) merged.set(entry.id, entry);
      webEntries = [...merged.values()].sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (mode === "more" || webCursor === null) webCursor = result.nextCursor;
    }
    webErrorEl.textContent = ""; renderWebList();
    const selected = webEntries.find(entry => entry.id === webSelectedId) || webEntries[0];
    if (selected && (!old || JSON.stringify(old) !== JSON.stringify(selected) || ["reset", "activate"].includes(mode))) {
      await selectWeb(selected, mode === "update" || mode === "activate");
    }
  } catch (error) {
    if (epoch === viewGeneration && activeTab === "web-search") webErrorEl.textContent = `读取网页请求日志失败：${error.message || error}`;
  } finally { webLoading = false; webMoreEl.disabled = clearing; }
}

async function updateTabs() {
  try {
    const available = await window.rawLog.listTabs();
    if (clearing) return;
    document.getElementById("web-search-tab").hidden = !available.webSearch;
    if (!available.webSearch && activeTab === "web-search") switchTab("requests");
  } catch { /* Existing tabs remain usable if discovery temporarily fails. */ }
}

function addText(parent, tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  parent.appendChild(node);
  return node;
}

function statusText(entry) {
  if (entry.requestCount != null) return `${entry.requestCount} 次请求${entry.pendingCount ? ` · ${entry.pendingCount} 次进行中` : ""}${entry.errorCount ? ` · ${entry.errorCount} 次失败` : ""}`;
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
  countEl.textContent = `已显示 ${entries.length} 个对话会话 / 文本请求 · 每 2 秒自动更新`;
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
    addText(button, "span", "", `#${entry.sequence} · ${entry.id.startsWith("conversation:") ? "对话会话" : labels[entry.label] || entry.label}`);
    addText(button, "time", "muted", new Date(entry.t).toLocaleString("zh-CN"));
    addText(button, "span", "muted", `${entry.model} · ${statusText(entry)}`);
    if (entry.id.startsWith("conversation:")) addText(button, "span", "muted", `${entry.turnCount} 轮输入${entry.summaryCount ? ` · ${entry.summaryCount} 次汇总请求` : ""}`);
    renderUsage(button, entry.usage, entry.finishedAt === null);
    button.addEventListener("click", () => void select(entry));
    requestsEl.appendChild(button);
  }
  moreEl.hidden = !nextCursor;
}

function renderContent(parent, content, requestId, imagePreviews = {}, showImageFields = true) {
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
      const preview = imagePreviews[url];
      const imageUrl = preview?.url || url;
      if (/^data:image\/(jpeg|png|webp|gif);base64,/i.test(imageUrl)) {
        const image = document.createElement("img");
        image.src = imageUrl;
        image.alt = part.logImageSource === "original" ? "保存的原始截图" : "本次发送给模型的图片";
        image.loading = "lazy";
        parent.appendChild(image);
        if (part.logImageSource === "original") addText(parent, "div", "muted", "保存的原始截图；发送给模型前会缩放、压缩。日志引用原图，不重复保存编码图片。");
      } else {
        addText(parent, "div", "content", `图片 URL：${url}${preview?.error ? `（${preview.error}）` : ""}`);
        if (url.startsWith("storage://") && requestId && !preview?.error) {
          const holder = document.createElement("div");
          const button = addText(holder, "button", "", "查看截图");
          button.type = "button";
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              const result = await window.rawLog.get(requestId);
              if (!holder.isConnected) return;
              holder.replaceChildren();
              renderContent(holder, [part], undefined, result.imagePreviews || {}, false);
            } catch (error) {
              button.disabled = false;
              addText(holder, "div", "error", `读取图片失败：${error.message || error}`);
            }
          });
          parent.appendChild(holder);
        }
      }
      if (showImageFields) {
        const detail = document.createElement("details");
        addText(detail, "summary", "", "原始图片字段");
        addText(detail, "div", "content", JSON.stringify(part, null, 2));
        parent.appendChild(detail);
      }
    } else {
      addText(parent, "div", "content", JSON.stringify(part, null, 2));
    }
  }
}

function renderMessage(message, parent = messagesEl, requestId, previews) {
  const card = document.createElement("article");
  card.className = "message";
  if (["user", "assistant"].includes(message.role)) card.classList.add(message.role);
  addText(card, "div", "role", `${roles[message.role] || message.role || "消息"}${message.name ? ` · ${message.name}` : ""}`);
  renderContent(card, message.content, requestId, previews);
  const extra = Object.fromEntries(Object.entries(message).filter(([key]) => !["role", "content", "name"].includes(key)));
  if (Object.keys(extra).length) addText(card, "div", "content", JSON.stringify(extra, null, 2));
  parent.appendChild(card);
}

function renderResponse(response, parent, requestId) {
  if (!response) return;
  if (response.choices?.length) {
    for (const choice of response.choices) if (choice.message) renderMessage(choice.message, parent, requestId);
  } else {
    renderMessage({ role: "assistant", content: typeof response === "string" ? response : JSON.stringify(response, null, 2) }, parent, requestId);
  }
}

function renderFullRequest(record, parent) {
  const details = document.createElement("details");
  details.className = "full-request";
  details.dataset.key = `full:${record.id}`;
  addText(details, "summary", "", `查看请求 #${record.sequence} 的完整消息与原始返回`);
  const content = document.createElement("div");
  content.className = "request-content";
  details.appendChild(content);
  let loaded = false, pending = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded || pending) return;
    pending = true;
    content.replaceChildren();
    addText(content, "div", "muted", "正在读取…");
    try {
      const result = await window.rawLog.get(record.id);
      if (!details.isConnected) return;
      content.replaceChildren();
      addText(content, "div", "content", JSON.stringify(record.parameters, null, 2));
      for (const message of result.request.messages || []) renderMessage(message, content, record.id, result.imagePreviews);
      if (result.response) addText(content, "div", "content", JSON.stringify(result.response, null, 2));
      loaded = true;
    } catch (error) {
      content.replaceChildren();
      addText(content, "div", "error", `读取请求失败：${error.message || error}`);
    } finally { pending = false; }
  });
  parent.appendChild(details);
}

function renderGroup(result) {
  messagesEl.replaceChildren();
  if (result.initialMessages.length) {
    const context = document.createElement("details");
    context.className = "shared-context";
    context.dataset.key = "context";
    addText(context, "summary", "", "本会话的系统提示词与初始上下文");
    for (const message of result.initialMessages) renderMessage(message, context);
    messagesEl.appendChild(context);
  }
  const turns = new Map();
  for (const record of result.entries) {
    const key = record.conversation?.turnId || record.id;
    if (!turns.has(key)) turns.set(key, []);
    turns.get(key).push(record);
  }
  for (const records of turns.values()) {
    const first = records[0];
    const summary = first.conversation?.kind === "summary";
    const section = document.createElement(summary ? "details" : "section");
    section.className = summary ? "summary-request" : "conversation-turn";
    if (summary) section.dataset.key = `summary:${first.id}`;
    addText(section, summary ? "summary" : "div", summary ? "" : "role", summary ? "上下文汇总请求" :
      first.conversation ? `第 ${first.conversation.turn} 轮 · ${new Date(first.t).toLocaleString("zh-CN")}` : `请求 #${first.sequence}`);
    if (first.input) renderMessage(first.input, section, first.id);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const attempt = document.createElement(records.length > 1 && index < records.length - 1 ? "details" : "div");
      attempt.className = "attempt";
      if (attempt.tagName === "DETAILS") attempt.dataset.key = `attempt:${record.id}`;
      const elapsed = record.finishedAt === null ? "" : ` · ${Math.max(0, record.finishedAt - record.t)} ms`;
      addText(attempt, attempt.tagName === "DETAILS" ? "summary" : "div", "muted",
        `请求 #${record.sequence}${records.length > 1 ? ` · 第 ${index + 1} 次尝试` : ""} · ${statusText(record)}${record.status ? ` · HTTP ${record.status}` : ""}${elapsed}`);
      renderUsage(attempt, record.usage, record.finishedAt === null);
      renderResponse(record.response, attempt, record.id);
      if (record.error) addText(attempt, "div", "error", record.error);
      renderFullRequest(record, attempt);
      section.appendChild(attempt);
    }
    messagesEl.appendChild(section);
  }
}

async function select(entry, preserveScroll = false) {
  const version = ++selectionVersion;
  selectedId = entry.id;
  renderList();
  try {
    const result = await window.rawLog.getGroup(entry.id);
    if (version !== selectionVersion || activeTab !== "requests") return;
    errorEl.textContent = "";
    metaEl.replaceChildren();
    addText(metaEl, "div", "", `${entry.id.startsWith("conversation:") ? "对话会话" : "文本 / 历史请求"} #${entry.sequence} · ${new Date(entry.t).toLocaleString("zh-CN")} · ${statusText(entry)}`);
    addText(metaEl, "div", "muted", "按轮次展示新增输入与回复；系统提示词和初始上下文只展示一次。完整请求可分别展开查看。");
    renderUsage(metaEl, entry.usage, entry.finishedAt === null);
    if (!entry.usageComplete) addText(metaEl, "div", "muted", "部分请求尚未提供用量，无法完整汇总的计数显示为未提供。");
    const expanded = preserveScroll ? new Set([...messagesEl.querySelectorAll("details[open][data-key]")]
      .map(details => details.dataset.key)) : new Set();
    renderGroup(result);
    for (const details of messagesEl.querySelectorAll("details[data-key]")) if (expanded.has(details.dataset.key)) details.open = true;
    if (!preserveScroll) document.querySelector("#requests-panel main").scrollTop = 0;
  } catch (error) {
    if (version === selectionVersion && activeTab === "requests") errorEl.textContent = `读取会话失败：${error.message || error}`;
  }
}

async function load(mode = "update") {
  if (loading || clearing) return;
  const epoch = viewGeneration;
  loading = true;
  moreEl.disabled = true;
  try {
    const result = await window.rawLog.listGroups({ before: mode === "more" ? nextCursor : null });
    if (activeTab !== "requests" || epoch !== viewGeneration) return;
    const oldSelected = entries.find(({ id }) => id === selectedId);
    if (mode === "reset" || !entries.length) {
      entries = result.entries;
      nextCursor = result.nextCursor;
    } else {
      const merged = new Map(entries.map((entry) => [entry.id, entry]));
      for (const entry of result.entries) merged.set(entry.id, entry);
      entries = [...merged.values()].sort((a, b) => b.sequence - a.sequence);
      if (mode === "more" || nextCursor === null) nextCursor = result.nextCursor;
    }
    errorEl.textContent = "";
    renderList();
    const selected = entries.find(({ id }) => id === selectedId) || entries[0];
    if (selected && (!oldSelected || selected.id !== selectedId || selected.updatedAt !== oldSelected.updatedAt || selected.revision !== oldSelected.revision || selected.pendingCount !== oldSelected.pendingCount || selected.errorCount !== oldSelected.errorCount || mode === "reset" || mode === "activate")) {
      await select(selected, mode === "update" || mode === "activate");
    }
  } catch (error) {
    if (activeTab === "requests" && epoch === viewGeneration) errorEl.textContent = `读取日志失败：${error.message || error}`;
  } finally { loading = false; moreEl.disabled = clearing; }
}

function screenshotTime(entry) {
  return new Date(entry.metadata.capturedAt || entry.createdAt).toLocaleString("zh-CN");
}

function screenshotSize(size) {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(2)} MB` : `${(size / 1024).toFixed(1)} KB`;
}

function renderScreenshots() {
  screenshotsEl.replaceChildren();
  countEl.textContent = `已显示 ${screenshots.length} 张截图 · 每 2 秒自动更新`;
  if (!screenshots.length) {
    addText(screenshotsEl, "div", "empty", "暂无保存的截图。自动采集和手动保存的截图会显示在这里。");
    screenshotDetailEl.replaceChildren();
    addText(screenshotDetailEl, "div", "empty", "选择左侧截图，查看原图与分析摘要。");
  }
  for (const entry of screenshots) {
    const button = document.createElement("button");
    button.className = "request";
    button.setAttribute("aria-pressed", String(entry.id === selectedScreenshotId));
    addText(button, "time", "", screenshotTime(entry));
    addText(button, "span", "muted", `${entry.metadata.manual ? "手动保存" : "自动采集"} · ${screenshotSize(entry.size)}`);
    addText(button, "span", "muted", entry.metadata.analyses?.length ? `已分析 ${entry.metadata.analyses.length} 次` : "尚无分析摘要");
    button.addEventListener("click", () => void selectScreenshot(entry));
    screenshotsEl.appendChild(button);
  }
  screenshotsMoreEl.hidden = !screenshotsCursor;
}

async function selectScreenshot(entry, preserveScroll = false) {
  const version = ++screenshotSelectionVersion;
  selectedScreenshotId = entry.id;
  renderScreenshots();
  try {
    const result = await window.rawLog.getScreenshot(entry.id);
    if (version !== screenshotSelectionVersion || activeTab !== "screenshots") return;
    screenshotErrorEl.textContent = "";
    screenshotDetailEl.replaceChildren();
    const metadata = result.metadata;
    addText(screenshotDetailEl, "div", "muted", `${screenshotTime(result)} · ${metadata.manual ? "手动保存" : "自动采集"} · ${metadata.width || "?"} × ${metadata.height || "?"} · ${screenshotSize(result.size)}`);
    const image = document.createElement("img");
    image.src = result.imageUrl;
    image.alt = `截图：${screenshotTime(result)}`;
    screenshotDetailEl.appendChild(image);
    for (const analysis of metadata.analyses || []) {
      const card = document.createElement("article");
      card.className = "message";
      const count = analysis.screenshotIds?.length || 1;
      addText(card, "div", "role", `分析时间 ${new Date(analysis.completedAt).toLocaleString("zh-CN")} · ${count > 1 ? `本批 ${count} 张截图的共同摘要` : "单张截图摘要"}`);
      if (analysis.screenSummary) {
        addText(card, "div", "muted", "画面摘要");
        addText(card, "div", "content", analysis.screenSummary);
      }
      if (analysis.workSummary) {
        addText(card, "div", "muted", "工作摘要");
        addText(card, "div", "content", analysis.workSummary);
      }
      if (!analysis.screenSummary && !analysis.workSummary) addText(card, "div", "muted", "本次分析未返回摘要。");
      screenshotDetailEl.appendChild(card);
    }
    if (!metadata.analyses?.length) addText(screenshotDetailEl, "div", "muted", "尚无分析摘要。手动保存、未送入模型或分析失败的截图可能没有摘要。");
    const details = document.createElement("details");
    addText(details, "summary", "", "截图信息");
    addText(details, "div", "content", JSON.stringify({ id: result.id, uri: result.uri, size: result.size, createdAt: result.createdAt, ...metadata }, null, 2));
    screenshotDetailEl.appendChild(details);
    if (!preserveScroll) document.getElementById("screenshots-main").scrollTop = 0;
  } catch (error) {
    if (version === screenshotSelectionVersion && activeTab === "screenshots") {
      screenshotDetailEl.replaceChildren();
      screenshotErrorEl.textContent = `读取截图失败：${error.message || error}`;
    }
  }
}

async function loadScreenshots(mode = "update") {
  if (screenshotsLoading || clearing) return;
  const epoch = viewGeneration;
  screenshotsLoading = true;
  screenshotsMoreEl.disabled = true;
  try {
    const result = await window.rawLog.listScreenshots({ before: mode === "more" ? screenshotsCursor : null });
    if (activeTab !== "screenshots" || epoch !== viewGeneration) return;
    const oldSelected = screenshots.find(({ id }) => id === selectedScreenshotId);
    if (mode === "reset" || !screenshots.length) {
      screenshots = result.entries;
      screenshotsCursor = result.nextCursor;
    } else {
      const merged = new Map(screenshots.map(entry => [entry.id, entry]));
      for (const entry of result.entries) merged.set(entry.id, entry);
      // Storage returns reverse insertion order; retain it even if capture clocks differ.
      screenshots = mode === "more" ? [...merged.values()] : [
        ...result.entries, ...screenshots.filter(entry => !result.entries.some(item => item.id === entry.id)),
      ];
      if (mode === "more" || screenshotsCursor === null) screenshotsCursor = result.nextCursor;
    }
    screenshotErrorEl.textContent = "";
    renderScreenshots();
    const selected = screenshots.find(({ id }) => id === selectedScreenshotId) || screenshots[0];
    if (selected && (!oldSelected || selected.id !== selectedScreenshotId || mode === "reset" || mode === "activate" ||
      JSON.stringify(selected.metadata) !== JSON.stringify(oldSelected.metadata))) {
      await selectScreenshot(selected, mode === "update" || mode === "activate");
    }
  } catch (error) {
    if (activeTab === "screenshots" && epoch === viewGeneration) screenshotErrorEl.textContent = `读取截图列表失败：${error.message || error}`;
  } finally { screenshotsLoading = false; screenshotsMoreEl.disabled = clearing; }
}

function switchTab(tab) {
  if (clearing) return;
  activeTab = tab;
  selectionVersion++;
  screenshotSelectionVersion++;
  webSelectionVersion++;
  rssSelectionVersion++;
  gitlabSelectionVersion++;
  for (const name of tabNames) {
    const selected = name === tab;
    const button = document.getElementById(`${name}-tab`);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    document.getElementById(`${name}-panel`).hidden = !selected;
  }
  if (tab === "screenshots") { renderScreenshots(); void loadScreenshots("activate"); }
  else if (tab === "web-search") { renderWebList(); void loadWeb("activate"); }
  else if (tab === "rss") { renderRssList(); void loadRss("activate"); }
  else if (tab === "gitlab") { renderGitlabList(); void loadGitlab("activate"); }
  else { renderList(); void load("activate"); }
}

for (const name of tabNames) {
  const button = document.getElementById(`${name}-tab`);
  button.addEventListener("click", () => switchTab(name));
  button.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const visible = tabNames.filter(tab => !document.getElementById(`${tab}-tab`).hidden);
    const index = visible.indexOf(name);
    const target = event.key === "Home" ? visible[0] : event.key === "End" ? visible.at(-1)
      : visible[(index + (event.key === "ArrowLeft" ? -1 : 1) + visible.length) % visible.length];
    switchTab(target);
    document.getElementById(`${target}-tab`).focus();
  });
}
const refresh = mode => activeTab === "screenshots" ? loadScreenshots(mode) : activeTab === "web-search" ? loadWeb(mode)
  : activeTab === "rss" ? loadRss(mode) : activeTab === "gitlab" ? loadGitlab(mode) : load(mode);
document.getElementById("refresh").addEventListener("click", () => void refresh("reset"));
moreEl.addEventListener("click", () => void load("more"));
screenshotsMoreEl.addEventListener("click", () => void loadScreenshots("more"));
webMoreEl.addEventListener("click", () => void loadWeb("more"));
rssMoreEl.addEventListener("click", () => void loadRss("more"));
gitlabMoreEl.addEventListener("click", () => void loadGitlab("more"));
const clearDialog = document.getElementById("clear-dialog");
const clearStatusEl = document.getElementById("clear-status");
const clearErrorEl = document.getElementById("clear-error");
const clearConfirmEl = document.getElementById("clear-confirm");
document.getElementById("clear").addEventListener("click", () => {
  clearErrorEl.textContent = "";
  clearDialog.showModal();
  document.getElementById("clear-cancel").focus();
});
clearDialog.addEventListener("cancel", event => { if (clearing) event.preventDefault(); });
document.getElementById("clear-form").addEventListener("submit", async event => {
  if (event.submitter?.value !== "confirm") return;
  event.preventDefault();
  if (clearing) return;
  clearing = true;
  viewGeneration++;
  selectionVersion++;
  screenshotSelectionVersion++;
  webSelectionVersion++;
  rssSelectionVersion++;
  gitlabSelectionVersion++;
  clearConfirmEl.textContent = "清理并压缩中…";
  clearErrorEl.textContent = "";
  const controls = ["clear", "clear-confirm", "clear-cancel", "refresh", "requests-tab", "screenshots-tab", "web-search-tab", "rss-tab", "gitlab-tab", "more", "screenshots-more", "web-search-more", "rss-more", "gitlab-more"];
  for (const id of controls) document.getElementById(id).disabled = true;
  try {
    const result = await window.rawLog.clear();
    entries = []; nextCursor = null; selectedId = null;
    screenshots = []; screenshotsCursor = null; selectedScreenshotId = null;
    webEntries = []; webCursor = null; webSelectedId = null;
    rssEntries = []; rssCursor = null; rssSelectedId = null;
    gitlabEntries = []; gitlabCursor = null; gitlabSelectedId = null;
    requestsEl.replaceChildren(); messagesEl.replaceChildren(); metaEl.replaceChildren();
    screenshotsEl.replaceChildren(); screenshotDetailEl.replaceChildren();
    webListEl.replaceChildren(); webDetailEl.replaceChildren(); webErrorEl.textContent = "";
    rssListEl.replaceChildren(); rssDetailEl.replaceChildren(); rssErrorEl.textContent = "";
    gitlabListEl.replaceChildren(); gitlabDetailEl.replaceChildren(); gitlabErrorEl.textContent = "";
    errorEl.textContent = screenshotErrorEl.textContent = "";
    moreEl.hidden = screenshotsMoreEl.hidden = webMoreEl.hidden = rssMoreEl.hidden = gitlabMoreEl.hidden = true;
    if (activeTab === "screenshots") renderScreenshots(); else if (activeTab === "web-search") renderWebList();
    else if (activeTab === "rss") renderRssList(); else if (activeTab === "gitlab") renderGitlabList(); else renderList();
    clearStatusEl.className = result.warnings?.length ? "error" : "muted";
    clearStatusEl.textContent = `已清理 ${result.requests} 条请求日志、${result.webSearch || 0} 条网页请求、${result.rss || 0} 条 RSS 获取记录、${result.gitlab || 0} 条 GitLab 查询记录、${result.screenshots} 张截图。` +
      (result.compacted ? "数据库已压缩。" : "") +
      (result.legacyLogs || result.legacyScreenshots ? `另清理 ${result.legacyLogs + result.legacyScreenshots} 个旧文件。` : "") +
      (result.warnings?.length ? `\n${result.warnings.join("\n")}` : "");
    clearDialog.close();
  } catch (error) {
    clearErrorEl.textContent = `清理失败：${error.message || error}`;
  } finally {
    clearing = false;
    clearConfirmEl.textContent = "全部清理";
    for (const id of controls) document.getElementById(id).disabled = false;
    if (!clearDialog.open) void refresh("reset");
  }
});
const timer = setInterval(() => { void updateTabs(); void refresh("update"); }, 2000);
window.addEventListener("beforeunload", () => clearInterval(timer));
void load();
void updateTabs();
