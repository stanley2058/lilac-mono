import { createHash } from "node:crypto";
import {
  MAX_REPLAY_TEXT_LENGTH,
  type DisplayMessage,
  type DisplayPart,
  type SubagentSummary,
} from "@stanley2058/lilac-client-protocol";
import type { ModelMessage } from "ai";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";
import type { DurableWorkflowStore } from "../../workflow/durable-workflow-store";
import type { WorkflowRun } from "../../workflow/workflow-domain";
import type { TranscriptStore } from "../../transcript/transcript-store";
import type { NativeStore } from "./store";
import type { NativeAgentStreamRecord } from "./codec";
import { activityPartData } from "./output-projection";
import {
  nativeToolActivityLabel,
  nativeToolActivityDetail,
  nativeToolActivityResult,
} from "../bridge/bus-agent-runner/native-activity-result";
import { nativeFailure } from "./errors";

export type SubagentSnapshot = {
  messages: readonly ModelMessage[];
  streaming: boolean;
  activeTools?: readonly { toolCallId: string; toolName: string }[];
  title: string;
  model?: string;
  reasoning?: SubagentSummary["reasoning"];
};
export type SubagentReader = {
  readSubagentSnapshot(
    sessionId: string,
    requestId: string,
    includeMessages?: boolean,
  ): SubagentSnapshot | undefined;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export type SubagentStreamingMode = "paragraph" | "complete";

// Mirrors the native output publisher: paragraph mode reveals finished paragraphs, complete mode
// reveals text when the step ends.
function visibleStreamText(text: string, mode: SubagentStreamingMode, lastPart: boolean) {
  if (mode === "complete") return "";
  if (!lastPart) return text;
  const normalized = text.replaceAll("\r\n", "\n");
  const boundary = normalized.lastIndexOf("\n\n");
  return boundary < 0 ? "" : normalized.slice(0, boundary + 2);
}

export function subagentMessages(
  messages: readonly (StoredMessageV1 | ModelMessage)[],
  streaming = false,
  activeTools: NonNullable<SubagentSnapshot["activeTools"]> = [],
  mode: SubagentStreamingMode = "paragraph",
): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  const activeIds = new Set(activeTools.map((tool) => tool.toolCallId));
  const includedTools = new Set<string>();
  const outputs = new Map<string, TranscriptToolOutput>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") outputs.set(part.toolCallId, part.output);
    }
  }
  for (const [index, message] of messages.entries()) {
    if (message.role === "system" || message.role === "tool") continue;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const streamed = streaming && index === messages.length - 1;
    let segment = 0;
    for (const part of content) {
      const id = `child_${index}_${segment++}`;
      if (part.type === "text") {
        const text = streamed
          ? visibleStreamText(part.text, mode, part === content.at(-1))
          : part.text;
        for (let offset = 0; offset < text.length; offset += MAX_REPLAY_TEXT_LENGTH)
          result.push({
            id: `${id}_${offset}`,
            role: message.role,
            ...(streamed ? { metadata: { incomplete: true } } : {}),
            parts: [{ type: "text", text: text.slice(offset, offset + MAX_REPLAY_TEXT_LENGTH) }],
          });
        continue;
      }
      if (part.type === "tool-call") includedTools.add(part.toolCallId);
      const running =
        (part.type === "tool-call" && activeIds.has(part.toolCallId)) ||
        (part.type === "reasoning" &&
          streaming &&
          !activeTools.length &&
          index === messages.length - 1 &&
          part === content.at(-1));
      const activity = transcriptActivity(
        part,
        id,
        running,
        part.type === "tool-call" ? outputs.get(part.toolCallId) : undefined,
      );
      if (activity) result.push({ id, role: message.role, parts: [activity] });
    }
  }
  for (const tool of activeTools) {
    if (includedTools.has(tool.toolCallId)) continue;
    const id = `child_tool_${digest(tool.toolCallId)}`;
    result.push({
      id,
      role: "assistant",
      parts: [
        {
          type: "data-activity",
          id,
          data: { kind: "tool", label: tool.toolName.slice(0, 256), state: "running" },
        },
      ],
    });
  }
  return result;
}

