import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ScopedStore } from "../db.js";
import { config } from "../config.js";
import { resolveOriginalPath } from "../documentFiles.js";
import {
  listWorkspace,
  readWorkspaceText,
  importFile,
  writeWorkspaceText,
  workspacePath,
  clearWorkspace,
} from "../shell/workspace.js";
import { runTool, runShellScript, toolCatalogText, type RunOutcome } from "../shell/executor.js";
import type { OnReference } from "./references.js";

// Tools for the `workshop-agent` subagent (and the `/run` forced turn). The
// model works in a per-user file workspace: it imports a document or a
// finished workspace file, runs allow-listed CLI tools over it inside a
// network-free bubblewrap sandbox, and saves results back as documents.

export interface WorkshopToolDeps {
  userId: string;
  store: ScopedStore;
  logActivity: (actor: string, action: string, detail: string) => void;
  /** Promote a workspace file into the document store (runs the ingest pipeline). */
  saveAsDocument: (filename: string, bytes: Buffer) => Promise<{ id: string; filename: string }>;
  /** Drop a workspace file into this user's watched inbox folder. */
  saveToInbox: (filename: string, bytes: Buffer) => Promise<void>;
  onReference?: OnReference;
}

function renderRun(o: RunOutcome): string {
  const parts: string[] = [];
  if (o.timedOut) parts.push("⏱ The command hit the time limit and was stopped.");
  parts.push(`exit code: ${o.code ?? "killed"}`);
  if (o.stdout.trim()) parts.push(`stdout:\n${o.stdout.trim()}`);
  if (o.stderr.trim()) parts.push(`stderr:\n${o.stderr.trim()}`);
  parts.push(o.changedFiles.length ? `files changed: ${o.changedFiles.join(", ")}` : "no files changed");
  return parts.join("\n");
}

export function makeWorkshopTools(deps: WorkshopToolDeps) {
  const { userId, store } = deps;

  const listWorkspaceTool = tool(
    async () => {
      const files = listWorkspace(userId);
      if (files.length === 0) return "The workspace is empty. Import a document first.";
      return files.map((f) => `  ${f.name}  (${(f.bytes / 1024).toFixed(1)} KB)`).join("\n");
    },
    { name: "list_workspace", description: "List the files currently in your working folder.", schema: z.object({}) }
  );

  const listToolsTool = tool(
    async () => {
      const cat = toolCatalogText();
      return cat
        ? `Command-line tools you can run with run_command:\n${cat}`
        : "No command-line tools are installed on this server.";
    },
    { name: "list_tools", description: "List the command-line tools available to run_command.", schema: z.object({}) }
  );

  const importDocument = tool(
    async ({ query }) => {
      const hits = store.searchDocuments(query, { limit: 3 });
      if (hits.length === 0) return `No document matches "${query}".`;
      const doc = store.getDocument(hits[0].id);
      if (!doc) return `No document matches "${query}".`;
      const src = await resolveOriginalPath(userId, doc.id, doc.originalDiskName, doc.sourcePath);
      let name: string;
      if (src) {
        name = importFile(userId, src, doc.filename);
      } else {
        // Pasted-text document — no original file; bring in the text under the
        // document's own name (adding .txt only if it has no extension).
        const fname = /\.[a-z0-9]{1,8}$/i.test(doc.filename) ? doc.filename : `${doc.filename}.txt`;
        name = writeWorkspaceText(userId, fname, doc.rawText);
      }
      deps.logActivity("workshop-agent", "workspace.import", `Imported "${doc.filename}" to the workspace`);
      deps.onReference?.({ type: "document", id: doc.id });
      return `Imported "${doc.filename}" as ${name}.${hits.length > 1 ? ` (Other matches: ${hits.slice(1).map((h) => h.filename).join(", ")})` : ""}`;
    },
    {
      name: "import_document",
      description:
        "Copy one of the family's documents into your working folder so you can process it. Give a few keywords to find it.",
      schema: z.object({ query: z.string().min(2).describe("Keywords identifying the document") }),
    }
  );

  const readText = tool(
    async ({ name }) => {
      try {
        return readWorkspaceText(userId, name);
      } catch (err) {
        return (err as Error).message;
      }
    },
    {
      name: "read_text_file",
      description: "Read a text file (txt, csv, json, md…) from your working folder.",
      schema: z.object({ name: z.string().min(1) }),
    }
  );

  const runCommand = tool(
    async ({ tool: toolName, args }) => {
      let outcome: RunOutcome;
      try {
        outcome = await runTool(userId, toolName, args ?? []);
      } catch (err) {
        return (err as Error).message;
      }
      deps.logActivity("workshop-agent", "shell.run", `Ran ${toolName} ${(args ?? []).join(" ")}`.slice(0, 200));
      return renderRun(outcome);
    },
    {
      name: "run_command",
      description:
        "Run ONE command-line tool over your working folder. `tool` is a name from list_tools; `args` is the argument list (each item separate — no pipes, no shell). Refer to files by plain name. Example: tool 'qpdf', args ['--empty','--pages','a.pdf','b.pdf','--','merged.pdf'].",
      schema: z.object({
        tool: z.string().min(1),
        args: z.array(z.string()).default([]),
      }),
    }
  );

  const saveOutput = tool(
    async ({ name, destination }) => {
      let path: string;
      try {
        path = workspacePath(userId, name);
      } catch (err) {
        return (err as Error).message;
      }
      const bytes = readFileSync(path);
      if (destination === "inbox") {
        await deps.saveToInbox(basename(name), bytes);
        deps.logActivity("workshop-agent", "workspace.save", `Saved ${name} to the watched folder`);
        return `Saved ${name} to the watched folder — it'll be filed as a document shortly.`;
      }
      const saved = await deps.saveAsDocument(basename(name), bytes);
      deps.onReference?.({ type: "document", id: saved.id });
      deps.logActivity("workshop-agent", "workspace.save", `Saved ${name} as a document`);
      return `Saved ${name} as the document "${saved.filename}".`;
    },
    {
      name: "save_output",
      description:
        "Save a finished file from your working folder into the family's documents (destination 'document', the default) or into the watched folder (destination 'inbox').",
      schema: z.object({
        name: z.string().min(1),
        destination: z.enum(["document", "inbox"]).default("document"),
      }),
    }
  );

  const clearWorkspaceTool = tool(
    async () => {
      clearWorkspace(userId);
      return "Working folder cleared.";
    },
    { name: "clear_workspace", description: "Delete everything in your working folder.", schema: z.object({}) }
  );

  const runShell = tool(
    async ({ script }) => {
      let outcome: RunOutcome;
      try {
        outcome = await runShellScript(userId, script);
      } catch (err) {
        return (err as Error).message;
      }
      deps.logActivity("workshop-agent", "shell.script", `Ran a shell script (${script.length} chars)`);
      return renderRun(outcome);
    },
    {
      name: "run_shell",
      description:
        "Run an arbitrary bash script in your working folder (sandboxed, no network). Use this only when run_command's tools can't do the job.",
      schema: z.object({ script: z.string().min(1) }),
    }
  );

  return [
    listWorkspaceTool,
    listToolsTool,
    importDocument,
    readText,
    runCommand,
    saveOutput,
    clearWorkspaceTool,
    ...(config.shellUnrestricted ? [runShell] : []),
  ];
}
