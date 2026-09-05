import type { ExternalToolExecutionOutcome } from "@stanley2058/lilac-agent";
import { claudeCodeExecutableSettings } from "@stanley2058/lilac-utils/claude-code-executable";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils/runtime-utils";
import type { LanguageModel, ToolSet } from "ai";
import {
  createClaudeCode,
  getSessionInfo,
  type ClaudeCodeQueryController,
  type ClaudeCodeSettings,
  type MessageInjector,
  type SpawnedProcess,
  type SpawnOptions,
} from "ai-sdk-provider-claude-code";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { spawn } from "node:child_process";
import { z } from "zod";

import {
  createClaudeCodeToolBridgeResult,
  validateClaudeCodeBuiltInToolsResult,
  type ClaudeCodeToolBridgeCreateError,
  type ClaudeCodeBuiltInTool,
  type ClaudeCodeToolCatalogMetadataMap,
  type ClaudeCodeToolExecutionRequest,
} from "./claude-code-tools";

const MAX_CALLBACK_ERROR_CHARS = 2_000;
const MAX_PROVIDER_WARNINGS = 32;
const MAX_PROVIDER_WARNING_CHARS = 1_000;
// Agent SDK cleanup waits 2s before SIGTERM and schedules SIGKILL 5s later.
// This outer bound leaves 3s for the OS exit event; expiry fails promotion closed.
const PROCESS_EXIT_PROOF_TIMEOUT_MS = 10_000;

const uuidSchema = z.uuid();
const nativeSessionStartSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ephemeral") }).strict(),
  z.object({ mode: z.literal("fresh"), sessionId: uuidSchema }).strict(),
  z
    .object({
      mode: z.literal("fork"),
      baseSessionId: uuidSchema,
      sessionId: uuidSchema,
      expectedSourceLastModified: z.number().finite().nonnegative(),
    })
    .strict()
    .refine(({ baseSessionId, sessionId }) => baseSessionId !== sessionId, {
      message: "fork source and candidate session IDs must be distinct",
      path: ["sessionId"],
    }),
]);

const sdkMessageTypeSchema = z.object({ type: z.string() }).passthrough();
const sdkInitMessageSchema = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    session_id: z.string().min(1),
    model: z.string().min(1),
  })
  .passthrough();
const sdkSuccessResultMessageSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    session_id: z.string().min(1),
  })
  .passthrough();
const stopHookInputSchema = z.object({ hook_event_name: z.literal("Stop") }).passthrough();
const contextUsageSchema = z
  .object({
    totalTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
  })
  .refine(({ totalTokens, maxTokens }) => totalTokens <= maxTokens, {
    message: "totalTokens must not exceed maxTokens",
  });
const sessionInfoSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  lastModified: z.number().finite().nonnegative(),
});

type ClaudeCodeQueryControllerBoundary = {
  readonly rawQuery: Pick<ClaudeCodeQueryController["rawQuery"], "return">;
  getContextUsage(): Promise<unknown>;
  interrupt(): Promise<void>;
};

type ClaudeCodeRunModelSettings = Omit<
  ClaudeCodeSettings,
  "onQueryControllerCreated" | "onSdkMessage"
> & {
  readonly onQueryControllerCreated?: (
    controller: ClaudeCodeQueryControllerBoundary,
  ) => void | PromiseLike<void>;
  readonly onSdkMessage?: (message: object) => void | PromiseLike<void>;
};

type CreateClaudeCodeModel = (
  modelId: string,
  settings: ClaudeCodeRunModelSettings,
) => LanguageModel;
type SpawnClaudeCodeProcess = NonNullable<ClaudeCodeSettings["spawnClaudeCodeProcess"]>;

type TrackedClaudeProcess = {
  readonly waitForExit: () => Promise<ResultType<void, ClaudeCodeRunExternalFailure>>;
};

type TrackedQueryController = {
  readonly settleResult: () => Promise<ResultType<void, ClaudeCodeRunCleanupFailed>>;
};

export class ClaudeCodeRunInvalidConfiguration extends TaggedError(
  "ClaudeCodeRunInvalidConfiguration",
)<{
  readonly message: string;
}> {}

export class ClaudeCodeRunExternalFailure extends TaggedError("ClaudeCodeRunExternalFailure")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ClaudeCodeRunCleanupFailed extends TaggedError("ClaudeCodeRunCleanupFailed")<{
  readonly failures: readonly ClaudeCodeRunExternalFailure[];
  readonly message: string;
}> {}

export class ClaudeCodeRunOperationAndCleanupFailed extends TaggedError(
  "ClaudeCodeRunOperationAndCleanupFailed",
)<{
  readonly operationError: ClaudeCodeRunMaterializationError;
  readonly cleanupError: ClaudeCodeRunCleanupFailed;
  readonly message: string;
}> {}

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

type OpaqueClaudeValue = {} | null | undefined;

function capturedClaudeError(cause: OpaqueClaudeValue, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

function captureClaudeOperation<T>(operation: () => Awaited<T>): ResultType<T, OpaqueClaudeValue> {
  return Result.try<T, OpaqueClaudeValue>({ try: operation, catch: (cause) => cause });
}

function captureClaudePromise<T>(
  operation: () => Promise<T>,
): Promise<ResultType<T, OpaqueClaudeValue>> {
  return Result.tryPromise<T, OpaqueClaudeValue>({ try: operation, catch: (cause) => cause });
}

export type ClaudeCodeRunMaterializationError =
  | ClaudeCodeRunInvalidConfiguration
  | ClaudeNativeSessionPreflightError
  | ClaudeCodeRunExternalFailure
  | ClaudeCodeToolBridgeCreateError;

export type ClaudeCodeRunFinalizationError =
  | ClaudeCodeRunInvalidConfiguration
  | ClaudeCodeRunCleanupFailed;

function cleanupFailureToAggregateError(error: ClaudeCodeRunCleanupFailed): AggregateError {
  return new AggregateError(error.failures, error.message);
}

export type ClaudeNativeSessionStart =
  | {
      readonly mode: "ephemeral";
    }
  | {
      readonly mode: "fresh";
      readonly sessionId: string;
    }
  | {
      readonly mode: "fork";
      readonly baseSessionId: string;
      readonly sessionId: string;
      readonly expectedSourceLastModified: number;
    };

export type ClaudeNativeAttemptObservation = {
  readonly requestedSessionId: string | null;
  readonly sourceSessionId: string | null;
  readonly initSessionId: string | null;
  readonly resultSessionId: string | null;
  readonly contextTokens: number | null;
  readonly contextMaxTokens: number | null;
  readonly requestedModel: string;
  readonly initializedModel: string | null;
  readonly requestedReasoning: string | null;
  readonly providerWarnings: readonly string[];
  readonly invoked: boolean;
  readonly requiredObservabilityError: string | null;
  readonly callbackError: string | null;
};

export type ClaudeNativeSessionMetadata = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly lastModified: number;
};

