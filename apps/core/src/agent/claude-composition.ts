import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Result, type AnyTaggedError } from "better-result";
import type { ToolSet, ModelMessage, LanguageModel } from "ai";
import { AiSdkPiAgent, AgentExternalHostFailed } from "@stanley2058/lilac-agent";
import { signalExternalToolCallHost } from "@stanley2058/lilac-agent/agent-runtime-support";
import {
  applyBasePromptForProvider,
  claudeCodeExecutableSettings,
  resolveNativeSubagentProfile,
  createLogger,
  isPanic,
  type CoreConfig,
  type ResolvedModelRef,
} from "@stanley2058/lilac-utils";
import {
  materializeClaudeCodeRunResult,
  type MaterializedClaudeCodeRun,
  type ClaudeCodeRunExternalFailure,
} from "@stanley2058/lilac-claude-code-bridge";
import type { AdapterPlatform, CorePrimaryLineageV2 } from "@stanley2058/lilac-event-bus";
import type { BuiltLevel1Toolset } from "../plugins";
import type { TranscriptStore, TranscriptSnapshot } from "../transcript/transcript-store";
import type { WorkflowRequestPolicy } from "../workflow/workflow-request-authority";
import type { AgentRunProfile } from "../surface/bridge/bus-agent-runner/raw";
import type { SessionSafetyMode } from "../surface/session-policy";
import {
  formatBridgeLogContext,
  formatBridgeTaggedErrorForLog,
} from "../surface/bridge/bridge-log";
import {
  coreProfileExecutionScopeAuthority,
  createCoreNamedClaudeRuntime as createCoreNamedClaudeRuntimeResult,
  hashCoreNamedExecutionScope,
  supportsCoreNamedContinuationStore,
  type CoreNamedClaudeRuntime,
} from "../surface/bridge/bus-agent-runner/core-named-continuation";
import {
  createCorePrimaryClaudeRuntime as createCorePrimaryClaudeRuntimeResult,
  supportsCorePrimaryContinuationStore,
  type CorePrimaryClaudeRuntime,
} from "../surface/bridge/bus-agent-runner/core-primary-continuation";

type Level1ToolAuthorityTarget = Pick<AiSdkPiAgent<ToolSet>, "setTools" | "setActiveTools">;
export function shouldUsePersistentCoreClaudeRuntime(input: {
  runProfile: AgentRunProfile;
  requestClient: AdapterPlatform;
  stableNamedContinuation: NonNullable<WorkflowRequestPolicy["stableNamedContinuation"]> | null;
  corePrimaryLineage?: CorePrimaryLineageV2;
}): boolean {
  if (input.runProfile === "primary") return input.requestClient === "discord";
  return input.stableNamedContinuation !== null;
}

export function applyCompleteLevel1Tools(
  target: Level1ToolAuthorityTarget,
  toolset: BuiltLevel1Toolset,
): void {
  toolset.updateActiveBatchTools(new Set(Object.keys(toolset.tools)));
  target.setTools(toolset.tools);
  target.setActiveTools(new Set(Object.keys(toolset.tools)));
}

export function completeLevel1ToolMapping(toolset: BuiltLevel1Toolset): {
  tools: ToolSet;
  catalogMetadata: BuiltLevel1Toolset["catalogMetadata"];
} {
  toolset.updateActiveBatchTools(new Set(Object.keys(toolset.tools)));
  return {
    tools: toolset.tools,
    catalogMetadata: toolset.catalogMetadata,
  };
}

export function formatClaudeLifecycleLogFields(
  event: string,
  detail: Readonly<Record<string, string | number | boolean | null | undefined>>,
  error?: AnyTaggedError,
): Readonly<Record<string, string | number | boolean | null | undefined>> {
  const context = formatBridgeLogContext({ lifecycle: event, ...detail });
  return error ? formatBridgeTaggedErrorForLog(error, context) : context;
}

