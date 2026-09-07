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
  type DocumentSearchHit,
  type DocumentSearchMode,
  type ActivityEntry,
  type Settings,
  type SettingsPatch,
  type Tool,
  type ToolDbColumn,
  type ToolOperation,
  type Health,
  type User,
  AGENT_SENDER_ID,
  type Channel,
  type Message,
  type FamilyMember,
  type StickyNote,
  type NoteScope,
  type ChatReference,
  type ChatSession,
  type ChatSessionMessage,
  type Routine,
  type RoutineRun,
  type RoutineTriggerInput,
  type RoutineAgentKind,
  type Skill,
  type McpServer,
} from "./api.js";
import { startRecording, type Recording } from "./audio.js";
import {
  friendlyDate,
  friendlyTime,
  friendlyDateTime,
  dueBucket,
  relativeTime,
  dayHeading,
  humanActor,
} from "./format.js";
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
  closeDbInspector();
  closeSidePanel();
  for (const btn of navButtons) btn.classList.toggle("is-active", btn.dataset.view === name);
  for (const view of views) view.classList.toggle("is-active", view.id === `view-${name}`);
  // Stop any view-scoped polling loops the previous view started.
  if (name !== "messages") stopMessagePolling();
  if (name !== "board") stopBoardPolling();
  if (name === "chat") {
    void refreshChatSessions();
    void refreshTools().then((tools) => {
      slashTools = tools;
    });
  }
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
      if (tools.some((t) => t.status === "building" || t.revisionState === "revising")) void pollTools();
    });
  }
  if (name === "activity") void refreshActivity();
  if (name === "routines") void refreshRoutines();
  if (name === "skills") void refreshSkills();
  if (name === "family") void refreshUsers();
  if (name === "settings") {
    void refreshSettings();
    if (mcpMode !== "off" && currentUser?.role === "admin") void refreshConnections();
  }
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
// True when no embedding model is configured — the Documents "By meaning"
// search option then annotates that it falls back to keyword + fuzzy.
let semanticSearchOff = false;
// Mirrors /health.routinesEnabled — hides the Routines nav item when off.
let routinesEnabled = true;
const navRoutines = document.getElementById("nav-routines") as HTMLButtonElement;
// Mirrors /health.skills — hides the Skills nav item when "off", gates /skill.
let skillsMode: NonNullable<Health["skills"]> = "off";
const navSkills = document.getElementById("nav-skills") as HTMLButtonElement;
// Mirrors /health.mcp — gates the Connections settings section and /connect.
let mcpMode: NonNullable<Health["mcp"]> = "off";
// Mirror /health.web / .shell / .compute — gate the /web, /run, /calc slash commands.
let webEnabled = false;
let shellEnabled = false;
let computeEnabled = true;

async function refreshStatus() {
  try {
    const health = await api.health();
    statusPill.className = "status-pill status-ok";
    statusText.textContent = `local · ${health.model}`;
    if (health.toolsPort) toolsPort = health.toolsPort;
    if (health.toolsEnabled) toolsEnabled = health.toolsEnabled;
    voiceEnabled = health.asrEnabled === true;
    chatMicBtn.hidden = !voiceEnabled;
    messageMicBtn.hidden = !voiceEnabled;
    semanticSearchOff = health.semanticSearch === "off";
    routinesEnabled = health.routinesEnabled !== false;
    navRoutines.hidden = !routinesEnabled;
    skillsMode = health.skills ?? "off";
    navSkills.hidden = skillsMode === "off";
    mcpMode = health.mcp ?? "off";
    settingsConnectionsSection.hidden = mcpMode === "off" || currentUser?.role !== "admin";
    webEnabled = health.web === "on";
    shellEnabled = health.shell === "on";
    computeEnabled = health.compute !== false;
    const meaningOpt = documentSearchMode.querySelector<HTMLOptionElement>('option[value="semantic"]');
    if (meaningOpt) {
      meaningOpt.textContent = semanticSearchOff ? "By meaning (needs a model)" : "By meaning";
      meaningOpt.title = semanticSearchOff
        ? "Run `ollama pull nomic-embed-text` on the server to enable — falls back to keyword + fuzzy for now"
        : "";
    }
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
const chatHelpBtn = document.getElementById("chat-help-btn") as HTMLButtonElement;
const chatSendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement;
const chatStopBtn = document.getElementById("chat-stop-btn") as HTMLButtonElement;
const chatSessionList = document.getElementById("chat-session-list")!;
const chatSlashMenu = document.getElementById("chat-slash-menu")!;

// The active persisted session, if any — null until the first message of a
// fresh conversation gets a reply and the server hands back a sessionId (see
// the submit handler below). A private chat has only one writer (this tab),
// so unlike Messages there's no need to poll.
let chatSessions: ChatSession[] = [];
let activeChatSessionId: string | null = null;

// "/" autocomplete: a fixed set of forced-agent commands (see
// parseForcedAgentCommand, agent-core/src/agents/index.ts — keep these four
// in sync with FORCED_AGENT_KEYWORDS there) plus the family's own tool names.
// "search" is a hand-typeable alias for "find", not listed separately, to
// keep this short.
interface SlashEntry {
  name: string;
  description: string;
}
const SLASH_COMMANDS: SlashEntry[] = [
  { name: "build", description: "Build a new tool, or improve an existing one" },
  { name: "task", description: "Add, list, or complete a to-do" },
  { name: "find", description: "Search the family's documents (alias: /search)" },
  { name: "note", description: "Read or add a sticky note" },
  { name: "schedule", description: "Create or manage a scheduled routine (alias: /remind)" },
  { name: "web", description: "Search the web and read a page (alias: /lookup)" },
  { name: "run", description: "Process a file with command-line tools (alias: /shell)" },
  { name: "calc", description: "Compute an exact answer — maths, dates, totals (alias: /compute)" },
  { name: "skill", description: "Use one of the family's taught skills" },
  { name: "connect", description: "Use a connected external service (alias: /mcp)" },
];
// Populated (from the same /tools list the Tools view already fetches) when
// the Chat view is entered; only ready, server-kind tools are offered — a
// static (display-only) tool has no operations to call via the tools API at
// all (see familyToolCatalog server-side), so it would be a dead end here.
let slashTools: Tool[] = [];

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
    // A "/" turn forced a specific specialist agent instead of the planner —
    // flag it so it's obvious at a glance which turns skipped the planner's
    // routing (see parseForcedAgentCommand, agent-core/src/agents/index.ts).
    if (text.trimStart().startsWith("/")) {
      const badge = document.createElement("span");
      badge.className = "bubble-tool-badge";
      badge.title = "Sent straight to a specialist agent — skipped the planner";
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94Z"/></svg>';
      p.appendChild(badge);
    }
    p.appendChild(document.createTextNode(text));
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

// ---------- composer plumbing (shared by Chat and Messages) ----------
// The chat and the family-chat composers behave the same: a textarea that
// starts one line and grows to three (then scrolls, with an expand button for
// a bigger view), a "/" command autocomplete, voice input, and image attach.
// Only how the message is delivered differs.

// -- voice --
// Tap once to start recording, tap again to stop; the transcript is dropped
// into the input for the user to review and send (never auto-sent).
function wireMic(
  micBtn: HTMLButtonElement,
  target: HTMLTextAreaElement,
  report: (msg: string) => void,
  afterInsert: () => void
) {
  let recording: Recording | null = null;
  const setRecording = (on: boolean) => {
    micBtn.classList.toggle("is-recording", on);
    micBtn.setAttribute("aria-pressed", String(on));
    micBtn.title = on ? "Stop recording" : "Voice input";
  };
  micBtn.addEventListener("click", async () => {
    if (recording) {
      const rec = recording;
      recording = null;
      setRecording(false);
      micBtn.disabled = true;
      try {
        const wav = await rec.stop();
        const { text } = await api.transcribe(wav);
        if (text) {
          const existing = target.value.trim();
          target.value = existing ? `${existing} ${text}` : text;
          target.focus();
          afterInsert();
        } else {
          report("Didn't catch any speech — try again, a bit closer to the mic.");
        }
      } catch (err) {
        report(`Voice input failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        micBtn.disabled = false;
      }
      return;
    }
    try {
      recording = await startRecording();
      setRecording(true);
    } catch (err) {
      report(
        `Couldn't start recording: ${err instanceof Error ? err.message : String(err)}. ` +
          "Check that a microphone is connected and this app has permission to use it."
      );
    }
  });
}

// -- auto-grow: one line → three, then scroll; an expand button toggles a
//    taller view when there's more than three lines of content. --
interface GrowController {
  refresh: () => void;
  reset: () => void;
}
function wireAutoGrow(
  ta: HTMLTextAreaElement,
  form: HTMLFormElement,
  expandBtn: HTMLButtonElement
): GrowController {
  let expanded = false;
  const threeLineCap = () => {
    const cs = getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight) || 21.6;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    return line * 3 + pad;
  };
  const setExpanded = (on: boolean) => {
    expanded = on;
    form.classList.toggle("is-expanded", on);
    expandBtn.setAttribute("aria-pressed", String(on));
    expandBtn.title = on ? "Collapse the input" : "Expand the input";
    refresh();
    ta.focus();
  };
  function refresh() {
    ta.style.height = "auto";
    // CSS max-height (3 lines collapsed / ~48vh expanded) does the clamping;
    // scrollHeight is always the full content height, so this is the natural
    // size the field wants.
    ta.style.height = `${ta.scrollHeight}px`;
    const overflowing = ta.scrollHeight > threeLineCap() + 1;
    expandBtn.hidden = !(overflowing || expanded);
    if (!overflowing && expanded) setExpanded(false);
  }
  function reset() {
    if (expanded) {
      expanded = false;
      form.classList.remove("is-expanded");
      expandBtn.setAttribute("aria-pressed", "false");
      expandBtn.title = "Expand the input";
    }
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    expandBtn.hidden = true;
  }
  expandBtn.addEventListener("click", () => setExpanded(!expanded));
  ta.addEventListener("input", refresh);
  return { refresh, reset };
}

// -- "/" command autocomplete + committed-command chip --
// Once a command is chosen (from the menu, or by typing "/name " with a
// trailing space), it's lifted out of the textarea into a chip so the command
// and the message text read as separate things. The textarea then holds only
// the message. Backspace at the very start of the textarea deletes the whole
// chip at once — you can never end up with half a "/command".
interface SlashController {
  hide: () => void;
  /** Remove the chip and hide the menu (a full reset on send / switch). */
  clear: () => void;
  /** The committed command name (e.g. "calc"), or null. */
  getCommand: () => string | null;
}
function wireSlashMenu(
  input: HTMLTextAreaElement,
  menu: HTMLElement,
  chip: HTMLElement,
  form: HTMLFormElement,
  onChange: () => void
): SlashController {
  let matches: SlashEntry[] = [];
  let highlight = -1;
  let command: string | null = null;

  const enabledCommands = () =>
    SLASH_COMMANDS.filter(
      (c) =>
        (c.name !== "web" || webEnabled) &&
        (c.name !== "run" || shellEnabled) &&
        (c.name !== "calc" || computeEnabled) &&
        (c.name !== "skill" || skillsMode !== "off") &&
        (c.name !== "connect" || mcpMode === "on")
    );
  const knownName = (name: string) =>
    enabledCommands().some((c) => c.name === name) ||
    slashTools.some((t) => t.kind === "server" && t.status === "ready" && t.name === name);

  const hide = () => {
    menu.hidden = true;
    menu.innerHTML = "";
    matches = [];
    highlight = -1;
  };
  const renderChip = () => {
    if (!command) {
      chip.hidden = true;
      chip.innerHTML = "";
      return;
    }
    chip.innerHTML = `<code>/${escapeHtml(command)}</code><button type="button" class="composer-chip-x" aria-label="Remove the /${escapeHtml(command)} command" tabindex="-1">×</button>`;
    chip.hidden = false;
    chip.querySelector(".composer-chip-x")!.addEventListener("mousedown", (e) => {
      e.preventDefault();
      removeCommand();
    });
  };
  const setCommand = (name: string) => {
    command = name;
    renderChip();
    hide();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    onChange();
  };
  const removeCommand = () => {
    command = null;
    renderChip();
    input.focus();
    onChange();
  };

  const render = () => {
    menu.innerHTML = "";
    if (matches.length === 0) {
      menu.innerHTML = `<li class="slash-menu-empty">No matching commands or tools.</li>`;
    } else {
      matches.forEach((t, i) => {
        const li = document.createElement("li");
        li.className = "slash-menu-row" + (i === highlight ? " is-active" : "");
        li.innerHTML = `<span class="slash-menu-row-name">${escapeHtml(t.name)}</span><span class="slash-menu-row-desc">${escapeHtml(t.description)}</span>`;
        li.addEventListener("mousedown", (e) => {
          // mousedown (not click) so this fires before the textarea blurs.
          e.preventDefault();
          input.value = "";
          setCommand(t.name);
        });
        menu.appendChild(li);
      });
    }
    menu.hidden = false;
  };
  const update = () => {
    // Typed "/name " (with a space) while no command is committed → commit it,
    // move the rest of the text into the field.
    if (!command) {
      const typed = /^\/(\S+)[ \t]([\s\S]*)$/.exec(input.value);
      if (typed && knownName(typed[1].toLowerCase())) {
        input.value = typed[2];
        setCommand(typed[1].toLowerCase());
        return;
      }
    }
    // A live autocomplete only while the whole field is "/" + a partial word
    // and nothing is committed yet.
    const m = command ? null : /^\/([^\s]*)$/.exec(input.value);
    if (!m) {
      hide();
      return;
    }
    const query = m[1].toLowerCase();
    const toolEntries: SlashEntry[] = slashTools
      .filter((t) => t.kind === "server" && t.status === "ready")
      .map((t) => ({ name: t.name, description: t.description }));
    matches = [...enabledCommands(), ...toolEntries].filter((e) => e.name.toLowerCase().includes(query));
    highlight = matches.length ? 0 : -1;
    render();
  };
  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    // Backspace at the very start of an otherwise-untouched caret drops the
    // whole command chip — never a partial "/comman".
    if (
      e.key === "Backspace" &&
      command &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      e.preventDefault();
      removeCommand();
      return;
    }
    if (!menu.hidden && matches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlight = (highlight + 1) % matches.length;
        render();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        highlight = (highlight - 1 + matches.length) % matches.length;
        render();
        return;
      }
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        input.value = "";
        setCommand(matches[highlight].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
        return;
      }
    }
    // Enter sends; Shift+Enter (or Enter mid-IME-composition) newlines.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  return {
    hide,
    clear: () => {
      command = null;
      renderChip();
      hide();
    },
    getCommand: () => command,
  };
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

const chatExpandBtn = document.getElementById("chat-expand-btn") as HTMLButtonElement;
const chatSlashChip = document.getElementById("chat-slash-chip")!;
const chatGrow = wireAutoGrow(chatInput, chatForm, chatExpandBtn);
const chatSlash = wireSlashMenu(chatInput, chatSlashMenu, chatSlashChip, chatForm, chatGrow.refresh);
wireMic(chatMicBtn, chatInput, (m) => appendBubble("system", m), chatGrow.refresh);

// Toggle the composer between "ready to send" and "reply in flight" (Stop).
function setChatPending(pending: boolean) {
  chatSendBtn.hidden = pending;
  chatStopBtn.hidden = !pending;
  chatSendBtn.disabled = pending;
}

// ---- chat history sessions ----
// A session is created lazily server-side on the first turn of a fresh
// conversation (see POST /chat) — this pane only ever lists/opens/deletes
// what the server already has.
function renderChatSessionList() {
  chatSessionList.innerHTML = "";
  if (chatSessions.length === 0) {
    chatSessionList.innerHTML = `<li class="empty-state"><span>No conversations yet.</span></li>`;
    return;
  }
  for (const s of chatSessions) {
    const li = document.createElement("li");
    li.className = "channel-row session-row" + (s.id === activeChatSessionId ? " is-active" : "");
    const preview = s.lastMessage ? s.lastMessage.slice(0, 60) : "No messages yet";
    li.innerHTML = `
      <span class="channel-row-title">${escapeHtml(s.title)}</span>
      <span class="channel-row-preview">${escapeHtml(preview)}</span>
      <button type="button" class="session-row-delete" title="Delete this conversation" aria-label="Delete this conversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    `;
    li.addEventListener("click", () => void openChatSession(s.id));
    li.querySelector(".session-row-delete")!.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteChatSessionRow(s.id);
    });
    chatSessionList.appendChild(li);
  }
}

