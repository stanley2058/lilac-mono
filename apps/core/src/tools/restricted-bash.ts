import fs from "node:fs/promises";
import path from "node:path";
import { posix as posixPath } from "node:path";

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

import type { BashToolInput, BashToolOutput } from "./bash-impl";
import { expandTilde } from "./fs/fs-impl";
import { parseSshCwdTarget } from "../ssh/ssh-cwd";

const WORKSPACE_MOUNT = "/workspace";
const TMP_MOUNT = "/tmp";
const RESTRICTED_TMP_ROOT = "/tmp/lilac-restricted";
const DEFAULT_RESTRICTED_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESTRICTED_OUTPUT_CHARS = 50 * 1024;
const MAX_RESTRICTED_FILE_READ_BYTES = 10 * 1024 * 1024;
const TOOL_SERVER_BACKEND_URL = process.env.TOOL_SERVER_BACKEND_URL || "http://localhost:8080";

type RestrictedBashContext = {
  requestId?: string;
  sessionId?: string;
  requestClient?: string;
};

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

function sanitizeSessionPathToken(value: string | undefined): string {
  const raw = value?.trim() || "unknown-session";
  return raw
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
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
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0) return false;

  if (parts.some((part) => part === ".ssh" || part === ".aws" || part === ".gnupg")) {
    return true;
  }

  if (parts[0] === ".git" && parts[1] === "config") return true;
  if (parts.some((part) => part === "core-config.yaml" || part === "core-config.yml")) {
    return true;
  }

  const leaf = parts[parts.length - 1] ?? "";
  if (leaf === ".env" || leaf.startsWith(".env.")) return true;

  return false;
}

function accessDenied(pathName: string): Error {
  const err = new Error(`Access denied in restricted mode: ${pathName}`);
  return Object.assign(err, { code: "EACCES" });
}

class RestrictedReadFs implements IFileSystem {
  constructor(private readonly inner: IFileSystem) {}

  private assertReadable(pathName: string): void {
    if (isDeniedWorkspacePath(pathName)) throw accessDenied(pathName);
  }

  private filterChild(parent: string, name: string): boolean {
    return !isDeniedWorkspacePath(posixPath.join(normalizeVirtualPath(parent), name));
  }

  async readFile(pathName: string, options?: Parameters<IFileSystem["readFile"]>[1]) {
    this.assertReadable(pathName);
    return await this.inner.readFile(pathName, options);
  }

  async readFileBytes(pathName: string) {
    this.assertReadable(pathName);
    if (this.inner.readFileBytes) return await this.inner.readFileBytes(pathName);
    const buffer = await this.inner.readFileBuffer(pathName);
    return unsafeBytesFromLatin1(Buffer.from(buffer).toString("latin1"));
  }

  async readFileBuffer(pathName: string) {
    this.assertReadable(pathName);
    return await this.inner.readFileBuffer(pathName);
  }

  async writeFile(
    pathName: string,
    content: Parameters<IFileSystem["writeFile"]>[1],
    options?: Parameters<IFileSystem["writeFile"]>[2],
  ) {
    return await this.inner.writeFile(pathName, content, options);
  }

  async appendFile(
    pathName: string,
    content: Parameters<IFileSystem["appendFile"]>[1],
    options?: Parameters<IFileSystem["appendFile"]>[2],
  ) {
    return await this.inner.appendFile(pathName, content, options);
  }

  async exists(pathName: string) {
    if (isDeniedWorkspacePath(pathName)) return false;
    return await this.inner.exists(pathName);
  }

  async stat(pathName: string): Promise<FsStat> {
    this.assertReadable(pathName);
    return await this.inner.stat(pathName);
  }

  async mkdir(pathName: string, options?: Parameters<IFileSystem["mkdir"]>[1]) {
    return await this.inner.mkdir(pathName, options);
  }

  async readdir(pathName: string) {
    this.assertReadable(pathName);
    const entries = await this.inner.readdir(pathName);
    return entries.filter((name) => this.filterChild(pathName, name));
  }

  async readdirWithFileTypes(pathName: string) {
    this.assertReadable(pathName);
    const entries = await this.inner.readdirWithFileTypes?.(pathName);
    if (entries) return entries.filter((entry) => this.filterChild(pathName, entry.name));
    return [];
  }

  async rm(pathName: string, options?: Parameters<IFileSystem["rm"]>[1]) {
    return await this.inner.rm(pathName, options);
  }

  async cp(src: string, dest: string, options?: Parameters<IFileSystem["cp"]>[2]) {
    this.assertReadable(src);
    return await this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string) {
    this.assertReadable(src);
    return await this.inner.mv(src, dest);
  }

  resolvePath(base: string, pathName: string) {
    return this.inner.resolvePath(base, pathName);
  }

  getAllPaths() {
    return this.inner.getAllPaths().filter((p) => !isDeniedWorkspacePath(p));
  }

  async chmod(pathName: string, mode: number) {
    return await this.inner.chmod(pathName, mode);
  }

  async symlink(target: string, linkPath: string) {
    return await this.inner.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string) {
    this.assertReadable(existingPath);
    return await this.inner.link(existingPath, newPath);
  }

  async readlink(pathName: string) {
    this.assertReadable(pathName);
    return await this.inner.readlink(pathName);
  }

  async lstat(pathName: string): Promise<FsStat> {
    this.assertReadable(pathName);
    return await this.inner.lstat(pathName);
  }

  async realpath(pathName: string) {
    this.assertReadable(pathName);
    return await this.inner.realpath(pathName);
  }

