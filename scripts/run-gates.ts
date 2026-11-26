import { lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";

/**
 * Repository gates. `check` runs every gate concurrently and skips a gate whose inputs match a run
 * that already passed. `ci` never reuses results; `--group` and `--shard` split it across CI jobs.
 */

export type GateGroup = "static" | "core" | "tests";

export type Gate = {
  readonly id: string;
  readonly group: GateGroup;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Workspace directories whose files, with their dependencies and root files, are the inputs. */
  readonly workspaces?: readonly string[];
  /** Relative cost, used to start slow gates first before durations are recorded. */
  readonly weight: number;
};

type Workspace = {
  readonly dir: string;
  readonly name: string;
  readonly dependencies: readonly string[];
};

type Options = {
  readonly mode: "check" | "ci";
  readonly group?: GateGroup;
  readonly shard?: string;
  readonly reuse: boolean;
};

type Outcome = {
  readonly gate: Gate;
  readonly status: "passed" | "failed" | "reused";
  readonly ms: number;
  readonly output: string;
};

const ROOT = path.resolve(import.meta.dir, "..");
const CACHE_DIR = path.join(ROOT, "node_modules/.cache/lilac-gates");
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const WORKSPACE_ROOTS = ["apps", "packages"] as const;
// Inputs that change a test's behavior without changing a file.
const SHARED_EXCLUDE = /(?:^\.github\/|\.md$)/u;
const KEY_ENV = /^(REDIS_URL|LILAC_[A-Z0-9_]+)$/u;

const CPUS = availableParallelism();
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Math.floor(value)));

export function gateSettings(mode: Options["mode"], cpus = CPUS) {
  return {
    // Six concurrent gates saturated a 32-core machine; more ran slower.
    pool: clamp(cpus / 5, 2, 6),
    coreTestWorkers: mode === "ci" ? clamp(cpus, 2, 16) : clamp(cpus / 2, 2, 16),
    architectureWorkers: clamp(cpus / 8, 1, 4),
  };
}

