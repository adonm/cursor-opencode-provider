import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Every case builds a small git fixture and spawns Bash, Git and Python.
setDefaultTimeout(60_000)

// Fixture roots, removed even when a case fails before its own `finally`.
const bases = new Set<string>()
afterAll(() => {
  for (const dir of bases) fs.rmSync(dir, { recursive: true, force: true })
  bases.clear()
})

const root = path.resolve(import.meta.dir, "..")

// The shipped script lists no topics: every fork change is already on `main`.
// These cases seed a synthetic topic into the copied script so the topic merge
// path stays covered without depending on a branch the fork still publishes.
const TOPIC = "test/topic"
const script = (name: string) => path.join(root, "scripts", name)

type Run = { status: number; stdout: string; stderr: string }

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Run {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...options.env },
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function base(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-build-"))
  bases.add(dir)
  return dir
}

/** A project-shaped directory with a fake compiler, so no real build runs. */
function project(baseDir: string, options: { dist?: string } = {}): string {
  const dir = path.join(baseDir, "project")
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 1\n")
  if (options.dist !== undefined) {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
    fs.writeFileSync(path.join(dir, "dist", "marker"), options.dist)
  }
  fs.copyFileSync(script("build-atomic.sh"), path.join(dir, "scripts", "build-atomic.sh"))
  fs.writeFileSync(path.join(dir, "node_modules", ".bin", "tsc"), FAKE_TSC)
  fs.chmodSync(path.join(dir, "node_modules", ".bin", "tsc"), 0o755)
  return dir
}

/** Writes the two artifacts a real `tsc` would emit, or fails on request. */
const FAKE_TSC = `#!/bin/sh
out=
while [ $# -gt 0 ]; do
  case "$1" in
    --outDir) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || { echo "fake tsc: no --outDir" >&2; exit 2; }
if [ -n "$FAKE_TSC_READY" ]; then : > "$FAKE_TSC_READY"; fi
[ -z "$FAKE_TSC_SLEEP" ] || sleep "$FAKE_TSC_SLEEP"
[ -z "$FAKE_TSC_FAIL" ] || { echo "error TS9999: fake compile error" >&2; exit 1; }
mkdir -p "$out/nested"
printf 'export const value = 1\\n' > "$out/index.js"
printf 'export declare const value: number\\n' > "$out/index.d.ts"
printf 'export {}\\n' > "$out/nested/mod.js"
printf 'export declare const mod: unknown\\n' > "$out/nested/mod.d.ts"
`

function build(dir: string, env: NodeJS.ProcessEnv = {}): Run {
  return run("bash", [path.join(dir, "scripts", "build-atomic.sh")], { cwd: dir, env })
}

function entries(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

function snapshotDist(dir: string): Record<string, string> {
  const dist = path.join(dir, "dist")
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at)) {
      const file = path.join(at, name)
      if (fs.statSync(file).isDirectory()) walk(file)
      else out[path.relative(dist, file)] = fs.readFileSync(file, "utf8")
    }
  }
  if (fs.existsSync(dist)) walk(dist)
  return out
}

