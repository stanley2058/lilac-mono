const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH_SIZE = 50;
const MAX_BREADCRUMBS = 100;
const MAX_WINDOW_MESSAGES = 32;
const MAX_PARTS_PER_MESSAGE = 64;
const MAX_STACK_FRAMES = 15;
const MAX_ANOMALIES = 32;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const DISTINCT_ID_RE = /^[a-f0-9]{32}$/u;
const HASH_16_RE = /^[a-f0-9]{16}$/u;
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
const SAFE_MODULE_RE = /^[a-z0-9:._-]{1,64}$/u;
const SAFE_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/u;
const SAFE_COMMIT_RE = /^[a-f0-9]{4,40}$|^dev$/u;
const SAFE_STACK_FRAME_RE = /^(?:apps|packages|node_modules)\/[A-Za-z0-9@+._/-]+:\d+(?::\d+)?$/u;
const SAFE_CALL_ID_ALIAS_RE = /^tc_\d{1,5}$/u;
const SAFE_EXT_TOOL_RE = /^ext_[a-f0-9]{10}$/u;
const SAFE_HASHED_KEY_RE = /^k_[a-f0-9]{8}$/u;
const SAFE_HASHED_NS_RE = /^ns_[a-f0-9]{8}$/u;
const SAFE_TOOL_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,47}$/u;
const SAFE_BUILTIN_CALLABLE_ID_RE = /^[a-z][a-z0-9_-]{0,31}(?:\.[a-z][a-z0-9_-]{0,31}){1,3}$/u;
const GENERIC_LOG_EVENTS = new Set(["log", "log_warn", "log_error", "log_fatal"]);
// Clients before the $exception mapping truncated fingerprint events to 60 characters.
const LEGACY_FINGERPRINT_EVENT_LENGTH = 60;

const ROLE_TRACE_PART_RE =
  /^(?:s|s0|t|t0|r|img|file|reasoning-file|other|tc_\d{1,5}|tr_\d{1,5}|tool-approval-request|tool-approval-response|c:(?:anthropic\.message_start|anthropic\.fallback|anthropic\.tool-reference|openai\.compaction|custom_other))$/u;
const ROLE_TRACE_SEGMENT_RE = /^[suat]\(([^)]*)\)$/u;

const STRICT_ANOMALY_RE =
  /^(?:consecutive_(?:user|assistant):\d{1,5},\d{1,5}|empty_content_array:msg=\d{1,5}|empty_text_part:msg=\d{1,5}|missing_anthropic_signature:msg=\d{1,5}|unmatched_tool_call_before_(?:user|assistant|system):tc_\d{1,5}@msg=\d{1,5}|duplicate_tool_call_id:tc_\d{1,5}@msg=\d{1,5}|tool_call_id_chars:tc_\d{1,5}=(?:empty|alnum_dash_underscore|(?:space|colon|dot|slash|non_ascii|special)(?:\+(?:space|colon|dot|slash|non_ascii|special))*)|non_object_tool_input:tc_\d{1,5}=(?:string|number|boolean|null|undefined|array|bigint|symbol|function|unknown)|orphan_tool_result:tc_\d{1,5}@msg=\d{1,5}|tool_result_not_immediately_after_call:tc_\d{1,5}@msg=\d{1,5}|orphan_tool_call:tc_\d{1,5}@msg=\d{1,5})$/u;

