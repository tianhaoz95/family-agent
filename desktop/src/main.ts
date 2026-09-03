// Bundled locally (no CDN) — the DESIGN.md typeface pair.
import "@fontsource-variable/inter/wght.css";
import "@fontsource/source-serif-4/400.css";
import {
  api,
  toolUrl,
  setToken,
  clearToken,
  SIGNED_OUT_EVENT,
  type Task,
  type Document,
  type ActivityEntry,
  type Settings,
  type SettingsPatch,
  type Tool,
  type Health,
  type User,
  AGENT_SENDER_ID,
  type Channel,
  type Message,
  type FamilyMember,
  type StickyNote,
  type NoteScope,
  type ChatReference,
} from "./api.js";
import { startRecording, type Recording } from "./audio.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { renderPdf, type PdfRender } from "./pdfPreview.js";

// The planner model replies in Markdown; render it. Assistant text only —
// user and system bubbles stay plain text.
marked.setOptions({ breaks: true, gfm: true });
function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    ADD_ATTR: ["target"],
  });
}

// ---------- view switching ----------
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
const views = Array.from(document.querySelectorAll<HTMLElement>(".view"));

function showView(name: string) {
  closeToolViewer();
  closeSidePanel();
  for (const btn of navButtons) btn.classList.toggle("is-active", btn.dataset.view === name);
  for (const view of views) view.classList.toggle("is-active", view.id === `view-${name}`);
  // Stop any view-scoped polling loops the previous view started.
  if (name !== "messages") stopMessagePolling();
  if (name !== "board") stopBoardPolling();
  if (name === "tasks") void refreshTasks();
  if (name === "messages") void enterMessages();
  if (name === "board") void enterBoard();
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
  if (name === "family") void refreshUsers();
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
// Whether the server offers speech-to-text — learned from /health, gates the
// chat mic button.
let voiceEnabled = false;

async function refreshStatus() {
  try {
    const health = await api.health();
    statusPill.className = "status-pill status-ok";
    statusText.textContent = `local · ${health.model}`;
    if (health.toolsPort) toolsPort = health.toolsPort;
    if (health.toolsEnabled) toolsEnabled = health.toolsEnabled;
    voiceEnabled = health.asrEnabled === true;
    chatMicBtn.hidden = !voiceEnabled;
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
const chatMicBtn = document.getElementById("chat-mic-btn") as HTMLButtonElement;
const chatAttachmentsEl = document.getElementById("chat-attachments")!;
const chatNewBtn = document.getElementById("chat-new-btn") as HTMLButtonElement;
const chatSendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement;
const chatStopBtn = document.getElementById("chat-stop-btn") as HTMLButtonElement;

// The empty-state block, kept so "New chat" can put it back after it's removed.
const chatEmptyEl = document.getElementById("chat-empty")!;

// Set while a reply is in flight so the Stop button can cancel it.
let chatAbort: AbortController | null = null;

// Images staged for the next message, as JPEG data URIs. Managed by an
// imageTray (see makeImageTray) — the same composer attachment behaviour is
// reused by the family-chat message composer.
const MAX_IMAGES = 4;
// Phone photos are huge; the planner model is slow. Cap the long edge and
// re-encode as JPEG before sending — a 4000px photo becomes ~150 KB.
const MAX_IMAGE_EDGE = 1536;

// Links inside a rendered reply must not navigate the Tauri webview away from
// the app — open them in the user's browser instead.
chatLog.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest("a");
  if (link?.href) {
    e.preventDefault();
    window.open(link.href, "_blank", "noopener");
  }
});

function hideChatEmpty() {
  if (chatEmptyEl.isConnected) chatEmptyEl.remove();
}

function appendBubble(role: "user" | "assistant" | "system", text: string) {
  hideChatEmpty();
  const el = document.createElement("div");
  el.className = `bubble bubble-${role}`;
  if (role === "assistant") {
    el.classList.add("bubble-markdown");
    el.innerHTML = renderMarkdown(text);
  } else {
    el.textContent = text;
  }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function appendUserMessage(text: string, images: string[]) {
  hideChatEmpty();
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

/** A composer image tray: staged data URIs + a thumbnail strip with remove
 *  buttons. Chat and family-chat both use one so attaching behaves identically. */
interface ImageTray {
  images: string[];
  addFiles(files: Iterable<File>): Promise<void>;
  clear(): void;
}
function makeImageTray(trayEl: HTMLElement, notify: (msg: string) => void): ImageTray {
  const tray: ImageTray = {
    images: [],
    async addFiles(files) {
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        if (tray.images.length >= MAX_IMAGES) {
          notify(`Up to ${MAX_IMAGES} images per message.`);
          break;
        }
        try {
          tray.images.push(await fileToScaledDataUrl(file));
        } catch (err) {
          notify(`Couldn't attach ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      render();
    },
    clear() {
      tray.images = [];
      render();
    },
  };
  function render() {
    trayEl.innerHTML = "";
    trayEl.hidden = tray.images.length === 0;
    tray.images.forEach((src, i) => {
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
        tray.images.splice(i, 1);
        render();
      });
      chip.append(img, remove);
      trayEl.appendChild(chip);
    });
  }
  return tray;
}

/** Wire a text input for image paste + a drop target to feed an ImageTray. */
function wireImagePasteAndDrop(tray: ImageTray, pasteTarget: HTMLElement, dropTarget: HTMLElement) {
  pasteTarget.addEventListener("paste", (e) => {
    const ev = e as ClipboardEvent;
    const files = Array.from(ev.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length) {
      e.preventDefault();
      void tray.addFiles(files);
    }
  });
  for (const evt of ["dragover", "drop"] as const) {
    dropTarget.addEventListener(evt, (e) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
      if (evt === "drop" && e.dataTransfer?.files) void tray.addFiles(Array.from(e.dataTransfer.files));
    });
  }
}

const chatTray = makeImageTray(chatAttachmentsEl, (m) => appendBubble("system", m));

chatAttachBtn.addEventListener("click", () => chatImageInput.click());
chatImageInput.addEventListener("change", () => {
  if (chatImageInput.files) void chatTray.addFiles(Array.from(chatImageInput.files));
  chatImageInput.value = "";
});
wireImagePasteAndDrop(chatTray, chatInput, chatLog);

// ---------- voice input ----------
// Tap once to start recording, tap again to stop; the transcript is dropped
// into the input for the user to review and send (never auto-sent).
let activeRecording: Recording | null = null;

function setMicRecording(on: boolean) {
  chatMicBtn.classList.toggle("is-recording", on);
  chatMicBtn.setAttribute("aria-pressed", String(on));
  chatMicBtn.title = on ? "Stop recording" : "Voice input";
}

chatMicBtn.addEventListener("click", async () => {
  if (activeRecording) {
    const rec = activeRecording;
    activeRecording = null;
    setMicRecording(false);
    chatMicBtn.disabled = true;
    try {
      const wav = await rec.stop();
      const { text } = await api.transcribe(wav);
      if (text) {
        const existing = chatInput.value.trim();
        chatInput.value = existing ? `${existing} ${text}` : text;
        chatInput.focus();
      } else {
        appendBubble("system", "Didn't catch any speech — try again, a bit closer to the mic.");
      }
    } catch (err) {
      appendBubble("system", `Voice input failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      chatMicBtn.disabled = false;
    }
    return;
  }
  try {
    activeRecording = await startRecording();
    setMicRecording(true);
  } catch (err) {
    appendBubble(
      "system",
      `Couldn't start recording: ${err instanceof Error ? err.message : String(err)}. ` +
        "Check that a microphone is connected and this app has permission to use it."
    );
  }
});

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

// Grow the composer with its content, up to the CSS max-height.
function autoGrowChatInput() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight}px`;
}
chatInput.addEventListener("input", autoGrowChatInput);

// Enter sends; Shift+Enter (or Enter mid-composition, e.g. an IME) inserts a
// newline. Matches every other chat app.
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

// Toggle the composer between "ready to send" and "reply in flight" (Stop).
function setChatPending(pending: boolean) {
  chatSendBtn.hidden = pending;
  chatStopBtn.hidden = !pending;
  chatSendBtn.disabled = pending;
}

// Clear the transcript and cancel anything in flight — a fresh conversation.
// The agent keeps no server-side history, so this is purely the visible thread.
function startNewChat() {
  chatAbort?.abort();
  chatAbort = null;
  chatLog.innerHTML = "";
  chatLog.appendChild(chatEmptyEl);
  chatTray.clear();
  chatInput.value = "";
  autoGrowChatInput();
  setChatPending(false);
  chatInput.focus();
}
chatNewBtn.addEventListener("click", startNewChat);
chatStopBtn.addEventListener("click", () => chatAbort?.abort());

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (chatAbort) return; // a reply is already in flight
  const typed = chatInput.value.trim();
  const images = chatTray.images.slice();
  if (!typed && !images.length) return;
  // The model needs a prompt; supply a default when the user only attached an image.
  const message = typed || "What's in this image?";
  chatInput.value = "";
  autoGrowChatInput();
  chatTray.clear();
  appendUserMessage(typed, images);
  const pending = appendTypingIndicator();
  chatAbort = new AbortController();
  setChatPending(true);
  try {
    const { reply, references } = await api.chat(message, images, chatAbort.signal);
    pending.remove();
    const bubble = appendBubble("assistant", reply);
    if (references?.length) appendReferences(bubble, references);
  } catch (err) {
    pending.remove();
    if (err instanceof DOMException && err.name === "AbortError") {
      appendBubble("system", "Stopped.");
    } else {
      appendBubble("system", `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    chatAbort = null;
    setChatPending(false);
    chatInput.focus();
  }
});