type TranscriptPart = Exclude<StoredMessageV1["content"] | ModelMessage["content"], string>[number];
type TranscriptToolOutput = Extract<TranscriptPart, { type: "tool-result" }>["output"];

function transcriptToolValue(output?: TranscriptToolOutput) {
  if (!output) return undefined;
  if (output.type === "execution-denied") return output.reason;
  if (output.type === "content")
    return output.value.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return output.value;
}

function transcriptToolState(running: boolean, output?: TranscriptToolOutput) {
  if (running) return "start" as const;
  const failed =
    output?.type === "error-text" ||
    output?.type === "error-json" ||
    output?.type === "execution-denied";
  return failed ? ("failed" as const) : ("complete" as const);
}

function workflowDisplayState(
  state: WorkflowRun["state"],
  fallback: SubagentSummary["state"] = "running",
) {
  if (state !== "succeeded" && state !== "failed" && state !== "cancelled") return fallback;
  return ({ succeeded: "complete", failed: "failed", cancelled: "canceled" } as const)[state];
}

function transcriptActivity(
  part: Exclude<StoredMessageV1["content"] | ModelMessage["content"], string>[number],
  id: string,
  running: boolean,
  output?: TranscriptToolOutput,
): DisplayPart | undefined {
  if (part.type === "reasoning")
    return {
      type: "data-activity",
      id,
      data: activityPartData({
        kind: "thinking",
        state: running ? "start" : "complete",
        ...(!running && part.text ? { detail: part.text } : {}),
      }),
    };
  if (part.type !== "tool-call") return undefined;
  const event = { args: part.input, result: transcriptToolValue(output) };
  return {
    type: "data-activity",
    id,
    data: activityPartData({
      kind: "tool",
      label: nativeToolActivityLabel({ toolName: part.toolName, event }),
      state: transcriptToolState(running, output),
      ...nativeToolActivityDetail({ toolName: part.toolName, event }),
      ...nativeToolActivityResult({ toolName: part.toolName, event }),
    }),
  };
}

export class NativeSubagents {
  constructor(
    private readonly options: {
      native: Pick<
        NativeStore,
        | "authorizeThread"
        | "listCanonicalRequestIds"
        | "getInputByRequestId"
        | "ensureAgentStream"
        | "findAgentStream"
        | "settleAgentStream"
        | "notifyDisplayChanged"
      >;
      workflows: Pick<
        DurableWorkflowStore,
        | "listSubagentRuns"
        | "getRun"
        | "listOperations"
        | "getOperationByRequestId"
        | "getWorkflowRequestDispatchPolicy"
      >;
      transcripts: Pick<TranscriptStore, "getRequestTranscript">;
      live: () => SubagentReader | undefined;
      streamingMode: () => SubagentStreamingMode;
    },
  ) {}

  private root(run: WorkflowRun) {
    return Result.gen(function* () {
      const visited = new Set<string>();
      let current = run;
      while (current.completionTarget.kind === "live_parent") {
        if (visited.has(current.runId)) return Result.ok(null);
        visited.add(current.runId);
        const target = current.completionTarget;
        const input = yield* this.options.native.getInputByRequestId(target.parentRequestId);
        if (input) {
          if (target.parentSessionId !== `native:${input.threadId}`) return Result.ok(null);
          const canonical = yield* this.options.native.listCanonicalRequestIds(input.threadId);
          return Result.ok(input.turnId && canonical.includes(input.requestId) ? input : null);
        }
        const operation = yield* this.options.workflows
          .getOperationByRequestId(target.parentRequestId)
          .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
        if (!operation) return Result.ok(null);
        const parent = yield* this.options.workflows
          .getRun(operation.runId)
          .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
        if (
          parent?.completionTarget.kind !== "live_parent" ||
          parent.completionTarget.childSessionId !== target.parentSessionId
        )
          return Result.ok(null);
        current = parent;
      }
      return Result.ok(null);
    }, this);
  }