const ALLOWED_LEVELS = new Set(["debug", "info", "warn", "error", "fatal"]);
const ALLOWED_ERROR_LEVELS = new Set(["error", "fatal"]);
const ALLOWED_RUN_STATUSES = new Set(["resolved", "cancelled", "failed"]);
const ALLOWED_SURFACES = new Set(["discord", "native", "github", "heartbeat", "unknown"]);
const ALLOWED_BLOB_BACKENDS = new Set(["local", "s3"]);
const ALLOWED_PROVIDERS = new Set([
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
const ALLOWED_TRANSPORTS = new Set([
  "ai-sdk",
  "openai-responses",
  "claude-code",
  "sse",
  "websocket",
  "auto",
]);
const ALLOWED_PROFILE_FAMILIES = new Set(["anthropic", "openai", "google", "other"]);
const ALLOWED_SEND_KINDS = new Set(["explicit", "continuation", "steer"]);
const ALLOWED_SOURCES = new Set([
  "wal-recovery",
  "compaction",
  "discord",
  "native",
  "github",
  "heartbeat",
  "unknown",
]);
const ALLOWED_OS = new Set(["linux", "darwin", "win32", "freebsd", "openbsd", "sunos", "aix"]);
const ALLOWED_ARCH = new Set(["x64", "arm64", "ia32", "arm", "ppc64", "s390x", "riscv64"]);

const ALLOWED_STATIC_EVENTS = new Set([
  "log",
  "log_warn",
  "log_error",
  "log_fatal",
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
  "tool call",
  "tool.call.result",
  "tool-server error",
  "tool plugin operation failed",
  "tool call defect contained",
  "tool server cleanup failed",
  "tool-server watchdog detected unhealthy runtime",
]);

const ALLOWED_ERROR_IDENTIFIERS = new Set([
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

const ALLOWED_ERROR_CODES = new Set([
  "unknown",
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

const ALLOWED_PROVIDER_ERROR_TYPES = new Set([
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
  "other",
]);

const ALLOWED_FAILURE_KINDS = new Set([
  "soft",
  "hard",
  "idle-timeout",
  "pre-agent-cancelled",
  "shutdown-draining",
  "other",
]);
const ALLOWED_FAILURE_CLASSES = new Set([
  "policy",
  "timeout",
  "cancelled",
  "environment",
  "tool",
  "unknown",
]);
const ALLOWED_TOOL_FAILURE_KINDS = new Set([
  "usage",
  "denied",
  "not_found",
  "conflict",
  "unavailable",
  "timeout",
  "cancelled",
  "internal",
]);
const ALLOWED_FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);
const ALLOWED_COST_STATUSES = new Set(["estimated", "unavailable"]);

const ALLOWED_BUILTIN_TOOLS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "edit_file",
  "apply_patch",
  "glob",
  "grep",
  "fuzzy_search",
  "subagent_delegate",
  "orchestrate",
  "job",
  "question",
  "model_catalog",
  "web_search",
  "web_fetch",
  "computer",
  "tool_search",
]);

const ALLOWED_BUILTIN_ARG_KEYS = new Set([
  "command",
  "cwd",
  "timeoutMs",
  "timeout",
  "description",
  "runInBackground",
  "path",
  "filePath",
  "offset",
  "limit",
  "startLine",
  "endLine",
  "pages",
  "content",
  "oldString",
  "newString",
  "replaceAll",
  "edits",
  "patch",
  "input",
  "pattern",
  "glob",
  "type",
  "caseSensitive",
  "query",
  "prompt",
  "task",
  "model",
  "reasoning",
  "permissions",
  "profile",
  "label",
  "options",
  "mode",
  "action",
  "id",
  "client",
  "scope",
  "message",
  "before",
  "after",
  "view",
  "itemId",
  "textOffset",
  "commandId",
  "jobId",
  "questions",
  "provider",
  "domain",
  "url",
  "maxChars",
  "sessionId",
  "code",
  "names",
]);

const ALLOWED_PROVIDER_NAMESPACES = new Set([
  "anthropic",
  "openai",
  "google",
  "googleVertex",
  "vertex",
  "openrouter",
  "gateway",
  "openaiCompatible",
  "lilac",
]);

const ALLOWED_PROVIDER_OPT_KEYS = new Set([
  "cacheControl",
  "cache_control",
  "signature",
  "redactedData",
  "citations",
  "title",
  "context",
  "containerUpload",
  "clearAt",
  "effort",
  "toolChanges",
  "type",
  "toolName",
  "serverName",
  "toolsetName",
  "caller",
  "from",
  "to",
  "itemId",
  "phase",
  "reasoningEncryptedContent",
  "encryptedContent",
  "imageDetail",
  "promptCacheBreakpoint",
  "namespace",
  "async",
  "reasoningEffortUpdate",
  "parallelToolCall",
  "approvalId",
  "toolSearchSeed",
  "toolSearchTools",
  "toolSearchCall",
  "thoughtSignature",
  "thought",
  "serverToolCallId",
  "serverToolType",
  "reasoning",
  "provider",
  "generated",
  "kind",
  "turnId",
  "compaction",
  "skipReply",
  "synthetic",
]);

const ALLOWED_ERROR_CATEGORIES = new Set([
  "orphan_tool_call",
  "orphan_tool_result",
  "invalid_tool_call_id",
  "invalid_tool_input",
  "invalid_thinking_block",
  "invalid_role_order",
  "empty_content",
  "previous_response_not_found",
  "invalid_schema",
  "invalid_request",
  "unknown",
]);

const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);
const ALLOWED_CONTENT_KINDS = new Set(["string", "array"]);
const ALLOWED_PART_TYPES = new Set([
  "text",
  "reasoning",
  "reasoning-file",
  "tool-call",
  "tool-result",
  "tool-approval-request",
  "tool-approval-response",
  "image",
  "file",
  "custom",
  "other",
]);
const ALLOWED_OUTPUT_TYPES = new Set([
  "text",
  "error-text",
  "json",
  "error-json",
  "execution-denied",
  "content",
]);
const ALLOWED_DATA_KINDS = new Set(["url", "bytes", "data_url", "string", "object", "undefined"]);
const ALLOWED_CALL_ID_PREFIXES = new Set([
  "empty",
  "toolu_",
  "call_",
  "fc_",
  "srvtoolu_",
  "mcptoolu_",
  "prefixed",
  "other",
]);
const ALLOWED_CALL_ID_CHARS_RE =
  /^(?:empty|alnum_dash_underscore|(?:space|colon|dot|slash|non_ascii|special)(?:\+(?:space|colon|dot|slash|non_ascii|special))*)$/u;
const ALLOWED_INPUT_LEAF_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "undefined",
  "bigint",
  "symbol",
  "function",
]);
const ALLOWED_CUSTOM_KINDS = new Set([
  "anthropic.message_start",
  "anthropic.fallback",
  "anthropic.tool-reference",
  "openai.compaction",
  "custom_other",
]);
const ALLOWED_PHASES = new Set(["commentary", "final_answer", "other"]);
const ALLOWED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/other",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/other",
  "application/json",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/other",
  "video/mp4",
  "video/webm",
  "video/other",
  "other",
]);
const ALLOWED_PARAM_PATH_SEGMENTS = new Set([
  "messages",
  "input",
  "content",
  "parts",
  "tools",
  "tool_use",
  "tool_result",
  "tool_call",
  "tool_calls",
  "function_call",
  "function_call_output",
  "call_id",
  "tool_use_id",
  "id",
  "name",
  "arguments",
  "role",
  "type",
  "thinking",
  "signature",
  "previous_response_id",
  "model",
  "<field>",
]);
const ALLOWED_OUTPUT_ITEM_TYPE_RE =
  /^(?:text|image-url|image-file-id|image-file-reference|file-url|file-id|file-reference|file:(?:image|audio|video|text|application)\/[a-z0-9.+-]+|file:other|custom:(?:anthropic|openai|google|googleVertex|vertex|openrouter|gateway|openaiCompatible|lilac|other))$/u;