// ---------- tasks ----------
const taskForm = document.getElementById("task-form") as HTMLFormElement;
const taskTitleInput = document.getElementById("task-title") as HTMLInputElement;
const taskDueInput = document.getElementById("task-due") as HTMLInputElement;
const taskTimeInput = document.getElementById("task-time") as HTMLInputElement;
const taskList = document.getElementById("task-list")!;
const taskCalendar = document.getElementById("task-calendar") as HTMLElement;
const calGrid = document.getElementById("cal-grid")!;
const calLabel = document.getElementById("cal-label")!;
const calUnscheduled = document.getElementById("cal-unscheduled") as HTMLElement;
const calUnscheduledList = document.getElementById("cal-unscheduled-list")!;
const calTimeGrid = document.getElementById("cal-timegrid") as HTMLElement;
const calTgHead = document.getElementById("cal-tg-head")!;
const calAllDay = document.getElementById("cal-allday")!;
const calHours = document.getElementById("cal-hours")!;
const taskViewButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".seg-toggle [data-taskview]")
);

type TaskView = "list" | "day" | "3day" | "week" | "month";
const TASK_VIEWS: TaskView[] = ["list", "day", "3day", "week", "month"];
const TASK_VIEW_KEY = "family-agent:taskView";
const HOUR_H = 44; // px per hour in the time grid — keep in sync with .cal-daycol

function loadTaskView(): TaskView {
  const raw = localStorage.getItem(TASK_VIEW_KEY);
  if (raw === "calendar") return "month"; // legacy value from the first version
  if (raw && (TASK_VIEWS as string[]).includes(raw)) return raw as TaskView;
  return "week";
}
let taskView: TaskView = loadTaskView();
// Anchor day for the calendar range (midnight, local).
let calAnchor = startOfDay(new Date());
let lastTasks: Task[] = [];

// ---- date helpers (local, no timezone drift) ----
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfWeekMon(d: Date): Date {
  const s = startOfDay(d);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function dueKey(task: Task): string | null {
  return task.dueDate ? task.dueDate.slice(0, 10) : null;
}
function parseHM(s: string | null): { h: number; m: number } | null {
  if (!s) return null;
  const [h, m] = s.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { h, m };
}
/** Days visible for the current non-month view. */
function rangeDays(): Date[] {
  const count = taskView === "day" ? 1 : taskView === "3day" ? 3 : 7;
  const start = taskView === "week" ? startOfWeekMon(calAnchor) : startOfDay(calAnchor);
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

function bucketByDay(tasks: Task[]) {
  const byDay = new Map<string, Task[]>();
  const unscheduled: Task[] = [];
  for (const t of tasks) {
    const key = dueKey(t);
    if (!key) {
      unscheduled.push(t);
      continue;
    }
    const bucket = byDay.get(key);
    if (bucket) bucket.push(t);
    else byDay.set(key, [t]);
  }
  return { byDay, unscheduled };
}

// ---- list view ----
function renderTasks(tasks: Task[]) {
  taskList.innerHTML = "";
  if (tasks.length === 0) {
    taskList.innerHTML = emptyState("tasks", "No events yet. Add one above or ask in Chat.");
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
      due.textContent = task.dueTime ? `${task.dueDate} ${task.dueTime}` : task.dueDate;
      li.appendChild(due);
    }
    taskList.appendChild(li);
  }
}

// ---- calendar shared bits ----
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function makeTaskChip(task: Task): HTMLElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = `cal-task${task.status === "done" ? " is-done" : ""}`;
  chip.textContent = task.dueTime ? `${task.dueTime} ${task.title}` : task.title;
  chip.title = task.title;
  chip.draggable = true;
  chip.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData("text/plain", task.id);
    chip.classList.add("is-dragging");
  });
  chip.addEventListener("dragend", () => chip.classList.remove("is-dragging"));
  chip.addEventListener("click", async () => {
    if (task.status === "done") return;
    await api.completeTask(task.id);
    void refreshTasks();
    void refreshActivity();
  });
  return chip;
}

async function moveTask(id: string, patch: { dueDate?: string | null; dueTime?: string | null }) {
  await api.rescheduleTask(id, patch);
  void refreshTasks();
  void refreshActivity();
}

function wireDropTarget(
  el: HTMLElement,
  patchFor: (e: DragEvent) => { dueDate?: string | null; dueTime?: string | null }
) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("is-drop-target");
  });
  el.addEventListener("dragleave", () => el.classList.remove("is-drop-target"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("is-drop-target");
    const id = e.dataTransfer?.getData("text/plain");
    if (id) void moveTask(id, patchFor(e));
  });
}

