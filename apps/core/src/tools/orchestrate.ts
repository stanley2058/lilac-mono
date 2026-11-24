import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { lilacEventTypes, type AdapterPlatform, type LilacBus } from "@stanley2058/lilac-event-bus";
import {
  createLogger,
  formatTaggedErrorForLog,
  resolveSubagentPermissionProfileName,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import type { Level1ExecutionRequestContext } from "@stanley2058/lilac-plugin-runtime";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { isAdapterPlatform } from "../shared/is-adapter-platform";
import { deriveRequestDeliveryId } from "../shared/request-delivery-id";
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
import {
  SUBAGENT_RUN_ID_PREFIX,
  type WorkflowOperation,
  type WorkflowRun,
} from "../workflow/workflow-domain";
import type { WorkflowProgressCardService } from "../workflow/workflow-progress-projector";
import { cancelWorkflowRun } from "../workflow/workflow-run-cancel";
import {
  buildSubagentDelegationRegistration,
  delegablePermissionProfiles,
  parseSubagentDepth,
  type SubagentDelegationHandle,
  type SubagentDelegationRegistration,
} from "./subagent";
import {
  listDiscordThreads,
  parseTimeCursor,
  searchThreads,
  type DirectoryClient,
  type OrchestrateDirectoryPorts,
  type ThreadRow,
} from "./orchestrate-directory";
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
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SNIPPET_CHARS = 300;
const TERMINAL_RUN_STATES = new Set<WorkflowRun["state"]>(["succeeded", "failed", "cancelled"]);
const WORKFLOW_RUN_PREFIX = "wfrun:";

export const orchestrateActions = ["read", "send", "interrupt", "list", "search"] as const;
export type OrchestrateAction = (typeof orchestrateActions)[number];
const READ_ONLY_ACTIONS = [
  "read",
  "list",
  "search",
] as const satisfies readonly OrchestrateAction[];
const DIRECTORY_CLIENTS = ["native", "discord"] as const satisfies readonly DirectoryClient[];

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
      .optional()
      .describe(
        "read, send, interrupt: a subagent run id (wfrun:subagent:…), a workflow run id (wfrun:…), or a thread id.",
      ),
    client: z
      .enum(DIRECTORY_CLIENTS)
      .optional()
      .describe(
        "read of a thread id, list with scope user: the surface, by default the one that started this run. search: only this surface; by default every surface this run can reach.",
      ),
    scope: z
      .enum(["conversation", "user"])
      .optional()
      .describe(
        "list: conversation (default) lists the subagents in this conversation, nested ones included; user lists the user's threads or runs.",
      ),
    kind: z
      .enum(["thread", "subagent", "workflow"])
      .optional()
      .describe("list with scope user: thread (default), subagent, or workflow."),
    state: z
      .enum(["active", "finished", "all"])
      .optional()
      .describe("list of subagents or workflows: active, finished, or all (default)."),
    query: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("search: words to find in thread summaries and messages."),
    view: z
      .enum(["messages", "activity"])
      .optional()
      .describe("read: messages (default) shows text; activity adds tool calls and their output."),
    before: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("read, list: cursor from a previous result, to page to older items."),
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
      .describe(
        `read, list: items per page, default ${DEFAULT_LIMIT}. search: results, default ${DEFAULT_SEARCH_LIMIT}, at most ${MAX_SEARCH_LIMIT}.`,
      ),
    maxCharsPerItem: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .optional()
      .describe(
        `read: characters kept per item, default ${DEFAULT_MAX_CHARS}. search: characters per snippet, default ${DEFAULT_SNIPPET_CHARS}.`,
      ),
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
/** Input for an action on one target, which names it by id. */
type TargetInput = OrchestrateInput & { readonly id: string };

export function formatOrchestrateToolArgs(input: unknown): string {
  const decoded = createOrchestrateInputSchema(orchestrateActions).safeParse(input);
  if (!decoded.success) return "orchestrate";
  const { action, id, query, scope } = decoded.data;
  return [action, id ?? query ?? scope].filter(Boolean).join(" ");
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
  readonly directory?: OrchestrateDirectoryPorts;
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

/** The verified user a run acts for. */
type RunIdentity = {
  readonly platform: AdapterPlatform;
  readonly userId: string;
};

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function directoryFailure(error: Error): OrchestrateOperationFailed {
  return new OrchestrateOperationFailed({ message: error.message });
}

export function createOrchestrateTool(options: OrchestrateToolOptions) {
  const requestContext = options.requestContext;
  const actions: readonly [OrchestrateAction, ...OrchestrateAction[]] = options.canControl
    ? orchestrateActions
    : READ_ONLY_ACTIONS;
  const inputSchema = createOrchestrateInputSchema(actions);
  const now = options.now ?? Date.now;

  /**
   * A primary run's initiator is trusted only after its ingress was verified. A child's initiator
   * comes from its durable workflow origin, which Core wrote.
   */
  function identity(): RunIdentity | null {
    const initiator = requestContext.requestInitiator;
    if (!initiator || !isAdapterPlatform(initiator.platform)) return null;
    if (options.runProfile === "primary" && requestContext.serverOwnedRequest !== true) return null;
    return { platform: initiator.platform, userId: initiator.userId };
  }

  /**
   * The user ids a run may act as on a surface: its own, or the Discord accounts a native user
   * linked through Clerk. Links are looked up on each use, so an unlinked account stops working.
   */
  async function userIdsOn(known: RunIdentity, platform: AdapterPlatform) {
    if (platform === known.platform) return [known.userId];
    const native = options.directory?.native;
    if (platform !== "discord" || known.platform !== "native" || !native) return [];
    return native.linkedDiscordIds(known.userId);
  }

  /** Thread control on a surface, by default the one that started this run. */
  async function threadAccess(platform?: AdapterPlatform): Promise<ThreadAccess | null> {
    const known = identity();
    if (!known || !options.threadControl) return null;
    const surface = platform ?? known.platform;
    const userId = (await userIdsOn(known, surface))[0];
    const port = userId ? options.threadControl.resolve(surface) : null;
    if (!userId || !port) return null;
    return {
      port,
      caller: {
        userId,
        sourceThreadId: requestContext.requestInitiatorSessionId ?? requestContext.sessionId,
      },
    };
  }

  async function requireThreadAccess(
    platform?: AdapterPlatform,
  ): Promise<ResultType<ThreadAccess, OrchestrateError>> {
    const access = await threadAccess(platform);
    if (access) return Result.ok(access);
    if (!platform) return unavailable("Thread control is unavailable on this surface");
    return unavailable(
      `This run cannot reach ${platform} threads; a native user reaches Discord only through a linked Discord account`,
    );
  }

  /** The surface whose thread a run reports to, when the run records one. */
  function runSurface(run: WorkflowRun): AdapterPlatform | undefined {
    const client = run.origin.client;
    return client && client !== "unknown" && isAdapterPlatform(client) ? client : undefined;
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
      // The run's own surface decides; a thread id on another surface could name a different thread.
      const access = await threadAccess(runSurface(run));
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
  function authorizeSubagentControl(
    run: WorkflowRun,
  ): ResultType<
    Extract<WorkflowRun["completionTarget"], { kind: "live_parent" }>,
    OrchestrateError
  > {
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

  async function readThread(input: TargetInput) {
    return Result.gen(async function* () {
      const read = yield* readInput(input);
      const access = yield* Result.await(requireThreadAccess(input.client));
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
    return deriveRequestDeliveryId(
      "orchestrate.subagent-steer",
      requestContext.sessionId,
      run.runId,
      commandId,
    );
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

  async function sendThread(input: TargetInput) {
    return Result.gen(async function* () {
      // Subagents control only their own children; other threads belong to primary runs.
      if (!options.canControl || options.runProfile !== "primary")
        return denied("Only a primary run can message or stop another thread");
      const access = yield* Result.await(requireThreadAccess());
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

  async function interruptThread(input: TargetInput) {
    return Result.gen(async function* () {
      // Subagents control only their own children; other threads belong to primary runs.
      if (!options.canControl || options.runProfile !== "primary")
        return denied("Only a primary run can message or stop another thread");
      const access = yield* Result.await(requireThreadAccess());
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

  function invalidInput(error: Error) {
    return new OrchestrateInputInvalid({ message: error.message });
  }

  /** A keyset page of runs: at most `limit` rows, older than `before`, filtered by state. */
  function runPage(input: OrchestrateInput) {
    return parseTimeCursor(input.before)
      .mapError(invalidInput)
      .map((before) => ({
        limit: input.limit ?? DEFAULT_LIMIT,
        ...(before ? { before: { createdAt: before.time, runId: before.id } } : {}),
        ...(input.state === "active" ? { terminal: false } : {}),
        ...(input.state === "finished" ? { terminal: true } : {}),
      }));
  }

  /** This run's own subagent run id, so a listing can mark it. */
  function callerRunId(): ResultType<string | null, OrchestrateError> {
    if (options.runProfile === "primary" || !options.workflows) return Result.ok(null);
    return options.workflows
      .getOperationByRequestId(requestContext.requestId)
      .mapError(storeFailure)
      .map((operation) => operation?.runId ?? null);
  }

  function subagentRow(run: WorkflowRun, selfRunId: string | null) {
    return Result.gen(function* () {
      const target = run.completionTarget;
      if (target.kind !== "live_parent") return Result.ok([]);
      const workflows = yield* requireWorkflows();
      const parent = yield* workflows
        .getOperationByRequestId(target.parentRequestId)
        .mapError(storeFailure);
      return Result.ok([
        {
          kind: "subagent" as const,
          id: run.runId,
          ...(run.origin.client ? { client: run.origin.client } : {}),
          ...(parent ? { parentId: parent.runId } : {}),
          ...(target.title ? { title: target.title } : {}),
          profile: target.profile,
          state: run.state,
          startedAt: isoTime(run.startedAt ?? run.createdAt),
          ...(run.terminalAt ? { endedAt: isoTime(run.terminalAt) } : {}),
          controllable: authorizeSubagentControl(run).match({ ok: () => true, err: () => false }),
          self: run.runId === selfRunId,
        },
      ]);
    });
  }

  function workflowRow(run: WorkflowRun) {
    return Result.gen(function* () {
      const workflows = yield* requireWorkflows();
      const revision = yield* workflows.getRevision(run.revisionId).mapError(storeFailure);
      return Result.ok([
        {
          kind: "workflow" as const,
          id: run.runId,
          ...(run.origin.client ? { client: run.origin.client } : {}),
          ...(revision ? { name: revision.name } : {}),
          state: run.state,
          startedAt: isoTime(run.startedAt ?? run.createdAt),
          ...(run.terminalAt ? { endedAt: isoTime(run.terminalAt) } : {}),
        },
      ]);
    });
  }

  /** One page of runs, given one more than the page holds so the cursor shows another page. */
  function runRows(runs: readonly WorkflowRun[], limit: number) {
    return Result.gen(function* () {
      const selfRunId = yield* callerRunId();
      const page = runs.slice(0, limit);
      const items = [];
      for (const run of page)
        items.push(
          ...(run.completionTarget.kind === "live_parent"
            ? yield* subagentRow(run, selfRunId)
            : yield* workflowRow(run)),
        );
      const last = page.at(-1);
      return Result.ok({
        items,
        ...(last && runs.length > page.length ? { before: `${last.createdAt}_${last.runId}` } : {}),
      });
    });
  }

  function listConversation(input: OrchestrateInput) {
    return Result.gen(function* () {
      if ((input.kind ?? "subagent") !== "subagent" || input.client)
        return invalid(
          "scope conversation lists subagents; use scope user for threads, workflows, or another client",
        );
      const page = yield* runPage(input);
      const workflows = yield* requireWorkflows();
      const root = yield* callerRootSession();
      const runs = yield* workflows
        .listSubagentRuns(root, 0, { ...page, throughWorkflows: true })
        .mapError(storeFailure);
      return runRows(runs, page.limit);
    });
  }

  async function listUserThreads(
    client: AdapterPlatform,
    userId: string,
    input: OrchestrateInput,
  ): Promise<ResultType<{ items: ThreadRow[]; before?: string }, OrchestrateError>> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const native = options.directory?.native;
    const discord = options.directory?.discordAdapter?.();
    if (client === "native" && native)
      return native
        .threads(userId, { limit, ...(input.before ? { cursor: input.before } : {}) })
        .mapError(directoryFailure)
        .map((page) => ({
          items: page.items.map((thread) => ({
            kind: "thread" as const,
            id: thread.id,
            client: "native" as const,
            title: thread.title,
            updatedAt: isoTime(thread.updatedAt),
            active: thread.active,
          })),
          ...(page.nextCursor ? { before: page.nextCursor } : {}),
        }));
    if (client === "discord" && discord)
      return (
        await listDiscordThreads({
          adapter: discord,
          config: (await options.directory?.getConfig?.()) ?? options.config,
          limit,
          ...(input.before ? { cursor: input.before } : {}),
        })
      ).mapError(directoryFailure);
    return unavailable(`Listing ${client} threads is unavailable in this runtime`);
  }

  async function listUserRuns(
    client: AdapterPlatform,
    userIds: readonly string[],
    input: OrchestrateInput & { kind: "subagent" | "workflow" },
  ) {
    return Result.gen(async function* () {
      const page = yield* runPage(input);
      const workflows = yield* requireWorkflows();
      // Workflow runs are readable only within this run's project, so list only those.
      const project = input.kind === "workflow" ? yield* Result.await(projectScope()) : undefined;
      const runs = yield* workflows
        .listRunsByOriginUser({
          client,
          userIds,
          kind: input.kind,
          ...(project ? { canonicalProjectId: project } : {}),
          ...page,
          limit: page.limit + 1,
        })
        .mapError(storeFailure);
      return runRows(runs, page.limit);
    });
  }

  async function listUser(input: OrchestrateInput) {
    return Result.gen(async function* () {
      const known = yield* requireIdentity();
      const client = input.client ?? known.platform;
      const userIds = await userIdsOn(known, client);
      if (userIds.length === 0) return denied(`This run's user has no linked ${client} account`);
      const kind = input.kind ?? "thread";
      if (kind !== "thread")
        return Result.ok(yield* Result.await(listUserRuns(client, userIds, { ...input, kind })));
      if (input.state) return invalid("state applies to subagent and workflow lists");
      return Result.ok(yield* Result.await(listUserThreads(client, userIds[0]!, input)));
    });
  }

  function requireIdentity(): ResultType<RunIdentity, OrchestrateError> {
    const known = identity();
    if (known) return Result.ok(known);
    return unavailable("This run has no verified surface user to list or search as");
  }

  async function search(input: OrchestrateInput) {
    return Result.gen(async function* () {
      if (!input.query) return invalid("search requires query");
      const known = yield* requireIdentity();
      const identities: { client: DirectoryClient; userId: string }[] = [];
      for (const client of input.client ? [input.client] : DIRECTORY_CLIENTS) {
        const userId = (await userIdsOn(known, client))[0];
        if (userId) identities.push({ client, userId });
      }
      if (identities.length === 0)
        return denied(`This run's user has no linked ${input.client ?? known.platform} account`);
      const items = yield* Result.await(
        searchThreads({
          ports: options.directory ?? {},
          config: (await options.directory?.getConfig?.()) ?? options.config,
          identities,
          query: input.query,
          limit: Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
          snippetChars: input.maxCharsPerItem ?? DEFAULT_SNIPPET_CHARS,
        }).then((found) => found.mapError(directoryFailure)),
      );
      return Result.ok({ items });
    });
  }

  async function execute(
    input: OrchestrateInput,
    toolCallId: string,
  ): Promise<ResultType<unknown, OrchestrateError>> {
    const directoryAction = input.action === "list" || input.action === "search";
    if (directoryAction && input.id) return invalid(`${input.action} does not take an id`);
    if (input.action === "search") return await search(input);
    if (input.action === "list")
      return input.scope === "user" ? await listUser(input) : listConversation(input);
    const id = input.id;
    if (!id) return invalid(`${input.action} requires id`);
    return await executeOnTarget({ ...input, id }, toolCallId);
  }

  async function executeOnTarget(
    input: TargetInput,
    toolCallId: string,
  ): Promise<ResultType<unknown, OrchestrateError>> {
    const isRun = input.id.startsWith(WORKFLOW_RUN_PREFIX);
    switch (true) {
      case input.action === "send" && !input.message:
        return invalid("send requires message");
      case input.client !== undefined && (isRun || input.action !== "read"):
        return invalid("client applies to reading a thread id, list, and search");
      case input.action === "send" && isRun && !input.id.startsWith(SUBAGENT_RUN_ID_PREFIX):
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
        case "list":
        case "search":
          return invalid(`${input.action} does not take an id`);
      }
    });
  }

  return tool({
    description: [
      "Find, read, message, or stop your subagents, workflow runs, and other threads.",
      "Pass the id from a subagent_delegate result (workflowRunId), a workflow run id, or a thread id.",
      "- list: ids to act on. By default, the subagents in this conversation, with controllable marking the ones you may message or stop. scope user lists the user's threads, subagents, or workflows.",
      "- search: threads whose summaries or messages match query, with each thread's id and client.",
      "- read: progress and history. Use view activity to see tool calls and their output. Results never change the target. Pass a search result's client with its thread id.",
      "- send: deliver a message. A running target receives it as steering. A subagent that is not running gets a follow-up run in the same conversation, which reports back as a subagent_result like a deferred delegation. send returns once the message is accepted; it does not wait for a reply.",
      "- interrupt: stop the target's current run.",
      "Workflow runs accept read and interrupt only. To start a new subagent, use subagent_delegate.",
      ...(options.canControl
        ? []
        : ["This run can find and read targets but not message or stop them."]),
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
