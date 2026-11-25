import { Buffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ModelMessage } from "ai";
import { Result } from "better-result";

import type { AiErrorLogDetails } from "./ai-error";
import { getBuildInfo } from "./build-info";
import { findWorkspaceRootResult } from "./find-root";
import {
  buildTranscriptShapeSnapshot,
  DEFAULT_BUILTIN_TOOL_NAMES,
  type TranscriptShapeProvenance,
  type TranscriptShapeSnapshot,
  type TranscriptShapeTarget,
} from "./transcript-shape";

export const TELEMETRY_PROXY_ENDPOINT = "https://t.lilac.stw.tw/batch/";

export type TelemetryLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type TelemetryPrimitive = string | number | boolean;

export type TelemetryLogFields = Readonly<Record<string, TelemetryPrimitive | null | undefined>>;

export type TelemetryLogObservation = {
  readonly level: TelemetryLogLevel;
  readonly module?: string;
  readonly message: string;
  readonly fields?: TelemetryLogFields;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly errorCode?: string;
  readonly errorStack?: string;
};

export type TelemetryBreadcrumb = {
  readonly ts: number;
  readonly deltaMs?: number;
  readonly level: TelemetryLogLevel;
  readonly module?: string;
  readonly event: string;
  readonly requestHash?: string;
  readonly sessionHash?: string;
  readonly runHash?: string;
  readonly toolCallHash?: string;
  readonly fields?: Readonly<Record<string, TelemetryPrimitive>>;
};

export type TelemetryEnvSnapshot = {
  readonly version: string;
  readonly commit: string;
  readonly dirty?: boolean;
  readonly os: string;
  readonly arch: string;
  readonly bunVersion: string;
  readonly docker: boolean;
  readonly surfaces?: readonly string[];
  readonly blobBackend?: "local" | "s3";
};

export type TelemetryConfigureInput = {
  readonly errors: boolean;
  readonly usage: boolean;
  readonly dataDir: string;
  readonly disabled?: boolean;
  readonly envSnapshot?: Partial<TelemetryEnvSnapshot>;
  readonly postErrorWindowMs?: number;
  readonly dedupeWindowMs?: number;
  readonly maxErrorsPerMinute?: number;
};

export type TelemetryErrorCaptureInput = {
  readonly module: string;
  readonly event: string;
  readonly level?: "error" | "fatal";
  readonly errorTag?: string;
  readonly errorName?: string;
  readonly errorCode?: string;
  readonly errorStack?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly provider?: string;
  readonly transport?: string;
  readonly surface?: string;
  readonly durationMs?: number;
  readonly aiError?: AiErrorLogDetails;
  readonly rawErrorMessage?: string;
  readonly transcriptContext?: {
    readonly messages: readonly ModelMessage[];
    readonly preProjectionMessages?: readonly ModelMessage[];
    readonly target?: TranscriptShapeTarget;
    readonly provenance?: TranscriptShapeProvenance;
  };
};

export type TelemetryAgentRunInput = {
  readonly status: "resolved" | "cancelled" | "failed";
  readonly surface: string;
  readonly isSubagent: boolean;
  readonly isWorkflow: boolean;
  readonly isHeartbeat: boolean;
  readonly provider?: string;
  readonly modelId?: string;
  readonly modelSpec?: string;
  readonly transport?: string;
  readonly didSwitchModel?: boolean;
  readonly durationMs: number;
  readonly ttftMs?: number | null;
  readonly turns?: number;
  readonly toolCallCount?: number;
  readonly compacted?: boolean;
  readonly transcriptMessageCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly noCacheTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly textTokens?: number;
  readonly reasoningTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly errorTag?: string;
  readonly statusCode?: number;
};

type PostHogEventName = "lilac_error" | "lilac_agent_run";

type PostHogEvent = {
  readonly event: PostHogEventName;
  readonly distinct_id: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, object | TelemetryPrimitive | null | undefined>>;
};

type SerializedPostHogEvent = {
  readonly event: PostHogEvent;
  readonly bytes: number;
};

type PendingErrorCapture = {
  readonly fingerprint: string;
  readonly capturedAtMs: number;
  readonly level: "error" | "fatal";
  readonly module: string;
  readonly event: string;
  readonly requestHash?: string;
  readonly sessionHash?: string;
  readonly runHash?: string;
  readonly errorTag?: string;
  readonly errorName?: string;
  readonly errorCode?: string;
  readonly stackFrames?: readonly string[];
  readonly fields: Record<string, TelemetryPrimitive>;
  readonly transcriptShape?: TranscriptShapeSnapshot;
  readonly preBreadcrumbs: readonly TelemetryBreadcrumb[];
  readonly postBreadcrumbs: TelemetryBreadcrumb[];
  timer: ReturnType<typeof setTimeout> | null;
};

export type TelemetryDiagnostics = {
  readonly errorsEnabled: boolean;
  readonly usageEnabled: boolean;
  readonly pendingEvents: number;
  readonly sentBatches: number;
  readonly failedBatches: number;
  readonly droppedEvents: number;
  readonly suppressedDuplicates: number;
  readonly rateLimitedErrors: number;
};

const MAX_GLOBAL_BREADCRUMBS = 80;
const MAX_REQUEST_BREADCRUMBS = 40;
const MAX_TRACKED_REQUEST_BUCKETS = 64;
const MAX_POST_BREADCRUMBS = 20;
const MAX_QUEUE_EVENTS = 200;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_EVENTS = 20;
const MAX_BATCH_BYTES = 200 * 1024;
const MAX_SINGLE_EVENT_BYTES = 180 * 1024;
const MAX_RECENT_FINGERPRINTS = 256;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_POST_ERROR_WINDOW_MS = 2_000;
const DEFAULT_DEDUPE_WINDOW_MS = 60_000;
const DEFAULT_MAX_ERRORS_PER_MINUTE = 12;
const MAX_STACK_FRAMES = 15;
const SALT_FILENAME = "telemetry-salt";
const SALT_HEX_RE = /^[a-f0-9]{64}$/u;
const SAFE_MODULE_RE = /^[a-z0-9:._-]{1,64}$/u;

// Closed allowlist of known static Core log messages that may appear verbatim as telemetry event IDs.
const ALLOWED_STATIC_EVENTS: ReadonlySet<string> = new Set([
  "agent run resolved",
  "agent run failed",
  "agent runner background operation failed",
  "agent.queue.transition",
  "request queued behind active run",
  "queued request cancelled",
  "requeueing a control the ended run did not consume",
  "sent a missed automatic subagent steer as a follow-up",
  "could not send a missed automatic subagent steer as a follow-up",
  "tool finished",
  "auto-compaction start",
  "auto-compaction end",
  "auto-compaction overflow recovery retry",
  "auto-compaction overflow recovery exhausted",
  "auto-compaction capability unknown; disabling threshold compaction",
  "Anthropic thinking prefix mismatch; retrying without retained thinking",
  "skipping claude-code model fallback for native agent run",
  "model stream warnings",
  "core-config hot-reload validation succeeded",
  "core-config hot-reload validation recovered",
  "core-config hot-reload validation failed",
  "core-config reload recovered",
  "native output prevented request terminalization",
  "failed to persist heartbeat handoff transcripts",
  "failed to persist heartbeat handoff transcripts after error",
  "heartbeat handoff transcript count mismatch",
  "agent activity publish failed",
  "subagent conversation ids unavailable",
]);