export async function discoverWorkspaces(root = ROOT): Promise<Workspace[]> {
  const found: { dir: string; manifest: Record<string, unknown> }[] = [];
  for (const parent of WORKSPACE_ROOTS) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${parent}/${entry.name}`;
      const manifest = await Bun.file(path.join(root, dir, "package.json"))
        .json()
        .catch(() => undefined);
      if (manifest) found.push({ dir, manifest });
    }
  }
  const dirByName = new Map(found.map(({ dir, manifest }) => [String(manifest.name), dir]));
  return found
    .map(({ dir, manifest }) => {
      const declared = ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) =>
        Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
      );
      const dependencies = declared.flatMap((name) => {
        const target = dirByName.get(name);
        return target ? [target] : [];
      });
      return { dir, name: String(manifest.name), dependencies };
    })
    .toSorted((left, right) => left.dir.localeCompare(right.dir));
}

export function buildGates(
  workspaces: readonly Workspace[],
  options: Pick<Options, "mode" | "shard">,
  cpus = CPUS,
): Gate[] {
  const settings = gateSettings(options.mode, cpus);
  const script = (id: string, group: GateGroup, name: string, weight: number): Gate => ({
    id,
    group,
    command: ["bun", "run", name],
    weight,
  });
  const gates: Gate[] = [
    script("codegen client-protocol-compat", "static", "codegen:client-protocol-compat:check", 9),
    script("codegen config-schemas", "static", "codegen:config-schemas:check", 2),
    script("codegen model-options", "static", "codegen:model-options:check", 2),
    script("codegen design-tool-activities", "static", "codegen:design-tool-activities:check", 1),
    script("lint oxlint", "static", "lint:oxlint", 30),
    {
      id: "lint architecture",
      group: "static",
      command: [
        "bun",
        "scripts/architecture/runner.ts",
        "check",
        `--workers=${settings.architectureWorkers}`,
      ],
      weight: 40,
    },
    script("lint architecture syntax", "static", "lint:architecture:syntax", 8),
    script("typecheck root", "static", "typecheck:root", 2),
    script("typecheck codegen", "static", "typecheck:codegen", 1),
    script("typecheck lint-plugins", "static", "typecheck:lint-plugins", 1),
    script("typecheck architecture", "static", "typecheck:architecture", 10),
    script("format", "static", "fmt:check", 2),
    {
      id: "test root",
      group: "static",
      command: ["bun", "run", "test:root", "--", "--only-failures"],
      weight: 1,
    },
    {
      id: "test lint-rules",
      group: "static",
      command: [
        "bun",
        "test",
        "--only-failures",
        ...[...new Bun.Glob("scripts/oxlint-plugins/*.test.mts").scanSync(ROOT)]
          .toSorted()
          .map((file) => `./${file}`),
      ],
      weight: 1,
    },
    {
      id: "test lint-rule waits",
      group: "static",
      command: [
        "node",
        "--experimental-strip-types",
        "scripts/oxlint-plugins/test-waits.rule-test.mts",
      ],
      weight: 1,
    },
    {
      id: "test architecture",
      group: "static",
      command: ["bun", "run", "test:architecture", "--", "--only-failures"],
      weight: 35,
    },
  ];
  for (const workspace of workspaces) {
    gates.push({
      id: `typecheck ${workspace.dir}`,
      group: "static",
      command: ["bunx", "tsc", "-p", `${workspace.dir}/tsconfig.json`, "--noEmit"],
      workspaces: [workspace.dir],
      weight: workspace.dir === "apps/core" ? 25 : 4,
    });
    const core = workspace.dir === "apps/core";
    const shard = core && options.shard ? [`--shard=${options.shard}`] : [];
    gates.push({
      id: `test ${workspace.dir}`,
      group: core ? "core" : "tests",
      command: ["bun", `--cwd=${workspace.dir}`, "run", "test", "--", "--only-failures", ...shard],
      env: core ? { CORE_TEST_PARALLEL: String(settings.coreTestWorkers) } : undefined,
      workspaces: [workspace.dir],
      weight: core ? 100 : workspace.dir === "packages/event-bus" ? 30 : 5,
    });
  }
  return gates;
}

export async function runCommands(commands: readonly string[][], workers: number): Promise<number> {
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(workers, commands.length) }, async () => {
      while (next < commands.length) {
        const command = commands[next++];
        if (!command) return;
        const child = Bun.spawn(command, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        if ((await child.exited) !== 0) failed = true;
      }
    }),
  );
  return Number(failed);
}

/** Files a gate can read: tracked and untracked, minus ignored files and the `ref/` checkouts. */
async function inputFiles(): Promise<string[]> {
  const child = Bun.spawn(["git", "ls-files", "-z", "-co", "--exclude-standard"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [listed, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("git ls-files failed");
  return [...new Set(listed.split("\0"))]
    .filter((file) => file && !file.startsWith("ref/"))
    .toSorted();
}

async function fileDigest(file: string): Promise<string | undefined> {
  const absolute = path.join(ROOT, file);
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) return undefined;
  if (info.isSymbolicLink()) return `link:${await readlink(absolute)}`;
  // Submodule checkouts appear as directories.
  if (!info.isFile()) return undefined;
  return Bun.hash(await readFile(absolute)).toString(16);
}

async function digestFiles(files: readonly string[]): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  const batch = 256;
  for (let start = 0; start < files.length; start += batch) {
    const slice = files.slice(start, start + batch);
    const values = await Promise.all(slice.map(fileDigest));
    slice.forEach((file, index) => {
      const value = values[index];
      if (value !== undefined) digests.set(file, value);
    });
  }
  return digests;
}

function workspaceOf(file: string): string | undefined {
  const [parent, name] = file.split("/");
  if (!name || !WORKSPACE_ROOTS.includes(parent as (typeof WORKSPACE_ROOTS)[number]))
    return undefined;
  return `${parent}/${name}`;
}

/**
 * Workspaces a gate depends on: declared workspace dependencies plus workspaces its files import
 * or read by a quoted path, followed transitively.
 */
function workspaceClosure(
  start: readonly string[],
  byDir: ReadonlyMap<string, Workspace>,
  references: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length) {
    const dir = queue.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    queue.push(...(byDir.get(dir)?.dependencies ?? []), ...(references.get(dir) ?? []));
  }
  return seen;
}

// A whole quoted string that is a relative path or a root-relative workspace path, such as an
// import specifier or a fixture.
const QUOTED_PATH = /["'`]((?:\.\.?\/)[\w./@-]+|(?:apps|packages)\/[\w./-]+)["'`]/gu;
const PACKAGE_SPECIFIER = /["'](@stanley2058\/lilac-[\w-]+)/gu;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.tsx"];

/**
 * Workspaces a workspace's own source and tests reach outside its declared dependencies. Comments,
 * test strings, `scripts/` output paths and ignored build output do not count; a path must name
 * an input file or a directory holding one.
 */
async function referencedWorkspaces(
  dir: string,
  byWorkspace: ReadonlyMap<string, readonly string[]>,
  byDir: ReadonlyMap<string, Workspace>,
  dirByPackage: ReadonlyMap<string, string>,
): Promise<string[]> {
  const files = byWorkspace.get(dir) ?? [];
  const found = new Set<string>();
  for (const file of files) {
    if (file.startsWith(`${dir}/scripts/`) || !/\.(?:[cm]?[jt]sx?)$/u.test(file)) continue;
    const text = await Bun.file(path.join(ROOT, file))
      .text()
      .catch(() => "");
    for (const [, name] of text.matchAll(PACKAGE_SPECIFIER)) {
      const target = dirByPackage.get(name!);
      if (target) found.add(target);
    }
    for (const [, literal] of text.matchAll(QUOTED_PATH)) {
      const target = resolveWorkspacePath(literal!, file, dir, byWorkspace);
      if (target) found.add(target);
    }
  }
  found.delete(dir);
  return [...found];
}

function resolveWorkspacePath(
  literal: string,
  fromFile: string,
  ownDir: string,
  byWorkspace: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  // Sibling-relative paths such as `../../agent/index` name no workspace root, so resolve first.
  const relative = literal.startsWith(".")
    ? path.relative(ROOT, path.resolve(ROOT, path.dirname(fromFile), literal))
    : literal.replace(/\/$/u, "");
  const target = workspaceOf(relative);
  // A bare workspace root names the workspace rather than reading from it.
  if (!target || target === ownDir || relative === target) return undefined;
  const files = byWorkspace.get(target) ?? [];
  const named = (file: string) =>
    file.startsWith(`${relative}/`) ||
    RESOLVE_SUFFIXES.some((suffix) => file === `${relative}${suffix}`);
  return files.some(named) ? target : undefined;
}

function groupByWorkspace(files: Iterable<string>) {
  const byWorkspace = new Map<string, string[]>();
  const shared: string[] = [];
  for (const file of files) {
    const dir = workspaceOf(file);
    if (!dir) {
      shared.push(file);
      continue;
    }
    const list = byWorkspace.get(dir);
    if (list) list.push(file);
    else byWorkspace.set(dir, [file]);
  }
  return { byWorkspace, shared };
}

/** For each workspace, every workspace whose files its gates read, itself included. */
export async function workspaceInputs(
  workspaces: readonly Workspace[],
  files?: Iterable<string>,
): Promise<Map<string, Set<string>>> {
  const { byWorkspace } = groupByWorkspace(files ?? (await inputFiles()));
  const byDir = new Map(workspaces.map((workspace) => [workspace.dir, workspace]));
  const dirByPackage = new Map(workspaces.map((workspace) => [workspace.name, workspace.dir]));
  const references = new Map<string, string[]>();
  for (const dir of byDir.keys())
    references.set(dir, await referencedWorkspaces(dir, byWorkspace, byDir, dirByPackage));
  return new Map([...byDir.keys()].map((dir) => [dir, workspaceClosure([dir], byDir, references)]));
}

async function gateKeys(
  gates: readonly Gate[],
  workspaces: readonly Workspace[],
): Promise<Map<Gate, string>> {
  const digests = await digestFiles(await inputFiles());
  const grouped = groupByWorkspace(digests.keys());
  const { byWorkspace } = grouped;
  // No workspace reads root Markdown or workflow files; repository-wide gates still hash them.
  const shared = grouped.shared.filter((file) => !SHARED_EXCLUDE.test(file));
  const inputs = await workspaceInputs(workspaces, digests.keys());
  const environment = Object.entries(process.env)
    .filter(([name]) => KEY_ENV.test(name))
    .toSorted(([left], [right]) => left.localeCompare(right));
  const base = JSON.stringify([Bun.version, process.version, process.platform, process.arch]);
  const keys = new Map<Gate, string>();
  for (const gate of gates) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(JSON.stringify([base, gate.id, gate.command, gate.env ?? {}, environment]));
    const dirs = new Set((gate.workspaces ?? []).flatMap((dir) => [...(inputs.get(dir) ?? [dir])]));
    const selected = gate.workspaces
      ? [...shared, ...[...dirs].flatMap((dir) => byWorkspace.get(dir) ?? [])].toSorted()
      : [...digests.keys()];
    for (const file of selected) hasher.update(`${file}\0${digests.get(file)}\n`);
    keys.set(gate, hasher.digest("hex"));
  }
  return keys;
}