async function refreshChatSessions() {
  try {
    chatSessions = (await api.listChatSessions()).sessions;
  } catch {
    return;
  }
  if (document.getElementById("view-chat")!.classList.contains("is-active")) renderChatSessionList();
}

async function openChatSession(id: string) {
  if (id === activeChatSessionId) return;
  chatAbort?.abort();
  chatAbort = null;
  let messages: ChatSessionMessage[];
  try {
    messages = (await api.getChatSessionMessages(id)).messages;
  } catch (err) {
    appendBubble("system", `Couldn't open that conversation: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  activeChatSessionId = id;
  chatTray.clear();
  chatInput.value = "";
  chatGrow.reset();
  setChatPending(false);
  chatSlash.clear();
  chatLog.innerHTML = "";
  chatLog.appendChild(chatEmptyEl);
  for (const m of messages) {
    if (m.role === "user") appendUserMessage(m.body, m.images);
    else {
      const bubble = appendBubble("assistant", m.body);
      if (m.refs.length) appendReferences(bubble, m.refs);
    }
  }
  renderChatSessionList();
  chatInput.focus();
}

async function deleteChatSessionRow(id: string) {
  try {
    await api.deleteChatSession(id);
  } catch (err) {
    appendBubble("system", `Couldn't delete that conversation: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  chatSessions = chatSessions.filter((s) => s.id !== id);
  if (id === activeChatSessionId) startNewChat();
  renderChatSessionList();
}

// Clear the transcript and cancel anything in flight — a fresh conversation.
// Nothing is created server-side until the first message actually sends.
function startNewChat() {
  chatAbort?.abort();
  chatAbort = null;
  activeChatSessionId = null;
  chatLog.innerHTML = "";
  chatLog.appendChild(chatEmptyEl);
  chatTray.clear();
  chatInput.value = "";
  chatGrow.reset();
  setChatPending(false);
  chatSlash.clear();
  chatInput.focus();
  renderChatSessionList();
}
chatNewBtn.addEventListener("click", startNewChat);

function slashHelpHtml(): string {
  const commandRows = SLASH_COMMANDS.map(
    (c) => `<p class="side-panel-hint"><code>/${escapeHtml(c.name)}</code> — ${escapeHtml(c.description)}</p>`
  ).join("");
  const toolRows = slashTools
    .filter((t) => t.kind === "server" && t.status === "ready")
    .map((t) => `<p class="side-panel-hint"><code>/${escapeHtml(t.name)}</code> — ${escapeHtml(t.description)}</p>`)
    .join("");
  return `
    <p class="side-panel-summary">Start a message with "/" to skip the assistant's own routing and send that turn
    straight to one specialist — useful when it doesn't otherwise pick the right one.</p>
    <p class="side-panel-hint"><strong>Commands</strong></p>
    ${commandRows}
    <p class="side-panel-hint"><strong>Or one of the family's tools, by name</strong></p>
    ${toolRows || `<p class="side-panel-hint">The family hasn't built any tools yet — see the Tools tab.</p>`}
  `;
}
chatHelpBtn.addEventListener("click", () => openSidePanel("Slash commands", slashHelpHtml()));
chatStopBtn.addEventListener("click", () => chatAbort?.abort());

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (chatAbort) return; // a reply is already in flight
  const typed = chatInput.value.trim();
  const cmd = chatSlash.getCommand();
  const images = chatTray.images.slice();
  if (!typed && !images.length && !cmd) return;
  // Rebuild the wire form: "/cmd rest", or the plain text (with an image-only
  // default), and show the same in the transcript bubble.
  const message = cmd
    ? `/${cmd} ${typed}`.trimEnd()
    : typed || "What's in this image?";
  const shown = cmd ? `/${cmd} ${typed}`.trimEnd() : typed;
  chatInput.value = "";
  chatGrow.reset();
  chatSlash.clear();
  chatTray.clear();
  appendUserMessage(shown, images);
  const pending = appendTypingIndicator();
  chatAbort = new AbortController();
  setChatPending(true);
  try {
    const { reply, references, sessionId } = await api.chat(
      message,
      images,
      activeChatSessionId ?? undefined,
      chatAbort.signal
    );
    pending.remove();
    const bubble = appendBubble("assistant", reply);
    if (references?.length) appendReferences(bubble, references);
    activeChatSessionId = sessionId;
    void refreshChatSessions();
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
  // Open events first (soonest due, then undated), done events sink to the bottom.
  const rank = (t: Task) =>
    t.status === "done" ? Number.MAX_SAFE_INTEGER : t.dueDate ? Date.parse(`${t.dueDate.slice(0, 10)}T00:00:00`) : Number.MAX_SAFE_INTEGER - 1;
  const sorted = [...tasks].sort((a, b) => rank(a) - rank(b));

  let sawDone = false;
  for (const task of sorted) {
    const done = task.status === "done";
    if (done && !sawDone && sorted.some((t) => t.status !== "done")) {
      sawDone = true;
      const sep = document.createElement("li");
      sep.className = "task-group-label";
      sep.textContent = "Done";
      taskList.appendChild(sep);
    }
    const bucket = done ? "none" : dueBucket(task.dueDate);
    const li = document.createElement("li");
    li.className = `task-row${done ? " is-done" : ""}${bucket === "overdue" ? " is-overdue" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = done;
    checkbox.disabled = done;
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
      due.className = `task-due${bucket === "overdue" || bucket === "today" ? " is-urgent" : ""}`;
      due.textContent = friendlyDateTime(task.dueDate, task.dueTime);
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
  chip.textContent = task.dueTime ? `${friendlyTime(task.dueTime)} ${task.title}` : task.title;
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
      block.textContent = `${friendlyTime(t.dueTime)} ${t.title}`;
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
const documentSearchInput = document.getElementById("document-search") as HTMLInputElement;
const documentSearchMode = document.getElementById("document-search-mode") as HTMLSelectElement;
const documentSearchStatus = document.getElementById("document-search-status")!;

// One row shape for both the full list (Document) and a search hit
// (DocumentSearchHit) — search hits have no sourcePath and carry a match snippet.
interface DocRow {
  id: string;
  filename: string;
  category: string | null;
  summary: string | null;
  extractionStatus: Document["extractionStatus"];
  sourcePath?: string | null;
  snippet?: string | null;
}
const rowFromDocument = (d: Document): DocRow => ({
  id: d.id,
  filename: d.filename,
  category: d.extracted?.category ?? null,
  summary: d.extracted?.summary ?? null,
  extractionStatus: d.extractionStatus,
  sourcePath: d.sourcePath,
});
const rowFromHit = (h: DocumentSearchHit): DocRow => ({ ...h, snippet: h.snippet });

function buildDocumentRow(row: DocRow): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "document-row";

  const head = document.createElement("div");
  head.className = "document-row-head";
  const name = document.createElement("span");
  name.className = "document-filename";
  name.textContent = row.filename;
  head.appendChild(name);
  if (row.sourcePath) {
    const tag = document.createElement("span");
    tag.className = "tag tag-local";
    tag.textContent = "watched folder";
    tag.title = row.sourcePath;
    head.appendChild(tag);
  }
  if (row.category) {
    const chip = document.createElement("span");
    chip.className = "category-chip";
    chip.textContent = row.category;
    head.appendChild(chip);
  }

  const preview = document.createElement("button");
  preview.className = "doc-preview";
  preview.type = "button";
  preview.textContent = "Preview";
  preview.title = "Open a preview in the side panel";
  preview.addEventListener("click", () => void openDocumentPanel(row.id));
  head.appendChild(preview);

  const rename = document.createElement("button");
  rename.className = "doc-preview";
  rename.type = "button";
  rename.textContent = "Rename";
  rename.title = "Rename this document, or let the agent suggest a name";
  rename.addEventListener("click", () =>
    beginDocumentRename({ id: row.id, filename: row.filename }, li, head)
  );
  head.appendChild(rename);

  const del = document.createElement("button");
  del.className = "doc-delete";
  del.type = "button";
  del.title = "Delete document";
  del.setAttribute("aria-label", `Delete ${row.filename}`);
  del.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  del.addEventListener("click", async () => {
    del.disabled = true;
    try {
      await api.deleteDocument(row.id);
      void refreshDocuments();
      void refreshActivity();
    } catch (err) {
      del.disabled = false;
      documentUploadStatus.textContent = `Could not delete: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  head.appendChild(del);
  li.appendChild(head);

  if (row.summary) {
    const detail = document.createElement("p");
    detail.className = "document-summary";
    detail.textContent = row.summary;
    li.appendChild(detail);
  } else if (row.extractionStatus === "failed") {
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
        await api.retryExtraction(row.id);
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

  if (row.snippet) {
    const snip = document.createElement("p");
    snip.className = "document-snippet";
    // The snippet is plain text from FTS; wrap the query terms in <mark>.
    snip.innerHTML = highlightSnippet(row.snippet, documentSearch.q);
    li.appendChild(snip);
  }

  return li;
}

function renderDocuments(docs: Document[]) {
  documentList.innerHTML = "";
  if (docs.length === 0) {
    documentList.innerHTML = emptyState(
      "documents",
      "No documents yet. Upload one above or drop a file in the watched folder."
    );
    return;
  }
  for (const doc of docs) documentList.appendChild(buildDocumentRow(rowFromDocument(doc)));
}

function renderDocumentHits(hits: DocumentSearchHit[]) {
  documentList.innerHTML = "";
  if (hits.length === 0) {
    documentList.innerHTML = emptyState("documents", `No documents match “${documentSearch.q}”.`);
    return;
  }
  for (const hit of hits) documentList.appendChild(buildDocumentRow(rowFromHit(hit)));
}

// Escape for HTML, then wrap each whitespace-separated query token (2+ chars)
// in <mark>. Keeps the snippet safe to set as innerHTML.
function highlightSnippet(text: string, query: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  let html = esc(text);
  // 3+ chars so filler like "is" / "my" / "of" in the query doesn't speckle
  // the snippet with highlights.
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))];
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(re, "<mark>$1</mark>");
  }
  return html;
}

// Search state: empty query ⇒ show the full list; otherwise the ranked hits.
// `refreshDocuments()` honours this, so a delete / rename / extraction poll
// re-runs the active search rather than dropping the user back to the list.
const documentSearch = { q: "", mode: "hybrid" as DocumentSearchMode };
let documentSearchSeq = 0;

async function runDocumentSearch(): Promise<Array<Pick<Document, "extractionStatus">>> {
  const seq = ++documentSearchSeq;
  documentSearchStatus.hidden = false;
  documentSearchStatus.textContent = "Searching…";
  try {
    const { results } = await api.searchDocuments(documentSearch.q, {
      mode: documentSearch.mode,
      limit: 12,
    });
    if (seq !== documentSearchSeq) return results; // a newer search superseded this one
    renderDocumentHits(results);
    documentSearchStatus.textContent =
      `${results.length} ${results.length === 1 ? "match" : "matches"}` +
      (documentSearch.mode === "semantic" && semanticSearchOff ? " · by meaning needs an embedding model — showing keyword + fuzzy" : "");
    return results;
  } catch (err) {
    if (seq === documentSearchSeq) {
      documentList.innerHTML = "";
      documentSearchStatus.textContent = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return [];
  }
}

async function refreshDocuments(): Promise<Array<Pick<Document, "extractionStatus">>> {
  if (documentSearch.q.trim()) return runDocumentSearch();
  documentSearchStatus.hidden = true;
  const { documents } = await api.listDocuments();
  renderDocuments(documents);
  return documents;
}

let docSearchDebounce: number | undefined;
documentSearchInput.addEventListener("input", () => {
  documentSearch.q = documentSearchInput.value;
  window.clearTimeout(docSearchDebounce);
  docSearchDebounce = window.setTimeout(() => void refreshDocuments(), 220);
});
documentSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && documentSearchInput.value) {
    documentSearchInput.value = "";
    documentSearch.q = "";
    void refreshDocuments();
  }
});
documentSearchMode.addEventListener("change", () => {
  documentSearch.mode = documentSearchMode.value as DocumentSearchMode;
  if (documentSearch.q.trim()) void refreshDocuments();
});

// Inline rename editor: type a new name, or ask the agent to propose one from
// the document's content. The agent only ever *suggests* — the name is applied
// only when the user clicks Save, and an AI-sourced name is logged as coming
// from the document-agent.
function beginDocumentRename(doc: { id: string; filename: string }, li: HTMLLIElement, head: HTMLElement) {
  if (li.querySelector(".doc-rename")) return;
  head.hidden = true;

  const box = document.createElement("div");
  box.className = "doc-rename";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "doc-rename-input";
  input.value = doc.filename;
  input.setAttribute("aria-label", "New document name");

  const save = document.createElement("button");
  save.type = "button";
  save.className = "doc-rename-save";
  save.textContent = "Save";

  const suggest = document.createElement("button");
  suggest.type = "button";
  suggest.className = "doc-preview";
  suggest.textContent = "Suggest with agent";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "doc-preview";
  cancel.textContent = "Cancel";

  const hint = document.createElement("p");
  hint.className = "doc-rename-hint";
  hint.hidden = true;

  let source: "user" | "document-agent" = "user";
  input.addEventListener("input", () => (source = "user"));

  const close = () => {
    box.remove();
    hint.remove();
    head.hidden = false;
  };

  cancel.addEventListener("click", close);

  suggest.addEventListener("click", async () => {
    suggest.disabled = true;
    suggest.textContent = "Thinking…";
    hint.hidden = true;
    try {
      const { suggestion } = await api.suggestDocumentName(doc.id);
      input.value = suggestion.filename;
      source = "document-agent";
      input.focus();
      input.select();
      hint.textContent = "Agent suggestion — edit it or click Save to confirm.";
      hint.hidden = false;
    } catch (err) {
      hint.textContent = `Couldn't suggest a name: ${err instanceof Error ? err.message : String(err)}`;
      hint.hidden = false;
    } finally {
      suggest.disabled = false;
      suggest.textContent = "Suggest with agent";
    }
  });

  const commit = async () => {
    const next = input.value.trim();
    if (!next || next === doc.filename) return close();
    save.disabled = true;
    try {
      await api.renameDocument(doc.id, next, source);
      close();
      void refreshDocuments();
      void refreshActivity();
    } catch (err) {
      save.disabled = false;
      hint.textContent = `Rename failed: ${err instanceof Error ? err.message : String(err)}`;
      hint.hidden = false;
    }
  };

  save.addEventListener("click", () => void commit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void commit();
    if (e.key === "Escape") close();
  });

  box.append(input, save, suggest, cancel);
  head.insertAdjacentElement("afterend", box);
  box.insertAdjacentElement("afterend", hint);
  input.focus();
  input.select();
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
  clearDocumentSearch();
  void pollForExtraction();
});

// After adding a document, drop out of any active search so the new file is
// visible in the list (it may not match the current query).
function clearDocumentSearch() {
  if (!documentSearch.q) return;
  documentSearchInput.value = "";
  documentSearch.q = "";
}

// Picking a file uploads it immediately — there's no separate Upload button.
documentFileInput.addEventListener("change", async () => {
  const file = documentFileInput.files?.[0];
  if (!file) return;
  documentFileInput.disabled = true;
  documentUploadStatus.textContent = `Uploading "${file.name}"…`;
  try {
    const { document: doc } = await api.uploadDocument(file);
    documentUploadStatus.textContent = `Uploaded "${doc.filename}" — extracting…`;
    clearDocumentSearch();
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
  let lastDay = "";
  for (const entry of entries) {
    const day = dayHeading(entry.ts);
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement("li");
      h.className = "activity-day";
      h.textContent = day;
      activityList.appendChild(h);
    }
    const li = document.createElement("li");
    li.className = "activity-row";
    const actor = document.createElement("span");
    actor.className = "activity-actor";
    actor.textContent = humanActor(entry.actor);
    const detail = document.createElement("span");
    detail.className = "activity-detail";
    detail.textContent = entry.detail;
    const ts = document.createElement("time");
    ts.className = "activity-ts";
    ts.dateTime = entry.ts;
    ts.textContent = relativeTime(entry.ts);
    ts.title = new Date(entry.ts).toLocaleString();
    li.append(actor, detail, ts);
    activityList.appendChild(li);
  }
}

async function refreshActivity() {
  const { activity } = await api.listActivity();
  renderActivity(activity);
}

// ---------- routines ----------
const routineList = document.getElementById("routine-list")!;
const routineStatus = document.getElementById("routine-status")!;
const routineNewBtn = document.getElementById("routine-new-btn") as HTMLButtonElement;
const routineForm = document.getElementById("routine-form") as HTMLFormElement;
const routineNameInput = document.getElementById("routine-name") as HTMLInputElement;
const routineAgentSelect = document.getElementById("routine-agent") as HTMLSelectElement;
const routineInstructionInput = document.getElementById("routine-instruction") as HTMLTextAreaElement;
const routineSchedKind = document.getElementById("routine-sched-kind") as HTMLSelectElement;
const routineSchedFields = document.getElementById("routine-sched-fields")!;
const routineDeliverSelect = document.getElementById("routine-deliver") as HTMLSelectElement;
const routineFormStatus = document.getElementById("routine-form-status")!;
const routineCancelBtn = document.getElementById("routine-cancel-btn") as HTMLButtonElement;
const routineSaveBtn = document.getElementById("routine-save-btn") as HTMLButtonElement;

let routines: Routine[] = [];
let editingRoutineId: string | null = null;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function schedFieldsHtml(kind: string): string {
  switch (kind) {
    case "dailyAt":
      return `<label class="field">At<input type="time" id="rs-time" value="07:00" required /></label>`;
    case "weekly":
      return (
        `<label class="field">On<select id="rs-weekday">` +
        WEEKDAY_NAMES.map((d, i) => `<option value="${i}"${i === 1 ? " selected" : ""}>${d}</option>`).join("") +
        `</select></label>` +
        `<label class="field">At<input type="time" id="rs-time" value="18:00" required /></label>`
      );
    case "monthly":
      return (
        `<label class="field">Day<input type="number" id="rs-day" min="1" max="28" value="1" required /></label>` +
        `<label class="field">At<input type="time" id="rs-time" value="09:00" required /></label>`
      );
    case "everyMinutes":
      return (
        `<label class="field">Every<select id="rs-hours">` +
        [1, 2, 3, 4, 6, 8, 12].map((h) => `<option value="${h}"${h === 3 ? " selected" : ""}>${h} hour${h === 1 ? "" : "s"}</option>`).join("") +
        `</select></label>`
      );
    case "onceAt":
      return `<label class="field">On<input type="datetime-local" id="rs-datetime" required /></label>`;
    case "cron":
      return `<label class="field">Cron<input type="text" id="rs-cron" placeholder="0 7 * * 1-5" spellcheck="false" required /></label>`;
    default:
      return "";
  }
}

function renderSchedFields() {
  routineSchedFields.innerHTML = schedFieldsHtml(routineSchedKind.value);
}
routineSchedKind.addEventListener("change", renderSchedFields);

/** Read the visible schedule sub-fields into the API's friendly trigger shape. */
function readTriggerInput(): RoutineTriggerInput {
  const kind = routineSchedKind.value;
  const time = () => (document.getElementById("rs-time") as HTMLInputElement | null)?.value || "09:00";
  if (kind === "dailyAt") return { dailyAt: time() };
  if (kind === "weekly")
    return {
      weeklyOn: WEEKDAY_NAMES[Number((document.getElementById("rs-weekday") as HTMLSelectElement).value)],
      weeklyAt: time(),
    };
  if (kind === "monthly")
    return {
      monthlyDay: Number((document.getElementById("rs-day") as HTMLInputElement).value) || 1,
      monthlyAt: time(),
    };
  if (kind === "everyMinutes")
    return { everyMinutes: Number((document.getElementById("rs-hours") as HTMLSelectElement).value) * 60 };
  if (kind === "onceAt") return { onceAt: (document.getElementById("rs-datetime") as HTMLInputElement).value };
  if (kind === "cron") return { cron: (document.getElementById("rs-cron") as HTMLInputElement).value.trim() };
  return {};
}

/** Best-effort: turn a stored trigger back into the form's fields (for Edit). */
function fillFormFromTrigger(t: Routine["trigger"]) {
  const setTime = (hhmm: string) => {
    const el = document.getElementById("rs-time") as HTMLInputElement | null;
    if (el) el.value = hhmm;
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  if (t.kind === "once") {
    routineSchedKind.value = "onceAt";
    renderSchedFields();
    const d = new Date(t.at);
    if (!Number.isNaN(d.getTime())) {
      (document.getElementById("rs-datetime") as HTMLInputElement).value =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return;
  }
  if (t.kind === "every") {
    const hours = t.minutes / 60;
    if (Number.isInteger(hours) && [1, 2, 3, 4, 6, 8, 12].includes(hours)) {
      routineSchedKind.value = "everyMinutes";
      renderSchedFields();
      (document.getElementById("rs-hours") as HTMLSelectElement).value = String(hours);
    } else {
      routineSchedKind.value = "cron";
      renderSchedFields();
      (document.getElementById("rs-cron") as HTMLInputElement).value = `*/${t.minutes} * * * *`;
    }
    return;
  }
  // cron: recognise the three shapes the form can produce, else "Advanced".
  const parts = t.expr.split(/\s+/);
  const [mi, ho, dom, , dow] = parts;
  const simpleTime = /^\d+$/.test(mi) && /^\d+$/.test(ho);
  if (parts.length === 5 && simpleTime && dom === "*" && dow === "*") {
    routineSchedKind.value = "dailyAt";
    renderSchedFields();
    setTime(`${pad(+ho)}:${pad(+mi)}`);
  } else if (parts.length === 5 && simpleTime && dom === "*" && /^\d$/.test(dow)) {
    routineSchedKind.value = "weekly";
    renderSchedFields();
    (document.getElementById("rs-weekday") as HTMLSelectElement).value = dow;
    setTime(`${pad(+ho)}:${pad(+mi)}`);
  } else if (parts.length === 5 && simpleTime && /^\d+$/.test(dom) && dow === "*") {
    routineSchedKind.value = "monthly";
    renderSchedFields();
    (document.getElementById("rs-day") as HTMLInputElement).value = dom;
    setTime(`${pad(+ho)}:${pad(+mi)}`);
  } else {
    routineSchedKind.value = "cron";
    renderSchedFields();
    (document.getElementById("rs-cron") as HTMLInputElement).value = t.expr;
  }
}

async function openRoutineForm(routine?: Routine) {
  editingRoutineId = routine?.id ?? null;
  routineFormStatus.textContent = "";
  routineForm.hidden = false;
  routineNewBtn.hidden = true;
  routineSaveBtn.textContent = routine ? "Save changes" : "Save routine";

  // Populate the "deliver to" channel list (fresh each open).
  routineDeliverSelect.innerHTML = '<option value="">— nowhere (just here) —</option>';
  try {
    const { channels } = await api.listChannels();
    for (const c of channels) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.title;
      routineDeliverSelect.appendChild(opt);
    }
  } catch {
    /* channels are optional — leave just the default */
  }

  routineNameInput.value = routine?.name ?? "";
  routineAgentSelect.value = routine?.action.agent ?? "planner";
  routineInstructionInput.value = routine?.action.instruction ?? "";
  routineDeliverSelect.value = routine?.deliverChannelId ?? "";
  if (routine) {
    fillFormFromTrigger(routine.trigger);
  } else {
    routineSchedKind.value = "dailyAt";
    renderSchedFields();
  }
  routineNameInput.focus();
}

function closeRoutineForm() {
  routineForm.hidden = true;
  routineNewBtn.hidden = false;
  editingRoutineId = null;
}

routineNewBtn.addEventListener("click", () => void openRoutineForm());
routineCancelBtn.addEventListener("click", closeRoutineForm);

routineForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: routineNameInput.value.trim(),
    trigger: readTriggerInput(),
    action: {
      agent: routineAgentSelect.value as RoutineAgentKind,
      instruction: routineInstructionInput.value.trim(),
    },
    deliverChannelId: routineDeliverSelect.value || null,
  };
  if (!body.name || !body.action.instruction) {
    routineFormStatus.textContent = "Give it a name and an instruction.";
    return;
  }
  routineSaveBtn.disabled = true;
  routineFormStatus.textContent = "Saving…";
  try {
    if (editingRoutineId) await api.updateRoutine(editingRoutineId, body);
    else await api.createRoutine(body);
    closeRoutineForm();
    await refreshRoutines();
  } catch (err) {
    routineFormStatus.textContent = err instanceof Error ? err.message : "Could not save.";
  } finally {
    routineSaveBtn.disabled = false;
  }
});

