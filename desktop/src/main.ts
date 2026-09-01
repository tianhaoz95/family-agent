import { api, type Task, type Document, type ActivityEntry } from "./api.js";

// ---------- view switching ----------
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
const views = Array.from(document.querySelectorAll<HTMLElement>(".view"));

function showView(name: string) {
  for (const btn of navButtons) btn.classList.toggle("is-active", btn.dataset.view === name);
  for (const view of views) view.classList.toggle("is-active", view.id === `view-${name}`);
  if (name === "tasks") void refreshTasks();
  if (name === "documents") void refreshDocuments();
  if (name === "activity") void refreshActivity();
}

for (const btn of navButtons) {
  btn.addEventListener("click", () => showView(btn.dataset.view!));
}

// ---------- status pill ----------
const statusPill = document.getElementById("status-pill")!;
const statusText = document.getElementById("status-text")!;

async function refreshStatus() {
  try {
    const health = await api.health();
    statusPill.className = "status-pill status-ok";
    statusText.textContent = `local · ${health.model}`;
  } catch {
    statusPill.className = "status-pill status-error";
    statusText.textContent = "agent-core unreachable";
  }
}

// ---------- chat ----------
const chatLog = document.getElementById("chat-log")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;

function appendBubble(role: "user" | "assistant" | "system", text: string) {
  const el = document.createElement("div");
  el.className = `bubble bubble-${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
  appendBubble("user", message);
  const pending = appendBubble("system", "thinking…");
  const submitBtn = chatForm.querySelector("button")!;
  submitBtn.disabled = true;
  try {
    const { reply } = await api.chat(message);
    pending.remove();
    appendBubble("assistant", reply);
  } catch (err) {
    pending.remove();
    appendBubble("system", `Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- tasks ----------
const taskForm = document.getElementById("task-form") as HTMLFormElement;
const taskTitleInput = document.getElementById("task-title") as HTMLInputElement;
const taskDueInput = document.getElementById("task-due") as HTMLInputElement;
const taskList = document.getElementById("task-list")!;

function renderTasks(tasks: Task[]) {
  taskList.innerHTML = "";
  if (tasks.length === 0) {
    taskList.innerHTML = '<li class="empty-state">No tasks yet.</li>';
    return;
  }
  for (const task of tasks) {
    const li = document.createElement("li");
    li.className = `task-row${task.status === "done" ? " is-done" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.status === "done";
    checkbox.disabled = task.status === "done";
    checkbox.addEventListener("change", async () => {
      await api.completeTask(task.id);
      void refreshTasks();
      void refreshActivity();
    });
    const title = document.createElement("span");
    title.className = "task-title";
    title.textContent = task.title;
    li.appendChild(checkbox);
    li.appendChild(title);
    if (task.dueDate) {
      const due = document.createElement("span");
      due.className = "task-due";
      due.textContent = task.dueDate;
      li.appendChild(due);
    }
    taskList.appendChild(li);
  }
}

async function refreshTasks() {
  const { tasks } = await api.listTasks();
  renderTasks(tasks);
}

taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = taskTitleInput.value.trim();
  if (!title) return;
  await api.createTask(title, taskDueInput.value);
  taskTitleInput.value = "";
  taskDueInput.value = "";
  void refreshTasks();
  void refreshActivity();
});

// ---------- documents ----------
const documentForm = document.getElementById("document-form") as HTMLFormElement;
const documentFilenameInput = document.getElementById("document-filename") as HTMLInputElement;
const documentTextInput = document.getElementById("document-text") as HTMLTextAreaElement;
const documentList = document.getElementById("document-list")!;

function renderDocuments(docs: Document[]) {
  documentList.innerHTML = "";
  if (docs.length === 0) {
    documentList.innerHTML = '<li class="empty-state">No documents ingested yet.</li>';
    return;
  }
  for (const doc of docs) {
    const li = document.createElement("li");
    li.className = "document-row";

    const head = document.createElement("div");
    head.className = "document-row-head";
    const name = document.createElement("span");
    name.className = "document-filename";
    name.textContent = doc.filename;
    head.appendChild(name);
    if (doc.extracted?.category) {
      const chip = document.createElement("span");
      chip.className = "category-chip";
      chip.textContent = doc.extracted.category;
      head.appendChild(chip);
    }
    li.appendChild(head);

    const detail = document.createElement("p");
    if (doc.extracted?.summary) {
      detail.className = "document-summary";
      detail.textContent = doc.extracted.summary;
    } else {
      detail.className = "document-pending";
      detail.textContent = "Extracting…";
    }
    li.appendChild(detail);

    documentList.appendChild(li);
  }
}

async function refreshDocuments() {
  const { documents } = await api.listDocuments();
  renderDocuments(documents);
}

documentForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const filename = documentFilenameInput.value.trim();
  const text = documentTextInput.value.trim();
  if (!filename || !text) return;
  await api.ingestDocument(filename, text);
  documentFilenameInput.value = "";
  documentTextInput.value = "";
  void refreshDocuments();
  void refreshActivity();
  // Extraction runs asynchronously server-side; poll a few times so the
  // summary/category chip appears without the user needing to switch tabs.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    await refreshDocuments();
  }
});

// ---------- activity ----------
const activityList = document.getElementById("activity-list")!;

function renderActivity(entries: ActivityEntry[]) {
  activityList.innerHTML = "";
  if (entries.length === 0) {
    activityList.innerHTML = '<li class="empty-state">Nothing has happened yet.</li>';
    return;
  }
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "activity-row";
    const ts = document.createElement("span");
    ts.className = "activity-ts";
    ts.textContent = new Date(entry.ts).toLocaleTimeString();
    const actor = document.createElement("span");
    actor.className = "activity-actor";
    actor.textContent = entry.actor;
    const detail = document.createElement("span");
    detail.className = "activity-detail";
    detail.textContent = entry.detail;
    li.append(ts, actor, detail);
    activityList.appendChild(li);
  }
}

async function refreshActivity() {
  const { activity } = await api.listActivity();
  renderActivity(activity);
}

// ---------- boot ----------
void refreshStatus();
setInterval(() => void refreshStatus(), 5000);
showView("chat");
