import type { ToolSet } from "ai";
import { isPluginPanic, safePluginExceptionCause } from "@stanley2058/lilac-plugin-runtime";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";
import { computeInputCompactionBudget } from "@stanley2058/lilac-agent";
import type { CorePrimaryLineageV2 } from "@stanley2058/lilac-event-bus";
import {
  deriveSubagentIdleTimeoutMs,
  ModelCapability,
  resolveEditingToolMode,
  resolveRouterSessionConfig,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { CoreToolPluginManager } from "../../plugins";
import type { TranscriptStore } from "../../transcript/transcript-store";
import { resolveSessionSafetyMode } from "../session-policy";
import { resolveAgentRunModelResult, selectedLevel1ToolNames } from "../bridge/bus-agent-runner";
import { resolveCorePrimaryLoadedCatalogIds } from "../bridge/bus-agent-runner/lineage-tool-authority";
import {
  estimateContextSnapshotTokens,
  type ContextSnapshotMessage,
  type ContextSnapshotTokenEstimate,
} from "../bridge/bus-agent-runner/stats";
import { maybeBuildSkillsSectionForPrimary } from "../bridge/bus-agent-runner/skills-context";
import { buildAgentRunSystemPrompt } from "../bridge/bus-agent-runner/system-prompt";
import { resolveSessionAdditionalPrompts } from "../bridge/bus-agent-runner/prompt-overlays";
import { buildHeartbeatOverlayForRequest } from "../bridge/bus-agent-runner/prompt-overlays";

const CONTEXT_REPORT_ACCENT_COLOR = 0x5865f2;
const USAGE_BAR_WIDTH = 20;

export type DiscordContextReportSource = "rest" | "snapshot";

export type DiscordContextReport = {
  readonly text: string;
  readonly accentColor: number;
};

export type DiscordContextReportRequest = {
  readonly source: DiscordContextReportSource;
  readonly config: CoreConfig;
  readonly sessionId: string;
  readonly requestId?: string;
  readonly userId?: string;
  readonly parentChannelId?: string;
  readonly guildId?: string;
  readonly modelOverride?: string;
  readonly messages: readonly ContextSnapshotMessage[];
  readonly corePrimaryLineage?: CorePrimaryLineageV2;
};

export type DiscordContextReportProvider = (
  request: DiscordContextReportRequest,
) => Promise<ResultType<DiscordContextReport, DiscordContextReportFailed>>;

export class DiscordContextReportFailed extends TaggedError("DiscordContextReportFailed")<{
  readonly stage: "model" | "tools";
  readonly cause?: unknown;
  readonly message: string;
}> {}

function compactCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) {
    const digits = value >= 100_000 ? 0 : 1;
    return `${(value / 1_000).toFixed(digits).replace(/\.0$/, "")}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function percentage(value: number, denominator: number): string {
  if (denominator <= 0) return "";
  return `${((value * 100) / denominator).toFixed(1)}%`;
}

function formatUsageBar(used: number, limit: number | null): string {
  if (!limit || limit <= 0) return "";
  const filled = Math.max(
    0,
    Math.min(USAGE_BAR_WIDTH, Math.round((used / limit) * USAGE_BAR_WIDTH)),
  );
  return `${"█".repeat(filled)}${"░".repeat(USAGE_BAR_WIDTH - filled)}`;
}

function formatCompositionRows(
  estimate: ContextSnapshotTokenEstimate,
  contextLimit: number | null,
  compactionTrigger: number | null,
): string[] {
  const denominator = contextLimit && contextLimit > 0 ? contextLimit : estimate.total;
  const rows: Array<readonly [string, number]> = [
    ["System prompt", estimate.systemPrompt],
    ["Additional prompts", estimate.additionalPrompts],
    ["Skills", estimate.skills],
    ["Active tool schemas", estimate.activeToolSchemas],
    ["User messages", estimate.userMessages],
    ["Assistant messages", estimate.assistantMessages],
    ["Tool results", estimate.toolResults],
  ];
  const visibleRows = rows.filter(([, tokens]) => tokens > 0);
  if (contextLimit && contextLimit > 0) {
    const visibleTrigger =
      compactionTrigger && compactionTrigger < contextLimit ? compactionTrigger : null;
    const usableLimit = visibleTrigger ?? contextLimit;
    visibleRows.push(["Free space", Math.max(0, usableLimit - estimate.total)]);
    if (visibleTrigger) {
      visibleRows.push(["Unusable space", contextLimit - visibleTrigger]);
    }
  }

  return visibleRows.map(([label, tokens]) => {
    const count = compactCount(tokens).padStart(7);
    const pct = percentage(tokens, denominator).padStart(6);
    return `${label.padEnd(21)} ${count} ${pct}`;
  });
}

function formatReport(input: {
  source: DiscordContextReportSource;
  model: string;
  estimate: ContextSnapshotTokenEstimate;
  contextLimit: number | null;
  compactionTrigger: number | null;
  activeToolCount: number;
  selectedToolCount: number;
  pluginCatalogCount: number;
  mcpCatalogCount: number;
}): DiscordContextReport {
  const title = input.source === "rest" ? "Resting context" : "Context snapshot";
  const limit = input.contextLimit;
  const usage = limit
    ? `${compactCount(input.estimate.total)} / ${compactCount(limit)} tokens (${percentage(input.estimate.total, limit)})`
    : `${compactCount(input.estimate.total)} estimated tokens`;
  const usageBar = formatUsageBar(input.estimate.total, limit);
  const rows = formatCompositionRows(input.estimate, limit, input.compactionTrigger);
  const selected = input.selectedToolCount > 0 ? ` · ${input.selectedToolCount} selected` : "";

  return {
    accentColor: CONTEXT_REPORT_ACCENT_COLOR,
    text: [
      `**${title}**`,
      `\`${input.model}\` · ${usage}`,
      usageBar ? `\`${usageBar}\`` : "",
      "",
      "```text",
      ...rows,
      "```",
      `**Tools**\n${input.activeToolCount} active${selected}`,
      `Catalog: ${input.pluginCatalogCount} plugin · ${input.mcpCatalogCount} MCP, loaded on demand`,
      "",
      "Estimated text composition. Media payloads are omitted.",
    ]
      .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
      .join("\n"),
  };
}