function routineRunRow(run: RoutineRun): string {
  const when = relativeTime(run.finishedAt ?? run.startedAt);
  const label =
    run.status === "ok"
      ? "✓"
      : run.status === "error"
        ? "⚠"
        : run.status === "running"
          ? "…"
          : "–";
  const text =
    run.status === "error"
      ? escapeHtml(run.error ?? "failed")
      : run.status === "running"
        ? "running…"
        : escapeHtml((run.output ?? "").slice(0, 600) || "(no output)");
  return `<div class="routine-run"><span class="routine-run-ts">${label} ${escapeHtml(when)}</span><span class="routine-run-body">${text}</span></div>`;
}

function renderRoutines() {
  routineList.innerHTML = "";
  if (routines.length === 0) {
    routineList.innerHTML =
      '<li class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>No routines yet. Add one, or ask in Chat — "every morning summarise my day".</span></li>';
    return;
  }
  const agentLabel: Record<string, string> = {
    planner: "the assistant",
    task: "Events",
    document: "Documents",
    notes: "the board",
    tools: "the family tools",
  };
  for (const r of routines) {
    const li = document.createElement("li");
    li.className = "routine-row" + (r.enabled ? "" : " is-off");

    const nextWhen = (iso: string) => {
      const d = new Date(iso);
      return `${friendlyDate(iso, { weekday: true })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    };
    const next = !r.enabled
      ? "paused"
      : r.nextRunAt
        ? `next: ${nextWhen(r.nextRunAt)}`
        : "next: —";
    const last =
      r.lastRunAt && r.lastStatus
        ? `<span class="${r.lastStatus === "ok" ? "routine-last-ok" : r.lastStatus === "error" ? "routine-last-error" : ""}">last ${r.lastStatus === "ok" ? "ran" : r.lastStatus} ${escapeHtml(relativeTime(r.lastRunAt))}</span>`
        : "";

    li.innerHTML = `
      <div class="routine-row-head">
        <span class="routine-switch" role="switch" tabindex="0" aria-checked="${r.enabled}" aria-label="Enabled"></span>
        <span class="routine-name">${escapeHtml(r.name)}</span>
      </div>
      <p class="routine-sched">${escapeHtml(r.triggerText)} · runs ${escapeHtml(agentLabel[r.action.agent] ?? r.action.agent)}</p>
      <p class="routine-instruction">${escapeHtml(r.action.instruction)}</p>
      <div class="routine-sub"><span>${escapeHtml(next)}</span>${last}</div>
      <div class="routine-row-foot"></div>`;

    const foot = li.querySelector(".routine-row-foot")!;
    const runBtn = document.createElement("button");
    runBtn.className = "btn-primary";
    runBtn.type = "button";
    runBtn.textContent = "Run now";
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      runBtn.textContent = "Running…";
      routineStatus.textContent = `Running "${r.name}"…`;
      try {
        const res = await api.runRoutine(r.id);
        routineStatus.textContent =
          res.status === "ok" ? `"${r.name}" ran.` : `"${r.name}" failed: ${res.error ?? "unknown error"}`;
      } catch (err) {
        routineStatus.textContent = err instanceof Error ? err.message : "Run failed.";
      } finally {
        await refreshRoutines();
      }
    });

    const editBtn = document.createElement("button");
    editBtn.className = "btn-ghost";
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => void openRoutineForm(r));

    const delBtn = document.createElement("button");
    delBtn.className = "btn-ghost";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete the routine "${r.name}"?`)) return;
      await api.deleteRoutine(r.id);
      await refreshRoutines();
    });

    foot.append(runBtn, editBtn, delBtn);

    const toggle = li.querySelector(".routine-switch") as HTMLElement;
    const flip = async () => {
      try {
        await api.updateRoutine(r.id, { enabled: !r.enabled });
        await refreshRoutines();
      } catch (err) {
        routineStatus.textContent = err instanceof Error ? err.message : "Could not update.";
      }
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        void flip();
      }
    });

    // Recent runs, lazily loaded when expanded.
    const runs = document.createElement("details");
    runs.className = "routine-runs";
    runs.innerHTML = "<summary>Recent runs</summary><div class='routine-runs-body'>…</div>";
    runs.addEventListener(
      "toggle",
      async () => {
        if (!runs.open) return;
        const bodyEl = runs.querySelector(".routine-runs-body")!;
        try {
          const { runs: history } = await api.listRoutineRuns(r.id, 10);
          bodyEl.innerHTML = history.length ? history.map(routineRunRow).join("") : "<p class='settings-hint'>No runs yet.</p>";
        } catch {
          bodyEl.innerHTML = "<p class='settings-hint'>Couldn't load runs.</p>";
        }
      },
      { once: false }
    );
    li.appendChild(runs);

    routineList.appendChild(li);
  }
}

