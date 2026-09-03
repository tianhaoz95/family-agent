#!/usr/bin/env bash
# Prints the local family accounts (username, display name, role, created date)
# straight out of agent-core's SQLite store — for when someone has forgotten
# which username is the admin.
#
# Passwords are NOT printed and cannot be: they're stored only as scrypt hashes
# (agent-core/src/auth.ts). If the admin password is also lost, reset it by
# writing a new hash into the `users` table with hashPassword() from auth.ts —
# see docs/STATUS.md, "Recovering a locked-out admin".
#
# Honors FAMILY_AGENT_DATA_DIR. Otherwise looks in the current default
# ($XDG_DATA_HOME/family-agent, i.e. ~/.local/share/family-agent) and the
# legacy in-repo location (agent-core/data), and uses whichever has a DB.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/find-db.sh
source "$SCRIPT_DIR/find-db.sh"

echo "==> Accounts in $DB"
echo

# node:sqlite is built into Node >=22.5 (same as agent-core needs), so this
# works without the sqlite3 CLI being installed.
NODE_NO_WARNINGS=1 node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db
  .prepare("SELECT username, display_name, role, created_at FROM users")
  .all()
  .sort((a, b) =>
    (b.role === "admin") - (a.role === "admin") ||
    String(a.created_at).localeCompare(String(b.created_at))
  );
if (rows.length === 0) {
  console.log("(no accounts — the server will show the first-run setup screen)");
  process.exit(0);
}
const w = (s, n) => String(s ?? "").padEnd(n);
console.log(w("USERNAME", 20) + w("DISPLAY NAME", 24) + w("ROLE", 8) + "CREATED");
for (const r of rows) {
  console.log(w(r.username, 20) + w(r.display_name, 24) + w(r.role, 8) + String(r.created_at ?? "").slice(0, 10));
}
const admins = rows.filter((r) => r.role === "admin").map((r) => r.username);
console.log("\nAdmin username" + (admins.length === 1 ? "" : "s") + ": " + (admins.join(", ") || "(none!)"));
' "$DB"

echo
echo "Passwords are not stored in a readable form. If the admin password is also"
echo "lost, reset it — see docs/STATUS.md, \"Recovering a locked-out admin\"."