function openQuickAdd(cell: HTMLElement, day: string, time?: string, topPx?: number) {
  if (cell.querySelector(".cal-add")) return;
  const input = document.createElement("input");
  input.className = "cal-add";
  input.type = "text";
  input.placeholder = time ? `New event · ${time}` : "New event";
  if (topPx !== undefined) {
    input.style.position = "absolute";
    input.style.top = `${topPx}px`;
    input.style.left = "2px";
    input.style.right = "2px";
    input.style.width = "auto";
    input.style.zIndex = "5";
  }
  const close = () => input.remove();
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") {
      const title = input.value.trim();
      close();
      if (!title) return;
      await api.createTask(title, day, time);
      void refreshTasks();
      void refreshActivity();
    }
  });
  input.addEventListener("blur", close);
  cell.appendChild(input);
  input.focus();
}

// ---- month grid ----
function renderMonthGrid(tasks: Task[]) {
  const first = startOfMonth(calAnchor);
  calLabel.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const { byDay, unscheduled } = bucketByDay(tasks);

  calGrid.innerHTML = "";
  for (const wd of WEEKDAYS) {
    const h = document.createElement("div");
    h.className = "cal-weekday";
    h.textContent = wd;
    calGrid.appendChild(h);
  }

  const start = addDays(first, -((first.getDay() + 6) % 7));
  const todayKey = isoDay(new Date());

  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const key = isoDay(d);
    const cell = document.createElement("div");
    cell.className = "cal-day";
    if (d.getMonth() !== first.getMonth()) cell.classList.add("cal-day--other-month");
    if (key === todayKey) cell.classList.add("cal-day--today");

    const num = document.createElement("span");
    num.className = "cal-day-num";
    num.textContent = String(d.getDate());
    cell.appendChild(num);

    for (const t of byDay.get(key) ?? []) cell.appendChild(makeTaskChip(t));

    cell.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".cal-task, .cal-add")) openQuickAdd(cell, key);
    });
    // Dropping onto a month cell just changes the date, keeping any time.
    wireDropTarget(cell, () => ({ dueDate: key }));
    calGrid.appendChild(cell);
  }

  calUnscheduledList.innerHTML = "";
  if (unscheduled.length === 0) {
    const span = document.createElement("span");
    span.className = "cal-unscheduled-empty";
    span.textContent = "Nothing without a due date.";
    calUnscheduledList.appendChild(span);
  } else {
    for (const t of unscheduled) calUnscheduledList.appendChild(makeTaskChip(t));
  }
}