const CONTEXT_BOOL_KEYS = new Set([
  "ok",
  "retryable",
  "isRetryable",
  "deferredAccepted",
  "transcriptHasCompactionCheckpoint",
  "compacted",
  "didSwitchModel",
]);
const CONTEXT_NUM_KEYS = new Set([
  "statusCode",
  "durationMs",
  "elapsedMs",
  "attempt",
  "retryAttempts",
  "exitCode",
  "turns",
  "turn",
  "step",
  "queueDepth",
  "messageCount",
  "transcriptMessageCount",
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

export interface TelemetryProxyEnv {
  POSTHOG_API_KEY: string;
  POSTHOG_HOST?: string;
}

interface SanitizedEvent {
  event: "$exception" | "lilac_agent_run";
  distinct_id: string;
  timestamp?: string;
  properties: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asEnum(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function asRegexString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isValidIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function asParamPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
  const segments = value.split(".");
  if (segments.length === 0 || segments.length > 8) return undefined;
  for (const seg of segments) {
    if (!/^\d{1,5}$/u.test(seg) && !ALLOWED_PARAM_PATH_SEGMENTS.has(seg)) return undefined;
  }
  return value;
}

function asToolLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (ALLOWED_BUILTIN_TOOLS.has(value) || SAFE_EXT_TOOL_RE.test(value)) return value;
  return undefined;
}

function asNumberArray(value: unknown, maxItems: number): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const item of value.slice(0, maxItems)) {
    const num = asNumber(item);
    if (num !== undefined && Number.isInteger(num) && num >= 0) out.push(num);
  }
  return out;
}

function sanitizeContextFields(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let count = 0;

  for (const [key, raw] of Object.entries(value)) {
    if (CONTEXT_BOOL_KEYS.has(key)) {
      const b = asBoolean(raw);
      if (b !== undefined) {
        out[key] = b;
        count += 1;
      }
      continue;
    }
    if (CONTEXT_NUM_KEYS.has(key)) {
      const n = asNumber(raw);
      if (n !== undefined) {
        out[key] = n;
        count += 1;
      }
      continue;
    }
    if (key === "toolName") {
      const t = asToolLabel(raw);
      if (t) {
        out[key] = t;
        count += 1;
      }
      continue;
    }
    if (key === "providerCode") {
      const n = asNumber(raw);
      if (n !== undefined) {
        out[key] = n;
        count += 1;
        continue;
      }
      const code = asEnum(raw, ALLOWED_ERROR_CODES);
      if (code) {
        out[key] = code;
        count += 1;
      }
      continue;
    }

    let safeStr: string | undefined;
    switch (key) {
      case "client":
      case "requestClient":
      case "surface":
        safeStr = asEnum(raw, ALLOWED_SURFACES);
        break;
      case "provider":
        safeStr = asEnum(raw, ALLOWED_PROVIDERS);
        break;
      case "transport":
        safeStr = asEnum(raw, ALLOWED_TRANSPORTS);
        break;
      case "failureKind":
        safeStr = asEnum(raw, ALLOWED_FAILURE_KINDS);
        break;
      case "failureClass":
        safeStr = asEnum(raw, ALLOWED_FAILURE_CLASSES);
        break;
      case "failureCode":
      case "code":
      case "errno":
      case "syscall":
        safeStr = asEnum(raw, ALLOWED_ERROR_CODES);
        break;
      case "providerType":
        safeStr = asEnum(raw, ALLOWED_PROVIDER_ERROR_TYPES);
        break;
      case "finishReason":
        safeStr = asEnum(raw, ALLOWED_FINISH_REASONS);
        break;
      case "costEstimateStatus":
        safeStr = asEnum(raw, ALLOWED_COST_STATUSES);
        break;
      case "errorTag":
      case "aiErrorName":
        safeStr = asEnum(raw, ALLOWED_ERROR_IDENTIFIERS);
        break;
      case "errorKind":
        safeStr = asEnum(raw, ALLOWED_TOOL_FAILURE_KINDS);
        break;
      case "errorCode":
        safeStr = asRegexString(raw, SAFE_TOOL_ERROR_CODE_RE);
        break;
      case "builtinCallableId":
        safeStr = asRegexString(raw, SAFE_BUILTIN_CALLABLE_ID_RE);
        break;
      default:
        break;
    }
    if (safeStr) {
      out[key] = safeStr;
      count += 1;
    }
  }
  // Only built-in tools define their failure codes in code; other sources can put arbitrary text there.
  if (out["errorCode"] !== undefined && out["builtinCallableId"] === undefined) {
    delete out["errorCode"];
    count -= 1;
  }
  return count > 0 ? out : undefined;
}

