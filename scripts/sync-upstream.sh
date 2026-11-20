#!/usr/bin/env bash
# Build a verified merge candidate for `main`; never touch live refs or files.
#
# `origin/main` already contains `fork/base`, `fork/defaults` and every topic:
# a normal merge preserves them, so this sync does not rebuild those branches.
# It merges the current upstream main and the newest topic tips onto a detached
# candidate seeded from `origin/main` (or from the local `main` when that only
# adds commits), then verifies the candidate in a scratch worktree outside this
# checkout. Topic histories are merged, never rebased. Fetches land in a private
# ref namespace, so no branch and no remote-tracking ref moves before every
# check passes, and nothing is pushed: the output names the exact tested SHA and
# a fast-forward push for it.
set -euo pipefail
cd "$(dirname "$0")/.."

TOPICS=(
  perf/cache-ttl-and-lean-runtime
)
# Private, unpublished refs: a fetch cache and the last verified candidate.
FETCH_NS=refs/sync-upstream
CANDIDATE_REF=$FETCH_NS/candidate

die() { echo "sync-upstream: $*" >&2; exit 1; }
is_ancestor() { git merge-base --is-ancestor "$1" "$2" 2>/dev/null; }

# Run inside the candidate worktree, as one link of an explicit `&&` chain: a
# build that emitted nothing must not pass for a verified candidate.
require_dist_artifacts() {
  local artifact missing=""
  for artifact in dist/index.js dist/index.d.ts; do
    [ -s "$artifact" ] || missing="$missing $artifact"
  done
  if [ -n "$missing" ]; then
    echo "sync-upstream: the build emitted no usable:$missing; the candidate is unverified" >&2
    return 1
  fi
}

# A dirty checkout usually means work the operator expects this sync to keep.
git diff --quiet && git diff --cached --quiet \
  || die "working tree is not clean; commit or stash first"
for state in MERGE_HEAD rebase-merge rebase-apply; do
  if [ -e "$(git rev-parse --git-path "$state")" ]; then
    die "this checkout is in the middle of $state; finish it first"
  fi
done
# Candidate merges are commits, so a missing identity fails them one at a time.
git var GIT_COMMITTER_IDENT >/dev/null 2>&1 \
  || die "git has no committer identity; set user.name and user.email first"

# `--refmap=` drops the remote's default refspec, so the only refs a fetch
# writes are the private ones below: not `refs/remotes/*`, tags or branches.
git fetch --no-tags --prune --refmap= upstream \
  "+refs/heads/main:$FETCH_NS/upstream/main" \
  || die "fetching upstream/main failed"
git fetch --no-tags --prune --refmap= origin \
  "+refs/heads/*:$FETCH_NS/origin/*" \
  || die "fetching origin failed"
remote_main=$(git rev-parse --verify -q "$FETCH_NS/origin/main") \
  || die "origin has no main branch"
git rev-parse --verify -q "$FETCH_NS/upstream/main" >/dev/null \
  || die "upstream has no main branch"

# Seed from the published main unless local main only adds commits on top of it
# (unpushed fork work). Divergence is the operator's to resolve, not ours.
local_main=$(git rev-parse --verify -q refs/heads/main || true)
if [ -n "$local_main" ] && [ "$local_main" != "$remote_main" ] && ! is_ancestor "$local_main" "$remote_main"; then
  is_ancestor "$remote_main" "$local_main" \
    || die "local main and origin/main have diverged; reconcile main first"
  seed=$local_main
  seed_label="local main"
else
  seed=$remote_main
  seed_label="origin/main"
fi