// ---- day / 3-day / week time grid ----
function renderTimeGrid(tasks: Task[]) {
  const days = rangeDays();
  const cols = `4rem repeat(${days.length}, 1fr)`;
  calTgHead.style.gridTemplateColumns = cols;
  calAllDay.style.gridTemplateColumns = cols;

  const label =
    days.length === 1
      ? days[0].toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
      : `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[
          days.length - 1
        ].toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  calLabel.textContent = label;

  const { byDay } = bucketByDay(tasks);
  const todayKey = isoDay(new Date());

  // Header row.
  calTgHead.innerHTML = '<div class="cal-tg-corner"></div>';
  for (const d of days) {
    const h = document.createElement("div");
    h.className = "cal-tg-dayname";
    if (isoDay(d) === todayKey) h.classList.add("is-today");
    h.textContent = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
    calTgHead.appendChild(h);
  }

  // All-day row (date-only tasks).
  calAllDay.innerHTML = '<div class="cal-allday-label">all-day</div>';
  for (const d of days) {
    const key = isoDay(d);
    const cell = document.createElement("div");
    cell.className = "cal-allday-cell";
    for (const t of (byDay.get(key) ?? []).filter((t) => !t.dueTime)) {
      cell.appendChild(makeTaskChip(t));
    }
    cell.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".cal-task, .cal-add")) openQuickAdd(cell, key);
    });
    wireDropTarget(cell, () => ({ dueDate: key, dueTime: null }));
    calAllDay.appendChild(cell);
  }

  // Hours body — a flex row: [time gutter] [day column]*N, each column full height.
  calHours.innerHTML = "";
  const body = document.createElement("div");
  body.className = "cal-hours-body";
  body.style.height = `${HOUR_H * 24}px`;

  const gutter = document.createElement("div");
  gutter.className = "cal-gutter";
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement("div");
    lbl.className = "cal-hourlabel";
    lbl.style.height = `${HOUR_H}px`;
    lbl.textContent = h === 0 ? "" : `${String(h).padStart(2, "0")}:00`;
    gutter.appendChild(lbl);
  }
  body.appendChild(gutter);

  days.forEach((d) => {
    const key = isoDay(d);
    const col = document.createElement("div");
    col.className = "cal-daycol";
    if (key === todayKey) col.classList.add("is-today");

    for (const t of (byDay.get(key) ?? []).filter((t) => t.dueTime)) {
      const hm = parseHM(t.dueTime)!;
      const block = document.createElement("button");
      block.type = "button";
      block.className = `cal-event${t.status === "done" ? " is-done" : ""}`;
      block.style.top = `${((hm.h * 60 + hm.m) / 60) * HOUR_H}px`;
      block.style.height = `${HOUR_H - 4}px`;
      block.textContent = `${t.dueTime} ${t.title}`;
      block.title = t.title;
      block.draggable = true;
      block.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", t.id);
        block.classList.add("is-dragging");
      });
      block.addEventListener("dragend", () => block.classList.remove("is-dragging"));
      block.addEventListener("click", async () => {
        if (t.status === "done") return;
        await api.completeTask(t.id);
        void refreshTasks();
        void refreshActivity();
      });
      col.appendChild(block);
    }

    const slotMinutes = (e: MouseEvent): number => {
      const rect = col.getBoundingClientRect();
      const mins = Math.max(0, Math.min(23 * 60 + 30, ((e.clientY - rect.top) / HOUR_H) * 60));
      return Math.round(mins / 30) * 30;
    };
    const asHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    col.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".cal-event, .cal-add")) return;
      const m = slotMinutes(e);
      openQuickAdd(col, key, asHM(m), (m / 60) * HOUR_H);
    });
    wireDropTarget(col, (e) => ({ dueDate: key, dueTime: asHM(slotMinutes(e as MouseEvent)) }));
    body.appendChild(col);
  });

  calHours.appendChild(body);
  calHours.scrollTop = 7 * HOUR_H; // open around 07:00
}

function applyTaskView() {
  for (const btn of taskViewButtons) {
    btn.classList.toggle("is-active", btn.dataset.taskview === taskView);
  }
  const isList = taskView === "list";
  const isMonth = taskView === "month";
  const isTime = !isList && !isMonth;

  taskForm.hidden = !isList;
  taskList.hidden = !isList;
  taskCalendar.hidden = isList;
  calGrid.hidden = !isMonth;
  calUnscheduled.hidden = !isMonth;
  calTimeGrid.hidden = !isTime;

  if (isList) renderTasks(lastTasks);
  else if (isMonth) renderMonthGrid(lastTasks);
  else renderTimeGrid(lastTasks);
}

for (const btn of taskViewButtons) {
  btn.addEventListener("click", () => {
    const v = btn.dataset.taskview as TaskView;
    if (!TASK_VIEWS.includes(v)) return;
    taskView = v;
    localStorage.setItem(TASK_VIEW_KEY, taskView);
    applyTaskView();
  });
}

wireDropTarget(calUnscheduled, () => ({ dueDate: null }));

function shiftAnchor(dir: 1 | -1) {
  if (taskView === "month") {
    calAnchor = new Date(calAnchor.getFullYear(), calAnchor.getMonth() + dir, 1);
  } else {
    calAnchor = addDays(calAnchor, dir * (taskView === "day" ? 1 : taskView === "3day" ? 3 : 7));
  }
  applyTaskView();
}
document.getElementById("cal-prev")!.addEventListener("click", () => shiftAnchor(-1));
document.getElementById("cal-next")!.addEventListener("click", () => shiftAnchor(1));
document.getElementById("cal-today")!.addEventListener("click", () => {
  calAnchor = startOfDay(new Date());
  applyTaskView();
});

async function refreshTasks() {
  const { tasks } = await api.listTasks();
  lastTasks = tasks;
  applyTaskView();
}

taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = taskTitleInput.value.trim();
  if (!title) return;
  await api.createTask(title, taskDueInput.value, taskTimeInput.value);
  taskTitleInput.value = "";
  taskDueInput.value = "";
  taskTimeInput.value = "";
  void refreshTasks();
  void refreshActivity();
});

// ---------- documents ----------
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

    const preview = document.createElement("button");
    preview.className = "doc-preview";
    preview.type = "button";
    preview.textContent = "Preview";
    preview.title = "Open a preview in the side panel";
    preview.addEventListener("click", () => void openDocumentPanel(doc.id));
    head.appendChild(preview);

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

// Picking a file uploads it immediately — there's no separate Upload button.
documentFileInput.addEventListener("change", async () => {
  const file = documentFileInput.files?.[0];
  if (!file) return;
  documentFileInput.disabled = true;
  documentUploadStatus.textContent = `Uploading "${file.name}"…`;
  try {
    const { document: doc } = await api.uploadDocument(file);
    documentUploadStatus.textContent = `Uploaded "${doc.filename}" — extracting…`;
    await pollForExtraction();
    documentUploadStatus.textContent = "";
  } catch (err) {
    documentUploadStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    documentFileInput.value = "";
    documentFileInput.disabled = false;
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
const settingsAsrModelInput = document.getElementById("settings-asr-model-input") as HTMLInputElement;
const settingsAsrForm = document.getElementById("settings-asr-form") as HTMLFormElement;
const settingsAsrStatusEl = document.getElementById("settings-asr-status")!;
const settingsAsrHintEl = document.getElementById("settings-asr-hint")!;
const settingsServerNameInput = document.getElementById("settings-servername-input") as HTMLInputElement;
const settingsServerNameForm = document.getElementById("settings-servername-form") as HTMLFormElement;
const settingsServerNameStatusEl = document.getElementById("settings-servername-status")!;
const accountNameEl = document.getElementById("account-name")!;
const accountRoleEl = document.getElementById("account-role")!;
const passwordForm = document.getElementById("password-form") as HTMLFormElement;
const accountPasswordInput = document.getElementById("account-password") as HTMLInputElement;
const accountStatusEl = document.getElementById("account-status")!;

// The signed-in user, set during boot() and after any account change.
let currentUser: User | null = null;

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
    if (document.activeElement !== settingsAsrModelInput) {
      settingsAsrModelInput.value = settings.asrModel;
    }
    settingsAsrHintEl.hidden = !settings.asrEnabled;
    settingsAsrForm.hidden = !settings.asrEnabled;
    if (!settings.asrEnabled) {
      settingsAsrStatusEl.textContent = "Voice input is turned off on this machine (FAMILY_AGENT_ASR=0).";
    }
    if (document.activeElement !== settingsOllamaUrlInput) {
      settingsOllamaUrlInput.value = settings.ollamaBaseUrl;
    }
    if (document.activeElement !== settingsInboxDirInput) {
      settingsInboxDirInput.value = settings.inboxDir;
    }
    if (document.activeElement !== settingsServerNameInput) {
      settingsServerNameInput.value = settings.serverName;
    }
    inboxPathEl.textContent = settings.inboxDir;
    inboxPathEl.title = settings.inboxDir;

    accountNameEl.textContent = currentUser?.displayName ?? "";
    accountRoleEl.textContent = currentUser?.role ?? "";

    // Machine settings (model / Ollama / OCR / home name) are admin-only.
    // Reuse setEnvLocked's disable pass, adding the "not an admin" reason.
    const adminLock = (form: HTMLFormElement, statusEl: HTMLElement, envPinned: boolean) => {
      setEnvLocked(form, statusEl, envPinned || !settings.isAdmin);
      if (!envPinned && !settings.isAdmin) statusEl.textContent = "Only an admin can change this.";
    };
    adminLock(settingsModelForm, settingsModelStatusEl, settings.envLocked.model);
    adminLock(settingsOllamaForm, settingsOllamaStatusEl, settings.envLocked.ollamaBaseUrl);
    adminLock(settingsOcrForm, settingsOcrStatusEl, settings.envLocked.ocrModel);
    if (settings.asrEnabled) adminLock(settingsAsrForm, settingsAsrStatusEl, settings.envLocked.asrModel);
    adminLock(settingsServerNameForm, settingsServerNameStatusEl, settings.envLocked.serverName);
    // The watched folder is this user's own — always editable (unless env-pinned).
    setEnvLocked(settingsForm, settingsStatusEl, settings.envLocked.inboxDir);
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

settingsAsrForm.addEventListener("submit", (e) => {
  e.preventDefault();
  // "" is valid — the server falls back to its default model.
  const asrModel = settingsAsrModelInput.value.trim();
  void saveSetting({ asrModel }, settingsAsrStatusEl, (s) => `Saved — voice input now uses ${s.asrModel}`);
});

settingsServerNameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const serverName = settingsServerNameInput.value.trim();
  if (serverName) void saveSetting({ serverName }, settingsServerNameStatusEl, (s) => `Saved — this home is "${s.serverName}"`);
});

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const password = accountPasswordInput.value;
  if (password.length < 6) {
    accountStatusEl.textContent = "Use at least 6 characters.";
    return;
  }
  accountStatusEl.textContent = "Saving…";
  try {
    await api.updateUser(currentUser.id, { password });
    accountPasswordInput.value = "";
    accountStatusEl.textContent = "Password changed.";
  } catch (err) {
    accountStatusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
});

// ---------- family (users) ----------
const userForm = document.getElementById("user-form") as HTMLFormElement;
const userDisplayNameInput = document.getElementById("user-displayname") as HTMLInputElement;
const userUsernameInput = document.getElementById("user-username") as HTMLInputElement;
const userPasswordInput = document.getElementById("user-password") as HTMLInputElement;
const userRoleSelect = document.getElementById("user-role") as HTMLSelectElement;
const userStatusEl = document.getElementById("user-status")!;
const userList = document.getElementById("user-list")!;
const userCountEl = document.getElementById("user-count")!;

// Up-to-two-letter initials for the avatar.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic avatar colour per account — pale tint + saturated ink, in the
// spirit of the DESIGN.md accent cast and the .category-chip pills.
const AVATAR_TINTS: Array<{ bg: string; fg: string }> = [
  { bg: "#ffefd0", fg: "#8a5a00" }, // marigold
  { bg: "#fde2de", fg: "#b5301f" }, // coral
  { bg: "#e2f0fd", fg: "#1667a8" }, // sky
  { bg: "#fdeecb", fg: "#8a6100" }, // saffron
  { bg: "#e5f0ea", fg: "#2f6b4c" }, // green
  { bg: "#e9e6f7", fg: "#5b4bab" }, // iris
];
function avatarTint(seed: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length];
}

function renderUsers(users: User[]) {
  userList.innerHTML = "";
  userCountEl.textContent = users.length === 1 ? "1 account" : `${users.length} accounts`;
  for (const user of users) {
    const li = document.createElement("li");
    li.className = "user-row";
    const isSelf = user.id === currentUser?.id;

    const avatar = document.createElement("span");
    avatar.className = "user-avatar";
    const tint = avatarTint(user.username);
    avatar.style.background = tint.bg;
    avatar.style.color = tint.fg;
    avatar.textContent = initials(user.displayName);

    const info = document.createElement("div");
    info.className = "user-info";
    const nameRow = document.createElement("div");
    nameRow.className = "user-name-row";
    const name = document.createElement("span");
    name.className = "user-name";
    name.textContent = user.displayName;
    nameRow.appendChild(name);
    if (isSelf) {
      const you = document.createElement("span");
      you.className = "user-you";
      you.textContent = "You";
      nameRow.appendChild(you);
    }
    const role = document.createElement("span");
    role.className = `user-role-badge${user.role === "admin" ? " is-admin" : ""}`;
    role.textContent = user.role === "admin" ? "Admin" : "Member";
    nameRow.appendChild(role);
    const uname = document.createElement("span");
    uname.className = "user-username";
    uname.textContent = `@${user.username}`;
    info.append(nameRow, uname);

    li.append(avatar, info);

    if (!isSelf) {
      const actions = document.createElement("div");
      actions.className = "user-actions";

      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "user-action";
      reset.textContent = "Reset password";
      reset.addEventListener("click", async () => {
        const pw = prompt(`New password for ${user.displayName} (6+ chars):`);
        if (!pw) return;
        if (pw.length < 6) {
          userStatusEl.textContent = "Password must be at least 6 characters.";
          return;
        }
        try {
          await api.updateUser(user.id, { password: pw });
          userStatusEl.textContent = `Reset ${user.displayName}'s password.`;
        } catch (err) {
          userStatusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "user-action user-action-danger";
      del.textContent = "Remove";
      del.addEventListener("click", async () => {
        if (!confirm(`Remove ${user.displayName}? Their events, documents, and history are deleted.`)) return;
        try {
          await api.deleteUser(user.id);
          userStatusEl.textContent = `Removed ${user.displayName}.`;
          void refreshUsers();
        } catch (err) {
          userStatusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      });

      actions.append(reset, del);
      li.appendChild(actions);
    }
    userList.appendChild(li);
  }
}

