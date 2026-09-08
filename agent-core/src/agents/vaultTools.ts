import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { VaultEntryRecord } from "../db.js";
import { trigramSimilarity } from "../db.js";
import { VaultLockedError, VaultAccessError, type VaultService } from "../vault/service.js";

// The vault-agent's tools. Deliberately read-only: the assistant looks a
// credential up, it never creates or changes one (that's a deliberate human
// action in the Vault screen). Bound to one user's id — a "/vault" chat turn
// runs as the person who typed it, so "my passwords" is always their own vault
// plus the shared family vault, never anyone else's private entries.
//
// Every reveal is logged (VaultService does it) and the returned secret is
// pushed to `onReveal` so the chat route can redact it out of the stored
// transcript — the live answer shows the password, the saved history shows a
// placeholder. See docs/DECISIONS.md → "Password vault".

export interface VaultToolDeps {
  vault: VaultService;
  userId: string;
  /** Called with every secret value handed back, for transcript redaction. */
  onReveal?: (secret: string) => void;
}

function describeEntry(e: VaultEntryRecord): string {
  const bits = [
    `"${e.title}"`,
    e.username ? `user: ${e.username}` : "",
    e.url ? e.url : "",
    e.scope === "shared" ? "(shared)" : "",
    e.hasTotp ? "[has 2FA]" : "",
    `id: ${e.id}`,
  ].filter(Boolean);
  return `- ${bits.join("  ·  ")}`;
}

/** Score an entry against a free-text query. */
function scoreEntry(e: VaultEntryRecord, q: string): number {
  const query = q.toLowerCase().trim();
  if (!query) return 0;
  const hay = [e.title, e.username ?? "", e.url ?? "", e.folder ?? ""].map((s) => s.toLowerCase());
  let score = 0;
  for (const [i, field] of hay.entries()) {
    if (!field) continue;
    if (field === query) score += [10, 6, 6, 4][i];
    else if (field.includes(query) || query.includes(field)) score += [6, 4, 4, 2][i];
  }
  score += trigramSimilarity(e.title, query) * 4;
  // host match: query "netflix" vs url "https://netflix.com/login"
  try {
    const host = e.url ? new URL(e.url.includes("://") ? e.url : `https://${e.url}`).hostname : "";
    if (host && (host.includes(query) || query.includes(host.replace(/^www\./, "")))) score += 5;
  } catch {
    /* not a URL */
  }
  return score;
}

function resolveOne(
  entries: VaultEntryRecord[],
  query: string
): { entry: VaultEntryRecord } | { ambiguous: VaultEntryRecord[] } | { none: true } {
  const byId = entries.find((e) => e.id === query.trim());
  if (byId) return { entry: byId };
  const ranked = entries
    .map((e) => ({ e, s: scoreEntry(e, query) }))
    .filter((x) => x.s > 1.5)
    .sort((a, b) => b.s - a.s);
  if (ranked.length === 0) return { none: true };
  if (ranked.length === 1 || ranked[0].s >= ranked[1].s * 1.8) return { entry: ranked[0].e };
  return { ambiguous: ranked.slice(0, 5).map((x) => x.e) };
}

function friendlyError(err: unknown): string {
  if (err instanceof VaultLockedError) return "The vault is locked. Ask the person to unlock it in the app, then try again.";
  if (err instanceof VaultAccessError) return err.message;
  return `Couldn't read the vault: ${(err as Error)?.message ?? String(err)}`;
}

export function makeVaultTools(deps: VaultToolDeps) {
  const { vault, userId } = deps;

  const searchVault = tool(
    async ({ query }) => {
      try {
        const entries = vault.listEntries(userId);
        if (entries.length === 0) return "The vault has no entries yet.";
        if (!query || !query.trim()) {
          return `Vault entries (${entries.length}):\n${entries.map(describeEntry).join("\n")}`;
        }
        const ranked = entries
          .map((e) => ({ e, s: scoreEntry(e, query) }))
          .filter((x) => x.s > 1)
          .sort((a, b) => b.s - a.s)
          .slice(0, 10)
          .map((x) => x.e);
        if (ranked.length === 0) return `No vault entry matches "${query}".`;
        return `Matches for "${query}":\n${ranked.map(describeEntry).join("\n")}`;
      } catch (err) {
        return friendlyError(err);
      }
    },
    {
      name: "search_vault",
      description:
        "List the person's saved credentials (their own + the shared family vault) matching a name, website, or username. Returns titles, usernames, and ids ONLY — never a password or code. Call with an empty query to list everything. Use this first to find the right entry id, then get_password or get_totp_code.",
      schema: z.object({
        query: z.string().default("").describe("A site or account name, e.g. 'Netflix', 'chase bank', 'gmail'"),
      }),
    }
  );

  const getPassword = tool(
    async ({ query }) => {
      try {
        const entries = vault.listEntries(userId);
        const r = resolveOne(entries, query);
        if ("none" in r) return `No vault entry matches "${query}". Try search_vault to see what's saved.`;
        if ("ambiguous" in r) {
          return `Several entries match "${query}" — ask which one, then call again with its id:\n${r.ambiguous
            .map(describeEntry)
            .join("\n")}`;
        }
        const revealed = vault.revealPassword(userId, r.entry.id, {
          actor: "vault-agent",
          onReveal: deps.onReveal,
        });
        if (!revealed.password) {
          return `"${r.entry.title}" has no password saved${
            revealed.username ? ` (username: ${revealed.username})` : ""
          }.`;
        }
        const lines = [`Entry: ${r.entry.title}${r.entry.scope === "shared" ? " (shared)" : ""}`];
        if (revealed.username) lines.push(`Username: ${revealed.username}`);
        lines.push(`Password: ${revealed.password}`);
        if (revealed.notes) lines.push(`Notes: ${revealed.notes}`);
        return lines.join("\n");
      } catch (err) {
        return friendlyError(err);
      }
    },
    {
      name: "get_password",
      description:
        "Get the username and password for ONE saved credential. Pass either the exact entry id (from search_vault) or a site/account name. Only use this when the person explicitly asked for a password in their message.",
      schema: z.object({
        query: z.string().min(1).describe("An entry id, or a site/account name like 'Netflix'"),
      }),
    }
  );

  const getTotpCode = tool(
    async ({ query }) => {
      try {
        const entries = vault.listEntries(userId);
        const r = resolveOne(
          entries.filter((e) => e.hasTotp),
          query
        );
        if ("none" in r) {
          return `No vault entry with a two-factor code matches "${query}".`;
        }
        if ("ambiguous" in r) {
          return `Several entries match "${query}" — ask which one, then call again with its id:\n${r.ambiguous
            .map(describeEntry)
            .join("\n")}`;
        }
        const t = vault.currentTotp(userId, r.entry.id, { actor: "vault-agent", onReveal: deps.onReveal });
        return `${r.entry.title} two-factor code: ${t.code}  (valid for ~${t.expiresInSeconds}s)`;
      } catch (err) {
        return friendlyError(err);
      }
    },
    {
      name: "get_totp_code",
      description:
        "Get the CURRENT six-digit two-factor (2FA / authenticator / TOTP) code for one saved account. Pass the entry id or a site/account name. The code changes every 30 seconds.",
      schema: z.object({
        query: z.string().min(1).describe("An entry id, or a site/account name"),
      }),
    }
  );

  return [searchVault, getPassword, getTotpCode];
}