// Closed allowlist of known JS, AI SDK, and Lilac error/TaggedError identifiers.
const ALLOWED_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "Panic",
  "SQLiteError",
  "AI_APICallError",
  "AI_RetryError",
  "AI_InvalidArgumentError",
  "AI_InvalidToolInputError",
  "AI_NoSuchToolError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
  "AI_DownloadError",
  "AI_LoadAPIKeyError",
  "AI_NoContentGeneratedError",
  "AgentAdapterFailure",
  "AgentIdleTimeoutError",
  "AgentExternalHostFailed",
  "TurnAbortedError",
  "ToolBatchExecutionFailed",
  "BusAgentRunnerOperationFailed",
  "BusAgentRunnerIntakeFailed",
  "BusAgentRunnerRequestHeadersInvalid",
  "BusAgentRunnerQueueAttemptRouteInvalid",
  "BusAgentRunnerRecoveryStopped",
  "BusAgentRunnerAuthenticationProjectionInvalid",
  "CoreRuntimeCreateFailed",
  "CoreRuntimeExternalFailure",
  "CoreConfigYamlInvalid",
  "CoreConfigV1Invalid",
  "CoreConfigV2Invalid",
  "CoreConfigV3Invalid",
  "CoreConfigMustBeObject",
  "CoreConfigVersionInvalid",
  "AgentProviderOptionsInvalid",
  "ModelResolutionFailed",
  "EventDeliveryStopped",
  "DiscordRequestDeliveryFailed",
  "DiscordContextReportFailed",
  "ConversationThreadOperationFailed",
  "ConversationThreadSummarizationRuntimeError",
  "ConversationThreadSummarizationTransportError",
  "AttachmentOutputLifecycleError",
  "AgentRunJournalMigrationFailure",
  "OpenObserveTimeout",
  "OpenObserveRequestFailed",
  "OpenObserveHttpFailed",
  "ProviderError",
]);

// Closed allowlist of known POSIX, SQLite, network, tool, and provider error codes.
const ALLOWED_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "ENOSPC",
  "EMFILE",
  "EPIPE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ERR_INVALID_ARG_TYPE",
  "ERR_STREAM_DESTROYED",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CONSTRAINT",
  "SQLITE_CORRUPT",
  "SQLITE_FULL",
  "SQLITE_READONLY",
  "SQLITE_IOERR",
  "SQLITE_CANTOPEN",
  "invalid_request_error",
  "invalid_argument",
  "invalid_prompt",
  "invalid_value",
  "invalid_type",
  "invalid_function_parameters",
  "missing_required_parameter",
  "previous_response_not_found",
  "model_not_found",
  "context_length_exceeded",
  "rate_limit_exceeded",
  "insufficient_quota",
  "overloaded_error",
  "server_error",
  "response_error",
  "response_failed",
  "stream_error",
  "nonzero_exit",
  "invalid_result",
  "host_execution_error",
  "spawn_cwd_missing",
]);

const ALLOWED_SCALAR_KEYS: ReadonlySet<string> = new Set([
  "ok",
  "statusCode",
  "durationMs",
  "elapsedMs",
  "attempt",
  "retryAttempts",
  "retryable",
  "isRetryable",
  "exitCode",
  "deferredAccepted",
  "turns",
  "turn",
  "step",
  "queueDepth",
  "messageCount",
  "transcriptMessageCount",
  "transcriptHasCompactionCheckpoint",
  "compacted",
  "didSwitchModel",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "ttftMs",
  "parserVersion",
  "droppedOrphanToolResults",
  "toolCallCount",
  "activeCount",
  "pendingCount",
  "failedBatches",
  "droppedRecords",
]);

const ALLOWED_SURFACES: ReadonlySet<string> = new Set([
  "discord",
  "native",
  "github",
  "heartbeat",
  "unknown",
]);

const ALLOWED_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "codex",
  "google",
  "vertex",
  "openrouter",
  "vercel",
  "gateway",
  "xai",
  "groq",
  "cerebras",
  "openai-compatible",
  "typesafe",
  "claude-code",
  "azure",
  "custom",
]);

const ALLOWED_TRANSPORTS: ReadonlySet<string> = new Set([
  "ai-sdk",
  "openai-responses",
  "claude-code",
  "sse",
  "websocket",
  "auto",
]);

const ALLOWED_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "soft",
  "hard",
  "idle-timeout",
  "pre-agent-cancelled",
  "shutdown-draining",
  "other",
]);

const ALLOWED_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "policy",
  "timeout",
  "cancelled",
  "environment",
  "tool",
  "unknown",
]);

const ALLOWED_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);

const ALLOWED_COST_STATUSES: ReadonlySet<string> = new Set(["estimated", "unavailable"]);

const ALLOWED_PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  "invalid_request_error",
  "invalid_argument",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "api_error",
  "overloaded_error",
  "server_error",
  "timeout_error",
  "response_error",
  "response_failed",
  "stream_error",
  "previous_response_not_found",
]);

const ID_KEY_TO_DOMAIN: Readonly<Record<string, "request" | "session" | "run" | "toolCall">> = {
  requestId: "request",
  request_id: "request",
  sessionId: "session",
  session_id: "session",
  runId: "run",
  workflowRunId: "run",
  workflowId: "run",
  toolCallId: "toolCall",
  tool_call_id: "toolCall",
};

const verifiedRepoFileCache = new Map<string, boolean>();
let cachedWorkspaceRoot: string | null | undefined;

function getWorkspaceRootCached(): string | null {
  if (cachedWorkspaceRoot !== undefined) return cachedWorkspaceRoot;
  cachedWorkspaceRoot = findWorkspaceRootResult(process.cwd()).match({
    ok: (root) => root,
    err: () => null,
  });
  return cachedWorkspaceRoot;
}

function hasDotOrEmptySegments(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((seg) => seg.length === 0 || seg === "." || seg === "..");
}

function isAllowedCanonicalRelPath(rel: string): boolean {
  if (hasDotOrEmptySegments(rel)) return false;
  return rel.startsWith("apps/") || rel.startsWith("packages/") || rel.startsWith("node_modules/");
}

function isVerifiedWorkspaceFile(relativePath: string): boolean {
  if (!isAllowedCanonicalRelPath(relativePath)) return false;
  const cached = verifiedRepoFileCache.get(relativePath);
  if (cached !== undefined) return cached;
  const root = getWorkspaceRootCached();
  if (!root) return false;
  const resolved = path.resolve(root, relativePath);
  const canonicalRel = path.relative(root, resolved).replace(/\\/gu, "/");
  if (canonicalRel !== relativePath || !isAllowedCanonicalRelPath(canonicalRel)) return false;
  const exists = Result.try({
    try: () => fs.statSync(resolved).isFile(),
    catch: () => false,
  }).match({ ok: (v) => v, err: () => false });
  if (verifiedRepoFileCache.size < 512) verifiedRepoFileCache.set(relativePath, exists);
  return exists;
}