async function refreshUsers() {
  try {
    const { users } = await api.listUsers();
    renderUsers(users);
  } catch (err) {
    userStatusEl.textContent = `Could not load accounts: ${err instanceof Error ? err.message : String(err)}`;
  }
}

userForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const displayName = userDisplayNameInput.value.trim();
  const username = userUsernameInput.value.trim();
  const password = userPasswordInput.value;
  if (!displayName || !username || password.length < 6) {
    userStatusEl.textContent = "Name, username, and a 6+ character password are all required.";
    return;
  }
  userStatusEl.textContent = "Creating…";
  try {
    await api.createUser({ displayName, username, password, role: userRoleSelect.value as "member" | "admin" });
    userForm.reset();
    userStatusEl.textContent = `Added ${displayName}.`;
    void refreshUsers();
  } catch (err) {
    userStatusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
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

// ---------- auth gate + boot ----------
const gate = document.getElementById("gate")!;
const appEl = document.getElementById("app")!;
const setupForm = document.getElementById("setup-form") as HTMLFormElement;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const loginTitle = document.getElementById("login-title")!;
const setupErr = document.getElementById("setup-error")!;
const loginErr = document.getElementById("login-error")!;
const railUser = document.getElementById("rail-user")!;
const railUserName = document.getElementById("rail-user-name")!;
const signOutBtn = document.getElementById("signout-btn") as HTMLButtonElement;
const navFamily = document.getElementById("nav-family")!;

function showGate(mode: "setup" | "login", serverName: string) {
  appEl.hidden = true;
  gate.hidden = false;
  setupForm.hidden = mode !== "setup";
  loginForm.hidden = mode !== "login";
  loginTitle.textContent = serverName ? `Sign in to ${serverName}` : "Sign in";
  (mode === "setup" ? setupForm : loginForm).querySelector("input")?.focus();
}

function enterApp(user: User) {
  currentUser = user;
  gate.hidden = true;
  appEl.hidden = false;
  railUser.hidden = false;
  railUserName.textContent = user.displayName;
  navFamily.hidden = user.role !== "admin";
  void refreshStatus();
  setInterval(() => void refreshStatus(), 5000);
  startChannelBadgePolling();
  showView("chat");
}

async function boot() {
  try {
    const status = await api.authStatus();
    if (status.needsSetup) return showGate("setup", status.serverName);
    try {
      enterApp((await api.me()).user);
    } catch {
      clearToken();
      showGate("login", status.serverName);
    }
  } catch {
    // agent-core isn't up yet (desktop spawns it on launch) — retry.
    statusText.textContent = "starting agent-core…";
    setTimeout(() => void boot(), 1500);
  }
}

setupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setupErr.textContent = "";
  const btn = setupForm.querySelector("button")!;
  btn.disabled = true;
  try {
    const { token, user } = await api.bootstrap({
      serverName: (document.getElementById("setup-servername") as HTMLInputElement).value.trim() || undefined,
      displayName: (document.getElementById("setup-displayname") as HTMLInputElement).value.trim(),
      username: (document.getElementById("setup-username") as HTMLInputElement).value.trim(),
      password: (document.getElementById("setup-password") as HTMLInputElement).value,
    });
    setToken(token);
    enterApp(user);
  } catch (err) {
    setupErr.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    btn.disabled = false;
  }
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErr.textContent = "";
  const btn = loginForm.querySelector("button")!;
  btn.disabled = true;
  try {
    const { token, user } = await api.login(
      (document.getElementById("login-username") as HTMLInputElement).value.trim(),
      (document.getElementById("login-password") as HTMLInputElement).value
    );
    setToken(token);
    enterApp(user);
  } catch (err) {
    loginErr.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    btn.disabled = false;
  }
});

async function signOut() {
  try {
    await api.logout();
  } catch {
    /* ignore */
  }
  clearToken();
  // Full reload is the simplest way to drop every screen's cached state
  // before the next person signs in.
  location.reload();
}
signOutBtn.addEventListener("click", () => void signOut());
window.addEventListener(SIGNED_OUT_EVENT, () => {
  clearToken();
  location.reload();
});