async function refreshRoutines() {
  if (!routinesEnabled) return;
  try {
    const { routines: list } = await api.listRoutines();
    routines = list;
    renderRoutines();
  } catch (err) {
    routineStatus.textContent = err instanceof Error ? err.message : "Couldn't load routines.";
  }
}

// ---------- skills ----------
// A skill is a markdown playbook the assistant follows for a recurring task.
// Read for everyone, edited by admins (the server enforces both). Scripts, if
// a skill ships any, run sandboxed on the server — this view just lists them.
const skillList = document.getElementById("skill-list")!;
const skillStatus = document.getElementById("skill-status")!;
const skillNewBtn = document.getElementById("skill-new-btn") as HTMLButtonElement;
const skillForm = document.getElementById("skill-form") as HTMLFormElement;
const skillNameInput = document.getElementById("skill-name") as HTMLInputElement;
const skillDescriptionInput = document.getElementById("skill-description") as HTMLInputElement;
const skillWhenInput = document.getElementById("skill-when") as HTMLInputElement;
const skillMarkdownInput = document.getElementById("skill-markdown") as HTMLTextAreaElement;
const skillEnabledCheckbox = document.getElementById("skill-enabled") as HTMLInputElement;
const skillDraftBtn = document.getElementById("skill-draft-btn") as HTMLButtonElement;
const skillDraftStatus = document.getElementById("skill-draft-status")!;
const skillFormStatus = document.getElementById("skill-form-status")!;
const skillCancelBtn = document.getElementById("skill-cancel-btn") as HTMLButtonElement;
const skillSaveBtn = document.getElementById("skill-save-btn") as HTMLButtonElement;