scratch_root=${TMPDIR:-/tmp}
[ -d "$scratch_root" ] || die "scratch root $scratch_root does not exist"
scratch=$(mktemp -d "$scratch_root/sync-upstream.XXXXXX")
tree=$scratch/tree
cleanup() {
  local failed=0
  if [ -d "$tree" ]; then
    # Only this sync's own scratch worktree is removed, and only by path. A
    # blanket `git worktree prune` would also drop other worktrees' metadata.
    git worktree remove --force "$tree" >/dev/null 2>&1 || failed=1
  fi
  rm -rf "$scratch"
  if [ "$failed" -eq 1 ]; then
    echo "sync-upstream: cleanup failed; the scratch worktree $tree is gone but git may still list it" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
mkdir -p "$scratch/tmp"

# The candidate is a detached HEAD in a scratch worktree, so no branch is
# created and nothing in this checkout is checked out, rebuilt or replaced.
git worktree add --quiet --detach "$tree" "$seed" \
  || die "creating the scratch worktree failed"
echo "sync-upstream: candidate seeded from $seed_label ($seed)"

merge_into_candidate() {
  local ref=$1 message=$2 conflicted
  if git -C "$tree" merge-base --is-ancestor "$ref" HEAD; then return 0; fi
  if git -C "$tree" merge --no-ff -m "$message" "$ref" >"$scratch/merge.log" 2>&1; then
    return 0
  fi
  conflicted=$(git -C "$tree" diff --name-only --diff-filter=U | tr '\n' ' ')
  cat "$scratch/merge.log" >&2
  git -C "$tree" merge --abort >/dev/null 2>&1 || true
  die "$message does not merge cleanly${conflicted:+ (conflicts: $conflicted)}; resolve it by hand, then rerun"
}

merge_into_candidate "$FETCH_NS/upstream/main" "upstream/main"

# Topic refs are published review history. Take the fetched tip when the local
# ref is merely behind it, and refuse to guess when the two histories diverged
# (a rebased published topic). Local-only commits are merged as they are; the
# output only ever names the candidate SHA, never a ref that can move later.
for topic in "${TOPICS[@]}"; do
  local_sha=$(git rev-parse --verify -q "refs/heads/$topic" || true)
  published_sha=$(git rev-parse --verify -q "$FETCH_NS/origin/$topic" || true)
  if [ -z "$local_sha" ] && [ -z "$published_sha" ]; then
    die "topic $topic is missing locally and on origin"
  elif [ -z "$local_sha" ] || [ "$local_sha" = "$published_sha" ]; then
    tip=$published_sha
  elif [ -z "$published_sha" ]; then
    tip=$local_sha
  elif is_ancestor "$local_sha" "$published_sha"; then
    tip=$published_sha
    echo "sync-upstream: local $topic is behind origin/$topic; using the published tip"
  elif is_ancestor "$published_sha" "$local_sha"; then
    tip=$local_sha
  else
    die "topic $topic has diverged from origin/$topic; keep one published history and rerun"
  fi
  merge_into_candidate "$tip" "branch '$topic'"
done

# Fork-only refs are additive too. They are normally ancestors already, so this
# is a no-op on an ordinary sync and only matters for local-only fork work.
for fork_ref in fork/base fork/defaults; do
  fork_sha=$(git rev-parse --verify -q "refs/heads/$fork_ref" || true)
  if [ -n "$fork_sha" ]; then
    merge_into_candidate "$fork_sha" "branch '$fork_ref'"
  fi
done

candidate=$(git -C "$tree" rev-parse HEAD)
is_ancestor "$remote_main" "$candidate" \
  || die "candidate $candidate is not a descendant of origin/main"

# Nothing new to verify or publish: the default already contains every input.
if [ "$candidate" = "$remote_main" ]; then
  echo "sync-upstream: origin/main already contains upstream/main and every topic; nothing to push"
  exit 0
fi

echo "sync-upstream: verifying $candidate in $tree"
# Every step is its own `&&` link. A negated subshell disables `set -e` inside
# it, so relying on that would let a failed typecheck or build be followed by a
# passing `bun test` and report an unverified candidate as verified.
if ! ( cd "$tree" \
  && TMPDIR=$scratch/tmp TMP=$scratch/tmp TEMP=$scratch/tmp NODE_DISABLE_COMPILE_CACHE=1 \
  && export TMPDIR TMP TEMP NODE_DISABLE_COMPILE_CACHE \
  && bun install --frozen-lockfile \
  && bun run typecheck \
  && bun run check:pricing \
  && bun run build \
  && require_dist_artifacts \
  && bun test \
); then
  die "verification failed; main, topics, this checkout and its build are unchanged"
fi
# The checks ran in a worktree that could have moved; only the commit that was
# just verified may be named.
if ! git -C "$tree" diff --quiet || ! git -C "$tree" diff --cached --quiet; then
  die "verification left tracked changes in the candidate; main and topics are unchanged"
fi
[ "$(git -C "$tree" rev-parse HEAD)" = "$candidate" ] \
  || die "the candidate HEAD moved during verification; main and topics are unchanged"
is_ancestor "$remote_main" "$candidate" \
  || die "candidate $candidate is not a descendant of origin/main"

# Only a verified candidate is worth naming. The ref is private and unpublished;
# it keeps the tested commit reachable after the scratch worktree goes away.
git update-ref "$CANDIDATE_REF" "$candidate"

cat <<EOF

sync-upstream: verified $candidate (descendant of origin/main $remote_main)
sync-upstream: no branch moved, no file changed here, nothing pushed
sync-upstream: tested candidate kept at $CANDIDATE_REF
sync-upstream: publish with a fast-forward (no force):
  git push origin $candidate:refs/heads/main
EOF
echo "sync-upstream: fork/base and fork/defaults were merged if needed, never rebuilt"
