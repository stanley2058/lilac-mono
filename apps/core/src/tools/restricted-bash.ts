import { expandTilde } from "@stanley2058/lilac-fs";
import { createLogger, type CoreConfig } from "@stanley2058/lilac-utils";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { posix as posixPath } from "node:path";
import { Readable } from "node:stream";

import {
  Bash,
  decodeBytesToUtf8,
  defineCommand,
  InMemoryFs,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
  unsafeBytesFromLatin1,
  type CommandContext,
  type ExecResult,
  type FsStat,
  type IFileSystem,
} from "just-bash";

import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import { resolveRestrictedSessionTmpDir } from "../shared/attachment-utils";
import { parseSshCwdTarget } from "../ssh/ssh-cwd";
import { isWorkflowProtectedPath } from "../workflow/workflow-protected-path";
import { withLimitedBashOutput, type BashToolInput, type BashToolOutput } from "./bash-impl";
import {
  createBashOutputSanitizerTransform,
  readSanitizedStreamTextCapped,
  sanitizeBashOutputText,
} from "./bash-output-sanitizer";

const WORKSPACE_MOUNT = "/workspace";
const TMP_MOUNT = "/tmp";
const DEFAULT_RESTRICTED_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TRUSTED_WORKFLOW_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_RESTRICTED_FILE_READ_BYTES = 10 * 1024 * 1024;
const TOOL_SERVER_BACKEND_URL = process.env.TOOL_SERVER_BACKEND_URL || "http://localhost:8080";
const BWRAP_PATH = "/usr/bin/bwrap";
const SYSTEMD_RUN_PATH = "/usr/bin/systemd-run";
const SYSTEMCTL_PATH = "/usr/bin/systemctl";
const TIMEOUT_PATH = "/usr/bin/timeout";
const GETCONF_PATH = "/usr/bin/getconf";
const TRUSTED_WORKFLOW_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const TRUSTED_WORKFLOW_TASKS_MAX = 256;
const TRUSTED_WORKFLOW_MAX_ENTRIES = 500_000;
const TRUSTED_WORKFLOW_MAX_CACHE_ENTRIES = 1_000_000;
const TRUSTED_WORKFLOW_MAX_HARDLINK_INODES = 100_000;
const TRUSTED_WORKFLOW_MAX_SINGLE_ARG_BYTES = 120 * 1024;
const logger = createLogger({ module: "restricted-bash" });

type RestrictedBashContext = {
  requestId?: string;
  sessionId?: string;
  requestClient?: string;
  workflowCapability?: string;
  controlCapability?: string;
  toolCallId?: string;
  workspaceWritable?: boolean;
};

type TrustedWorkflowBashProcess = {
  stdout: unknown;
  stderr: unknown;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
};

export type TrustedWorkflowBashRuntime = {
  spawn(command: readonly string[]): TrustedWorkflowBashProcess;
  stopUnit(unit: string): Promise<void>;
  createUnitName(): string;
};