let skills: Skill[] = [];
let editingSkillName: string | null = null;
let skillScriptsRunnable = false;

function isAdmin() {
  return currentUser?.role === "admin";
}

function openSkillForm(skill?: Skill) {
  editingSkillName = skill?.name ?? null;
  skillFormStatus.textContent = "";
  skillDraftStatus.textContent = "";
  skillNameInput.value = skill?.name ?? "";
  skillNameInput.disabled = !!skill; // name is the id — rename = delete + recreate
  skillDescriptionInput.value = skill?.description ?? "";
  skillWhenInput.value = skill?.whenToUse ?? "";
  skillEnabledCheckbox.checked = skill ? skill.enabled : true;
  skillSaveBtn.textContent = skill ? "Save changes" : "Save skill";
  skillForm.hidden = false;
  skillNewBtn.hidden = true;
  if (skill) {
    skillMarkdownInput.value = "Loading…";
    void api
      .getSkill(skill.name)
      .then(({ skill: full }) => {
        skillMarkdownInput.value = full.body;
      })
      .catch(() => {
        skillMarkdownInput.value = "";
        skillFormStatus.textContent = "Couldn't load the skill body.";
      });
  } else {
    skillMarkdownInput.value = "";
  }
  skillNameInput.focus();
}

function closeSkillForm() {
  skillForm.hidden = true;
  skillNewBtn.hidden = false;
  editingSkillName = null;
}

skillNewBtn.addEventListener("click", () => openSkillForm());
skillCancelBtn.addEventListener("click", closeSkillForm);

skillDraftBtn.addEventListener("click", async () => {
  const name = skillNameInput.value.trim().toLowerCase();
  const description = skillDescriptionInput.value.trim();
  if (name.length < 1 || description.length < 3) {
    skillDraftStatus.textContent = "Fill in the name and description first.";
    return;
  }
  skillDraftBtn.disabled = true;
  skillDraftStatus.textContent = "Drafting… (a local model call, ~10–30s)";
  try {
    const { markdown } = await api.draftSkill({ name, description });
    skillMarkdownInput.value = markdown;
    skillDraftStatus.textContent = "Draft ready — review and edit before saving.";
  } catch (err) {
    skillDraftStatus.textContent = err instanceof Error ? err.message : "Draft failed.";
  } finally {
    skillDraftBtn.disabled = false;
  }
});

skillForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = skillNameInput.value.trim().toLowerCase();
  const markdown = skillMarkdownInput.value.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    skillFormStatus.textContent = "Name: lowercase letters, digits and hyphens only.";
    return;
  }
  if (markdown.length < 1) {
    skillFormStatus.textContent = "Write some instructions.";
    return;
  }
  skillSaveBtn.disabled = true;
  skillFormStatus.textContent = "Saving…";
  try {
    await api.saveSkill({
      name,
      description: skillDescriptionInput.value.trim() || undefined,
      whenToUse: skillWhenInput.value.trim() || undefined,
      enabled: skillEnabledCheckbox.checked,
      markdown,
    });
    closeSkillForm();
    await refreshSkills();
  } catch (err) {
    skillFormStatus.textContent = err instanceof Error ? err.message : "Could not save.";
  } finally {
    skillSaveBtn.disabled = false;
  }
});

function renderSkills() {
  skillList.innerHTML = "";
  skillNewBtn.hidden = !isAdmin() || !skillForm.hidden;
  if (skills.length === 0) {
    skillList.innerHTML = `<li class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7l9 5 9-5-9-5Z"/><path d="M3 17l9 5 9-5M3 12l9 5 9-5"/></svg><span>${
      isAdmin() ? "No skills yet. Add one to teach the assistant a repeatable task." : "No skills yet."
    }</span></li>`;
    return;
  }
  for (const s of skills) {
    const li = document.createElement("li");
    li.className = "routine-row" + (s.enabled ? "" : " is-off");
    const scripts = s.scripts.length
      ? `<p class="skill-scripts">Scripts: ${s.scripts.map(escapeHtml).join(", ")}${
          skillScriptsRunnable ? "" : " (script runner unavailable on this server)"
        }</p>`
      : "";
    li.innerHTML = `
      <div class="routine-row-head">
        ${isAdmin() ? `<span class="routine-switch" role="switch" tabindex="0" aria-checked="${s.enabled}" aria-label="Enabled"></span>` : ""}
        <span class="routine-name">${escapeHtml(s.name)}</span>
      </div>
      <p class="routine-instruction">${escapeHtml(s.description)}</p>
      ${s.whenToUse ? `<p class="routine-sched">Use when: ${escapeHtml(s.whenToUse)}</p>` : ""}
      ${scripts}
      <div class="routine-sub"><span>updated ${escapeHtml(relativeTime(s.updatedAt))}</span></div>
      <div class="routine-row-foot"></div>`;

    const foot = li.querySelector(".routine-row-foot")!;
    if (isAdmin()) {
      const editBtn = document.createElement("button");
      editBtn.className = "btn-ghost";
      editBtn.type = "button";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => openSkillForm(s));
      const delBtn = document.createElement("button");
      delBtn.className = "btn-ghost";
      delBtn.type = "button";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete the skill "${s.name}"?`)) return;
        await api.deleteSkill(s.name);
        await refreshSkills();
      });
      foot.append(editBtn, delBtn);

      const toggle = li.querySelector(".routine-switch") as HTMLElement;
      const flip = async () => {
        try {
          await api.setSkillEnabled(s.name, !s.enabled);
          await refreshSkills();
        } catch (err) {
          skillStatus.textContent = err instanceof Error ? err.message : "Could not update.";
        }
      };
      toggle.addEventListener("click", flip);
      toggle.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          void flip();
        }
      });
    }
    skillList.appendChild(li);
  }
}

async function refreshSkills() {
  if (skillsMode === "off") return;
  try {
    const { skills: list, scriptsRunnable } = await api.listSkills();
    skills = list;
    skillScriptsRunnable = scriptsRunnable;
    skillStatus.textContent = "";
    renderSkills();
  } catch (err) {
    skillStatus.textContent = err instanceof Error ? err.message : "Couldn't load skills.";
  }
}

// ---------- MCP connections (Settings) ----------
const mcpForm = document.getElementById("mcp-form") as HTMLFormElement;
const mcpNameInput = document.getElementById("mcp-name") as HTMLInputElement;
const mcpTransportSelect = document.getElementById("mcp-transport") as HTMLSelectElement;
const mcpUrlField = document.getElementById("mcp-url-field") as HTMLElement;
const mcpUrlInput = document.getElementById("mcp-url") as HTMLInputElement;
const mcpHeadersField = document.getElementById("mcp-headers-field") as HTMLElement;
const mcpHeadersInput = document.getElementById("mcp-headers") as HTMLTextAreaElement;
const mcpCommandField = document.getElementById("mcp-command-field") as HTMLElement;
const mcpCommandInput = document.getElementById("mcp-command") as HTMLInputElement;
const mcpAllowHostsField = document.getElementById("mcp-allowhosts-field") as HTMLElement;
const mcpAllowHostsInput = document.getElementById("mcp-allowhosts") as HTMLInputElement;
const mcpFormStatus = document.getElementById("mcp-form-status")!;
const mcpSaveBtn = document.getElementById("mcp-save-btn") as HTMLButtonElement;
const mcpList = document.getElementById("mcp-list")!;

let mcpServers: McpServer[] = [];

function syncMcpTransportFields() {
  const stdio = mcpTransportSelect.value === "stdio";
  mcpUrlField.hidden = stdio;
  mcpHeadersField.hidden = stdio;
  mcpCommandField.hidden = !stdio;
  mcpAllowHostsField.hidden = !stdio;
}
mcpTransportSelect.addEventListener("change", syncMcpTransportFields);
syncMcpTransportFields();

function parseHeaderLines(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

mcpForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = mcpNameInput.value.trim().toLowerCase();
  const transport = mcpTransportSelect.value as McpServer["transport"];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    mcpFormStatus.textContent = "Name: lowercase letters, digits and hyphens only.";
    return;
  }
  const body: McpServer = { name, transport, enabled: true };
  if (transport === "http") {
    body.url = mcpUrlInput.value.trim();
    body.headers = parseHeaderLines(mcpHeadersInput.value);
    if (!/^https?:\/\//i.test(body.url)) {
      mcpFormStatus.textContent = "Enter a full http(s) URL.";
      return;
    }
  } else {
    const parts = mcpCommandInput.value.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      mcpFormStatus.textContent = "Enter a command to run.";
      return;
    }
    body.command = parts[0];
    body.args = parts.slice(1);
    body.allowHosts = mcpAllowHostsInput.value
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
  }
  mcpSaveBtn.disabled = true;
  mcpFormStatus.textContent = "Saving and testing…";
  try {
    const { probe } = await api.saveMcpServer(body);
    mcpFormStatus.textContent = probe.ok
      ? `Connected — ${probe.toolCount ?? 0} tool(s) available.`
      : `Saved, but the test failed: ${probe.error ?? "unknown error"}`;
    mcpForm.reset();
    syncMcpTransportFields();
    await refreshConnections();
  } catch (err) {
    mcpFormStatus.textContent = err instanceof Error ? err.message : "Could not save.";
  } finally {
    mcpSaveBtn.disabled = false;
  }
});

function renderConnections() {
  mcpList.innerHTML = "";
  if (mcpServers.length === 0) {
    mcpList.innerHTML = "<li class='settings-hint'>No connections yet.</li>";
    return;
  }
  for (const s of mcpServers) {
    const li = document.createElement("li");
    li.className = "routine-row" + (s.enabled ? "" : " is-off");
    const target = s.transport === "http" ? s.url : [s.command, ...(s.args ?? [])].join(" ");
    li.innerHTML = `
      <div class="routine-row-head">
        <span class="routine-switch" role="switch" tabindex="0" aria-checked="${s.enabled}" aria-label="Enabled"></span>
        <span class="routine-name">${escapeHtml(s.name)}</span>
        <span class="settings-hint">${s.transport}</span>
      </div>
      <p class="routine-instruction">${escapeHtml(target ?? "")}</p>
      <p class="mcp-row-tools" data-role="tools"></p>
      <div class="routine-row-foot"></div>`;

    const foot = li.querySelector(".routine-row-foot")!;
    const toolsEl = li.querySelector('[data-role="tools"]') as HTMLElement;

    const probeBtn = document.createElement("button");
    probeBtn.className = "btn-ghost";
    probeBtn.type = "button";
    probeBtn.textContent = "Test";
    probeBtn.addEventListener("click", async () => {
      probeBtn.disabled = true;
      toolsEl.textContent = "Testing…";
      toolsEl.classList.remove("mcp-row-error");
      try {
        const res = await api.probeMcpServer(s.name);
        toolsEl.textContent = res.ok ? `${res.toolCount ?? 0} tool(s) available` : `Failed: ${res.error ?? "unknown"}`;
        toolsEl.classList.toggle("mcp-row-error", !res.ok);
      } finally {
        probeBtn.disabled = false;
      }
    });

    const delBtn = document.createElement("button");
    delBtn.className = "btn-ghost";
    delBtn.type = "button";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Remove the "${s.name}" connection?`)) return;
      await api.deleteMcpServer(s.name);
      await refreshConnections();
    });
    foot.append(probeBtn, delBtn);

    const toggle = li.querySelector(".routine-switch") as HTMLElement;
    const flip = async () => {
      try {
        await api.setMcpServerEnabled(s.name, !s.enabled);
        await refreshConnections();
      } catch (err) {
        mcpFormStatus.textContent = err instanceof Error ? err.message : "Could not update.";
      }
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        void flip();
      }
    });

    mcpList.appendChild(li);
  }
}