function sanitizeBreadcrumbs(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const raw of value.slice(0, MAX_BREADCRUMBS)) {
    if (!isPlainObject(raw)) continue;
    const ts = asNumber(raw["ts"]);
    const level = asEnum(raw["level"], ALLOWED_LEVELS);
    const event = asEnum(raw["event"], ALLOWED_STATIC_EVENTS);
    if (ts === undefined || !level || !event) continue;

    const crumb: Record<string, unknown> = { ts, level, event };
    const deltaMs = asNumber(raw["deltaMs"]);
    if (deltaMs !== undefined) crumb["deltaMs"] = deltaMs;
    const moduleName = asRegexString(raw["module"], SAFE_MODULE_RE);
    if (moduleName) crumb["module"] = moduleName;
    const requestHash = asRegexString(raw["requestHash"], HASH_16_RE);
    if (requestHash) crumb["requestHash"] = requestHash;
    const sessionHash = asRegexString(raw["sessionHash"], HASH_16_RE);
    if (sessionHash) crumb["sessionHash"] = sessionHash;
    const runHash = asRegexString(raw["runHash"], HASH_16_RE);
    if (runHash) crumb["runHash"] = runHash;
    const toolCallHash = asRegexString(raw["toolCallHash"], HASH_16_RE);
    if (toolCallHash) crumb["toolCallHash"] = toolCallHash;
    const fields = sanitizeContextFields(raw["fields"]);
    if (fields) crumb["fields"] = fields;
    out.push(crumb);
  }
  return out;
}

function sanitizeProviderOptionKeys(value: unknown): Record<string, string[]> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string[]> = {};
  let count = 0;
  for (const [ns, keys] of Object.entries(value).slice(0, 12)) {
    if (!ALLOWED_PROVIDER_NAMESPACES.has(ns) && !SAFE_HASHED_NS_RE.test(ns)) continue;
    if (!Array.isArray(keys)) continue;
    const safeKeys: string[] = [];
    for (const k of keys.slice(0, 32)) {
      if (
        typeof k === "string" &&
        (ALLOWED_PROVIDER_OPT_KEYS.has(k) || SAFE_HASHED_KEY_RE.test(k))
      ) {
        safeKeys.push(k);
      }
    }
    out[ns] = safeKeys;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

function sanitizeInputShape(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return ALLOWED_INPUT_LEAF_TYPES.has(value) ? value : undefined;
  }
  if (depth > 3 || !isPlainObject(value)) return undefined;
  const kind = value["kind"];
  if (kind === "array") {
    const len = asNumber(value["len"]);
    if (len === undefined) return undefined;
    const item = sanitizeInputShape(value["item"], depth + 1);
    return { kind: "array", len, ...(item !== undefined ? { item } : {}) };
  }
  if (kind === "object") {
    const keyCount = asNumber(value["keyCount"]);
    if (keyCount === undefined) return undefined;
    const out: Record<string, unknown> = { kind: "object", keyCount };
    const truncated = asBoolean(value["truncated"]);
    if (truncated !== undefined) out["truncated"] = truncated;
    if (isPlainObject(value["keys"])) {
      const safeKeys: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value["keys"]).slice(0, 20)) {
        if (!ALLOWED_BUILTIN_ARG_KEYS.has(k) && !SAFE_HASHED_KEY_RE.test(k)) continue;
        const safeV = sanitizeInputShape(v, depth + 1);
        if (safeV !== undefined) safeKeys[k] = safeV;
      }
      out["keys"] = safeKeys;
    }
    return out;
  }
  return undefined;
}

function sanitizeTranscriptPart(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const type = asEnum(value["type"], ALLOWED_PART_TYPES);
  if (!type) return null;
  const part: Record<string, unknown> = { type };
  const len = asNumber(value["len"]);
  if (len !== undefined) part["len"] = len;
  const empty = asBoolean(value["empty"]);
  if (empty !== undefined) part["empty"] = empty;
  const tool = asToolLabel(value["tool"]);
  if (tool) part["tool"] = tool;
  const callId = asRegexString(value["callId"], SAFE_CALL_ID_ALIAS_RE);
  if (callId) part["callId"] = callId;
  if (isPlainObject(value["callIdShape"])) {
    const csLen = asNumber(value["callIdShape"]["len"]);
    const csPrefix = asEnum(value["callIdShape"]["prefix"], ALLOWED_CALL_ID_PREFIXES);
    const csChars = asRegexString(value["callIdShape"]["chars"], ALLOWED_CALL_ID_CHARS_RE);
    if (csLen !== undefined && csPrefix && csChars) {
      part["callIdShape"] = { len: csLen, prefix: csPrefix, chars: csChars };
    }
  }
  const inputShape = sanitizeInputShape(value["inputShape"], 0);
  if (inputShape !== undefined) part["inputShape"] = inputShape;
  const providerExecuted = asBoolean(value["providerExecuted"]);
  if (providerExecuted !== undefined) part["providerExecuted"] = providerExecuted;
  const outputType = asEnum(value["outputType"], ALLOWED_OUTPUT_TYPES);
  if (outputType) part["outputType"] = outputType;
  if (Array.isArray(value["outputItemTypes"])) {
    const items: string[] = [];
    for (const item of value["outputItemTypes"].slice(0, 20)) {
      const safeItem = asRegexString(item, ALLOWED_OUTPUT_ITEM_TYPE_RE);
      if (safeItem) items.push(safeItem);
    }
    if (items.length > 0) part["outputItemTypes"] = items;
  }
  const outputLen = asNumber(value["outputLen"]);
  if (outputLen !== undefined) part["outputLen"] = outputLen;
  const isError = asBoolean(value["isError"]);
  if (isError !== undefined) part["isError"] = isError;
  const mediaType = asEnum(value["mediaType"], ALLOWED_MEDIA_TYPES);
  if (mediaType) part["mediaType"] = mediaType;
  const dataKind = asEnum(value["dataKind"], ALLOWED_DATA_KINDS);
  if (dataKind) part["dataKind"] = dataKind;
  const hasSignature = asBoolean(value["hasSignature"]);
  if (hasSignature !== undefined) part["hasSignature"] = hasSignature;
  const hasEncryptedContent = asBoolean(value["hasEncryptedContent"]);
  if (hasEncryptedContent !== undefined) part["hasEncryptedContent"] = hasEncryptedContent;
  const hasThoughtSignature = asBoolean(value["hasThoughtSignature"]);
  if (hasThoughtSignature !== undefined) part["hasThoughtSignature"] = hasThoughtSignature;
  const customKind = asEnum(value["customKind"], ALLOWED_CUSTOM_KINDS);
  if (customKind) part["customKind"] = customKind;
  const phase = asEnum(value["phase"], ALLOWED_PHASES);
  if (phase) part["phase"] = phase;
  const providerOptions = sanitizeProviderOptionKeys(value["providerOptions"]);
  if (providerOptions) part["providerOptions"] = providerOptions;
  return part;
}