async function pruneCache(): Promise<void> {
  const entries = await readdir(CACHE_DIR).catch(() => [] as string[]);
  const now = Date.now();
  await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(CACHE_DIR, entry);
      const info = await stat(file).catch(() => undefined);
      if (info && now - info.mtimeMs > CACHE_MAX_AGE_MS) await rm(file, { force: true });
    }),
  );
}

async function readDurations(): Promise<Record<string, number>> {
  return Bun.file(path.join(CACHE_DIR, "durations.json"))
    .json()
    .catch(() => ({}));
}

async function runGate(gate: Gate): Promise<Outcome> {
  const started = performance.now();
  const child = Bun.spawn([...gate.command], {
    cwd: ROOT,
    env: { ...process.env, ...gate.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    gate,
    status: code === 0 ? "passed" : "failed",
    ms: performance.now() - started,
    output: `${stdout}${stderr}`,
  };
}

function report(outcome: Outcome, ci: boolean): void {
  const seconds = `${(outcome.ms / 1000).toFixed(1)}s`.padStart(7);
  const label = { passed: "ok  ", failed: "FAIL", reused: "same" }[outcome.status];
  const line = `${label} ${outcome.status === "reused" ? "      -" : seconds}  ${outcome.gate.id}`;
  if (outcome.status === "failed") {
    console.log(`${line}\n${outcome.output.trimEnd()}\n`);
    return;
  }
  if (!ci || !outcome.output.trim()) {
    console.log(line);
    return;
  }
  console.log(`::group::${line}\n${outcome.output.trimEnd()}\n::endgroup::`);
}

export async function runGates(options: Options): Promise<number> {
  const workspaces = await discoverWorkspaces();
  const gates = buildGates(workspaces, options).filter(
    (gate) => !options.group || gate.group === options.group,
  );
  const durations = await readDurations();
  const ordered = gates.toSorted(
    (left, right) =>
      (durations[right.id] ?? right.weight * 1000) - (durations[left.id] ?? left.weight * 1000),
  );
  if (options.reuse) await pruneCache();
  const keys = options.reuse ? await gateKeys(ordered, workspaces) : new Map<Gate, string>();
  const reused = new Set<Gate>();
  for (const [gate, key] of keys) {
    if (await Bun.file(path.join(CACHE_DIR, key)).exists()) reused.add(gate);
  }
  for (const gate of ordered.filter((candidate) => reused.has(candidate)))
    report({ gate, status: "reused", ms: 0, output: "" }, options.mode === "ci");
  const pending = ordered.filter((gate) => !reused.has(gate));
  const { pool } = gateSettings(options.mode);
  console.log(
    `Running ${pending.length} gates, ${pool} at a time` +
      (reused.size ? `; ${reused.size} unchanged since they last passed` : ""),
  );
  const started = performance.now();
  const outcomes: Outcome[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(pool, pending.length) }, async () => {
      while (next < pending.length) {
        const gate = pending[next++]!;
        const outcome = await runGate(gate);
        outcomes.push(outcome);
        report(outcome, options.mode === "ci");
        await recordPass(outcome, keys.get(gate));
      }
    }),
  );
  await recordDurations(durations, outcomes);
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  const total = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    failed.length
      ? `${failed.length} of ${gates.length} gates failed in ${total}s: ${failed.map((outcome) => outcome.gate.id).join(", ")}`
      : `All ${gates.length} gates passed in ${total}s`,
  );
  return Number(failed.length > 0);
}

