import { expandTilde } from "@stanley2058/lilac-fs";
import {
  serverToolExitCode,
  type ServerToolFailure,
  type ServerToolJsonValue,
} from "@stanley2058/lilac-plugin-runtime";
import {
  createLogger,
  errorCode,
  formatTaggedErrorForLog,
  opaqueErrorMessage,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { posix as posixPath } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";

import {
  applyToolPositionals,
  parseToolBoolean as parseBooleanLike,
  toolFlagField as kebabToCamelCase,
} from "../tool-server/client-arguments";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type ToolClientJsonObject,
  type ToolClientJsonValue,
  toolCallPayloadSchema as nestedToolResponseSchema,
  toolOutputFullSchema,
} from "../tool-server/client-protocol";

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
import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { resolveRestrictedSessionTmpDir } from "../shared/attachment-utils";
import { parseSshCwdTarget } from "../ssh/ssh-cwd";
import {
  withLimitedBashOutput,
  type BashExecutionError,
  type BashToolInput,
  type BashToolOutput,
} from "./bash-impl";
import { sanitizeBashOutputText } from "./bash-output-sanitizer";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

const WORKSPACE_MOUNT = "/workspace";
const TMP_MOUNT = "/tmp";
export const RESTRICTED_BASH_WALL_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_RESTRICTED_FILE_READ_BYTES = 10 * 1024 * 1024;
const TOOL_SERVER_BACKEND_URL = process.env.TOOL_SERVER_BACKEND_URL || "http://localhost:8080";
const logger = createLogger({ module: "restricted-bash" });

class RestrictedBashOperationError extends TaggedError("RestrictedBashOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

class NestedToolsCommandFailure extends TaggedError("NestedToolsCommandFailure")<{
  readonly failure: ServerToolFailure;
  readonly message: string;
}> {}

async function captureRestrictedBashOperation<T>(params: {
  readonly operation: string;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, RestrictedBashOperationError>> {
  const captured = (
    await Result.tryPromise({ try: params.run, catch: captureRuntimeError })
  ).mapError((error) =>
    projectCapturedRuntimeError(error, `Opaque restricted Bash ${params.operation} failure`),
  );
  return captured.match<() => ResultType<T, RestrictedBashOperationError>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      const cause = preserveToolPanic(error);
      return Result.err(
        new RestrictedBashOperationError({
          operation: params.operation,
          cause,
          message: opaqueErrorMessage(cause, `Restricted Bash failed while ${params.operation}`),
        }),
      );
    },
  })();
}

function captureRestrictedBashSync<T>(params: {
  readonly operation: string;
  readonly run: () => Awaited<T>;
}): ResultType<T, RestrictedBashOperationError> {
  const captured = Result.try({ try: params.run, catch: captureRuntimeError }).mapError((error) =>
    projectCapturedRuntimeError(error, `Opaque restricted Bash ${params.operation} failure`),
  );
  return captured.match<() => ResultType<T, RestrictedBashOperationError>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      const cause = preserveToolPanic(error);
      return Result.err(
        new RestrictedBashOperationError({
          operation: params.operation,
          cause,
          message: opaqueErrorMessage(cause, `Restricted Bash failed while ${params.operation}`),
        }),
      );
    },
  })();
}

function signalRestrictedBashFailure(operation: string, message: string): never {
  return adaptToolResultToHost(
    Result.err(
      new RestrictedBashOperationError({
        operation,
        cause: new Error(message),
        message,
      }),
    ),
  );
}

async function captureRestrictedHostPromise<T>(
  run: () => Promise<T>,
): Promise<ResultType<T, Error | Panic>> {
  return (await Result.tryPromise({ try: run, catch: captureRuntimeError })).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Opaque restricted host operation failure"),
  );
}

function restrictedHostErrorCode(cause: Error): string | undefined {
  return errorCode(cause);
}

type RestrictedBashTermination = "wall_clock" | "aborted";
type RestrictedBashTerminationClassifier = () => RestrictedBashTermination | undefined;

