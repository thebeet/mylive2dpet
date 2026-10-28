let busy = false;
let engaged = false;
function engage() {
  if (engaged) return;
  engaged = true;
  void window.petQuestions.activity().catch(() => { engaged = false; });
}
for (const type of ["pointerdown", "keydown", "input", "focusin"]) {
  document.addEventListener(type, engage, true);
}
async function answer(input) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  try { await window.petQuestions.answer(input); }
  catch (error) {
    document.getElementById("error").textContent = error.message || "保存失败，请重试";
    busy = false;
    document.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  }
}
for (const action of ["unknown", "skip", "defer", "remove"]) document.getElementById(action).addEventListener("click", () => void answer({ action }));
document.getElementById("close").addEventListener("click", () => void answer({ action: "defer" }));
document.getElementById("custom").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = document.getElementById("text").value.trim();
  if (text) void answer({ action: "answer", text });
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") void answer({ action: "defer" }); });
void window.petQuestions.current().then((question) => {
  document.getElementById("prompt").textContent = question.prompt;
  document.getElementById("reason").textContent = question.reason;
  question.options.forEach((option, optionIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.addEventListener("click", () => void answer({ action: "answer", optionIndex }));
    document.getElementById("options").appendChild(button);
  });
}).catch((error) => { document.getElementById("error").textContent = error.message || "问题读取失败"; });