export type ClaudeNativeSessionValidationIssue = {
  readonly code:
    | "source-preflight-read-failed"
    | "source-preflight-missing"
    | "source-preflight-invalid"
    | "source-preflight-id-mismatch"
    | "source-preflight-cwd-mismatch"
    | "source-preflight-last-modified-mismatch"
    | "init-session-id-missing"
    | "init-session-id-mismatch"
    | "init-session-id-conflict"
    | "result-session-id-missing"
    | "result-session-id-mismatch"
    | "result-session-id-conflict"
    | "context-usage-missing"
    | "candidate-read-failed"
    | "candidate-missing"
    | "candidate-invalid"
    | "candidate-id-mismatch"
    | "candidate-cwd-mismatch"
    | "source-final-read-failed"
    | "source-final-missing"
    | "source-final-invalid"
    | "source-final-id-mismatch"
    | "source-final-cwd-mismatch"
    | "source-last-modified-changed"
    | "required-observability-failed";
  readonly message: string;
};

type ClaudeNativeSessionFinalizationBase = {
  readonly observations: ClaudeNativeAttemptObservation;
  readonly candidate: ClaudeNativeSessionMetadata | null;
  readonly sourcePreflight: ClaudeNativeSessionMetadata | null;
  readonly sourceFinal: ClaudeNativeSessionMetadata | null;
};

export type ClaudeNativeSessionFinalization =
  | (ClaudeNativeSessionFinalizationBase & {
      readonly status: "promotable";
      readonly issues: readonly [];
    })
  | (ClaudeNativeSessionFinalizationBase & {
      readonly status: "unpromotable";
      readonly issues: readonly ClaudeNativeSessionValidationIssue[];
    });

export class ClaudeNativeSessionPreflightError extends TaggedError(
  "ClaudeNativeSessionPreflightError",
)<{
  readonly issues: readonly ClaudeNativeSessionValidationIssue[];
  readonly message: string;
}> {}

export type ClaudeNativeSessionLifecycle = {
  getObservation(): ClaudeNativeAttemptObservation;
  /**
   * Wait for currently scheduled native observability work without finalizing the session.
   * Init/result IDs and context usage are returned only when freshly observed since the previous wait.
   */
  waitForObservation(): Promise<ClaudeNativeAttemptObservation>;
  recordWarning(warning: string): void;
  finalizeResult(): Promise<
    ResultType<ClaudeNativeSessionFinalization, ClaudeCodeRunFinalizationError>
  >;
  finalize(): Promise<ClaudeNativeSessionFinalization>;
};

export type ClaudeCodeRunControl = {
  inject(message: string, onResult?: (delivered: boolean) => void): boolean;
  interruptResult(): Promise<ResultType<boolean, ClaudeCodeRunExternalFailure>>;
  interrupt(): Promise<boolean>;
  clearResult(): ResultType<void, ClaudeCodeRunCleanupFailed>;
  clear(): void;
};

export type MaterializedClaudeCodeRun = {
  agentModel: LanguageModel;
  /** Internal in-place candidate continuation model for persistent attempts. */
  continuationModel?: LanguageModel;
  createUtilityModelResult(): ResultType<LanguageModel, ClaudeCodeRunExternalFailure>;
  /** Compatibility adapter for callers that consume utility-model failures as throws. */
  createUtilityModel(): LanguageModel;
  control: ClaudeCodeRunControl;
  /** Present on bridge-created runs; optional for existing injected run implementations. */
  nativeSession?: ClaudeNativeSessionLifecycle;
  disposeResult(): Promise<ResultType<void, ClaudeCodeRunCleanupFailed>>;
  dispose(): Promise<void>;
};

export type ClaudeNativeQueryController = {
  getContextUsage(): Promise<unknown>;
  interrupt(): Promise<void>;
  /** End the query and prove its tracked subprocess emitted `exit`. */
  settle(): Promise<void>;
};

export type ClaudeNativeSessionInfoReader = (
  sessionId: string,
  options: { dir: string },
) => Promise<unknown>;

type SessionReadResult =
  | { readonly status: "ok"; readonly metadata: ClaudeNativeSessionMetadata }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly error: string }
  | { readonly status: "failed"; readonly error: string };

export type ClaudeSdkMessageProjection =
  | { readonly kind: "init"; readonly sessionId: string; readonly model: string }
  | { readonly kind: "success-result"; readonly sessionId: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "invalid"; readonly message: string };

function boundedText(value: string, maxChars: number): string {
  const text = value;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function boundedExternalFailure(error: ClaudeCodeRunExternalFailure, maxChars: number): string {
  return boundedText(opaqueErrorMessage(error.cause, "Opaque Claude SDK failure"), maxChars);
}

async function captureExternalOperation<T>(
  operation: string,
  effect: () => T | PromiseLike<T>,
): Promise<ResultType<T, ClaudeCodeRunExternalFailure>> {
  const captured = resultOutcome(await captureClaudePromise(async () => await effect()));
  if (captured.ok) return Result.ok(captured.value);
  if (Panic.is(captured.error)) throw captured.error;
  return Result.err(
    new ClaudeCodeRunExternalFailure({
      operation,
      cause: capturedClaudeError(captured.error, `${operation} failed`),
      message: `${operation} failed`,
    }),
  );
}

function captureExternalOperationSync(error: ClaudeCodeRunExternalFailure): never;
function captureExternalOperationSync<T>(
  operation: string,
  effect: () => Awaited<T>,
): ResultType<T, ClaudeCodeRunExternalFailure>;
function captureExternalOperationSync<T>(
  operation: string | ClaudeCodeRunExternalFailure,
  effect?: () => Awaited<T>,
): ResultType<T, ClaudeCodeRunExternalFailure> {
  if (operation instanceof ClaudeCodeRunExternalFailure) throw operation;
  if (effect === undefined) {
    return captureExternalOperationSync(
      new ClaudeCodeRunExternalFailure({
        operation,
        cause: new Error(`${operation} failed`),
        message: `${operation} failed`,
      }),
    );
  }
  const captured = resultOutcome(captureClaudeOperation(effect));
  if (captured.ok) return Result.ok(captured.value);
  if (Panic.is(captured.error)) throw captured.error;
  return Result.err(
    new ClaudeCodeRunExternalFailure({
      operation,
      cause: capturedClaudeError(captured.error, `${operation} failed`),
      message: `${operation} failed`,
    }),
  );
}

type CapturedCleanupOperation<T> =
  | { readonly status: "result"; readonly result: ResultType<T, ClaudeCodeRunExternalFailure> }
  | { readonly status: "panic"; readonly panic: Panic };

function captureCleanupOperationSync<T>(
  operation: string,
  effect: () => Awaited<T>,
): CapturedCleanupOperation<T> {
  const captured = resultOutcome(
    captureClaudeOperation(() => captureExternalOperationSync(operation, effect)),
  );
  if (captured.ok) return { status: "result", result: captured.value };
  if (!Panic.is(captured.error)) throw captured.error;
  return { status: "panic", panic: captured.error };
}

function deferredCleanupPanic<T>(outcome: PromiseSettledResult<T>): Panic | undefined {
  if (outcome.status === "fulfilled") return undefined;
  if (Panic.is(outcome.reason)) return outcome.reason;
  return new Panic({ message: "Claude cleanup rejected outside its Result contract" });
}

export function decodeClaudeNativeSessionStart(
  value: ClaudeNativeSessionStart | undefined,
): ResultType<ClaudeNativeSessionStart, ClaudeCodeRunInvalidConfiguration> {
  const parsed = nativeSessionStartSchema.safeParse(value ?? { mode: "ephemeral" });
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new ClaudeCodeRunInvalidConfiguration({
          message: `Invalid Claude native session start: ${z.prettifyError(parsed.error)}`,
        }),
      );
}

