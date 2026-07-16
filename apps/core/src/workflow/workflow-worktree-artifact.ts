import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { sha256 } from "./workflow-definition";

const GIT_PATH = "/usr/bin/git";
const WORKFLOW_WORKTREE_PATCH_PREFIX = "workflow-worktree-patch:";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40,64}$/u;
const GIT_STDERR_MAX_BYTES = 64 * 1024;
const GIT_INSPECTION_MAX_BYTES = 4 * 1024 * 1024;
const FILESYSTEM_INSPECTION_MAX_ENTRIES = 100_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const SAFE_GIT_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  XDG_CONFIG_HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_SSH_COMMAND: "/bin/false",
  http_proxy: "",
  https_proxy: "",
  all_proxy: "",
  no_proxy: "*",
} satisfies Record<string, string>;
const SAFE_GIT_CONFIG = [
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=/bin/false",
  "-c",
  "core.sshCommand=/bin/false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
  "-c",
  "interactive.diffFilter=",
  "-c",
  "protocol.allow=never",
  "-c",
  "submodule.recurse=false",
] as const;

export const WORKFLOW_WORKTREE_PATCH_MAX_BYTES = 64 * 1024 * 1024;
export const WORKFLOW_WORKTREE_PATCH_READ_MAX_BYTES = 64 * 1024;

export const workflowWorktreeOutputSchema = z
  .strictObject({
    runId: z.string().min(1),
    operationId: z.string().min(1),
    state: z.enum(["prepared", "captured", "cleaned", "quarantined"]),
    worktreePath: z.string().min(1),
    baseCommit: z.string().regex(GIT_OBJECT_PATTERN).nullable(),
    artifactId: z
      .string()
      .regex(/^workflow-worktree-patch:[a-f0-9]{64}$/u)
      .nullable(),
    patchSha256: z.string().regex(HASH_PATTERN).nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    cleanupError: z.string().nullable(),
    preparedAt: z.number().int().nonnegative(),
    capturedAt: z.number().int().nonnegative().nullable(),
    cleanedAt: z.number().int().nonnegative().nullable(),
  })
  .superRefine((value, context) => {
    if (value.state === "quarantined") {
      if (
        value.baseCommit !== null ||
        value.artifactId !== null ||
        value.patchSha256 !== null ||
        value.bytes !== null ||
        value.capturedAt !== null ||
        value.cleanedAt !== null ||
        !value.cleanupError
      ) {
        context.addIssue({ code: "custom", message: "Invalid quarantined worktree output" });
      }
      return;
    }
    if (value.baseCommit === null) {
      context.addIssue({ code: "custom", message: "Prepared worktree output requires a base" });
    }
    if (value.state === "prepared") {
      if (
        value.artifactId !== null ||
        value.patchSha256 !== null ||
        value.bytes !== null ||
        value.capturedAt !== null ||
        value.cleanedAt !== null
      ) {
        context.addIssue({ code: "custom", message: "Invalid prepared worktree output" });
      }
      return;
    }
    if (
      value.artifactId === null ||
      value.patchSha256 === null ||
      value.bytes === null ||
      value.capturedAt === null ||
      (value.state === "captured" && value.cleanedAt !== null) ||
      (value.state === "cleaned" && value.cleanedAt === null)
    ) {
      context.addIssue({ code: "custom", message: "Invalid captured worktree output" });
    }
  });

export type WorkflowWorktreeOutput = z.infer<typeof workflowWorktreeOutputSchema>;

export type PublicWorkflowWorktreeOutput = Omit<
  WorkflowWorktreeOutput,
  "worktreePath" | "cleanupError"
> & {
  reconciliationDetail: string | null;
};

export function publicWorkflowWorktreeOutput(
  output: WorkflowWorktreeOutput,
): PublicWorkflowWorktreeOutput {
  const { worktreePath: _worktreePath, cleanupError, ...visible } = output;
  return {
    ...visible,
    reconciliationDetail: cleanupError
      ? output.state === "quarantined"
        ? "Pre-dispatch base unavailable; preserved for manual reconciliation"
        : output.state === "prepared"
          ? "Patch capture failed or was interrupted; preserved for manual reconciliation"
          : "Durable patch captured; worktree cleanup will be retried"
      : null,
  };
}

export type CapturedWorkflowWorktreePatch = {
  artifactId: string;
  patchSha256: string;
  bytes: number;
};

type CaptureControl = {
  signal?: AbortSignal;
  deadline: number;
};

function artifactHash(artifactId: string): string {
  if (!artifactId.startsWith(WORKFLOW_WORKTREE_PATCH_PREFIX)) {
    throw new Error(`Unsupported workflow worktree patch artifact: ${artifactId}`);
  }
  const hash = artifactId.slice(WORKFLOW_WORKTREE_PATCH_PREFIX.length);
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`Invalid workflow worktree patch artifact: ${artifactId}`);
  }
  return hash;
}