function isValidStackFrame(value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_STACK_FRAME_RE.test(value)) return false;
  const colonIdx = value.indexOf(":");
  const filePath = colonIdx > 0 ? value.slice(0, colonIdx) : value;
  return !filePath.split("/").some((seg) => seg.length === 0 || seg === "." || seg === "..");
}

function asValidRoleTrace(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  if (value.length === 0) return "";
  let body = value;
  let truncated = false;
  if (body.endsWith("...")) {
    body = body.slice(0, -3);
    truncated = true;
    if (!body.endsWith(")")) return undefined;
  }
  const segments = body.split("),");
  if (segments.length === 0 || segments.length > 500) return undefined;
  for (let i = 0; i < segments.length; i += 1) {
    const rawSeg = segments[i];
    if (!rawSeg) return undefined;
    const seg = i < segments.length - 1 ? `${rawSeg})` : rawSeg;
    const match = ROLE_TRACE_SEGMENT_RE.exec(seg);
    if (!match) return undefined;
    const inner = match[1] ?? "";
    if (inner.length === 0) continue;
    const tokens = inner.split(",");
    for (const token of tokens) {
      if (!ROLE_TRACE_PART_RE.test(token)) return undefined;
    }
  }
  return truncated ? `${body}...` : body;
}

function asValidAnomaly(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 96 && STRICT_ANOMALY_RE.test(value)
    ? value
    : undefined;
}

function sanitizeTranscriptShape(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const totalMessages = asNumber(value["totalMessages"]);
  const roleTrace = asValidRoleTrace(value["roleTrace"]);
  const errorCategory = asEnum(value["errorCategory"], ALLOWED_ERROR_CATEGORIES);
  if (totalMessages === undefined || roleTrace === undefined || !errorCategory) return undefined;

  const anomalies: string[] = [];
  if (Array.isArray(value["anomalies"])) {
    for (const item of value["anomalies"].slice(0, MAX_ANOMALIES)) {
      const safe = asValidAnomaly(item);
      if (safe) anomalies.push(safe);
    }
  }

  const shape: Record<string, unknown> = {
    totalMessages,
    roleTrace,
    errorCategory,
    anomalies,
  };

  if (isPlainObject(value["target"])) {
    const target: Record<string, unknown> = {};
    const provider = asEnum(value["target"]["provider"], ALLOWED_PROVIDERS);
    if (provider) target["provider"] = provider;
    const transport = asEnum(value["target"]["transport"], ALLOWED_TRANSPORTS);
    if (transport) target["transport"] = transport;
    const profileFamily = asEnum(value["target"]["profileFamily"], ALLOWED_PROFILE_FAMILIES);
    if (profileFamily) target["profileFamily"] = profileFamily;
    const routed = asBoolean(value["target"]["routed"]);
    if (routed !== undefined) target["routed"] = routed;
    shape["target"] = target;
  }

  if (isPlainObject(value["provenance"])) {
    const prov: Record<string, unknown> = {};
    const source = asEnum(value["provenance"]["source"], ALLOWED_SOURCES);
    if (source) prov["source"] = source;
    const compacted = asBoolean(value["provenance"]["compacted"]);
    if (compacted !== undefined) prov["compacted"] = compacted;
    const didSwitchModel = asBoolean(value["provenance"]["didSwitchModel"]);
    if (didSwitchModel !== undefined) prov["didSwitchModel"] = didSwitchModel;
    const step = asNumber(value["provenance"]["step"]);
    if (step !== undefined) prov["step"] = step;
    const sendKind = asEnum(value["provenance"]["sendKind"], ALLOWED_SEND_KINDS);
    if (sendKind) prov["sendKind"] = sendKind;
    const usedPreviousResponseId = asBoolean(value["provenance"]["usedPreviousResponseId"]);
    if (usedPreviousResponseId !== undefined) {
      prov["usedPreviousResponseId"] = usedPreviousResponseId;
    }
    const sentItemCount = asNumber(value["provenance"]["sentItemCount"]);
    if (sentItemCount !== undefined) prov["sentItemCount"] = sentItemCount;
    shape["provenance"] = prov;
  }

  const referencedMessageIndices = asNumberArray(value["referencedMessageIndices"], 16);
  if (referencedMessageIndices && referencedMessageIndices.length > 0) {
    shape["referencedMessageIndices"] = referencedMessageIndices;
  }
  const referencedInputIndices = asNumberArray(value["referencedInputIndices"], 16);
  if (referencedInputIndices && referencedInputIndices.length > 0) {
    shape["referencedInputIndices"] = referencedInputIndices;
  }
  if (Array.isArray(value["referencedCallIds"])) {
    const callIds: string[] = [];
    for (const id of value["referencedCallIds"].slice(0, 16)) {
      const safe = asRegexString(id, SAFE_CALL_ID_ALIAS_RE);
      if (safe) callIds.push(safe);
    }
    if (callIds.length > 0) shape["referencedCallIds"] = callIds;
  }
  const referencedParamPath = asParamPath(value["referencedParamPath"]);
  if (referencedParamPath) shape["referencedParamPath"] = referencedParamPath;

  if (isPlainObject(value["preProjectionSummary"])) {
    const preTotal = asNumber(value["preProjectionSummary"]["totalMessages"]);
    const preTrace = asValidRoleTrace(value["preProjectionSummary"]["roleTrace"]);
    if (preTotal !== undefined && preTrace !== undefined) {
      shape["preProjectionSummary"] = { totalMessages: preTotal, roleTrace: preTrace };
    }
  }

  const windowOut: Array<Record<string, unknown>> = [];
  if (Array.isArray(value["window"])) {
    for (const rawMsg of value["window"].slice(0, MAX_WINDOW_MESSAGES)) {
      if (!isPlainObject(rawMsg)) continue;
      const i = asNumber(rawMsg["i"]);
      const role = asEnum(rawMsg["role"], ALLOWED_ROLES);
      const contentKind = asEnum(rawMsg["contentKind"], ALLOWED_CONTENT_KINDS);
      if (i === undefined || !role || !contentKind) continue;
      const msg: Record<string, unknown> = { i, role, contentKind };
      const textLen = asNumber(rawMsg["textLen"]);
      if (textLen !== undefined) msg["textLen"] = textLen;
      const empty = asBoolean(rawMsg["empty"]);
      if (empty !== undefined) msg["empty"] = empty;
      const providerOptions = sanitizeProviderOptionKeys(rawMsg["providerOptions"]);
      if (providerOptions) msg["providerOptions"] = providerOptions;
      if (Array.isArray(rawMsg["parts"])) {
        const parts: Array<Record<string, unknown>> = [];
        for (const rawPart of rawMsg["parts"].slice(0, MAX_PARTS_PER_MESSAGE)) {
          const clean = sanitizeTranscriptPart(rawPart);
          if (clean) parts.push(clean);
        }
        msg["parts"] = parts;
      }
      windowOut.push(msg);
    }
  }
  shape["window"] = windowOut;

  return shape;
}