const defaultTrustedWorkflowBashRuntime: TrustedWorkflowBashRuntime = {
  spawn: (command) =>
    Bun.spawn([...command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  stopUnit: async (unit) => await stopTrustedWorkflowUnit(unit),
  createUnitName: () => `lilac-workflow-bash-${crypto.randomUUID()}`,
};

async function runUnitControl(command: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([TIMEOUT_PATH, "1s", ...command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function unitIsAbsent(result: { exitCode: number; stdout: string; stderr: string }): boolean {
  return (
    result.exitCode !== 0 &&
    /(?:not loaded|not found|could not be found)/iu.test(`${result.stdout}\n${result.stderr}`)
  );
}

async function stopTrustedWorkflowUnit(unit: string): Promise<void> {
  await runUnitControl([
    SYSTEMCTL_PATH,
    "--user",
    "kill",
    "--kill-whom=all",
    "--signal=SIGKILL",
    unit,
  ]).catch(() => undefined);
  await runUnitControl([SYSTEMCTL_PATH, "--user", "stop", unit]).catch(() => undefined);

  const deadline = Date.now() + 3_000;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const status = await runUnitControl([
      SYSTEMCTL_PATH,
      "--user",
      "show",
      unit,
      "--property=ActiveState",
      "--value",
    ]).catch((error: unknown) => ({
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));
    if (unitIsAbsent(status) || (status.exitCode === 0 && status.stdout.trim() === "inactive")) {
      await runUnitControl([SYSTEMCTL_PATH, "--user", "reset-failed", unit]).catch(() => undefined);
      return;
    }
    lastState = status.stdout.trim() || status.stderr.trim() || `exit ${status.exitCode}`;
    await Bun.sleep(50);
  }
  throw new Error(`transient unit ${unit} did not stop within 3000ms (${lastState})`);
}

type RestrictedBashFsCacheEntry = {
  bash: Bash;
  lastAccess: number;
};

const restrictedBashByRequest = new Map<string, RestrictedBashFsCacheEntry>();
const RESTRICTED_BASH_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function pruneRestrictedBashCache(now: number): void {
  for (const [key, entry] of restrictedBashByRequest) {
    if (now - entry.lastAccess > RESTRICTED_BASH_CACHE_TTL_MS) {
      restrictedBashByRequest.delete(key);
    }
  }
}

function normalizeVirtualPath(p: string): string {
  const prefixed = p.startsWith("/") ? p : `/${p}`;
  return posixPath.normalize(prefixed);
}

function isDeniedWorkspacePath(p: string): boolean {
  const normalized = normalizeVirtualPath(p);
  if (normalized === "/" || normalized === WORKSPACE_MOUNT) return false;

  const rel = normalized.startsWith(`${WORKSPACE_MOUNT}/`)
    ? normalized.slice(WORKSPACE_MOUNT.length + 1)
    : normalized.slice(1);
  return isWorkflowProtectedPath("/", path.resolve("/", rel));
}

function accessDenied(pathName: string): Error {
  const err = new Error(`Access denied in restricted mode: ${pathName}`);
  return Object.assign(err, { code: "EACCES" });
}

type TrustedWorkflowMask = {
  target: string;
  directory: boolean;
};

type TrustedWorkflowAuthorizedRoot = {
  root: string;
  cwd: string;
  masks: readonly TrustedWorkflowMask[];
  readOnlyDependencyRoots: readonly string[];
};

type HardlinkRecord = {
  key: string;
  expectedLinks: number;
  observedLinks: number;
  protected: boolean;
  unprotected: boolean;
  allObservedLinksReadOnly: boolean;
  examplePath: string;
};

type TrustedWorkflowAuthorizationControl = {
  signal?: AbortSignal;
  deadline: number;
};

class TrustedWorkflowAuthorizationInterruptedError extends Error {
  constructor(readonly kind: "aborted" | "timeout") {
    super(
      kind === "aborted"
        ? "Trusted workflow authorization aborted"
        : "Trusted workflow authorization timed out",
    );
  }
}

function assertTrustedWorkflowAuthorizationActive(
  control: TrustedWorkflowAuthorizationControl,
): void {
  if (control.signal?.aborted) throw new TrustedWorkflowAuthorizationInterruptedError("aborted");
  if (Date.now() >= control.deadline) {
    throw new TrustedWorkflowAuthorizationInterruptedError("timeout");
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function resolveTrustedBunCacheRoot(override?: string): Promise<string> {
  const configured = override ?? process.env.BUN_INSTALL_CACHE_DIR;
  const candidate = path.resolve(
    expandTilde(configured || path.join(homedir(), ".bun/install/cache")),
  );
  const stats = await fs.lstat(candidate);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (await fs.realpath(candidate)) !== candidate
  ) {
    throw new Error("Trusted workflow Bun cache root must be a canonical real directory");
  }
  return candidate;
}

async function authorizeBunCacheHardlinkSources(input: {
  records: readonly HardlinkRecord[];
  cacheRootOverride?: string;
  control: TrustedWorkflowAuthorizationControl;
}): Promise<void> {
  const unresolved = new Map(input.records.map((record) => [record.key, record]));
  if (unresolved.size === 0) return;
  assertTrustedWorkflowAuthorizationActive(input.control);
  const cacheRoot = await resolveTrustedBunCacheRoot(input.cacheRootOverride);
  let entries = 0;

  const visit = async (directory: string): Promise<void> => {
    assertTrustedWorkflowAuthorizationActive(input.control);
    const directoryHandle = await fs.opendir(directory);
    for await (const entry of directoryHandle) {
      entries += 1;
      if (entries > TRUSTED_WORKFLOW_MAX_CACHE_ENTRIES) {
        throw new Error(
          `Trusted workflow Bun cache exceeds authorization limit (${TRUSTED_WORKFLOW_MAX_CACHE_ENTRIES})`,
        );
      }
      if (entries % 128 === 0) assertTrustedWorkflowAuthorizationActive(input.control);
      const candidate = path.join(directory, entry.name);
      const stats = await fs.lstat(candidate);
      if (stats.isFile() && stats.nlink > 1) {
        unresolved.delete(`${stats.dev}:${stats.ino}`);
        if (unresolved.size === 0) return;
      }
      if (stats.isDirectory() && !stats.isSymbolicLink()) await visit(candidate);
      if (unresolved.size === 0) return;
    }
  };

  await visit(cacheRoot);
  assertTrustedWorkflowAuthorizationActive(input.control);
  const escaped = unresolved.values().next().value;
  if (escaped) {
    throw new Error(
      `Trusted workflow dependency hardlink has no authorized Bun cache source: ${escaped.examplePath}`,
    );
  }
}

async function inspectTrustedWorkflowRoot(input: {
  root: string;
  bunCacheRoot?: string;
  control: TrustedWorkflowAuthorizationControl;
}): Promise<{
  masks: readonly TrustedWorkflowMask[];
  readOnlyDependencyRoots: readonly string[];
}> {
  const root = input.root;
  const masks: TrustedWorkflowMask[] = [];
  const readOnlyDependencyRoots: string[] = [];
  const hardlinks = new Map<string, HardlinkRecord>();
  let entries = 0;

  const addMask = (target: string, directory: boolean): void => {
    masks.push({ target, directory });
  };

  const visit = async (directory: string, insideReadOnlyDependency: boolean): Promise<void> => {
    assertTrustedWorkflowAuthorizationActive(input.control);
    const directoryHandle = await fs.opendir(directory);
    for await (const entry of directoryHandle) {
      entries += 1;
      if (entries > TRUSTED_WORKFLOW_MAX_ENTRIES) {
        throw new Error(
          `Trusted workflow root exceeds entry authorization limit (${TRUSTED_WORKFLOW_MAX_ENTRIES})`,
        );
      }
      if (entries % 128 === 0) assertTrustedWorkflowAuthorizationActive(input.control);
      const candidate = path.join(directory, entry.name);
      const stats = await fs.lstat(candidate);
      const protectedPath = isWorkflowProtectedPath(root, candidate);
      const readOnlyDependency =
        insideReadOnlyDependency || (stats.isDirectory() && entry.name === "node_modules");
      if (readOnlyDependency && !insideReadOnlyDependency && stats.isDirectory()) {
        readOnlyDependencyRoots.push(candidate);
      }

      if (stats.isFile() && stats.nlink > 1) {
        const key = `${stats.dev}:${stats.ino}`;
        const record = hardlinks.get(key);
        if (record) {
          record.observedLinks += 1;
          record.protected ||= protectedPath;
          record.unprotected ||= !protectedPath;
          record.allObservedLinksReadOnly &&= readOnlyDependency;
          if (record.expectedLinks !== stats.nlink) {
            throw new Error(
              `Trusted workflow hardlink count changed during authorization: ${candidate}`,
            );
          }
        } else {
          if (hardlinks.size >= TRUSTED_WORKFLOW_MAX_HARDLINK_INODES) {
            throw new Error(
              `Trusted workflow root exceeds hardlink authorization limit (${TRUSTED_WORKFLOW_MAX_HARDLINK_INODES})`,
            );
          }
          hardlinks.set(key, {
            key,
            expectedLinks: stats.nlink,
            observedLinks: 1,
            protected: protectedPath,
            unprotected: !protectedPath,
            allObservedLinksReadOnly: readOnlyDependency,
            examplePath: candidate,
          });
        }
      }

      if (protectedPath) {
        addMask(candidate, stats.isDirectory() && !stats.isSymbolicLink());
        continue;
      }

      if (!stats.isDirectory() && !stats.isFile() && !stats.isSymbolicLink()) {
        throw new Error(`Trusted workflow root contains unsupported special node: ${candidate}`);
      }
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) await visit(candidate, readOnlyDependency);
    }
  };

  await visit(root, false);
  assertTrustedWorkflowAuthorizationActive(input.control);
  const externalDependencyRecords: HardlinkRecord[] = [];
  for (const record of hardlinks.values()) {
    if (record.protected && record.unprotected) {
      throw new Error(`Trusted workflow hardlink aliases protected data: ${record.examplePath}`);
    }
    if (record.observedLinks !== record.expectedLinks) {
      if (!record.allObservedLinksReadOnly) {
        throw new Error(
          `Trusted workflow hardlink escapes the approved root: ${record.examplePath} (${record.observedLinks}/${record.expectedLinks} links authorized)`,
        );
      }
      externalDependencyRecords.push(record);
    }
  }
  await authorizeBunCacheHardlinkSources({
    records: externalDependencyRecords,
    cacheRootOverride: input.bunCacheRoot,
    control: input.control,
  });
  return { masks, readOnlyDependencyRoots };
}

async function authorizeTrustedWorkflowRoot(input: {
  workspaceRoot: string;
  cwd?: string;
  bunCacheRoot?: string;
  control: TrustedWorkflowAuthorizationControl;
}): Promise<TrustedWorkflowAuthorizedRoot> {
  assertTrustedWorkflowAuthorizationActive(input.control);
  const root = path.resolve(expandTilde(input.workspaceRoot));
  if (root === path.parse(root).root || isContained("/usr", root)) {
    throw new Error("Trusted workflow bash requires a dedicated non-system workspace root");
  }
  const stats = await fs.lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory() || (await fs.realpath(root)) !== root) {
    throw new Error("Trusted workflow bash root must be a canonical real directory");
  }
  let cwd = root;
  if (input.cwd !== undefined) {
    const parsed = parseSshCwdTarget(input.cwd);
    if (parsed.kind === "ssh") {
      throw new Error("Trusted workflow bash does not allow SSH cwd targets");
    }
    const requestedValue = parsed.cwd ?? input.cwd;
    const requested = path.isAbsolute(requestedValue)
      ? path.resolve(expandTilde(requestedValue))
      : path.resolve(root, requestedValue);
    if (!isContained(root, requested)) {
      throw new Error("Trusted workflow bash cwd is outside the approved root");
    }
    if (isWorkflowProtectedPath(root, requested)) {
      throw new Error("Trusted workflow bash cwd is a protected path");
    }
    const requestedStats = await fs.lstat(requested);
    if (
      requestedStats.isSymbolicLink() ||
      !requestedStats.isDirectory() ||
      (await fs.realpath(requested)) !== requested
    ) {
      throw new Error("Trusted workflow bash cwd must be a canonical real directory");
    }
    cwd = requested;
  }
  const inspection = await inspectTrustedWorkflowRoot({
    root,
    bunCacheRoot: input.bunCacheRoot,
    control: input.control,
  });
  return { root, cwd, ...inspection };
}

function trustedWorkflowRootDirectories(root: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(root);
  while (current !== path.parse(current).root) {
    directories.unshift(current);
    current = path.dirname(current);
  }
  return directories;
}

let trustedWorkflowArgvLimitPromise: Promise<number> | null = null;

async function resolveTrustedWorkflowArgvLimit(): Promise<number> {
  trustedWorkflowArgvLimitPromise ??= (async () => {
    const child = Bun.spawn([GETCONF_PATH, "ARG_MAX"], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const argMax = Number(stdout.trim());
    if (exitCode !== 0 || !Number.isSafeInteger(argMax) || argMax <= 0) {
      throw new Error(
        `Trusted workflow could not resolve ARG_MAX: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`,
      );
    }
    const environmentBytes = Object.entries(process.env).reduce(
      (total, [name, value]) =>
        total + Buffer.byteLength(name) + Buffer.byteLength(value ?? "") + 2,
      0,
    );
    const available = argMax - environmentBytes - 64 * 1024;
    if (available <= TRUSTED_WORKFLOW_MAX_SINGLE_ARG_BYTES) {
      throw new Error("Trusted workflow process environment leaves no safe argv capacity");
    }
    return Math.floor(available * 0.75);
  })();
  return await trustedWorkflowArgvLimitPromise;
}

function buildTrustedWorkflowCommand(input: {
  command: string;
  root: string;
  cwd: string;
  writable: boolean;
  masks: readonly TrustedWorkflowMask[];
  readOnlyDependencyRoots: readonly string[];
  emptyFile: string;
  emptyDirectory: string;
  timeoutMs: number;
  stdinMode: "error" | "eof";
  unit: string;
  maxArgvBytes: number;
  context?: RestrictedBashContext;
}): string[] {
  const command = [
    SYSTEMD_RUN_PATH,
    "--user",
    "--pipe",
    "--wait",
    "--collect",
    "--quiet",
    `--unit=${input.unit}`,
    "-p",
    `MemoryMax=${TRUSTED_WORKFLOW_MEMORY_BYTES}`,
    "-p",
    "MemorySwapMax=0",
    "-p",
    `TasksMax=${TRUSTED_WORKFLOW_TASKS_MAX}`,
    "-p",
    `RuntimeMaxSec=${Math.max(1, Math.ceil(input.timeoutMs / 1_000))}s`,
    BWRAP_PATH,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--dir",
    "/sandbox",
    "--dir",
    "/sandbox/bin",
    "--ro-bind",
    process.execPath,
    "/sandbox/bin/bun",
  ];

  for (const directory of trustedWorkflowRootDirectories(input.root)) {
    if (directory !== "/usr" && !directory.startsWith("/usr/")) command.push("--dir", directory);
  }
  command.push(input.writable ? "--bind" : "--ro-bind", input.root, input.root);

  for (const dependencyRoot of input.readOnlyDependencyRoots) {
    command.push("--ro-bind", dependencyRoot, dependencyRoot);
  }

  for (const mask of input.masks) {
    command.push("--ro-bind", mask.directory ? input.emptyDirectory : input.emptyFile, mask.target);
  }

  const environment: Record<string, string | undefined> = {
    HOME: "/tmp/home",
    PATH: "/sandbox/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: "/tmp/cache",
    BUN_INSTALL_CACHE_DIR: "/tmp/bun-cache",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
    LILAC_REQUEST_ID: input.context?.requestId,
    LILAC_SESSION_ID: input.context?.sessionId,
    LILAC_REQUEST_CLIENT: input.context?.requestClient,
    LILAC_CWD: input.root,
  };
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) command.push("--setenv", name, value);
  }

  command.push("--chdir", input.cwd, "/usr/bin/bash", "-c");
  command.push(input.stdinMode === "eof" ? input.command : `exec 0>/dev/null; ${input.command}`);
  const oversizedArgument = command.find(
    (value) => Buffer.byteLength(value) > TRUSTED_WORKFLOW_MAX_SINGLE_ARG_BYTES,
  );
  if (oversizedArgument !== undefined) {
    throw new Error(
      `Trusted workflow sandbox argument exceeds transport limit (${Buffer.byteLength(oversizedArgument)}/${TRUSTED_WORKFLOW_MAX_SINGLE_ARG_BYTES} bytes)`,
    );
  }
  const argvBytes = command.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0);
  if (argvBytes > input.maxArgvBytes) {
    throw new Error(
      `Trusted workflow sandbox argv exceeds transport limit (${argvBytes}/${input.maxArgvBytes} bytes)`,
    );
  }
  return command;
}

async function createTrustedWorkflowSupportDirectory(): Promise<{
  root: string;
  emptyFile: string;
  emptyDirectory: string;
}> {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath("/tmp"), "lilac-trusted-workflow-bash-"),
  );
  const emptyFile = path.join(root, "empty-file");
  const emptyDirectory = path.join(root, "empty-directory");
  await fs.writeFile(emptyFile, "", { mode: 0o600 });
  await fs.mkdir(emptyDirectory, { mode: 0o700 });
  return { root, emptyFile, emptyDirectory };
}

