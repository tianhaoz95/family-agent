import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// The only piece of config a user can change from the app itself (via the
// desktop Settings page) rather than an env var + restart. Small and
// file-based on purpose — this app has no database migration story and
// doesn't need one for a single string.
interface PersistedSettings {
  inboxDir?: string;
}

function settingsPath(dataDir: string): string {
  return `${dataDir}/settings.json`;
}

export function readPersistedInboxDir(dataDir: string): string | undefined {
  try {
    const raw = readFileSync(settingsPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as PersistedSettings;
    return typeof parsed.inboxDir === "string" ? parsed.inboxDir : undefined;
  } catch {
    return undefined;
  }
}

export function persistInboxDir(dataDir: string, inboxDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const settings: PersistedSettings = { inboxDir };
  writeFileSync(settingsPath(dataDir), JSON.stringify(settings, null, 2));
}