function sanitizeCommonProps(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { $ip: null };
  if (raw["$lib"] === "lilac-core") out["$lib"] = "lilac-core";
  const libVersion = asRegexString(raw["$lib_version"], SAFE_VERSION_RE);
  if (libVersion) out["$lib_version"] = libVersion;
  const commit = asRegexString(raw["lilac_commit"], SAFE_COMMIT_RE);
  if (commit) out["lilac_commit"] = commit;
  const os = asEnum(raw["os"], ALLOWED_OS);
  if (os) out["os"] = os;
  const arch = asEnum(raw["arch"], ALLOWED_ARCH);
  if (arch) out["arch"] = arch;
  const bunVersion = asRegexString(raw["bun_version"], SAFE_VERSION_RE);
  if (bunVersion) out["bun_version"] = bunVersion;
  const docker = asBoolean(raw["docker"]);
  if (docker !== undefined) out["docker"] = docker;
  return out;
}

function isValidToolFailureCode(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator <= 0) return false;
  return (
    ALLOWED_TOOL_FAILURE_KINDS.has(value.slice(0, separator)) &&
    SAFE_TOOL_ERROR_CODE_RE.test(value.slice(separator + 1))
  );
}

// Expands a legacy truncated event so old and new clients share one PostHog grouping key.
function canonicalFingerprintEvent(value: string): string | undefined {
  if (ALLOWED_STATIC_EVENTS.has(value)) return value;
  if (value.length !== LEGACY_FINGERPRINT_EVENT_LENGTH) return undefined;
  const matches = [...ALLOWED_STATIC_EVENTS].filter(
    (event) => event.slice(0, LEGACY_FINGERPRINT_EVENT_LENGTH) === value,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function canonicalFingerprintLocation(value: string): string | undefined {
  if (isValidStackFrame(value)) return value;
  return canonicalFingerprintEvent(value);
}

function isValidFingerprintDetail(value: string): boolean {
  return (
    asValidAnomaly(value) !== undefined ||
    ALLOWED_ERROR_CATEGORIES.has(value) ||
    SAFE_BUILTIN_CALLABLE_ID_RE.test(value)
  );
}

function sanitizeFingerprint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) return undefined;
  const parts = value.split("|");
  if (parts.length !== 5) return undefined;
  const [mod, errId, code, locOrEvent, detail] = parts;
  if (!mod || !SAFE_MODULE_RE.test(mod)) return undefined;
  if (!errId || (errId !== "error" && !ALLOWED_ERROR_IDENTIFIERS.has(errId))) return undefined;
  const isAllowedBuiltinFailureCode =
    code !== undefined &&
    isValidToolFailureCode(code) &&
    SAFE_BUILTIN_CALLABLE_ID_RE.test(detail ?? "");
  if (
    code &&
    !ALLOWED_ERROR_CODES.has(code) &&
    !/^\d{3}$/u.test(code) &&
    !isAllowedBuiltinFailureCode
  ) {
    return undefined;
  }
  const location = locOrEvent ? canonicalFingerprintLocation(locOrEvent) : "";
  if (location === undefined) return undefined;
  if (detail && !isValidFingerprintDetail(detail)) return undefined;
  const canonical = [mod, errId, code, location, detail].join("|");
  return canonical.length <= 240 ? canonical : undefined;
}