function sameWorkspaceRealpath(root: string, relA: string, relB: string): boolean {
  return Result.try({
    try: () =>
      fs.realpathSync(path.resolve(root, relA)) === fs.realpathSync(path.resolve(root, relB)),
    catch: () => false,
  }).match({ ok: (v) => v, err: () => false });
}

function isTestProcess(): boolean {
  const env = process.env;
  if (env.NODE_ENV === "test") return true;
  if (env.BUN_ENV === "test") return true;
  if (env.BUN_TEST === "1" || env.BUN_TEST === "true") return true;
  if (typeof env.VITEST === "string") return true;
  if (typeof env.JEST_WORKER_ID === "string") return true;
  return "describe" in globalThis && "it" in globalThis;
}

function detectDocker(): boolean {
  return Result.try({
    try: () => fs.existsSync("/.dockerenv"),
    catch: () => false,
  }).match({ ok: (exists) => exists, err: () => false });
}

function defaultEnvSnapshot(): TelemetryEnvSnapshot {
  const build = getBuildInfo();
  return {
    version: build.version,
    commit: build.commit,
    ...(build.dirty !== undefined ? { dirty: build.dirty } : {}),
    os: process.platform,
    arch: process.arch,
    bunVersion: typeof Bun !== "undefined" ? Bun.version : (process.versions.node ?? "unknown"),
    docker: detectDocker(),
  };
}

function sanitizeModuleName(moduleName: string | undefined): string | undefined {
  if (!moduleName) return undefined;
  return SAFE_MODULE_RE.test(moduleName) ? moduleName : "other";
}

function sanitizeEventName(rawEvent: string, level: TelemetryLogLevel): string {
  if (ALLOWED_STATIC_EVENTS.has(rawEvent)) return rawEvent;
  if (level === "fatal") return "log_fatal";
  if (level === "error") return "log_error";
  if (level === "warn") return "log_warn";
  return "log";
}

function sanitizeErrorIdentifier(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return ALLOWED_ERROR_IDENTIFIERS.has(raw) ? raw : "Error";
}

function sanitizeErrorCode(raw: string | number | undefined): string | number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (!raw) return undefined;
  return ALLOWED_ERROR_CODES.has(raw) ? raw : "unknown";
}

function sanitizeSurface(raw: string | undefined): string {
  if (!raw) return "unknown";
  return ALLOWED_SURFACES.has(raw) ? raw : "unknown";
}

function sanitizeProvider(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return ALLOWED_PROVIDERS.has(raw) ? raw : "custom";
}

function sanitizeTransport(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return ALLOWED_TRANSPORTS.has(raw) ? raw : undefined;
}

function sanitizeProviderErrorType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  return ALLOWED_PROVIDER_ERROR_TYPES.has(lower) ? lower : "other";
}

function projectAllowedStringField(key: string, rawValue: string): string | undefined {
  switch (key) {
    case "client":
    case "requestClient":
    case "surface":
      return sanitizeSurface(rawValue);
    case "provider":
      return sanitizeProvider(rawValue);
    case "transport":
      return sanitizeTransport(rawValue);
    case "failureKind":
      return ALLOWED_FAILURE_KINDS.has(rawValue) ? rawValue : undefined;
    case "failureClass":
      return ALLOWED_FAILURE_CLASSES.has(rawValue) ? rawValue : undefined;
    case "failureCode":
    case "code":
    case "errno":
    case "syscall":
    case "providerCode": {
      const safe = sanitizeErrorCode(rawValue);
      return typeof safe === "string" ? safe : undefined;
    }
    case "finishReason":
      return ALLOWED_FINISH_REASONS.has(rawValue) ? rawValue : undefined;
    case "costEstimateStatus":
      return ALLOWED_COST_STATUSES.has(rawValue) ? rawValue : undefined;
    case "providerType":
      return sanitizeProviderErrorType(rawValue);
    case "errorTag":
    case "aiErrorName":
      return sanitizeErrorIdentifier(rawValue);
    default:
      return undefined;
  }
}

function readValidSaltFile(saltPath: string): string | null {
  const outcome = Result.try({
    try: () => {
      if (!fs.existsSync(saltPath)) return null;
      const raw = fs.readFileSync(saltPath, "utf8").trim().toLowerCase();
      return SALT_HEX_RE.test(raw) ? raw : null;
    },
    catch: () => null,
  });
  return outcome.match({ ok: (value) => value, err: () => null });
}

