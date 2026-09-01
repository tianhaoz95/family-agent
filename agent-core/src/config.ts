import { readPersistedInboxDir } from "./settingsFile.js";

// Local by default, cloud by explicit grant (see docs/DECISIONS.md).
// Nothing in this file reaches off-box; OLLAMA_BASE_URL always points at
// localhost or another node on the family tailnet, never a public host.
const dataDir = process.env.FAMILY_AGENT_DATA_DIR ?? new URL("../data", import.meta.url).pathname;

// inboxDir precedence: explicit env var > persisted setting (from the
// desktop Settings page, PUT /settings) > derived default. The env var
// always wins so an operator's explicit override can't be silently
// shadowed by a value saved from the UI on a previous run.
export const config = {
  port: Number(process.env.PORT ?? 4173),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  model: process.env.FAMILY_AGENT_MODEL ?? "gemma4:e2b",
  dataDir,
  // The "drop a file in a watched folder" story from the architecture notes.
  // Derived from dataDir (not hardcoded) so overriding FAMILY_AGENT_DATA_DIR
  // moves both together, unless FAMILY_AGENT_INBOX_DIR is set explicitly. A
  // real deployment would point this at the NAS/cloud-mounted directory
  // instead of anywhere under dataDir. This property is mutated at runtime
  // by PUT /settings (see server.ts) — read it fresh, don't cache it.
  inboxDir: process.env.FAMILY_AGENT_INBOX_DIR ?? readPersistedInboxDir(dataDir) ?? `${dataDir}/inbox`,
};

export function dbPath(): string {
  return `${config.dataDir}/family-agent.db`;
}