export function resolveCoreClaudeCompactionSummaryModel(input: {
  readonly run: Pick<MaterializedClaudeCodeRun, "createUtilityModelResult"> | null;
  readonly fallback: () => LanguageModel;
  readonly onFailure: (error: ClaudeCodeRunExternalFailure) => void;
}): LanguageModel {
  if (input.run === null) return input.fallback();

  const created = input.run.createUtilityModelResult();
  return created.match({
    ok: (model) => model,
    err: (error) => {
      switch (error._tag) {
        case "ClaudeCodeRunExternalFailure":
          input.onFailure(error);
          return input.fallback();
      }
    },
  });
}

export type CoreClaudeComposition = {
  readonly run: MaterializedClaudeCodeRun | null;
  readonly namedRuntime: CoreNamedClaudeRuntime | null;
  readonly primaryRuntime: CorePrimaryClaudeRuntime | null;
};
export type CoreClaudeCompositionInput = {
  readonly cfg: CoreConfig;
  readonly runProfile: AgentRunProfile;
  readonly safetyMode: SessionSafetyMode;
  readonly next: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly requestClient: AdapterPlatform;
  };
  readonly activeBinding: {
    readonly resolved: ResolvedModelRef;
    readonly toolset: BuiltLevel1Toolset;
  };
  readonly executionCwd: string;
  readonly stableNamedContinuation: NonNullable<
    WorkflowRequestPolicy["stableNamedContinuation"]
  > | null;
  readonly workflowPolicy: WorkflowRequestPolicy | null;
  readonly workspaceSystemPrompt: string;
  readonly additionalSessionPrompts: readonly string[];
  readonly skillsSection: string | null;
  readonly subagentMeta: { readonly depth: number };
  readonly seededSessionTranscript: TranscriptSnapshot | null;
  readonly seededSessionMessages: readonly ModelMessage[];
  readonly getCurrentTurnMessages: () => readonly ModelMessage[];
  readonly getLineage: () => CorePrimaryLineageV2 | undefined;
  readonly projectCanonicalStoredMessages: NonNullable<
    Parameters<typeof createCorePrimaryClaudeRuntimeResult>[0]["projectCanonicalStoredMessages"]
  >;
  readonly transcriptStore: TranscriptStore | undefined;
  readonly materializeClaudeCodeRun:
    | ((
        options: Parameters<typeof materializeClaudeCodeRunResult>[0],
      ) => Promise<MaterializedClaudeCodeRun>)
    | undefined;
  readonly getAgent: () => AiSdkPiAgent<ToolSet> | null;
  readonly waitForPreAgent: <T>(operation: Promise<T>) => Promise<T>;
};
function signalClaudeCompositionHost(error: Error): never {
  return signalExternalToolCallHost(
    new AgentExternalHostFailed({ cause: error, message: error.message }),
  );
}
export async function createCoreClaudeComposition(
  input: CoreClaudeCompositionInput,
): Promise<CoreClaudeComposition> {
  const {
    cfg,
    runProfile,
    safetyMode,
    next,
    activeBinding,
    executionCwd,
    stableNamedContinuation,
    workflowPolicy,
    workspaceSystemPrompt,
    additionalSessionPrompts,
    skillsSection,
    subagentMeta,
    seededSessionTranscript,
    seededSessionMessages,
    waitForPreAgent,
  } = input;
  const subagents = cfg.agent.subagents;
  const logger = createLogger({ module: "bus-agent-runner" });
  if (activeBinding.resolved.provider !== "claude-code")
    return { run: null, namedRuntime: null, primaryRuntime: null };
  const claudeCodeToolMapping = completeLevel1ToolMapping(activeBinding.toolset);
  const continuationStore = input.transcriptStore;
  const materializeClaude = async (
    nativeSession?: Parameters<typeof materializeClaudeCodeRunResult>[0]["nativeSession"],
  ) => {
    const options = {
      modelId: activeBinding.resolved.modelId,
      cwd: executionCwd,
      tools: claudeCodeToolMapping.tools,
      catalogMetadata: claudeCodeToolMapping.catalogMetadata,
      // Core admits no Claude built-ins; Lilac remains the only tool source.
      builtInTools: [],
      reasoning: activeBinding.resolved.reasoning,
      ...(nativeSession ? { nativeSession } : {}),
      execute: async (request) => {
        const agent = input.getAgent();
        if (!agent) {
          return signalClaudeCompositionHost(
            new Error("Claude Code tool execution started before the agent was ready"),
          );
        }
        return await agent.executeExternalToolCall(request);
      },
    } satisfies Parameters<typeof materializeClaudeCodeRunResult>[0];
    if (input.materializeClaudeCodeRun) return await input.materializeClaudeCodeRun(options);
    const result = await materializeClaudeCodeRunResult(options);
    const materialized = result.match<
      | { kind: "success"; value: import("better-result").InferOk<typeof result> }
      | { kind: "failure"; error: import("better-result").InferErr<typeof result> }
    >({
      ok: (value) => ({ kind: "success", value }),
      err: (error) => ({ kind: "failure", error }),
    });
    if (materialized.kind === "failure") return signalClaudeCompositionHost(materialized.error);
    return materialized.value;
  };
  const shouldPersistClaude = shouldUsePersistentCoreClaudeRuntime({
    runProfile,
    requestClient: next.requestClient,
    stableNamedContinuation,
    corePrimaryLineage: input.getLineage(),
  });
  if (!shouldPersistClaude || continuationStore === undefined) {
    return {
      run: await waitForPreAgent(materializeClaude()),
      namedRuntime: null,
      primaryRuntime: null,
    };
  }

  const canonicalExecutionCwd = await canonicalClaudeExecutionCwd(executionCwd);
  const nativeStorageNamespace = path.resolve(
    process.env["CLAUDE_CONFIG_DIR"] ?? path.join(homedir(), ".claude"),
  );
  const profileConfig =
    runProfile === "primary" ? null : resolveNativeSubagentProfile(cfg, runProfile);
  const executionScope = hashCoreNamedExecutionScope({
    canonicalCwd: canonicalExecutionCwd,
    providerIdentity: "core:claude-code",
    nativeStorageNamespaceIdentity: nativeStorageNamespace,
    nativeExecutableConfig: claudeCodeExecutableSettings(),
    profile: runProfile,
    safetyMode,
    profileAuthority: {
      level1: profileConfig?.level1 ?? null,
      level2: profileConfig?.level2 ?? null,
      network: profileConfig?.network ?? null,
      workspaceWrites: profileConfig?.workspaceWrites ?? null,
      execution:
        profileConfig === null ? null : coreProfileExecutionScopeAuthority(profileConfig.execution),
      delegation: profileConfig?.delegation ?? null,
    },
    pluginAuthority: cfg.plugins ?? null,
    workflowAuthority: workflowPolicy
      ? {
          profile: workflowPolicy.profile,
          cwd: workflowPolicy.cwd,
          originClient: workflowPolicy.originSession.client,
        }
      : null,
    systemPolicy: {
      base: applyBasePromptForProvider({
        systemPrompt: workspaceSystemPrompt,
        basePrompt: cfg.basePrompt,
        provider: activeBinding.resolved.provider,
      }),
      profileOverlay: profileConfig?.promptOverlay ?? null,
      additionalSessionPrompts,
      skillsSection,
    },
    directToolNames: [...activeBinding.toolset.directToolNames],
    externalToolAuthority: activeBinding.toolset.catalog
      .map((entry) => ({
        source: entry.source,
        sourceId: entry.sourceId,
        stableId: entry.stableId,
        modelName: entry.modelName,
      }))
      .sort((left, right) => left.stableId.localeCompare(right.stableId)),
    subagentAuthority: {
      enabled: subagents.enabled,
      maxDepth: subagents.maxDepth,
      currentDepth: subagentMeta.depth,
    },
  });
  if (
    runProfile === "primary" &&
    next.requestClient === "discord" &&
    supportsCorePrimaryContinuationStore(continuationStore)
  ) {
    const createdPrimaryRuntime = createCorePrimaryClaudeRuntimeResult({
      store: continuationStore,
      sessionId: next.sessionId,
      requestId: next.requestId,
      providerId: activeBinding.resolved.provider,
      modelSpecifier: activeBinding.resolved.spec,
      reasoning: activeBinding.resolved.reasoning ?? "provider-default",
      executionScopeHash: executionScope.hash,
      executionCwd,
      getLineage: () => input.getLineage(),
      projectCanonicalStoredMessages: (messages) => input.projectCanonicalStoredMessages(messages),
      materialize: (nativeSession) => waitForPreAgent(materializeClaude(nativeSession)),
      onDiagnostic: (event, detail, error) =>
        reportClaudeLifecycle(logger, "core_primary_claude.lifecycle", event, detail, error),
    });
    const primaryRuntime = createdPrimaryRuntime.match({
      ok: (value) => () => value,
      err: (error) => () => signalClaudeCompositionHost(error),
    })();
    return { run: null, namedRuntime: null, primaryRuntime };
  }
  if (stableNamedContinuation !== null && supportsCoreNamedContinuationStore(continuationStore)) {
    const createdNamedRuntime = createCoreNamedClaudeRuntimeResult({
      store: continuationStore,
      requestClient: stableNamedContinuation.requestClient,
      sessionId: next.sessionId,
      requestId: next.requestId,
      providerId: activeBinding.resolved.provider,
      modelSpecifier: activeBinding.resolved.spec,
      reasoning: activeBinding.resolved.reasoning ?? "provider-default",
      executionScopeHash: executionScope.hash,
      executionCwd,
      sourceTranscript: seededSessionTranscript,
      sourceMessages: seededSessionMessages,
      getCurrentTurnMessages: input.getCurrentTurnMessages,
      materialize: (nativeSession) => waitForPreAgent(materializeClaude(nativeSession)),
      onDiagnostic: (event, detail, error) =>
        reportClaudeLifecycle(logger, "core_named_claude.lifecycle", event, detail, error),
    });
    const namedRuntime = createdNamedRuntime.match({
      ok: (value) => () => value,
      err: (error) => () => signalClaudeCompositionHost(error),
    })();
    return { run: null, namedRuntime, primaryRuntime: null };
  }
  return {
    run: await waitForPreAgent(materializeClaude()),
    namedRuntime: null,
    primaryRuntime: null,
  };
}