function sanitizeErrorProperties(raw: Record<string, unknown>): Record<string, unknown> {
  const out = sanitizeCommonProps(raw);
  if (Array.isArray(raw["surfaces"])) {
    const surfaces: string[] = [];
    for (const s of raw["surfaces"].slice(0, 8)) {
      const safe = asEnum(s, ALLOWED_SURFACES);
      if (safe) surfaces.push(safe);
    }
    if (surfaces.length > 0) out["surfaces"] = surfaces;
  }
  const blobBackend = asEnum(raw["blob_backend"], ALLOWED_BLOB_BACKENDS);
  if (blobBackend) out["blob_backend"] = blobBackend;
  const fingerprint = sanitizeFingerprint(raw["fingerprint"]);
  if (fingerprint) out["fingerprint"] = fingerprint;
  const level = asEnum(raw["level"], ALLOWED_ERROR_LEVELS);
  if (level) out["level"] = level;
  const moduleName = asRegexString(raw["module"], SAFE_MODULE_RE);
  if (moduleName) out["module"] = moduleName;
  const eventMessage = asEnum(raw["event_message"], ALLOWED_STATIC_EVENTS);
  if (eventMessage) out["event_message"] = eventMessage;
  const errorTag = asEnum(raw["error_tag"], ALLOWED_ERROR_IDENTIFIERS);
  if (errorTag) out["error_tag"] = errorTag;
  const errorName = asEnum(raw["error_name"], ALLOWED_ERROR_IDENTIFIERS);
  if (errorName) out["error_name"] = errorName;
  const errorCode = asEnum(raw["error_code"], ALLOWED_ERROR_CODES);
  if (errorCode) out["error_code"] = errorCode;
  const requestHash = asRegexString(raw["request_hash"], HASH_16_RE);
  if (requestHash) out["request_hash"] = requestHash;
  const sessionHash = asRegexString(raw["session_hash"], HASH_16_RE);
  if (sessionHash) out["session_hash"] = sessionHash;
  const runHash = asRegexString(raw["run_hash"], HASH_16_RE);
  if (runHash) out["run_hash"] = runHash;
  if (Array.isArray(raw["stack_frames"])) {
    const frames: string[] = [];
    for (const frame of raw["stack_frames"].slice(0, MAX_STACK_FRAMES)) {
      if (isValidStackFrame(frame)) frames.push(frame);
    }
    if (frames.length > 0) out["stack_frames"] = frames;
  }
  const suppressed = asNumber(raw["suppressed_duplicates"]);
  if (suppressed !== undefined) out["suppressed_duplicates"] = suppressed;
  const context = sanitizeContextFields(raw["context"]);
  if (context) out["context"] = context;
  const transcriptShape = sanitizeTranscriptShape(raw["transcript_shape"]);
  if (transcriptShape) out["transcript_shape"] = transcriptShape;
  const breadcrumbs = sanitizeBreadcrumbs(raw["breadcrumbs"]);
  if (breadcrumbs) out["breadcrumbs"] = breadcrumbs;
  return { ...out, ...buildExceptionProperties(out) };
}

function exceptionType(props: Record<string, unknown>): string {
  const errorId = asNonEmptyString(props["error_tag"]) ?? asNonEmptyString(props["error_name"]);
  if (errorId) return errorId;
  const eventMessage = asNonEmptyString(props["event_message"]);
  if (eventMessage && !GENERIC_LOG_EVENTS.has(eventMessage)) return eventMessage;
  return `${asNonEmptyString(props["module"]) ?? "lilac"} error`;
}

function exceptionCode(
  props: Record<string, unknown>,
  context: Record<string, unknown>,
): string | undefined {
  const kind = asNonEmptyString(context["errorKind"]);
  const code = asNonEmptyString(context["errorCode"]);
  if (kind && code) return `${kind}/${code}`;
  return asNonEmptyString(props["error_code"]) ?? code ?? kind;
}