async function refreshConnections() {
  try {
    const { servers } = await api.listMcpServers();
    mcpServers = servers;
    renderConnections();
  } catch (err) {
    mcpFormStatus.textContent = err instanceof Error ? err.message : "Couldn't load connections.";
  }
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

// Turn a tool operation into a plain imperative phrase a family member can read,
// e.g. { name: "add_loan", description: "Record that someone borrowed an item" }
// → "record that someone borrowed an item". No snake_case, no jargon.
const OP_VERBS =
  /^(record|log|list|show|display|add|create|save|store|mark|remove|delete|update|edit|change|rename|find|look up|search|get|see|view|browse|track|check|set|clear|count|split|calculate|total|note|pick|choose|send)\b/i;
function humanizeOperation(o: ToolOperation): string {
  const d = (o.description ?? "").trim().replace(/\.$/, "");
  if (d && OP_VERBS.test(d)) return d.charAt(0).toLowerCase() + d.slice(1);
  if (d) return `see ${d.charAt(0).toLowerCase()}${d.slice(1)}`;
  const name = (o.name ?? "").replace(/_/g, " ").trim();
  if (!name) return "";
  return o.access === "read" ? `see ${name}` : name;
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

    const revising = tool.revisionState === "revising";

    const footer = document.createElement("div");
    footer.className = "tool-row-foot";
    if (tool.status === "building") {
      const b = document.createElement("span");
      b.className = "document-pending";
      b.textContent = tool.revisionCount > 0 ? "Rebuilding…" : "Building…";
      footer.appendChild(b);
    } else if (tool.status === "failed") {
      const f = document.createElement("span");
      f.className = "document-failed";
      f.textContent = "This didn't come together. Try describing it again, or tweak the wording below.";
      footer.appendChild(f);
      // A failed tool can still be salvaged with an instruction.
      footer.appendChild(makeImproveButton(tool, "Fix it"));
    } else {
      const openBtn = document.createElement("button");
      openBtn.className = "btn-primary";
      openBtn.type = "button";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", () => openTool(tool));
      footer.appendChild(openBtn);

      const inspectBtn = document.createElement("button");
      inspectBtn.className = "doc-preview";
      inspectBtn.type = "button";
      inspectBtn.textContent = "Inspect data";
      inspectBtn.title =
        tool.kind === "server"
          ? "Browse this tool's database (read-only)"
          : "View this tool's saved data (read-only)";
      inspectBtn.addEventListener("click", () => void openDbInspector(tool));
      footer.appendChild(inspectBtn);

      if (revising) {
        const b = document.createElement("span");
        b.className = "document-pending";
        b.textContent = "Improving…";
        footer.appendChild(b);
      } else {
        footer.appendChild(makeImproveButton(tool, "Improve"));
        if (tool.canRevert) {
          const rev = document.createElement("button");
          rev.className = "doc-preview";
          rev.type = "button";
          rev.textContent = "Undo last change";
          rev.addEventListener("click", async () => {
            rev.disabled = true;
            try {
              const { note } = await api.revertTool(tool.id);
              toolStatusEl.textContent = note;
              void refreshTools();
            } catch (err) {
              rev.disabled = false;
              toolStatusEl.textContent = `Could not undo: ${err instanceof Error ? err.message : String(err)}`;
            }
          });
          footer.appendChild(rev);
        }
      }
    }
    li.appendChild(footer);

    // A failed improve: the tool still works, but say the change didn't land.
    if (tool.revisionState && !revising) {
      const warn = document.createElement("p");
      warn.className = "tool-revision-warn";
      warn.textContent = `Last change didn't work: ${tool.revisionState}`;
      li.appendChild(warn);
    } else if (tool.revisionCount > 0 && !revising) {
      const meta = document.createElement("p");
      meta.className = "tool-revision-meta";
      const n = tool.revisionCount;
      meta.textContent = tool.updatedAt
        ? `Updated ${relativeTime(tool.updatedAt).toLowerCase()}`
        : `Improved ${n} time${n === 1 ? "" : "s"}`;
      li.appendChild(meta);
    }

    // For a server tool, show what the chat assistant can do with it.
    if (tool.kind === "server" && tool.status === "ready") {
      const ops = document.createElement("div");
      ops.className = "tool-ops-line";
      li.appendChild(ops);
      void api
        .toolOperations(tool.id)
        .then(({ operations }) => {
          const phrases = operations.map(humanizeOperation).filter(Boolean);
          if (!phrases.length) return;
          const label = document.createElement("span");
          label.className = "tool-ops-label";
          label.textContent = "In Chat you can";
          const list = document.createElement("ul");
          list.className = "tool-ops-items";
          for (const p of phrases) {
            const item = document.createElement("li");
            item.textContent = p;
            list.appendChild(item);
          }
          ops.replaceChildren(label, list);
        })
        .catch(() => {});
    }

    toolList.appendChild(li);
  }
}

// "Improve" / "Fix it": expands to an inline text box that posts to /iterate.
function makeImproveButton(tool: Tool, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "doc-preview";
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", () => {
    if (toolList.querySelector(`[data-improve-for="${tool.id}"]`)) return;
    const form = document.createElement("form");
    form.className = "tool-improve-form";
    form.dataset.improveFor = tool.id;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder =
      label === "Fix it" ? "What should be different? e.g. 'the total is wrong'" : "What should change? e.g. 'add a due date to each loan'";
    input.required = true;
    const send = document.createElement("button");
    send.type = "submit";
    send.textContent = "Send";
    form.append(input, send);
    btn.closest(".tool-row")?.appendChild(form);
    input.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const instruction = input.value.trim();
      if (instruction.length < 3) return;
      send.disabled = true;
      try {
        await api.iterateTool(tool.id, instruction);
        toolStatusEl.textContent = `Improving "${tool.name}" — it'll update in a minute.`;
        void refreshTools();
        void refreshActivity();
        void pollTools();
      } catch (err) {
        send.disabled = false;
        toolStatusEl.textContent = `Couldn't start: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
  });
  return btn;
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
      const busy = (t: Tool) => t.status === "building" || t.revisionState === "revising";
      while (Date.now() < deadline) {
        const tools = await refreshTools().catch(() => null);
        if (tools && !tools.some(busy)) return;
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

// ---------- tool database inspector ----------
// Read-only browsing of a server tool's private SQLite db. Fills the content
// area like the tool viewer; the sidebar stays usable. Backend: GET
// /tools/:id/db, GET /tools/:id/db/rows, POST /tools/:id/db/query.
const dbInspector = document.getElementById("db-inspector") as HTMLElement;
const dbInspectorTitle = document.getElementById("db-inspector-title")!;
const dbInspectorMeta = document.getElementById("db-inspector-meta")!;
const dbInspectorTablesEl = document.getElementById("db-inspector-tables")!;
const dbInspectorGrid = document.getElementById("db-inspector-grid")!;
const dbInspectorStatus = document.getElementById("db-inspector-status")!;
const dbInspectorPager = document.getElementById("db-inspector-pager") as HTMLElement;
const dbInspectorRange = document.getElementById("db-inspector-range")!;
const dbInspectorPrev = document.getElementById("db-inspector-prev") as HTMLButtonElement;
const dbInspectorNext = document.getElementById("db-inspector-next") as HTMLButtonElement;
const dbInspectorClose = document.getElementById("db-inspector-close") as HTMLButtonElement;
const dbInspectorQueryForm = document.getElementById("db-inspector-query") as HTMLFormElement;
const dbInspectorSql = document.getElementById("db-inspector-sql") as HTMLInputElement;

const DB_PAGE = 50;
const dbState = {
  toolId: "",
  table: "",
  offset: 0,
  orderBy: undefined as string | undefined,
  dir: "asc" as "asc" | "desc",
};

function closeDbInspector() {
  if (dbInspector.hidden) return;
  dbInspector.hidden = true;
  dbInspectorTablesEl.innerHTML = "";
  dbInspectorGrid.innerHTML = "";
  dbInspectorPager.hidden = true;
  dbInspectorStatus.textContent = "";
  dbInspectorStatus.classList.remove("is-error");
  dbInspectorSql.value = "";
  dbInspectorQueryForm.hidden = false;
  dbState.toolId = "";
  dbState.table = "";
}
dbInspectorClose.addEventListener("click", () => showView("tools"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !dbInspector.hidden && document.activeElement !== dbInspectorSql) {
    closeDbInspector();
  }
});

function dbError(msg: string) {
  dbInspectorStatus.textContent = msg;
  dbInspectorStatus.classList.add("is-error");
}
function dbInfo(msg: string) {
  dbInspectorStatus.textContent = msg;
  dbInspectorStatus.classList.remove("is-error");
}
// A calm centered placeholder for the "nothing stored yet" cases, instead of
// a status line stranded above a large blank panel.
function dbEmpty(title: string, hint: string) {
  dbInfo("");
  dbInspectorPager.hidden = true;
  dbInspectorTablesEl.hidden = true;
  dbInspectorGrid.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "db-inspector-empty";
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg><p class="db-inspector-empty-title">${escapeHtml(title)}</p><p class="db-inspector-empty-hint">${escapeHtml(hint)}</p>`;
  dbInspectorGrid.appendChild(wrap);
}

function fmtBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function openDbInspector(tool: Tool) {
  closeToolViewer();
  closeSidePanel();
  dbState.toolId = tool.id;
  dbState.table = "";
  dbInspectorTitle.textContent = `${tool.name} — ${tool.kind === "server" ? "database" : "saved data"}`;
  dbInspectorMeta.textContent = "";
  dbInspectorTablesEl.hidden = false;
  dbInspectorTablesEl.innerHTML = "";
  dbInspectorGrid.innerHTML = "";
  dbInspectorPager.hidden = true;
  dbInspectorSql.value = "";
  // The SQL box only makes sense for a real database.
  dbInspectorQueryForm.hidden = tool.kind !== "server";
  dbInfo("Loading…");
  dbInspector.hidden = false;

  try {
    const overview = await api.toolDb(tool.id);
    // Tolerate an older/unexpected response shape (e.g. an agent-core that
    // predates this feature): never index into a field that might be missing.
    const kind = overview?.kind ?? tool.kind;
    const tables = Array.isArray(overview?.tables) ? overview.tables : [];
    const stateEntries = Array.isArray(overview?.stateEntries) ? overview.stateEntries : [];
    dbInspectorMeta.textContent = fmtBytes(overview?.sizeBytes ?? null);

    if (kind !== "server") {
      // A current agent-core always returns a stateEntries array here; its
      // absence means the running backend predates this feature.
      if (!Array.isArray(overview?.stateEntries)) {
        dbInspectorTablesEl.innerHTML = "";
        dbInspectorGrid.innerHTML = "";
        dbError("Please restart the app to finish updating, then try again.");
        return;
      }
      renderStaticState(stateEntries);
      return;
    }

    if (!overview?.exists) {
      dbInspectorTablesEl.innerHTML = "";
      dbEmpty("Nothing saved yet", "This tool starts storing information the first time it's used in Chat or opened.");
      return;
    }
    if (tables.length === 0) {
      dbInspectorTablesEl.innerHTML = "";
      dbEmpty("Nothing saved yet", "Once the tool records something, it'll show up here.");
      return;
    }
    for (const t of tables) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "db-inspector-table-btn" + (t.type === "view" ? " is-view" : "");
      btn.dataset.table = t.name;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = t.name;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = t.rowCount == null ? "" : String(t.rowCount);
      btn.append(name, count);
      btn.addEventListener("click", () => void selectDbTable(t.name));
      dbInspectorTablesEl.appendChild(btn);
    }
    dbInfo("");
    await selectDbTable(tables[0].name);
  } catch (err) {
    dbError(err instanceof Error ? err.message : String(err));
  }
}

