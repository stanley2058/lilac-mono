import { realpath, stat } from "node:fs/promises";

import {
  AgentIdleTimeoutError,
  AiSdkPiAgent,
  attachAutoCompaction,
  compactMessages,
  createAgentRunIdleWatchdog,
  createTransientModelRetryController,
  type AiSdkPiAgentEvent,
  type AutoCompactionOptions,
  type TransientModelRetryConfig,
  type TurnBoundaryDecision,
} from "@stanley2058/lilac-agent";
import { createCodingToolset } from "@stanley2058/lilac-coding-tools";
import { subagentSessionNameSchema } from "@stanley2058/lilac-coding-tools/schemas";
import {
  miniLilacCancelResultSchema,
  miniLilacCompactResultSchema,
  miniLilacInterruptQueuedSteeringRequestSchema,
  miniLilacInterruptQueuedSteeringResultSchema,
  miniLilacLanguageModelUsageSchema,
  miniLilacProviderMetadataSchema,
  miniLilacReasoningSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSkillSummarySchema,
  miniLilacSteerResultSchema,
  miniLilacTodoSchema,
  miniLilacTodoStateSchema,
  miniLilacUIMessageSchema,
  miniLilacUserUIMessageSchema,
  miniLilacUndoResultSchema,
  miniLilacUpdateSessionBindingsRequestSchema,
  type MiniLilacCancelRequest,
  type MiniLilacCancelResult,
  type MiniLilacCompactRequest,
  type MiniLilacCompactResult,
  type MiniLilacControlResult,
  type MiniLilacInterruptQueuedSteeringRequest,
  type MiniLilacInterruptQueuedSteeringInput,
  type MiniLilacInterruptQueuedSteeringResult,
  type MiniLilacLanguageModelUsage,
  type MiniLilacReasoning,
  type MiniLilacSessionSnapshot,
  type MiniLilacSkillSummary,
  type MiniLilacSteerRequest,
  type MiniLilacSteerResult,
  type MiniLilacStreamCursorChunk,
  type MiniLilacSubagentStatus,
  type MiniLilacTodo,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
  type MiniLilacUIMessageMetadata,
  type MiniLilacUndoRequest,
  type MiniLilacUndoResult,
  type MiniLilacUpdateSessionBindingsRequest,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";
import {
  convertToModelMessages,
  readUIMessageStream,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import {
  createLogger,
  getCodexAuthStoragePath,
  ModelCapability,
  resolveEditingToolMode,
  withoutOpenAIItemIds,
} from "@stanley2058/lilac-utils";
import { z } from "zod";

import {
  runtimeConfigSchema,
  type AgentProfile,
  type LoadedRuntimeConfig,
  type RuntimeConfig,
} from "./config";
import { parseModelRef, resolveLanguageModel } from "./model-catalog";
import {
  reasoningProviderOptions,
  type LoadedProviderRegistry,
  type ProviderType,
} from "./providers";
import { MiniLilacSkillCatalog, type MiniLilacSkillCatalogSnapshot } from "./skills";
import {
  MiniLilacSqliteStore,
  type StoredCommandRequest,
  type StoredRunChunk,
  type StoredSessionResume,
  type StoredUIMessageChunk,
  type StoredUserCheckpoint,
} from "./sqlite-store";
import {
  createWebSearchProviderResolver,
  createWebsearchTool,
  type WebSearchProviderResolver,
} from "./web-search";
import { createWebfetchTool } from "./webfetch";

export type MiniLilacRuntimeChunk = StoredUIMessageChunk | MiniLilacStreamCursorChunk;

const logger = createLogger({ module: "mini-lilac-runtime:session-service" });
const CODEX_TRANSIENT_RETRY = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
} satisfies TransientModelRetryConfig;

export type ModelResolver = (modelSpecifier: string) => LanguageModel;
export type ModelLimitsResolver = (
  modelSpecifier: string,
) => Promise<{ readonly context: number; readonly output: number } | undefined>;

export type SessionServiceOptions = {
  config: RuntimeConfig | LoadedRuntimeConfig;
  databasePath?: string;
  store?: MiniLilacSqliteStore;
  modelResolver?: ModelResolver;
  providers?: LoadedProviderRegistry;
  modelCapability?: ModelCapability;
  modelLimitsResolver?: ModelLimitsResolver;
  attachCompaction?: (
    agent: AiSdkPiAgent<ToolSet>,
    options: AutoCompactionOptions,
  ) => Promise<() => void>;
  skillCatalog?: MiniLilacSkillCatalog;
  webSearchProviderResolver?: WebSearchProviderResolver;
  protectedToolPaths?: readonly string[];
  shutdownGraceMs?: number;
};

export type SessionServiceShutdownOptions = {
  graceMs?: number;
};

export type SessionResumeProjection = StoredSessionResume;

function parseSessionConfig(config: RuntimeConfig | LoadedRuntimeConfig): RuntimeConfig {
  if (!("configFile" in config)) return runtimeConfigSchema.parse(config);
  const { configFile: _configFile, ...runtimeConfig } = config;
  return runtimeConfigSchema.parse(runtimeConfig);
}

export type CreateSessionInput = {
  id?: string;
  cwd: string;
  model: string;
  profile?: string;
  reasoning?: MiniLilacReasoning;
};

export type StartedSessionRun = {
  runId: string;
  stream: ReadableStream<MiniLilacRuntimeChunk>;
};

type StartPromptOptions = {
  depth?: number;
  profileId?: string;
  overrides?: SubagentOverrides;
  idleTimeoutMs?: number;
};

type Subscriber = ReadableStreamDefaultController<MiniLilacRuntimeChunk>;

function streamCursor(runId: string, seq: number): MiniLilacStreamCursorChunk {
  return {
    type: "data-streamCursor",
    data: { runId, seq },
    transient: true,
  };
}

function enqueueStoredChunk(
  controller: ReadableStreamDefaultController<MiniLilacRuntimeChunk>,
  runId: string,
  entry: StoredRunChunk,
): void {
  controller.enqueue(streamCursor(runId, entry.seq));
  controller.enqueue(entry.chunk);
}

type DeferredChild = {
  runId: string;
  promise: Promise<SubagentTerminalResult>;
  readyAtBoundary: boolean;
  result?: SubagentTerminalResult;
  completionOrder?: number;
};

type RunContext = {
  runId: string;
  depth: number;
  profileId: string;
  deferred: DeferredChild[];
  childrenStarted: number;
  idleTimeoutMs?: number;
  reportActivity?: () => void;
};

type RunProjection = {
  runId: string;
  agent: AiSdkPiAgent<ToolSet>;
  eventQueue: Promise<void>;
  lastFinishReason?: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  stepOpen: boolean;
  streamFinished: boolean;
  eventError?: string;
  toolInputsAvailable: Map<string, { toolName: string; input: unknown }>;
  toolOutputsAvailable: Set<string>;
};

type ActiveRootRun = RunProjection & {
  context: RunContext;
  cancelRequested: boolean;
  initialUserSeen: boolean;
  phase: "accepting-controls" | "finalizing";
  uiChunkCursor: number;
  chronologicalUiPrefix: MiniLilacUIMessage[];
};

type SubagentCapacity = {
  tryAcquire(): boolean;
  release(): void;
};

type SubagentOverrides = {
  model?: string;
  effort?: MiniLilacReasoning;
};

type DelegatedSessionRequest = {
  parentSessionId: string;
  parentRunId: string;
  parentToolCallId: string;
  sessionName: string;
  profileId: string;
  prompt: string;
  depth: number;
  overrides: SubagentOverrides;
  reportActivity: () => void;
  onActivity: (toolCount: number, activity: string) => void;
};

type DelegatedSessionHandle = {
  sessionId: string;
  runId: string;
  completion: Promise<SubagentTerminalResult>;
  cancel: () => void;
};

const subagentInputSchema = z.object({
  profile: z.string().min(1),
  prompt: z.string().trim().min(1),
  mode: z.enum(["sync", "deferred"]).default("sync"),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional provider/model override for this child run."),
  effort: miniLilacReasoningSchema
    .optional()
    .describe("Optional reasoning-effort override for this child run."),
  sessionName: subagentSessionNameSchema
    .optional()
    .describe("Stable name used to continue this subagent session."),
});

const subagentTerminalResultSchema = z.object({
  status: z.enum(["completed", "cancelled", "error"]),
  childRunId: z.string(),
  childSessionId: z.string(),
  sessionName: subagentSessionNameSchema,
  profile: z.string(),
  text: z.string(),
  error: z.string().optional(),
});

type SubagentTerminalResult = z.infer<typeof subagentTerminalResultSchema>;

function generateSubagentSessionName(profileId: string): string {
  const prefix = profileId
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 48);
  return subagentSessionNameSchema.parse(
    `${prefix || "subagent"}-${crypto.randomUUID().slice(0, 8)}`,
  );
}

function delegatedSessionId(parentSessionId: string, sessionName: string): string {
  return `sub:${parentSessionId}:named:${sessionName}`;
}

const todoWriteInputSchema = z
  .object({
    todos: z
      .array(miniLilacTodoSchema)
      .max(50)
      .describe(
        "The complete replacement todo list. Include every item that should remain in the session.",
      ),
  })
  .strict()
  .superRefine((input, context) => {
    const parsed = miniLilacTodoStateSchema.safeParse({ revision: 0, todos: input.todos });
    parsed.error?.issues.forEach((issue) =>
      context.addIssue({ code: "custom", message: issue.message, path: issue.path }),
    );
  });

const TODO_WRITE_DESCRIPTION = [
  "Create and maintain the structured task list for the current coding session.",
  "Use this for non-trivial multi-step work, multiple user requests, or work that benefits from visible progress tracking. Skip it for a single straightforward task or a purely informational response.",
  "Each call replaces the entire list. Include all unchanged items that should remain; pass an empty list only to intentionally clear it.",
  "Keep items specific and actionable. Mark work in_progress before starting it, completed only after implementation and required verification finish, and cancelled when it is no longer needed. Keep exactly one item in_progress while actionable work remains.",
  "Update statuses as work progresses instead of batching completion updates at the end.",
].join("\n\n");

function commandId(value: string | undefined): string {
  return value ?? crypto.randomUUID();
}

function promptCommandRequest(
  snapshot: MiniLilacSessionSnapshot,
  userMessage: MiniLilacUIMessage,
): StoredCommandRequest {
  return {
    kind: "prompt",
    runId: null,
    payload: {
      userMessage,
      bindings: {
        cwd: snapshot.cwd,
        model: snapshot.model,
        profile: snapshot.profile,
        reasoning: snapshot.reasoning,
      },
    },
  };
}

function controlCommandRequest(
  kind: "steer" | "interrupt" | "cancel",
  runId: string,
  payload: unknown,
): StoredCommandRequest {
  return { kind, runId, payload };
}

function undoCommandRequest(): StoredCommandRequest {
  return { kind: "undo", runId: null, payload: {} };
}

function compactCommandRequest(): StoredCommandRequest {
  return { kind: "compact", runId: null, payload: {} };
}