// Built only from values that already passed the allowlists above.
function exceptionValue(props: Record<string, unknown>, type: string): string {
  const context = isPlainObject(props["context"]) ? props["context"] : {};
  const eventMessage = asNonEmptyString(props["event_message"]);
  const callable = asNonEmptyString(context["builtinCallableId"]);
  const statusCode = asNumber(context["statusCode"]);
  const details = [
    eventMessage && eventMessage !== type ? eventMessage : undefined,
    exceptionCode(props, context),
    callable ? `in ${callable}` : undefined,
    statusCode !== undefined ? `HTTP ${statusCode}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const moduleName = asNonEmptyString(props["module"]) ?? "lilac";
  return details.length > 0 ? `${moduleName}: ${details.join(" ")}` : moduleName;
}

// Lilac sends frames innermost first; PostHog expects the innermost frame last.
function exceptionFrames(props: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(props["stack_frames"])) return [];
  const frames: Array<Record<string, unknown>> = [];
  for (const frame of props["stack_frames"]) {
    if (typeof frame !== "string") continue;
    const [filename, lineno, colno] = frame.split(":");
    if (!filename) continue;
    frames.push({
      platform: "node:javascript",
      filename,
      function: "?",
      ...(lineno ? { lineno: Number(lineno) } : {}),
      ...(colno ? { colno: Number(colno) } : {}),
      in_app: !filename.startsWith("node_modules/"),
    });
  }
  return frames.reverse();
}

function buildExceptionProperties(props: Record<string, unknown>): Record<string, unknown> {
  const type = exceptionType(props);
  const frames = exceptionFrames(props);
  const fingerprint = asNonEmptyString(props["fingerprint"]);
  return {
    $exception_level: asEnum(props["level"], ALLOWED_ERROR_LEVELS) ?? "error",
    ...(fingerprint ? { $exception_fingerprint: fingerprint } : {}),
    $exception_list: [
      {
        type,
        value: exceptionValue(props, type),
        mechanism: { type: "generic", handled: true, synthetic: frames.length === 0 },
        ...(frames.length > 0 ? { stacktrace: { type: "raw", frames } } : {}),
      },
    ],
  };
}

function sanitizeAgentRunProperties(raw: Record<string, unknown>): Record<string, unknown> {
  const out = sanitizeCommonProps(raw);
  const status = asEnum(raw["status"], ALLOWED_RUN_STATUSES);
  if (status) out["status"] = status;
  const surface = asEnum(raw["surface"], ALLOWED_SURFACES);
  if (surface) out["surface"] = surface;
  const provider = asEnum(raw["provider"], ALLOWED_PROVIDERS);
  if (provider) out["provider"] = provider;
  const modelId = asNonEmptyString(raw["model_id"]);
  if (modelId) out["model_id"] = modelId;
  const modelSpec = asNonEmptyString(raw["model_spec"]);
  if (modelSpec) out["model_spec"] = modelSpec;
  const transport = asEnum(raw["transport"], ALLOWED_TRANSPORTS);
  if (transport) out["transport"] = transport;
  const errorTag = asEnum(raw["error_tag"], ALLOWED_ERROR_IDENTIFIERS);
  if (errorTag) out["error_tag"] = errorTag;

  const boolFields = [
    "is_subagent",
    "is_workflow",
    "is_heartbeat",
    "did_switch_model",
    "compacted",
  ];
  for (const key of boolFields) {
    const val = asBoolean(raw[key]);
    if (val !== undefined) out[key] = val;
  }
  const numFields = [
    "duration_ms",
    "ttft_ms",
    "turns",
    "tool_call_count",
    "transcript_message_count",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "no_cache_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "text_tokens",
    "reasoning_tokens",
    "estimated_cost_usd",
    "status_code",
  ];
  for (const key of numFields) {
    const val = asNumber(raw[key]);
    if (val !== undefined) out[key] = val;
  }
  const requestHash = asRegexString(raw["request_hash"], HASH_16_RE);
  if (requestHash) out["request_hash"] = requestHash;
  const sessionHash = asRegexString(raw["session_hash"], HASH_16_RE);
  if (sessionHash) out["session_hash"] = sessionHash;
  return out;
}

function sanitizeBatchItem(item: unknown): SanitizedEvent | null {
  if (!isPlainObject(item)) return null;
  const event = item["event"];
  const distinctId = item["distinct_id"];
  if (event !== "lilac_error" && event !== "lilac_agent_run") return null;
  if (typeof distinctId !== "string" || !DISTINCT_ID_RE.test(distinctId)) {
    return null;
  }

  let timestamp: string | undefined;
  if ("timestamp" in item && item["timestamp"] !== undefined) {
    if (typeof item["timestamp"] !== "string" || !isValidIsoTimestamp(item["timestamp"])) {
      return null;
    }
    timestamp = item["timestamp"];
  }

  const rawProps = isPlainObject(item["properties"]) ? item["properties"] : {};
  const properties =
    event === "lilac_error"
      ? sanitizeErrorProperties(rawProps)
      : sanitizeAgentRunProperties(rawProps);

  return {
    event: event === "lilac_error" ? "$exception" : event,
    distinct_id: distinctId,
    ...(timestamp ? { timestamp } : {}),
    properties,
  };
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<
  { readonly status: "ok"; readonly bytes: Uint8Array } | { readonly status: "empty" | "too_large" }
> {
  const body = request.body;
  if (!body) return { status: "empty" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { status: "too_large" };
    }
    chunks.push(value);
  }

  if (total === 0) return { status: "empty" };
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", bytes: merged };
}

export async function handleTelemetryProxyRequest(
  request: Request,
  env: TelemetryProxyEnv,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return new Response("ok", { status: 200 });
  }

  if (url.pathname !== "/batch" && url.pathname !== "/batch/") {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }

  const bodyOutcome = await readBoundedBody(request, MAX_BODY_BYTES);
  if (bodyOutcome.status !== "ok") {
    return new Response(bodyOutcome.status === "too_large" ? "Payload Too Large" : "Bad Request", {
      status: bodyOutcome.status === "too_large" ? 413 : 400,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyOutcome.bytes));
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed["batch"])) {
    return new Response("Expected batch array", { status: 400 });
  }

  if (parsed["batch"].length === 0 || parsed["batch"].length > MAX_BATCH_SIZE) {
    return new Response("Invalid batch size", { status: 400 });
  }

  const sanitizedBatch: SanitizedEvent[] = [];
  for (const item of parsed["batch"]) {
    const clean = sanitizeBatchItem(item);
    if (clean) sanitizedBatch.push(clean);
  }

  if (sanitizedBatch.length === 0) {
    return new Response("No allowed events in batch", { status: 400 });
  }

  if (!env.POSTHOG_API_KEY) {
    return new Response("Telemetry proxy misconfigured", { status: 500 });
  }

  const posthogHost = (env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/u, "");
  const upstreamBody = JSON.stringify({
    api_key: env.POSTHOG_API_KEY,
    batch: sanitizedBatch,
  });

  // Forward with a clean header set (no CF-Connecting-IP, X-Forwarded-For, cookies, or User-Agent).
  const upstreamResponse = await fetchFn(`${posthogHost}/batch/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: upstreamBody,
  });

  return new Response(null, { status: upstreamResponse.ok ? 202 : 502 });
}

export default {
  fetch(request: Request, env: TelemetryProxyEnv): Promise<Response> {
    return handleTelemetryProxyRequest(request, env);
  },
};