function toRestrictedTerminationError(
  termination: RestrictedBashTermination | undefined,
  timeoutMs: number,
): BashExecutionError | undefined {
  switch (termination) {
    case "wall_clock":
      return {
        type: "timeout",
        code: "wall_clock_timeout",
        timeoutMs,
        timeoutKind: "wall_clock",
        signal: "ABORT",
      };
    case "aborted":
      return {
        type: "aborted",
        code: "execution_cancelled",
        signal: "ABORT",
      };
    case undefined:
      return undefined;
  }
}

type RestrictedBashContext = {
  requestId?: string;
  requestDeliveryId?: string;
  sessionId?: string;
  requestClient?: string;
  controlCapability?: string;
  currentTurnUserId?: string;
  toolCallId?: string;
  workspaceWritable?: boolean;
  subagentProfile?: "explore" | "general" | "self";
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

function normalizeVirtualPath(p: string): string {
  const prefixed = p.startsWith("/") ? p : `/${p}`;
  return posixPath.normalize(prefixed);
}

function accessDenied(pathName: string): Error {
  const err = new Error(`Access denied in restricted mode: ${pathName}`);
  return Object.assign(err, { code: "EACCES" });
}

class RestrictedReadFs implements IFileSystem {
  constructor(
    private readonly inner: IFileSystem,
    private readonly denyOutsideMount = false,
    private readonly hostRoot?: string,
  ) {}

  private async assertReadable(pathName: string): Promise<void> {
    if (this.denyOutsideMount && normalizeVirtualPath(pathName) !== "/") {
      signalRestrictedBashFailure("authorize_read", accessDenied(pathName).message);
    }
    if (!this.hostRoot) return;
    const virtual = normalizeVirtualPath(pathName);
    const relative = virtual.startsWith(`${WORKSPACE_MOUNT}/`)
      ? virtual.slice(WORKSPACE_MOUNT.length + 1)
      : virtual.slice(1);
    const candidate = path.resolve(this.hostRoot, relative);
    if (candidate !== this.hostRoot && !candidate.startsWith(`${this.hostRoot}${path.sep}`)) {
      signalRestrictedBashFailure("authorize_read", accessDenied(pathName).message);
    }
    const inspected = await captureRestrictedHostPromise(() => fs.lstat(candidate));
    const inspectError = inspected.match({ ok: () => null, err: (error) => error });
    if (inspectError) {
      const cause = preserveToolPanic(inspectError);
      if (restrictedHostErrorCode(cause) === "ENOENT") return;
      signalRestrictedBashFailure(
        "inspect_read_target",
        opaqueErrorMessage(cause, "Failed to inspect restricted read target"),
      );
    }
    const stat = inspected.match({ ok: (value) => value, err: () => null });
    if (stat?.isFile() && stat.nlink > 1) {
      signalRestrictedBashFailure("authorize_read", accessDenied(pathName).message);
    }
  }

  private async assertWritable(pathName: string): Promise<void> {
    if (this.denyOutsideMount || normalizeVirtualPath(pathName) === "/") {
      signalRestrictedBashFailure("authorize_write", accessDenied(pathName).message);
    }
    if (!this.hostRoot) return;
    const virtual = normalizeVirtualPath(pathName);
    const relative = virtual.startsWith(`${WORKSPACE_MOUNT}/`)
      ? virtual.slice(WORKSPACE_MOUNT.length + 1)
      : virtual.slice(1);
    const candidate = path.resolve(this.hostRoot, relative);
    if (candidate !== this.hostRoot && !candidate.startsWith(`${this.hostRoot}${path.sep}`)) {
      signalRestrictedBashFailure("authorize_write", accessDenied(pathName).message);
    }
    const inspected = await captureRestrictedHostPromise(() => fs.lstat(candidate));
    const inspectError = inspected.match({ ok: () => null, err: (error) => error });
    if (inspectError) {
      const cause = preserveToolPanic(inspectError);
      if (restrictedHostErrorCode(cause) === "ENOENT") return;
      signalRestrictedBashFailure(
        "inspect_write_target",
        opaqueErrorMessage(cause, "Failed to inspect restricted write target"),
      );
    }
    const stat = inspected.match({ ok: (value) => value, err: () => null });
    if (stat?.isFile() && stat.nlink > 1) {
      signalRestrictedBashFailure("authorize_write", accessDenied(pathName).message);
    }
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
    const readable = await captureRestrictedHostPromise(() => this.assertReadable(pathName));
    const readError = readable.match({ ok: () => null, err: (error) => error });
    if (readError) {
      const cause = preserveToolPanic(readError);
      const message = opaqueErrorMessage(cause, "Restricted path is unavailable");
      if (message.startsWith("Access denied in restricted mode:")) return false;
      signalRestrictedBashFailure("authorize_exists", message);
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
    return await this.inner.readdir(pathName);
  }

  async readdirWithFileTypes(pathName: string) {
    await this.assertReadable(pathName);
    const entries = await this.inner.readdirWithFileTypes?.(pathName);
    if (entries) return entries;
    return [];
  }

  async rm(pathName: string, options?: Parameters<IFileSystem["rm"]>[1]) {
    await this.assertWritable(pathName);
    return await this.inner.rm(pathName, options);
  }

  async cp(src: string, dest: string, options?: Parameters<IFileSystem["cp"]>[2]) {
    await this.assertReadable(src);
    await this.assertWritable(dest);
    return await this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string) {
    await this.assertWritable(src);
    await this.assertWritable(dest);
    return await this.inner.mv(src, dest);
  }

  resolvePath(base: string, pathName: string) {
    return this.inner.resolvePath(base, pathName);
  }

  getAllPaths() {
    if (this.denyOutsideMount) return [];
    return this.inner.getAllPaths();
  }

  async chmod(pathName: string, mode: number) {
    await this.assertWritable(pathName);
    return await this.inner.chmod(pathName, mode);
  }

  async symlink(target: string, linkPath: string) {
    await this.assertWritable(linkPath);
    signalRestrictedBashFailure("create_symlink", accessDenied(`${linkPath} -> ${target}`).message);
  }

  async link(existingPath: string, newPath: string) {
    await this.assertReadable(existingPath);
    await this.assertWritable(newPath);
    signalRestrictedBashFailure(
      "create_hard_link",
      accessDenied(`${newPath} -> ${existingPath}`).message,
    );
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

type NestedToolResponse = z.infer<typeof nestedToolResponseSchema>;
type NestedToolsOutputMode = "json" | "json-pretty";

function createNestedToolsFailure(params: {
  kind: ServerToolFailure["kind"];
  code: string;
  message: string;
  retryable: boolean;
  details?: ServerToolJsonValue;
}): ServerToolFailure {
  return {
    kind: params.kind,
    code: params.code,
    message: params.message,
    retryable: params.retryable,
    ...(params.details === undefined ? {} : { details: params.details }),
  };
}

function nestedToolsTerminationFailure(
  termination: RestrictedBashTermination | undefined,
  operation: string,
): ServerToolFailure | undefined {
  switch (termination) {
    case "wall_clock":
      return createNestedToolsFailure({
        kind: "timeout",
        code: "TOOL_SERVER_REQUEST_TIMEOUT",
        message: `${operation} timed out`,
        retryable: true,
      });
    case "aborted":
      return createNestedToolsFailure({
        kind: "cancelled",
        code: "TOOL_SERVER_REQUEST_CANCELLED",
        message: `${operation} was cancelled`,
        retryable: false,
      });
    case undefined:
      return undefined;
  }
}

function signalNestedToolsFailure(failure: ServerToolFailure): never {
  return adaptToolResultToHost(
    Result.err(new NestedToolsCommandFailure({ failure, message: failure.message })),
  );
}

function formatNestedToolsJson(
  value: ServerToolJsonValue,
  outputMode: NestedToolsOutputMode,
): string {
  return `${JSON.stringify(value, null, outputMode === "json-pretty" ? 2 : undefined)}\n`;
}

function nestedToolsFailureResult(
  failure: ServerToolFailure,
  outputMode: NestedToolsOutputMode,
): ExecResult {
  return {
    stdout: "",
    stderr: formatNestedToolsJson({ status: "error", error: failure }, outputMode),
    exitCode: serverToolExitCode[failure.kind],
  };
}

function signalNestedToolsInputFailure(code: string, message: string): never {
  return signalNestedToolsFailure(
    createNestedToolsFailure({
      kind: "usage",
      code,
      message,
      retryable: false,
    }),
  );
}

async function readJsonSource(source: string, ctx: CommandContext): Promise<ToolClientJsonValue> {
  if (source === "@-") {
    return adaptToolResultToHost(decodeRestrictedJson(decodeBytesToUtf8(ctx.stdin)));
  }
  if (source.startsWith("@")) {
    const rawPath = source.slice(1);
    const resolved = ctx.fs.resolvePath(ctx.cwd, rawPath);
    return adaptToolResultToHost(decodeRestrictedJson(await ctx.fs.readFile(resolved)));
  }
  return adaptToolResultToHost(decodeRestrictedJson(source));
}

function decodeRestrictedJson(
  source: string,
): ResultType<ToolClientJsonValue, NestedToolsCommandFailure> {
  const decoded = Result.try({
    try: () => jsonValueSchema.parse(JSON.parse(source)),
    catch: captureRuntimeError,
  }).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Opaque restricted Bash JSON parse failure"),
  );
  return decoded.match<() => ResultType<ToolClientJsonValue, NestedToolsCommandFailure>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      const cause = preserveToolPanic(error);
      return Result.err(
        new NestedToolsCommandFailure({
          failure: createNestedToolsFailure({
            kind: "usage",
            code: "INVALID_JSON",
            message: opaqueErrorMessage(cause, "Invalid JSON input"),
            retryable: false,
          }),
          message: opaqueErrorMessage(cause, "Invalid JSON input"),
        }),
      );
    },
  })();
}