function trustedWorkflowOverflowPaths(): { stdout: string; stderr: string } {
  const base = path.join("/tmp", `lilac-trusted-workflow-output-${crypto.randomUUID()}`);
  return { stdout: `${base}.stdout`, stderr: `${base}.stderr` };
}

function createTrustedWorkflowArtifactSource(input: {
  stdout: string;
  stderr: string;
  stdoutOverflowPath?: string;
  stderrOverflowPath?: string;
}): Readable {
  async function* content() {
    yield "--- stdout ---\n";
    if (input.stdoutOverflowPath) yield* createReadStream(input.stdoutOverflowPath);
    else yield input.stdout;
    yield "\n\n--- stderr ---\n";
    if (input.stderrOverflowPath) yield* createReadStream(input.stderrOverflowPath);
    else yield input.stderr;
    yield "\n";
  }
  return Readable.from(content()).pipe(createBashOutputSanitizerTransform([]));
}

async function persistTrustedWorkflowOutput(input: {
  artifacts?: ToolResultArtifactStore;
  outputConfig: CoreConfig["tools"]["output"];
  context?: RestrictedBashContext;
  toolCallId?: string;
  stdout: string;
  stderr: string;
  stdoutOverflowPath?: string;
  stderrOverflowPath?: string;
}): Promise<string | undefined> {
  if (
    !input.artifacts ||
    !input.context?.requestId ||
    !input.context.sessionId ||
    !input.toolCallId
  ) {
    return undefined;
  }
  try {
    return (
      await input.artifacts.createFromStream({
        sessionId: input.context.sessionId,
        requestId: input.context.requestId,
        toolCallId: input.toolCallId,
        toolName: "bash",
        source: createTrustedWorkflowArtifactSource(input),
        ttlMs: input.outputConfig.artifactTtlMs,
        maxBytesPerSession: input.outputConfig.artifactMaxBytesPerSession,
      })
    ).uri;
  } catch (error) {
    logger.warn("tool.artifact.write_failed", {
      toolName: "bash",
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

class RestrictedReadFs implements IFileSystem {
  constructor(
    private readonly inner: IFileSystem,
    private readonly denyOutsideMount = false,
    private readonly hostRoot?: string,
  ) {}

  private async assertReadable(pathName: string): Promise<void> {
    if (this.denyOutsideMount && normalizeVirtualPath(pathName) !== "/") {
      throw accessDenied(pathName);
    }
    if (isDeniedWorkspacePath(pathName)) throw accessDenied(pathName);
    if (!this.hostRoot) return;
    const virtual = normalizeVirtualPath(pathName);
    const relative = virtual.startsWith(`${WORKSPACE_MOUNT}/`)
      ? virtual.slice(WORKSPACE_MOUNT.length + 1)
      : virtual.slice(1);
    const candidate = path.resolve(this.hostRoot, relative);
    if (candidate !== this.hostRoot && !candidate.startsWith(`${this.hostRoot}${path.sep}`)) {
      throw accessDenied(pathName);
    }
    const stat = await fs.lstat(candidate).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isFile() && stat.nlink > 1) throw accessDenied(pathName);
  }

  private async assertWritable(pathName: string): Promise<void> {
    if (this.denyOutsideMount || normalizeVirtualPath(pathName) === "/") {
      throw accessDenied(pathName);
    }
    if (isDeniedWorkspacePath(pathName)) throw accessDenied(pathName);
    if (!this.hostRoot) return;
    const virtual = normalizeVirtualPath(pathName);
    const relative = virtual.startsWith(`${WORKSPACE_MOUNT}/`)
      ? virtual.slice(WORKSPACE_MOUNT.length + 1)
      : virtual.slice(1);
    const candidate = path.resolve(this.hostRoot, relative);
    if (candidate !== this.hostRoot && !candidate.startsWith(`${this.hostRoot}${path.sep}`)) {
      throw accessDenied(pathName);
    }
    const stat = await fs.lstat(candidate).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isFile() && stat.nlink > 1) throw accessDenied(pathName);
  }

  private async assertNoProtectedDescendants(pathName: string): Promise<void> {
    if (!(await this.inner.exists(pathName))) return;
    const stat = await this.inner.lstat(pathName);
    if (!stat.isDirectory) return;
    for (const name of await this.inner.readdir(pathName)) {
      const child = posixPath.join(pathName, name);
      if (isDeniedWorkspacePath(child)) throw accessDenied(child);
      await this.assertNoProtectedDescendants(child);
    }
  }

  private filterChild(parent: string, name: string): boolean {
    return !isDeniedWorkspacePath(posixPath.join(normalizeVirtualPath(parent), name));
  }

  async readFile(pathName: string, options?: Parameters<IFileSystem["readFile"]>[1]) {
    await this.assertReadable(pathName);
    return await this.inner.readFile(pathName, options);
  }

  async readFileBytes(pathName: string) {
    await this.assertReadable(pathName);
    if (this.inner.readFileBytes) return await this.inner.readFileBytes(pathName);
    const buffer = await this.inner.readFileBuffer(pathName);
    return unsafeBytesFromLatin1(Buffer.from(buffer).toString("latin1"));
  }

  async readFileBuffer(pathName: string) {
    await this.assertReadable(pathName);
    return await this.inner.readFileBuffer(pathName);
  }

  async writeFile(
    pathName: string,
    content: Parameters<IFileSystem["writeFile"]>[1],
    options?: Parameters<IFileSystem["writeFile"]>[2],
  ) {
    await this.assertWritable(pathName);
    return await this.inner.writeFile(pathName, content, options);
  }

  async appendFile(
    pathName: string,
    content: Parameters<IFileSystem["appendFile"]>[1],
    options?: Parameters<IFileSystem["appendFile"]>[2],
  ) {
    await this.assertWritable(pathName);
    return await this.inner.appendFile(pathName, content, options);
  }

  async exists(pathName: string) {
    if (this.denyOutsideMount && normalizeVirtualPath(pathName) !== "/") return false;
    if (isDeniedWorkspacePath(pathName)) return false;
    try {
      await this.assertReadable(pathName);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EACCES") return false;
      throw error;
    }
    return await this.inner.exists(pathName);
  }

  async stat(pathName: string): Promise<FsStat> {
    await this.assertReadable(pathName);
    return await this.inner.stat(pathName);
  }

  async mkdir(pathName: string, options?: Parameters<IFileSystem["mkdir"]>[1]) {
    await this.assertWritable(pathName);
    return await this.inner.mkdir(pathName, options);
  }

  async readdir(pathName: string) {
    await this.assertReadable(pathName);
    const entries = await this.inner.readdir(pathName);
    return entries.filter((name) => this.filterChild(pathName, name));
  }

  async readdirWithFileTypes(pathName: string) {
    await this.assertReadable(pathName);
    const entries = await this.inner.readdirWithFileTypes?.(pathName);
    if (entries) return entries.filter((entry) => this.filterChild(pathName, entry.name));
    return [];
  }

  async rm(pathName: string, options?: Parameters<IFileSystem["rm"]>[1]) {
    await this.assertWritable(pathName);
    await this.assertNoProtectedDescendants(pathName);
    return await this.inner.rm(pathName, options);
  }

  async cp(src: string, dest: string, options?: Parameters<IFileSystem["cp"]>[2]) {
    await this.assertReadable(src);
    await this.assertNoProtectedDescendants(src);
    await this.assertWritable(dest);
    return await this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string) {
    await this.assertWritable(src);
    await this.assertNoProtectedDescendants(src);
    await this.assertWritable(dest);
    return await this.inner.mv(src, dest);
  }

  resolvePath(base: string, pathName: string) {
    return this.inner.resolvePath(base, pathName);
  }

  getAllPaths() {
    if (this.denyOutsideMount) return [];
    return this.inner.getAllPaths().filter((p) => !isDeniedWorkspacePath(p));
  }

  async chmod(pathName: string, mode: number) {
    await this.assertWritable(pathName);
    return await this.inner.chmod(pathName, mode);
  }

  async symlink(target: string, linkPath: string) {
    await this.assertWritable(linkPath);
    throw accessDenied(`${linkPath} -> ${target}`);
  }

  async link(existingPath: string, newPath: string) {
    await this.assertReadable(existingPath);
    await this.assertWritable(newPath);
    throw accessDenied(`${newPath} -> ${existingPath}`);
  }

  async readlink(pathName: string) {
    await this.assertReadable(pathName);
    return await this.inner.readlink(pathName);
  }

  async lstat(pathName: string): Promise<FsStat> {
    await this.assertReadable(pathName);
    return await this.inner.lstat(pathName);
  }

  async realpath(pathName: string) {
    await this.assertReadable(pathName);
    return await this.inner.realpath(pathName);
  }

  async utimes(pathName: string, atime: Date, mtime: Date) {
    await this.assertWritable(pathName);
    return await this.inner.utimes(pathName, atime, mtime);
  }
}

function kebabToCamelCase(input: string): string {
  return input.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function parseBooleanLike(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

async function readJsonSource(source: string, ctx: CommandContext): Promise<unknown> {
  if (source === "@-") return JSON.parse(decodeBytesToUtf8(ctx.stdin));
  if (source.startsWith("@")) {
    const rawPath = source.slice(1);
    const resolved = ctx.fs.resolvePath(ctx.cwd, rawPath);
    return JSON.parse(await ctx.fs.readFile(resolved));
  }
  return JSON.parse(source);
}

function formatToolOutput(value: unknown): string {
  if (typeof value === "string") return value.endsWith("\n") ? value : `${value}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildToolServerHeaders(
  context: RestrictedBashContext,
  cwd: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-lilac-safety-mode": "restricted",
  };
  if (context.requestId) headers["x-lilac-request-id"] = context.requestId;
  if (context.sessionId) headers["x-lilac-session-id"] = context.sessionId;
  if (context.requestClient) headers["x-lilac-request-client"] = context.requestClient;
  if (context.workflowCapability) {
    headers["x-lilac-workflow-capability"] = context.workflowCapability;
  }
  if (context.controlCapability) {
    headers["x-lilac-control-capability"] = context.controlCapability;
  }
  if (context.toolCallId) headers["x-lilac-tool-call-id"] = context.toolCallId;
  headers["x-lilac-cwd"] = cwd;
  return headers;
}

async function readHttpErrorMessage(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  if (body.trim().length === 0) return `${res.status} ${res.statusText}`.trim();
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record["message"] === "string") return record["message"];
      if (typeof record["output"] === "string") return record["output"];
    }
  } catch {
    // Keep raw body below.
  }
  return body;
}

type PrimaryPositional = {
  field: string;
  variadic?: boolean;
};

async function fetchToolHelp(callableId: string, headers: Record<string, string>) {
  const res = await fetch(`${TOOL_SERVER_BACKEND_URL}/help/${encodeURIComponent(callableId)}`, {
    headers,
  });
  if (!res.ok) throw new Error(await readHttpErrorMessage(res));
  return (await res.json()) as { primaryPositional?: PrimaryPositional };
}

async function buildNestedToolInput(params: {
  callableId: string;
  args: readonly string[];
  ctx: CommandContext;
  headers: Record<string, string>;
}): Promise<Record<string, unknown>> {
  let input: Record<string, unknown> = {};
  const positionals: string[] = [];
  const bareBooleanFlags: string[] = [];

  for (let i = 0; i < params.args.length; i++) {
    const arg = params.args[i] ?? "";
    if (arg === "--stdin" || arg.startsWith("--stdin=")) {
      const value = arg === "--stdin" ? true : parseBooleanLike(arg.slice("--stdin=".length));
      if (value === false) continue;
      input = JSON.parse(decodeBytesToUtf8(params.ctx.stdin)) as Record<string, unknown>;
      continue;
    }
    if (arg === "--input") {
      throw new Error(
        "--input requires a value: --input=@file.json, --input=@-, or --input='<json>'",
      );
    }
    if (arg.startsWith("--input=")) {
      const value = arg.slice("--input=".length);
      input = (await readJsonSource(value, params.ctx)) as Record<string, unknown>;
      continue;
    }
    if (arg === "--") {
      positionals.push(...params.args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const rawKey = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const rawValue = eq === -1 ? "" : arg.slice(eq + 1);
    if (rawKey.length === 0) continue;

    const isJson = rawKey.endsWith(":json");
    const field = kebabToCamelCase(isJson ? rawKey.slice(0, -":json".length) : rawKey);
    if (isJson) {
      if (eq === -1) {
        throw new Error(`--${field}:json requires a value`);
      }
      input[field] = await readJsonSource(rawValue, params.ctx);
      continue;
    }

    if (eq === -1) {
      bareBooleanFlags.push(rawKey);
      input[field] = true;
    } else {
      input[field] = parseBooleanLike(rawValue) ?? rawValue;
    }
  }

  if (positionals.length > 0) {
    const help = await fetchToolHelp(params.callableId, params.headers);
    const primaryPositional = help.primaryPositional;
    if (!primaryPositional) {
      const bareFlag = bareBooleanFlags[0];
      const flagHint = bareFlag
        ? ` Bare --${bareFlag} was parsed as boolean true; if you meant to pass a value, use --${bareFlag}=<value>.`
        : " If you meant to pass a flag value, use --field=<value>.";
      throw new Error(
        `Tool '${params.callableId}' does not support positional input.${flagHint} Space-separated flag values are not supported; use --input JSON or stdin for structured input.`,
      );
    }
    if (Object.hasOwn(input, primaryPositional.field)) {
      throw new Error(
        `Primary positional conflicts with an existing '${primaryPositional.field}' value from flags or JSON input`,
      );
    }
    if (primaryPositional.variadic === true) {
      input[primaryPositional.field] = positionals;
      return input;
    }

    if (positionals.length > 1) {
      throw new Error(`Tool '${params.callableId}' accepts at most one positional argument`);
    }
    input[primaryPositional.field] = positionals[0] ?? "";
  }

  return input;
}

function createToolsCommand(context: RestrictedBashContext) {
  return defineCommand("tools", async (args, ctx): Promise<ExecResult> => {
    const headers = buildToolServerHeaders(context, ctx.cwd);
    const [first, ...rest] = args;

    try {
      if (!first || first === "--list") {
        const res = await fetch(`${TOOL_SERVER_BACKEND_URL}/list`, { headers });
        if (!res.ok) throw new Error(await readHttpErrorMessage(res));
        return { stdout: formatToolOutput(await res.json()), stderr: "", exitCode: 0 };
      }

      if (first === "--help") {
        const callableId = rest[0];
        if (!callableId) {
          return {
            stdout: "Usage: tools [--list] [--help <callableId>] <callableId> [args...]\n",
            stderr: "",
            exitCode: 0,
          };
        }
        const help = await fetchToolHelp(callableId, headers);
        return { stdout: formatToolOutput(help), stderr: "", exitCode: 0 };
      }

      const callableId = first;
      const input = await buildNestedToolInput({ callableId, args: rest, ctx, headers });
      const res = await fetch(`${TOOL_SERVER_BACKEND_URL}/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({ callableId, input }),
      });
      if (!res.ok) throw new Error(await readHttpErrorMessage(res));
      const payload = (await res.json()) as { isError: boolean; output: unknown };
      if (payload.isError) {
        return { stdout: "", stderr: formatToolOutput(payload.output), exitCode: 1 };
      }
      return { stdout: formatToolOutput(payload.output), stderr: "", exitCode: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
    }
  });
}