// A static (non-server) tool has no SQLite db — it persists small JSON blobs
// through GET/PUT /__state. Show those instead of tables.
function renderStaticState(entries: { key: string; bytes: number }[]) {
  if (!entries || entries.length === 0) {
    dbInspectorTablesEl.innerHTML = "";
    dbEmpty("Nothing saved yet", "This tool hasn't stored anything so far.");
    return;
  }
  for (const e of entries) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "db-inspector-table-btn";
    btn.dataset.stateKey = e.key;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = e.key === "__ls" ? "browser storage" : e.key;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = fmtBytes(e.bytes);
    btn.append(name, count);
    btn.addEventListener("click", () => void loadStaticState(e.key));
    dbInspectorTablesEl.appendChild(btn);
  }
  dbInfo("");
  void loadStaticState(entries[0].key);
}

async function loadStaticState(key: string) {
  for (const b of dbInspectorTablesEl.querySelectorAll<HTMLElement>(".db-inspector-table-btn")) {
    b.classList.toggle("is-active", b.dataset.stateKey === key);
  }
  dbInfo("Loading…");
  try {
    const { value } = await api.toolDbState(dbState.toolId, key);
    dbInspectorGrid.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "db-inspector-json";
    pre.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    dbInspectorGrid.appendChild(pre);
    dbInfo("");
  } catch (err) {
    dbError(err instanceof Error ? err.message : String(err));
  }
}

async function selectDbTable(table: string) {
  dbState.table = table;
  dbState.offset = 0;
  dbState.orderBy = undefined;
  dbState.dir = "asc";
  dbInspectorSql.value = "";
  for (const b of dbInspectorTablesEl.querySelectorAll<HTMLElement>(".db-inspector-table-btn")) {
    b.classList.toggle("is-active", b.dataset.table === table);
  }
  await loadDbRows();
}

async function loadDbRows() {
  if (!dbState.toolId || !dbState.table) return;
  dbInfo("Loading…");
  try {
    const page = await api.toolDbRows(dbState.toolId, {
      table: dbState.table,
      limit: DB_PAGE,
      offset: dbState.offset,
      orderBy: dbState.orderBy,
      dir: dbState.orderBy ? dbState.dir : undefined,
    });
    renderDbGrid(
      page.columns,
      page.rows,
      (col) => {
        if (dbState.orderBy === col) {
          dbState.dir = dbState.dir === "asc" ? "desc" : "asc";
        } else {
          dbState.orderBy = col;
          dbState.dir = "asc";
        }
        void loadDbRows();
      },
    );
    const from = page.total === 0 ? 0 : page.offset + 1;
    const to = Math.min(page.offset + page.limit, page.total);
    dbInspectorRange.textContent = `${from}–${to} of ${page.total}`;
    dbInspectorPrev.disabled = page.offset === 0;
    dbInspectorNext.disabled = to >= page.total;
    dbInspectorPager.hidden = false;
    dbInfo("");
  } catch (err) {
    dbInspectorPager.hidden = true;
    dbError(err instanceof Error ? err.message : String(err));
  }
}

dbInspectorPrev.addEventListener("click", () => {
  dbState.offset = Math.max(0, dbState.offset - DB_PAGE);
  void loadDbRows();
});
dbInspectorNext.addEventListener("click", () => {
  dbState.offset += DB_PAGE;
  void loadDbRows();
});

dbInspectorQueryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const sql = dbInspectorSql.value.trim();
  if (!sql || !dbState.toolId) return;
  dbInfo("Running…");
  dbInspectorPager.hidden = true;
  dbState.table = "";
  dbState.orderBy = undefined;
  for (const b of dbInspectorTablesEl.querySelectorAll(".db-inspector-table-btn")) {
    b.classList.remove("is-active");
  }
  try {
    const res = await api.toolDbQuery(dbState.toolId, sql);
    renderDbGrid(
      res.columns.map((name) => ({ name, type: "", pk: false, notNull: false })),
      res.rows,
    );
    dbInfo(
      res.truncated
        ? `${res.rowCount} rows (truncated — refine the query to see more)`
        : `${res.rowCount} row${res.rowCount === 1 ? "" : "s"}`,
    );
  } catch (err) {
    dbError(err instanceof Error ? err.message : String(err));
  }
});

function renderDbGrid(
  columns: ToolDbColumn[],
  rows: Record<string, unknown>[],
  onSort?: (col: string) => void,
) {
  dbInspectorGrid.innerHTML = "";
  if (rows.length === 0) {
    dbInspectorGrid.innerHTML = `<p class="db-inspector-grid-empty">No rows.</p>`;
    return;
  }
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    const label = document.createElement("span");
    label.textContent = col.name;
    if (col.pk) label.classList.add("pk");
    th.appendChild(label);
    if (col.pk) {
      const key = document.createElement("span");
      key.className = "pk";
      key.textContent = " 🔑";
      th.appendChild(key);
    }
    if (onSort) {
      if (dbState.orderBy === col.name) {
        const s = document.createElement("span");
        s.className = "sort";
        s.textContent = dbState.dir === "asc" ? " ▲" : " ▼";
        th.appendChild(s);
      }
      th.addEventListener("click", () => onSort(col.name));
    } else {
      th.style.cursor = "default";
    }
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      const v = row[col.name];
      if (v === null || v === undefined) {
        td.textContent = "NULL";
        td.classList.add("is-null");
      } else if (typeof v === "object" && (v as { __blob?: boolean }).__blob) {
        const b = v as { bytes: number; preview: string };
        td.textContent = `‹blob ${b.bytes} B›`;
        td.classList.add("is-blob");
        td.title = b.preview;
      } else {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        td.textContent = s;
        td.title = s;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  dbInspectorGrid.appendChild(table);
}

// ---------- settings ----------
const settingsConnectionsSection = document.getElementById("settings-connections-section") as HTMLElement;
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
const settingsBackgroundHeading = document.getElementById("settings-background-heading")!;
const settingsBackgroundHint = document.getElementById("settings-background-hint")!;
const settingsAutostartRow = document.getElementById("settings-autostart-row")!;
const settingsAutostartCheckbox = document.getElementById("settings-autostart-checkbox") as HTMLInputElement;
const settingsAutostartStatusEl = document.getElementById("settings-autostart-status")!;
const settingsQuitBtn = document.getElementById("settings-quit-btn") as HTMLButtonElement;
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

    // Background/tray behavior — Tauri-only (no such thing in a plain
    // browser tab, e.g. `npm run dev` or the test suite).
    const tauriBackground = isTauri();
    settingsBackgroundHeading.hidden = !tauriBackground;
    settingsBackgroundHint.hidden = !tauriBackground;
    settingsAutostartRow.hidden = !tauriBackground;
    settingsQuitBtn.hidden = !tauriBackground;
    if (tauriBackground) {
      settingsAutostartCheckbox.disabled = !settings.isAdmin;
      settingsQuitBtn.disabled = !settings.isAdmin;
      settingsAutostartStatusEl.textContent = settings.isAdmin ? "" : "Only an admin can change this.";
      try {
        const { isEnabled } = await import("@tauri-apps/plugin-autostart");
        settingsAutostartCheckbox.checked = await isEnabled();
      } catch (err) {
        settingsAutostartStatusEl.textContent = `Couldn't check launch-at-login status: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

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

// Closing the window hides it to the tray instead of quitting (see
// docs/DECISIONS.md) — these two Tauri-only controls are the corresponding
// "launch at login" toggle and the explicit way to actually stop everything.
settingsAutostartCheckbox.addEventListener("change", async () => {
  const wantEnabled = settingsAutostartCheckbox.checked;
  settingsAutostartStatusEl.textContent = "Saving…";
  try {
    const autostart = await import("@tauri-apps/plugin-autostart");
    await (wantEnabled ? autostart.enable() : autostart.disable());
    settingsAutostartStatusEl.textContent = wantEnabled
      ? "Family Agent will launch at login."
      : "Launch at login turned off.";
  } catch (err) {
    settingsAutostartCheckbox.checked = !wantEnabled;
    settingsAutostartStatusEl.textContent = `Couldn't change this: ${err instanceof Error ? err.message : String(err)}`;
  }
});