function decodeNestedToolInput(
  value: unknown,
): ResultType<ToolClientJsonObject, NestedToolsCommandFailure> {
  const decoded = jsonObjectSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new NestedToolsCommandFailure({
      failure: createNestedToolsFailure({
        kind: "usage",
        code: "INVALID_TOOL_INPUT",
        message: "Tool input must be a JSON object",
        retryable: false,
      }),
      message: "Tool input must be a JSON object",
    }),
  );
}

function parseNestedToolsOutputOption(args: readonly string[]): {
  args: string[];
  outputMode: NestedToolsOutputMode;
} {
  const remaining: string[] = [];
  let outputMode: NestedToolsOutputMode = "json";
  let optionsEnded = false;
  for (const arg of args) {
    if (arg === "--") {
      optionsEnded = true;
      remaining.push(arg);
      continue;
    }
    if (optionsEnded || (arg !== "--output" && !arg.startsWith("--output="))) {
      remaining.push(arg);
      continue;
    }
    if (arg === "--output") {
      signalNestedToolsInputFailure(
        "MISSING_OUTPUT_MODE",
        "--output requires a value: --output=json|json-pretty",
      );
    }
    if (arg !== "--output=json" && arg !== "--output=json-pretty") {
      signalNestedToolsInputFailure(
        "INVALID_OUTPUT_MODE",
        `Invalid --output value '${arg.slice("--output=".length)}' (expected json|json-pretty)`,
      );
    }
    outputMode = arg === "--output=json-pretty" ? "json-pretty" : "json";
  }
  return { args: remaining, outputMode };
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
  if (context.requestDeliveryId) {
    headers["x-lilac-request-delivery-id"] = context.requestDeliveryId;
  }
  if (context.sessionId) headers["x-lilac-session-id"] = context.sessionId;
  if (context.requestClient) headers["x-lilac-request-client"] = context.requestClient;
  if (context.controlCapability) {
    headers["x-lilac-control-capability"] = context.controlCapability;
  }
  if (context.currentTurnUserId) {
    headers["x-lilac-current-turn-user-id"] = context.currentTurnUserId;
  }
  if (context.toolCallId) headers["x-lilac-tool-call-id"] = context.toolCallId;
  if (context.subagentProfile) headers["x-lilac-subagent-profile"] = context.subagentProfile;
  headers["x-lilac-cwd"] = cwd;
  return headers;
}

