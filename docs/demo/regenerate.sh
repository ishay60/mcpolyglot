#!/usr/bin/env bash
# Regenerate the captured CLI outputs in this directory.
#
# These are real captures of `mcpolyglot <command>` against a local sample SQLite
# database — used by the README and ARCHITECTURE.md as the "screenshot"
# replacement that survives renaming, link-rot, and grayscale terminals.
#
# Run from the repo root:
#   pnpm build && bash docs/demo/regenerate.sh
#
# The bearer token, session UUID, and temp config path are scrubbed at the end.
# Latency numbers still vary per run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/packages/cli/dist/bin.js"
DEMO_DIR="$ROOT/docs/demo"
# mktemp -d, not -t: BSD mktemp appends a suffix after the template, which breaks the .json extension.
TMP="$(mktemp -d)"
DB="$TMP/demo.db"
CFG="$TMP/mcpolyglot.config.json"

trap 'rm -rf "$TMP"' EXIT

if [[ ! -x "$CLI" ]]; then
  echo "build the CLI first: pnpm build" >&2
  exit 1
fi

# Sample data
sqlite3 "$DB" <<'SQL'
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  total_cents INTEGER NOT NULL,
  status TEXT CHECK(status IN ('pending','paid','shipped','cancelled'))
);
INSERT INTO users (email, name, password_hash) VALUES
  ('alice@example.com', 'Alice Anderson', 'argon2id$...'),
  ('bob@example.com',   'Bob Bishop',     'argon2id$...'),
  ('carol@example.com', 'Carol Chen',     'argon2id$...');
INSERT INTO orders (user_id, total_cents, status) VALUES
  (1, 4995, 'paid'),
  (1, 12000, 'shipped'),
  (2, 2500, 'pending');
SQL

# Config (JSON so there's no module-resolution dance for the demo)
cat > "$CFG" <<JSON
{
  "server": { "name": "mcpolyglot", "version": "0.0.1" },
  "transport": { "kind": "stdio" },
  "sources": [
    {
      "id": "sqlite.demo",
      "kind": "sqlite",
      "url": "$DB",
      "scopes": ["schema:read", "tables:read", "query:raw"],
      "perEntityTools": { "enabled": false },
      "limits": { "rowCap": 200, "timeoutMs": 10000, "maxBytes": 262144 },
      "redact": { "columns": ["users.password_hash"], "patterns": [] }
    }
  ],
  "audit": { "path": "~/.mcpolyglot/audit.log" },
  "rateLimit": { "defaultPerMinute": 30, "maxConcurrent": 5 },
  "security": { "wrapMode": "strict" }
}
JSON

run() {
  echo "regenerating $1.txt"
  echo "\$ $2" > "$DEMO_DIR/$1.txt"
  echo "" >> "$DEMO_DIR/$1.txt"
  NO_COLOR=1 eval "$3" >> "$DEMO_DIR/$1.txt" 2>&1 || true
}

run help    "mcpolyglot --help" \
            "node \"$CLI\" --help"
run doctor  "mcpolyglot doctor --config ./mcpolyglot.config.json" \
            "node \"$CLI\" doctor --config \"$CFG\""
run tools   "mcpolyglot tools --config ./mcpolyglot.config.json" \
            "node \"$CLI\" tools --config \"$CFG\""

echo "regenerating agent-call.txt"
{
  echo "# An MCP client calling mcpolyglot over stdio, as an agent would."
  echo "# Note: email redacted, password_hash dropped by the column deny list,"
  echo "# result wrapped as untrusted data, and the UPDATE rejected."
  echo ""
  node "$DEMO_DIR/agent-call.mjs" "$CLI" "$CFG"
} > "$DEMO_DIR/agent-call.txt" 2>&1 || true

echo "regenerating serve-http.txt"
{
  echo "\$ mcpolyglot serve --http --port 7339 --config ./mcpolyglot.config.json"
  echo ""
} > "$DEMO_DIR/serve-http.txt"
NO_COLOR=1 node "$CLI" serve --http --port 7339 --config "$CFG" >> "$DEMO_DIR/serve-http.txt" 2>&1 &
PID=$!
sleep 1
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

# Scrub per-run noise so diffs show only real behavior changes.
perl -pi -e "s#\Q$CFG\E#./mcpolyglot.config.json#g; s#(Token\s+)\S+#\1REDACTED-DEMO-TOKEN#; s#(tokenFingerprint\":\")[^\"]+#\1REDA…OKEN#; s#(sessionId\":\")[^\"]+#\1<session-uuid>#" "$DEMO_DIR"/*.txt

echo ""
echo "Done."