export async function canonicalClaudeExecutionCwd(
  executionCwd: string,
  realpath: (cwd: string) => Promise<string> = (cwd) => fs.realpath(cwd),
): Promise<string> {
  const resolved = await Result.tryPromise({
    try: () => realpath(executionCwd),
    catch: (cause) =>
      new AgentExternalHostFailed({
        cause,
        message: "Claude execution cwd canonicalization failed",
      }),
  });
  if (resolved.isErr()) {
    if (isPanic(resolved.error.cause)) throw resolved.error.cause;
    return path.resolve(executionCwd);
  }
  return resolved.match({ ok: (value) => value, err: () => path.resolve(executionCwd) });
}

function reportClaudeLifecycle(
  logger: ReturnType<typeof createLogger>,
  label: string,
  event: string,
  detail: Parameters<typeof formatClaudeLifecycleLogFields>[1],
  error: AnyTaggedError | undefined,
): void {
  const fields = formatClaudeLifecycleLogFields(event, detail, error);
  switch (true) {
    case event === "native-source-invalid" ||
      event === "candidate-observability-lost" ||
      event === "candidate-unpromotable" ||
      event === "candidate-finalization-failed" ||
      event === "canonical-publication-failed" ||
      event === "promotion-failed" ||
      event === "promotion-rejected":
      logger.warn(label, fields);
      return;
    case event === "canonical-published" || event === "promotion":
      logger.info(label, fields);
      return;
    default:
      logger.debug(label, fields);
      return;
  }
}