function resolveRestrictedCwd(input: {
  cwd?: string;
  workspaceRoot: string;
  sessionTmpDir: string;
}): string {
  if (!input.cwd) return WORKSPACE_MOUNT;
  const parsed = parseSshCwdTarget(input.cwd);
  if (parsed.kind === "ssh") {
    throw new Error("Restricted bash does not allow SSH cwd targets");
  }

  const expanded = path.resolve(expandTilde(parsed.cwd ?? input.cwd));
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const sessionTmpDir = path.resolve(input.sessionTmpDir);

  if (expanded === workspaceRoot) return WORKSPACE_MOUNT;
  if (expanded.startsWith(`${workspaceRoot}${path.sep}`)) {
    return posixPath.join(
      WORKSPACE_MOUNT,
      path.relative(workspaceRoot, expanded).split(path.sep).join("/"),
    );
  }
  if (expanded === sessionTmpDir) return TMP_MOUNT;
  if (expanded.startsWith(`${sessionTmpDir}${path.sep}`)) {
    return posixPath.join(
      TMP_MOUNT,
      path.relative(sessionTmpDir, expanded).split(path.sep).join("/"),
    );
  }
  if (input.cwd === TMP_MOUNT || input.cwd.startsWith(`${TMP_MOUNT}/`)) return input.cwd;
  if (input.cwd === WORKSPACE_MOUNT || input.cwd.startsWith(`${WORKSPACE_MOUNT}/`))
    return input.cwd;

  throw new Error("Restricted bash cwd is outside the approved workspace and session temp roots");
}