async function recordPass(outcome: Outcome, key: string | undefined): Promise<void> {
  if (outcome.status !== "passed" || !key) return;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, key), `${outcome.gate.id}\n`);
}

async function recordDurations(
  previous: Record<string, number>,
  outcomes: readonly Outcome[],
): Promise<void> {
  const measured = outcomes.filter((outcome) => outcome.status === "passed");
  if (!measured.length) return;
  const durations = { ...previous };
  for (const outcome of measured) durations[outcome.gate.id] = Math.round(outcome.ms);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, "durations.json"), `${JSON.stringify(durations)}\n`);
}

export function parseOptions(argv: readonly string[]): Options {
  const [mode, ...flags] = argv;
  if (mode !== "check" && mode !== "ci")
    throw new Error(
      "Usage: run-gates.ts check|ci [--group=static|core|tests] [--shard=N/M] [--no-reuse]",
    );
  const value = (name: string) =>
    flags.find((flag) => flag.startsWith(`--${name}=`))?.slice(name.length + 3);
  const group = value("group");
  if (group !== undefined && group !== "static" && group !== "core" && group !== "tests")
    throw new Error(`Unknown gate group: ${group}`);
  const shard = value("shard");
  if (shard !== undefined && !/^\d+\/\d+$/u.test(shard))
    throw new Error(`Shard must look like 1/3: ${shard}`);
  return { mode, group, shard, reuse: mode === "check" && !flags.includes("--no-reuse") };
}

if (import.meta.main) process.exitCode = await runGates(parseOptions(process.argv.slice(2)));
