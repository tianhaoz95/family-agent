# Sourced by the account-recovery scripts. Sets $DB to agent-core's SQLite
# store, or exits 1 with a helpful message. The caller must have set $ROOT_DIR.
#
# An explicit FAMILY_AGENT_DATA_DIR is authoritative (no silent fallback to a
# stale DB); otherwise try the current default then the legacy in-repo path.

if [ -n "${FAMILY_AGENT_DATA_DIR:-}" ]; then
  _db_candidates=("$FAMILY_AGENT_DATA_DIR/family-agent.db")
else
  _db_candidates=(
    "${XDG_DATA_HOME:-$HOME/.local/share}/family-agent/family-agent.db"
    "$ROOT_DIR/agent-core/data/family-agent.db"
  )
fi

DB=""
for _c in "${_db_candidates[@]}"; do
  if [ -f "$_c" ]; then DB="$_c"; break; fi
done

if [ -z "$DB" ]; then
  echo "!! No agent-core database found. Looked in:" >&2
  for _c in "${_db_candidates[@]}"; do echo "     $_c" >&2; done
  echo "   Set FAMILY_AGENT_DATA_DIR if the store lives somewhere else." >&2
  exit 1
fi