async function createRestrictedBash(params: {
  workspaceRoot: string;
  sessionTmpDir: string;
  context: RestrictedBashContext;
}): Promise<Bash> {
  await fs.mkdir(params.sessionTmpDir, { recursive: true, mode: 0o700 });
  if (params.context.workspaceWritable) {
    const workspaceStats = await fs.lstat(params.workspaceRoot);
    if (
      workspaceStats.isSymbolicLink() ||
      !workspaceStats.isDirectory() ||
      (await fs.realpath(params.workspaceRoot)) !== params.workspaceRoot
    ) {
      throw new Error("Restricted writable workspace must be a canonical real directory");
    }
  }

  const workspaceFs = new RestrictedReadFs(
    params.context.workspaceWritable
      ? new ReadWriteFs({
          root: params.workspaceRoot,
          maxFileReadSize: MAX_RESTRICTED_FILE_READ_BYTES,
          allowSymlinks: false,
        })
      : new OverlayFs({
          root: params.workspaceRoot,
          mountPoint: "/",
          maxFileReadSize: MAX_RESTRICTED_FILE_READ_BYTES,
          allowSymlinks: false,
        }),
    false,
    params.workspaceRoot,
  );

  const tmpFs = new ReadWriteFs({
    root: params.sessionTmpDir,
    maxFileReadSize: MAX_RESTRICTED_FILE_READ_BYTES,
    allowSymlinks: false,
  });

  const mountable = new MountableFs({
    base: new RestrictedReadFs(new InMemoryFs(), true),
    mounts: [
      { mountPoint: WORKSPACE_MOUNT, filesystem: workspaceFs },
      { mountPoint: TMP_MOUNT, filesystem: tmpFs },
    ],
  });

  return new Bash({
    fs: mountable,
    cwd: WORKSPACE_MOUNT,
    env: {
      HOME: "/home/user",
      TMPDIR: TMP_MOUNT,
      LILAC_RESTRICTED: "1",
      LILAC_RESTRICTED_TMP: TMP_MOUNT,
      ...(params.context.requestId ? { LILAC_REQUEST_ID: params.context.requestId } : {}),
      ...(params.context.sessionId ? { LILAC_SESSION_ID: params.context.sessionId } : {}),
      ...(params.context.requestClient
        ? { LILAC_REQUEST_CLIENT: params.context.requestClient }
        : {}),
    },
    customCommands: [createToolsCommand(params.context)],
    defenseInDepth: true,
    executionLimits: {
      maxCommandCount: 10000,
      maxLoopIterations: 10000,
      maxCallDepth: 100,
      maxAwkIterations: 10000,
      maxSedIterations: 10000,
      maxJqIterations: 10000,
      maxStringLength: 10 * 1024 * 1024,
      maxArrayElements: 100000,
      maxGlobOperations: 100000,
      maxSubstitutionDepth: 50,
      maxHeredocSize: 10 * 1024 * 1024,
    },
  });
}

