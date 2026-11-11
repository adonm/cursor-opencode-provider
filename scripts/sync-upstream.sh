#!/usr/bin/env bash
# Rebase this fork onto upstream/main, rebuild the integration branch, verify.
#
# Topic branches hold one reviewable change each so they can become upstream
# PRs. `main` is integration-only: it merges those branches plus fork/defaults
# (seven-day snapshot retention, progress-only retries off, this script).
set -euo pipefail
cd "$(dirname "$0")/.."

TOPICS=(
  fix/short-variant-aliases
  feat/cache-ttl-env
  perf/cache-ttl-and-lean-runtime
)
FORK_DEFAULTS=fork/defaults

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "sync-upstream: working tree is not clean; commit or stash first" >&2
  exit 1
fi

git fetch upstream main
git branch -f upstream-main upstream/main

for topic in "${TOPICS[@]}"; do
  git checkout "$topic"
  git rebase upstream/main
done

# fork/defaults carries only fork defaults on top of the merged topics, so a
# plain rebase onto upstream/main replays exactly its own commits.
git checkout "$FORK_DEFAULTS"
git rebase upstream/main

# main carries no commits of its own, so it is safe to rebuild from scratch.
git checkout main
git reset --hard upstream/main
for topic in "${TOPICS[@]}" "$FORK_DEFAULTS"; do
  git merge --no-ff "$topic" -m "Merge branch '$topic'"
done

bun install --frozen-lockfile
bun run typecheck
bun test
bun run build

cat <<'EOF'

sync-upstream: rebased, merged, and verified.
Push with:
  git push --force-with-lease origin main upstream-main \
    fix/short-variant-aliases \
    feat/cache-ttl-env \
    perf/cache-ttl-and-lean-runtime \
    fork/defaults
EOF
