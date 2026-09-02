// Bundled locally (no CDN) — the DESIGN.md typeface pair.
import "@fontsource-variable/inter/wght.css";
import "@fontsource/source-serif-4/400.css";
import {
  api,
  toolUrl,
  type Task,
  type Document,
  type ActivityEntry,
  type Settings,
  type SettingsPatch,
  type Tool,
  type Health,
} from "./api.js";

// ---------- view switching ----------
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
const views = Array.from(document.querySelectorAll<HTMLElement>(".view"));

function showView(name: string) {
  closeToolViewer();
  for (const btn of navButtons) btn.classList.toggle("is-active", btn.dataset.view === name);
  for (const view of views) view.classList.toggle("is-active", view.id === `view-${name}`);
  if (name === "tasks") void refreshTasks();
  if (name === "documents") {
    // Opening the tab: if anything is still extracting (e.g. a job left
    // running by a previous session), resume polling so it self-updates.
    void refreshDocuments().then((docs) => {
      if (docs.some((d) => d.extractionStatus === "pending")) void pollForExtraction();
    });
  }
  if (name === "tools") {
    void refreshTools().then((tools) => {
      if (tools.some((t) => t.status === "building")) void pollTools();
    });
  }
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

// Port the tools server is on — learned from /health, used to open a tool.
let toolsPort = 4174;
let toolsEnabled: Health["toolsEnabled"] = "full";

async function refreshStatus() {
  try {
    const health = await api.health();
    statusPill.className = "status-pill status-ok";
    statusText.textContent = `local · ${health.model}`;
    inboxPathEl.textContent = health.inboxDir;
    inboxPathEl.title = health.inboxDir;
    if (health.toolsPort) toolsPort = health.toolsPort;
    if (health.toolsEnabled) toolsEnabled = health.toolsEnabled;
  } catch {
    statusPill.className = "status-pill status-error";
    statusText.textContent = "agent-core unreachable";
  }
}

// ---------- chat ----------
const chatLog = document.getElementById("chat-log")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const chatImageInput = document.getElementById("chat-image-input") as HTMLInputElement;
const chatAttachBtn = document.getElementById("chat-attach-btn") as HTMLButtonElement;
const chatAttachmentsEl = document.getElementById("chat-attachments")!;

// Images staged for the next message, as JPEG data URIs.
let attachedImages: string[] = [];
const MAX_IMAGES = 4;
// Phone photos are huge; the planner model is slow. Cap the long edge and
// re-encode as JPEG before sending — a 4000px photo becomes ~150 KB.
const MAX_IMAGE_EDGE = 1536;

function appendBubble(role: "user" | "assistant" | "system", text: string) {
  document.getElementById("chat-empty")?.remove();
  const el = document.createElement("div");
  el.className = `bubble bubble-${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function appendUserMessage(text: string, images: string[]) {
  document.getElementById("chat-empty")?.remove();
  const el = document.createElement("div");
  el.className = "bubble bubble-user";
  if (images.length) {
    const grid = document.createElement("div");
    grid.className = "bubble-images";
    for (const src of images) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "attached image";
      grid.appendChild(img);
    }
    el.appendChild(grid);
  }
  if (text) {
    const p = document.createElement("div");
    p.className = "bubble-text";
    p.textContent = text;
    el.appendChild(p);
  }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

// Load a file, downscale to at most MAX_IMAGE_EDGE on the long side, return a
// JPEG data URI.
function fileToScaledDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas 2d context"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read image"));
    };
    img.src = url;
  });
}

function renderAttachments() {
  chatAttachmentsEl.innerHTML = "";
  chatAttachmentsEl.hidden = attachedImages.length === 0;
  attachedImages.forEach((src, i) => {
    const chip = document.createElement("div");
    chip.className = "chat-attachment";
    const img = document.createElement("img");
    img.src = src;
    img.alt = "attachment preview";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove image");
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    remove.addEventListener("click", () => {
      attachedImages.splice(i, 1);
      renderAttachments();
    });
    chip.append(img, remove);
    chatAttachmentsEl.appendChild(chip);
  });
}

async function addImageFiles(files: Iterable<File>) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (attachedImages.length >= MAX_IMAGES) {
      appendBubble("system", `Up to ${MAX_IMAGES} images per message.`);
      break;
    }
    try {
      attachedImages.push(await fileToScaledDataUrl(file));
    } catch (err) {
      appendBubble("system", `Couldn't attach ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  renderAttachments();
}

chatAttachBtn.addEventListener("click", () => chatImageInput.click());
chatImageInput.addEventListener("change", () => {
  if (chatImageInput.files) void addImageFiles(Array.from(chatImageInput.files));
  chatImageInput.value = "";
});
// Paste a screenshot straight into the message.
chatInput.addEventListener("paste", (e) => {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null);
  if (files.length) {
    e.preventDefault();
    void addImageFiles(files);
  }
});
// Drag an image file onto the chat area.
for (const evt of ["dragover", "drop"] as const) {
  chatLog.addEventListener(evt, (e) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    if (evt === "drop" && e.dataTransfer?.files) void addImageFiles(Array.from(e.dataTransfer.files));
  });
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
  const typed = chatInput.value.trim();
  const images = attachedImages;
  if (!typed && !images.length) return;
  // The model needs a prompt; supply a default when the user only attached an image.
  const message = typed || "What's in this image?";
  chatInput.value = "";
  attachedImages = [];
  renderAttachments();
  appendUserMessage(typed, images);
  const pending = appendTypingIndicator();
  const submitBtn = chatForm.querySelector('button[type="submit"]') as HTMLButtonElement;
  submitBtn.disabled = true;
  try {
    const { reply } = await api.chat(message, images);
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

async function refreshDocuments(): Promise<Document[]> {
  const { documents } = await api.listDocuments();
  renderDocuments(documents);
  return documents;
}

// Field extraction runs asynchronously server-side and is slow — a local
// model turn can take a couple of minutes, OCR longer. Poll until nothing is
// left `pending` rather than for a fixed (too-short) number of rounds, which
// left the "Extracting…" spinner stuck until the user changed tabs. One
// shared poll: a second upload during extraction rides the same loop, which
// already runs until *every* document is done.
let activeExtractionPoll: Promise<void> | null = null;

function pollForExtraction(): Promise<void> {
  if (!activeExtractionPoll) {
    activeExtractionPoll = runExtractionPoll().finally(() => {
      activeExtractionPoll = null;
    });
  }
  return activeExtractionPoll;
}

async function runExtractionPoll(): Promise<void> {
  const deadline = Date.now() + 6 * 60_000;
  let delay = 1500;
  void refreshActivity();
  while (Date.now() < deadline) {
    const docs = await refreshDocuments().catch(() => null);
    if (docs && !docs.some((d) => d.extractionStatus === "pending")) return;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1000, 5000);
    void refreshActivity();
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

// ---------- tools ----------
const toolForm = document.getElementById("tool-form") as HTMLFormElement;
const toolPromptInput = document.getElementById("tool-prompt") as HTMLInputElement;
const toolStatusEl = document.getElementById("tool-status")!;
const toolList = document.getElementById("tool-list")!;

// Tools open in an <iframe> that fills the content area — the sidebar stays
// visible; navigating away (or the back button / Escape) closes the tool.
const toolViewer = document.getElementById("tool-viewer") as HTMLElement;
const toolFrame = document.getElementById("tool-frame") as HTMLIFrameElement;
const toolViewerTitle = document.getElementById("tool-viewer-title")!;
const toolViewerClose = document.getElementById("tool-viewer-close") as HTMLButtonElement;

function closeToolViewer() {
  if (toolViewer.hidden) return;
  toolViewer.hidden = true;
  toolFrame.removeAttribute("src");
  toolViewerTitle.textContent = "";
}
toolViewerClose.addEventListener("click", () => showView("tools"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !toolViewer.hidden) closeToolViewer();
});

function openTool(tool: Tool) {
  if (!tool.path) return;
  toolViewerTitle.textContent = tool.name;
  toolFrame.src = toolUrl(toolsPort, tool.path);
  toolViewer.hidden = false;
}

function renderTools(tools: Tool[]) {
  toolList.innerHTML = "";
  if (tools.length === 0) {
    toolList.innerHTML = `<li class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/></svg><span>No tools yet. Describe one above, or ask in Chat.</span></li>`;
    return;
  }
  for (const tool of tools) {
    const li = document.createElement("li");
    li.className = "tool-row";

    const head = document.createElement("div");
    head.className = "tool-row-head";
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;
    head.appendChild(name);
    if (tool.kind === "server") {
      const chip = document.createElement("span");
      chip.className = "category-chip";
      chip.textContent = "shared";
      head.appendChild(chip);
    }
    const del = document.createElement("button");
    del.className = "doc-delete";
    del.type = "button";
    del.title = "Delete tool";
    del.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener("click", async () => {
      del.disabled = true;
      try {
        await api.deleteTool(tool.id);
        void refreshTools();
      } catch (err) {
        del.disabled = false;
        toolStatusEl.textContent = `Could not delete: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    head.appendChild(del);
    li.appendChild(head);

    const desc = document.createElement("p");
    desc.className = "document-summary";
    desc.textContent = tool.description;
    li.appendChild(desc);

    const footer = document.createElement("div");
    footer.className = "tool-row-foot";
    if (tool.status === "building") {
      const b = document.createElement("span");
      b.className = "document-pending";
      b.textContent = "Building…";
      footer.appendChild(b);
    } else if (tool.status === "failed") {
      const f = document.createElement("span");
      f.className = "document-failed";
      f.textContent = tool.error ? `Failed: ${tool.error}` : "Build failed.";
      footer.appendChild(f);
    } else {
      const openBtn = document.createElement("button");
      openBtn.className = "btn-primary";
      openBtn.type = "button";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", () => openTool(tool));
      footer.appendChild(openBtn);
    }
    li.appendChild(footer);
    toolList.appendChild(li);
  }
}

async function refreshTools(): Promise<Tool[]> {
  const { tools } = await api.listTools();
  renderTools(tools);
  return tools;
}

let toolsPoll: Promise<void> | null = null;
function pollTools(): Promise<void> {
  if (!toolsPoll) {
    toolsPoll = (async () => {
      const deadline = Date.now() + 8 * 60_000;
      let delay = 2000;
      while (Date.now() < deadline) {
        const tools = await refreshTools().catch(() => null);
        if (tools && !tools.some((t) => t.status === "building")) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 1000, 6000);
        void refreshActivity();
      }
    })().finally(() => {
      toolsPoll = null;
    });
  }
  return toolsPoll;
}

toolForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = toolPromptInput.value.trim();
  if (!prompt) return;
  if (toolsEnabled === "off") {
    toolStatusEl.textContent = "Tool building is disabled on this machine.";
    return;
  }
  toolStatusEl.textContent = "Sending to the builder…";
  try {
    await api.buildTool(prompt);
    toolPromptInput.value = "";
    toolStatusEl.textContent = "Building — this takes a minute or two.";
    void refreshTools();
    void refreshActivity();
    void pollTools();
  } catch (err) {
    toolStatusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
});

// ---------- settings ----------
const settingsModelSelect = document.getElementById("settings-model-select") as HTMLSelectElement;
const settingsModelForm = document.getElementById("settings-model-form") as HTMLFormElement;
const settingsModelStatusEl = document.getElementById("settings-model-status")!;
const settingsOllamaUrlInput = document.getElementById("settings-ollama-url-input") as HTMLInputElement;
const settingsOllamaForm = document.getElementById("settings-ollama-form") as HTMLFormElement;
const settingsOllamaStatusEl = document.getElementById("settings-ollama-status")!;
const settingsInboxDirInput = document.getElementById("settings-inbox-dir") as HTMLInputElement;
const settingsInboxBrowseBtn = document.getElementById("settings-inbox-browse") as HTMLButtonElement;
const settingsForm = document.getElementById("settings-form") as HTMLFormElement;
const settingsStatusEl = document.getElementById("settings-status")!;
const settingsOcrModelSelect = document.getElementById("settings-ocr-model-select") as HTMLSelectElement;
const settingsOcrForm = document.getElementById("settings-ocr-form") as HTMLFormElement;
const settingsOcrStatusEl = document.getElementById("settings-ocr-status")!;
const settingsOcrActiveEl = document.getElementById("settings-ocr-active")!;

// Populate a <select> with the given options, keeping `current` selected even
// if it isn't in `models` (e.g. a model set earlier but not currently pulled).
function fillModelSelect(sel: HTMLSelectElement, models: string[], current: string, blankLabel?: string) {
  const values = [...new Set([...(blankLabel !== undefined ? [""] : []), ...models, current])];
  sel.innerHTML = "";
  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value === "" ? (blankLabel ?? "") : value;
    // Only flag "not pulled" when Ollama actually answered with a list.
    if (value === current && current !== "" && models.length > 0 && !models.includes(value)) {
      opt.textContent = `${value} (not pulled)`;
    }
    sel.appendChild(opt);
  }
  sel.value = current;
}

function setEnvLocked(form: HTMLFormElement, statusEl: HTMLElement, locked: boolean) {
  for (const el of form.querySelectorAll<HTMLElement>("input, select, button")) {
    (el as HTMLInputElement).disabled = locked;
  }
  if (locked) statusEl.textContent = "Pinned by an environment variable — change it there and restart.";
}

async function refreshSettings() {
  try {
    const [settings, ollama] = await Promise.all([api.getSettings(), api.listOllamaModels().catch(() => ({ models: [], reachable: false }))]);
    const models = ollama.models;

    if (document.activeElement !== settingsModelSelect) {
      fillModelSelect(settingsModelSelect, models, settings.model);
    }
    if (document.activeElement !== settingsOcrModelSelect) {
      fillModelSelect(settingsOcrModelSelect, models, settings.ocrModel, "Built-in (Tesseract)");
    }
    settingsOcrActiveEl.textContent = settings.ocrModel || "built-in engine";
    if (document.activeElement !== settingsOllamaUrlInput) {
      settingsOllamaUrlInput.value = settings.ollamaBaseUrl;
    }
    if (document.activeElement !== settingsInboxDirInput) {
      settingsInboxDirInput.value = settings.inboxDir;
    }

    setEnvLocked(settingsModelForm, settingsModelStatusEl, settings.envLocked.model);
    setEnvLocked(settingsOllamaForm, settingsOllamaStatusEl, settings.envLocked.ollamaBaseUrl);
    setEnvLocked(settingsForm, settingsStatusEl, settings.envLocked.inboxDir);
    setEnvLocked(settingsOcrForm, settingsOcrStatusEl, settings.envLocked.ocrModel);
    // The Browse button is Tauri-only; re-hide/disable handled separately.
    settingsInboxBrowseBtn.hidden = !isTauri();
    if (settings.envLocked.inboxDir) settingsInboxBrowseBtn.disabled = true;

    if (!ollama.reachable) {
      settingsModelStatusEl.textContent = "Ollama isn't reachable — can't list models.";
    }
  } catch (err) {
    settingsStatusEl.textContent = `Could not load settings: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Save one setting; report to its own status line.
async function saveSetting(patch: SettingsPatch, statusEl: HTMLElement, okMsg: (s: Settings) => string) {
  statusEl.textContent = "Saving…";
  try {
    const updated = await api.updateSettings(patch);
    statusEl.textContent = okMsg(updated);
    void refreshStatus();
    void refreshSettings();
  } catch (err) {
    statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

settingsModelForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const model = settingsModelSelect.value;
  if (model) void saveSetting({ model }, settingsModelStatusEl, (s) => `Saved — assistant now uses ${s.model}`);
});

settingsOllamaForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const ollamaBaseUrl = settingsOllamaUrlInput.value.trim();
  if (ollamaBaseUrl) void saveSetting({ ollamaBaseUrl }, settingsOllamaStatusEl, (s) => `Saved — Ollama at ${s.ollamaBaseUrl}`);
});

settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const inboxDir = settingsInboxDirInput.value.trim();
  if (inboxDir) void saveSetting({ inboxDir }, settingsStatusEl, (s) => `Saved — now watching ${s.inboxDir}`);
});

settingsOcrForm.addEventListener("submit", (e) => {
  e.preventDefault();
  // "" is valid here — it means "use the built-in engine".
  const ocrModel = settingsOcrModelSelect.value;
  void saveSetting({ ocrModel }, settingsOcrStatusEl, (s) =>
    s.ocrModel ? `Saved — OCR now uses ${s.ocrModel}` : "Saved — OCR uses the built-in engine"
  );
});

// Native directory picker (Tauri only). Falls back to typing the path when
// the app runs as a plain web page (vite preview, tests).
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

settingsInboxBrowseBtn.addEventListener("click", async () => {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose the watched folder",
      defaultPath: settingsInboxDirInput.value || undefined,
    });
    if (typeof picked === "string") {
      settingsInboxDirInput.value = picked;
      settingsForm.requestSubmit();
    }
  } catch (err) {
    settingsStatusEl.textContent = `Could not open the folder picker: ${err instanceof Error ? err.message : String(err)}`;
  }
});

// ---------- boot ----------
void refreshStatus();
setInterval(() => void refreshStatus(), 5000);
showView("chat");