// ==================================================================
// Messages (family chat) + Board (sticky notes)
// ==================================================================

// ---------- Messages ----------
const messagesBadge = document.getElementById("messages-badge")!;
const channelList = document.getElementById("channel-list")!;
const channelNewBtn = document.getElementById("channel-new-btn") as HTMLButtonElement;
const channelNewForm = document.getElementById("channel-new-form") as HTMLFormElement;
const channelNewMembers = document.getElementById("channel-new-members")!;
const channelNewName = document.getElementById("channel-new-name") as HTMLInputElement;
const channelNewCancel = document.getElementById("channel-new-cancel") as HTMLButtonElement;
const channelNewError = document.getElementById("channel-new-error")!;
const conversationEl = document.getElementById("conversation") as HTMLElement;
const conversationEmpty = document.getElementById("conversation-empty") as HTMLElement;
const conversationTitle = document.getElementById("conversation-title")!;
const conversationMembers = document.getElementById("conversation-members")!;
const conversationDelete = document.getElementById("conversation-delete") as HTMLButtonElement;
const messageLog = document.getElementById("message-log")!;
const messageForm = document.getElementById("message-form") as HTMLFormElement;
const messageInput = document.getElementById("message-input") as HTMLTextAreaElement;
const messageAttachmentsEl = document.getElementById("message-attachments")!;
const messageAttachBtn = document.getElementById("message-attach-btn") as HTMLButtonElement;
const messageImageInput = document.getElementById("message-image-input") as HTMLInputElement;

const messageTray = makeImageTray(messageAttachmentsEl, appendMessageError);
messageAttachBtn.addEventListener("click", () => messageImageInput.click());
messageImageInput.addEventListener("change", () => {
  if (messageImageInput.files) void messageTray.addFiles(Array.from(messageImageInput.files));
  messageImageInput.value = "";
});
wireImagePasteAndDrop(messageTray, messageInput, messageLog);

let familyMembers: FamilyMember[] = [];
let channels: Channel[] = [];
let activeChannelId: string | null = null;
let lastMessageTs: string | null = null;
let messagePollTimer: number | null = null;
let channelBadgeTimer: number | null = null;
let renderedMessageIds = new Set<string>();

function nameForSender(senderId: string): string {
  if (senderId === AGENT_SENDER_ID) return "Assistant";
  if (senderId === currentUser?.id) return "You";
  return familyMembers.find((m) => m.id === senderId)?.displayName ?? "Someone";
}

function updateMessagesBadge() {
  const total = channels.reduce((n, c) => n + (c.unreadCount ?? 0), 0);
  messagesBadge.textContent = total > 99 ? "99+" : String(total);
  messagesBadge.hidden = total === 0;
}