function loadOrCreateSalt(dataDir: string): string | null {
  const secretDir = path.join(dataDir, "secret");
  const saltPath = path.join(secretDir, SALT_FILENAME);

  const existing = readValidSaltFile(saltPath);
  if (existing) return existing;

  const existsAlready = Result.try({
    try: () => fs.existsSync(saltPath),
    catch: () => true,
  }).match({ ok: (exists) => exists, err: () => true });
  if (existsAlready) return null;

  const generated = randomBytes(32).toString("hex");
  const tempPath = path.join(
    secretDir,
    `.${SALT_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  const published = Result.try({
    try: () => {
      fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tempPath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.linkSync(tempPath, saltPath);
      return true;
    },
    catch: () => false,
  }).match({ ok: (ok) => ok, err: () => false });

  Result.try({
    try: () => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    },
    catch: () => undefined,
  });

  if (published) return generated;
  return readValidSaltFile(saltPath);
}

export function hashTelemetryIdentifier(salt: string, domain: string, rawId: string): string {
  return createHmac("sha256", salt).update(`${domain}:${rawId}`).digest("hex").slice(0, 16);
}

export function deriveTelemetryDistinctId(salt: string): string {
  return createHmac("sha256", salt).update("install").digest("hex").slice(0, 32);
}

function stripStackHeader(stack: string, errorMessage?: string, errorName?: string): string | null {
  if (errorMessage !== undefined && errorMessage.length > 0) {
    if (errorName && errorName.length > 0) {
      const exactPrefix = `${errorName}: ${errorMessage}`;
      if (stack.startsWith(exactPrefix)) {
        const rest = stack.slice(exactPrefix.length);
        return rest.length === 0 || rest.startsWith("\n") ? rest : null;
      }
    }
    if (stack.startsWith(errorMessage)) {
      const rest = stack.slice(errorMessage.length);
      return rest.length === 0 || rest.startsWith("\n") ? rest : null;
    }
    const colonIdx = stack.indexOf(": ");
    if (colonIdx > 0 && stack.startsWith(errorMessage, colonIdx + 2)) {
      const rest = stack.slice(colonIdx + 2 + errorMessage.length);
      return rest.length === 0 || rest.startsWith("\n") ? rest : null;
    }
    // Message boundary cannot be verified; drop frames rather than risk forged message lines.
    return null;
  }

  if (errorName && errorName.length > 0) {
    if (stack.startsWith(errorName)) {
      const rest = stack.slice(errorName.length);
      if (rest.length === 0 || rest.startsWith("\n")) return rest;
      if (rest.startsWith(": ")) {
        const nl = rest.indexOf("\n");
        return nl >= 0 ? rest.slice(nl) : "";
      }
    }
    if (errorName.includes("\n")) return null;
  }

  const firstNewline = stack.indexOf("\n");
  return firstNewline >= 0 ? stack.slice(firstNewline) : "";
}

export function sanitizeStackTrace(
  stack: string | undefined,
  errorMessage?: string,
  errorName?: string,
): readonly string[] | undefined {
  if (typeof stack !== "string" || stack.length === 0) return undefined;
  const remaining = stripStackHeader(stack, errorMessage, errorName);
  if (remaining === null || remaining.length === 0) return undefined;
  const frames: string[] = [];
  const lines = remaining.split("\n");

  for (let i = 1; i < lines.length; i += 1) {
    if (frames.length >= MAX_STACK_FRAMES) break;
    const rawLine = lines[i];
    if (!rawLine || !/^\s+at\s+/u.test(rawLine)) continue;

    const normalized = normalizeStackFrame(rawLine.trim());
    if (normalized) frames.push(normalized);
  }

  return frames.length > 0 ? frames : undefined;
}

function normalizeStackFrame(frame: string): string | null {
  const pathMatch = /(?:file:\/\/)?((?:[A-Za-z]:)?[^\s():]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/u.exec(
    frame,
  );
  if (!pathMatch) return null;

  const rawPath = (pathMatch[1] ?? "").replace(/\\/gu, "/");
  const line = pathMatch[2] ?? "0";
  const col = pathMatch[3];
  const relative = extractVerifiedRelativeFramePath(rawPath);
  if (!relative) return null;

  // Omit function names so forged message lines can never smuggle arbitrary labels.
  return `${relative}:${line}${col ? `:${col}` : ""}`;
}

function extractVerifiedRelativeFramePath(normalizedPath: string): string | null {
  const root = getWorkspaceRootCached();
  if (!root) return null;
  const normalizedRoot = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return null;

  const rel = normalizedPath.slice(normalizedRoot.length + 1);
  if (hasDotOrEmptySegments(rel)) return null;
  if (rel.startsWith("node_modules/")) {
    if (!isVerifiedWorkspaceFile(rel)) return null;
    const afterNm = rel.slice("node_modules/".length);
    const bunNested = afterNm.indexOf("/node_modules/");
    if (bunNested >= 0) {
      const pkgPath = afterNm.slice(bunNested + "/node_modules/".length);
      const shortened = `node_modules/${pkgPath}`;
      if (
        !hasDotOrEmptySegments(pkgPath) &&
        /^[@A-Za-z0-9+._/-]+$/u.test(pkgPath) &&
        isVerifiedWorkspaceFile(shortened) &&
        sameWorkspaceRealpath(root, shortened, rel)
      ) {
        return shortened;
      }
    }
    return /^node_modules\/[@A-Za-z0-9+._/-]+$/u.test(rel) ? rel : null;
  }
  if (/^(?:apps|packages)\/[A-Za-z0-9._/-]+$/u.test(rel)) {
    return isVerifiedWorkspaceFile(rel) ? rel : null;
  }
  return null;
}

const VALIDATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request_error",
  "invalid_argument",
  "invalid_prompt",
  "invalid_value",
  "invalid_type",
  "invalid_function_parameters",
  "missing_required_parameter",
  "previous_response_not_found",
]);

export function isProviderShapeValidationError(
  aiError: AiErrorLogDetails | undefined,
  rawErrorMessage?: string,
): boolean {
  const status = aiError?.statusCode;
  if (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 429
  ) {
    return true;
  }
  const type = aiError?.providerType?.toLowerCase();
  if (type && VALIDATION_ERROR_CODES.has(type)) {
    return true;
  }
  const code = typeof aiError?.providerCode === "string" ? aiError.providerCode.toLowerCase() : "";
  if (code && VALIDATION_ERROR_CODES.has(code)) {
    return true;
  }
  const combined = `${code} ${aiError?.providerMessage ?? ""} ${aiError?.aiErrorMessage ?? ""} ${rawErrorMessage ?? ""}`;
  return /invalid_request_error|previous_response_not_found|no output found for (?:function|tool) call|tool_use|tool_result|function_call|invalid_schema|schema validation|tool (?:parameters|output) must be|unexpected.*tool/iu.test(
    combined,
  );
}

export type TelemetryClientOptions = {
  readonly fetchFn?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly allowInTestEnv?: boolean;
};

export class TelemetryClient {
  private errorsEnabled = false;
  private usageEnabled = false;
  private disabled = false;
  private dataDir = "";
  private salt: string | null = null;
  private distinctId: string | null = null;
  private envSnapshot: TelemetryEnvSnapshot = defaultEnvSnapshot();
  private postErrorWindowMs = DEFAULT_POST_ERROR_WINDOW_MS;
  private dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS;
  private maxErrorsPerMinute = DEFAULT_MAX_ERRORS_PER_MINUTE;

  private readonly globalBreadcrumbs: TelemetryBreadcrumb[] = [];
  private readonly requestBreadcrumbs = new Map<string, TelemetryBreadcrumb[]>();
  private readonly pendingErrors = new Map<string, PendingErrorCapture>();
  private readonly recentFingerprints = new Map<
    string,
    { lastSentAtMs: number; suppressed: number }
  >();
  private readonly recentRichRequestHashes = new Map<string, number>();
  private readonly errorSendTimestamps: number[] = [];

  private readonly queue: SerializedPostHogEvent[] = [];
  private queueBytes = 0;
  private flushScheduled = false;
  private flushing = false;
  private activeFlushPromise: Promise<void> | null = null;

  private sentBatches = 0;
  private failedBatches = 0;
  private droppedEvents = 0;
  private suppressedDuplicates = 0;
  private rateLimitedErrors = 0;

  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly allowInTestEnv: boolean;

  constructor(options: TelemetryClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.allowInTestEnv = options.allowInTestEnv === true;
  }

  configure(input: TelemetryConfigureInput): void {
    const hardDisabled = input.disabled === true || (!this.allowInTestEnv && isTestProcess());
    this.disabled = hardDisabled;
    this.errorsEnabled = !hardDisabled && input.errors;
    this.usageEnabled = !hardDisabled && input.usage;
    if (input.postErrorWindowMs !== undefined) this.postErrorWindowMs = input.postErrorWindowMs;
    if (input.dedupeWindowMs !== undefined) this.dedupeWindowMs = input.dedupeWindowMs;
    if (input.maxErrorsPerMinute !== undefined) this.maxErrorsPerMinute = input.maxErrorsPerMinute;

    if (input.envSnapshot) {
      this.envSnapshot = {
        ...defaultEnvSnapshot(),
        ...input.envSnapshot,
      };
    }

    if (this.dataDir !== input.dataDir) {
      this.dataDir = input.dataDir;
      this.salt = null;
      this.distinctId = null;
    }

    if (this.errorsEnabled || this.usageEnabled) {
      this.ensureSalt();
    }

    if (!this.errorsEnabled) {
      this.clearPendingErrors(false);
      this.globalBreadcrumbs.length = 0;
      this.requestBreadcrumbs.clear();
      this.errorSendTimestamps.length = 0;
    }

    this.pruneDisabledQueuedEvents();
  }

  isErrorCaptureActive(): boolean {
    return !this.disabled && this.errorsEnabled;
  }

  isUsageCaptureActive(): boolean {
    return !this.disabled && this.usageEnabled;
  }

  diagnostics(): TelemetryDiagnostics {
    return {
      errorsEnabled: this.isErrorCaptureActive(),
      usageEnabled: this.isUsageCaptureActive(),
      pendingEvents: this.queue.length,
      sentBatches: this.sentBatches,
      failedBatches: this.failedBatches,
      droppedEvents: this.droppedEvents,
      suppressedDuplicates: this.suppressedDuplicates,
      rateLimitedErrors: this.rateLimitedErrors,
    };
  }

  observeLog(observation: TelemetryLogObservation): void {
    if (!this.isErrorCaptureActive()) return;
    Result.try({
      try: () => this.observeLogInternal(observation),
      catch: () => undefined,
    });
  }

  private observeLogInternal(observation: TelemetryLogObservation): void {
    const salt = this.ensureSalt();
    if (!salt) return;

    const breadcrumb = this.projectLogToBreadcrumb(salt, observation);
    this.appendBreadcrumb(breadcrumb);

    if (observation.level !== "error" && observation.level !== "fatal") {
      return;
    }

    if (breadcrumb.requestHash) {
      const richAt = this.recentRichRequestHashes.get(breadcrumb.requestHash);
      if (richAt !== undefined && this.now() - richAt < 5_000) {
        return;
      }
    }

    const errorTag =
      typeof breadcrumb.fields?.errorTag === "string" ? breadcrumb.fields.errorTag : undefined;
    const errorName = sanitizeErrorIdentifier(observation.errorName);
    const safeErrorCode = sanitizeErrorCode(observation.errorCode);
    const errorCode = safeErrorCode !== undefined ? String(safeErrorCode) : undefined;
    const stackFrames = sanitizeStackTrace(
      observation.errorStack,
      observation.errorMessage,
      observation.errorName,
    );
    const module = breadcrumb.module ?? "unknown";
    const fingerprint = this.computeFingerprint({
      module,
      event: breadcrumb.event,
      errorTag,
      errorName,
      errorCode,
      topFrame: stackFrames?.[0],
    });

    this.scheduleErrorCapture({
      fingerprint,
      level: observation.level,
      module,
      event: breadcrumb.event,
      requestHash: breadcrumb.requestHash,
      sessionHash: breadcrumb.sessionHash,
      runHash: breadcrumb.runHash,
      errorTag,
      errorName,
      errorCode,
      stackFrames,
      fields: breadcrumb.fields ? { ...breadcrumb.fields } : {},
    });
  }

  captureError(input: TelemetryErrorCaptureInput): void {
    if (!this.isErrorCaptureActive()) return;
    Result.try({
      try: () => this.captureErrorInternal(input),
      catch: () => undefined,
    });
  }

  private captureErrorInternal(input: TelemetryErrorCaptureInput): void {
    const salt = this.ensureSalt();
    if (!salt) return;

    const requestHash = input.requestId
      ? hashTelemetryIdentifier(salt, "request", input.requestId)
      : undefined;
    const sessionHash = input.sessionId
      ? hashTelemetryIdentifier(salt, "session", input.sessionId)
      : undefined;
    const runHash = input.runId ? hashTelemetryIdentifier(salt, "run", input.runId) : undefined;

    const fields: Record<string, TelemetryPrimitive> = {};
    const safeProvider = sanitizeProvider(input.provider);
    if (safeProvider) fields.provider = safeProvider;
    const safeTransport = sanitizeTransport(input.transport);
    if (safeTransport) fields.transport = safeTransport;
    if (input.surface) fields.surface = sanitizeSurface(input.surface);
    if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
      fields.durationMs = Math.max(0, Math.round(input.durationMs));
    }
    if (input.aiError) {
      const aiName = sanitizeErrorIdentifier(input.aiError.aiErrorName);
      if (aiName) fields.aiErrorName = aiName;
      if (input.aiError.statusCode !== undefined) fields.statusCode = input.aiError.statusCode;
      if (input.aiError.isRetryable !== undefined) fields.isRetryable = input.aiError.isRetryable;
      if (input.aiError.retryAttempts !== undefined) {
        fields.retryAttempts = input.aiError.retryAttempts;
      }
      const providerCode = sanitizeErrorCode(input.aiError.providerCode);
      if (providerCode !== undefined) fields.providerCode = providerCode;
      const providerType = sanitizeProviderErrorType(input.aiError.providerType);
      if (providerType) fields.providerType = providerType;
    }

    let transcriptShape: TranscriptShapeSnapshot | undefined;
    if (
      input.transcriptContext &&
      isProviderShapeValidationError(input.aiError, input.rawErrorMessage)
    ) {
      const ctx = input.transcriptContext;
      transcriptShape = Result.try({
        try: () =>
          buildTranscriptShapeSnapshot({
            messages: ctx.messages,
            preProjectionMessages: ctx.preProjectionMessages,
            target: ctx.target,
            provenance: ctx.provenance,
            errorDetails: input.aiError,
            rawErrorMessage: input.rawErrorMessage,
            hashExternalName: (domain, raw) => hashTelemetryIdentifier(salt, domain, raw),
          }),
        catch: () => undefined,
      }).match({ ok: (value) => value, err: () => undefined });
    }

    const level = input.level ?? "error";
    const module = sanitizeModuleName(input.module) ?? "unknown";
    const event = sanitizeEventName(input.event, level);
    const errorTag = sanitizeErrorIdentifier(input.errorTag);
    const errorName = sanitizeErrorIdentifier(input.errorName ?? input.aiError?.aiErrorName);
    const safeErrorCode = sanitizeErrorCode(input.errorCode);
    const errorCode = safeErrorCode !== undefined ? String(safeErrorCode) : undefined;
    const stackFrames = sanitizeStackTrace(
      input.errorStack,
      input.rawErrorMessage,
      input.errorName,
    );
    const fingerprint = this.computeFingerprint({
      module,
      event,
      errorTag,
      errorName,
      errorCode:
        errorCode ??
        (input.aiError?.statusCode !== undefined ? String(input.aiError.statusCode) : undefined),
      topFrame: stackFrames?.[0],
      providerCode: fields.providerCode !== undefined ? String(fields.providerCode) : undefined,
      firstAnomaly: transcriptShape?.anomalies[0] ?? transcriptShape?.errorCategory,
    });

    if (requestHash) {
      for (const [key, pending] of this.pendingErrors) {
        if (pending.requestHash === requestHash && !pending.transcriptShape) {
          if (pending.timer) clearTimeout(pending.timer);
          this.pendingErrors.delete(key);
        }
      }
    }

    this.scheduleErrorCapture({
      fingerprint,
      level,
      module,
      event,
      requestHash,
      sessionHash,
      runHash,
      errorTag,
      errorName,
      errorCode,
      stackFrames,
      fields,
      transcriptShape,
    });

    if (requestHash) {
      this.recentRichRequestHashes.set(requestHash, this.now());
      this.pruneRichRequestCache();
    }
  }

  captureAgentRun(input: TelemetryAgentRunInput): void {
    if (!this.isUsageCaptureActive()) return;
    Result.try({
      try: () => this.captureAgentRunInternal(input),
      catch: () => undefined,
    });
  }

  private captureAgentRunInternal(input: TelemetryAgentRunInput): void {
    const salt = this.ensureSalt();
    const distinctId = this.distinctId;
    if (!salt || !distinctId) return;

    const properties: Record<string, object | TelemetryPrimitive | null | undefined> = {
      $ip: null,
      $lib: "lilac-core",
      $lib_version: this.envSnapshot.version,
      lilac_commit: this.envSnapshot.commit,
      os: this.envSnapshot.os,
      arch: this.envSnapshot.arch,
      bun_version: this.envSnapshot.bunVersion,
      docker: this.envSnapshot.docker,
      status: input.status,
      surface: sanitizeSurface(input.surface),
      is_subagent: input.isSubagent,
      is_workflow: input.isWorkflow,
      is_heartbeat: input.isHeartbeat,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
    };

    const safeProvider = sanitizeProvider(input.provider);
    if (safeProvider) properties.provider = safeProvider;
    if (input.modelId && input.modelId.length > 0) {
      properties.model_id = input.modelId;
    }
    if (input.modelSpec && input.modelSpec.length > 0) {
      properties.model_spec = input.modelSpec;
    }
    const safeTransport = sanitizeTransport(input.transport);
    if (safeTransport) properties.transport = safeTransport;
    if (input.didSwitchModel !== undefined) properties.did_switch_model = input.didSwitchModel;
    if (typeof input.ttftMs === "number" && Number.isFinite(input.ttftMs)) {
      properties.ttft_ms = Math.max(0, Math.round(input.ttftMs));
    }
    if (typeof input.turns === "number") properties.turns = input.turns;
    if (typeof input.toolCallCount === "number") properties.tool_call_count = input.toolCallCount;
    if (input.compacted !== undefined) properties.compacted = input.compacted;
    if (typeof input.transcriptMessageCount === "number") {
      properties.transcript_message_count = input.transcriptMessageCount;
    }
    if (typeof input.inputTokens === "number") properties.input_tokens = input.inputTokens;
    if (typeof input.outputTokens === "number") properties.output_tokens = input.outputTokens;
    if (typeof input.totalTokens === "number") properties.total_tokens = input.totalTokens;
    if (typeof input.noCacheTokens === "number") properties.no_cache_tokens = input.noCacheTokens;
    if (typeof input.cacheReadTokens === "number") {
      properties.cache_read_tokens = input.cacheReadTokens;
    }
    if (typeof input.cacheWriteTokens === "number") {
      properties.cache_write_tokens = input.cacheWriteTokens;
    }
    if (typeof input.textTokens === "number") properties.text_tokens = input.textTokens;
    if (typeof input.reasoningTokens === "number") {
      properties.reasoning_tokens = input.reasoningTokens;
    }
    if (typeof input.estimatedCostUsd === "number" && Number.isFinite(input.estimatedCostUsd)) {
      properties.estimated_cost_usd = Number(input.estimatedCostUsd.toFixed(6));
    }
    if (input.requestId) {
      properties.request_hash = hashTelemetryIdentifier(salt, "request", input.requestId);
    }
    if (input.sessionId) {
      properties.session_hash = hashTelemetryIdentifier(salt, "session", input.sessionId);
    }
    const safeErrorTag = sanitizeErrorIdentifier(input.errorTag);
    if (safeErrorTag) properties.error_tag = safeErrorTag;
    if (typeof input.statusCode === "number") properties.status_code = input.statusCode;

    this.enqueueEvent({
      event: "lilac_agent_run",
      distinct_id: distinctId,
      timestamp: new Date(this.now()).toISOString(),
      properties,
    });
  }

  async flush(timeoutMs = 2_000): Promise<void> {
    this.clearPendingErrors(this.isErrorCaptureActive());
    this.pruneDisabledQueuedEvents();
    if (this.queue.length === 0 && !this.flushing) return;

    const flushWork = this.activeFlushPromise ?? this.drainQueue();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(10, timeoutMs));
      timer.unref?.();
    });

    await Promise.race([flushWork, deadline]);
    if (timer) clearTimeout(timer);
  }

  private isEventEnabled(eventName: PostHogEventName): boolean {
    if (eventName === "lilac_error") return this.isErrorCaptureActive();
    return this.isUsageCaptureActive();
  }

  private pruneDisabledQueuedEvents(): void {
    if (this.queue.length === 0) return;
    let writeIdx = 0;
    let remainingBytes = 0;
    for (let i = 0; i < this.queue.length; i += 1) {
      const item = this.queue[i];
      if (!item) continue;
      if (this.isEventEnabled(item.event.event)) {
        this.queue[writeIdx] = item;
        writeIdx += 1;
        remainingBytes += item.bytes;
      }
    }
    this.queue.length = writeIdx;
    this.queueBytes = remainingBytes;
  }

  private ensureSalt(): string | null {
    if (this.salt && this.distinctId) return this.salt;
    if (!this.dataDir) return null;
    const loaded = loadOrCreateSalt(this.dataDir);
    if (!loaded) return null;
    this.salt = loaded;
    this.distinctId = deriveTelemetryDistinctId(loaded);
    return loaded;
  }

  private projectLogToBreadcrumb(
    salt: string,
    observation: TelemetryLogObservation,
  ): TelemetryBreadcrumb {
    let requestHash: string | undefined;
    let sessionHash: string | undefined;
    let runHash: string | undefined;
    let toolCallHash: string | undefined;
    const safeFields: Record<string, TelemetryPrimitive> = {};
    let hasFields = false;

    if (observation.fields) {
      for (const [key, rawValue] of Object.entries(observation.fields)) {
        if (rawValue === null || rawValue === undefined) continue;

        const idDomain = ID_KEY_TO_DOMAIN[key];
        if (idDomain && typeof rawValue === "string" && rawValue.length > 0) {
          const hashed = hashTelemetryIdentifier(salt, idDomain, rawValue);
          if (idDomain === "request") requestHash = hashed;
          else if (idDomain === "session") sessionHash = hashed;
          else if (idDomain === "run") runHash = hashed;
          else toolCallHash = hashed;
          continue;
        }

        if (key === "toolName" && typeof rawValue === "string" && rawValue.length > 0) {
          safeFields.toolName = DEFAULT_BUILTIN_TOOL_NAMES.has(rawValue)
            ? rawValue
            : `ext_${hashTelemetryIdentifier(salt, "tool", rawValue).slice(0, 10)}`;
          hasFields = true;
          continue;
        }

        if (
          ALLOWED_SCALAR_KEYS.has(key) &&
          (typeof rawValue === "boolean" ||
            (typeof rawValue === "number" && Number.isFinite(rawValue)))
        ) {
          safeFields[key] = rawValue;
          hasFields = true;
          continue;
        }

        if (typeof rawValue === "string" && rawValue.length > 0) {
          const projected = projectAllowedStringField(key, rawValue);
          if (projected !== undefined) {
            safeFields[key] = projected;
            hasFields = true;
          }
        }
      }
    }

    const safeModule = sanitizeModuleName(observation.module);
    return {
      ts: this.now(),
      level: observation.level,
      ...(safeModule ? { module: safeModule } : {}),
      event: sanitizeEventName(observation.message, observation.level),
      ...(requestHash ? { requestHash } : {}),
      ...(sessionHash ? { sessionHash } : {}),
      ...(runHash ? { runHash } : {}),
      ...(toolCallHash ? { toolCallHash } : {}),
      ...(hasFields ? { fields: safeFields } : {}),
    };
  }

  private appendBreadcrumb(breadcrumb: TelemetryBreadcrumb): void {
    this.globalBreadcrumbs.push(breadcrumb);
    if (this.globalBreadcrumbs.length > MAX_GLOBAL_BREADCRUMBS) {
      this.globalBreadcrumbs.shift();
    }

    if (breadcrumb.requestHash) {
      let bucket = this.requestBreadcrumbs.get(breadcrumb.requestHash);
      if (!bucket) {
        bucket = [];
        this.requestBreadcrumbs.set(breadcrumb.requestHash, bucket);
        if (this.requestBreadcrumbs.size > MAX_TRACKED_REQUEST_BUCKETS) {
          const oldestKey = this.requestBreadcrumbs.keys().next().value;
          if (oldestKey !== undefined) this.requestBreadcrumbs.delete(oldestKey);
        }
      }
      bucket.push(breadcrumb);
      if (bucket.length > MAX_REQUEST_BREADCRUMBS) {
        bucket.shift();
      }
    }

    for (const pending of this.pendingErrors.values()) {
      if (pending.postBreadcrumbs.length >= MAX_POST_BREADCRUMBS) continue;
      if (
        pending.requestHash &&
        breadcrumb.requestHash &&
        pending.requestHash !== breadcrumb.requestHash
      ) {
        continue;
      }
      pending.postBreadcrumbs.push(breadcrumb);
    }
  }

  private computeFingerprint(parts: {
    readonly module: string;
    readonly event: string;
    readonly errorTag?: string;
    readonly errorName?: string;
    readonly errorCode?: string;
    readonly topFrame?: string;
    readonly providerCode?: string;
    readonly firstAnomaly?: string;
  }): string {
    return [
      parts.module,
      parts.errorTag ?? parts.errorName ?? "error",
      parts.errorCode ?? parts.providerCode ?? "",
      parts.topFrame ?? parts.event.slice(0, 60),
      parts.firstAnomaly ?? "",
    ].join("|");
  }

  private pruneExpiredFingerprints(nowMs: number): void {
    for (const [key, entry] of this.recentFingerprints) {
      if (nowMs - entry.lastSentAtMs >= this.dedupeWindowMs) {
        this.recentFingerprints.delete(key);
      }
    }
    while (this.recentFingerprints.size > MAX_RECENT_FINGERPRINTS) {
      const oldestKey = this.recentFingerprints.keys().next().value;
      if (oldestKey === undefined) break;
      this.recentFingerprints.delete(oldestKey);
    }
  }

  private scheduleErrorCapture(input: {
    readonly fingerprint: string;
    readonly level: "error" | "fatal";
    readonly module: string;
    readonly event: string;
    readonly requestHash?: string;
    readonly sessionHash?: string;
    readonly runHash?: string;
    readonly errorTag?: string;
    readonly errorName?: string;
    readonly errorCode?: string;
    readonly stackFrames?: readonly string[];
    readonly fields: Record<string, TelemetryPrimitive>;
    readonly transcriptShape?: TranscriptShapeSnapshot;
  }): void {
    const nowMs = this.now();
    this.pruneExpiredFingerprints(nowMs);

    const existingPending = this.pendingErrors.get(input.fingerprint);
    if (existingPending) {
      this.suppressedDuplicates += 1;
      return;
    }

    const recent = this.recentFingerprints.get(input.fingerprint);
    if (recent && nowMs - recent.lastSentAtMs < this.dedupeWindowMs) {
      recent.suppressed += 1;
      this.suppressedDuplicates += 1;
      return;
    }

    while (
      this.errorSendTimestamps.length > 0 &&
      nowMs - (this.errorSendTimestamps[0] ?? 0) > 60_000
    ) {
      this.errorSendTimestamps.shift();
    }
    if (this.errorSendTimestamps.length + this.pendingErrors.size >= this.maxErrorsPerMinute) {
      this.rateLimitedErrors += 1;
      return;
    }

    const preBreadcrumbs = input.requestHash
      ? [...(this.requestBreadcrumbs.get(input.requestHash) ?? this.globalBreadcrumbs.slice(-30))]
      : this.globalBreadcrumbs.slice(-40);

    const pending: PendingErrorCapture = {
      fingerprint: input.fingerprint,
      capturedAtMs: nowMs,
      level: input.level,
      module: input.module,
      event: input.event,
      requestHash: input.requestHash,
      sessionHash: input.sessionHash,
      runHash: input.runHash,
      errorTag: input.errorTag,
      errorName: input.errorName,
      errorCode: input.errorCode,
      stackFrames: input.stackFrames,
      fields: input.fields,
      transcriptShape: input.transcriptShape,
      preBreadcrumbs,
      postBreadcrumbs: [],
      timer: null,
    };

    if (this.postErrorWindowMs <= 0) {
      this.finalizePendingError(pending);
      return;
    }

    this.pendingErrors.set(input.fingerprint, pending);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      this.pendingErrors.delete(input.fingerprint);
      this.finalizePendingError(pending);
    }, this.postErrorWindowMs);
    pending.timer.unref?.();
  }

  private finalizePendingError(pending: PendingErrorCapture): void {
    if (!this.isErrorCaptureActive()) return;
    const distinctId = this.distinctId;
    if (!distinctId) return;

    const nowMs = this.now();
    const priorRecord = this.recentFingerprints.get(pending.fingerprint);
    const suppressedSinceLast = priorRecord?.suppressed ?? 0;
    this.recentFingerprints.set(pending.fingerprint, { lastSentAtMs: nowMs, suppressed: 0 });
    this.pruneExpiredFingerprints(nowMs);
    this.errorSendTimestamps.push(nowMs);

    const combinedBreadcrumbs = [...pending.preBreadcrumbs, ...pending.postBreadcrumbs].map(
      (crumb) => ({
        ...crumb,
        deltaMs: crumb.ts - pending.capturedAtMs,
      }),
    );

    const properties: Record<string, object | TelemetryPrimitive | null | undefined> = {
      $ip: null,
      $lib: "lilac-core",
      $lib_version: this.envSnapshot.version,
      lilac_commit: this.envSnapshot.commit,
      os: this.envSnapshot.os,
      arch: this.envSnapshot.arch,
      bun_version: this.envSnapshot.bunVersion,
      docker: this.envSnapshot.docker,
      ...(this.envSnapshot.surfaces ? { surfaces: [...this.envSnapshot.surfaces] } : {}),
      ...(this.envSnapshot.blobBackend ? { blob_backend: this.envSnapshot.blobBackend } : {}),
      fingerprint: pending.fingerprint,
      level: pending.level,
      module: pending.module,
      event_message: pending.event,
      ...(pending.errorTag ? { error_tag: pending.errorTag } : {}),
      ...(pending.errorName ? { error_name: pending.errorName } : {}),
      ...(pending.errorCode ? { error_code: pending.errorCode } : {}),
      ...(pending.requestHash ? { request_hash: pending.requestHash } : {}),
      ...(pending.sessionHash ? { session_hash: pending.sessionHash } : {}),
      ...(pending.runHash ? { run_hash: pending.runHash } : {}),
      ...(pending.stackFrames ? { stack_frames: [...pending.stackFrames] } : {}),
      ...(suppressedSinceLast > 0 ? { suppressed_duplicates: suppressedSinceLast } : {}),
      ...(Object.keys(pending.fields).length > 0 ? { context: pending.fields } : {}),
      ...(pending.transcriptShape ? { transcript_shape: pending.transcriptShape } : {}),
      breadcrumbs: combinedBreadcrumbs,
    };

    this.enqueueEvent({
      event: "lilac_error",
      distinct_id: distinctId,
      timestamp: new Date(pending.capturedAtMs).toISOString(),
      properties,
    });
  }

  private clearPendingErrors(emitPending: boolean): void {
    const entries = [...this.pendingErrors.values()];
    this.pendingErrors.clear();
    for (const pending of entries) {
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      if (emitPending) {
        this.finalizePendingError(pending);
      }
    }
  }

  private pruneRichRequestCache(): void {
    if (this.recentRichRequestHashes.size <= 64) return;
    const cutoff = this.now() - 10_000;
    for (const [key, ts] of this.recentRichRequestHashes) {
      if (ts < cutoff) this.recentRichRequestHashes.delete(key);
    }
  }

  private enqueueEvent(event: PostHogEvent): void {
    if (!this.isEventEnabled(event.event)) return;
    const serialized = Result.try({
      try: () => JSON.stringify(event),
      catch: () => undefined,
    }).match({ ok: (json) => json, err: () => undefined });
    if (!serialized) {
      this.droppedEvents += 1;
      return;
    }

    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_SINGLE_EVENT_BYTES) {
      this.droppedEvents += 1;
      return;
    }

    this.queue.push({ event, bytes });
    this.queueBytes += bytes;

    while (this.queue.length > MAX_QUEUE_EVENTS || this.queueBytes > MAX_QUEUE_BYTES) {
      const evicted = this.queue.shift();
      if (!evicted) break;
      this.queueBytes -= evicted.bytes;
      this.droppedEvents += 1;
    }

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushing) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.drainQueue();
    });
  }

  private drainQueue(): Promise<void> {
    if (this.activeFlushPromise) return this.activeFlushPromise;
    if (this.queue.length === 0) return Promise.resolve();
    this.flushing = true;

    const run = async (): Promise<void> => {
      while (this.queue.length > 0) {
        const batch = this.takeBatch();
        if (batch.length === 0) break;
        const ok = await this.postBatch(batch);
        if (ok) {
          this.sentBatches += 1;
        } else {
          this.failedBatches += 1;
        }
      }
    };

    const promise = run().finally(() => {
      this.flushing = false;
      if (this.activeFlushPromise === promise) {
        this.activeFlushPromise = null;
      }
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    });
    this.activeFlushPromise = promise;
    return promise;
  }

  private takeBatch(): readonly PostHogEvent[] {
    const events: PostHogEvent[] = [];
    let bodyBytes = 64;

    while (events.length < MAX_BATCH_EVENTS) {
      const next = this.queue[0];
      if (!next) break;
      if (!this.isEventEnabled(next.event.event)) {
        this.queue.shift();
        this.queueBytes -= next.bytes;
        continue;
      }
      if (events.length > 0 && bodyBytes + next.bytes > MAX_BATCH_BYTES) break;
      this.queue.shift();
      this.queueBytes -= next.bytes;
      events.push(next.event);
      bodyBytes += next.bytes + 1;
    }

    return events;
  }

  private async postBatch(batch: readonly PostHogEvent[]): Promise<boolean> {
    const body = Result.try({
      try: () => JSON.stringify({ batch }),
      catch: () => undefined,
    }).match({ ok: (text) => text, err: () => undefined });
    if (!body) return false;

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, REQUEST_TIMEOUT_MS);
      timeoutId.unref?.();
    });

    const request = Result.tryPromise({
      try: async () => {
        const response = await this.fetchFn(TELEMETRY_PROXY_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
        return response.ok;
      },
      catch: () => false,
    }).then((result) => result.match({ ok: (ok) => ok, err: () => false }));

    const ok = await Promise.race([request, timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    return ok;
  }
}

const defaultTelemetryClient = new TelemetryClient();

export function createTelemetryClient(options: TelemetryClientOptions = {}): TelemetryClient {
  return new TelemetryClient(options);
}

export function configureTelemetry(input: TelemetryConfigureInput): void {
  defaultTelemetryClient.configure(input);
}

export function isTelemetryErrorCaptureActive(): boolean {
  return defaultTelemetryClient.isErrorCaptureActive();
}

export function isTelemetryUsageCaptureActive(): boolean {
  return defaultTelemetryClient.isUsageCaptureActive();
}

export function observeTelemetryLog(observation: TelemetryLogObservation): void {
  defaultTelemetryClient.observeLog(observation);
}

export function captureTelemetryError(input: TelemetryErrorCaptureInput): void {
  defaultTelemetryClient.captureError(input);
}

export function captureTelemetryAgentRun(input: TelemetryAgentRunInput): void {
  defaultTelemetryClient.captureAgentRun(input);
}

export function getTelemetryDiagnostics(): TelemetryDiagnostics {
  return defaultTelemetryClient.diagnostics();
}

export function flushTelemetry(timeoutMs = 2_000): Promise<void> {
  return defaultTelemetryClient.flush(timeoutMs);
}