async function fetchNestedToolsJson(params: {
  url: string;
  operation: string;
  init: RequestInit;
  signal?: AbortSignal;
  classifyTermination: RestrictedBashTerminationClassifier;
}): Promise<ServerToolJsonValue> {
  const fetched = await captureRestrictedBashOperation({
    operation: params.operation,
    run: () => fetch(params.url, { ...params.init, signal: params.signal }),
  });
  const fetchError = fetched.match({ ok: () => null, err: (error) => error });
  if (fetchError) {
    const terminationFailure = nestedToolsTerminationFailure(
      params.classifyTermination(),
      params.operation,
    );
    if (terminationFailure) return signalNestedToolsFailure(terminationFailure);
    signalNestedToolsFailure(
      createNestedToolsFailure({
        kind: "unavailable",
        code: "TOOL_SERVER_NETWORK_ERROR",
        message: fetchError.message,
        retryable: true,
      }),
    );
  }
  const response = fetched.match({ ok: (value) => value, err: () => null });
  if (!response) {
    return signalNestedToolsFailure(
      createNestedToolsFailure({
        kind: "internal",
        code: "TOOL_SERVER_FETCH_INVARIANT",
        message: "Tool server request did not produce a response",
        retryable: false,
      }),
    );
  }
  const read = await captureRestrictedBashOperation({
    operation: `read_${params.operation}`,
    run: () => response.text(),
  });
  const readError = read.match({ ok: () => null, err: (error) => error });
  if (readError) {
    const terminationFailure = nestedToolsTerminationFailure(
      params.classifyTermination(),
      params.operation,
    );
    if (terminationFailure) return signalNestedToolsFailure(terminationFailure);
    return signalNestedToolsFailure(
      createNestedToolsFailure({
        kind: "unavailable",
        code: "TOOL_SERVER_RESPONSE_READ_ERROR",
        message: readError.message,
        retryable: true,
      }),
    );
  }
  const text = read.match({ ok: (value) => value, err: () => "" });
  if (!response.ok) {
    const status = response.status;
    let projection: Pick<ServerToolFailure, "kind" | "retryable"> = {
      kind: "internal",
      retryable: false,
    };
    switch (true) {
      case status === 400 || status === 422:
        projection = { kind: "usage", retryable: false };
        break;
      case status === 401 || status === 403:
        projection = { kind: "denied", retryable: false };
        break;
      case status === 404:
        projection = { kind: "not_found", retryable: false };
        break;
      case status === 408 || status === 504:
        projection = { kind: "timeout", retryable: true };
        break;
      case status === 409:
        projection = { kind: "conflict", retryable: false };
        break;
      case status === 429 || status >= 500:
        projection = { kind: "unavailable", retryable: true };
        break;
    }
    return signalNestedToolsFailure(
      createNestedToolsFailure({
        kind: projection.kind,
        code: "TOOL_SERVER_HTTP_ERROR",
        message: `Tool server returned HTTP ${status}`,
        retryable: projection.retryable,
        details: { status },
      }),
    );
  }
  let hasNonFiniteNumber = false;
  const parsed = Result.try({
    try: (): ServerToolJsonValue =>
      JSON.parse(text, (_key, value: ServerToolJsonValue) => {
        if (typeof value === "number" && !Number.isFinite(value)) {
          hasNonFiniteNumber = true;
          return null;
        }
        return value;
      }),
    catch: captureRuntimeError,
  }).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Tool server returned invalid JSON"),
  );
  const parseError = parsed.match({ ok: () => null, err: (error) => error });
  if (parseError) {
    return signalNestedToolsFailure(
      createNestedToolsFailure({
        kind: "internal",
        code: "TOOL_SERVER_INVALID_JSON",
        message: opaqueErrorMessage(parseError, "Tool server returned invalid JSON"),
        retryable: false,
      }),
    );
  }
  if (hasNonFiniteNumber) {
    return signalNestedToolsFailure(
      createNestedToolsFailure({
        kind: "internal",
        code: "TOOL_SERVER_INVALID_JSON",
        message: "Tool server returned invalid JSON",
        retryable: false,
      }),
    );
  }
  return parsed.match({ ok: (value) => value, err: () => null });
}