function normalizeSessionTitle(value: string): string {
  const normalized = value
    .replace(/^\s*["'`]+|["'`]+\s*$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const title = (normalized || "Mini Lilac").slice(0, 50);
  return /[\uD800-\uDBFF]$/u.test(title) ? title.slice(0, -1) : title;
}

function fallbackSessionTitle(message: MiniLilacUserUIMessage): string {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  return normalizeSessionTitle(text);
}

function updateBindingsCommandRequest(
  request: MiniLilacUpdateSessionBindingsRequest,
): StoredCommandRequest {
  return {
    kind: "update-bindings",
    runId: null,
    payload: {
      model: request.model,
      profile: request.profile,
      reasoning: request.reasoning,
    },
  };
}

function browserSafeUsage(usage: LanguageModelUsage): MiniLilacLanguageModelUsage {
  return miniLilacLanguageModelUsageSchema.parse(JSON.parse(JSON.stringify(usage)));
}

function browserSafeProviderMetadata(metadataValue: unknown) {
  if (metadataValue === undefined) return undefined;
  return miniLilacProviderMetadataSchema.parse(JSON.parse(JSON.stringify(metadataValue)));
}

function metadata(
  snapshot: MiniLilacSessionSnapshot,
  usage?: LanguageModelUsage,
): MiniLilacUIMessageMetadata {
  return {
    createdAt: new Date().toISOString(),
    model: snapshot.model ?? undefined,
    profile: snapshot.profile ?? undefined,
    reasoning: snapshot.reasoning ?? undefined,
    usage: usage ? browserSafeUsage(usage) : undefined,
  };
}

function systemPrompt(
  config: RuntimeConfig,
  profile: AgentProfile,
  cwd: string,
  skillsSection?: string | null,
): string {
  return [
    config.agent.systemPrompt,
    profile.promptOverlay,
    skillsSection,
    `Working directory: ${cwd}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function profileRequestsTool(profile: AgentProfile, name: string): boolean {
  return profile.tools.includes("*") || profile.tools.includes(name);
}

function enabledProfileTools(profile: AgentProfile, availableTools: readonly string[]): string[] {
  const available = new Set(availableTools);
  const editingTool = available.has("apply_patch") ? "apply_patch" : "edit_file";
  const requested = profile.tools.includes("*")
    ? availableTools
    : [
        ...new Set(
          profile.tools
            .map((name) => (name === "apply_patch" || name === "edit_file" ? editingTool : name))
            .filter((name) => available.has(name)),
        ),
      ];
  return requested.filter((name) => {
    // Bash is trusted, unrestricted execution rather than a filesystem sandbox.
    if (name === "bash" && (!profile.execution || !profile.workspaceWrites)) return false;
    if ((name === "edit_file" || name === "apply_patch") && !profile.workspaceWrites) {
      return false;
    }
    if (name === "subagent_delegate" && !profile.delegation) return false;
    return true;
  });
}

function terminalText(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

async function assistantMessageFromChunks(
  runChunks: readonly StoredRunChunk[],
  afterSeq: number,
): Promise<{ message: MiniLilacUIMessage | null; throughSeq: number }> {
  const segment = runChunks.filter((entry) => entry.seq > afterSeq);
  const throughSeq = segment.at(-1)?.seq ?? afterSeq;
  if (segment.length === 0) return { message: null, throughSeq };
  const segmentChunks = segment
    .map((entry) => entry.chunk)
    .filter((chunk) => chunk.type !== "data-steering");
  const originalStart = runChunks.find((entry) => entry.chunk.type === "start")?.chunk;
  const firstSegmentSeq = segment[0]?.seq;
  const chunks =
    !segmentChunks.some((chunk) => chunk.type === "start") && originalStart?.type === "start"
      ? [
          {
            ...originalStart,
            messageId: `${originalStart.messageId ?? "assistant"}:segment-${firstSegmentSeq}`,
          },
          ...segmentChunks,
        ]
      : segmentChunks;
  const resetIndex = chunks.findLastIndex((chunk) => chunk.type === "data-transcriptReset");
  const start = chunks.find((chunk) => chunk.type === "start");
  const canonicalChunks =
    resetIndex >= 0 && start ? [start, ...chunks.slice(resetIndex + 1)] : chunks;
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      canonicalChunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
  let message: MiniLilacUIMessage | null = null;
  for await (const update of readUIMessageStream<MiniLilacUIMessage>({ stream })) {
    message = update;
  }
  return { message, throughSeq };
}

class SessionActor {
  private active: ActiveRootRun | undefined;
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly delegatedCancels = new Map<string, () => void>();
  private readonly titleControllers = new Map<string, AbortController>();
  private readonly steeringEntries: Array<{
    id: string;
    message: MiniLilacUserUIMessage;
    modelMessage: ModelMessage;
    state: "queued" | "consumed";
  }> = [];
  private readonly interruptedSteerCommandIds = new Set<string>();
  private deferredCompletionOrder = 0;
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private snapshot: MiniLilacSessionSnapshot,
    private readonly config: RuntimeConfig,
    private readonly store: MiniLilacSqliteStore,
    private readonly resolveModel: ModelResolver,
    private readonly modelCapability: ModelCapability,
    private readonly resolveModelLimits: ModelLimitsResolver,
    private readonly attachCompaction: (
      agent: AiSdkPiAgent<ToolSet>,
      options: AutoCompactionOptions,
    ) => Promise<() => void>,
    private readonly subagentCapacity: SubagentCapacity,
    private readonly promptDelegatedSession: (
      request: DelegatedSessionRequest,
    ) => Promise<DelegatedSessionHandle>,
    private readonly supersededProviderIds: ReadonlySet<string>,
    private readonly resolveProviderType: (providerId: string) => ProviderType | undefined,
    private readonly skillCatalog: MiniLilacSkillCatalog | undefined,
    private readonly resolveWebSearchProvider: WebSearchProviderResolver,
    private readonly protectedToolPaths: readonly string[],
    private readonly trackExecution: (task: Promise<void>) => Promise<void>,
    private readonly acceptsAdmissions: () => boolean,
  ) {}

  private withLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private beginCommandSideEffect(commandIdValue: string, request: StoredCommandRequest): void {
    try {
      this.store.markCommandSideEffectStarted(this.snapshot.id, commandIdValue, request);
    } catch (error) {
      this.store.releaseCommand(this.snapshot.id, commandIdValue, request);
      throw error;
    }
  }

  getSnapshot(): MiniLilacSessionSnapshot {
    this.snapshot = this.store.getSession(this.snapshot.id);
    return this.snapshot;
  }

  getMessages(): MiniLilacUIMessage[] {
    return this.store.getUiMessages(this.snapshot.id);
  }

  getSessionResume(): Promise<SessionResumeProjection> {
    return this.withLock(async () => {
      const active = this.active;
      if (active !== undefined) await active.eventQueue;
      return this.store.getSessionResume(this.snapshot.id);
    });
  }

  isQuiescent(): boolean {
    return (
      this.active === undefined &&
      this.delegatedCancels.size === 0 &&
      this.titleControllers.size === 0
    );
  }

  requestShutdown(): Promise<void> {
    for (const controller of this.titleControllers.values()) controller.abort();
    return this.withLock(() => {
      const active = this.active;
      if (active === undefined) return;
      active.cancelRequested = true;
      this.steeringEntries.length = 0;
      if (active.phase === "accepting-controls") {
        this.snapshot = this.store.updateSessionState(
          this.snapshot.id,
          "cancelling",
          0,
          active.runId,
        );
      }
      active.agent.cancel();
      for (const cancel of this.delegatedCancels.values()) cancel();
    });
  }

  streamRun(runId: string, afterSeq = 0): ReadableStream<MiniLilacRuntimeChunk> {
    let subscriber: Subscriber | undefined;
    return new ReadableStream<MiniLilacRuntimeChunk>({
      start: (controller) => {
        for (const entry of this.store.getChunks(runId, afterSeq)) {
          enqueueStoredChunk(controller, runId, entry);
        }
        if (this.projection(runId) === undefined || this.store.getRun(runId).status !== "active") {
          controller.close();
          return;
        }
        const runSubscribers = this.subscribers.get(runId) ?? new Set<Subscriber>();
        runSubscribers.add(controller);
        subscriber = controller;
        this.subscribers.set(runId, runSubscribers);
      },
      cancel: () => {
        const runSubscribers = this.subscribers.get(runId);
        if (!runSubscribers || !subscriber) return;
        runSubscribers.delete(subscriber);
        if (runSubscribers.size === 0) this.subscribers.delete(runId);
      },
    });
  }

  async startPrompt(
    userMessageValue: MiniLilacUIMessage,
    clientCommandId: string = crypto.randomUUID(),
    options: StartPromptOptions = {},
  ): Promise<StartedSessionRun> {
    return this.withLock(async () => {
      if (!this.acceptsAdmissions()) {
        throw new Error("SessionService is shutting down and is not accepting admissions");
      }
      const parsedMessage = miniLilacUIMessageSchema.parse(userMessageValue);
      if (parsedMessage.role !== "user") throw new Error("startPrompt requires a user UI message");
      const userMessage = miniLilacUserUIMessageSchema.parse(parsedMessage);
      const command = promptCommandRequest(this.snapshot, userMessage);
      const previous = this.store.getCommandResult(this.snapshot.id, clientCommandId, command);
      if (previous !== undefined) {
        const runId = z.object({ runId: z.string().min(1) }).parse(previous).runId;
        return { runId, stream: this.streamRun(runId) };
      }
      if (this.active || this.store.getLatestRun(this.snapshot.id)?.status === "active") {
        throw new Error(`Session '${this.snapshot.id}' already has an active run`);
      }

      const profileId = options.profileId ?? this.snapshot.profile;
      const modelSpecifier = this.snapshot.model;
      const reasoning = this.snapshot.reasoning;
      if (!profileId || !modelSpecifier || !reasoning) {
        throw new Error(`Session '${this.snapshot.id}' is not fully configured`);
      }
      const profile = this.config.agent.profiles[profileId];
      if (!profile || (profile.subagentOnly && (options.depth ?? 0) === 0)) {
        throw new Error(`Profile '${profileId}' cannot run a top-level session`);
      }

      const priorModelMessages = this.store.getModelMessages(this.snapshot.id);
      const priorUiMessages = this.store.getUiMessages(this.snapshot.id);
      const isFirstPrompt = priorUiMessages.length === 0;
      const initialTitle = isFirstPrompt ? fallbackSessionTitle(userMessage) : undefined;
      const converted = await convertToModelMessages([userMessage]);
      const userModelMessage = converted[0];
      if (converted.length !== 1 || userModelMessage?.role !== "user") {
        throw new Error("User UI message did not convert to one model user message");
      }
      const runId = crypto.randomUUID();
      const context: RunContext = {
        runId,
        depth: options.depth ?? 0,
        profileId,
        deferred: [],
        childrenStarted: 0,
        idleTimeoutMs: options.idleTimeoutMs,
      };
      this.store.reserveCommand(this.snapshot.id, clientCommandId, command);
      let admitted = false;
      try {
        const agent = await this.createAgent(
          profileId,
          context,
          priorModelMessages,
          options.overrides,
        );
        this.snapshot = this.store.beginRootRun({
          run: {
            id: runId,
            sessionId: this.snapshot.id,
            profile: profileId,
            depth: context.depth,
          },
          commandId: clientCommandId,
          commandPayload: command.payload,
          modelMessages: [...priorModelMessages, userModelMessage],
          uiMessages: [...priorUiMessages, userMessage],
          title: initialTitle,
        });
        admitted = true;
        this.active = {
          runId,
          agent,
          context,
          eventQueue: Promise.resolve(),
          cancelRequested: false,
          initialUserSeen: false,
          stepOpen: false,
          phase: "accepting-controls",
          streamFinished: false,
          uiChunkCursor: 0,
          chronologicalUiPrefix: [...priorUiMessages, userMessage],
          toolInputsAvailable: new Map(),
          toolOutputsAvailable: new Set(),
        };
        agent.subscribe((event) => {
          this.enqueueEvent(runId, event);
        });

        if (isFirstPrompt && this.config.agent.titleModel !== undefined) {
          const controller = new AbortController();
          this.titleControllers.set(runId, controller);
          const titleTask = this.generateSessionTitle(
            runId,
            initialTitle ?? "Mini Lilac",
            userMessage,
            controller.signal,
          ).finally(() => {
            if (this.titleControllers.get(runId) === controller) {
              this.titleControllers.delete(runId);
            }
          });
          void this.trackExecution(titleTask);
        }

        const execution = Promise.resolve().then(() =>
          this.executeTopLevelRun(agent, context, userModelMessage),
        );
        const trackedExecution = this.trackExecution(execution);
        void trackedExecution.finally(() => this.closeSubscribers(runId));
        return { runId, stream: this.streamRun(runId) };
      } catch (error) {
        if (!admitted) {
          this.active = undefined;
          this.closeSubscribers(runId);
          this.store.releaseCommand(this.snapshot.id, clientCommandId, command);
        }
        throw error;
      }
    });
  }

  cancelDelegatedRun(runId: string): void {
    void this.withLock(() => {
      const active = this.active;
      if (!active || active.runId !== runId || active.phase !== "accepting-controls") return;
      active.cancelRequested = true;
      this.snapshot = this.store.updateSessionState(
        this.snapshot.id,
        "cancelling",
        0,
        active.runId,
      );
      active.agent.cancel();
      for (const cancel of this.delegatedCancels.values()) cancel();
    });
  }

  private async createAgent(
    profileId: string,
    context: RunContext,
    messages: ModelMessage[],
    overrides: SubagentOverrides = {},
  ): Promise<AiSdkPiAgent<ToolSet>> {
    const profile = this.config.agent.profiles[profileId];
    if (!profile) throw new Error(`Unknown profile '${profileId}'`);
    const modelSpecifier = overrides.model ?? this.snapshot.model;
    const reasoning = overrides.effort ?? this.snapshot.reasoning;
    if (!modelSpecifier || !reasoning) throw new Error("Session model and reasoning are required");

    const skills =
      this.skillCatalog !== undefined && profileRequestsTool(profile, "skill")
        ? await this.skillCatalog.discover(this.snapshot.cwd)
        : undefined;
    const tools = this.createTools(profile, context, modelSpecifier, skills);
    const skillContextWindow =
      tools.skill === undefined
        ? undefined
        : ((await this.resolveModelLimits(modelSpecifier))?.context ??
          this.snapshot.contextWindow ??
          undefined);
    const providerId = parseModelRef(modelSpecifier).providerId;
    const usesCodexOAuth = this.supersededProviderIds.has(providerId);
    const providerOptions = reasoningProviderOptions({
      usesCodexOAuth,
      providerType: this.resolveProviderType(providerId),
      reasoningEnabled: reasoning !== "none",
    });
    let transientRetryOutputStarted = false;
    const transientRetryController = usesCodexOAuth
      ? createTransientModelRetryController({
          retry: CODEX_TRANSIENT_RETRY,
          logger,
          requestId: context.runId,
          sessionId: this.snapshot.id,
          modelSpec: modelSpecifier,
          hasStartedOutput: () => transientRetryOutputStarted,
        })
      : undefined;
    const agent = new AiSdkPiAgent<ToolSet>({
      system: systemPrompt(
        this.config,
        profile,
        this.snapshot.cwd,
        tools.skill === undefined ? undefined : skills?.promptSection(skillContextWindow),
      ),
      model: this.resolveModel(modelSpecifier),
      modelSpecifier,
      reasoning,
      tools,
      exclusiveToolNames: tools.skill === undefined ? undefined : new Set(["skill"]),
      messages,
      providerOptions,
      turnErrorHandler: transientRetryController?.handler,
      turnBoundaryHandler: () => this.finishDeferredChildren(context),
    });
    if (transientRetryController) {
      agent.subscribe((event) => {
        if (event.type === "turn_end") {
          transientRetryController.reset();
          transientRetryOutputStarted = false;
          return;
        }
        if (event.type !== "message_update") return;
        const update = event.assistantMessageEvent;
        if (
          (update.type === "text_delta" && update.delta.length > 0) ||
          (update.type === "thinking_delta" && update.delta.length > 0) ||
          update.type === "toolcall_start"
        ) {
          transientRetryOutputStarted = true;
        }
      });
    }
    agent.setSteeringMode("all");
    const configuredSummaryModel = this.config.agent.compaction.model;
    await this.attachCompaction(agent, {
      model: modelSpecifier,
      modelCapability: this.modelCapability,
      summaryModel:
        configuredSummaryModel === "inherit"
          ? "current"
          : this.resolveModel(configuredSummaryModel),
      thresholdFraction: this.config.agent.compaction.earlyCompactionPoint,
      resolveCurrentModelSpecifier: () => agent.state.modelSpecifier,
      resolveContextLimit: async ({ defaultModel, currentModelSpecifier }) =>
        (await this.resolveModelLimits(currentModelSpecifier ?? defaultModel)) ?? 0,
      baseTurnErrorHandler: transientRetryController?.handler,
      onCompactionEnd: (event) => this.queueAutomaticCompaction(event),
    });
    if (context.depth === 0) {
      agent.appendTransformMessages((outboundMessages) => {
        if (outboundMessages.at(-1)?.role === "assistant") {
          throw new Error("Cannot append todo context after an assistant message");
        }
        const state = this.store.getTodos(this.snapshot.id);
        if (state.revision === 0) return [...outboundMessages];
        const serialized = JSON.stringify({ revision: state.revision, todos: state.todos });
        return [
          ...outboundMessages,
          {
            role: "user",
            content: [
              "<session-todos>",
              "This is the authoritative current todo state for this session, not a new user request.",
              "It supersedes todo state found in older tool calls or compaction summaries.",
              serialized,
              "</session-todos>",
            ].join("\n"),
          },
        ];
      });
    }
    if (usesCodexOAuth) agent.appendTransformMessages(withoutOpenAIItemIds);
    return agent;
  }

  private async generateSessionTitle(
    runId: string,
    fallbackTitle: string,
    message: MiniLilacUserUIMessage,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const titleModel = this.config.agent.titleModel;
    if (titleModel === undefined) return;
    try {
      const prompt = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const modelRef = parseModelRef(titleModel);
      const usesCodexOAuth = this.supersededProviderIds.has(modelRef.providerId);
      const result = streamText({
        model: this.resolveModel(titleModel),
        instructions:
          "You are a title generator. Output only one natural, single-line title of at most 50 characters, using the user's language. Focus on the user's main topic or requested outcome; preserve exact technical terms, filenames, numbers, and HTTP codes. Never answer the request, narrate your process or next steps, mention tools, or add quotes or explanations.",
        prompt,
        maxOutputTokens: usesCodexOAuth ? undefined : 64,
        providerOptions: usesCodexOAuth ? { openai: { store: false } } : undefined,
        abortSignal,
      });
      let rejectAbort: (reason: DOMException) => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => rejectAbort(new DOMException("Title generation aborted", "AbortError"));
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
      let titleText: string;
      try {
        titleText = await Promise.race([result.text, aborted]);
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
      }
      const title = normalizeSessionTitle(titleText);
      await this.withLock(async () => {
        this.snapshot = this.store.updateSessionTitle(this.snapshot.id, fallbackTitle, title);
        const active = this.active;
        if (!active || active.runId !== runId || active.streamFinished) return;
        const operation = active.eventQueue.then(() =>
          this.appendChunk(runId, { type: "data-session", data: this.snapshot }),
        );
        active.eventQueue = operation.catch((error) => this.reportEventFailure(runId, error));
        await operation;
      });
    } catch (error) {
      if (abortSignal.aborted) return;
      const messageValue = error instanceof Error ? error.message : String(error);
      console.warn(`Mini Lilac title generation failed: ${messageValue}`);
    }
  }

  private createTools(
    profile: AgentProfile,
    context: RunContext,
    modelSpecifier: string,
    skills?: MiniLilacSkillCatalogSnapshot,
  ): ToolSet {
    const profileIds = Object.keys(this.config.agent.profiles);
    const profileDescriptions = profileIds
      .map((id) => {
        const entry = this.config.agent.profiles[id];
        return `${id}: ${entry?.description ?? "No description"}`;
      })
      .join("\n");
    const delegationTool = tool({
      description:
        "Delegate a task to a subagent using one configured profile. Reuse sessionName to continue the same subagent session with its prior context. Profiles:\n" +
        profileDescriptions,
      inputSchema: subagentInputSchema.extend({ profile: z.enum(profileIds) }),
      execute: async (input, options) =>
        this.delegate(
          context,
          options.toolCallId,
          input.profile,
          input.prompt,
          input.mode,
          input.sessionName,
          { model: input.model, effort: input.effort },
          options.abortSignal,
        ),
    });
    const skillTool =
      skills === undefined
        ? undefined
        : tool({
            description:
              "Load the complete instructions and bounded resource inventory for one available skill. Use the exact name from the available skills catalog or an @skills:<name> token.",
            inputSchema: z.object({
              name: miniLilacSkillSummarySchema.shape.name.describe(
                "Exact skill name from the available skills catalog",
              ),
            }),
            execute: ({ name }) => skills.load(name),
          });
    const webSearchProvider = this.resolveWebSearchProvider(modelSpecifier);
    const todoWriteTool =
      context.depth === 0 && profileRequestsTool(profile, "todowrite")
        ? tool({
            description: TODO_WRITE_DESCRIPTION,
            inputSchema: todoWriteInputSchema,
            execute: ({ todos }) => this.replaceTodos(context, todos),
          })
        : undefined;
    const extraTools: ToolSet = {
      ...createWebfetchTool(),
      ...(webSearchProvider === undefined
        ? {}
        : createWebsearchTool({
            model: this.resolveModel(modelSpecifier),
            modelSpecifier,
            provider: webSearchProvider,
          })),
      ...(skillTool === undefined ? {} : { skill: skillTool }),
      ...(todoWriteTool === undefined ? {} : { todowrite: todoWriteTool }),
      ...(profile.delegation && this.config.agent.subagents.enabled
        ? { subagent_delegate: delegationTool }
        : {}),
    };
    const commonOptions = {
      cwd: this.snapshot.cwd,
      fsBackend: "fff",
      extraTools,
      batchExcludedTools: ["todowrite"],
      bashStreamOutput: true,
      bashMergeOutput: true,
      allowGuardrailBypass: false,
      denyPaths: this.protectedToolPaths,
      bashEnv: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== this.config.server.authTokenEnv),
      ),
    } as const;
    const modelRef = parseModelRef(modelSpecifier);
    const editingToolMode = resolveEditingToolMode({
      provider: modelRef.providerId,
      modelId: modelRef.modelId,
    });
    const availableTools = Object.keys(createCodingToolset(commonOptions)).filter(
      (name) =>
        (name !== "apply_patch" || editingToolMode === "apply_patch") &&
        (name !== "edit_file" || editingToolMode === "edit_file"),
    );
    return createCodingToolset({
      ...commonOptions,
      enabledTools: enabledProfileTools(profile, availableTools),
    });
  }

  private replaceTodos(context: RunContext, todos: readonly MiniLilacTodo[]) {
    return this.withLock(async () => {
      const active = this.active;
      this.snapshot = this.store.getSession(this.snapshot.id);
      if (
        context.depth !== 0 ||
        !active ||
        active.runId !== context.runId ||
        this.snapshot.activeRunId !== context.runId ||
        this.store.getRun(context.runId).status !== "active"
      ) {
        throw new Error(`Run '${context.runId}' is not active for session '${this.snapshot.id}'`);
      }
      if (
        active.phase !== "accepting-controls" ||
        active.cancelRequested ||
        active.streamFinished ||
        this.snapshot.status === "cancelling" ||
        !active.agent.state.isStreaming
      ) {
        throw new Error(`Session '${this.snapshot.id}' is not accepting todo updates`);
      }

      const operation = active.eventQueue.then(async () => {
        this.snapshot = this.store.getSession(this.snapshot.id);
        if (
          this.active !== active ||
          active.phase !== "accepting-controls" ||
          active.cancelRequested ||
          active.streamFinished ||
          this.snapshot.activeRunId !== context.runId ||
          this.snapshot.status === "cancelling" ||
          this.store.getRun(context.runId).status !== "active"
        ) {
          throw new Error(`Run '${context.runId}' stopped accepting todo updates`);
        }
        const result = await this.store.replaceTodosForRun({
          sessionId: this.snapshot.id,
          runId: context.runId,
          todos,
        });
        if (result.storedChunk !== undefined) {
          this.publishStoredChunk(context.runId, result.storedChunk);
        }
        return result.state;
      });
      active.eventQueue = operation.then(
        () => undefined,
        (error) => this.reportEventFailure(context.runId, error),
      );
      return operation;
    });
  }

  private async delegate(
    parent: RunContext,
    toolCallId: string,
    profileId: string,
    prompt: string,
    mode: "sync" | "deferred",
    requestedSessionName: string | undefined,
    overrides: SubagentOverrides,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.config.agent.subagents.enabled) {
      return { status: "rejected", reason: "subagent delegation is disabled" };
    }
    if (parent.depth >= this.config.agent.subagents.maxDepth) {
      return { status: "rejected", reason: "maximum subagent depth reached" };
    }
    if (parent.childrenStarted >= this.config.agent.subagents.maxChildrenPerRun) {
      return { status: "rejected", reason: "maximum children per run reached" };
    }
    if (!this.config.agent.profiles[profileId]) {
      return { status: "rejected", reason: `unknown profile '${profileId}'` };
    }
    const sessionName = requestedSessionName ?? generateSubagentSessionName(profileId);
    const childSessionId = delegatedSessionId(this.snapshot.id, sessionName);
    try {
      const child = this.store.getSession(childSessionId);
      if (child.activeRunId !== null) {
        return {
          status: "rejected",
          childSessionId,
          sessionName,
          reason: `subagent session '${sessionName}' already has an active run`,
        };
      }
    } catch {
      // The session will be created during delegated admission.
    }
    if (!this.subagentCapacity.tryAcquire()) {
      return { status: "rejected", reason: "maximum concurrent subagents reached" };
    }

    parent.childrenStarted += 1;
    let toolCount = 0;
    let activity: string | undefined;
    let handle: DelegatedSessionHandle | undefined;
    const queueRunningStatus = () => {
      if (handle === undefined) return;
      this.queueSubagentStatus(parent.runId, {
        toolCallId,
        runId: handle.runId,
        sessionId: childSessionId,
        sessionName,
        profile: profileId,
        prompt,
        mode,
        state: "running",
        toolCount,
        ...(activity ? { activity } : {}),
      });
    };
    try {
      handle = await this.promptDelegatedSession({
        parentSessionId: this.snapshot.id,
        parentRunId: parent.runId,
        parentToolCallId: toolCallId,
        sessionName,
        profileId,
        prompt,
        depth: parent.depth + 1,
        overrides,
        reportActivity: () => parent.reportActivity?.(),
        onActivity: (nextToolCount, nextActivity) => {
          toolCount = nextToolCount;
          activity = nextActivity;
          parent.reportActivity?.();
          queueRunningStatus();
        },
      });
    } catch (error) {
      this.subagentCapacity.release();
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "error",
        childRunId: "unavailable",
        childSessionId,
        sessionName,
        profile: profileId,
        text: "",
        error: message,
      } satisfies SubagentTerminalResult;
    }
    if (handle === undefined) throw new Error("Subagent session admission returned no handle");
    const childRunId = handle.runId;
    this.delegatedCancels.set(childRunId, handle.cancel);
    queueRunningStatus();
    const promise = handle.completion
      .catch((error): SubagentTerminalResult => {
        const message = error instanceof Error ? error.message : String(error);
        const result: SubagentTerminalResult = {
          status: "error",
          childRunId,
          childSessionId,
          sessionName,
          profile: profileId,
          text: "",
          error: message,
        };
        return result;
      })
      .then((result) => {
        this.queueSubagentStatus(parent.runId, {
          toolCallId,
          runId: childRunId,
          sessionId: childSessionId,
          sessionName,
          profile: profileId,
          prompt,
          mode,
          state: result.status,
          toolCount,
          ...(activity ? { activity } : {}),
          text: result.text,
          ...(result.error ? { error: result.error } : {}),
        });
        return result;
      })
      .finally(() => {
        this.subagentCapacity.release();
        this.delegatedCancels.delete(childRunId);
      });
    const abortChild = () => handle.cancel();
    abortSignal?.addEventListener("abort", abortChild, { once: true });
    if (abortSignal?.aborted) abortChild();
    if (mode === "deferred") {
      const deferred: DeferredChild = { runId: childRunId, promise, readyAtBoundary: false };
      parent.deferred.push(deferred);
      void promise.then((result) => {
        deferred.result = result;
        deferred.completionOrder = ++this.deferredCompletionOrder;
        abortSignal?.removeEventListener("abort", abortChild);
      });
      return {
        status: "accepted",
        childRunId,
        childSessionId,
        sessionName,
        profile: profileId,
        mode,
      };
    }
    try {
      return await promise;
    } finally {
      abortSignal?.removeEventListener("abort", abortChild);
    }
  }

  private async finishDeferredChildren(context: RunContext): Promise<TurnBoundaryDecision> {
    if (context.deferred.length === 0) return {};
    const eligible = context.deferred.filter((child) => child.readyAtBoundary);
    context.deferred.forEach((child) => {
      child.readyAtBoundary = true;
    });
    if (eligible.length === 0) return {};
    await Promise.all(eligible.map((child) => child.promise));
    const eligibleIds = new Set(eligible.map((child) => child.runId));
    context.deferred = context.deferred.filter((child) => !eligibleIds.has(child.runId));
    const results = eligible
      .sort((left, right) => (left.completionOrder ?? 0) - (right.completionOrder ?? 0))
      .map((child) => child.result)
      .filter((result): result is SubagentTerminalResult => result !== undefined);
    const append: ModelMessage[] = [];
    results.forEach((result) => {
      const toolCallId = `subagent-result-${result.childRunId}`;
      append.push(
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId,
              toolName: "subagent_result",
              input: { childRunId: result.childRunId, profile: result.profile },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: "subagent_result",
              output: { type: "json", value: result },
            },
          ],
        },
      );
    });
    return { append, forceNextTurn: true };
  }

  private async executeTopLevelRun(
    agent: AiSdkPiAgent<ToolSet>,
    context: RunContext,
    userModelMessage: ModelMessage,
  ): Promise<void> {
    const idleWatchdog = createAgentRunIdleWatchdog({
      idleTimeoutMs: context.idleTimeoutMs ?? this.config.agent.idleTimeoutMs,
      onTimeout: (error) => {
        const active = this.active;
        if (active?.runId === context.runId) active.eventError ??= error.message;
        logger.warn("agent run idle timeout", {
          requestId: context.runId,
          sessionId: this.snapshot.id,
          idleTimeoutMs: context.idleTimeoutMs ?? this.config.agent.idleTimeoutMs,
        });
        agent.cancel();
      },
    });
    context.reportActivity = () => idleWatchdog.reset();
    const unsubscribeActivity = agent.subscribe(() => idleWatchdog.reset());
    idleWatchdog.start();
    const operation = agent.prompt(userModelMessage);
    let thrown: string | undefined;
    try {
      await idleWatchdog.waitFor(operation);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
      if (error instanceof AgentIdleTimeoutError) {
        const settled = await Promise.race([
          operation.then(
            () => true,
            () => true,
          ),
          Bun.sleep(5_000).then(() => false),
        ]);
        if (!settled) {
          logger.warn("agent operation did not settle after cancellation grace period", {
            requestId: context.runId,
            sessionId: this.snapshot.id,
            reason: "idle_timeout",
            abortGraceMs: 5_000,
          });
        }
      }
    } finally {
      idleWatchdog.stop();
      unsubscribeActivity();
      context.reportActivity = undefined;
    }

    const active = this.active;
    if (!active || active.runId !== context.runId) return;
    await active.eventQueue;
    await this.withLock(() => this.finalizeTopLevelRun(agent, context, active, thrown));
  }

  private async finalizeTopLevelRun(
    agent: AiSdkPiAgent<ToolSet>,
    context: RunContext,
    active: NonNullable<SessionActor["active"]>,
    thrown: string | undefined,
  ): Promise<void> {
    if (this.active !== active || active.runId !== context.runId) return;
    active.phase = "finalizing";
    let error = thrown ?? active.eventError ?? agent.state.error;
    const cancelled = active.cancelRequested;
    if (error && !cancelled) {
      for (const cancel of this.delegatedCancels.values()) cancel();
    }
    this.steeringEntries.length = 0;
    try {
      if (error && !agent.state.error) {
        await this.appendChunk(context.runId, { type: "error", errorText: error });
        await this.appendChunk(context.runId, { type: "finish", finishReason: "error" });
      }
      const runChunks = this.store.getChunks(context.runId);
      const { message: assistantMessage } = await assistantMessageFromChunks(
        runChunks,
        active.uiChunkCursor,
      );
      const uiMessages = [...active.chronologicalUiPrefix];
      if (assistantMessage && assistantMessage.parts.length > 0) uiMessages.push(assistantMessage);
      const runStatus = cancelled ? "cancelled" : error ? "error" : "completed";
      this.snapshot = this.store.finalizeRootRun({
        runId: context.runId,
        sessionId: this.snapshot.id,
        runStatus,
        sessionStatus: error && !cancelled ? "error" : "idle",
        error,
        terminalResult: { text: terminalText(agent.state.messages) },
        modelMessages: agent.state.messages,
        uiMessages,
      });
    } catch (finalizationError) {
      const message =
        finalizationError instanceof Error ? finalizationError.message : String(finalizationError);
      error ??= `Failed to persist final transcript: ${message}`;
      try {
        this.snapshot = this.store.finalizeRootRun({
          runId: context.runId,
          sessionId: this.snapshot.id,
          runStatus: "error",
          sessionStatus: "error",
          error,
          terminalResult: { text: terminalText(agent.state.messages) },
          modelMessages: this.store.getModelMessages(this.snapshot.id),
          uiMessages: this.store.getUiMessages(this.snapshot.id),
        });
      } catch {
        // Cleanup must still run if the persistence layer remains unavailable.
      }
    } finally {
      this.active = undefined;
      this.interruptedSteerCommandIds.clear();
    }
  }

  private enqueueEvent(runId: string, event: AiSdkPiAgentEvent<ToolSet>): void {
    const projection = this.projection(runId);
    if (projection === undefined) return;
    const active = this.active?.runId === runId ? this.active : undefined;
    if (event.type === "agent_end" && active !== undefined) active.phase = "finalizing";
    let consumedSteeringCheckpoints: Array<
      Omit<StoredUserCheckpoint, "uiPrefix" | "replayAfterSeq">
    > = [];
    if (active !== undefined && event.type === "message_start" && event.message.role === "user") {
      if (!active.initialUserSeen) {
        active.initialUserSeen = true;
      } else {
        const queuedIds = new Set(active.agent.getQueuedSteeringIds());
        this.steeringEntries.forEach((entry) => {
          if (entry.state === "queued" && !queuedIds.has(entry.id)) entry.state = "consumed";
        });
        const consumedEntries = this.steeringEntries.filter((entry) => entry.state === "consumed");
        let modelPrefix = active.agent.state.messages.slice(0, -1);
        consumedSteeringCheckpoints = consumedEntries.map((entry) => {
          const checkpoint = { message: entry.message, modelPrefix };
          modelPrefix = [...modelPrefix, entry.modelMessage];
          return checkpoint;
        });
        const consumedIds = new Set(
          this.steeringEntries
            .filter((entry) => entry.state === "consumed")
            .map((entry) => entry.id),
        );
        const remaining = this.steeringEntries.filter((entry) => !consumedIds.has(entry.id));
        this.steeringEntries.splice(0, this.steeringEntries.length, ...remaining);
      }
    }
    const operation = projection.eventQueue.then(() =>
      this.handleAgentEvent(projection, event, consumedSteeringCheckpoints),
    );
    projection.eventQueue = operation.catch((error) => {
      this.reportEventFailure(runId, error);
    });
  }

  private projection(runId: string): RunProjection | undefined {
    if (this.active?.runId === runId) return this.active;
    return undefined;
  }

  private reportEventFailure(runId: string, error: unknown): void {
    const projection = this.projection(runId);
    if (projection === undefined) return;
    projection.eventError ??= error instanceof Error ? error.message : String(error);
    projection.agent.abort();
    if (this.active?.runId === runId) {
      for (const cancel of this.delegatedCancels.values()) cancel();
    }
  }

  private async handleAgentEvent(
    projection: RunProjection,
    event: AiSdkPiAgentEvent<ToolSet>,
    consumedSteeringCheckpoints: readonly Omit<
      StoredUserCheckpoint,
      "uiPrefix" | "replayAfterSeq"
    >[],
  ): Promise<void> {
    const { runId } = projection;
    const active = this.active?.runId === runId ? this.active : undefined;
    switch (event.type) {
      case "agent_start":
        await this.appendChunk(runId, {
          type: "start",
          messageId: crypto.randomUUID(),
          messageMetadata: metadata(this.snapshot),
        });
        if (active !== undefined) {
          await this.appendChunk(runId, { type: "data-session", data: this.snapshot });
        }
        return;
      case "agent_end": {
        const runError = projection.agent.state.error ?? projection.eventError;
        if (projection.stepOpen) {
          projection.stepOpen = false;
          await this.appendChunk(runId, { type: "finish-step" });
        }
        if (runError) {
          await this.appendChunk(runId, {
            type: "error",
            errorText: runError,
          });
        }
        await this.appendChunk(runId, {
          type: "finish",
          finishReason: runError ? "error" : (projection.lastFinishReason ?? "stop"),
          messageMetadata: metadata(this.snapshot, event.totalUsage),
        });
        return;
      }
      case "turn_start":
        if (projection.stepOpen) {
          await this.appendChunk(runId, { type: "finish-step" });
        }
        projection.stepOpen = true;
        await this.appendChunk(runId, { type: "start-step" });
        return;
      case "turn_end":
        projection.lastFinishReason = event.finishReason;
        if (active !== undefined && event.usage.inputTokens !== undefined) {
          this.snapshot = this.store.updateSessionUsage(this.snapshot.id, event.usage.inputTokens);
          await this.appendChunk(runId, { type: "data-session", data: this.snapshot });
        }
        return;
      case "turn_abort":
        if (projection.stepOpen) {
          projection.stepOpen = false;
          await this.appendChunk(runId, { type: "finish-step" });
        }
        await this.appendChunk(runId, {
          type: "abort",
          reason: event.detail ?? `${event.reason}:${event.phase}`,
        });
        return;
      case "message_start":
        if (event.message.role === "user") {
          if (active === undefined || consumedSteeringCheckpoints.length === 0) return;
          const runChunks = this.store.getChunks(runId);
          const segment = await assistantMessageFromChunks(runChunks, active.uiChunkCursor);
          const chronologicalUiPrefix = [...active.chronologicalUiPrefix];
          if (segment.message && segment.message.parts.length > 0) {
            chronologicalUiPrefix.push(segment.message);
          }
          const checkpoints = consumedSteeringCheckpoints.map((checkpoint) => {
            const storedCheckpoint: StoredUserCheckpoint = {
              ...checkpoint,
              uiPrefix: [...chronologicalUiPrefix],
              replayAfterSeq: segment.throughSeq,
            };
            chronologicalUiPrefix.push(checkpoint.message);
            return storedCheckpoint;
          });
          this.store.appendUserCheckpoints(this.snapshot.id, runId, checkpoints);
          active.chronologicalUiPrefix = chronologicalUiPrefix;
          active.uiChunkCursor = segment.throughSeq;
          this.snapshot = this.store.updateSessionState(
            this.snapshot.id,
            this.snapshot.status,
            this.queuedSteeringCount(),
          );
          await this.appendChunk(runId, { type: "data-session", data: this.snapshot });
        } else if (event.message.role === "tool") {
          for (const part of event.message.content) {
            if (part.type !== "tool-result") continue;
            if (projection.toolOutputsAvailable.has(part.toolCallId)) continue;
            projection.toolOutputsAvailable.add(part.toolCallId);
            const output = part.output;
            if (output.type === "execution-denied") {
              await this.appendChunk(runId, {
                type: "tool-output-denied",
                toolCallId: part.toolCallId,
              });
            } else if (output.type === "error-text" || output.type === "error-json") {
              const errorText =
                output.type === "error-text" ? output.value : "Tool returned a structured error";
              const toolInput = projection.toolInputsAvailable.get(part.toolCallId);
              await this.appendChunk(
                runId,
                errorText.includes("AI_InvalidToolInputError")
                  ? {
                      type: "tool-input-error",
                      toolCallId: part.toolCallId,
                      toolName: part.toolName,
                      input: toolInput?.input,
                      errorText,
                      dynamic: true,
                    }
                  : {
                      type: "tool-output-error",
                      toolCallId: part.toolCallId,
                      errorText,
                      dynamic: true,
                    },
              );
            } else {
              await this.appendChunk(runId, {
                type: "tool-output-available",
                toolCallId: part.toolCallId,
                output: output.value,
                dynamic: true,
              });
            }
          }
        }
        return;
      case "message_update": {
        const update = event.assistantMessageEvent;
        switch (update.type) {
          case "text_start":
            await this.appendChunk(runId, {
              type: "text-start",
              id: update.id,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
            });
            return;
          case "text_delta":
            await this.appendChunk(runId, {
              type: "text-delta",
              id: update.id,
              delta: update.delta,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
            });
            return;
          case "text_end":
            await this.appendChunk(runId, {
              type: "text-end",
              id: update.id,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
            });
            return;
          case "thinking_start":
            await this.appendChunk(runId, {
              type: "reasoning-start",
              id: update.id,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
            });
            return;
          case "thinking_delta":
            await this.appendChunk(runId, {
              type: "reasoning-delta",
              id: update.id,
              delta: update.delta,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
            });
            return;
          case "thinking_end":
            await this.appendChunk(runId, {
              type: "reasoning-end",
              id: update.id,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
            });
            return;
          case "toolcall_start":
            await this.appendChunk(runId, {
              type: "tool-input-start",
              toolCallId: update.toolCallId,
              toolName: update.toolName,
              providerExecuted: update.raw.providerExecuted,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
              dynamic: true,
              title: update.raw.title,
            });
            return;
          case "toolcall_delta":
            await this.appendChunk(runId, {
              type: "tool-input-delta",
              toolCallId: update.toolCallId,
              inputTextDelta: update.delta,
            });
            return;
          case "toolcall_end":
            return;
          case "custom":
            await this.appendChunk(runId, {
              type: "custom",
              kind: update.raw.kind,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
            });
            return;
          case "source":
            if (update.raw.sourceType === "url") {
              await this.appendChunk(runId, {
                type: "source-url",
                sourceId: update.raw.id,
                url: update.raw.url,
                title: update.raw.title,
                providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
              });
            } else {
              await this.appendChunk(runId, {
                type: "source-document",
                sourceId: update.raw.id,
                mediaType: update.raw.mediaType,
                title: update.raw.title,
                filename: update.raw.filename,
                providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
              });
            }
            return;
          case "file":
          case "reasoning_file":
            await this.appendChunk(runId, {
              type: update.type === "file" ? "file" : "reasoning-file",
              mediaType: update.raw.file.mediaType,
              url: `data:${update.raw.file.mediaType};base64,${update.raw.file.base64}`,
              providerMetadata: browserSafeProviderMetadata(update.raw.providerMetadata),
            });
            return;
        }
        return;
      }
      case "tool_execution_start":
        if (projection.toolInputsAvailable.has(event.toolCallId)) return;
        projection.toolInputsAvailable.set(event.toolCallId, {
          toolName: event.toolName,
          input: event.args,
        });
        await this.appendChunk(runId, {
          type: "tool-input-available",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
          dynamic: true,
        });
        return;
      case "tool_execution_update":
        await this.appendChunk(runId, {
          type: "tool-output-available",
          toolCallId: event.toolCallId,
          output: event.partialResult,
          dynamic: true,
          preliminary: true,
        });
        return;
      case "tool_execution_end":
        projection.toolOutputsAvailable.add(event.toolCallId);
        if (event.outcome === "denied" || event.output.type === "execution-denied") {
          await this.appendChunk(runId, {
            type: "tool-output-denied",
            toolCallId: event.toolCallId,
          });
        } else if (
          event.outcome === "invalid-input" ||
          (typeof event.result === "string" && event.result.includes("AI_InvalidToolInputError")) ||
          (event.output.type === "error-text" &&
            event.output.value.includes("AI_InvalidToolInputError"))
        ) {
          await this.appendChunk(runId, {
            type: "tool-input-error",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args,
            errorText: typeof event.result === "string" ? event.result : "Invalid tool input",
            dynamic: true,
          });
        } else {
          await this.appendChunk(
            runId,
            event.isError
              ? {
                  type: "tool-output-error",
                  toolCallId: event.toolCallId,
                  errorText:
                    typeof event.result === "string" ? event.result : "Tool execution failed",
                  dynamic: true,
                }
              : {
                  type: "tool-output-available",
                  toolCallId: event.toolCallId,
                  output: event.result,
                  dynamic: true,
                },
          );
        }
        return;
      case "messages_reset":
        if (event.reason === "cancel" || event.reason === "interrupt") {
          await this.appendChunk(runId, {
            type: "data-transcriptReset",
            data: { reason: event.reason },
          });
        }
        return;
      case "message_end":
        if (event.message.role === "assistant" && typeof event.message.content !== "string") {
          for (const part of event.message.content) {
            if (part.type !== "tool-call") continue;
            if (projection.toolInputsAvailable.has(part.toolCallId)) continue;
            projection.toolInputsAvailable.set(part.toolCallId, {
              toolName: part.toolName,
              input: part.input,
            });
            await this.appendChunk(runId, {
              type: "tool-input-available",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              dynamic: true,
            });
          }
        }
        return;
      case "turn_warnings":
        return;
    }
  }

  private async appendChunk(runId: string, chunk: StoredUIMessageChunk): Promise<void> {
    const projection = this.projection(runId);
    if (projection === undefined || projection.streamFinished) return;
    const seq = this.store.appendChunk(runId, chunk);
    this.publishStoredChunk(runId, { seq, chunk });
  }

  private publishStoredChunk(runId: string, entry: StoredRunChunk): void {
    const projection = this.projection(runId);
    if (projection === undefined || projection.streamFinished) return;
    if (entry.chunk.type === "finish") projection.streamFinished = true;
    const runSubscribers = this.subscribers.get(runId);
    if (!runSubscribers) return;
    for (const subscriber of runSubscribers) {
      try {
        enqueueStoredChunk(subscriber, runId, entry);
      } catch {
        runSubscribers.delete(subscriber);
      }
    }
  }

  private closeSubscribers(runId: string): void {
    const runSubscribers = this.subscribers.get(runId);
    if (!runSubscribers) return;
    this.subscribers.delete(runId);
    for (const subscriber of runSubscribers) {
      try {
        subscriber.close();
      } catch {
        // A disconnected stream is already closed and does not affect the run.
      }
    }
  }

  private queueControlChunks(
    runId: string,
    id: string,
    result: MiniLilacControlResult,
  ): Promise<void> {
    const active = this.active;
    if (!active || active.runId !== runId) return Promise.resolve();
    const operation = active.eventQueue.then(async () => {
      if (active.phase !== "accepting-controls" || active.streamFinished) return;
      await this.appendChunk(runId, { type: "data-control", id, data: result });
      await this.appendChunk(runId, { type: "data-session", data: this.snapshot });
    });
    active.eventQueue = operation.catch((error) => {
      this.reportEventFailure(runId, error);
    });
    return operation;
  }

  private queueSteeringChunk(runId: string, message: MiniLilacUserUIMessage): Promise<void> {
    const active = this.active;
    if (!active || active.runId !== runId) return Promise.resolve();
    const operation = active.eventQueue.then(() =>
      this.appendChunk(runId, { type: "data-steering", id: message.id, data: message }),
    );
    active.eventQueue = operation.catch((error) => {
      this.reportEventFailure(runId, error);
    });
    return operation;
  }

  private queueSubagentStatus(parentRunId: string, status: MiniLilacSubagentStatus): void {
    const projection = this.projection(parentRunId);
    if (projection === undefined) return;
    const operation = projection.eventQueue.then(() =>
      this.appendChunk(parentRunId, {
        type: "data-subagentStatus",
        id: status.runId,
        data: status,
      }),
    );
    projection.eventQueue = operation.catch((error) => {
      this.reportEventFailure(parentRunId, error);
    });
  }

  private queueAutomaticCompaction(event: {
    readonly reason: "threshold" | "overflow";
    readonly status: "completed" | "failed";
    readonly messageCountBefore: number;
    readonly messageCountAfter?: number;
    readonly estimatedInputTokens: number;
    readonly estimatedInputTokensAfter?: number;
    readonly error?: unknown;
  }): void {
    const active = this.active;
    if (!active) return;
    const id = crypto.randomUUID();
    const operation = active.eventQueue.then(() =>
      this.appendChunk(active.runId, {
        type: "data-compaction",
        id,
        data: {
          source: "automatic",
          reason: event.reason,
          status: event.status,
          messageCountBefore: event.messageCountBefore,
          messageCountAfter: event.messageCountAfter,
          estimatedInputTokensBefore: event.estimatedInputTokens,
          estimatedInputTokensAfter: event.estimatedInputTokensAfter,
          ...(event.error === undefined
            ? {}
            : { error: event.error instanceof Error ? event.error.message : String(event.error) }),
        },
      }),
    );
    active.eventQueue = operation.catch((error) => {
      this.reportEventFailure(active.runId, error);
    });
  }

  steer(request: MiniLilacSteerRequest): Promise<MiniLilacSteerResult> {
    return this.withLock(async () => {
      const id = commandId(request.clientCommandId);
      if (this.interruptedSteerCommandIds.has(id)) {
        throw new Error(`Steering command '${id}' was interrupted before admission`);
      }
      const command = controlCommandRequest("steer", request.runId, {
        message: request.message,
      });
      const stored = this.store.getCommandResult(this.snapshot.id, id, command);
      if (stored !== undefined) return miniLilacSteerResultSchema.parse(stored);
      const converted = await convertToModelMessages([request.message]);
      const userModelMessage = converted[0];
      if (converted.length !== 1 || userModelMessage?.role !== "user") {
        throw new Error("Steering UI message did not convert to one model user message");
      }
      const active = this.active;
      if (
        !active ||
        active.runId !== request.runId ||
        this.snapshot.activeRunId !== request.runId
      ) {
        throw new Error(`Run '${request.runId}' is not active for session '${this.snapshot.id}'`);
      }
      if (
        active.phase !== "accepting-controls" ||
        active.cancelRequested ||
        this.snapshot.status === "cancelling" ||
        !active.agent.state.isStreaming
      ) {
        throw new Error(`Session '${this.snapshot.id}' is not accepting steering`);
      }
      this.store.reserveCommand(this.snapshot.id, id, command);
      this.beginCommandSideEffect(id, command);
      const steeringId = active.agent.steer(userModelMessage);
      this.steeringEntries.push({
        id: steeringId,
        message: request.message,
        modelMessage: userModelMessage,
        state: "queued",
      });
      await this.queueSteeringChunk(active.runId, request.message);
      this.snapshot = this.store.updateSessionState(
        this.snapshot.id,
        this.snapshot.status,
        this.queuedSteeringCount(),
      );
      const result: MiniLilacSteerResult = {
        clientCommandId: id,
        status: "queued",
        steeringId,
      };
      this.store.saveCommandResult(this.snapshot.id, id, command, result);
      await this.queueControlChunks(active.runId, id, result);
      return result;
    });
  }

  interruptQueuedSteering(
    request: MiniLilacInterruptQueuedSteeringRequest,
  ): Promise<MiniLilacInterruptQueuedSteeringResult> {
    return this.withLock(async () => {
      const id = commandId(request.clientCommandId);
      const command = controlCommandRequest("interrupt", request.runId, {
        pendingSteerCommandIds: request.pendingSteerCommandIds,
      });
      const stored = this.store.getCommandResult(this.snapshot.id, id, command);
      if (stored !== undefined) return miniLilacInterruptQueuedSteeringResultSchema.parse(stored);
      const active = this.active;
      if (
        !active ||
        active.runId !== request.runId ||
        this.snapshot.activeRunId !== request.runId
      ) {
        throw new Error(`Run '${request.runId}' is not active for session '${this.snapshot.id}'`);
      }
      if (active.phase !== "accepting-controls" || active.cancelRequested) {
        throw new Error(`Session '${this.snapshot.id}' is not accepting controls`);
      }
      this.store.reserveCommand(this.snapshot.id, id, command);
      this.beginCommandSideEffect(id, command);
      request.pendingSteerCommandIds.forEach((commandIdValue) =>
        this.interruptedSteerCommandIds.add(commandIdValue),
      );
      const interrupted = active.agent.interruptQueuedSteering();
      if (interrupted.status === "interrupted") {
        for (const cancel of this.delegatedCancels.values()) cancel();
        const consumed = new Set(interrupted.steeringIds);
        this.steeringEntries.forEach((entry) => {
          if (consumed.has(entry.id)) entry.state = "consumed";
        });
      }
      this.snapshot = this.store.updateSessionState(
        this.snapshot.id,
        this.snapshot.status,
        this.queuedSteeringCount(),
      );
      const result = miniLilacInterruptQueuedSteeringResultSchema.parse({
        ...interrupted,
        clientCommandId: id,
      });
      this.store.saveCommandResult(this.snapshot.id, id, command, result);
      await this.queueControlChunks(active.runId, id, result);
      return result;
    });
  }

  cancel(request: MiniLilacCancelRequest): Promise<MiniLilacCancelResult> {
    return this.withLock(async () => {
      const id = commandId(request.clientCommandId);
      const command = controlCommandRequest("cancel", request.runId, {});
      const stored = this.store.getCommandResult(this.snapshot.id, id, command);
      if (stored !== undefined) return miniLilacCancelResultSchema.parse(stored);
      const active = this.active;
      if (
        !active ||
        active.runId !== request.runId ||
        this.snapshot.activeRunId !== request.runId
      ) {
        throw new Error(`Run '${request.runId}' is not active for session '${this.snapshot.id}'`);
      }
      if (active.phase !== "accepting-controls") {
        throw new Error(`Session '${this.snapshot.id}' is not accepting controls`);
      }
      const result: MiniLilacCancelResult = {
        clientCommandId: id,
        status: "cancelled",
      };
      this.store.reserveCommand(this.snapshot.id, id, command);
      this.beginCommandSideEffect(id, command);
      active.cancelRequested = true;
      this.steeringEntries.length = 0;
      this.snapshot = this.store.updateSessionState(
        this.snapshot.id,
        "cancelling",
        0,
        active.runId,
      );
      active.agent.cancel();
      for (const cancel of this.delegatedCancels.values()) cancel();
      this.store.saveCommandResult(this.snapshot.id, id, command, result);
      await this.queueControlChunks(active.runId, id, result);
      return result;
    });
  }

  undo(request: MiniLilacUndoRequest): Promise<MiniLilacUndoResult> {
    return this.withLock(() => {
      const id = commandId(request.clientCommandId);
      const command = undoCommandRequest();
      const stored = this.store.getCommandResult(this.snapshot.id, id, command);
      if (stored !== undefined) return miniLilacUndoResultSchema.parse(stored);
      this.snapshot = this.store.getSession(this.snapshot.id);
      if (
        this.active ||
        !["idle", "error"].includes(this.snapshot.status) ||
        this.snapshot.activeRunId !== null
      ) {
        throw new Error(`Session '${this.snapshot.id}' must be quiescent to undo`);
      }
      const result = this.store.undoLatestUser(this.snapshot.id, id, command);
      this.snapshot = this.store.getSession(this.snapshot.id);
      return result;
    });
  }

  compact(request: MiniLilacCompactRequest): Promise<MiniLilacCompactResult> {
    return this.withLock(async () => {
      const id = commandId(request.clientCommandId);
      const command = compactCommandRequest();
      const stored = this.store.getCommandResult(this.snapshot.id, id, command);
      if (stored !== undefined) return miniLilacCompactResultSchema.parse(stored);
      this.snapshot = this.store.getSession(this.snapshot.id);
      if (
        this.active ||
        !["idle", "error"].includes(this.snapshot.status) ||
        this.snapshot.activeRunId !== null
      ) {
        throw new Error(`Session '${this.snapshot.id}' must be quiescent to compact`);
      }

      const messages = this.store.getModelMessages(this.snapshot.id);
      this.store.reserveCommand(this.snapshot.id, id, command);
      try {
        if (messages.length === 0) {
          const empty = miniLilacCompactResultSchema.parse({
            status: "empty",
            clientCommandId: id,
            messageCountBefore: 0,
            messageCountAfter: 0,
            estimatedInputTokensBefore: 0,
            estimatedInputTokensAfter: 0,
          });
          return this.store.commitCompaction(this.snapshot.id, id, command, messages, empty);
        }
        const modelSpecifier = this.snapshot.model;
        if (modelSpecifier === null) throw new Error("Session model is required for compaction");
        const limits = await this.resolveModelLimits(modelSpecifier);
        if (limits === undefined || limits.context <= 0) {
          throw new Error(`Context window is unavailable for model '${modelSpecifier}'`);
        }
        const configuredSummaryModel = this.config.agent.compaction.model;
        const summaryModelSpecifier =
          configuredSummaryModel === "inherit" ? modelSpecifier : configuredSummaryModel;
        const compacted = await compactMessages({
          messages,
          currentModel: this.resolveModel(modelSpecifier),
          contextLimit: limits.context,
          outputLimit: limits.output,
          thresholdFraction: this.config.agent.compaction.earlyCompactionPoint,
          summaryModel:
            configuredSummaryModel === "inherit"
              ? "current"
              : this.resolveModel(configuredSummaryModel),
          providerOptions: this.supersededProviderIds.has(
            parseModelRef(summaryModelSpecifier).providerId,
          )
            ? { openai: { store: false, include: ["reasoning.encrypted_content"] } }
            : undefined,
        });
        const result = miniLilacCompactResultSchema.parse({
          status:
            compacted.status === "compacted"
              ? "compacted"
              : compacted.reason === "empty"
                ? "empty"
                : "noop",
          clientCommandId: id,
          messageCountBefore: compacted.messageCountBefore,
          messageCountAfter: compacted.messageCountAfter,
          estimatedInputTokensBefore: compacted.estimatedTokensBefore,
          estimatedInputTokensAfter: compacted.estimatedTokensAfter,
        });
        const committed = this.store.commitCompaction(
          this.snapshot.id,
          id,
          command,
          compacted.messages,
          result,
        );
        this.snapshot = this.store.getSession(this.snapshot.id);
        return committed;
      } catch (error) {
        this.store.releaseCommand(this.snapshot.id, id, command);
        throw error;
      }
    });
  }

  updateBindings(
    requestValue: MiniLilacUpdateSessionBindingsRequest,
  ): Promise<MiniLilacSessionSnapshot> {
    return this.withLock(async () => {
      const request = miniLilacUpdateSessionBindingsRequestSchema.parse(requestValue);
      const command = updateBindingsCommandRequest(request);
      const stored = this.store.getCommandResult(
        this.snapshot.id,
        request.clientCommandId,
        command,
      );
      if (stored !== undefined) return miniLilacSessionSnapshotSchema.parse(stored);
      this.snapshot = this.store.getSession(this.snapshot.id);
      if (
        this.active ||
        !["idle", "error"].includes(this.snapshot.status) ||
        this.snapshot.activeRunId !== null
      ) {
        throw new Error(`Session '${this.snapshot.id}' must be quiescent to update bindings`);
      }

      if (request.model !== undefined) {
        parseModelRef(request.model);
        this.resolveModel(request.model);
      }
      if (request.profile !== undefined) {
        const profile = this.config.agent.profiles[request.profile];
        if (!profile) throw new Error(`Unknown profile '${request.profile}'`);
        if (profile.subagentOnly) throw new Error(`Profile '${request.profile}' is subagent-only`);
      }
      if (request.reasoning !== undefined) miniLilacReasoningSchema.parse(request.reasoning);

      const limits =
        request.model === undefined ? undefined : await this.resolveModelLimits(request.model);

      this.snapshot = this.store.updateSessionBindings(
        this.snapshot.id,
        request.clientCommandId,
        command,
        {
          model: request.model,
          profile: request.profile,
          reasoning: request.reasoning,
          contextWindow: limits?.context,
        },
      );
      return this.snapshot;
    });
  }

  private queuedSteeringCount(): number {
    return this.steeringEntries.filter((entry) => entry.state === "queued").length;
  }
}

export class SessionService {
  readonly store: MiniLilacSqliteStore;
  private readonly options: SessionServiceOptions;
  private readonly actors = new Map<string, SessionActor>();
  private readonly delegatedSessionLocks = new Map<string, Promise<void>>();
  private readonly resolveModel: ModelResolver;
  private readonly modelCapability: ModelCapability;
  private readonly resolveModelLimits: ModelLimitsResolver;
  private readonly attachCompaction: (
    agent: AiSdkPiAgent<ToolSet>,
    options: AutoCompactionOptions,
  ) => Promise<() => void>;
  private readonly subagentCapacity: SubagentCapacity;
  private readonly supersededProviderIds: ReadonlySet<string>;
  private readonly resolveProviderType: (providerId: string) => ProviderType | undefined;
  private readonly resolveWebSearchProvider: WebSearchProviderResolver;
  private readonly protectedToolPaths: readonly string[];
  private readonly activeTasks = new Set<Promise<void>>();
  private concurrentSubagents = 0;
  private acceptingAdmissions = true;
  private closed = false;
  private shutdownAttempt: Promise<void> | undefined;

  constructor(options: SessionServiceOptions) {
    this.options = { ...options, config: parseSessionConfig(options.config) };
    if (!this.options.store && !this.options.databasePath) {
      throw new Error("SessionService requires store or databasePath");
    }
    if (!this.options.modelResolver && !this.options.providers) {
      throw new Error("SessionService requires modelResolver or configured providers");
    }
    this.store = this.options.store
      ? this.options.store
      : new MiniLilacSqliteStore(this.options.databasePath ?? "mini-lilac.sqlite");
    const databasePaths =
      this.store.filename === ":memory:"
        ? []
        : [
            this.store.filename,
            `${this.store.filename}-journal`,
            `${this.store.filename}-shm`,
            `${this.store.filename}-wal`,
          ];
    this.protectedToolPaths = [
      this.options.config.providerConfigFile,
      this.options.config.providerAuthFile,
      getCodexAuthStoragePath(),
      ...databasePaths,
      ...(this.options.protectedToolPaths ?? []),
    ];
    const providers = this.options.providers;
    this.resolveModel = this.options.modelResolver
      ? this.options.modelResolver
      : (specifier) => {
          if (!providers) throw new Error("Configured providers are unavailable");
          return resolveLanguageModel(specifier, providers).model;
        };
    this.modelCapability = this.options.modelCapability ?? new ModelCapability();
    this.resolveModelLimits =
      this.options.modelLimitsResolver ??
      (async (specifier) => {
        try {
          const capability = await this.modelCapability.resolve(specifier);
          return capability.limit.context > 0
            ? { context: capability.limit.context, output: capability.limit.output }
            : undefined;
        } catch {
          return undefined;
        }
      });
    this.attachCompaction = this.options.attachCompaction ?? attachAutoCompaction;
    this.supersededProviderIds = new Set(providers?.supersededProviderIds);
    this.resolveProviderType = (providerId) => providers?.config.providers[providerId]?.type;
    this.resolveWebSearchProvider =
      this.options.webSearchProviderResolver ?? createWebSearchProviderResolver(providers);
    this.subagentCapacity = {
      tryAcquire: () => {
        if (this.concurrentSubagents >= this.options.config.agent.subagents.maxConcurrent) {
          return false;
        }
        this.concurrentSubagents += 1;
        return true;
      },
      release: () => {
        this.concurrentSubagents = Math.max(0, this.concurrentSubagents - 1);
      },
    };
  }

  createSession(input: CreateSessionInput): Promise<MiniLilacSessionSnapshot> {
    this.assertAcceptingAdmissions();
    return this.trackOperation(this.createSessionInternal(input));
  }

  private async createSessionInternal(
    input: CreateSessionInput,
  ): Promise<MiniLilacSessionSnapshot> {
    if (input.id?.startsWith("sub:")) {
      throw new Error("Session ids beginning with 'sub:' are reserved for delegated sessions");
    }
    const cwd = await realpath(input.cwd);
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error(`Session cwd '${cwd}' is not a directory`);
    parseModelRef(input.model);
    this.resolveModel(input.model);

    const profileId = input.profile ?? this.options.config.agent.defaultProfile;
    const profile = this.options.config.agent.profiles[profileId];
    if (!profile) throw new Error(`Unknown profile '${profileId}'`);
    if (profile.subagentOnly) throw new Error(`Profile '${profileId}' is subagent-only`);

    const limits = await this.resolveModelLimits(input.model);
    const snapshot = this.store.createSession({
      id: input.id ?? crypto.randomUUID(),
      cwd,
      model: input.model,
      profile: profileId,
      reasoning: input.reasoning ?? "provider-default",
      contextWindow: limits?.context,
    });
    this.actors.set(snapshot.id, this.createActor(snapshot));
    return snapshot;
  }

  loadSession(sessionId: string): MiniLilacSessionSnapshot {
    const actor = this.actor(sessionId);
    return actor.getSnapshot();
  }

  getSnapshot(sessionId: string): MiniLilacSessionSnapshot {
    return this.actor(sessionId).getSnapshot();
  }

  getMessages(sessionId: string): MiniLilacUIMessage[] {
    return this.actor(sessionId).getMessages();
  }

  getSessionResume(sessionId: string): Promise<SessionResumeProjection> {
    return this.trackOperation(this.actor(sessionId).getSessionResume());
  }

  getTodos(sessionId: string): MiniLilacTodoState {
    return this.store.getTodos(sessionId);
  }

  getRunChunks(runId: string, afterSeq = 0): StoredRunChunk[] {
    return this.store.getChunks(runId, afterSeq);
  }

  async listSkills(cwdValue: string, profileId?: string): Promise<MiniLilacSkillSummary[]> {
    if (this.options.skillCatalog === undefined) return [];
    const cwd = await realpath(cwdValue);
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error(`Skill cwd '${cwd}' is not a directory`);
    const selectedProfileId = profileId ?? this.options.config.agent.defaultProfile;
    const profile = this.options.config.agent.profiles[selectedProfileId];
    if (profile === undefined) throw new Error(`Unknown profile '${selectedProfileId}'`);
    if (!profileRequestsTool(profile, "skill")) return [];
    return [...(await this.options.skillCatalog.discover(cwd)).summaries];
  }

  startPrompt(
    sessionId: string,
    userMessage: MiniLilacUIMessage,
    clientCommandId?: string,
  ): Promise<StartedSessionRun> {
    this.assertAcceptingAdmissions();
    return this.trackOperation(this.actor(sessionId).startPrompt(userMessage, clientCommandId));
  }

  private promptDelegatedSession(
    request: DelegatedSessionRequest,
  ): Promise<DelegatedSessionHandle> {
    const childSessionId = delegatedSessionId(request.parentSessionId, request.sessionName);
    return this.withDelegatedSessionLock(childSessionId, async () => {
      let snapshot: MiniLilacSessionSnapshot;
      try {
        snapshot = this.store.getSession(childSessionId);
      } catch {
        const parent = this.store.getSession(request.parentSessionId);
        const model = request.overrides.model ?? parent.model;
        const reasoning = request.overrides.effort ?? parent.reasoning;
        if (!model || !reasoning)
          throw new Error("Parent session model and reasoning are required");
        parseModelRef(model);
        const limits = await this.resolveModelLimits(model);
        snapshot = this.store.createSession({
          id: childSessionId,
          cwd: parent.cwd,
          model,
          profile: request.profileId,
          reasoning,
          contextWindow: limits?.context,
        });
      }
      if (snapshot.cwd !== this.store.getSession(request.parentSessionId).cwd) {
        throw new Error(
          `Subagent session '${request.sessionName}' has a different working directory`,
        );
      }
      if (snapshot.profile !== request.profileId) {
        throw new Error(
          `Subagent session '${request.sessionName}' uses profile '${snapshot.profile}', not '${request.profileId}'`,
        );
      }
      if (request.overrides.model !== undefined && request.overrides.model !== snapshot.model) {
        throw new Error(
          `Subagent session '${request.sessionName}' uses model '${snapshot.model}', not '${request.overrides.model}'`,
        );
      }
      if (
        request.overrides.effort !== undefined &&
        request.overrides.effort !== snapshot.reasoning
      ) {
        throw new Error(
          `Subagent session '${request.sessionName}' uses reasoning '${snapshot.reasoning}', not '${request.overrides.effort}'`,
        );
      }
      const userMessage: MiniLilacUserUIMessage = {
        id: `subagent:${request.parentRunId}:${request.parentToolCallId}`,
        role: "user",
        parts: [{ type: "text", text: request.prompt }],
      };
      const started = await this.actor(childSessionId).startPrompt(
        userMessage,
        `subagent:${request.parentRunId}:${request.parentToolCallId}`,
        {
          depth: request.depth,
          profileId: request.profileId,
          overrides: request.overrides,
          idleTimeoutMs: this.options.config.agent.subagents.idleTimeoutMs,
        },
      );
      return {
        sessionId: childSessionId,
        runId: started.runId,
        completion: this.collectDelegatedRun(request, childSessionId, started),
        cancel: () => this.actor(childSessionId).cancelDelegatedRun(started.runId),
      };
    });
  }

  private async collectDelegatedRun(
    request: DelegatedSessionRequest,
    childSessionId: string,
    started: StartedSessionRun,
  ): Promise<SubagentTerminalResult> {
    const seenTools = new Set<string>();
    let toolCount = 0;
    for await (const chunk of started.stream) {
      if (chunk.type === "data-streamCursor") continue;
      request.reportActivity();
      if (chunk.type !== "tool-input-available" || seenTools.has(chunk.toolCallId)) continue;
      seenTools.add(chunk.toolCallId);
      toolCount += 1;
      request.onActivity(toolCount, chunk.toolName);
    }
    const run = this.store.getRun(started.runId);
    const terminal = z.object({ text: z.string() }).safeParse(run.terminalResult);
    return subagentTerminalResultSchema.parse({
      status: run.status === "active" ? "error" : run.status,
      childRunId: run.id,
      childSessionId,
      sessionName: request.sessionName,
      profile: request.profileId,
      text: terminal.success ? terminal.data.text : "",
      ...(run.error ? { error: run.error } : {}),
    });
  }

  private withDelegatedSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.delegatedSessionLocks.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.delegatedSessionLocks.set(sessionId, settled);
    void settled.finally(() => {
      if (this.delegatedSessionLocks.get(sessionId) === settled) {
        this.delegatedSessionLocks.delete(sessionId);
      }
    });
    return result;
  }

  replayRun(
    runId: string,
    options: { afterSeq?: number; tail?: boolean } = {},
  ): ReadableStream<MiniLilacRuntimeChunk> {
    const run = this.store.getRun(runId);
    if (options.tail !== false && run.status === "active") {
      return this.actor(run.sessionId).streamRun(runId, options.afterSeq);
    }
    const chunks = this.store.getChunks(runId, options.afterSeq);
    return new ReadableStream<MiniLilacRuntimeChunk>({
      start(controller) {
        chunks.forEach((entry) => enqueueStoredChunk(controller, runId, entry));
        controller.close();
      },
    });
  }

  steer(request: MiniLilacSteerRequest): Promise<MiniLilacSteerResult> {
    this.assertAcceptingAdmissions();
    return this.trackOperation(this.actor(request.sessionId).steer(request));
  }

  interruptQueuedSteering(
    request: MiniLilacInterruptQueuedSteeringInput,
  ): Promise<MiniLilacInterruptQueuedSteeringResult> {
    this.assertAcceptingAdmissions();
    const parsed = miniLilacInterruptQueuedSteeringRequestSchema.parse(request);
    return this.trackOperation(this.actor(parsed.sessionId).interruptQueuedSteering(parsed));
  }

  cancel(request: MiniLilacCancelRequest): Promise<MiniLilacCancelResult> {
    this.assertAcceptingAdmissions();
    return this.trackOperation(this.actor(request.sessionId).cancel(request));
  }

  undo(request: MiniLilacUndoRequest): Promise<MiniLilacUndoResult> {
    this.assertAcceptingAdmissions();
    return this.trackOperation(this.actor(request.sessionId).undo(request));
  }

  compact(request: MiniLilacCompactRequest): Promise<MiniLilacCompactResult> {
    this.assertAcceptingAdmissions();
    return this.trackOperation(this.actor(request.sessionId).compact(request));
  }

  updateSessionBindings(
    request: MiniLilacUpdateSessionBindingsRequest,
  ): Promise<MiniLilacSessionSnapshot> {
    this.assertAcceptingAdmissions();
    return this.trackOperation(this.actor(request.sessionId).updateBindings(request));
  }

  close(): void {
    if (this.closed) return;
    if (
      this.activeTasks.size > 0 ||
      this.delegatedSessionLocks.size > 0 ||
      [...this.actors.values()].some((actor) => !actor.isQuiescent())
    ) {
      throw new Error("Cannot close SessionService while runtime work is active; use shutdown()");
    }
    this.acceptingAdmissions = false;
    this.store.close();
    this.closed = true;
  }

  shutdown(options: SessionServiceShutdownOptions = {}): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.acceptingAdmissions = false;
    if (this.shutdownAttempt !== undefined) return this.shutdownAttempt;
    const graceMs = options.graceMs ?? this.options.shutdownGraceMs ?? 5_000;
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      return Promise.reject(new Error("SessionService shutdown graceMs must be non-negative"));
    }
    const attempt = this.performShutdown(graceMs).finally(() => {
      if (this.shutdownAttempt === attempt) this.shutdownAttempt = undefined;
    });
    this.shutdownAttempt = attempt;
    return attempt;
  }

  private actor(sessionId: string): SessionActor {
    const existing = this.actors.get(sessionId);
    if (existing) return existing;
    const snapshot = this.store.getSession(sessionId);
    const actor = this.createActor(snapshot);
    this.actors.set(sessionId, actor);
    return actor;
  }

  private createActor(snapshot: MiniLilacSessionSnapshot): SessionActor {
    return new SessionActor(
      snapshot,
      this.options.config,
      this.store,
      this.resolveModel,
      this.modelCapability,
      this.resolveModelLimits,
      this.attachCompaction,
      this.subagentCapacity,
      (request) => this.promptDelegatedSession(request),
      this.supersededProviderIds,
      this.resolveProviderType,
      this.options.skillCatalog,
      this.resolveWebSearchProvider,
      this.protectedToolPaths,
      (task) => this.trackTask(task),
      () => this.acceptingAdmissions,
    );
  }

  private assertAcceptingAdmissions(): void {
    if (!this.acceptingAdmissions || this.closed) {
      throw new Error("SessionService is shutting down and is not accepting admissions");
    }
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    const releaseStore = this.store.acquireCloseBlocker();
    let completion: Promise<void>;
    const tracked = operation.finally(() => {
      releaseStore();
      this.activeTasks.delete(completion);
    });
    completion = tracked.then(
      () => undefined,
      () => undefined,
    );
    this.activeTasks.add(completion);
    return tracked;
  }

  private trackTask(task: Promise<void>): Promise<void> {
    const releaseStore = this.store.acquireCloseBlocker();
    let completion: Promise<void>;
    const tracked = task.finally(() => {
      releaseStore();
      this.activeTasks.delete(completion);
    });
    completion = tracked.then(
      () => undefined,
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("tracked runtime task failed", { error: message });
      },
    );
    this.activeTasks.add(completion);
    return completion;
  }

  private async performShutdown(graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs;
    const requestedActors = new Set<SessionActor>();
    for (;;) {
      const newActors = [...this.actors.values()].filter((actor) => !requestedActors.has(actor));
      newActors.forEach((actor) => requestedActors.add(actor));
      if (newActors.length > 0) {
        await this.waitWithinGrace(
          Promise.all(newActors.map((actor) => actor.requestShutdown())).then(() => undefined),
          deadline,
        );
      }

      const tasks = [...this.activeTasks];
      const quiescent =
        tasks.length === 0 &&
        this.delegatedSessionLocks.size === 0 &&
        [...this.actors.values()].every((actor) => actor.isQuiescent());
      if (quiescent) break;
      await this.waitWithinGrace(
        tasks.length > 0 ? Promise.all(tasks).then(() => undefined) : Bun.sleep(1),
        deadline,
      );
    }
    this.store.close();
    this.closed = true;
  }

  private async waitWithinGrace(task: Promise<void>, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("SessionService shutdown grace period elapsed with active runtime work");
    }
    await Promise.race([
      task,
      Bun.sleep(remaining).then(() => {
        throw new Error("SessionService shutdown grace period elapsed with active runtime work");
      }),
    ]);
  }
}