function selectActiveTools(toolset: ToolSet, names: ReadonlySet<string>): ToolSet {
  return Object.fromEntries(Object.entries(toolset).filter(([name]) => names.has(name))) as ToolSet;
}

export function createDiscordContextReportProvider(params: {
  readonly pluginManager: CoreToolPluginManager;
  readonly transcriptStore?: TranscriptStore;
  readonly cwd: string;
}): DiscordContextReportProvider {
  return async (request) => {
    const modelPlan = resolveAgentRunModelResult({
      cfg: request.config,
      runProfile: "primary",
      requestModelOverride: request.modelOverride,
    });
    const modelError = modelPlan.match({ ok: () => null, err: (error) => error });
    if (modelError) {
      return Result.err(
        new DiscordContextReportFailed({
          stage: "model",
          cause: modelError,
          message: modelError.message,
        }),
      );
    }
    const resolved = modelPlan.match({ ok: (value) => value.head, err: () => null });
    if (!resolved) {
      return Result.err(
        new DiscordContextReportFailed({
          stage: "model",
          message: "Could not resolve the session model",
        }),
      );
    }

    const sessionConfig = resolveRouterSessionConfig(request.config, {
      sessionId: request.sessionId,
      parentChannelId: request.parentChannelId,
      guildId: request.guildId,
    });
    const additionalSessionPrompts = await resolveSessionAdditionalPrompts({
      entries: sessionConfig.additionalPrompts,
    });
    const skillsSection = await maybeBuildSkillsSectionForPrimary();
    const safetyMode = resolveSessionSafetyMode(
      request.config,
      request.sessionId,
      request.parentChannelId,
      request.guildId,
    );
    const editingToolMode = resolveEditingToolMode({
      provider: resolved.provider,
      modelId: resolved.modelId,
    });
    const reportRequestId = request.requestId ?? `context:${crypto.randomUUID()}`;
    const system = buildAgentRunSystemPrompt({
      cfg: request.config,
      runProfile: "primary",
      resolved,
      editingToolMode,
      skillsSection,
      additionalSessionPrompts,
      messages: request.messages,
      safetyMode,
      sessionId: request.sessionId,
      heartbeatOverlay: buildHeartbeatOverlayForRequest({
        cfg: request.config,
        requestId: reportRequestId,
        sessionId: request.sessionId,
        runProfile: "primary",
        nowMs: Date.now(),
      }),
    });

    const subagents = request.config.agent.subagents;
    const toolsetResult = await params.pluginManager.buildLevel1ToolsetResult({
      cwd: params.cwd,
      runProfile: "primary",
      editingToolMode,
      subagentDepth: 0,
      subagentConfig: {
        enabled: subagents.enabled,
        idleTimeoutMs: deriveSubagentIdleTimeoutMs(request.config.agent.idleTimeoutMs),
        maxDepth: subagents.maxDepth,
      },
      requestContext: {
        requestId: reportRequestId,
        sessionId: request.sessionId,
        requestClient: "discord",
        subagentDepth: 0,
        subagentProfile: "primary",
        safetyMode,
        ...(request.userId
          ? {
              requestInitiator: { platform: "discord" as const, userId: request.userId },
              requestInitiatorSessionId: request.sessionId,
              currentTurnUserId: request.userId,
            }
          : {}),
      },
    });
    const toolsetError = toolsetResult.match({ ok: () => null, err: (error) => error });
    if (toolsetError) {
      return Result.err(
        new DiscordContextReportFailed({
          stage: "tools",
          cause: toolsetError,
          message: toolsetError.message,
        }),
      );
    }
    const toolset = toolsetResult.match({ ok: (value) => value, err: () => null });
    if (!toolset) {
      return Result.err(
        new DiscordContextReportFailed({
          stage: "tools",
          message: "Could not assemble the session tools",
        }),
      );
    }

    const buildReport = async () => {
      const selectedCatalogIds = resolveCorePrimaryLoadedCatalogIds({
        lineage: request.corePrimaryLineage,
        transcriptStore: params.transcriptStore,
      });
      const activeToolNames = selectedLevel1ToolNames(toolset, selectedCatalogIds);
      toolset.updateActiveBatchTools(activeToolNames);
      const activeTools = selectActiveTools(toolset.tools, activeToolNames);
      const estimate = estimateContextSnapshotTokens({
        system,
        skillsSection,
        additionalSessionPrompts,
        messages: request.messages,
        tools: activeTools,
      });

      const capabilityConfig = request.config.models.capability;
      const capability = await new ModelCapability({
        forceUnknownProviders: capabilityConfig?.forceUnknownProviders ?? ["openai-compatible"],
        overrides: capabilityConfig?.overrides ?? {},
      }).resolveResult(resolved.spec);
      const modelLimits = capability.match({
        ok: (value) => (value.limit.context > 0 ? value.limit : null),
        err: () => null,
      });
      const contextLimit = modelLimits?.context ?? null;
      const compactionTrigger = modelLimits
        ? computeInputCompactionBudget({
            contextLimit: modelLimits.context,
            outputLimit: modelLimits.output,
          }).inputBudget
        : null;
      const selectedSet = new Set(selectedCatalogIds);
      const selectedToolCount = toolset.catalog.filter((entry) =>
        selectedSet.has(entry.stableId),
      ).length;

      return Result.ok(
        formatReport({
          source: request.source,
          model: resolved.spec,
          estimate,
          contextLimit,
          compactionTrigger,
          activeToolCount: activeToolNames.size,
          selectedToolCount,
          pluginCatalogCount: toolset.catalog.filter((entry) => entry.source === "plugin").length,
          mcpCatalogCount: toolset.catalog.filter((entry) => entry.source === "mcp").length,
        }),
      );
    };
    const [report] = await Promise.allSettled([buildReport()]);
    const [cleanup] = await Promise.allSettled([toolset.release()]);
    if (report.status === "rejected" && isPluginPanic(report.reason)) {
      return adaptToolResultToHost(Result.err(report.reason));
    }
    if (cleanup.status === "rejected" && isPluginPanic(cleanup.reason)) {
      return adaptToolResultToHost(Result.err(cleanup.reason));
    }
    if (report.status === "rejected") {
      return adaptToolResultToHost(Result.err(safePluginExceptionCause(report.reason)));
    }
    if (cleanup.status === "rejected") {
      return adaptToolResultToHost(Result.err(safePluginExceptionCause(cleanup.reason)));
    }
    return cleanup.value
      .andThen(() => report.value)
      .mapError(
        (error) =>
          new DiscordContextReportFailed({
            stage: "tools",
            cause: error,
            message: error.message,
          }),
      );
  };
}

export function isDiscordContextTextCommand(text: string): boolean {
  return text.startsWith("!context");
}
