const form = document.getElementById("form");
const time = document.getElementById("time");
const text = document.getElementById("text");
const createButton = document.getElementById("create");
const status = document.getElementById("status");
const filter = document.getElementById("filter");
const tasks = document.getElementById("tasks");
const labels = { pending: "待提交", submitting: "提交中", queued: "已提交", failed: "提交失败", cancelled: "已取消" };
let refreshing = false;
let snapshot = "";

function defaultTime() {
  const date = new Date(Date.now() + 5 * 60000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  time.value = local.toISOString().slice(0, 19);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const records = await window.schedule.list();
    const next = JSON.stringify([filter.value, records]);
    if (next === snapshot) return;
    snapshot = next;
    tasks.replaceChildren();
    const visible = records.filter((task) => filter.value === "all" || ["pending", "submitting", "failed"].includes(task.status));
    if (!visible.length) {
      const empty = document.createElement("li");
      empty.textContent = "暂无通知";
      tasks.append(empty);
    }
    for (const task of visible) {
      const item = document.createElement("li");
      const content = document.createElement("div");
      content.className = "text";
      content.textContent = task.text;
      const details = document.createElement("div");
      details.className = "details";
      details.textContent = `${new Date(task.scheduledAt).toLocaleString()} · ${labels[task.status] || task.status}`;
      if (task.lastError) details.textContent += `\n${task.lastError}`;
      item.append(content, details);
      if (task.status === "pending") {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "cancel";
        cancel.textContent = "取消";
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try {
            await window.schedule.cancel(task.id);
            status.textContent = "通知已取消";
            await refresh();
          } catch (error) {
            status.textContent = error.message || "取消失败";
            cancel.disabled = false;
          }
        });
        item.append(cancel);
      }
      tasks.append(item);
    }
  } catch (error) { status.textContent = error.message || "读取通知失败"; }
  finally { refreshing = false; }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (createButton.disabled) return;
  const date = new Date(time.value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    status.textContent = "请选择未来的有效时间";
    return;
  }
  createButton.disabled = true;
  try {
    await window.schedule.create({ text: text.value, scheduledAt: date.getTime() });
    text.value = "";
    status.textContent = `通知已安排：${date.toLocaleString()}`;
    await refresh();
  } catch (error) { status.textContent = error.message || "添加通知失败"; }
  finally { createButton.disabled = false; }
});

document.getElementById("timezone").textContent = `（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
filter.addEventListener("change", () => void refresh());
defaultTime();
void refresh();
const refreshTimer = setInterval(() => void refresh(), 2000);
window.addEventListener("unload", () => clearInterval(refreshTimer));