  async utimes(pathName: string, atime: Date, mtime: Date) {
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

function buildToolServerHeaders(context: RestrictedBashContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-lilac-safety-mode": "restricted",
  };
  if (context.requestId) headers["x-lilac-request-id"] = context.requestId;
  if (context.sessionId) headers["x-lilac-session-id"] = context.sessionId;
  if (context.requestClient) headers["x-lilac-request-client"] = context.requestClient;
  headers["x-lilac-cwd"] = WORKSPACE_MOUNT;
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

async function fetchToolHelp(callableId: string, headers: Record<string, string>) {
  const res = await fetch(`${TOOL_SERVER_BACKEND_URL}/help/${encodeURIComponent(callableId)}`, {
    headers,
  });
  if (!res.ok) throw new Error(await readHttpErrorMessage(res));
  return (await res.json()) as { primaryPositional?: { field: string } };
}

async function buildNestedToolInput(params: {
  callableId: string;
  args: readonly string[];
  ctx: CommandContext;
  headers: Record<string, string>;
}): Promise<Record<string, unknown>> {
  let input: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let i = 0; i < params.args.length; i++) {
    const arg = params.args[i] ?? "";
    if (arg === "--stdin") {
      input = JSON.parse(decodeBytesToUtf8(params.ctx.stdin)) as Record<string, unknown>;
      continue;
    }
    if (arg === "--input" || arg.startsWith("--input=")) {
      const value = arg === "--input" ? (params.args[++i] ?? "") : arg.slice("--input=".length);
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
    const rawValue = eq === -1 ? (params.args[++i] ?? "") : arg.slice(eq + 1);
    if (rawKey.length === 0) continue;

    const isJson = rawKey.endsWith(":json");
    const field = kebabToCamelCase(isJson ? rawKey.slice(0, -":json".length) : rawKey);
    if (isJson) {
      input[field] = await readJsonSource(rawValue, params.ctx);
      continue;
    }

    input[field] = parseBooleanLike(rawValue) ?? rawValue;
  }

  if (positionals.length > 0) {
    const help = await fetchToolHelp(params.callableId, params.headers);
    const field = help.primaryPositional?.field;
    if (!field) {
      throw new Error(`Tool '${params.callableId}' does not support positional input`);
    }
    if (positionals.length > 1) {
      throw new Error(`Tool '${params.callableId}' accepts at most one positional argument`);
    }
    input[field] = positionals[0] ?? "";
  }

  return input;
}

function createToolsCommand(context: RestrictedBashContext) {
  return defineCommand("tools", async (args, ctx): Promise<ExecResult> => {
    const headers = buildToolServerHeaders(context);
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

  return WORKSPACE_MOUNT;
}

async function createRestrictedBash(params: {
  workspaceRoot: string;
  sessionTmpDir: string;
  context: RestrictedBashContext;
}): Promise<Bash> {
  await fs.mkdir(params.sessionTmpDir, { recursive: true, mode: 0o700 });

  const workspaceFs = new RestrictedReadFs(
    new OverlayFs({
      root: params.workspaceRoot,
      mountPoint: "/",
      maxFileReadSize: MAX_RESTRICTED_FILE_READ_BYTES,
      allowSymlinks: false,
    }),
  );

  const tmpFs = new ReadWriteFs({
    root: params.sessionTmpDir,
    maxFileReadSize: MAX_RESTRICTED_FILE_READ_BYTES,
    allowSymlinks: false,
  });

  const mountable = new MountableFs({
    base: new InMemoryFs(),
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

  const cacheKey = params.requestId;
  if (!cacheKey) {
    return await createRestrictedBash(params);
  }

  const cached = restrictedBashByRequest.get(cacheKey);
  if (cached) {
    cached.lastAccess = now;
    return cached.bash;
  }

  const bash = await createRestrictedBash(params);
  restrictedBashByRequest.set(cacheKey, { bash, lastAccess: now });
  return bash;
}

function withLimitedOutput(output: BashToolOutput): BashToolOutput {
  const total = output.stdout.length + output.stderr.length;
  if (total <= MAX_RESTRICTED_OUTPUT_CHARS) return output;

  const stdout = output.stdout.slice(0, MAX_RESTRICTED_OUTPUT_CHARS);
  const stderr =
    stdout.length < MAX_RESTRICTED_OUTPUT_CHARS
      ? output.stderr.slice(0, MAX_RESTRICTED_OUTPUT_CHARS - stdout.length)
      : "";
  return {
    ...output,
    stdout,
    stderr,
    executionError: output.executionError ?? {
      type: "truncated",
      message: `Restricted bash output truncated: exceeded ${MAX_RESTRICTED_OUTPUT_CHARS.toLocaleString()} characters`,
    },
  };
}

export async function executeRestrictedBash(
  { command, cwd, timeoutMs, stdinMode }: BashToolInput,
  options: {
    workspaceRoot?: string;
    context?: RestrictedBashContext;
    abortSignal?: AbortSignal;
  } = {},
): Promise<BashToolOutput> {
  if (stdinMode === "eof") {
    // just-bash commands see empty stdin by default; keep accepting this compatibility flag.
  }

  const context = options.context ?? {};
  const workspaceRoot = path.resolve(expandTilde(options.workspaceRoot ?? process.cwd()));
  const sessionTmpDir = path.join(RESTRICTED_TMP_ROOT, sanitizeSessionPathToken(context.sessionId));

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
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
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
    return withLimitedOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: -1,
      executionError: aborted
        ? {
            type: "timeout",
            timeoutMs: effectiveTimeoutMs,
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
