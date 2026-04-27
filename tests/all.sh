#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "state-commit help"
"$ROOT/scripts/state-commit" --help >/dev/null

echo "schema parses"
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$ROOT/schema/vrm-evidence-input.schema.json"

echo "asset mirror present"
test -x "$ROOT/scripts/state-commit"
test -x "$ROOT/scripts/build-vrm-prompt"
test -f "$ROOT/prompts/orchestrator.md"
test -f "$ROOT/agents/builder-plan.md"

echo "state-commit mutation flow"
cd "$TMP"
git init >/dev/null
NOW="2026-04-27T00:00:00Z"
cat >tx.json <<JSON
{
  "message": "test init",
  "writes": [
    {
      "path": ".agent-atelier/work-items.json",
      "expected_revision": null,
      "content": {
        "revision": 1,
        "updated_at": "$NOW",
        "items": []
      }
    }
  ],
  "deletes": []
}
JSON
"$ROOT/scripts/state-commit" --root "$TMP" <tx.json >/dev/null
node -e "const s=require('./.agent-atelier/work-items.json'); if (s.revision !== 1 || s.items.length !== 0) process.exit(1)"

if [ -d "$ROOT/node_modules" ]; then
  echo "typecheck"
  cd "$ROOT"
  npm run typecheck

  echo "pi command flow"
  CMD_TMP="$(mktemp -d)"
  (
    cd "$CMD_TMP"
    git init >/dev/null
    git config user.email test@example.com
    git config user.name Test
    touch README.md
    git add README.md
    git commit -m init >/dev/null
    cat >wi.json <<'JSON'
{"id":"WI-001","title":"Smoke","status":"ready","complexity":"simple","owned_paths":["README.md"],"verify":["true"],"behaviors":["smoke"]}
JSON
    run_pi() {
      npx --prefix "$ROOT" pi -e "$ROOT/src/index.ts" --mode json -p --no-session "$1" >/dev/null
    }
    run_pi "/aa-init"
    run_pi "/aa-status"
    run_pi "/aa-run --no-monitors"
    run_pi "/aa-wi upsert --request-id T1 --input wi.json"
    run_pi "/aa-execute claim WI-001 --owner-session-id test --request-id T2"
    run_pi "/aa-execute heartbeat WI-001 --request-id T3"
    node -e 'const s=require("./.agent-atelier/work-items.json"); if (s.items[0].status !== "implementing") process.exit(1)'
    run_pi "/aa-execute requeue WI-001 --request-id T4 --reason smoke"
    node -e 'const s=require("./.agent-atelier/work-items.json"); if (s.items[0].status !== "ready") process.exit(1)'
    run_pi "/aa-monitors spawn event-tail --request-id M1 --interval-ms 1000"
    node -e 'const s=require("./.agent-atelier/watchdog-jobs.json"); if (!s.monitors || !s.monitors["event-tail"]) process.exit(1)'
    run_pi "/aa-monitors stop all --request-id M2"
  )
  rm -rf "$CMD_TMP"
else
  echo "typecheck skipped (node_modules missing)"
fi

echo "ok"