function renderChannelList() {
  channelList.innerHTML = "";
  if (channels.length === 0) {
    channelList.innerHTML = `<li class="empty-state"><span>No conversations yet.</span></li>`;
    return;
  }
  for (const c of channels) {
    const li = document.createElement("li");
    li.className = "channel-row" + (c.id === activeChannelId ? " is-active" : "");
    const preview = c.lastMessage
      ? (c.lastMessage.pending ? "…" : c.lastMessage.body).slice(0, 60)
      : "No messages yet";
    li.innerHTML = `
      <span class="channel-row-title">${escapeHtml(c.title)}</span>
      <span class="channel-row-preview">${escapeHtml(preview)}</span>
      ${c.unreadCount ? `<span class="channel-row-badge">${c.unreadCount}</span>` : ""}
    `;
    li.addEventListener("click", () => void openChannel(c.id));
    channelList.appendChild(li);
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function refreshChannels() {
  try {
    channels = (await api.listChannels()).channels;
  } catch {
    return;
  }
  updateMessagesBadge();
  if (document.getElementById("view-messages")!.classList.contains("is-active")) renderChannelList();
}

function renderMessage(m: Message) {
  if (renderedMessageIds.has(m.id)) {
    // Update a pending agent bubble in place once it resolves.
    const existing = messageLog.querySelector<HTMLElement>(`[data-msg-id="${m.id}"]`);
    if (existing && !m.pending) {
      existing.classList.remove("is-pending");
      existing.querySelector(".msg-body")!.innerHTML = renderMarkdown(m.body);
    }
    return;
  }
  renderedMessageIds.add(m.id);
  const own = m.senderId === currentUser?.id;
  const agent = m.senderId === AGENT_SENDER_ID;
  const el = document.createElement("div");
  el.className = `msg ${own ? "msg-own" : agent ? "msg-agent" : "msg-other"}${m.pending ? " is-pending" : ""}`;
  el.dataset.msgId = m.id;
  const bodyHtml = m.pending
    ? "<em>Assistant is typing…</em>"
    : agent
      ? renderMarkdown(m.body)
      : escapeHtml(m.body);
  el.innerHTML = `${own ? "" : `<span class="msg-sender">${escapeHtml(nameForSender(m.senderId))}</span>`}<div class="msg-body">${bodyHtml}</div>`;
  if (m.images?.length) {
    const grid = document.createElement("div");
    grid.className = "msg-images";
    for (const src of m.images) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "attached image";
      img.loading = "lazy";
      grid.appendChild(img);
    }
    el.querySelector(".msg-body")!.insertAdjacentElement("beforebegin", grid);
  }
  messageLog.appendChild(el);
  messageLog.scrollTop = messageLog.scrollHeight;
}

async function openChannel(id: string) {
  activeChannelId = id;
  lastMessageTs = null;
  renderedMessageIds = new Set();
  messageTray.clear();
  messageLog.innerHTML = "";
  conversationEmpty.hidden = true;
  conversationEl.hidden = false;
  const channel = channels.find((c) => c.id === id);
  conversationTitle.textContent = channel?.title ?? "Conversation";
  conversationMembers.textContent = (channel?.members ?? []).map((m) => m.displayName).join(", ");
  renderChannelList();
  await pollActiveChannel();
  messageInput.focus();
}

async function pollActiveChannel() {
  if (!activeChannelId) return;
  try {
    const { messages } = await api.listMessages(activeChannelId, lastMessageTs ?? undefined);
    for (const m of messages) {
      renderMessage(m);
      lastMessageTs = m.createdAt;
    }
    if (messages.length) {
      await api.markChannelRead(activeChannelId, messages[messages.length - 1].createdAt).catch(() => {});
    }
    // Re-render any pending agent bubble that may have resolved.
    const pendingEls = messageLog.querySelectorAll(".msg.is-pending");
    if (pendingEls.length) {
      const all = (await api.listMessages(activeChannelId)).messages;
      for (const m of all) renderMessage(m);
    }
  } catch {
    /* transient */
  }
}

function stopMessagePolling() {
  if (messagePollTimer !== null) {
    clearInterval(messagePollTimer);
    messagePollTimer = null;
  }
  activeChannelId = null;
}

async function enterMessages() {
  channelNewForm.hidden = true;
  conversationEl.hidden = true;
  conversationEmpty.hidden = false;
  try {
    familyMembers = (await api.listFamilyMembers()).members;
  } catch {
    /* ignore */
  }
  await refreshChannels();
  renderChannelList();
  if (messagePollTimer === null) {
    messagePollTimer = window.setInterval(() => {
      void pollActiveChannel();
      void refreshChannels();
    }, 2500);
  }
}

function startChannelBadgePolling() {
  void refreshChannels();
  if (channelBadgeTimer === null) {
    channelBadgeTimer = window.setInterval(() => void refreshChannels(), 8000);
  }
}

channelNewBtn.addEventListener("click", async () => {
  channelNewError.textContent = "";
  channelNewName.value = "";
  channelNewMembers.innerHTML = "";
  // Always refetch — the directory grows as the admin adds accounts, and a
  // stale cache from an earlier visit would show an empty picker.
  let fetchFailed = false;
  try {
    familyMembers = (await api.listFamilyMembers()).members;
  } catch (err) {
    fetchFailed = true;
    channelNewError.textContent = `Couldn't load family accounts: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  const others = familyMembers.filter((m) => m.id !== currentUser?.id);
  if (!fetchFailed && others.length === 0) {
    channelNewError.textContent = "No other family accounts yet — ask the admin to add one.";
  }
  for (const m of others) {
    const label = document.createElement("label");
    label.className = "channel-new-member";
    label.innerHTML = `<input type="checkbox" value="${m.id}" /> ${escapeHtml(m.displayName)}`;
    channelNewMembers.appendChild(label);
  }
  channelNewForm.hidden = !channelNewForm.hidden;
});
channelNewCancel.addEventListener("click", () => {
  channelNewForm.hidden = true;
});
channelNewForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  channelNewError.textContent = "";
  const picked = Array.from(
    channelNewMembers.querySelectorAll<HTMLInputElement>("input:checked")
  ).map((i) => i.value);
  if (picked.length === 0) {
    channelNewError.textContent = "Pick at least one person.";
    return;
  }
  const name = channelNewName.value.trim();
  try {
    const kind = picked.length === 1 && !name ? "dm" : "group";
    if (kind === "group" && !name) {
      channelNewError.textContent = "Give the group a name.";
      return;
    }
    const { channel } = await api.createChannel({ kind, memberIds: picked, name: name || undefined });
    channelNewForm.hidden = true;
    await refreshChannels();
    await openChannel(channel.id);
  } catch (err) {
    channelNewError.textContent = err instanceof Error ? err.message : String(err);
  }
});

autoGrow(messageInput);
messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = messageInput.value.trim();
  const images = messageTray.images.slice();
  if ((!typed && !images.length) || !activeChannelId) return;
  // The server requires a non-empty body; stand in for an image-only message.
  const body = typed || (images.length > 1 ? "(shared images)" : "(shared an image)");
  messageInput.value = "";
  messageInput.style.height = "auto";
  messageTray.clear();
  const mentionAgent = /(^|[^\w@])@(agent|ai|assistant)\b/i.test(body);
  try {
    await api.postMessage(activeChannelId, body, mentionAgent, images);
    await pollActiveChannel();
    await refreshChannels();
  } catch (err) {
    appendMessageError(err instanceof Error ? err.message : String(err));
  }
});

conversationDelete.addEventListener("click", async () => {
  if (!activeChannelId) return;
  const channel = channels.find((c) => c.id === activeChannelId);
  if (!confirm(`Delete "${channel?.title ?? "this conversation"}"? Its messages are removed for everyone in it.`)) return;
  const id = activeChannelId;
  try {
    await api.deleteChannel(id);
    activeChannelId = null;
    conversationEl.hidden = true;
    conversationEmpty.hidden = false;
    await refreshChannels();
    renderChannelList();
  } catch (err) {
    appendMessageError(err instanceof Error ? err.message : String(err));
  }
});

function appendMessageError(text: string) {
  const el = document.createElement("div");
  el.className = "msg msg-error";
  el.textContent = text;
  messageLog.appendChild(el);
}

function autoGrow(ta: HTMLTextAreaElement) {
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ta.form?.requestSubmit();
    }
  });
}

// ---------- Board (sticky notes) ----------
const NOTE_COLORS = ["butter", "mint", "sky", "blush", "lilac"] as const;
const noteGrid = document.getElementById("note-grid")!;
const noteForm = document.getElementById("note-form") as HTMLFormElement;
const noteText = document.getElementById("note-text") as HTMLTextAreaElement;
const noteColorsEl = document.getElementById("note-colors")!;
const noteStatus = document.getElementById("note-status")!;
const boardToggle = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.seg-toggle [data-board]')
);

let boardScope: NoteScope = "shared";
let notes: StickyNote[] = [];
let newNoteColor: string = NOTE_COLORS[0];
let boardPollTimer: number | null = null;

for (const color of NOTE_COLORS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `note-swatch note-${color}` + (color === newNoteColor ? " is-active" : "");
  b.dataset.color = color;
  b.setAttribute("role", "radio");
  b.setAttribute("aria-label", color);
  b.addEventListener("click", () => {
    newNoteColor = color;
    for (const s of noteColorsEl.children) s.classList.toggle("is-active", (s as HTMLElement).dataset.color === color);
  });
  noteColorsEl.appendChild(b);
}

for (const btn of boardToggle) {
  btn.addEventListener("click", () => {
    boardScope = btn.dataset.board as NoteScope;
    for (const b of boardToggle) b.classList.toggle("is-active", b === btn);
    void refreshNotes();
  });
}

function renderNotes() {
  noteGrid.innerHTML = "";
  if (notes.length === 0) {
    noteGrid.innerHTML = `<li class="empty-state"><span>No notes on this board yet.</span></li>`;
    return;
  }
  for (const n of notes) {
    const li = document.createElement("li");
    li.className = `note-card note-${n.color}`;
    const body = document.createElement("div");
    body.className = "note-card-text";
    body.textContent = n.text;
    body.title = "Click to edit";
    body.addEventListener("click", () => startEditNote(li, n));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "note-card-del";
    del.setAttribute("aria-label", "Delete note");
    del.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener("click", async () => {
      await api.deleteNote(n.id).catch(() => {});
      await refreshNotes();
    });
    li.append(body, del);
    noteGrid.appendChild(li);
  }
}

function startEditNote(li: HTMLElement, n: StickyNote) {
  li.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.className = "note-card-edit";
  ta.value = n.text;
  const save = async () => {
    const text = ta.value.trim();
    if (text && text !== n.text) await api.updateNote(n.id, { text }).catch(() => {});
    await refreshNotes();
  };
  ta.addEventListener("blur", () => void save());
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape") void refreshNotes();
  });
  const colors = document.createElement("div");
  colors.className = "note-colors";
  for (const color of NOTE_COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `note-swatch note-${color}` + (color === n.color ? " is-active" : "");
    b.addEventListener("click", async () => {
      await api.updateNote(n.id, { color }).catch(() => {});
      await refreshNotes();
    });
    colors.appendChild(b);
  }
  li.append(ta, colors);
  ta.focus();
}

async function refreshNotes() {
  try {
    notes = (await api.listNotes(boardScope)).notes;
    renderNotes();
  } catch {
    /* ignore */
  }
}

noteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = noteText.value.trim();
  if (!text) return;
  noteStatus.textContent = "";
  try {
    await api.createNote(boardScope, text, newNoteColor);
    noteText.value = "";
    await refreshNotes();
  } catch (err) {
    noteStatus.textContent = err instanceof Error ? err.message : String(err);
  }
});

function stopBoardPolling() {
  if (boardPollTimer !== null) {
    clearInterval(boardPollTimer);
    boardPollTimer = null;
  }
}

async function enterBoard() {
  await refreshNotes();
  if (boardPollTimer === null) {
    boardPollTimer = window.setInterval(() => void refreshNotes(), 5000);
  }
}

// ---------- side panel (document preview + chat references) ----------
const sidePanel = document.getElementById("side-panel") as HTMLElement;
const sidePanelTitle = document.getElementById("side-panel-title")!;
const sidePanelBody = document.getElementById("side-panel-body")!;
const sidePanelClose = document.getElementById("side-panel-close") as HTMLButtonElement;

sidePanelClose.addEventListener("click", closeSidePanel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !sidePanel.hidden) closeSidePanel();
});

// A PDF render in flight, and any object URLs handed to <img>/blobs — torn down
// whenever the panel closes or shows something else.
let activePdfRender: PdfRender | null = null;
let panelObjectUrls: string[] = [];

// Bumped every time the panel content changes — a slow fetch from a previous
// openDocumentPanel() call checks this before touching the DOM it no longer owns.
let panelGen = 0;

function teardownPanelContent() {
  panelGen++;
  activePdfRender?.cancel();
  activePdfRender = null;
  for (const url of panelObjectUrls) URL.revokeObjectURL(url);
  panelObjectUrls = [];
}

function closeSidePanel() {
  teardownPanelContent();
  sidePanel.hidden = true;
  sidePanel.classList.remove("is-open", "side-panel--wide");
  sidePanelBody.innerHTML = "";
}

function openSidePanel(title: string, bodyHtml: string, opts: { wide?: boolean } = {}) {
  teardownPanelContent();
  sidePanelTitle.textContent = title;
  sidePanelBody.innerHTML = bodyHtml;
  sidePanel.classList.toggle("side-panel--wide", opts.wide === true);
  sidePanel.hidden = false;
  // next frame so the transition runs
  requestAnimationFrame(() => sidePanel.classList.add("is-open"));
}

function docMetaHtml(doc: Document): string {
  const meta: string[] = [];
  if (doc.extracted?.category) meta.push(`<span class="category-chip">${escapeHtml(doc.extracted.category)}</span>`);
  if (doc.sourcePath) meta.push(`<span class="tag tag-local">watched folder</span>`);
  const dates = doc.extracted?.importantDates?.length
    ? `<p class="side-panel-hint">Important dates: ${doc.extracted.importantDates.map(escapeHtml).join(", ")}</p>`
    : "";
  return `${meta.length ? `<div class="side-panel-meta">${meta.join(" ")}</div>` : ""}
     ${doc.extracted?.summary ? `<p class="side-panel-summary">${escapeHtml(doc.extracted.summary)}</p>` : ""}
     ${dates}`;
}

async function openDocumentPanel(id: string) {
  openSidePanel("Loading…", `<p class="side-panel-hint">Loading…</p>`);
  const gen = panelGen;
  let doc: Document;
  try {
    doc = (await api.getDocument(id)).document;
  } catch (err) {
    if (gen !== panelGen) return;
    openSidePanel("Not found", `<p class="side-panel-hint">${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`);
    return;
  }
  if (gen !== panelGen) return; // the user opened something else while this loaded

  const isPdf = doc.originalMime === "application/pdf" || /\.pdf$/i.test(doc.filename);
  const isImage = (doc.originalMime ?? "").startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(doc.filename);
  const textBlock = `<pre class="side-panel-text">${escapeHtml(doc.rawText)}</pre>`;

  if (isPdf) {
    openSidePanel(
      doc.filename,
      `${docMetaHtml(doc)}
       <div id="pdf-scroll" class="pdf-scroll"><p class="side-panel-hint">Opening PDF…</p></div>
       <details class="pdf-text-details"><summary>Extracted text</summary>${textBlock}</details>`,
      { wide: true }
    );
    const g = panelGen;
    try {
      const { buffer } = await api.getDocumentOriginal(id);
      if (g !== panelGen) return;
      const host = document.getElementById("pdf-scroll");
      if (host) activePdfRender = renderPdf(host, buffer);
    } catch {
      if (g !== panelGen) return;
      const host = document.getElementById("pdf-scroll");
      if (host) host.innerHTML = `<p class="side-panel-hint">The original PDF isn't available — showing the extracted text below.</p>`;
    }
    return;
  }

  if (isImage) {
    openSidePanel(doc.filename, `${docMetaHtml(doc)}<div id="img-host"><p class="side-panel-hint">Loading image…</p></div>`);
    const g = panelGen;
    try {
      const { buffer, type } = await api.getDocumentOriginal(id);
      if (g !== panelGen) return;
      const url = URL.createObjectURL(new Blob([buffer], { type: type || "image/*" }));
      panelObjectUrls.push(url);
      const host = document.getElementById("img-host");
      if (host) host.innerHTML = `<img class="side-panel-image" src="${url}" alt="${escapeHtml(doc.filename)}" />`;
    } catch {
      if (g !== panelGen) return;
      const host = document.getElementById("img-host");
      if (host) host.innerHTML = textBlock;
    }
    return;
  }

  openSidePanel(doc.filename, `${docMetaHtml(doc)}${textBlock}`);
}

async function openTaskPanel(id: string) {
  openSidePanel("Loading…", `<p class="side-panel-hint">Loading…</p>`);
  const gen = panelGen;
  try {
    const { task } = await api.getTask(id);
    if (gen !== panelGen) return;
    const when = task.dueDate
      ? `<p class="side-panel-hint">Due ${escapeHtml(task.dueDate)}${task.dueTime ? ` at ${escapeHtml(task.dueTime)}` : ""}</p>`
      : "";
    openSidePanel(
      task.title,
      `<div class="side-panel-meta"><span class="category-chip">${task.status === "done" ? "done" : "open"}</span></div>
       ${when}
       ${task.notes ? `<p class="side-panel-summary">${escapeHtml(task.notes)}</p>` : ""}
       <p class="side-panel-hint">Open the Events tab to reschedule or complete it.</p>`
    );
  } catch (err) {
    if (gen !== panelGen) return;
    openSidePanel("Not found", `<p class="side-panel-hint">${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`);
  }
}

/** Render the assistant's task/document references as clickable chips under its bubble. */
function appendReferences(afterEl: HTMLElement, references: ChatReference[]) {
  const wrap = document.createElement("div");
  wrap.className = "chat-references";
  const label = document.createElement("span");
  label.className = "chat-references-label";
  label.textContent = "References";
  wrap.appendChild(label);
  for (const ref of references) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `ref-chip ref-chip-${ref.type}`;
    chip.textContent = ref.label;
    chip.addEventListener("click", () =>
      ref.type === "document" ? void openDocumentPanel(ref.id) : void openTaskPanel(ref.id)
    );
    wrap.appendChild(chip);
  }
  afterEl.insertAdjacentElement("afterend", wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

void boot();
