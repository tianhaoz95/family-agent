#!/usr/bin/env bash
# Resets a local family account's password by writing a fresh scrypt hash into
# agent-core's SQLite store. For when the (only) admin is locked out — there is
# no in-app reset flow, because the app is fully local with no email/SMS.
#
#   ./scripts/reset-password.sh <username>              # sets a random password, prints it
#   ./scripts/reset-password.sh <username> <password>   # sets the one you give (>= 6 chars)
#
# The new hash is produced by agent-core/src/auth.ts's own hashPassword(), so
# it always matches what the login route expects. All of that account's other
# sessions are invalidated. Honors FAMILY_AGENT_DATA_DIR; otherwise finds the
# store in the default or legacy location.
#
# Stop the desktop app / `npm run dev` first — this writes to the database.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

USERNAME="${1:-}"
NEWPASS="${2:-}"

if [ -z "$USERNAME" ]; then
  echo "usage: ./scripts/reset-password.sh <username> [new-password]" >&2
  echo "       omit the password to have one generated" >&2
  echo >&2
  "$SCRIPT_DIR/show-accounts.sh" >&2 || true
  exit 1
fi

if [ -n "$NEWPASS" ] && [ "${#NEWPASS}" -lt 6 ]; then
  echo "!! Password must be at least 6 characters (the login route requires it)." >&2
  exit 1
fi

# shellcheck source=scripts/find-db.sh
source "$SCRIPT_DIR/find-db.sh"

# Node >= 22.6 strips TS types natively, so we import agent-core's real
# hashPassword() with no build and no tsx (auth.ts has no third-party imports).
# The password is generated here too when none was given, so there's one source
# of randomness and no bash pipefail/SIGPIPE surprises.
RP_DB="$DB" RP_USER="$USERNAME" RP_PASS="$NEWPASS" RP_AUTH="$ROOT_DIR/agent-core/src/auth.ts" \
  NODE_NO_WARNINGS=1 node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
const { RP_DB, RP_USER, RP_AUTH } = process.env;
const { hashPassword } = await import(RP_AUTH);

let password = process.env.RP_PASS;
const generated = !password;
if (generated) password = randomBytes(18).toString("base64url").slice(0, 16);

const db = new DatabaseSync(RP_DB);
const user = db
  .prepare("SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE")
  .get(RP_USER);
if (!user) {
  console.error(`No account named "${RP_USER}" in ${RP_DB}.`);
  process.exit(2);
}
db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);

console.log(`Reset password for "${user.username}" (${user.role}). Its other sessions were signed out.`);
if (generated) {
  console.log(`\n  new password:  ${password}\n`);
  console.log("Sign in with it, then change it from Settings.");
}
'