export function projectClaudeSdkMessage(message: unknown): ClaudeSdkMessageProjection {
  const envelope = sdkMessageTypeSchema.safeParse(message);
  if (!envelope.success) {
    return { kind: "invalid", message: `Invalid SDK message: ${z.prettifyError(envelope.error)}` };
  }
  switch (envelope.data.type) {
    case "system": {
      if (envelope.data["subtype"] !== "init") return { kind: "unsupported" };
      const parsed = sdkInitMessageSchema.safeParse(message);
      return parsed.success
        ? { kind: "init", sessionId: parsed.data.session_id, model: parsed.data.model }
        : {
            kind: "invalid",
            message: `Invalid SDK init message: ${z.prettifyError(parsed.error)}`,
          };
    }
    case "result": {
      if (envelope.data["subtype"] !== "success") return { kind: "unsupported" };
      const parsed = sdkSuccessResultMessageSchema.safeParse(message);
      return parsed.success
        ? { kind: "success-result", sessionId: parsed.data.session_id }
        : {
            kind: "invalid",
            message: `Invalid SDK result message: ${z.prettifyError(parsed.error)}`,
          };
    }
    default:
      return { kind: "unsupported" };
  }
}

export function decodeClaudeContextUsage(
  value: unknown,
): ResultType<z.output<typeof contextUsageSchema>, ClaudeCodeRunInvalidConfiguration> {
  const parsed = contextUsageSchema.safeParse(value);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new ClaudeCodeRunInvalidConfiguration({
          message: `Invalid context usage: ${z.prettifyError(parsed.error)}`,
        }),
      );
}

async function captureClaudeContextUsage(
  controller: ClaudeNativeQueryController,
): Promise<
  ResultType<
    z.output<typeof contextUsageSchema>,
    ClaudeCodeRunExternalFailure | ClaudeCodeRunInvalidConfiguration
  >
> {
  return (
    await captureExternalOperation("Claude context usage capture", () =>
      controller.getContextUsage(),
    )
  ).andThen(decodeClaudeContextUsage);
}

export function decodeClaudeStopHookInput(
  args: readonly unknown[],
): ResultType<void, ClaudeCodeRunInvalidConfiguration> {
  const parsed = stopHookInputSchema.safeParse(args[0]);
  return parsed.success
    ? Result.ok()
    : Result.err(
        new ClaudeCodeRunInvalidConfiguration({
          message: `Invalid Stop hook input: ${z.prettifyError(parsed.error)}`,
        }),
      );
}

function spawnLocalClaudeCodeProcess(options: SpawnOptions): SpawnedProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

