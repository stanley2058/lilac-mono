import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import {
  createLogger,
  formatTaggedErrorForLog,
  resolveSubagentPermissionProfileName,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import type { Level1ExecutionRequestContext } from "@stanley2058/lilac-plugin-runtime";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { isAdapterPlatform } from "../shared/is-adapter-platform";
import type { SurfaceThreadControlResolver } from "../surface/runtime-descriptor";
import type { RegisteredSurfacePlatform } from "../surface/types";
import {
  projectThreadTimeline,
  type SurfaceThreadControlPort,
  type ThreadControlCaller,
  type ThreadTimelineItem,
  type ThreadTimelineView,
} from "../surface/thread-control";
import { subagentMessages, type SubagentReader } from "../surface/native/subagents";
import type { TranscriptStore } from "../transcript/transcript-store";
import type { DurableWorkflowStore } from "../workflow/durable-workflow-store";
import { sha256 } from "../workflow/workflow-definition";
import type { WorkflowOperation, WorkflowRun } from "../workflow/workflow-domain";
import type { WorkflowProgressCardService } from "../workflow/workflow-progress-projector";
import { cancelWorkflowRun } from "../workflow/workflow-run-cancel";
import {
  buildSubagentDelegationRegistration,
  delegablePermissionProfiles,
  parseSubagentDepth,
  type SubagentDelegationHandle,
  type SubagentDelegationRegistration,
} from "./subagent";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

export class OrchestrateInputInvalid extends TaggedError("OrchestrateInputInvalid")<{
  readonly message: string;
}> {}

export class OrchestrateTargetUnavailable extends TaggedError("OrchestrateTargetUnavailable")<{
  readonly message: string;
}> {}

export class OrchestrateDenied extends TaggedError("OrchestrateDenied")<{
  readonly message: string;
}> {}

export class OrchestrateOperationFailed extends TaggedError("OrchestrateOperationFailed")<{
  readonly message: string;
}> {}

type OrchestrateError =
  | OrchestrateInputInvalid
  | OrchestrateTargetUnavailable
  | OrchestrateDenied
  | OrchestrateOperationFailed;

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 2_000;
const TERMINAL_RUN_STATES = new Set<WorkflowRun["state"]>(["succeeded", "failed", "cancelled"]);
const SUBAGENT_RUN_PREFIX = "wfrun:subagent:";
const WORKFLOW_RUN_PREFIX = "wfrun:";

export const orchestrateActions = ["read", "send", "interrupt"] as const;
export type OrchestrateAction = (typeof orchestrateActions)[number];

function createOrchestrateInputSchema(
  actions: readonly [OrchestrateAction, ...OrchestrateAction[]],
) {
  return z.strictObject({
    action: z.enum(actions),
    id: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .describe(
        "Target: a subagent run id (wfrun:subagent:…), a workflow run id (wfrun:…), or a thread id.",
      ),
    view: z
      .enum(["messages", "activity"])
      .optional()
      .describe("read: messages (default) shows text; activity adds tool calls and their output."),
    before: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("read: cursor from a previous read, to page to older items."),
    after: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("read: cursor from a previous read, to read only newer items."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(`read: items per page, default ${DEFAULT_LIMIT}.`),
    maxCharsPerItem: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .optional()
      .describe(`read: characters kept per item, default ${DEFAULT_MAX_CHARS}.`),
    message: z.string().min(1).max(65_536).optional().describe("send: the message to deliver."),
    mode: z
      .enum(["auto", "queue", "steer"])
      .optional()
      .describe(
        "send: auto (default) steers a running target and starts an idle one; queue waits for the current run to finish; steer only delivers to a running target.",
      ),
    commandId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("send: idempotency key. Retrying with the same key does not send twice."),
    runId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("interrupt, thread targets: stop only if this run is still the active one."),
  });
}

export type OrchestrateInput = z.output<ReturnType<typeof createOrchestrateInputSchema>>;

export function formatOrchestrateToolArgs(input: unknown): string {
  const decoded = createOrchestrateInputSchema(orchestrateActions).safeParse(input);
  if (!decoded.success) return "orchestrate";
  return [decoded.data.action, decoded.data.id].join(" ");
}

type DelegateHandler = (
  registration: SubagentDelegationRegistration,
) => Promise<SubagentDelegationHandle>;

export type OrchestrateToolOptions = {
  readonly config: CoreConfig;
  readonly cwd: string;
  /** "primary" or the calling run's permission profile name. */
  readonly runProfile: string;
  /** Whether this run may send to or interrupt targets; a run without it can only read. */
  readonly canControl: boolean;
  readonly idleTimeoutMs: number;
  readonly maxDepth: number;
  readonly requestContext: Level1ExecutionRequestContext<RegisteredSurfacePlatform>;
  readonly workflows?: DurableWorkflowStore;
  readonly transcripts?: Pick<TranscriptStore, "getRequestTranscript">;
  readonly liveSubagents?: () => SubagentReader | undefined;
  readonly threadControl?: SurfaceThreadControlResolver;
  /** Whether a request delivery was already accepted, so a keyed retry is not sent twice. */
  readonly requestDeliveryKnown?: (requestDeliveryId: string) => boolean;
  readonly bus?: LilacBus;
  readonly progressCards?: Pick<WorkflowProgressCardService, "requestProjection">;
  readonly delegate?: DelegateHandler;
  readonly now?: () => number;
};

const logger = createLogger({ module: "tool:orchestrate" });

function invalid(message: string) {
  return Result.err(new OrchestrateInputInvalid({ message }));
}

function unavailable(message: string) {
  return Result.err(new OrchestrateTargetUnavailable({ message }));
}

function denied(message: string) {
  return Result.err(new OrchestrateDenied({ message }));
}

function storeFailure(error: Error): OrchestrateOperationFailed {
  return new OrchestrateOperationFailed({ message: preserveToolPanic(error).message });
}

function bounded(text: string, maxChars: number) {
  return text.length <= maxChars
    ? { text, truncated: false }
    : { text: text.slice(0, maxChars), truncated: true };
}

function runResultText(run: WorkflowRun): string | null {
  if (run.resultArtifact) return "The result is stored as an artifact; use workflow.run.get.";
  if (run.result === null) return null;
  return typeof run.result === "string" ? run.result : JSON.stringify(run.result);
}

/**
 * Resolves a page of positions in a list of `total` items. Cursors are positions, so they stay
 * valid while the list grows. Without a cursor the page holds the newest items.
 */
function pageWindow(
  total: number,
  input: { before?: string; after?: string; limit: number },
): ResultType<{ start: number; end: number }, OrchestrateError> {
  const position = (cursor: string | undefined) => {
    if (cursor === undefined) return undefined;
    const value = Number(cursor);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const before = position(input.before);
  const after = position(input.after);
  if (before === null || after === null) return invalid("Cursor is not from this target");
  let start = Math.max(0, total - input.limit);
  let end = total;
  if (after !== undefined) {
    start = Math.min(after, total);
    end = Math.min(total, start + input.limit);
  }
  if (before !== undefined) {
    end = Math.min(before, total);
    start = Math.max(0, end - input.limit);
  }
  return Result.ok({ start, end });
}

function pageCursor(window: { start: number; end: number }) {
  return {
    /** Older items exist before this page. */
    hasMore: window.start > 0,
    ...(window.start > 0 ? { before: String(window.start) } : {}),
    after: String(window.end),
  };
}

function pageItems<T>(
  items: readonly T[],
  input: { before?: string; after?: string; limit: number },
) {
  return pageWindow(items.length, input).map((window) => ({
    items: items.slice(window.start, window.end),
    ...pageCursor(window),
  }));
}

type ThreadAccess = {
  readonly port: SurfaceThreadControlPort;
  readonly caller: ThreadControlCaller;
};

export function createOrchestrateTool(options: OrchestrateToolOptions) {
  const requestContext = options.requestContext;
  const actions: readonly [OrchestrateAction, ...OrchestrateAction[]] = options.canControl
    ? orchestrateActions
    : ["read"];
  const inputSchema = createOrchestrateInputSchema(actions);
  const now = options.now ?? Date.now;

  /**
   * A primary run's initiator is trusted only after its ingress was verified. A child's initiator
   * comes from its durable workflow origin, which Core wrote.
   */
  function threadAccess(): ThreadAccess | null {
    const initiator = requestContext.requestInitiator;
    if (!initiator || !options.threadControl || !isAdapterPlatform(initiator.platform)) return null;
    if (options.runProfile === "primary" && requestContext.serverOwnedRequest !== true) return null;
    const port = options.threadControl.resolve(initiator.platform);
    if (!port) return null;
    return {
      port,
      caller: {
        userId: initiator.userId,
        sourceThreadId: requestContext.requestInitiatorSessionId ?? requestContext.sessionId,
      },
    };
  }

  function requireThreadAccess(): ResultType<ThreadAccess, OrchestrateError> {
    const access = threadAccess();
    if (access) return Result.ok(access);
    return unavailable("Thread control is unavailable on this surface");
  }

  function requireWorkflows(): ResultType<DurableWorkflowStore, OrchestrateError> {
    return options.workflows
      ? Result.ok(options.workflows)
      : unavailable("Workflows are unavailable");
  }

  function loadRun(id: string): ResultType<WorkflowRun, OrchestrateError> {
    return Result.gen(function* () {
      const workflows = yield* requireWorkflows();
      const run = yield* workflows.getRun(id).mapError(storeFailure);
      if (!run) return unavailable(`No workflow run has id ${id}`);
      return Result.ok(run);
    });
  }

  function operations(run: WorkflowRun): ResultType<WorkflowOperation[], OrchestrateError> {
    return Result.gen(function* () {
      const workflows = yield* requireWorkflows();
      return workflows.listOperations(run.runId, { limit: 1_000 }).mapError(storeFailure);
    });
  }

  function latestAgentOperation(run: WorkflowRun) {
    return operations(run).map(
      (listed) =>
        listed.filter((operation) => operation.kind === "agent" && operation.requestId).at(-1) ??
        null,
    );
  }

  /** The session of the conversation a run ultimately serves, following parent subagents up. */
  function rootSession(run: WorkflowRun): ResultType<string, OrchestrateError> {
    return Result.gen(function* () {
      const workflows = yield* requireWorkflows();
      const visited = new Set<string>();
      let current = run;
      while (current.completionTarget.kind === "live_parent") {
        if (visited.has(current.runId)) break;
        visited.add(current.runId);
        const target = current.completionTarget;
        const parentOperation = yield* workflows
          .getOperationByRequestId(target.parentRequestId)
          .mapError(storeFailure);
        if (!parentOperation) return Result.ok(target.parentSessionId);
        const parent = yield* workflows.getRun(parentOperation.runId).mapError(storeFailure);
        if (!parent) return Result.ok(target.parentSessionId);
        current = parent;
      }
      return Result.ok(current.origin.sessionId ?? "");
    });
  }

  function callerRootSession(): ResultType<string, OrchestrateError> {
    return Result.gen(function* () {
      if (options.runProfile === "primary" || !options.workflows)
        return Result.ok(requestContext.sessionId);
      const operation = yield* options.workflows
        .getOperationByRequestId(requestContext.requestId)
        .mapError(storeFailure);
      if (!operation) return Result.ok(requestContext.sessionId);
      return rootSession(yield* loadRun(operation.runId));
    });
  }

  async function projectScope(): Promise<ResultType<string, OrchestrateError>> {
    const resolved = await Result.tryPromise({
      try: () => fs.realpath(path.resolve(options.cwd)),
      catch: (cause) =>
        new OrchestrateTargetUnavailable({
          message: `Workflow project root is unavailable: ${String(cause)}`,
        }),
    });
    return resolved.map((root) => `project:${sha256(root)}`);
  }

  async function authorizeWorkflowRead(run: WorkflowRun) {
    return Result.gen(async function* () {
      const workflows = yield* requireWorkflows();
      const revision = yield* workflows.getRevision(run.revisionId).mapError(storeFailure);
      const scope = yield* Result.await(projectScope());
      if (revision?.canonicalProjectId !== scope)
        return denied("The workflow run is outside this run's project");
      return Result.ok(revision);
    });
  }

  /** A run reads a subagent in its own conversation tree, or one under a thread it may read. */
  async function authorizeSubagentRead(run: WorkflowRun) {
    return Result.gen(async function* () {
      const root = yield* rootSession(run);
      if (root === (yield* callerRootSession())) return Result.ok(undefined);
      const access = threadAccess();
      const readable = access
        ? await access.port.read(access.caller, root, {
            view: "messages",
            limit: 1,
            maxCharsPerItem: 1,
          })
        : null;
      const allowed = readable?.match({ ok: () => true, err: () => false }) ?? false;
      if (allowed) return Result.ok(undefined);
      return denied("The subagent belongs to a conversation this run cannot read");
    });
  }

  /** Only the session that launched a subagent may message or stop it. */
  function authorizeSubagentControl(run: WorkflowRun) {
    if (!options.canControl) return denied("This run can only read targets");
    if (
      run.completionTarget.kind !== "live_parent" ||
      run.completionTarget.parentSessionId !== requestContext.sessionId
    )
      return denied("Only the conversation that launched this subagent can control it");
    return Result.ok(run.completionTarget);
  }

  function readInput(input: OrchestrateInput) {
    if (input.before && input.after) return invalid("Pass before or after, not both");
    return Result.ok({
      view: (input.view ?? "messages") as ThreadTimelineView,
      before: input.before,
      after: input.after,
      limit: input.limit ?? DEFAULT_LIMIT,
      maxCharsPerItem: input.maxCharsPerItem ?? DEFAULT_MAX_CHARS,
    });
  }

  async function readSubagent(run: WorkflowRun, input: OrchestrateInput) {
    return Result.gen(async function* () {
      const target = run.completionTarget;
      if (target.kind !== "live_parent") return unavailable("Not a subagent run");
      const read = yield* readInput(input);
      yield* Result.await(authorizeSubagentRead(run));
      const operation = yield* latestAgentOperation(run);
      const requestId = operation?.requestId ?? target.childRequestId;
      const live = options
        .liveSubagents?.()
        ?.readSubagentSnapshot(target.childSessionId, requestId, true);
      const saved = live
        ? null
        : yield* (
            options.transcripts?.getRequestTranscript?.({ requestId }) ?? Result.ok(null)
          ).mapError(storeFailure);
      const display = subagentMessages(
        live?.messages ?? saved?.messages ?? [],
        live?.streaming,
        live?.activeTools,
      );
      const page = yield* pageItems(
        projectThreadTimeline(display, read.view, read.maxCharsPerItem),
        read,
      );
      const policy = yield* operation?.requestId
        ? requireWorkflows().andThen((workflows) =>
            workflows.getWorkflowRequestDispatchPolicy(operation.requestId!).mapError(storeFailure),
          )
        : Result.ok(null);
      const resultText = TERMINAL_RUN_STATES.has(run.state) ? runResultText(run) : null;
      return Result.ok({
        kind: "subagent" as const,
        id: run.runId,
        state: run.state,
        running: !TERMINAL_RUN_STATES.has(run.state),
        profile: target.profile,
        sessionName: target.sessionName,
        ...(target.title ? { title: target.title } : {}),
        ...(policy ? { model: policy.resolvedModelRequest.spec } : {}),
        ...(run.terminalDetail ? { detail: run.terminalDetail } : {}),
        ...(resultText === null ? {} : { result: bounded(resultText, read.maxCharsPerItem) }),
        ...page,
      });
    });
  }

  async function readWorkflow(run: WorkflowRun, input: OrchestrateInput) {
    return Result.gen(async function* () {
      const read = yield* readInput(input);
      const revision = yield* Result.await(authorizeWorkflowRead(run));
      const workflows = yield* requireWorkflows();
      const window = yield* pageWindow(workflows.countOperations(run.runId), read);
      const items =
        window.end > window.start
          ? yield* workflows
              .listOperations(run.runId, {
                offset: window.start,
                limit: window.end - window.start,
              })
              .mapError(storeFailure)
          : [];
      const cursor = pageCursor(window);
      const resultText = TERMINAL_RUN_STATES.has(run.state) ? runResultText(run) : null;
      return Result.ok({
        kind: "workflow" as const,
        id: run.runId,
        name: revision.name,
        state: run.state,
        ...(run.terminalDetail ? { detail: run.terminalDetail } : {}),
        ...cursor,
        operations: items.map((operation) => ({
          operationId: operation.operationId,
          kind: operation.kind,
          ...(operation.label ? { label: operation.label } : {}),
          state: operation.state,
          ...(operation.error ? { error: bounded(operation.error, read.maxCharsPerItem) } : {}),
        })),
        ...(resultText === null ? {} : { result: bounded(resultText, read.maxCharsPerItem) }),
      });
    });
  }

  async function readThread(input: OrchestrateInput) {
    return Result.gen(async function* () {
      const read = yield* readInput(input);
      const access = yield* requireThreadAccess();
      const result = yield* Result.await(
        access.port
          .read(access.caller, input.id, read)
          .then((value) =>
            value.mapError((error) => new OrchestrateDenied({ message: error.message })),
          ),
      );
      return Result.ok({ kind: "thread" as const, ...result });
    });
  }

  async function steerSubagent(
    run: WorkflowRun,
    operation: WorkflowOperation,
    input: OrchestrateInput & { message: string },
    toolCallId: string,
  ) {
    return Result.gen(async function* () {
      const target = run.completionTarget;
      if (target.kind !== "live_parent" || !operation.requestId)
        return unavailable("Not a subagent run");
      if (!options.bus) return unavailable("Messaging is unavailable in this runtime");
      yield* Result.await(
        options.bus
          .publish(
            lilacEventTypes.CmdRequestMessage,
            {
              // The durable bus publishes a delivery ID once, so a keyed retry is not sent twice.
              requestDeliveryId: input.commandId
                ? keyedSteerDeliveryId(run, input.commandId)
                : crypto.randomUUID(),
              queue: "steer",
              messages: [{ role: "user", content: input.message }],
              raw: {
                requiresActive: true,
                // The runner sends an automatic steer that misses the run as a follow-up.
                ...((input.mode ?? "auto") === "auto"
                  ? {
                      autoFollowUp: {
                        parentRequestId: requestContext.requestId,
                        parentToolCallId: toolCallId,
                      },
                    }
                  : {}),
                subagent: { profile: target.profile, depth: target.depth },
              },
            },
            {
              headers: {
                request_id: operation.requestId,
                session_id: target.childSessionId,
                request_client: "unknown",
              },
            },
          )
          .then((published) => published.mapError(storeFailure)),
      );
      return Result.ok({
        kind: "subagent" as const,
        disposition: "steered" as const,
        runId: run.runId,
      });
    });
  }

  function keyedSteerDeliveryId(run: WorkflowRun, commandId: string): string {
    return `orchestrate-${sha256(`${requestContext.sessionId}:${run.runId}:${commandId}`).slice(0, 48)}`;
  }

  /** A keyed follow-up's child request ID ends with this, so a retry finds the run it started. */
  function followUpKeySuffix(commandId: string): string {
    return `:cmd-${sha256(`${requestContext.sessionId}:${commandId}`).slice(0, 40)}`;
  }

  function existingFollowUp(
    childSessionId: string,
    commandId: string,
  ): ResultType<WorkflowRun | null, OrchestrateError> {
    return Result.gen(function* () {
      const workflows = yield* requireWorkflows();
      const suffix = followUpKeySuffix(commandId);
      // Each page holds up to 100 runs plus one that signals another page.
      for (let offset = 0; ; offset += 100) {
        const runs = yield* workflows
          .listSubagentRuns(requestContext.sessionId, offset)
          .mapError(storeFailure);
        const found = runs
          .slice(0, 100)
          .find(
            (candidate) =>
              candidate.completionTarget.kind === "live_parent" &&
              candidate.completionTarget.childSessionId === childSessionId &&
              candidate.completionTarget.childRequestId.endsWith(suffix),
          );
        if (found) return Result.ok(found);
        if (runs.length <= 100) return Result.ok(null);
      }
    });
  }

  function replayKeyedSend(run: WorkflowRun, commandId: string | undefined) {
    return Result.gen(function* () {
      if (!commandId || run.completionTarget.kind !== "live_parent") return Result.ok(null);
      if (options.requestDeliveryKnown?.(keyedSteerDeliveryId(run, commandId)))
        return Result.ok({
          kind: "subagent" as const,
          disposition: "steered" as const,
          runId: run.runId,
        });
      const followUp = yield* existingFollowUp(run.completionTarget.childSessionId, commandId);
      if (!followUp) return Result.ok(null);
      return Result.ok({
        kind: "subagent" as const,
        disposition: "started" as const,
        runId: followUp.runId,
        previousRunId: run.runId,
      });
    });
  }

  async function followUpSubagent(
    run: WorkflowRun,
    operation: WorkflowOperation | null,
    input: OrchestrateInput & { message: string },
    toolCallId: string,
  ) {
    return Result.gen(async function* () {
      const target = run.completionTarget;
      if (target.kind !== "live_parent") return unavailable("Not a subagent run");
      if (!options.delegate) return unavailable("Subagent delegation is unavailable in this run");
      const allowed = delegablePermissionProfiles(options.config, options.runProfile);
      // Runs recorded before permission profiles carry retired role names.
      const profileName =
        resolveSubagentPermissionProfileName(options.config, target.profile) ?? target.profile;
      if (!allowed.some((profile) => profile.name === profileName))
        return denied(`Permission profile '${target.profile}' is not within this run's authority`);
      const ctx = {
        requestId: requestContext.requestId,
        sessionId: requestContext.sessionId,
        requestClient: requestContext.requestClient,
        subagentDepth: requestContext.subagentDepth,
        ...(requestContext.requestInitiator
          ? { requestInitiator: requestContext.requestInitiator }
          : {}),
        ...(requestContext.requestInitiatorSessionId
          ? { requestInitiatorSessionId: requestContext.requestInitiatorSessionId }
          : {}),
      };
      const depth = parseSubagentDepth(ctx);
      if (depth >= options.maxDepth)
        return denied("This run cannot start subagents (depth limit reached)");
      // A follow-up keeps the model and reasoning the subagent ran with.
      const policy = operation?.requestId
        ? yield* requireWorkflows().andThen((workflows) =>
            workflows.getWorkflowRequestDispatchPolicy(operation.requestId!).mapError(storeFailure),
          )
        : null;
      const registration = buildSubagentDelegationRegistration({
        ctx,
        toolCallId,
        mode: "deferred",
        profile: target.profile,
        sessionName: target.sessionName,
        task: input.message,
        ...(input.commandId
          ? {
              childRequestId: `sub:${requestContext.requestId}${followUpKeySuffix(input.commandId)}`,
            }
          : {}),
        ...(target.title ? { title: target.title } : {}),
        idleTimeoutMs: options.idleTimeoutMs,
        depth: depth + 1,
        ...(policy?.model ? { modelOverride: policy.model } : {}),
        ...((policy?.reasoning ?? target.reasoning)
          ? { reasoningOverride: (policy?.reasoning ?? target.reasoning)! }
          : {}),
      });
      if (registration.childSessionId !== target.childSessionId)
        return denied("Only the conversation that launched this subagent can continue it");
      const handle = yield* Result.await(
        Result.tryPromise({
          try: () => options.delegate!(registration),
          catch: (cause) =>
            new OrchestrateOperationFailed({
              message: cause instanceof Error ? cause.message : "Subagent follow-up failed",
            }),
        }),
      );
      return Result.ok({
        kind: "subagent" as const,
        disposition: "started" as const,
        runId: handle.runId,
        previousRunId: run.runId,
      });
    });
  }

  /**
   * A child is steerable only while the runner holds its request as the session's active run.
   * Without a live reader, the stored operation state decides.
   */
  function isLive(run: WorkflowRun, operation: WorkflowOperation | null): boolean {
    if (TERMINAL_RUN_STATES.has(run.state) || operation?.state !== "running") return false;
    if (run.completionTarget.kind !== "live_parent" || !operation.requestId) return false;
    const reader = options.liveSubagents?.();
    if (!options.liveSubagents) return true;
    return (
      reader?.readSubagentSnapshot(run.completionTarget.childSessionId, operation.requestId) !==
      undefined
    );
  }

  async function sendSubagent(run: WorkflowRun, input: OrchestrateInput, toolCallId: string) {
    return Result.gen(async function* () {
      yield* authorizeSubagentControl(run);
      const message = input.message!;
      const mode = input.mode ?? "auto";
      const operation = yield* latestAgentOperation(run);
      // A keyed retry returns what the first attempt did, even if the child has changed state.
      const replayed = yield* replayKeyedSend(run, input.commandId);
      if (replayed) return Result.ok(replayed);
      if (mode !== "queue" && operation && isLive(run, operation))
        return Result.ok(
          yield* Result.await(steerSubagent(run, operation, { ...input, message }, toolCallId)),
        );
      if (mode === "steer")
        return unavailable(
          "target-ended: the subagent is not running; use mode auto to send it as a follow-up",
        );
      // A follow-up on the same child session waits for any unfinished run there.
      return Result.ok(
        yield* Result.await(followUpSubagent(run, operation, { ...input, message }, toolCallId)),
      );
    });
  }

  async function sendThread(input: OrchestrateInput) {
    return Result.gen(async function* () {
      // Subagents control only their own children; other threads belong to primary runs.
      if (!options.canControl || options.runProfile !== "primary")
        return denied("Only a primary run can message or stop another thread");
      const access = yield* requireThreadAccess();
      const sent = yield* Result.await(
        access.port
          .send(access.caller, input.id, {
            text: input.message!,
            mode: input.mode ?? "auto",
            ...(input.commandId ? { commandId: input.commandId } : {}),
          })
          .then((value) =>
            value.mapError((error) => new OrchestrateDenied({ message: error.message })),
          ),
      );
      return Result.ok({ kind: "thread" as const, ...sent });
    });
  }

  async function interruptRun(run: WorkflowRun) {
    return Result.gen(async function* () {
      if (run.completionTarget.kind === "live_parent") yield* authorizeSubagentControl(run);
      else {
        if (!options.canControl || options.runProfile !== "primary")
          return denied("Only a primary run can interrupt a workflow run");
        yield* Result.await(authorizeWorkflowRead(run));
      }
      const workflows = yield* requireWorkflows();
      const cancelled = yield* Result.await(
        cancelWorkflowRun({
          store: workflows,
          ...(options.bus ? { bus: options.bus } : {}),
          ...(options.progressCards ? { progressCards: options.progressCards } : {}),
          run,
          detail: "Interrupted by the agent that controls it",
          now: now(),
        }).then((value) => value.mapError(storeFailure)),
      );
      return Result.ok({
        kind:
          run.completionTarget.kind === "live_parent"
            ? ("subagent" as const)
            : ("workflow" as const),
        id: run.runId,
        status: cancelled.changed ? ("cancelled" as const) : ("ended" as const),
        state: cancelled.run?.state ?? run.state,
      });
    });
  }

  async function interruptThread(input: OrchestrateInput) {
    return Result.gen(async function* () {
      // Subagents control only their own children; other threads belong to primary runs.
      if (!options.canControl || options.runProfile !== "primary")
        return denied("Only a primary run can message or stop another thread");
      const access = yield* requireThreadAccess();
      const interrupted = yield* Result.await(
        access.port
          .interrupt(access.caller, input.id, input.runId ? { runId: input.runId } : {})
          .then((value) =>
            value.mapError((error) => new OrchestrateDenied({ message: error.message })),
          ),
      );
      return Result.ok({ kind: "thread" as const, ...interrupted });
    });
  }

  async function execute(
    input: OrchestrateInput,
    toolCallId: string,
  ): Promise<ResultType<unknown, OrchestrateError>> {
    const isRun = input.id.startsWith(WORKFLOW_RUN_PREFIX);
    switch (true) {
      case input.action === "send" && !input.message:
        return invalid("send requires message");
      case input.action === "send" && isRun && !input.id.startsWith(SUBAGENT_RUN_PREFIX):
        return invalid("Workflow runs do not accept messages; read or interrupt them instead");
      case !isRun && input.action === "read":
        return await readThread(input);
      case !isRun && input.action === "send":
        return await sendThread(input);
      case !isRun:
        return await interruptThread(input);
    }
    return Result.gen(async function* () {
      const run = yield* loadRun(input.id);
      const subagent = run.completionTarget.kind === "live_parent";
      switch (input.action) {
        case "read":
          return subagent ? await readSubagent(run, input) : await readWorkflow(run, input);
        case "send":
          if (!subagent) return invalid("Workflow runs do not accept messages");
          return await sendSubagent(run, input, toolCallId);
        case "interrupt":
          return await interruptRun(run);
      }
    });
  }

  return tool({
    description: [
      "Read, message, or stop your subagents, workflow runs, and other threads.",
      "Pass the id from a subagent_delegate result (workflowRunId), a workflow run id, or a thread id.",
      "- read: progress and history. Use view activity to see tool calls and their output. Results never change the target.",
      "- send: deliver a message. A running target receives it as steering. A subagent that is not running gets a follow-up run in the same conversation, which reports back as a subagent_result like a deferred delegation. send returns once the message is accepted; it does not wait for a reply.",
      "- interrupt: stop the target's current run.",
      "Workflow runs accept read and interrupt only. To start a new subagent, use subagent_delegate.",
      ...(options.canControl ? [] : ["This run can only read."]),
    ].join("\n"),
    inputSchema,
    execute: async (input, { toolCallId }) => {
      const result = (await execute(input, toolCallId)).tapError((error) => {
        logger.warn("orchestrate failed", {
          action: input.action,
          requestId: requestContext.requestId,
          toolCallId,
          ...formatTaggedErrorForLog(error),
        });
      });
      return adaptToolResultToHost<unknown, OrchestrateError>(result);
    },
  });
}