settingsQuitBtn.addEventListener("click", async () => {
  if (!confirm("Quit Family Agent completely? Other devices won't be able to reach it until you reopen this app.")) {
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("quit_app");
  } catch (err) {
    settingsAutostartStatusEl.textContent = `Couldn't quit: ${err instanceof Error ? err.message : String(err)}`;
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

const connError = document.getElementById("conn-error")!;
const connErrorDetail = document.getElementById("conn-error-detail")!;
const connRetry = document.getElementById("conn-retry") as HTMLButtonElement;

// agent-core is spawned by the shell on launch, so the first few boot() calls
// can race its startup. Retry a bounded number of times, then show a visible
// error instead of leaving the window blank forever (the old behaviour).
let bootAttempt = 0;
const BOOT_MAX_ATTEMPTS = 8; // ~12s at 1.5s spacing
let bootTimer: ReturnType<typeof setTimeout> | undefined;

function showGate(mode: "setup" | "login" | "conn-error", serverName: string, detail?: string) {
  appEl.hidden = true;
  gate.hidden = false;
  setupForm.hidden = mode !== "setup";
  loginForm.hidden = mode !== "login";
  connError.hidden = mode !== "conn-error";
  loginTitle.textContent = serverName ? `Sign in to ${serverName}` : "Sign in";
  if (mode === "conn-error" && detail) connErrorDetail.textContent = detail;
  if (mode !== "conn-error") {
    (mode === "setup" ? setupForm : loginForm).querySelector("input")?.focus();
  }
}

connRetry.addEventListener("click", () => {
  connRetry.disabled = true;
  connErrorDetail.textContent = "Reconnecting…";
  bootAttempt = 0;
  void boot().finally(() => {
    connRetry.disabled = false;
  });
});

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
  bootAttempt++;
  try {
    const status = await api.authStatus();
    bootAttempt = 0;
    if (status.needsSetup) return showGate("setup", status.serverName);
    try {
      enterApp((await api.me()).user);
    } catch {
      clearToken();
      showGate("login", status.serverName);
    }
  } catch {
    if (bootAttempt >= BOOT_MAX_ATTEMPTS) {
      showGate(
        "conn-error",
        "",
        "The Family Agent background service isn't responding on this machine. " +
          "It may still be starting up, or another copy may be holding its port."
      );
      return;
    }
    // agent-core isn't up yet — retry. statusText lives inside the (hidden) app
    // shell, so this line is only visible once we're past the gate.
    statusText.textContent = "starting agent-core…";
    clearTimeout(bootTimer);
    bootTimer = setTimeout(() => void boot(), 1500);
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
const messageMicBtn = document.getElementById("message-mic-btn") as HTMLButtonElement;
const messageExpandBtn = document.getElementById("message-expand-btn") as HTMLButtonElement;
const messageSlashMenu = document.getElementById("message-slash-menu")!;
const messageSlashChip = document.getElementById("message-slash-chip")!;
const messageHelpBtn = document.getElementById("message-help-btn") as HTMLButtonElement;
messageHelpBtn.addEventListener("click", () => openSidePanel("Slash commands", slashHelpHtml()));

const messageTray = makeImageTray(messageAttachmentsEl, appendMessageError);
messageAttachBtn.addEventListener("click", () => messageImageInput.click());
messageImageInput.addEventListener("change", () => {
  if (messageImageInput.files) void messageTray.addFiles(Array.from(messageImageInput.files));
  messageImageInput.value = "";
});
wireImagePasteAndDrop(messageTray, messageInput, messageLog);

// Same composer plumbing as the 1:1 chat: 1→3-line auto-grow with an expand
// button, "/" command autocomplete, and voice input.
const messageGrow = wireAutoGrow(messageInput, messageForm, messageExpandBtn);
const messageSlash = wireSlashMenu(
  messageInput,
  messageSlashMenu,
  messageSlashChip,
  messageForm,
  messageGrow.refresh
);
wireMic(messageMicBtn, messageInput, appendMessageError, messageGrow.refresh);

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
  messageInput.value = "";
  messageGrow.reset();
  messageSlash.clear();
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
  // The "/" autocomplete in the message composer shares slashTools with Chat.
  void refreshTools().then((tools) => {
    slashTools = tools;
  });
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

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = messageInput.value.trim();
  const cmd = messageSlash.getCommand();
  const images = messageTray.images.slice();
  if ((!typed && !images.length && !cmd) || !activeChannelId) return;
  // The server requires a non-empty body; "/cmd rest", or the text, or an
  // image-only stand-in.
  const body = cmd
    ? `/${cmd} ${typed}`.trimEnd()
    : typed || (images.length > 1 ? "(shared images)" : "(shared an image)");
  messageInput.value = "";
  messageGrow.reset();
  messageSlash.clear();
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


// ---------- Board (physical corkboard of sticky notes) ----------
const NOTE_COLORS = ["butter", "mint", "sky", "blush", "lilac"] as const;
const NOTE_W = 176; // keep in sync with .note-card width in style.css
const NOTE_H = 176;
const noteBoard = document.getElementById("note-board")!;
const noteAddBtn = document.getElementById("note-add") as HTMLButtonElement;
const noteStatus = document.getElementById("note-status")!;
const boardToggle = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.seg-toggle [data-board]')
);

let boardScope: NoteScope = "shared";
let notes: StickyNote[] = [];
let boardPollTimer: number | null = null;
// A drag or an in-place edit is in progress — don't let a poll wipe the DOM
// out from under it.
let boardBusy = false;
// A note we just created and want to drop straight into edit mode.
let autoEditId: string | null = null;

for (const btn of boardToggle) {
  btn.addEventListener("click", () => {
    boardScope = btn.dataset.board as NoteScope;
    for (const b of boardToggle) b.classList.toggle("is-active", b === btn);
    void refreshNotes();
  });
}

/** Deterministic small tilt (deg) so the board looks pinned-on, not gridded. */
function noteTilt(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 7) - 3) * 0.9; // -2.7°..+2.7°
}

function clampToBoard(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(0, noteBoard.clientWidth - NOTE_W);
  const maxY = Math.max(0, noteBoard.clientHeight - NOTE_H);
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

function renderBoard() {
  if (boardBusy) return;
  noteBoard.innerHTML = "";
  if (notes.length === 0) {
    const hint = document.createElement("p");
    hint.className = "note-board-empty";
    hint.textContent = 'Nothing pinned up yet. Hit "+ Add note".';
    noteBoard.appendChild(hint);
    return;
  }
  for (const n of notes) noteBoard.appendChild(makeNoteEl(n));
}

function makeNoteEl(n: StickyNote): HTMLElement {
  const card = document.createElement("div");
  // A colour the agent invented (or an older value) falls back to butter.
  const noteColor = (NOTE_COLORS as readonly string[]).includes(n.color) ? n.color : "butter";
  card.className = `note-card note-${noteColor}`;
  card.dataset.id = n.id;
  const { x, y } = clampToBoard(n.x, n.y);
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.setProperty("--tilt", `${noteTilt(n.id)}deg`);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "note-card-del";
  del.setAttribute("aria-label", "Remove note");
  del.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    notes = notes.filter((m) => m.id !== n.id);
    renderBoard();
    await api.deleteNote(n.id).catch(() => {});
    void refreshNotes();
  });

  const body = document.createElement("div");
  body.className = "note-card-text";
  if (n.text) {
    body.textContent = n.text;
  } else {
    body.classList.add("is-placeholder");
    body.textContent = "Type here…";
  }

  const palette = document.createElement("div");
  palette.className = "note-card-palette";
  for (const color of NOTE_COLORS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = `note-swatch note-${color}` + (color === noteColor ? " is-active" : "");
    sw.setAttribute("aria-label", color);
    sw.addEventListener("click", async (e) => {
      e.stopPropagation();
      n.color = color;
      card.className = `note-card note-${color}`;
      for (const s of palette.children) s.classList.toggle("is-active", s === sw);
      await api.updateNote(n.id, { color }).catch(() => {});
    });
    palette.appendChild(sw);
  }

  card.append(del, body, palette);
  wireNoteDrag(card, n, body);
  if (autoEditId === n.id) {
    autoEditId = null;
    // Let the element land in the DOM before focusing the editor.
    queueMicrotask(() => startEditNote(card, n, body));
  }
  return card;
}

// Pointer-drag that also acts as a click-to-edit when the pointer barely moves.
function wireNoteDrag(card: HTMLElement, n: StickyNote, body: HTMLElement) {
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".note-card-del, .note-card-palette, textarea")) return;

    const boardRect = noteBoard.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = n.x;
    const originY = n.y;
    const grabX = e.clientX - boardRect.left - n.x;
    const grabY = e.clientY - boardRect.top - n.y;
    let moved = false;

    boardBusy = true;
    card.setPointerCapture(e.pointerId);
    card.classList.add("is-dragging");

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      const p = clampToBoard(ev.clientX - boardRect.left - grabX, ev.clientY - boardRect.top - grabY);
      n.x = p.x;
      n.y = p.y;
      card.style.left = `${p.x}px`;
      card.style.top = `${p.y}px`;
    };
    const onUp = async (ev?: PointerEvent) => {
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      card.classList.remove("is-dragging");
      boardBusy = false;
      if (!moved) {
        if (ev?.type !== "pointercancel") startEditNote(card, n, body);
        return;
      }
      // Move to the end so it renders on top next time.
      notes = notes.filter((m) => m.id !== n.id).concat(n);
      if (n.x !== originX || n.y !== originY) {
        await api.updateNote(n.id, { x: Math.round(n.x), y: Math.round(n.y) }).catch(() => {});
      }
    };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  });
}

function startEditNote(card: HTMLElement, n: StickyNote, body: HTMLElement) {
  if (card.querySelector("textarea")) return;
  boardBusy = true;
  const ta = document.createElement("textarea");
  ta.className = "note-card-edit";
  ta.value = n.text;
  ta.placeholder = "Type here…";
  body.replaceWith(ta);

  let done = false;
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    boardBusy = false;
    const text = ta.value.trim();
    if (commit && text !== n.text) {
      n.text = text;
      await api.updateNote(n.id, { text }).catch(() => {});
    }
    // A note left completely blank is clutter on a real board — clear it away.
    if (!n.text.trim()) {
      notes = notes.filter((m) => m.id !== n.id);
      await api.deleteNote(n.id).catch(() => {});
    }
    await refreshNotes();
  };

  ta.addEventListener("blur", () => void finish(true));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      ta.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      void finish(false);
    }
  });
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

noteAddBtn.addEventListener("click", async () => {
  noteStatus.textContent = "";
  // Cascade new notes from the top-left so repeated adds don't stack exactly.
  const n = notes.length;
  const pos = clampToBoard(24 + (n % 6) * 26, 24 + (n % 6) * 26);
  const color = NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)];
  try {
    const { note } = await api.createNote(boardScope, "", color, pos);
    autoEditId = note.id;
    await refreshNotes();
  } catch (err) {
    noteStatus.textContent = err instanceof Error ? err.message : String(err);
  }
});

async function refreshNotes(force = false) {
  // A background poll must not pull the notes array out from under an active
  // drag or in-place edit. An explicit refresh (after our own mutation) passes
  // force.
  if (boardBusy && !force) return;
  try {
    notes = (await api.listNotes(boardScope)).notes;
    renderBoard();
  } catch {
    /* ignore */
  }
}

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
    ? `<p class="side-panel-hint">Key dates: ${doc.extracted.importantDates
        .map((d) => escapeHtml(friendlyDate(d, { weekday: true })))
        .join(" · ")}</p>`
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
      ? `<p class="side-panel-hint">Due ${escapeHtml(friendlyDateTime(task.dueDate, task.dueTime))}</p>`
      : "";
    openSidePanel(
      task.title,
      `<div class="side-panel-meta"><span class="category-chip">${task.status === "done" ? "Done" : "To do"}</span></div>
       ${when}
       ${task.notes ? `<p class="side-panel-summary">${escapeHtml(task.notes)}</p>` : ""}
       <p class="side-panel-hint">Open the Events tab to reschedule or complete it.</p>`
    );
  } catch (err) {
    if (gen !== panelGen) return;
    openSidePanel("Not found", `<p class="side-panel-hint">${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`);
  }
}

async function openToolPanel(id: string) {
  openSidePanel("Loading…", `<p class="side-panel-hint">Loading…</p>`);
  const gen = panelGen;
  try {
    const [{ tool }, { operations }] = await Promise.all([api.getTool(id), api.toolOperations(id)]);
    if (gen !== panelGen) return;
    const phrases = operations.map(humanizeOperation).filter(Boolean);
    const ops = phrases.length
      ? `<ul class="tool-op-list">${phrases.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`
      : "";
    openSidePanel(
      tool.name,
      `<p class="side-panel-summary">${escapeHtml(tool.description)}</p>
       ${phrases.length ? `<p class="side-panel-hint">In Chat you can:</p>${ops}` : ""}
       <button type="button" class="btn-primary" id="tool-panel-open">Open tool</button>`
    );
    document.getElementById("tool-panel-open")?.addEventListener("click", () => {
      closeSidePanel();
      showView("tools");
      void refreshTools().then((tools) => {
        const t = tools.find((x) => x.id === id);
        if (t) openTool(t);
      });
    });
  } catch (err) {
    if (gen !== panelGen) return;
    openSidePanel("Not found", `<p class="side-panel-hint">${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`);
  }
}

/** Render the assistant's task/document/tool references as clickable chips under its bubble. */
function appendReferences(afterEl: HTMLElement, references: ChatReference[]) {
  const wrap = document.createElement("div");
  wrap.className = "chat-references";
  const label = document.createElement("span");
  label.className = "chat-references-label";
  label.textContent = "References";
  wrap.appendChild(label);
  for (const ref of references) {
    // A web page the research agent opened — a real link, not a panel.
    if (ref.type === "link") {
      const a = document.createElement("a");
      a.className = "ref-chip ref-chip-link";
      a.textContent = ref.label.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48);
      a.href = ref.id;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.title = ref.id;
      wrap.appendChild(a);
      continue;
    }
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `ref-chip ref-chip-${ref.type}`;
    chip.textContent = ref.label;
    chip.addEventListener("click", () => {
      if (ref.type === "document") void openDocumentPanel(ref.id);
      else if (ref.type === "tool") void openToolPanel(ref.id);
      else void openTaskPanel(ref.id);
    });
    wrap.appendChild(chip);
  }
  afterEl.insertAdjacentElement("afterend", wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

void boot();

// Tell the index.html watchdog the module evaluated — no reload needed.
(window as unknown as Record<string, unknown>).__mainLoaded = true;
try {
  sessionStorage.removeItem("familyAgent.reloadedOnce");
} catch {
  /* private mode / disabled storage */
}