async function waitForProcessExitProofResult(
  exit: Promise<void>,
): Promise<ResultType<void, ClaudeCodeRunExternalFailure>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ResultType<void, ClaudeCodeRunExternalFailure>>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        Result.err(
          new ClaudeCodeRunExternalFailure({
            operation: "Claude process exit proof",
            cause: new Error(
              `Claude process exit was not observed within ${PROCESS_EXIT_PROOF_TIMEOUT_MS}ms`,
            ),
            message: `Claude process exit was not observed within ${PROCESS_EXIT_PROOF_TIMEOUT_MS}ms`,
          }),
        ),
      );
    }, PROCESS_EXIT_PROOF_TIMEOUT_MS);
    timer.unref();
  });
  const proof = await Promise.race([
    captureExternalOperation("Claude process exit observation", async () => await exit),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return proof;
}

async function settleQueryAndProcess(input: {
  readonly settleQuery: () => Promise<void>;
  readonly process: TrackedClaudeProcess | undefined;
}): Promise<ResultType<void, ClaudeCodeRunCleanupFailed>> {
  const errors: ClaudeCodeRunExternalFailure[] = [];
  let firstPanic: Panic | undefined;
  const missingProcess = new ClaudeCodeRunExternalFailure({
    operation: "Claude process exit proof",
    cause: new Error("Claude query has no tracked subprocess exit proof"),
    message: "Claude query has no tracked subprocess exit proof",
  });
  const [settled, exited] = await Promise.allSettled([
    captureExternalOperation("Claude query settlement", input.settleQuery),
    input.process?.waitForExit() ?? Promise.resolve(Result.err(missingProcess)),
  ]);
  for (const outcome of [settled, exited]) {
    const panic = deferredCleanupPanic(outcome);
    if (panic) firstPanic ??= panic;
    else if (outcome.status === "fulfilled") {
      outcome.value.match({ ok: () => undefined, err: (error) => errors.push(error) });
    }
  }
  if (firstPanic) throw firstPanic;
  return errors.length === 0
    ? Result.ok()
    : Result.err(
        new ClaudeCodeRunCleanupFailed({
          failures: errors,
          message: "Claude query settlement could not prove subprocess exit",
        }),
      );
}

function nativeSettings(
  start: ClaudeNativeSessionStart,
): Pick<ClaudeCodeSettings, "forkSession" | "persistSession" | "resume" | "sessionId"> {
  switch (start.mode) {
    case "ephemeral":
      return { persistSession: false };
    case "fresh":
      return { persistSession: true, sessionId: start.sessionId };
    case "fork":
      return {
        persistSession: true,
        resume: start.baseSessionId,
        forkSession: true,
        sessionId: start.sessionId,
      };
  }
}

async function readSessionInfo(
  reader: ClaudeNativeSessionInfoReader,
  sessionId: string,
  cwd: string,
): Promise<SessionReadResult> {
  const read = resultOutcome(
    await captureExternalOperation("Claude native session metadata read", () =>
      reader(sessionId, { dir: cwd }),
    ),
  );
  if (!read.ok) {
    return {
      status: "failed",
      error: boundedExternalFailure(read.error, MAX_CALLBACK_ERROR_CHARS),
    };
  }
  const raw = read.value;
  if (raw === undefined) return { status: "missing" };

  return decodeClaudeSessionInfo(raw).match<SessionReadResult>({
    ok: (metadata) => ({ status: "ok", metadata }),
    err: (error) => ({
      status: "invalid",
      error: boundedText(error.message, MAX_CALLBACK_ERROR_CHARS),
    }),
  });
}

export function decodeClaudeSessionInfo(
  value: unknown,
): ResultType<ClaudeNativeSessionMetadata, ClaudeCodeRunInvalidConfiguration> {
  const parsed = sessionInfoSchema.safeParse(value);
  if (!parsed.success) {
    return Result.err(
      new ClaudeCodeRunInvalidConfiguration({
        message: `Invalid Claude native session metadata: ${z.prettifyError(parsed.error)}`,
      }),
    );
  }
  return Result.ok(parsed.data);
}

function pushSessionReadIssue(
  issues: ClaudeNativeSessionValidationIssue[],
  scope: "candidate" | "source-preflight" | "source-final",
  read: Exclude<SessionReadResult, { status: "ok" }>,
): void {
  if (read.status === "failed") {
    issues.push({ code: `${scope}-read-failed`, message: `${scope} read failed: ${read.error}` });
  } else if (read.status === "invalid") {
    issues.push({
      code: `${scope}-invalid`,
      message: `${scope} metadata is invalid: ${read.error}`,
    });
  } else {
    issues.push({ code: `${scope}-missing`, message: `${scope} session is missing` });
  }
}

export async function materializeClaudeCodeRunResult(options: {
  modelId: string;
  cwd: string;
  tools: ToolSet;
  catalogMetadata?: ClaudeCodeToolCatalogMetadataMap;
  execute(request: ClaudeCodeToolExecutionRequest): Promise<ExternalToolExecutionOutcome>;
  /**
   * Claude built-in tools this run may call. Applied to the agent model only;
   * the utility model is always tool-free so a summarization prompt cannot
   * reach the network.
   */
  builtInTools?: readonly ClaudeCodeBuiltInTool[];
  nativeSession?: ClaudeNativeSessionStart;
  reasoning?: string;
  createModel?: CreateClaudeCodeModel;
  getSessionInfo?: ClaudeNativeSessionInfoReader;
  controller?: ClaudeNativeQueryController;
  spawnClaudeCodeProcess?: SpawnClaudeCodeProcess;
  waitForProcessExit?: (exit: Promise<void>) => Promise<void>;
  onSdkMessage?: (message: object) => void | PromiseLike<void>;
}): Promise<
  ResultType<
    MaterializedClaudeCodeRun,
    ClaudeCodeRunMaterializationError | ClaudeCodeRunOperationAndCleanupFailed
  >
> {
  const decodedStart = resultOutcome(decodeClaudeNativeSessionStart(options.nativeSession));
  if (!decodedStart.ok) return Result.err(decodedStart.error);
  const start = decodedStart.value;
  const readInfo: ClaudeNativeSessionInfoReader =
    options.getSessionInfo ?? ((sessionId, readOptions) => getSessionInfo(sessionId, readOptions));
  const preflightIssues: ClaudeNativeSessionValidationIssue[] = [];
  let sourcePreflight: ClaudeNativeSessionMetadata | null = null;

  if (start.mode === "fork") {
    const read = await readSessionInfo(readInfo, start.baseSessionId, options.cwd);
    if (read.status !== "ok") {
      pushSessionReadIssue(preflightIssues, "source-preflight", read);
    } else {
      sourcePreflight = read.metadata;
      if (read.metadata.sessionId !== start.baseSessionId) {
        preflightIssues.push({
          code: "source-preflight-id-mismatch",
          message: `source preflight ID '${read.metadata.sessionId}' does not match '${start.baseSessionId}'`,
        });
      }
      if (read.metadata.cwd !== options.cwd) {
        preflightIssues.push({
          code: "source-preflight-cwd-mismatch",
          message: `source preflight cwd '${read.metadata.cwd}' does not match '${options.cwd}'`,
        });
      }
      if (read.metadata.lastModified !== start.expectedSourceLastModified) {
        preflightIssues.push({
          code: "source-preflight-last-modified-mismatch",
          message: `source preflight lastModified ${read.metadata.lastModified} does not match promoted snapshot ${start.expectedSourceLastModified}`,
        });
      }
    }
    if (preflightIssues.length > 0) {
      return Result.err(
        new ClaudeNativeSessionPreflightError({
          issues: preflightIssues,
          message: `Claude native fork preflight requires a fresh start: ${preflightIssues
            .map(({ message }) => message)
            .join("; ")}`,
        }),
      );
    }
  }

  // Validated here as well as in the bridge, because this array also reaches
  // the Agent SDK's own built-in allowlist.
  const validatedBuiltIns = resultOutcome(
    validateClaudeCodeBuiltInToolsResult(options.builtInTools),
  );
  if (!validatedBuiltIns.ok) return Result.err(validatedBuiltIns.error);
  const builtInTools = [...new Set([...validatedBuiltIns.value, "ToolSearch" as const])];
  const createdBridge = resultOutcome(
    await createClaudeCodeToolBridgeResult({
      tools: options.tools,
      catalogMetadata: options.catalogMetadata,
      execute: options.execute,
      builtInTools,
    }),
  );
  if (!createdBridge.ok) return Result.err(createdBridge.error);
  const bridge = createdBridge.value;
  const createModel =
    options.createModel ??
    createClaudeCode({
      defaultSettings: {
        tools: [],
        settingSources: [],
        persistSession: false,
      },
    });
  const executable = claudeCodeExecutableSettings();
  const requestedSessionId = start.mode === "ephemeral" ? null : start.sessionId;
  const sourceSessionId = start.mode === "fork" ? start.baseSessionId : null;
  const providerWarnings: string[] = [];
  const initSessionIds = new Set<string>();
  const resultSessionIds = new Set<string>();
  const pendingObservabilityCallbacks = new Set<Promise<void>>();
  const injectors = new Set<MessageInjector>();
  const queryControllers = new Set<TrackedQueryController>();
  const settledQueryControllers = new Set<TrackedQueryController>();
  const trackedProcesses: TrackedClaudeProcess[] = [];
  const unclaimedProcesses: TrackedClaudeProcess[] = [];
  let injector: MessageInjector | null = null;
  let controller: ClaudeNativeQueryController | null = options.controller ?? null;
  if (controller) {
    const injectedController = controller;
    queryControllers.add({
      settleResult: async () => {
        const settled = await captureExternalOperation("Claude query settlement", () =>
          injectedController.settle(),
        );
        return settled.match<ResultType<void, ClaudeCodeRunCleanupFailed>>({
          ok: () => Result.ok(),
          err: (error) =>
            Result.err(
              new ClaudeCodeRunCleanupFailed({
                failures: [error],
                message: "Claude query settlement failed",
              }),
            ),
        });
      },
    });
  }
  let initSessionId: string | null = null;
  let resultSessionId: string | null = null;
  let latestInitSessionId: string | null = null;
  let latestResultSessionId: string | null = null;
  let initializedModel: string | null = null;
  let contextTokens: number | null = null;
  let contextMaxTokens: number | null = null;
  let callbackError: string | null = null;
  let requiredObservabilityError: string | null = null;
  let contextCaptureSequence = 0;
  let successfulContextCaptureSequence = 0;
  let deliveredContextCaptureSequence = 0;
  let initObservationSequence = 0;
  let deliveredInitObservationSequence = 0;
  let resultObservationSequence = 0;
  let deliveredResultObservationSequence = 0;
  let pendingContextCapture: Promise<void> | null = null;
  let invoked = controller !== null;
  let disposed = false;
  let acceptingProcesses = true;
  let disposalPromise: Promise<void> | null = null;
  let finalizationResultPromise: Promise<
    ResultType<ClaudeNativeSessionFinalization, ClaudeCodeRunFinalizationError>
  > | null = null;
  let finalizationPromise: Promise<ClaudeNativeSessionFinalization> | null = null;

  const recordCallbackError = (message: string, required = false) => {
    const next = boundedText(message, MAX_CALLBACK_ERROR_CHARS);
    if (required) {
      requiredObservabilityError = boundedText(
        requiredObservabilityError ? `${requiredObservabilityError}; ${next}` : next,
        MAX_CALLBACK_ERROR_CHARS,
      );
    }
    callbackError = boundedText(
      callbackError ? `${callbackError}; ${next}` : next,
      MAX_CALLBACK_ERROR_CHARS,
    );
  };

  const recordWarning = (warning: string) => {
    if (providerWarnings.length >= MAX_PROVIDER_WARNINGS) return;
    providerWarnings.push(boundedText(warning, MAX_PROVIDER_WARNING_CHARS));
  };

  const getObservation = (): ClaudeNativeAttemptObservation => ({
    requestedSessionId,
    sourceSessionId,
    initSessionId,
    resultSessionId,
    contextTokens,
    contextMaxTokens,
    requestedModel: options.modelId,
    initializedModel,
    requestedReasoning: options.reasoning ?? null,
    providerWarnings: [...providerWarnings],
    invoked,
    requiredObservabilityError,
    callbackError,
  });

  const beginContextCapture = () => {
    const liveController = controller;
    if (!liveController) {
      recordCallbackError("Stop hook ran without a live query controller", true);
      return;
    }

    const sequence = ++contextCaptureSequence;
    const capture = (async () => {
      const requestedUsage = resultOutcome(await captureClaudeContextUsage(liveController));
      if (!requestedUsage.ok) {
        const message =
          requestedUsage.error._tag === "ClaudeCodeRunExternalFailure"
            ? boundedExternalFailure(requestedUsage.error, MAX_CALLBACK_ERROR_CHARS)
            : requestedUsage.error.message;
        recordCallbackError(message, true);
        return;
      }
      if (sequence >= successfulContextCaptureSequence) {
        successfulContextCaptureSequence = sequence;
        contextTokens = requestedUsage.value.totalTokens;
        contextMaxTokens = requestedUsage.value.maxTokens;
      }
    })();
    pendingContextCapture = capture;
  };

  const observeSdkMessage = (message: object) => {
    const projected = projectClaudeSdkMessage(message);
    switch (projected.kind) {
      case "init":
        initSessionIds.add(projected.sessionId);
        initSessionId ??= projected.sessionId;
        latestInitSessionId = projected.sessionId;
        initObservationSequence += 1;
        initializedModel ??= projected.model;
        if (initSessionIds.size > 1) {
          recordCallbackError(
            `SDK init emitted conflicting session IDs: ${[...initSessionIds].join(", ")}`,
            true,
          );
        }
        break;
      case "success-result":
        resultSessionIds.add(projected.sessionId);
        resultSessionId ??= projected.sessionId;
        latestResultSessionId = projected.sessionId;
        resultObservationSequence += 1;
        if (resultSessionIds.size > 1) {
          recordCallbackError(
            `SDK result emitted conflicting session IDs: ${[...resultSessionIds].join(", ")}`,
            true,
          );
        }
        break;
      case "invalid":
        recordCallbackError(projected.message, true);
        break;
      case "unsupported":
        break;
    }

    if (options.onSdkMessage) {
      const pending = (async () => {
        const observed = await captureExternalOperation("Optional Claude SDK observer", () =>
          options.onSdkMessage?.(message),
        );
        observed.match({
          ok: () => undefined,
          err: (error) =>
            recordCallbackError(boundedExternalFailure(error, MAX_CALLBACK_ERROR_CHARS)),
        });
      })();
      pendingObservabilityCallbacks.add(pending);
    }
  };

  const stopHook = async (...args: unknown[]): Promise<unknown> => {
    const parsed = resultOutcome(decodeClaudeStopHookInput(args));
    if (!parsed.ok) {
      recordCallbackError(parsed.error.message, true);
      return {};
    }
    beginContextCapture();
    return {};
  };

  const waitForObservability = async () => {
    let firstPanic: Panic | undefined;
    const capture = pendingContextCapture;
    const observations = await Promise.allSettled([
      ...(capture ? [capture] : []),
      ...pendingObservabilityCallbacks,
    ]);
    pendingObservabilityCallbacks.clear();
    for (const observation of observations) {
      const panic = deferredCleanupPanic(observation);
      if (panic) firstPanic ??= panic;
    }
    if (firstPanic) throw firstPanic;
  };

  const waitForObservation = async (): Promise<ClaudeNativeAttemptObservation> => {
    await waitForObservability();
    const observation = getObservation();
    const hasNewTerminalUsage =
      contextCaptureSequence > deliveredContextCaptureSequence &&
      successfulContextCaptureSequence === contextCaptureSequence;
    const hasNewInit = initObservationSequence > deliveredInitObservationSequence;
    const hasNewResult = resultObservationSequence > deliveredResultObservationSequence;
    deliveredContextCaptureSequence = contextCaptureSequence;
    deliveredInitObservationSequence = initObservationSequence;
    deliveredResultObservationSequence = resultObservationSequence;
    return {
      ...observation,
      initSessionId: hasNewInit ? latestInitSessionId : null,
      resultSessionId: hasNewResult ? latestResultSessionId : null,
      contextTokens: hasNewTerminalUsage ? observation.contextTokens : null,
      contextMaxTokens: hasNewTerminalUsage ? observation.contextMaxTokens : null,
    };
  };

  const spawnTrackedProcess: SpawnClaudeCodeProcess = (spawnOptions) => {
    if (!acceptingProcesses) {
      throw new Error("Cannot spawn a Claude process after run disposal started");
    }
    const spawned = (options.spawnClaudeCodeProcess ?? spawnLocalClaudeCodeProcess)(spawnOptions);
    const exited = Promise.withResolvers<void>();
    const process = {
      waitForExit: (() => {
        let proof: Promise<ResultType<void, ClaudeCodeRunExternalFailure>> | null = null;
        return () => {
          proof ??= options.waitForProcessExit
            ? captureExternalOperation("Claude process exit proof", () =>
                options.waitForProcessExit?.(exited.promise),
              )
            : waitForProcessExitProofResult(exited.promise);
          return proof;
        };
      })(),
    } satisfies TrackedClaudeProcess;
    spawned.once("exit", () => exited.resolve());
    if (spawned.exitCode !== null) exited.resolve();
    trackedProcesses.push(process);
    unclaimedProcesses.push(process);
    return spawned;
  };

  const drainQueryControllers = async (): Promise<ResultType<void, ClaudeCodeRunCleanupFailed>> => {
    const errors: ClaudeCodeRunExternalFailure[] = [];
    for (;;) {
      const batch = [...queryControllers].filter(
        (queryController) => !settledQueryControllers.has(queryController),
      );
      if (batch.length === 0) break;
      batch.forEach((queryController) => settledQueryControllers.add(queryController));
      const settlements = await Promise.allSettled(
        batch.map((queryController) => queryController.settleResult()),
      );
      for (const settlement of settlements) {
        const panic = deferredCleanupPanic(settlement);
        if (panic) throw panic;
        if (settlement.status === "fulfilled") {
          settlement.value.match({
            ok: () => undefined,
            err: (error) => errors.push(...error.failures),
          });
        }
      }
    }
    return errors.length === 0
      ? Result.ok()
      : Result.err(
          new ClaudeCodeRunCleanupFailed({
            failures: errors,
            message: "One or more Claude queries failed to settle",
          }),
        );
  };

  const interruptResult = async (): Promise<ResultType<boolean, ClaudeCodeRunExternalFailure>> => {
    if (disposed) return Result.ok(false);
    bridge.clear();
    if (!controller) return Result.ok(false);
    const interrupted = await captureExternalOperation("Claude query interruption", () =>
      controller?.interrupt(),
    );
    return interrupted.map(() => true);
  };

  const clearResult = (): ResultType<void, ClaudeCodeRunCleanupFailed> => {
    const errors: ClaudeCodeRunExternalFailure[] = [];
    let firstPanic: Panic | undefined;
    const attempt = (operation: string, effect: () => void): void => {
      const captured = captureCleanupOperationSync(operation, effect);
      if (captured.status === "panic") firstPanic ??= captured.panic;
      else captured.result.match({ ok: () => undefined, err: (error) => errors.push(error) });
    };
    for (const activeInjector of injectors) {
      attempt("Claude message injector close", () => activeInjector.close());
    }
    injectors.clear();
    injector = null;
    controller = null;
    attempt("Claude MCP bridge clear", () => bridge.clear());
    if (firstPanic) throw firstPanic;
    return errors.length === 0
      ? Result.ok()
      : Result.err(
          new ClaudeCodeRunCleanupFailed({
            failures: errors,
            message: "Claude run controls could not be cleared cleanly",
          }),
        );
  };

  const control: ClaudeCodeRunControl = {
    inject(message, onResult) {
      if (disposed || !injector) return false;
      injector.inject(message, onResult);
      return true;
    },
    interruptResult,
    async interrupt() {
      const interrupted = await interruptResult();
      return interrupted.match({ ok: (value) => value, err: () => false });
    },
    clearResult,
    clear() {
      const cleared = resultOutcome(clearResult());
      if (!cleared.ok) throw cleanupFailureToAggregateError(cleared.error);
    },
  };

  let disposalResultPromise: Promise<ResultType<void, ClaudeCodeRunCleanupFailed>> | null = null;
  const disposeResult = (): Promise<ResultType<void, ClaudeCodeRunCleanupFailed>> => {
    if (disposalResultPromise) return disposalResultPromise;
    disposed = true;
    acceptingProcesses = false;
    disposalResultPromise = (async () => {
      const errors: ClaudeCodeRunExternalFailure[] = [];
      let firstPanic: Panic | undefined;
      const collectCleanup = (result: ResultType<void, ClaudeCodeRunCleanupFailed>): void => {
        result.match({ ok: () => undefined, err: (error) => errors.push(...error.failures) });
      };
      const attemptCleanup = async (effect: () => void | Promise<void>): Promise<void> => {
        const [settled] = await Promise.allSettled([Promise.resolve().then(effect)]);
        const panic = deferredCleanupPanic(settled);
        if (panic) firstPanic ??= panic;
      };
      const collectExitProofs = async () => {
        const exitProofs = await Promise.allSettled(
          trackedProcesses.map((process) => process.waitForExit()),
        );
        for (const exitProof of exitProofs) {
          const panic = deferredCleanupPanic(exitProof);
          if (panic) firstPanic ??= panic;
          else if (exitProof.status === "fulfilled") {
            exitProof.value.match({ ok: () => undefined, err: (error) => errors.push(error) });
          }
        }
      };
      await attemptCleanup(async () => {
        const observability = await captureExternalOperation(
          "Claude observability settlement",
          waitForObservability,
        );
        observability.match({ ok: () => undefined, err: (error) => errors.push(error) });
      });
      await attemptCleanup(() => collectCleanup(clearResult()));
      await attemptCleanup(async () => collectCleanup(await drainQueryControllers()));
      await attemptCleanup(collectExitProofs);
      await attemptCleanup(async () => collectCleanup(await drainQueryControllers()));
      await attemptCleanup(async () => {
        const bridgeClosed = await bridge.closeResult();
        bridgeClosed.match({
          ok: () => undefined,
          err: (error) =>
            errors.push(
              new ClaudeCodeRunExternalFailure({
                operation: "Claude MCP bridge cleanup",
                cause: error,
                message: error.message,
              }),
            ),
        });
      });
      await attemptCleanup(async () => collectCleanup(await drainQueryControllers()));
      if (unclaimedProcesses.length > 0) {
        errors.push(
          new ClaudeCodeRunExternalFailure({
            operation: "Claude query-controller registration",
            cause: new Error(
              `${unclaimedProcesses.length} Claude subprocess(es) exited without query-controller registration`,
            ),
            message: `${unclaimedProcesses.length} Claude subprocess(es) exited without query-controller registration`,
          }),
        );
      }
      queryControllers.clear();
      if (firstPanic) throw firstPanic;
      return errors.length === 0
        ? Result.ok()
        : Result.err(
            new ClaudeCodeRunCleanupFailed({
              failures: errors,
              message: "Claude run disposal could not prove clean settlement",
            }),
          );
    })();
    return disposalResultPromise;
  };

  const dispose = (): Promise<void> => {
    if (disposalPromise) return disposalPromise;
    disposalPromise = (async () => {
      const disposedRun = resultOutcome(await disposeResult());
      if (!disposedRun.ok) throw cleanupFailureToAggregateError(disposedRun.error);
    })();
    return disposalPromise;
  };

  const finalizeResult = (): Promise<
    ResultType<ClaudeNativeSessionFinalization, ClaudeCodeRunFinalizationError>
  > => {
    if (start.mode === "ephemeral") {
      return Promise.resolve(
        Result.err(
          new ClaudeCodeRunInvalidConfiguration({
            message: "Cannot finalize an ephemeral Claude native session",
          }),
        ),
      );
    }
    if (finalizationResultPromise) return finalizationResultPromise;

    finalizationResultPromise = (async () => {
      const issues = [...preflightIssues];
      let candidate: ClaudeNativeSessionMetadata | null = null;
      let sourceFinal: ClaudeNativeSessionMetadata | null = null;
      const [observability] = await Promise.allSettled([waitForObservability()]);
      const observabilityPanic = deferredCleanupPanic(observability);

      if (!initSessionId) {
        issues.push({
          code: "init-session-id-missing",
          message: "SDK init session ID is missing",
        });
      } else if (initSessionId !== start.sessionId) {
        issues.push({
          code: "init-session-id-mismatch",
          message: `SDK init session ID '${initSessionId}' does not match '${start.sessionId}'`,
        });
      }
      if (initSessionIds.size > 1) {
        issues.push({
          code: "init-session-id-conflict",
          message: `SDK init emitted conflicting session IDs: ${[...initSessionIds].join(", ")}`,
        });
      }

      if (!resultSessionId) {
        issues.push({
          code: "result-session-id-missing",
          message: "successful SDK result session ID is missing",
        });
      } else if (resultSessionId !== start.sessionId) {
        issues.push({
          code: "result-session-id-mismatch",
          message: `SDK result session ID '${resultSessionId}' does not match '${start.sessionId}'`,
        });
      }
      if (resultSessionIds.size > 1) {
        issues.push({
          code: "result-session-id-conflict",
          message: `SDK result emitted conflicting session IDs: ${[...resultSessionIds].join(", ")}`,
        });
      }

      if (
        contextTokens === null ||
        contextMaxTokens === null ||
        successfulContextCaptureSequence !== contextCaptureSequence
      ) {
        issues.push({
          code: "context-usage-missing",
          message: "terminal native context usage is missing",
        });
      }
      if (requiredObservabilityError !== null) {
        issues.push({
          code: "required-observability-failed",
          message: requiredObservabilityError,
        });
      }

      // The provider closes its AI SDK output stream at the result message while
      // Agent SDK query cleanup may still append to the persisted transcript.
      // Disposal combines Query.return() with the tracked child's actual exit.
      const [disposed] = await Promise.allSettled([disposeResult()]);
      const disposalPanic = deferredCleanupPanic(disposed);
      if (observabilityPanic) throw observabilityPanic;
      if (disposed.status === "rejected") throw disposalPanic;
      const disposedRun = resultOutcome(disposed.value);
      if (!disposedRun.ok) return Result.err(disposedRun.error);

      const reads = await Promise.all([
        readSessionInfo(readInfo, start.sessionId, options.cwd),
        start.mode === "fork"
          ? readSessionInfo(readInfo, start.baseSessionId, options.cwd)
          : Promise.resolve<SessionReadResult>({ status: "missing" }),
      ]);
      const candidateRead = reads[0];
      if (candidateRead.status !== "ok") {
        pushSessionReadIssue(issues, "candidate", candidateRead);
      } else {
        candidate = candidateRead.metadata;
        if (candidate.sessionId !== start.sessionId) {
          issues.push({
            code: "candidate-id-mismatch",
            message: `candidate ID '${candidate.sessionId}' does not match '${start.sessionId}'`,
          });
        }
        if (candidate.cwd !== options.cwd) {
          issues.push({
            code: "candidate-cwd-mismatch",
            message: `candidate cwd '${candidate.cwd}' does not match '${options.cwd}'`,
          });
        }
      }

      if (start.mode === "fork") {
        const sourceRead = reads[1];
        if (sourceRead.status !== "ok") {
          pushSessionReadIssue(issues, "source-final", sourceRead);
        } else {
          sourceFinal = sourceRead.metadata;
          if (sourceFinal.sessionId !== start.baseSessionId) {
            issues.push({
              code: "source-final-id-mismatch",
              message: `source final ID '${sourceFinal.sessionId}' does not match '${start.baseSessionId}'`,
            });
          }
          if (sourceFinal.cwd !== options.cwd) {
            issues.push({
              code: "source-final-cwd-mismatch",
              message: `source final cwd '${sourceFinal.cwd}' does not match '${options.cwd}'`,
            });
          }
          if (sourcePreflight && sourceFinal.lastModified !== sourcePreflight.lastModified) {
            issues.push({
              code: "source-last-modified-changed",
              message: `source lastModified changed from ${sourcePreflight.lastModified} to ${sourceFinal.lastModified}`,
            });
          }
        }
      }

      const base = {
        observations: getObservation(),
        candidate,
        sourcePreflight,
        sourceFinal,
      } satisfies ClaudeNativeSessionFinalizationBase;
      return Result.ok(
        issues.length === 0
          ? { ...base, status: "promotable", issues: [] }
          : { ...base, status: "unpromotable", issues },
      );
    })();
    return finalizationResultPromise;
  };

  const finalizeToHost = async (): Promise<ClaudeNativeSessionFinalization> => {
    const finalized = resultOutcome(await finalizeResult());
    if (!finalized.ok) {
      if (finalized.error._tag === "ClaudeCodeRunCleanupFailed") {
        throw cleanupFailureToAggregateError(finalized.error);
      }
      throw finalized.error;
    }
    return finalized.value;
  };

  const finalize = (): Promise<ClaudeNativeSessionFinalization> => {
    finalizationPromise ??= finalizeToHost();
    return finalizationPromise;
  };

  const createUtilityModelResult = () =>
    captureExternalOperationSync("Claude utility model construction", () =>
      createModel(options.modelId, {
        ...executable,
        cwd: options.cwd,
        tools: [],
        settingSources: [],
        persistSession: false,
      }),
    );
  const createUtilityModel = () => {
    const created = resultOutcome(createUtilityModelResult());
    if (!created.ok) return captureExternalOperationSync(created.error);
    return created.value;
  };

  const construction = resultOutcome(
    await captureClaudePromise(async () => {
      const sharedAgentSettings = {
        ...executable,
        cwd: options.cwd,
        env: { ENABLE_TOOL_SEARCH: "true" },
        tools: builtInTools,
        settingSources: [],
        mcpServers: bridge.mcpServers,
        canUseTool: bridge.canUseTool,
        spawnClaudeCodeProcess: spawnTrackedProcess,
        streamingInput: "always",
        hooks: { Stop: [{ hooks: [stopHook] }] },
        onSdkMessage: observeSdkMessage,
        onStreamStart: (nextInjector) => {
          invoked = true;
          if (disposed) {
            const closed = captureExternalOperationSync("Late Claude message injector close", () =>
              nextInjector.close(),
            );
            closed.match({
              ok: () => undefined,
              err: (error) =>
                recordCallbackError(boundedExternalFailure(error, MAX_CALLBACK_ERROR_CHARS)),
            });
            return;
          }
          injectors.add(nextInjector);
          injector = nextInjector;
        },
        onQueryControllerCreated: (nextController) => {
          invoked = true;
          const process = unclaimedProcesses.shift();
          let settlement: Promise<ResultType<void, ClaudeCodeRunCleanupFailed>> | null = null;
          const trackedController: TrackedQueryController = {
            settleResult: () => {
              settlement ??= settleQueryAndProcess({
                settleQuery: async () => {
                  await nextController.rawQuery.return(undefined);
                },
                process,
              });
              return settlement;
            },
          };
          const queryController: ClaudeNativeQueryController = {
            getContextUsage: () => nextController.getContextUsage(),
            interrupt: () => nextController.interrupt(),
            settle: async () => undefined,
          };
          queryControllers.add(trackedController);
          if (!disposed) controller = queryController;
        },
      } satisfies ClaudeCodeRunModelSettings;
      const agentModel = createModel(options.modelId, {
        ...sharedAgentSettings,
        ...nativeSettings(start),
      });
      const continuationModel =
        start.mode === "ephemeral"
          ? undefined
          : createModel(options.modelId, {
              ...sharedAgentSettings,
              persistSession: true,
              resume: start.sessionId,
            });
      return Result.ok({
        agentModel,
        ...(continuationModel ? { continuationModel } : {}),
        createUtilityModelResult,
        createUtilityModel,
        control,
        nativeSession: {
          getObservation,
          waitForObservation,
          recordWarning,
          finalizeResult,
          finalize,
        },
        disposeResult,
        dispose,
      });
    }),
  );
  if (construction.ok) return construction.value;
  const cause = construction.error;
  disposed = true;
  acceptingProcesses = false;
  const operationPanic = Panic.is(cause) ? cause : undefined;
  const cleanupFailures: ClaudeCodeRunExternalFailure[] = [];
  let cleanupPanic: Panic | undefined;
  const controlsCleared = captureCleanupOperationSync("Claude run control cleanup", clearResult);
  if (controlsCleared.status === "panic") cleanupPanic = controlsCleared.panic;
  else {
    const controlsOutcome = resultOutcome(controlsCleared.result);
    if (!controlsOutcome.ok) cleanupFailures.push(controlsOutcome.error);
    else {
      controlsOutcome.value.match({
        ok: () => undefined,
        err: (error) => cleanupFailures.push(...error.failures),
      });
    }
  }
  const [bridgeCleanup] = await Promise.allSettled([bridge.closeResult()]);
  const bridgePanic = deferredCleanupPanic(bridgeCleanup);
  if (bridgeCleanup.status === "fulfilled") {
    const bridgeClosed = bridgeCleanup.value;
    bridgeClosed.match({
      ok: () => undefined,
      err: (error) =>
        cleanupFailures.push(
          new ClaudeCodeRunExternalFailure({
            operation: "Claude MCP bridge cleanup",
            cause: error,
            message: error.message,
          }),
        ),
    });
  }
  if (bridgePanic) cleanupPanic ??= bridgePanic;
  if (operationPanic) throw operationPanic;
  if (cleanupPanic) throw cleanupPanic;
  const operationError = new ClaudeCodeRunExternalFailure({
    operation: "Claude model construction",
    cause: capturedClaudeError(cause, "Claude model construction failed"),
    message: "Claude model construction failed",
  });
  if (cleanupFailures.length === 0) return Result.err(operationError);
  return Result.err(
    new ClaudeCodeRunOperationAndCleanupFailed({
      operationError,
      cleanupError: new ClaudeCodeRunCleanupFailed({
        failures: cleanupFailures,
        message: "Claude run cleanup after model construction failure failed",
      }),
      message: "Claude model construction and cleanup failed",
    }),
  );
}

/** Compatibility adapter for callers that consume materialization failures as rejections. */
export async function materializeClaudeCodeRun(
  options: Parameters<typeof materializeClaudeCodeRunResult>[0],
): Promise<MaterializedClaudeCodeRun> {
  const materialized = resultOutcome(await materializeClaudeCodeRunResult(options));
  if (!materialized.ok) throw materialized.error;
  return materialized.value;
}