function assertCaptureActive(control: CaptureControl): void {
  if (control.signal?.aborted) throw new Error("Workflow worktree patch capture was cancelled");
  if (Date.now() >= control.deadline) throw new Error("Workflow worktree patch capture timed out");
}

async function artifactRoot(dataDir: string): Promise<string> {
  const root = path.resolve(dataDir, "workflow-worktree-artifacts");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Workflow worktree artifact root must be a real directory");
  }
  return await fs.realpath(root);
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
  onLimit: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        onLimit();
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

async function runGit(input: {
  worktreePath: string;
  args: readonly string[];
  control: CaptureControl;
  stdoutMaxBytes?: number;
  allowedExitCodes?: readonly number[];
}): Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }> {
  assertCaptureActive(input.control);
  const process = Bun.spawn(
    [GIT_PATH, ...SAFE_GIT_CONFIG, "-C", input.worktreePath, ...input.args],
    {
      env: SAFE_GIT_ENV,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const abort = () => process.kill();
  input.control.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => {
      timedOut = true;
      process.kill();
    },
    Math.max(1, input.control.deadline - Date.now()),
  );
  timer.unref?.();
  try {
    const [stdout, stderrBytes, exitCode] = await Promise.all([
      readBounded(
        process.stdout,
        input.stdoutMaxBytes ?? GIT_INSPECTION_MAX_BYTES,
        "Git capture output",
        abort,
      ),
      readBounded(process.stderr, GIT_STDERR_MAX_BYTES, "Git capture stderr", abort),
      process.exited,
    ]);
    if (input.control.signal?.aborted) {
      throw new Error("Workflow worktree patch capture was cancelled");
    }
    if (timedOut) throw new Error("Workflow worktree patch capture timed out");
    const allowed = input.allowedExitCodes ?? [0];
    const stderr = Buffer.from(stderrBytes).toString("utf8");
    if (!allowed.includes(exitCode)) {
      throw new Error(`Git worktree patch command failed: ${stderr.trim() || `exit ${exitCode}`}`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
    input.control.signal?.removeEventListener("abort", abort);
  }
}

function inspectStatus(status: Uint8Array): void {
  const records = Buffer.from(status).toString("utf8").split("\0").filter(Boolean);
  for (const record of records) {
    if (record.startsWith("! ")) {
      throw new Error(`Ignored worktree content is not patch-captured: ${record.slice(2)}`);
    }
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const submodule = record.split(" ", 4)[2];
      if (submodule?.startsWith("S") && submodule !== "S...") {
        throw new Error("Dirty or moved submodule content is not patch-captured");
      }
    }
  }
}

function parseSubmodulePaths(staged: Uint8Array): Set<string> {
  const paths = new Set<string>();
  for (const record of Buffer.from(staged).toString("utf8").split("\0")) {
    if (!record.startsWith("160000 ")) continue;
    const separator = record.indexOf("\t");
    if (separator >= 0) paths.add(record.slice(separator + 1));
  }
  return paths;
}

async function assertNoNestedRepositories(input: {
  worktreePath: string;
  submodulePaths: ReadonlySet<string>;
  control: CaptureControl;
}): Promise<void> {
  let entries = 0;
  const inspect = async (directory: string, relativeDirectory: string): Promise<void> => {
    assertCaptureActive(input.control);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > FILESYSTEM_INSPECTION_MAX_ENTRIES) {
        throw new Error(
          `Workflow worktree inspection exceeds ${FILESYSTEM_INSPECTION_MAX_ENTRIES} entries`,
        );
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.name === ".git") {
        if (relativeDirectory === "") continue;
        if (input.submodulePaths.has(relativeDirectory)) continue;
        throw new Error(`Embedded repository content is not patch-captured: ${relativeDirectory}`);
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (input.submodulePaths.has(relative)) continue;
      await inspect(path.join(directory, entry.name), relative);
    }
  };
  await inspect(input.worktreePath, "");
}

async function inspectWorktree(input: {
  worktreePath: string;
  control: CaptureControl;
}): Promise<void> {
  const configuredFilters = await runGit({
    worktreePath: input.worktreePath,
    args: [
      "config",
      "--includes",
      "--local",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process)$",
    ],
    control: input.control,
    allowedExitCodes: [0, 1],
  });
  if (configuredFilters.exitCode === 0 && configuredFilters.stdout.byteLength > 0) {
    throw new Error("Repository-configured clean/smudge filters are not allowed during capture");
  }
  const [status, staged] = await Promise.all([
    runGit({
      worktreePath: input.worktreePath,
      args: [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
        "-z",
      ],
      control: input.control,
    }),
    runGit({
      worktreePath: input.worktreePath,
      args: ["ls-files", "--stage", "-z"],
      control: input.control,
    }),
  ]);
  inspectStatus(status.stdout);
  await assertNoNestedRepositories({
    worktreePath: input.worktreePath,
    submodulePaths: parseSubmodulePaths(staged.stdout),
    control: input.control,
  });
}