async function fetchNestedToolCallResponse(params: {
  url: string;
  operation: string;
  init: RequestInit;
  signal?: AbortSignal;
  classifyTermination: RestrictedBashTerminationClassifier;
}): Promise<NestedToolResponse> {
  const decoded = nestedToolResponseSchema.safeParse(await fetchNestedToolsJson(params));
  if (!decoded.success) {
    return signalNestedToolsFailure(
      createNestedToolsFailure({
        kind: "internal",
        code: "TOOL_SERVER_INVALID_RESPONSE",
        message: "Tool server response is invalid",
        retryable: false,
      }),
    );
  }
  return decoded.data;
}

async function fetchToolHelp(
  callableId: string,
  headers: Record<string, string>,
  classifyTermination: RestrictedBashTerminationClassifier,
  signal?: AbortSignal,
) {
  const value = await fetchNestedToolsJson({
    url: `${TOOL_SERVER_BACKEND_URL}/help/${encodeURIComponent(callableId)}`,
    operation: "fetch_tool_help",
    init: { headers },
    signal,
    classifyTermination,
  });
  const decoded = toolOutputFullSchema.safeParse(value);
  if (!decoded.success) {
    signalNestedToolsFailure(
      createNestedToolsFailure({
        kind: "internal",
        code: "TOOL_SERVER_INVALID_HELP",
        message: "Tool help response is invalid",
        retryable: false,
      }),
    );
  }
  return decoded.data;
}

