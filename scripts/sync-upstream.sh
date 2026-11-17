#!/usr/bin/env bash
# Rebuild this fork's integration branch from upstream plus its topic branches.
#
# Layout:
#   upstream-main   mirror of upstream/main
#   TOPICS          one reviewable change each, rebased onto upstream/main so
#                   they can stay upstream PRs
#   fork/base       merge of upstream/main and every topic; the fork-only base
#   fork/defaults   fork-only commits, strictly linear above fork/base
#   main            fast-forwarded to fork/defaults
#
# Open-PR topics are pinned: their pushed commits are reviewed history, so they
# are merged as-is instead of being rebased here.
set -euo pipefail
cd "$(dirname "$0")/.."

TOPICS=(
  fix/short-variant-aliases
  feat/cache-ttl-env
  perf/cache-ttl-and-lean-runtime
)
# Topics whose commits are already pushed for review. Rebasing them would
# rewrite reviewed history and desync the open PRs.
PINNED_TOPICS=(
  fix/short-variant-aliases
  feat/cache-ttl-env
)
FORK_BASE=fork/base
FORK_DEFAULTS=fork/defaults

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "sync-upstream: working tree is not clean; commit or stash first" >&2
  exit 1
fi

is_pinned() {
  local candidate="$1" topic
  for topic in "${PINNED_TOPICS[@]}"; do
    [ "$topic" = "$candidate" ] && return 0
  done
  return 1
}

old_base=$(git rev-parse "$FORK_BASE" 2>/dev/null || echo "")
if [ -z "$old_base" ]; then
  echo "sync-upstream: $FORK_BASE is missing; create it at the current topic merge first" >&2
  exit 1
fi

git fetch upstream main
git fetch origin
git branch -f upstream-main upstream/main
upstream_head=$(git rev-parse upstream/main)

# Rebase unpinned topics onto upstream/main. Pinned topics keep their pushed
# commits, so a merge brings in their content without a rewrite.
for topic in "${TOPICS[@]}"; do
  if is_pinned "$topic"; then
    if git merge-base --is-ancestor "origin/$topic" "$topic"; then continue; fi
    echo "sync-upstream: $topic is behind origin/$topic; push it first" >&2
    exit 1
  fi
  git checkout "$topic"
  git rebase upstream/main
done

# fork/base is exactly the merge of upstream/main and the topics. Build it on a
# scratch branch first: a conflict must fail the sync without moving fork/base,
# because `rebase --onto` below trusts it as the fork commits' exact parent set.
git checkout -B fork/base-next "$upstream_head"
# `CHANGELOG.md` gets one bullet appended per topic, so merging two topics
# conflicts on the shared `### Added` section every time. Resolve it by keeping
# both sides' bullets, which is what the changelog means.
resolve_changelog() {
  python3 - "$1" <<'PY'
import re, sys
p = sys.argv[1]
text = open(p).read()
pattern = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)
def keep_both(m):
    return m.group(1) + m.group(2)
open(p, "w").write(pattern.sub(keep_both, text))
PY
}
for topic in "${TOPICS[@]}"; do
  if ! git merge --no-ff "$topic" -m "Merge branch '$topic'"; then
    if git diff --name-only --diff-filter=U | grep -qx 'CHANGELOG.md'; then
      # Only the changelog may auto-resolve; any other conflict is a real one.
      if [ "$(git diff --name-only --diff-filter=U | wc -l)" -eq 1 ]; then
        resolve_changelog CHANGELOG.md
        git add CHANGELOG.md
        git commit -q --no-edit
        continue
      fi
    fi
    echo "sync-upstream: merging $topic failed; $FORK_BASE is unchanged" >&2
    git merge --abort 2>/dev/null || true
    exit 1
  fi
done

new_base=$(git rev-parse fork/base-next)
if [ "$old_base" = "$new_base" ]; then
  echo "sync-upstream: $FORK_BASE already matches upstream/main and the topics"
  git branch -f "$FORK_BASE" "$new_base"
  git checkout "$FORK_DEFAULTS"
else
  # Replay fork-only commits onto the rebuilt base. The old base is the exact
  # parent set of those commits, so no topic commit is duplicated.
  git checkout "$FORK_DEFAULTS"
  git rebase --onto "$new_base" "$old_base" "$FORK_DEFAULTS"
  git branch -f "$FORK_BASE" "$new_base"
fi
git branch -D fork/base-next

# `main` may be checked out in another worktree (the primary checkout), where
# switching to it fails. Use a dedicated integration branch there, pointing at
# the same commit `main` would get.
integration_branch=main
if [ -n "$(git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\/heads\/main$/{print w}')" ]; then
  integration_branch=integration-main
fi
git checkout -B "$integration_branch" "$FORK_DEFAULTS"

# The point of the layout: every topic and the fork commits must be reachable
# from the integration branch. This turns a bad rebase into a failed sync
# instead of a silently rewritten history.
for topic in "${TOPICS[@]}"; do
  git merge-base --is-ancestor "$topic" "$integration_branch" \
    || { echo "sync-upstream: $topic is not an ancestor of $integration_branch" >&2; exit 1; }
done
git merge-base --is-ancestor "$FORK_DEFAULTS" "$integration_branch" \
  || { echo "sync-upstream: $FORK_DEFAULTS is not an ancestor of $integration_branch" >&2; exit 1; }

bun install --frozen-lockfile
bun run typecheck
bun run check:pricing
# Build before the suite: `test/architecture.test.ts` fails on a stale `dist/`.
bun run build
bun test

cat <<'EOF'

sync-upstream: rebased, merged, and verified.
Topic branches are fast-forward pushes; the fork branches are rebuilt each sync,
so `main` needs a lease. Push with:
  git push origin upstream-main \
    fix/short-variant-aliases \
    feat/cache-ttl-env \
    perf/cache-ttl-and-lean-runtime
  git push --force-with-lease origin main fork/base fork/defaults
EOF