  prepareOutput(input: { runId: string; requestId: string; sessionId: string; prompt: string }) {
    return Result.gen(function* () {
      const run = yield* this.options.workflows
        .getRun(input.runId)
        .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
      if (
        run?.completionTarget.kind !== "live_parent" ||
        run.completionTarget.childSessionId !== input.sessionId
      )
        return Result.ok(null);
      const operation = yield* this.options.workflows
        .getOperationByRequestId(input.requestId)
        .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
      if (operation?.runId !== input.runId) return Result.ok(null);
      const root = yield* this.root(run);
      if (!root) return Result.ok(null);
      return this.options.native.ensureAgentStream({
        parentThreadId: root.threadId,
        parentRequestId: root.requestId,
        runId: run.runId,
        requestId: input.requestId,
        messages: subagentMessages([{ role: "user", content: input.prompt }]),
        taskTitle:
          run.completionTarget.kind === "live_parent" ? run.completionTarget.title : undefined,
        titlePrompt: input.prompt,
        state: "running",
        startedAt: run.startedAt ?? run.createdAt,
      });
    }, this);
  }

  stream(actorId: string, input: { threadId: string; agentId: string }) {
    return Result.gen(function* () {
      yield* this.options.native.authorizeThread(actorId, input.threadId);
      const run = yield* this.options.workflows
        .getRun(input.agentId)
        .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
      const root = run ? yield* this.root(run) : null;
      if (
        !root ||
        root.threadId !== input.threadId ||
        !run ||
        run.completionTarget.kind !== "live_parent"
      )
        return Result.err(nativeFailure("not-found", "Subagent not found"));
      const existing = yield* this.options.native.findAgentStream(run.runId);
      if (existing) {
        yield* this.settle(run, existing);
        return Result.ok(existing);
      }
      const requestId = yield* this.childRequestId(run, run.completionTarget.childRequestId);
      const saved = yield* (
        this.options.transcripts
          .getRequestTranscript?.({ requestId })
          .mapError(() => nativeFailure("sqlite", "Transcript is unavailable")) ?? Result.ok(null)
      );
      const messages = subagentMessages(saved?.messages ?? []);
      const lastWork = messages.findLastIndex(
        (message) =>
          message.role !== "assistant" || message.parts.some((part) => part.type !== "text"),
      );
      const state = workflowDisplayState(run.state);
      return this.options.native.ensureAgentStream({
        parentThreadId: root.threadId,
        parentRequestId: root.requestId,
        runId: run.runId,
        requestId,
        state,
        startedAt: run.startedAt ?? run.createdAt,
        messages: messages.map((message, index) =>
          message.role === "assistant"
            ? {
                ...message,
                metadata: {
                  ...message.metadata,
                  phase: state === "complete" && index > lastWork ? "final" : "commentary",
                },
              }
            : message,
        ),
      });
    }, this);
  }

  private settle(run: WorkflowRun, stream: NativeAgentStreamRecord) {
    const states = { succeeded: "complete", failed: "failed", cancelled: "canceled" } as const;
    if (run.state !== "succeeded" && run.state !== "failed" && run.state !== "cancelled")
      return Result.ok(undefined);
    return this.options.native.settleAgentStream(stream, states[run.state]);
  }

  reconcile(runId: string) {
    return Result.gen(function* () {
      const run = yield* this.options.workflows
        .getRun(runId)
        .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
      if (!run || run.completionTarget.kind !== "live_parent") return Result.ok(undefined);
      const root = yield* this.root(run);
      if (!root) return Result.ok(undefined);
      const stream = yield* this.options.native.findAgentStream(runId);
      if (stream) yield* this.settle(run, stream);
      this.options.native.notifyDisplayChanged(root.threadId);
      return Result.ok(undefined);
    }, this);
  }

  private childRequestId(run: WorkflowRun, fallback: string) {
    return this.options.workflows
      .listOperations(run.runId, { limit: 1_000 })
      .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"))
      .map(
        (operations) =>
          operations.find((operation) => operation.kind === "agent" && operation.requestId !== null)
            ?.requestId ?? fallback,
      );
  }