async function getRestrictedBash(params: {
  requestId?: string;
  workspaceRoot: string;
  sessionTmpDir: string;
  context: RestrictedBashContext;
}): Promise<Bash> {
  const now = Date.now();
  pruneRestrictedBashCache(now);

  if (!params.requestId) {
    return await createRestrictedBash(params);
  }
  const cacheKey = JSON.stringify([
    params.context.sessionId ?? "",
    params.requestId,
    params.workspaceRoot,
    params.context.toolCallId ?? "",
    params.context.workspaceWritable ? "write" : "read",
  ]);

  const cached = restrictedBashByRequest.get(cacheKey);
  if (cached) {
    cached.lastAccess = now;
    return cached.bash;
  }

  const bash = await createRestrictedBash(params);
  restrictedBashByRequest.set(cacheKey, { bash, lastAccess: now });
  return bash;
}

export async function executeRestrictedBash(
  { command, cwd, timeoutMs, stdinMode }: BashToolInput,
  options: {
    workspaceRoot?: string;
    context?: RestrictedBashContext;
    abortSignal?: AbortSignal;
    toolCallId?: string;
    artifacts?: ToolResultArtifactStore;
    outputConfig?: CoreConfig["tools"]["output"];
  } = {},
): Promise<BashToolOutput> {
  if (stdinMode === "eof") {
    // just-bash commands see empty stdin by default; keep accepting this compatibility flag.
  }

  const context = { ...options.context, toolCallId: options.toolCallId };
  const workspaceRoot = path.resolve(expandTilde(options.workspaceRoot ?? process.cwd()));
  const sessionTmpDir = resolveRestrictedSessionTmpDir(context.sessionId);

  let restrictedCwd: string;
  try {
    restrictedCwd = resolveRestrictedCwd({ cwd, workspaceRoot, sessionTmpDir });
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: -1,
      executionError: {
        type: "blocked",
        reason: "restricted_bash_cwd",
      },
    };
  }

  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_RESTRICTED_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeoutMs);
  timeout.unref?.();

  const abortListener = () => controller.abort();
  if (options.abortSignal) {
    if (options.abortSignal.aborted) controller.abort();
    else options.abortSignal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    const bash = await getRestrictedBash({
      requestId: context.requestId,
      workspaceRoot,
      sessionTmpDir,
      context,
    });
    const result = await bash.exec(command, {
      cwd: restrictedCwd,
      replaceEnv: false,
      signal: controller.signal,
    });
    const output = {
      stdout: sanitizeBashOutputText(result.stdout),
      stderr: sanitizeBashOutputText(result.stderr),
      exitCode: result.exitCode,
    };
    const outputConfig = options.outputConfig ?? {
      maxPreviewBytes: 40 * 1024,
      artifactTtlMs: 7 * 24 * 60 * 60 * 1000,
      artifactMaxBytesPerSession: 50 * 1024 * 1024,
    };
    const isTruncated =
      Buffer.byteLength(output.stdout, "utf8") + Buffer.byteLength(output.stderr, "utf8") >
      outputConfig.maxPreviewBytes;
    let artifactUri: string | undefined;
    if (
      isTruncated &&
      options.artifacts &&
      context.sessionId &&
      context.requestId &&
      options.toolCallId
    ) {
      try {
        artifactUri = (
          await options.artifacts.createFromStream({
            sessionId: context.sessionId,
            requestId: context.requestId,
            toolCallId: options.toolCallId,
            toolName: "bash",
            source: Readable.from([
              "--- stdout ---\n",
              output.stdout,
              "\n\n--- stderr ---\n",
              output.stderr,
              "\n",
            ]),
            ttlMs: outputConfig.artifactTtlMs,
            maxBytesPerSession: outputConfig.artifactMaxBytesPerSession,
          })
        ).uri;
      } catch (error) {
        logger.warn("tool.artifact.write_failed", {
          toolName: "bash",
          error: error instanceof Error ? error.message : String(error),
        });
        artifactUri = undefined;
      }
    }
    return withLimitedBashOutput(output, {
      maxOutputBytes: outputConfig.maxPreviewBytes,
      truncated: isTruncated,
      artifactUri,
      originalStdoutBytes: Buffer.byteLength(output.stdout, "utf8"),
      originalStderrBytes: Buffer.byteLength(output.stderr, "utf8"),
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: -1,
      executionError: timedOut
        ? {
            type: "timeout",
            timeoutMs: effectiveTimeoutMs,
            signal: "ABORT",
          }
        : aborted
          ? {
              type: "aborted",
              signal: "ABORT",
            }
          : {
              type: "exception",
              phase: "unknown",
              message: error instanceof Error ? error.message : String(error),
            },
    };
  } finally {
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", abortListener);
  }
}

