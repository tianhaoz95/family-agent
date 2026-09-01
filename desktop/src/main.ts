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
  if (name === "settings") void refreshSettings();
}

for (const btn of navButtons) {
  btn.addEventListener("click", () => showView(btn.dataset.view!));
}

// ---------- status pill ----------
const statusPill = document.getElementById("status-pill")!;
const statusText = document.getElementById("status-text")!;
const inboxPathEl = document.getElementById("inbox-path")!;

async function refreshStatus() {
  try {
    const health = await api.health();
    statusPill.className = "status-pill status-ok";
    statusText.textContent = `local · ${health.model}`;
    inboxPathEl.textContent = health.inboxDir;
    inboxPathEl.title = health.inboxDir;
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
  document.getElementById("chat-empty")?.remove();
  const el = document.createElement("div");
  el.className = `bubble bubble-${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function appendTypingIndicator() {
  const el = document.createElement("div");
  el.className = "bubble-typing";
  el.setAttribute("aria-label", "Assistant is thinking");
  el.innerHTML = "<span></span><span></span><span></span>";
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

// Small inline icons for empty states — keeps them from reading as an error.
const EMPTY_ICONS: Record<string, string> = {
  tasks: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  documents: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};

function emptyState(kind: keyof typeof EMPTY_ICONS, text: string) {
  return `<li class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EMPTY_ICONS[kind]}</svg><span>${text}</span></li>`;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
  appendBubble("user", message);
  const pending = appendTypingIndicator();
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
    taskList.innerHTML = emptyState("tasks", "No tasks yet. Add one above or ask in Chat.");
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
const documentUploadForm = document.getElementById("document-upload-form") as HTMLFormElement;
const documentFileInput = document.getElementById("document-file-input") as HTMLInputElement;
const documentUploadStatus = document.getElementById("document-upload-status")!;
const documentForm = document.getElementById("document-form") as HTMLFormElement;
const documentFilenameInput = document.getElementById("document-filename") as HTMLInputElement;
const documentTextInput = document.getElementById("document-text") as HTMLTextAreaElement;
const documentList = document.getElementById("document-list")!;

function renderDocuments(docs: Document[]) {
  documentList.innerHTML = "";
  if (docs.length === 0) {
    documentList.innerHTML = emptyState("documents", "No documents yet. Upload one above or drop a file in the watched folder.");
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
    if (doc.sourcePath) {
      const tag = document.createElement("span");
      tag.className = "tag tag-local";
      tag.textContent = "watched folder";
      tag.title = doc.sourcePath;
      head.appendChild(tag);
    }
    if (doc.extracted?.category) {
      const chip = document.createElement("span");
      chip.className = "category-chip";
      chip.textContent = doc.extracted.category;
      head.appendChild(chip);
    }

    const del = document.createElement("button");
    del.className = "doc-delete";
    del.type = "button";
    del.title = "Delete document";
    del.setAttribute("aria-label", `Delete ${doc.filename}`);
    del.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener("click", async () => {
      del.disabled = true;
      try {
        await api.deleteDocument(doc.id);
        void refreshDocuments();
        void refreshActivity();
      } catch (err) {
        del.disabled = false;
        documentUploadStatus.textContent = `Could not delete: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    head.appendChild(del);
    li.appendChild(head);

    if (doc.extracted?.summary) {
      const detail = document.createElement("p");
      detail.className = "document-summary";
      detail.textContent = doc.extracted.summary;
      li.appendChild(detail);
    } else if (doc.extractionStatus === "failed") {
      const failed = document.createElement("div");
      failed.className = "document-failed";
      const msg = document.createElement("span");
      msg.textContent = "Couldn't read this document.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "doc-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        retry.textContent = "Retrying…";
        try {
          await api.retryExtraction(doc.id);
          void pollForExtraction();
        } catch (err) {
          retry.disabled = false;
          retry.textContent = "Retry";
          documentUploadStatus.textContent = `Retry failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      });
      failed.append(msg, retry);
      li.appendChild(failed);
    } else {
      const detail = document.createElement("p");
      detail.className = "document-pending";
      detail.textContent = "Extracting…";
      li.appendChild(detail);
    }

    documentList.appendChild(li);
  }
}

async function refreshDocuments() {
  const { documents } = await api.listDocuments();
  renderDocuments(documents);
}

// Extraction runs asynchronously server-side; poll a few times afterward so
// the summary/category chip appears without the user needing to switch tabs.
async function pollForExtraction() {
  void refreshDocuments();
  void refreshActivity();
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    await refreshDocuments();
  }
}

documentForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const filename = documentFilenameInput.value.trim();
  const text = documentTextInput.value.trim();
  if (!filename || !text) return;
  await api.ingestDocument(filename, text);
  documentFilenameInput.value = "";
  documentTextInput.value = "";
  void pollForExtraction();
});

documentUploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = documentFileInput.files?.[0];
  if (!file) return;
  const submitBtn = documentUploadForm.querySelector("button")!;
  submitBtn.disabled = true;
  documentUploadStatus.textContent = `Uploading "${file.name}"…`;
  try {
    const { document: doc } = await api.uploadDocument(file);
    documentUploadStatus.textContent = `Uploaded "${doc.filename}" — extracting…`;
    documentFileInput.value = "";
    await pollForExtraction();
    documentUploadStatus.textContent = "";
  } catch (err) {
    documentUploadStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- activity ----------
const activityList = document.getElementById("activity-list")!;

function renderActivity(entries: ActivityEntry[]) {
  activityList.innerHTML = "";
  if (entries.length === 0) {
    activityList.innerHTML = emptyState("activity", "Nothing has happened yet.");
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

// ---------- settings ----------
const settingsModelEl = document.getElementById("settings-model")!;
const settingsOllamaUrlEl = document.getElementById("settings-ollama-url")!;
const settingsInboxDirInput = document.getElementById("settings-inbox-dir") as HTMLInputElement;
const settingsForm = document.getElementById("settings-form") as HTMLFormElement;
const settingsStatusEl = document.getElementById("settings-status")!;

async function refreshSettings() {
  try {
    const settings = await api.getSettings();
    settingsModelEl.textContent = settings.model;
    settingsOllamaUrlEl.textContent = settings.ollamaBaseUrl;
    // Don't clobber text the user is mid-typing.
    if (document.activeElement !== settingsInboxDirInput) {
      settingsInboxDirInput.value = settings.inboxDir;
    }
  } catch (err) {
    settingsStatusEl.textContent = `Could not load settings: ${err instanceof Error ? err.message : String(err)}`;
  }
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const newDir = settingsInboxDirInput.value.trim();
  if (!newDir) return;
  settingsStatusEl.textContent = "Saving…";
  try {
    const updated = await api.updateSettings(newDir);
    settingsStatusEl.textContent = `Saved — now watching ${updated.inboxDir}`;
    void refreshStatus();
  } catch (err) {
    settingsStatusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
});

// ---------- boot ----------
void refreshStatus();
setInterval(() => void refreshStatus(), 5000);
showView("chat");