async function syncPublishedArtifact(filePath: string, root: string): Promise<void> {
  const file = await fs.open(filePath, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await fs.open(root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeWorkflowWorktreePatchArtifact(input: {
  dataDir: string;
  patch: Uint8Array;
}): Promise<CapturedWorkflowWorktreePatch> {
  if (input.patch.byteLength > WORKFLOW_WORKTREE_PATCH_MAX_BYTES) {
    throw new Error(`Workflow worktree patch exceeds ${WORKFLOW_WORKTREE_PATCH_MAX_BYTES} bytes`);
  }
  const patchSha256 = sha256(input.patch);
  const artifactId = `${WORKFLOW_WORKTREE_PATCH_PREFIX}${patchSha256}`;
  const root = await artifactRoot(input.dataDir);
  const artifactPath = path.join(root, `${patchSha256}.patch`);
  const existing = await fs.lstat(artifactPath).catch(() => null);
  if (existing) {
    if (
      existing.isSymbolicLink() ||
      !existing.isFile() ||
      existing.size !== input.patch.byteLength
    ) {
      throw new Error(`Invalid workflow worktree patch artifact: ${artifactId}`);
    }
    const stored = await fs.readFile(artifactPath);
    if (sha256(stored) !== patchSha256) {
      throw new Error(`Workflow worktree patch artifact hash mismatch: ${artifactId}`);
    }
    await syncPublishedArtifact(artifactPath, root);
    return { artifactId, patchSha256, bytes: input.patch.byteLength };
  }

  const temporaryPath = path.join(root, `.${patchSha256}.${crypto.randomUUID()}.tmp`);
  let temporary: fs.FileHandle | null = null;
  try {
    temporary = await fs.open(temporaryPath, "wx", 0o600);
    await temporary.writeFile(input.patch);
    await temporary.sync();
    await temporary.close();
    temporary = null;
    await fs.rename(temporaryPath, artifactPath);
    await syncPublishedArtifact(artifactPath, root);
  } catch (error) {
    await temporary?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { artifactId, patchSha256, bytes: input.patch.byteLength };
}

export async function captureWorkflowWorktreePatch(input: {
  dataDir: string;
  worktreePath: string;
  baseCommit: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CapturedWorkflowWorktreePatch> {
  if (!GIT_OBJECT_PATTERN.test(input.baseCommit)) {
    throw new Error(`Invalid workflow worktree base commit: ${input.baseCommit}`);
  }
  const control = {
    signal: input.signal,
    deadline: Date.now() + (input.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS),
  };
  await runGit({
    worktreePath: input.worktreePath,
    args: ["cat-file", "-e", `${input.baseCommit}^{commit}`],
    control,
  });
  await inspectWorktree({ worktreePath: input.worktreePath, control });
  await runGit({
    worktreePath: input.worktreePath,
    args: ["add", "-A", "--", "."],
    control,
  });
  await inspectWorktree({ worktreePath: input.worktreePath, control });
  const { stdout: patch } = await runGit({
    worktreePath: input.worktreePath,
    args: [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      input.baseCommit,
      "--",
    ],
    control,
    stdoutMaxBytes: WORKFLOW_WORKTREE_PATCH_MAX_BYTES,
  });
  assertCaptureActive(control);
  const artifact = await writeWorkflowWorktreePatchArtifact({ dataDir: input.dataDir, patch });
  assertCaptureActive(control);
  return artifact;
}

export async function readWorkflowWorktreePatch(input: {
  dataDir: string;
  artifactId: string;
  expectedBytes?: number;
}): Promise<Uint8Array> {
  const hash = artifactHash(input.artifactId);
  try {
    const root = await artifactRoot(input.dataDir);
    const artifactPath = path.join(root, `${hash}.patch`);
    const stats = await fs.lstat(artifactPath);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size > WORKFLOW_WORKTREE_PATCH_MAX_BYTES ||
      (input.expectedBytes !== undefined && stats.size !== input.expectedBytes)
    ) {
      throw new Error(`Invalid workflow worktree patch artifact: ${input.artifactId}`);
    }
    const canonical = await fs.realpath(artifactPath);
    if (path.dirname(canonical) !== root) {
      throw new Error(`Workflow worktree patch artifact escapes its root: ${input.artifactId}`);
    }
    const patch = await fs.readFile(canonical);
    if (sha256(patch) !== hash) {
      throw new Error(`Workflow worktree patch artifact hash mismatch: ${input.artifactId}`);
    }
    return patch;
  } catch (error) {
    if (error instanceof Error && error.message.includes(input.artifactId)) throw error;
    throw new Error(`Workflow worktree patch artifact is unavailable: ${input.artifactId}`, {
      cause: error,
    });
  }
}