/**
 * `executeBash` cannot be used here: it inherits Core's environment and host
 * filesystem authority. Trusted workflows instead get installed executable
 * trees plus their approved root inside the existing systemd/bwrap boundary.
 */
export async function executeTrustedWorkflowBash(
  { command, cwd, timeoutMs, stdinMode }: BashToolInput,
  options: {
    workspaceRoot: string;
    workspaceWritable: boolean;
    context?: RestrictedBashContext;
    abortSignal?: AbortSignal;
    toolCallId?: string;
    artifacts?: ToolResultArtifactStore;
    outputConfig?: CoreConfig["tools"]["output"];
    onActivity?: () => void;
    runtime?: TrustedWorkflowBashRuntime;
    bunCacheRoot?: string;
  },
): Promise<BashToolOutput> {
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TRUSTED_WORKFLOW_TIMEOUT_MS;
  const authorizationControl: TrustedWorkflowAuthorizationControl = {
    signal: options.abortSignal,
    deadline: Date.now() + effectiveTimeoutMs,
  };
  if (options.abortSignal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      executionError: { type: "aborted", signal: "SIGTERM" },
    };
  }
  let authorized: TrustedWorkflowAuthorizedRoot;
  try {
    authorized = await authorizeTrustedWorkflowRoot({
      workspaceRoot: options.workspaceRoot,
      cwd,
      bunCacheRoot: options.bunCacheRoot,
      control: authorizationControl,
    });
  } catch (error) {
    if (error instanceof TrustedWorkflowAuthorizationInterruptedError) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        executionError:
          error.kind === "aborted"
            ? { type: "aborted", signal: "SIGTERM" }
            : { type: "timeout", timeoutMs: effectiveTimeoutMs, signal: "SIGTERM" },
      };
    }
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: -1,
      executionError: { type: "blocked", reason: "trusted_workflow_bash_cwd" },
    };
  }

  const runtime = options.runtime ?? defaultTrustedWorkflowBashRuntime;
  const unit = runtime.createUnitName();
  const outputConfig = options.outputConfig ?? {
    maxPreviewBytes: 40 * 1024,
    artifactTtlMs: 7 * 24 * 60 * 60 * 1000,
    artifactMaxBytesPerSession: 50 * 1024 * 1024,
  };
  let maxArgvBytes: number;
  try {
    maxArgvBytes = await resolveTrustedWorkflowArgvLimit();
    assertTrustedWorkflowAuthorizationActive(authorizationControl);
  } catch (error) {
    if (error instanceof TrustedWorkflowAuthorizationInterruptedError) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        executionError:
          error.kind === "aborted"
            ? { type: "aborted", signal: "SIGTERM" }
            : { type: "timeout", timeoutMs: effectiveTimeoutMs, signal: "SIGTERM" },
      };
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      executionError: {
        type: "exception",
        phase: "spawn",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const remainingTimeoutMs = Math.max(1, authorizationControl.deadline - Date.now());
  let child: TrustedWorkflowBashProcess | null = null;
  let timedOut = false;
  let aborted = false;
  let stopping: Promise<void> | null = null;
  let supportRoot: string | null = null;
  const overflowPaths = trustedWorkflowOverflowPaths();
  const retainOverflow = Boolean(
    options.artifacts &&
    options.context?.requestId &&
    options.context.sessionId &&
    options.toolCallId,
  );
  const stop = (reason: "timeout" | "abort"): void => {
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {}
    stopping ??= runtime.stopUnit(unit);
  };
  const abortListener = () => stop("abort");
  if (options.abortSignal?.aborted) abortListener();
  else options.abortSignal?.addEventListener("abort", abortListener, { once: true });
  const timeout = setTimeout(() => stop("timeout"), remainingTimeoutMs);
  timeout.unref?.();

  try {
    if (timedOut || aborted) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        executionError: timedOut
          ? { type: "timeout", timeoutMs: effectiveTimeoutMs, signal: "SIGTERM" }
          : { type: "aborted", signal: "SIGTERM" },
      };
    }
    const support = await createTrustedWorkflowSupportDirectory();
    supportRoot = support.root;
    if (timedOut || aborted) {
      return {
        stdout: "",
        stderr: "",
        exitCode: -1,
        executionError: timedOut
          ? { type: "timeout", timeoutMs: effectiveTimeoutMs, signal: "SIGTERM" }
          : { type: "aborted", signal: "SIGTERM" },
      };
    }
    child = runtime.spawn(
      buildTrustedWorkflowCommand({
        command,
        root: authorized.root,
        cwd: authorized.cwd,
        writable: options.workspaceWritable,
        masks: authorized.masks,
        readOnlyDependencyRoots: authorized.readOnlyDependencyRoots,
        emptyFile: support.emptyFile,
        emptyDirectory: support.emptyDirectory,
        timeoutMs: remainingTimeoutMs,
        stdinMode: stdinMode ?? "error",
        unit,
        maxArgvBytes,
        context: options.context,
      }),
    );
    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readSanitizedStreamTextCapped(child.stdout, outputConfig.maxPreviewBytes, {
        overflowFilePath: retainOverflow ? overflowPaths.stdout : undefined,
        onActivity: options.onActivity,
      }),
      readSanitizedStreamTextCapped(child.stderr, outputConfig.maxPreviewBytes, {
        overflowFilePath: retainOverflow ? overflowPaths.stderr : undefined,
        onActivity: options.onActivity,
      }),
      child.exited,
    ]);

    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value.text : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value.text : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;
    const truncated =
      (stdoutResult.status === "fulfilled" && stdoutResult.value.capped) ||
      (stderrResult.status === "fulfilled" && stderrResult.value.capped);
    const spillComplete =
      stdoutResult.status === "fulfilled" &&
      stderrResult.status === "fulfilled" &&
      (!stdoutResult.value.capped || stdoutResult.value.overflowFilePath !== undefined) &&
      (!stderrResult.value.capped || stderrResult.value.overflowFilePath !== undefined);
    const artifactUri =
      truncated && spillComplete
        ? await persistTrustedWorkflowOutput({
            artifacts: options.artifacts,
            outputConfig,
            context: options.context,
            toolCallId: options.toolCallId,
            stdout,
            stderr,
            stdoutOverflowPath: stdoutResult.value.overflowFilePath,
            stderrOverflowPath: stderrResult.value.overflowFilePath,
          })
        : undefined;

    let cleanupError: unknown;
    const pendingStop = (() => stopping)();
    if (pendingStop) {
      try {
        await pendingStop;
      } catch (error) {
        cleanupError = error;
      }
    }
    const executionError = cleanupError
      ? {
          type: "exception" as const,
          phase: "unknown" as const,
          message: `Trusted workflow bash cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        }
      : timedOut
        ? {
            type: "timeout" as const,
            timeoutMs: effectiveTimeoutMs,
            signal: "SIGTERM",
          }
        : aborted
          ? { type: "aborted" as const, signal: "SIGTERM" }
          : stdoutResult.status === "rejected"
            ? {
                type: "exception" as const,
                phase: "stdout" as const,
                message:
                  stdoutResult.reason instanceof Error
                    ? stdoutResult.reason.message
                    : String(stdoutResult.reason),
              }
            : stderrResult.status === "rejected"
              ? {
                  type: "exception" as const,
                  phase: "stderr" as const,
                  message:
                    stderrResult.reason instanceof Error
                      ? stderrResult.reason.message
                      : String(stderrResult.reason),
                }
              : exitResult.status === "rejected"
                ? {
                    type: "exception" as const,
                    phase: "unknown" as const,
                    message:
                      exitResult.reason instanceof Error
                        ? exitResult.reason.message
                        : String(exitResult.reason),
                  }
                : undefined;
    return withLimitedBashOutput(
      {
        stdout,
        stderr,
        exitCode: cleanupError ? -1 : exitCode,
        ...(executionError ? { executionError } : {}),
      },
      {
        maxOutputBytes: outputConfig.maxPreviewBytes,
        truncated,
        artifactUri,
        originalStdoutBytes:
          stdoutResult.status === "fulfilled" ? stdoutResult.value.totalBytes : 0,
        originalStderrBytes:
          stderrResult.status === "fulfilled" ? stderrResult.value.totalBytes : 0,
      },
    );
  } catch (error) {
    let cleanupError: unknown;
    if (child) {
      try {
        await runtime.stopUnit(unit);
      } catch (stopError) {
        cleanupError = stopError;
      }
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      executionError: {
        type: "exception",
        phase: child ? "unknown" : "spawn",
        message: cleanupError
          ? `Trusted workflow bash cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; original error: ${error instanceof Error ? error.message : String(error)}`
          : error instanceof Error
            ? error.message
            : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", abortListener);
    await Promise.all([
      supportRoot ? fs.rm(supportRoot, { recursive: true, force: true }) : undefined,
      fs.rm(overflowPaths.stdout, { force: true }),
      fs.rm(overflowPaths.stderr, { force: true }),
    ]);
  }
}