/** Whether this host can exchange two directories atomically at all. */
const exchangeSupported = (() => {
  const dir = base()
  try {
    fs.mkdirSync(path.join(dir, "a"))
    fs.mkdirSync(path.join(dir, "b"))
    const probe = run("python3", ["-c", `
import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
name = "renameat2" if sys.platform.startswith("linux") else "renamex_np"
swap = getattr(libc, name, None)
if swap is None: raise SystemExit(1)
if sys.platform.startswith("linux"):
    swap.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    ok = swap(-100, b"a", -100, b"b", 2) == 0
else:
    swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    ok = swap(b"a", b"b", 2) == 0
raise SystemExit(0 if ok else 1)
`], { cwd: dir })
    return probe.status === 0
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()

describe("build-atomic.sh", () => {
  it("leaves the current dist untouched when the compile fails", () => {
    const dir = base()
    try {
      const working = project(dir, { dist: "previous build" })
      const before = snapshotDist(working)
      const result = build(working, { FAKE_TSC_FAIL: "1" })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("TS9999")
      expect(snapshotDist(working)).toEqual(before)
      expect(entries(working).filter(name => name.startsWith(".dist.build."))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!exchangeSupported)("replaces an existing dist in place, without nesting or leftovers", () => {
    const dir = base()
    try {
      const working = project(dir, { dist: "previous build" })
      const result = build(working)
      expect(result.status, result.stderr).toBe(0)
      expect(fs.lstatSync(path.join(working, "dist")).isDirectory()).toBe(true)
      expect(fs.existsSync(path.join(working, "dist", "marker"))).toBe(false)
      expect(snapshotDist(working)).toEqual({
        "index.js": "export const value = 1\n",
        "index.d.ts": "export declare const value: number\n",
        "nested/mod.js": "export {}\n",
        "nested/mod.d.ts": "export declare const mod: unknown\n",
      })
      expect(entries(path.join(working, "dist"))).not.toContain("dist")
      expect(entries(working).filter(name => name.startsWith(".dist.build."))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("installs the first build as a real directory", () => {
    const dir = base()
    try {
      const working = project(dir)
      const result = build(working)
      expect(result.status, result.stderr).toBe(0)
      expect(fs.lstatSync(path.join(working, "dist")).isDirectory()).toBe(true)
      expect(snapshotDist(working)["index.js"]).toBe("export const value = 1\n")
      expect(entries(working).filter(name => name.startsWith(".dist.build."))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a compile that emitted no entry point", () => {
    const dir = base()
    try {
      const working = project(dir, { dist: "previous build" })
      const before = snapshotDist(working)
      // A compiler that produces some nested output but no entry point.
      fs.writeFileSync(path.join(working, "node_modules", ".bin", "tsc"),
        "#!/bin/sh\nwhile [ $# -gt 0 ]; do case \"$1\" in --outDir) out=$2; shift 2;; *) shift;; esac; done\nmkdir -p \"$out/nested\"\nprintf x > \"$out/nested/only.js\"\n")
      fs.chmodSync(path.join(working, "node_modules", ".bin", "tsc"), 0o755)
      const rejected = build(working)
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain("dist/ is unchanged")
      expect(snapshotDist(working)).toEqual(before)
      expect(entries(working).filter(name => name.startsWith(".dist.build."))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails clearly without touching dist when no exchange is possible", () => {
    const dir = base()
    try {
      const working = project(dir, { dist: "previous build" })
      const before = snapshotDist(working)
      // A PATH with the script's own tools but no python3 to promote with.
      const shims = path.join(dir, "shims")
      fs.mkdirSync(shims)
      for (const tool of ["bash", "mktemp", "chmod", "rm", "dirname"]) {
        const found = Bun.which(tool)
        expect(found, `${tool} is required for this case`).toBeString()
        fs.symlinkSync(found!, path.join(shims, tool))
      }
      const result = build(working, { PATH: shims })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("python3 is required")
      expect(result.stderr).toContain("dist/ is unchanged")
      expect(snapshotDist(working)).toEqual(before)
      expect(entries(working).filter(name => name.startsWith(".dist.build."))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!exchangeSupported)("keeps the previous dist when a build is interrupted", async () => {
    const dir = base()
    try {
      const working = project(dir, { dist: "previous build" })
      const before = snapshotDist(working)
      const ready = path.join(dir, "ready")
      // Its own process group, so the interrupt reaches the compiler too, as a
      // terminal's Ctrl-C does. Signalling only the script would wait for tsc.
      const child = spawn("bash", [path.join(working, "scripts", "build-atomic.sh")], {
        cwd: working,
        env: { ...process.env, FAKE_TSC_SLEEP: "5", FAKE_TSC_READY: ready },
        stdio: "ignore",
        detached: true,
      })
      const exited = new Promise<number | null>(resolve => child.on("exit", resolve))
      const deadline = Date.now() + 15_000
      while (!fs.existsSync(ready)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error("the build did not start")
        await Bun.sleep(25)
      }
      process.kill(-child.pid!, "SIGTERM")
      expect(await exited).not.toBe(0)
      expect(snapshotDist(working)).toEqual(before)
      expect(entries(working).filter(name => name.startsWith(".dist.build."))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!exchangeSupported)("keeps dist whole when two builds overlap", async () => {
    const dir = base()
    try {
      const working = project(dir, { dist: "previous build" })
      const spawnBuild = () => spawn("bash", [path.join(working, "scripts", "build-atomic.sh")], {
        cwd: working,
        env: { ...process.env, FAKE_TSC_SLEEP: "0.2" },
        stdio: "ignore",
      })
      const children = [spawnBuild(), spawnBuild(), spawnBuild()]
      const statuses = await Promise.all(children.map(child =>
        new Promise<number | null>(resolve => child.on("exit", resolve))))
      expect(statuses).toEqual([0, 0, 0])
      expect(fs.lstatSync(path.join(working, "dist")).isDirectory()).toBe(true)
      expect(snapshotDist(working)["index.js"]).toBe("export const value = 1\n")
      expect(entries(path.join(working, "dist"))).not.toContain("dist")
      expect(entries(working).filter(name => name.startsWith(".dist.build."))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- sync-upstream.sh: a fake upstream, a fake fork remote, a fake `bun` ---

// The real `bun run build` emits `dist/`; the sync checks those artifacts, so
// this stand-in does too. FAKE_BUN_EMPTY_DIST makes the build emit nothing, and
// FAKE_BUN_FAIL_ON names one step that fails.
const FAKE_BUN = `#!/bin/sh
printf '%s\\t%s\\t%s\\n' "$(pwd)" "$(git rev-parse HEAD)" "$*" >> "$FAKE_BUN_LOG"
if [ -n "$FAKE_BUN_FAIL_ON" ]; then
  for arg in "$@"; do
    [ "$arg" != "$FAKE_BUN_FAIL_ON" ] || exit 1
  done
fi
if [ "$*" = "run build" ] && [ -z "$FAKE_BUN_EMPTY_DIST" ]; then
  mkdir -p dist
  printf 'export const value = 1\\n' > dist/index.js
  printf 'export declare const value: number\\n' > dist/index.d.ts
fi
if [ -n "$FAKE_BUN_DIRTIES_TREE" ]; then
  echo "modified during verification" >> src/index.ts
fi
exit 0
`

type Fixture = {
  base: string
  work: string
  origin: string
  upstream: string
  bin: string
  log: string
  tmp: string
  env: NodeJS.ProcessEnv
  git: (cwd: string, args: string[]) => Run
}

function fixture(): Fixture {
  const baseDir = base()
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(baseDir, "gitconfig"),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  }
  fs.writeFileSync(path.join(baseDir, "gitconfig"),
    "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n")
  const git = (cwd: string, args: string[]) => {
    const result = run("git", args, { cwd, env: gitEnv })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
    return result
  }

  const origin = path.join(baseDir, "origin.git")
  const upstream = path.join(baseDir, "upstream.git")
  git(baseDir, ["init", "--quiet", "--bare", "--initial-branch=main", origin])
  git(baseDir, ["init", "--quiet", "--bare", "--initial-branch=main", upstream])

  const seed = path.join(baseDir, "seed")
  git(baseDir, ["init", "--quiet", seed])
  const write = (name: string, text: string) => {
    const file = path.join(seed, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  write("src/index.ts", "export const value = 1\n")
  write("package.json", '{"name":"fixture","private":true}\n')
  write("docs/perf.md", "perf\n")
  git(seed, ["add", "-A"])
  git(seed, ["commit", "--quiet", "-m", "base"])

  const commit = (branch: string, name: string, text: string, message: string) => {
    git(seed, ["checkout", "--quiet", "-B", branch])
    write(name, text)
    git(seed, ["add", "-A"])
    git(seed, ["commit", "--quiet", "-m", message])
    return git(seed, ["rev-parse", "HEAD"]).stdout.trim()
  }

  const topic = TOPIC
  const perfMerged = commit(topic, "docs/perf.md", "perf\nlean\n", "topic: perf")
  const forkBase = commit("fork/base", "docs/fork-base.md", "base\n", "fork: base")
  const forkDefaults = commit("fork/defaults", "docs/fork-defaults.md", "defaults\n", "fork: defaults")

  // Published default: everything above is already merged, as in the real fork.
  git(seed, ["checkout", "--quiet", "-B", "main"])
  git(seed, ["merge", "--quiet", "--no-ff", "-m", "Merge fork work", forkBase])
  git(seed, ["merge", "--quiet", "--no-ff", "-m", "Merge fork defaults", forkDefaults])
  git(seed, ["merge", "--quiet", "--no-ff", "-m", "Merge perf", topic])
  git(seed, ["remote", "add", "upstream", upstream])
  git(seed, ["remote", "add", "origin", origin])
  git(seed, ["push", "--quiet", "upstream", "main:refs/heads/main"])
  git(seed, ["push", "--quiet", "origin", "main:refs/heads/main"])
  git(seed, ["checkout", "--quiet", topic])
  commit(topic, "docs/perf-topic.md", "published\n", "topic: perf published")
  git(seed, ["push", "--quiet", "origin", `${topic}:refs/heads/${topic}`])
  git(seed, ["push", "--quiet", "origin", "fork/base:refs/heads/fork/base"])
  git(seed, ["push", "--quiet", "origin", "fork/defaults:refs/heads/fork/defaults"])

  const work = path.join(baseDir, "work")
  git(baseDir, ["clone", "--quiet", origin, work])
  git(work, ["remote", "add", "upstream", upstream])
  fs.mkdirSync(path.join(work, "scripts"), { recursive: true })
  const syncSource = fs.readFileSync(script("sync-upstream.sh"), "utf8")
  const withTopic = syncSource.replace(/^TOPICS=\(\)$/m, `TOPICS=(\n  ${TOPIC}\n)`)
  if (withTopic === syncSource) throw new Error("sync-upstream.sh no longer has an empty TOPICS array to seed")
  fs.writeFileSync(path.join(work, "scripts", "sync-upstream.sh"), withTopic)
  fs.mkdirSync(path.join(work, "dist"), { recursive: true })
  fs.writeFileSync(path.join(work, "dist", "marker"), "extant build\n")
  for (const branch of ["fork/base", "fork/defaults"]) {
    git(work, ["branch", "--quiet", branch, `origin/${branch}`])
  }
  // The local perf topic is behind its published tip, which the sync must notice.
  git(work, ["branch", "--quiet", topic, perfMerged])

  const bin = path.join(baseDir, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "bun"), FAKE_BUN)
  fs.chmodSync(path.join(bin, "bun"), 0o755)
  const log = path.join(baseDir, "bun.log")
  const tmp = path.join(baseDir, "tmp")
  fs.mkdirSync(tmp)

  return {
    base: baseDir, work, origin, upstream, bin, log, tmp,
    env: {
      ...gitEnv,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_BUN_LOG: log,
      TMPDIR: tmp,
    },
    git,
  }
}

/** Advance upstream/main, as a real upstream release would. */
function advanceUpstream(fx: Fixture, name: string, text: string, message = "upstream change"): string {
  const clone = path.join(fx.base, `upstream-${Math.random().toString(36).slice(2)}`)
  fx.git(fx.base, ["clone", "--quiet", fx.upstream, clone])
  const file = path.join(clone, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  fx.git(clone, ["add", "-A"])
  fx.git(clone, ["commit", "--quiet", "-m", message])
  fx.git(clone, ["push", "--quiet", "origin", "main:refs/heads/main"])
  return fx.git(clone, ["rev-parse", "HEAD"]).stdout.trim()
}

function refs(fx: Fixture, ...patterns: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pattern of patterns) {
    const result = fx.git(fx.work, ["for-each-ref", "--format=%(refname) %(objectname)", pattern])
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const [name, sha] = line.split(" ")
      out[name] = sha
    }
  }
  return out
}

function sync(fx: Fixture, env: NodeJS.ProcessEnv = {}): Run {
  return run("bash", [path.join(fx.work, "scripts", "sync-upstream.sh")], {
    cwd: fx.work,
    env: { ...fx.env, ...env },
  })
}

const CANDIDATE_REF = "refs/sync-upstream/candidate"
// Every ref this checkout publishes from, plus the fetch cache: a fetch writes
// its own private namespace and nothing else.
const PUBLISH_REFS = ["refs/heads/*", "refs/remotes/*", "refs/tags/*"]

function remoteRefs(fx: Fixture): Record<string, string> {
  const out: Record<string, string> = {}
  for (const remote of [fx.origin, fx.upstream]) {
    const result = fx.git(remote, ["for-each-ref", "--format=%(refname) %(objectname)"])
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const [name, sha] = line.split(" ")
      out[`${path.basename(remote)}:${name}`] = sha
    }
  }
  return out
}

describe("sync-upstream.sh", () => {
  it("verifies a detached candidate and prints a fast-forward push for the tested SHA", () => {
    const fx = fixture()
    try {
      const upstreamTip = advanceUpstream(fx, "src/upstream.ts", "export const upstream = true\n")
      const publishedTopic = fx.git(fx.work, ["rev-parse", `origin/${TOPIC}`]).stdout.trim()
      const before = refs(fx, ...PUBLISH_REFS)
      const remotesBefore = remoteRefs(fx)
      const distBefore = fs.readFileSync(path.join(fx.work, "dist", "marker"), "utf8")

      const result = sync(fx)
      expect(result.status, result.stderr).toBe(0)

      const tested = /verified ([0-9a-f]{40})/.exec(result.stdout)?.[1]
      expect(tested).toBeString()
      expect(refs(fx, CANDIDATE_REF)).toEqual({ [CANDIDATE_REF]: tested! })

      // The exact tested candidate contains both new inputs and descends from
      // the published default; a plain fast-forward is therefore correct.
      const parents = fx.git(fx.work, ["rev-list", "--parents", "-n", "1", tested!]).stdout.trim().split(" ")
      const fetchedMain = refs(fx, "refs/sync-upstream/origin/main")["refs/sync-upstream/origin/main"]
      expect(fetchedMain).toBe(fx.git(fx.origin, ["rev-parse", "refs/heads/main"]).stdout.trim())
      expect(fx.git(fx.work, ["merge-base", "--is-ancestor", fetchedMain, tested!]).status).toBe(0)
      expect(fx.git(fx.work, ["merge-base", "--is-ancestor", upstreamTip, tested!]).status).toBe(0)
      expect(fx.git(fx.work, ["merge-base", "--is-ancestor", publishedTopic, tested!]).status).toBe(0)
      expect(parents.length).toBeGreaterThanOrEqual(3)

      // No local publish ref, fetch cache, remote ref, file or build moved.
      expect(refs(fx, ...PUBLISH_REFS)).toEqual(before)
      expect(remoteRefs(fx)).toEqual(remotesBefore)
      expect(fs.readFileSync(path.join(fx.work, "dist", "marker"), "utf8")).toBe(distBefore)
      expect(fx.git(fx.work, ["branch", "--list", "integration-main"]).stdout.trim()).toBe("")
      // The scratch worktree is gone, not left registered in this checkout.
      const worktrees = fx.git(fx.work, ["worktree", "list", "--porcelain"]).stdout
      expect(worktrees.trim().split("\n\n")).toHaveLength(1)

      expect(result.stdout).toContain(`git push origin ${tested}:refs/heads/main`)
      expect(result.stdout).not.toContain("--force")
      expect(result.stdout).not.toContain("push --force")
      // Only the tested main SHA is named; topic refs could move after the run.
      expect(result.stdout.match(/git push/g)).toHaveLength(1)
      expect(result.stdout).not.toContain("refs/heads/fix/")
      expect(result.stdout).not.toContain("refs/heads/feat/")
      expect(result.stdout).not.toContain(`refs/heads/${TOPIC}`)

      // Every check ran in the scratch worktree, outside this checkout, and
      // every one of them ran against the exact candidate that was printed.
      const runs = fs.readFileSync(fx.log, "utf8").split("\n").filter(Boolean)
        .map(line => line.split("\t"))
      expect(runs.map(([, , args]) => args)).toEqual([
        "install --frozen-lockfile",
        "run typecheck",
        "run check:pricing",
        "run build",
        "test",
      ])
      expect(runs.every(([cwd]) => cwd.startsWith(`${fx.tmp}${path.sep}`))).toBe(true)
      expect(runs.every(([, sha]) => sha === tested)).toBe(true)
      expect(fs.existsSync(path.join(fx.work, ".fake-bun-ran"))).toBe(false)
      expect(entries(fx.tmp)).toEqual([])
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true })
    }
  })

  // Every step must be its own `&&` link: inside a negated subshell `set -e` is
  // disabled, so a failed step followed by a passing `bun test` used to be
  // reported as a verified candidate.
  for (const [label, failure, expectedOutput] of [
    ["typecheck", { FAKE_BUN_FAIL_ON: "typecheck" }, "verification failed"],
    ["pricing coverage", { FAKE_BUN_FAIL_ON: "check:pricing" }, "verification failed"],
    ["build", { FAKE_BUN_FAIL_ON: "build" }, "verification failed"],
    ["full suite", { FAKE_BUN_FAIL_ON: "test" }, "verification failed"],
    ["emitted dist", { FAKE_BUN_EMPTY_DIST: "1" }, "the build emitted no usable"],
  ] as const) {
    it(`stops at a failed ${label} and never names a candidate`, () => {
      const fx = fixture()
      try {
        advanceUpstream(fx, "src/upstream.ts", "export const upstream = true\n")
        const before = refs(fx, ...PUBLISH_REFS)
        const remotesBefore = remoteRefs(fx)
        const result = sync(fx, failure)
        expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0)
        expect(result.stderr).toContain(expectedOutput)
        expect(result.stdout).not.toContain("verified ")
        expect(result.stdout).not.toContain("git push")
        // Nothing was recorded, so nothing may be pushed as this candidate.
        expect(refs(fx, CANDIDATE_REF)).toEqual({})
        expect(refs(fx, ...PUBLISH_REFS)).toEqual(before)
        expect(remoteRefs(fx)).toEqual(remotesBefore)
        expect(fs.readFileSync(path.join(fx.work, "dist", "marker"), "utf8")).toBe("extant build\n")
        expect(entries(fx.tmp)).toEqual([])

        // Later checks were not reached: the failing step is the last one run.
        const ran = fs.readFileSync(fx.log, "utf8").split("\n").filter(Boolean)
          .map(line => line.split("\t")[2])
        const failingStep = label === "emitted dist" ? "run build"
          : failure.FAKE_BUN_FAIL_ON === "test" ? "test" : `run ${failure.FAKE_BUN_FAIL_ON}`
        expect(ran.at(-1)).toBe(failingStep)
        // Only a failure before the suite shows that a later step was skipped.
        if (failingStep !== "test") expect(ran).not.toContain("test")
      } finally {
        fs.rmSync(fx.base, { recursive: true, force: true })
      }
    })
  }

  it("refuses to name a candidate that verification left dirty", () => {
    const fx = fixture()
    try {
      advanceUpstream(fx, "src/upstream.ts", "export const upstream = true\n")
      const before = refs(fx, ...PUBLISH_REFS)
      const result = sync(fx, { FAKE_BUN_DIRTIES_TREE: "1" })
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0)
      expect(result.stderr).toContain("tracked changes")
      expect(result.stdout).not.toContain("git push")
      expect(refs(fx, CANDIDATE_REF)).toEqual({})
      expect(refs(fx, ...PUBLISH_REFS)).toEqual(before)
      expect(entries(fx.tmp)).toEqual([])
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true })
    }
  })

  it("fails clearly on an upstream conflict without touching anything", () => {
    const fx = fixture()
    try {
      // The fork and upstream must both change the same file differently.
      const fork = path.join(fx.base, "fork-edit")
      fx.git(fx.base, ["clone", "--quiet", fx.origin, fork])
      fs.writeFileSync(path.join(fork, "docs", "perf.md"), "perf\nfork rewrite\n")
      fx.git(fork, ["add", "-A"])
      fx.git(fork, ["commit", "--quiet", "-m", "fork: perf rewrite"])
      fx.git(fork, ["push", "--quiet", "origin", "main:refs/heads/main"])
      advanceUpstream(fx, "docs/perf.md", "perf\nupstream rewrite\n")
      const before = refs(fx, ...PUBLISH_REFS)
      const result = sync(fx)
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0)
      expect(result.stderr).toContain("conflicts")
      expect(result.stderr).toContain("docs/perf.md")
      expect(refs(fx, ...PUBLISH_REFS)).toEqual(before)
      expect(refs(fx, CANDIDATE_REF)).toEqual({})
      expect(fs.readFileSync(path.join(fx.work, "dist", "marker"), "utf8")).toBe("extant build\n")
      expect(entries(fx.tmp)).toEqual([])
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true })
    }
  })

  it("refuses a topic whose local history diverged from its published tip", () => {
    const fx = fixture()
    try {
      const topic = TOPIC
      const published = fx.git(fx.work, ["rev-parse", `origin/${topic}`]).stdout.trim()
      fx.git(fx.work, ["checkout", "--quiet", topic])
      fs.writeFileSync(path.join(fx.work, "docs", "perf.md"), "rewritten\n")
      fx.git(fx.work, ["add", "docs/perf.md"])
      fx.git(fx.work, ["commit", "--quiet", "--amend", "-m", "topic: perf rewritten"])
      fx.git(fx.work, ["checkout", "--quiet", "main"])
      const before = refs(fx, ...PUBLISH_REFS)
      const result = sync(fx)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("diverged")
      expect(refs(fx, ...PUBLISH_REFS)).toEqual(before)
      expect(fx.git(fx.work, ["rev-parse", `origin/${topic}`]).stdout.trim()).toBe(published)
      expect(entries(fx.tmp)).toEqual([])
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true })
    }
  })

  it("seeds from local main when it only adds unpublished commits", () => {
    const fx = fixture()
    try {
      fs.writeFileSync(path.join(fx.work, "docs", "local.md"), "local\n")
      fx.git(fx.work, ["add", "-A"])
      fx.git(fx.work, ["commit", "--quiet", "-m", "local work"])
      const localMain = fx.git(fx.work, ["rev-parse", "main"]).stdout.trim()
      const before = refs(fx, ...PUBLISH_REFS)
      const result = sync(fx)
      expect(result.status, result.stderr).toBe(0)
      const tested = /verified ([0-9a-f]{40})/.exec(result.stdout)?.[1]
      expect(tested).toBeString()
      const localMainSha = fx.git(fx.work, ["rev-parse", "main"]).stdout.trim()
      expect(localMainSha).toBe(localMain)
      expect(fx.git(fx.work, ["merge-base", "--is-ancestor", localMain, tested!]).status).toBe(0)
      expect(fx.git(fx.work, ["merge-base", "--is-ancestor",
        fx.git(fx.work, ["rev-parse", "refs/sync-upstream/origin/main"]).stdout.trim(), tested!]).status).toBe(0)
      expect(refs(fx, ...PUBLISH_REFS)).toEqual(before)
      expect(entries(fx.tmp)).toEqual([])
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true })
    }
  })

  it("reports nothing to push when main already contains every input", () => {
    const fx = fixture()
    try {
      // Publish the topic tip into the default, as the real fork does.
      const fork = path.join(fx.base, "publish-topics")
      fx.git(fx.base, ["clone", "--quiet", fx.origin, fork])
      fx.git(fork, ["merge", "--quiet", "--no-ff", "-m", "Merge topic", `origin/${TOPIC}`])
      fx.git(fork, ["push", "--quiet", "origin", "HEAD:refs/heads/main"])
      const before = refs(fx, ...PUBLISH_REFS)
      const result = sync(fx)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain("nothing to push")
      expect(result.stdout).not.toContain("git push")
      // No work was needed, so nothing was verified or recorded either.
      expect(refs(fx, CANDIDATE_REF)).toEqual({})
      expect(refs(fx, ...PUBLISH_REFS)).toEqual(before)
      expect(entries(fx.tmp)).toEqual([])
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true })
    }
  })

  it("refuses a dirty checkout and diverged local main before fetching", () => {
    const fx = fixture()
    try {
      fs.appendFileSync(path.join(fx.work, "docs", "perf.md"), "uncommitted\n")
      const dirty = sync(fx)
      expect(dirty.status, `${dirty.stdout}\n${dirty.stderr}`).not.toBe(0)
      expect(dirty.stderr).toContain("not clean")
      expect(entries(fx.tmp)).toEqual([])
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true })
    }

    const diverged = fixture()
    try {
      // Local main rewrites published history instead of stacking on it.
      diverged.git(diverged.work, ["reset", "--quiet", "--hard", "HEAD~1"])
      fs.writeFileSync(path.join(diverged.work, "docs", "local.md"), "local\n")
      diverged.git(diverged.work, ["add", "-A"])
      diverged.git(diverged.work, ["commit", "--quiet", "-m", "divergent local work"])
      const before = refs(diverged, ...PUBLISH_REFS)
      const result = sync(diverged)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("diverged")
      expect(refs(diverged, ...PUBLISH_REFS)).toEqual(before)
      expect(entries(diverged.tmp)).toEqual([])
    } finally {
      fs.rmSync(diverged.base, { recursive: true, force: true })
    }
  })
})
