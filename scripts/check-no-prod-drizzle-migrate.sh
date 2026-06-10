#!/usr/bin/env bash
# Guard: no `drizzle-kit migrate` may target a production/preview D1 binding.
#
# drizzle emits bare `CREATE TABLE` (no IF NOT EXISTS). Production/preview D1 has
# no drizzle journal (__drizzle_migrations), so running `drizzle-kit migrate`
# against it would replay from 0000 and crash on "table already exists".
# Production/preview migrations must go exclusively through
# `wrangler d1 migrations apply` against the binding.
#
# This asserts the only `drizzle-kit migrate` entrypoint stays local-only:
#   1. drizzle.config.ts credentials must resolve to a local SQLite file (DB_FILE
#      / file:), never a D1 / remote / account binding.
#   2. No workflow or shell script may invoke `drizzle-kit migrate` alongside a
#      remote/D1 target (--remote, d1, wrangler binding, etc).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail=0

config="packages/db/drizzle.config.ts"
if [ -f "$config" ]; then
  # Inspect code only — strip // line comments so prose mentioning wrangler/D1
  # in the rationale does not trip the guard.
  config_code="$(sed -E 's@//.*$@@' "$config")"
  # The migrate target must be a local file, not a D1/remote/account binding.
  if printf '%s' "$config_code" | grep -Eiq "d1[-_]?http|accountId|databaseId|driver:[[:space:]]*['\"]d1"; then
    echo "::error::$config appears to point drizzle-kit at D1/remote. Production migrations must use 'wrangler d1 migrations apply'." >&2
    fail=1
  fi
  if ! printf '%s' "$config_code" | grep -Eq "DB_FILE|file:"; then
    echo "::error::$config no longer resolves to a local SQLite file (DB_FILE / file:). Refusing to assume it is local-only." >&2
    fail=1
  fi
fi

# Scan tracked workflows + shell scripts for `drizzle-kit migrate` (or the
# package script alias `db ... migrate` / `--filter ... migrate`) co-located
# with a remote/D1 target on the same line.
scan_paths=$(git ls-files '.github/workflows/*' 'scripts/*' '*.sh' 2>/dev/null || true)
for f in $scan_paths; do
  [ -f "$f" ] || continue
  # Skip this guard script itself.
  [ "$f" = "scripts/check-no-prod-drizzle-migrate.sh" ] && continue
  while IFS= read -r line; do
    # Strip `#` comments (sh/yaml) so prose rationale mentioning
    # `drizzle-kit migrate` / D1 in a comment does not trip the guard — only
    # actual command text is scanned (mirrors the `//` stripping above).
    code_line="${line%%#*}"
    if echo "$code_line" | grep -Eiq 'drizzle-kit[[:space:]]+migrate'; then
      if echo "$code_line" | grep -Eiq -- '--remote|\bd1\b|GOVERNANCE_KV|database_id|env[._]production|env[._]preview'; then
        echo "::error::$f: 'drizzle-kit migrate' co-located with a remote/D1 target: $line" >&2
        fail=1
      fi
    fi
  done < "$f"
done

if [ "$fail" -ne 0 ]; then
  echo "drizzle-migrate guard FAILED." >&2
  exit 1
fi

echo "drizzle-migrate guard OK: no 'drizzle-kit migrate' targets production/preview D1."