async function buildNestedToolInput(params: {
  callableId: string;
  args: readonly string[];
  ctx: CommandContext;
  headers: Record<string, string>;
  signal?: AbortSignal;
  classifyTermination: RestrictedBashTerminationClassifier;
}): Promise<ToolClientJsonObject> {
  let input: ToolClientJsonObject = {};
  const positionals: string[] = [];
  const bareBooleanFlags: string[] = [];

  for (let i = 0; i < params.args.length; i++) {
    const arg = params.args[i] ?? "";
    if (arg === "--stdin" || arg.startsWith("--stdin=")) {
      const value = arg === "--stdin" ? true : parseBooleanLike(arg.slice("--stdin=".length));
      if (value === false) continue;
      input = adaptToolResultToHost(
        decodeNestedToolInput(
          adaptToolResultToHost(decodeRestrictedJson(decodeBytesToUtf8(params.ctx.stdin))),
        ),
      );
      continue;
    }
    if (arg === "--input") {
      signalNestedToolsInputFailure(
        "MISSING_TOOL_INPUT",
        "--input requires a value: --input=@file.json, --input=@-, or --input='<json>'",
      );
    }
    if (arg.startsWith("--input=")) {
      const value = arg.slice("--input=".length);
      input = adaptToolResultToHost(decodeNestedToolInput(await readJsonSource(value, params.ctx)));
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
        signalNestedToolsInputFailure(
          "MISSING_JSON_FLAG_VALUE",
          `--${field}:json requires a value`,
        );
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
    const help = await fetchToolHelp(
      params.callableId,
      params.headers,
      params.classifyTermination,
      params.signal,
    );
    const positionalInput = applyToolPositionals({
      callableId: params.callableId,
      input,
      positionals,
      primary: help.primaryPositional,
      bareBooleanField: bareBooleanFlags[0],
    });
    const positionalError = positionalInput.match({ ok: () => undefined, err: (error) => error });
    if (positionalError !== undefined) {
      return signalNestedToolsInputFailure(positionalError.code, positionalError.message);
    }
    return positionalInput.match({ ok: (value) => value, err: () => input });
  }

  return input;
}

function createToolsCommand(
  context: RestrictedBashContext,
  classifyTermination: RestrictedBashTerminationClassifier,
) {
  return defineCommand("tools", async (args, ctx): Promise<ExecResult> => {
    const headers = buildToolServerHeaders(context, ctx.cwd);
    const [first, ...rest] = args;
    let outputMode: NestedToolsOutputMode = "json";

    const runToolsCommand = async (): Promise<ExecResult> => {
      const parsedOptions = parseNestedToolsOutputOption(rest);
      outputMode = parsedOptions.outputMode;
      const commandArgs = parsedOptions.args;
      if (!first || first === "--list") {
        const value = await fetchNestedToolsJson({
          url: `${TOOL_SERVER_BACKEND_URL}/list`,
          operation: "list_tools",
          init: { headers },
          signal: ctx.signal,
          classifyTermination,
        });
        return { stdout: formatNestedToolsJson(value, outputMode), stderr: "", exitCode: 0 };
      }

      if (first === "--help") {
        const callableId = commandArgs[0];
        if (!callableId) {
          return {
            stdout: formatNestedToolsJson(
              "Usage: tools [--list] [--help <callableId>] <callableId> [args...]",
              outputMode,
            ),
            stderr: "",
            exitCode: 0,
          };
        }
        const help = await fetchToolHelp(callableId, headers, classifyTermination, ctx.signal);
        return { stdout: formatNestedToolsJson(help, outputMode), stderr: "", exitCode: 0 };
      }

      const callableId = first;
      const input = await buildNestedToolInput({
        callableId,
        args: commandArgs,
        ctx,
        headers,
        signal: ctx.signal,
        classifyTermination,
      });
      const response = await fetchNestedToolCallResponse({
        url: `${TOOL_SERVER_BACKEND_URL}/call`,
        operation: "call_tool",
        init: {
          method: "POST",
          headers,
          body: JSON.stringify({ callableId, input }),
        },
        signal: ctx.signal,
        classifyTermination,
      });
      if (response.status === "error") {
        return nestedToolsFailureResult(response.error, outputMode);
      }
      return {
        stdout: formatNestedToolsJson(response.value, outputMode),
        stderr: "",
        exitCode: 0,
      };
    };
    const executed = await captureRestrictedBashOperation({
      operation: "run_tools_command",
      run: runToolsCommand,
    });
    return executed.match({
      ok: (value) => value,
      err: (error) => {
        if (error.cause instanceof NestedToolsCommandFailure) {
          return nestedToolsFailureResult(error.cause.failure, outputMode);
        }
        const terminationFailure = nestedToolsTerminationFailure(
          classifyTermination(),
          "Tools command",
        );
        if (terminationFailure) {
          return nestedToolsFailureResult(terminationFailure, outputMode);
        }
        return nestedToolsFailureResult(
          createNestedToolsFailure({
            kind: "internal",
            code: "TOOLS_COMMAND_FAILED",
            message: error.message,
            retryable: false,
          }),
          outputMode,
        );
      },
    });
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
    signalRestrictedBashFailure("resolve_cwd", "Restricted bash does not allow SSH cwd targets");
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

  signalRestrictedBashFailure(
    "resolve_cwd",
    "Restricted bash cwd is outside the approved workspace and session temp roots",
  );
}

async function createRestrictedBash(params: {
  workspaceRoot: string;
  sessionTmpDir: string;
  context: RestrictedBashContext;
  classifyTermination: RestrictedBashTerminationClassifier;
}): Promise<Bash> {
  // Bun lazily creates FileHandle's FinalizationRegistry. Initialize it before
  // just-bash blocks that constructor during guest filesystem operations.
  await initializeRestrictedFileHandles();
  await fs.mkdir(params.sessionTmpDir, { recursive: true, mode: 0o700 });
  if (params.context.workspaceWritable) {
    const workspaceStats = await fs.lstat(params.workspaceRoot);
    if (
      workspaceStats.isSymbolicLink() ||
      !workspaceStats.isDirectory() ||
      (await fs.realpath(params.workspaceRoot)) !== params.workspaceRoot
    ) {
      signalRestrictedBashFailure(
        "create_runtime",
        "Restricted writable workspace must be a canonical real directory",
      );
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
      ...(params.context.currentTurnUserId
        ? { LILAC_CURRENT_TURN_USER_ID: params.context.currentTurnUserId }
        : {}),
    },
    customCommands: [createToolsCommand(params.context, params.classifyTermination)],
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

async function initializeRestrictedFileHandles(): Promise<void> {
  await using _handle = await fs.open(process.execPath, "r");
}

async function getRestrictedBash(params: {
  requestId?: string;
  workspaceRoot: string;
  sessionTmpDir: string;
  context: RestrictedBashContext;
  classifyTermination: RestrictedBashTerminationClassifier;
}): Promise<Bash> {
  const now = Date.now();
  pruneRestrictedBashCache(now);

  if (!params.requestId) {
    return await createRestrictedBash(params);
  }
  const cacheKey = JSON.stringify([
    params.context.sessionId ?? "",
    params.requestId,
    params.context.requestDeliveryId ?? "",
    params.workspaceRoot,
    params.context.toolCallId ?? "",
    params.context.currentTurnUserId ?? "",
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

  const resolvedCwd = captureRestrictedBashSync({
    operation: "resolve_cwd",
    run: () => resolveRestrictedCwd({ cwd, workspaceRoot, sessionTmpDir }),
  });
  const blockedCwd = resolvedCwd.match<BashToolOutput | null>({
    ok: () => null,
    err: (error) => ({
      stdout: "",
      stderr: error.message,
      exitCode: -1,
      executionError: {
        type: "blocked",
        code: "restricted_cwd",
        reason: error.message,
        hint: "Choose a cwd inside the approved workspace or the restricted session /tmp.",
      },
    }),
  });
  if (blockedCwd) return blockedCwd;
  const restrictedCwd = resolvedCwd.match({ ok: (value) => value, err: () => WORKSPACE_MOUNT });

  const wallClockTimeoutMs = Math.min(
    timeoutMs ?? RESTRICTED_BASH_WALL_TIMEOUT_MS,
    RESTRICTED_BASH_WALL_TIMEOUT_MS,
  );
  const controller = new AbortController();
  let termination: RestrictedBashTermination | undefined;
  const terminate = (reason: RestrictedBashTermination) => {
    if (termination) return;
    termination = reason;
    controller.abort();
  };
  const timeout = setTimeout(() => {
    terminate("wall_clock");
  }, wallClockTimeoutMs);
  timeout.unref?.();

  const abortListener = () => terminate("aborted");
  if (options.abortSignal) {
    if (options.abortSignal.aborted) abortListener();
    else options.abortSignal.addEventListener("abort", abortListener, { once: true });
  }
  const classifyTermination: RestrictedBashTerminationClassifier = () => termination;

  const runRestrictedExecution = async (): Promise<BashToolOutput> => {
    // just-bash temporarily locks down dynamic constructors while executing a script.
    // Initialize the Result adapter before entering that host-controlled section.
    await captureRestrictedBashOperation({
      operation: "initialize_result_adapter",
      run: () => Promise.resolve(),
    });
    const bash = await getRestrictedBash({
      requestId: context.requestId,
      workspaceRoot,
      sessionTmpDir,
      context,
      classifyTermination,
    });
    const result = await bash.exec(command, {
      cwd: restrictedCwd,
      replaceEnv: false,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", abortListener);
    const executionError = toRestrictedTerminationError(termination, wallClockTimeoutMs);
    const output: BashToolOutput = {
      stdout: sanitizeBashOutputText(result.stdout),
      stderr: sanitizeBashOutputText(result.stderr),
      exitCode: result.exitCode,
      ...(executionError ? { executionError } : {}),
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
      const artifacts = options.artifacts;
      const sessionId = context.sessionId;
      const requestId = context.requestId;
      const toolCallId = options.toolCallId;
      const created = await captureRestrictedBashOperation({
        operation: "persist_artifact",
        run: () =>
          artifacts.createFromStream({
            sessionId,
            requestId,
            toolCallId,
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
          }),
      });
      const createError = created.match({ ok: () => null, err: (error) => error });
      if (createError) {
        logger.warn("tool.artifact.write_failed", {
          toolName: "bash",
          ...formatTaggedErrorForLog(createError),
        });
      } else {
        const artifact = created.match({ ok: (value) => value, err: () => null });
        const artifactError = artifact?.match({ ok: () => null, err: (error) => error });
        if (artifactError) {
          logger.warn("tool.artifact.write_failed", {
            toolName: "bash",
            ...formatTaggedErrorForLog(artifactError),
          });
        } else {
          artifactUri = artifact?.match({ ok: (value) => value.uri, err: () => undefined });
        }
      }
    }
    return withLimitedBashOutput(output, {
      maxOutputBytes: outputConfig.maxPreviewBytes,
      truncated: isTruncated,
      artifactUri,
      originalStdoutBytes: Buffer.byteLength(output.stdout, "utf8"),
      originalStderrBytes: Buffer.byteLength(output.stderr, "utf8"),
    });
  };
  const executed = await captureRestrictedBashOperation({
    operation: "execute",
    run: runRestrictedExecution,
  }).finally(() => {
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", abortListener);
  });
  return executed.match<() => BashToolOutput>({
    err: (error) => () => {
      const executionError = toRestrictedTerminationError(termination, wallClockTimeoutMs) ?? {
        type: "exception" as const,
        code: "execution_failed" as const,
        phase: "unknown" as const,
        message: error.message,
      };
      return {
        stdout: "",
        stderr: error.message,
        exitCode: -1,
        executionError,
      };
    },
    ok: (value) => () => value,
  })();
}