  private summary(run: WorkflowRun, turnId: string, requestId: string) {
    return Result.gen(function* () {
      const target = run.completionTarget;
      if (target.kind !== "live_parent") return Result.ok(undefined);
      const stream = yield* this.options.native.findAgentStream(run.runId);
      const live = this.options.live()?.readSubagentSnapshot(target.childSessionId, requestId);
      const state = workflowDisplayState(run.state, stream?.state);
      const titles = {
        running: stream?.title ?? live?.title ?? "Waiting…",
        complete: "Completed",
        failed: "Failed",
        canceled: "Canceled",
      };
      const title = titles[state];
      const policy = yield* this.options.workflows
        .getWorkflowRequestDispatchPolicy(requestId)
        .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
      const execution = [live, stream].find((entry) => entry?.model);
      const reasoning = execution ? execution.reasoning : policy?.resolvedModelRequest.reasoning;
      return Result.ok({
        id: run.runId,
        activityId: digest(target.parentToolCallId),
        turnId,
        profile: target.profile,
        taskTitle: target.title ?? stream?.taskTitle,
        model: live?.model ?? stream?.model ?? policy?.resolvedModelRequest.spec,
        reasoning,
        name: target.sessionName.slice(0, 256),
        title: title.slice(0, 256),
        state,
        startedAt: run.startedAt ?? run.createdAt,
      } satisfies SubagentSummary);
    }, this);
  }

  list(actorId: string, input: { threadId: string; cursor?: string }) {
    return Result.gen(function* () {
      yield* this.options.native.authorizeThread(actorId, input.threadId);
      const offset = Number(input.cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        return Result.err(nativeFailure("invalid", "Invalid agent cursor"));

      const runs = yield* this.options.workflows
        .listSubagentRuns(`native:${input.threadId}`, offset)
        .mapError(() => nativeFailure("sqlite", "Subagents are unavailable"));
      const items: SubagentSummary[] = [];
      for (const run of runs.slice(0, 100)) {
        const target = run.completionTarget;
        if (target.kind !== "live_parent") continue;
        const parent = yield* this.root(run);
        if (parent?.threadId !== input.threadId) continue;
        if (!parent?.turnId) continue;
        const requestId = yield* this.childRequestId(run, target.childRequestId);
        const summary = yield* this.summary(run, parent.turnId, requestId);
        if (summary) items.push(summary);
      }
      return Result.ok({
        items,
        ...(runs.length > 100 ? { nextCursor: String(offset + 100) } : {}),
      });
    }, this);
  }

  read(
    actorId: string,
    input: { threadId: string; agentId: string; before?: number; from?: number },
  ) {
    return Result.gen(function* () {
      yield* this.options.native.authorizeThread(actorId, input.threadId);
      const run = yield* this.options.workflows
        .getRun(input.agentId)
        .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
      const target = run?.completionTarget;
      if (
        !run ||
        target?.kind !== "live_parent" ||
        target.parentSessionId !== `native:${input.threadId}`
      )
        return Result.err(nativeFailure("not-found", "Subagent not found"));
      const validRequests = yield* this.options.native.listCanonicalRequestIds(input.threadId);
      if (!validRequests.includes(target.parentRequestId))
        return Result.err(nativeFailure("not-found", "Subagent not found"));
      const parent = yield* this.options.native.getInputByRequestId(target.parentRequestId);
      if (!parent?.turnId) return Result.err(nativeFailure("not-found", "Subagent not found"));
      const requestId = yield* this.childRequestId(run, target.childRequestId);
      const agent = (yield* this.summary(run, parent.turnId, requestId))!;
      const live = this.options
        .live()
        ?.readSubagentSnapshot(target.childSessionId, requestId, true);
      const saved = live
        ? null
        : yield* (
            this.options.transcripts
              .getRequestTranscript?.({ requestId })
              .mapError(() => nativeFailure("sqlite", "Transcript is unavailable")) ??
              Result.ok(null)
          );
      const projected = subagentMessages(
        live?.messages ?? saved?.messages ?? [],
        live?.streaming,
        live?.activeTools,
        this.options.streamingMode(),
      );
      const before = Math.min(input.before ?? projected.length, projected.length);
      const start =
        input.from === undefined || input.from > projected.length
          ? Math.max(0, before - 20)
          : input.from;
      const end = input.from === undefined ? before : Math.min(projected.length, start + 40);
      return Result.ok({
        agent,
        messages: projected.slice(start, end),
        offset: start,
        total: projected.length,
        ...(start ? { nextBefore: start } : {}),
        unavailable: !live && !saved && agent.state !== "running",
      });
    }, this);
  }
}
