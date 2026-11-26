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
import { isGeneratedMessage } from "@stanley2058/lilac-agent";
import type { DurableWorkflowStore, SubagentFollowUp } from "../../workflow/durable-workflow-store";
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

type LiveParentTarget = Extract<WorkflowRun["completionTarget"], { kind: "live_parent" }>;

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

/** Indexes of the text replies after an exchange's last activity, in `[start, end)`. */
function closingReplies(messages: readonly DisplayMessage[], start: number, end: number) {
  const lastWork = messages
    .slice(start, end)
    .findLastIndex((message) => message.parts.some((part) => part.type !== "text"));
  const replies: number[] = [];
  for (let reply = start + lastWork + 1; reply < end; reply++) replies.push(reply);
  return replies;
}

/**
 * Marks the replies that close each prompt as final and other assistant messages as commentary.
 * The last prompt's reply is final only once its run completed.
 */
function withReplyPhases(messages: readonly DisplayMessage[], complete: boolean): DisplayMessage[] {
  const finals = new Set<number>();
  let start = 0;
  for (let index = 0; index <= messages.length; index++) {
    const end = index === messages.length;
    if (!end && messages[index]!.role !== "user") continue;
    if (!end || complete)
      for (const reply of closingReplies(messages, start, index)) finals.add(reply);
    start = index + 1;
  }
  return messages.map((message, index) =>
    message.role === "assistant"
      ? {
          ...message,
          metadata: { ...message.metadata, phase: finals.has(index) ? "final" : "commentary" },
        }
      : message,
  );
}

/**
 * Copies earlier exchanges into a follow-up's stream under new IDs. Native message IDs carry
 * their run's output position and thinking IDs repeat between runs, so kept IDs would let the
 * follow-up's own output land among or update the copies. Tool activity IDs come from unique
 * tool calls and stay, since a delegation row finds its nested agent by that ID.
 */
function seededHistory(messages: readonly DisplayMessage[]): DisplayMessage[] {
  const seeded = (id: string) => `seed_${digest(id)}`;
  return messages.map((message) => ({
    ...message,
    id: seeded(message.id),
    parts: message.parts.map((part) => {
      if (part.type === "data-activity" && part.data.kind === "tool") return part;
      return "id" in part ? { ...part, id: seeded(part.id) } : part;
    }),
  }));
}

/**
 * Whether a follow-up's stream starts at a later prompt of its saved session, as streams did
 * before history seeding. Seeded streams start with copied history, and streams projected from a
 * transcript start at its first prompt. A later prompt may be followed by steers.
 */
function startsAtOwnPrompt(
  shown: readonly DisplayMessage[],
  saved: readonly (StoredMessageV1 | ModelMessage)[],
) {
  const first = shown[0];
  if (first?.role !== "user" || !first.id.startsWith("child_0_0_")) return false;
  const text = (message: DisplayMessage | undefined) =>
    message?.parts.find((part) => part.type === "text")?.text;
  const [opening, ...later] = saved
    .filter((message) => message.role === "user")
    .map((message) => text(subagentMessages([message])[0]));
  return text(first) !== opening && later.includes(text(first));
}

type SavedMessage = StoredMessageV1 | ModelMessage;
type Alignment = { readonly anchor: number; readonly replyLength: number };

function savedText(message: SavedMessage) {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function shownText(message: DisplayMessage) {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Text without whitespace, which chunking, batching steers, and trimming change. */
const squashed = (text: string) => text.replace(/\s+/gu, "");

function shownToolCall(messages: readonly DisplayMessage[], toolCallId: string) {
  const id = digest(toolCallId);
  return messages.findIndex((message) =>
    message.parts.some((part) => part.type === "data-activity" && part.id === id),
  );
}

/** The last of the consecutive user messages from `first` that together hold `text`, or -1. */
function shownUserMessage(messages: readonly DisplayMessage[], first: number, text: string) {
  const target = squashed(text);
  let shown = "";
  for (let last = first; messages[last]?.role === "user"; last++) {
    shown += squashed(shownText(messages[last]!));
    if (shown === target) return last;
    if (!target.startsWith(shown)) return -1;
  }
  return -1;
}

const isReplyText = (message: DisplayMessage | undefined) =>
  message?.role === "assistant" &&
  message.parts.length > 0 &&
  message.parts.every((part) => part.type === "text");

/** The end of the only run of stream reply messages that holds `text`, or -1. */
function uniqueShownReply(messages: readonly DisplayMessage[], text: string) {
  const target = squashed(text);
  if (target.length === 0) return -1;
  const ends = messages.flatMap((_, first) => {
    let shown = "";
    for (let last = first; isReplyText(messages[last]); last++) {
      shown += squashed(shownText(messages[last]!));
      if (shown === target) return [last];
      if (!target.startsWith(shown)) return [];
    }
    return [];
  });
  return ends.length === 1 ? ends[0]! : -1;
}

/**
 * Moves past an assistant message: to its latest shown tool call, counting reply text since.
 * Before any anchor, as after compaction drops the prompt, a reply the stream shows exactly once
 * anchors instead.
 */
function alignAssistant(
  messages: readonly DisplayMessage[],
  message: Extract<SavedMessage, { role: "assistant" }>,
  aligned: Alignment,
): Alignment {
  const parts =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content;
  let { anchor, replyLength } = aligned;
  for (const part of parts) {
    if (part.type === "text") replyLength += squashed(part.text).length;
    if (part.type !== "tool-call") continue;
    const found = shownToolCall(messages, part.toolCallId);
    if (found <= anchor) continue;
    anchor = found;
    replyLength = 0;
  }
  if (anchor >= 0) return { anchor, replyLength };
  const reply = uniqueShownReply(messages, savedText(message));
  return reply < 0 ? { anchor, replyLength } : { anchor: reply, replyLength: 0 };
}

/**
 * Whether a message can sit where a transcript user message belongs: a user message, or a reply
 * an interrupt cut short, which the stream keeps and the transcript drops.
 */
const isUserSpot = (message: DisplayMessage | undefined) =>
  message?.role === "user" ||
  (message?.role === "assistant" && message.metadata?.incomplete === true);

const isThinking = (message: DisplayMessage) =>
  message.parts.every((part) => part.type === "data-activity" && part.data.kind === "thinking");

/** Where a steer goes after its anchor: past the reply text, and its thinking, ahead of it. */
function steerPosition(messages: readonly DisplayMessage[], { anchor, replyLength }: Alignment) {
  let position = anchor + 1;
  let covered = 0;
  while (covered < replyLength) {
    const message = messages[position];
    if (message?.role !== "assistant") break;
    position++;
    if (isThinking(message)) continue;
    if (message.parts.some((part) => part.type !== "text")) return position - 1;
    covered += squashed(shownText(message)).length;
  }
  return position;
}

/**
 * Adds the steers a run's saved transcript holds and its stream lacks, since streams once
 * showed only output. Each belongs after the stream's copy of what preceded it in the transcript:
 * the latest tool call or user message, then the reply text that followed. A user message matches
 * only among the stream's user messages at that spot, so a later one with the same text cannot
 * stand in for it. User messages the stream lacks ahead of every match, such as a compaction
 * summary, stay out. Null when nothing is missing.
 */
function withTranscriptSteers(
  shown: readonly DisplayMessage[],
  saved: readonly SavedMessage[],
): DisplayMessage[] | null {
  const messages = [...shown];
  let aligned: Alignment = { anchor: -1, replyLength: 0 };
  let added = false;
  for (const [index, message] of saved.entries()) {
    if (message.role === "system" || message.role === "tool") continue;
    if (message.role === "assistant") {
      aligned = alignAssistant(messages, message, aligned);
      continue;
    }
    const text = savedText(message);
    const position = steerPosition(messages, aligned);
    let match = -1;
    for (let first = position; isUserSpot(messages[first]) && match < 0; first++)
      if (messages[first]!.role === "user") match = shownUserMessage(messages, first, text);
    if (match >= 0) {
      aligned = { anchor: match, replyLength: 0 };
      continue;
    }
    // Generated messages are runtime context; they align when a projection shows them, never insert.
    if (isGeneratedMessage(message) || aligned.anchor < 0 || squashed(text).length === 0) continue;
    const parts: DisplayPart[] = [];
    for (let offset = 0; offset < text.length; offset += MAX_REPLAY_TEXT_LENGTH)
      parts.push({ type: "text", text: text.slice(offset, offset + MAX_REPLAY_TEXT_LENGTH) });
    messages.splice(position, 0, {
      id: `steer_${digest(`${index}:${text}`)}`,
      role: "user",
      metadata: { inputMode: "steer" },
      parts,
    });
    aligned = { anchor: position, replyLength: 0 };
    added = true;
  }
  return added ? messages : null;
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
    // Native output derives tool activity IDs from the call, and delegation rows find nested
    // agents by them.
    id: digest(part.toolCallId),
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
        | "agentStreamMessages"
        | "rewriteAgentStream"
        | "notifyDisplayChanged"
      >;
      workflows: Pick<
        DurableWorkflowStore,
        | "listSubagentRuns"
        | "listSubagentFollowUps"
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
        const parent = yield* this.parentRun(target);
        if (!parent) return Result.ok(null);
        current = parent;
      }
      return Result.ok(null);
    }, this);
  }

  /** The subagent run that delegated this one; null when a thread input or nothing owns it. */
  private parentRun(target: LiveParentTarget) {
    return Result.gen(function* () {
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
      return Result.ok(parent);
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
      const history = yield* this.previousHistory(root.threadId, run);
      const prompt = subagentMessages([{ role: "user", content: input.prompt }]);
      return this.options.native.ensureAgentStream({
        parentThreadId: root.threadId,
        parentRequestId: root.requestId,
        runId: run.runId,
        requestId: input.requestId,
        messages: [...history, ...prompt],
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
      if (existing) return this.openExisting(root.threadId, run, existing);
      const requestId = yield* this.childRequestId(run, run.completionTarget.childRequestId);
      return this.options.native.ensureAgentStream({
        parentThreadId: root.threadId,
        parentRequestId: root.requestId,
        runId: run.runId,
        requestId,
        state: workflowDisplayState(run.state),
        startedAt: run.startedAt ?? run.createdAt,
        messages: yield* this.unstreamedMessages(root.threadId, run, requestId),
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

  /** Where listed follow-up runs sit in their child sessions, by run id. */
  private followUps(threadId: string, runIds: readonly string[]) {
    return this.options.workflows
      .listSubagentFollowUps(`native:${threadId}`, runIds)
      .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
  }

  private savedTranscript(requestId: string) {
    return (
      this.options.transcripts
        .getRequestTranscript?.({ requestId })
        .mapError(() => nativeFailure("sqlite", "Transcript is unavailable")) ?? Result.ok(null)
    );
  }

  /**
   * What a run without a stream shows: its saved transcript, or for a follow-up that ended
   * before saving one, the session so far. A run yet to start stays empty, so preparing its
   * output adds the prompt.
   */
  private unstreamedMessages(threadId: string, run: WorkflowRun, requestId: string) {
    return Result.gen(function* () {
      const saved = yield* this.savedTranscript(requestId);
      const state = workflowDisplayState(run.state);
      if (saved)
        return Result.ok(withReplyPhases(subagentMessages(saved.messages), state === "complete"));
      if (state === "running") return Result.ok([]);
      return this.previousHistory(threadId, run);
    }, this);
  }

  /** Settles an existing stream and fills in history it lacks before a viewer opens it. */
  private openExisting(threadId: string, run: WorkflowRun, stream: NativeAgentStreamRecord) {
    return Result.gen(function* () {
      yield* this.settle(run, stream);
      if (workflowDisplayState(run.state) === "running") return Result.ok(stream);
      const saved = yield* this.runTranscript(run.runId);
      yield* this.backfillHistory(threadId, run, saved?.messages);
      yield* this.options.native.rewriteAgentStream(run.runId, (messages) =>
        saved ? withTranscriptSteers(messages, saved.messages) : null,
      );
      return Result.ok((yield* this.options.native.findAgentStream(run.runId)) ?? stream);
    }, this);
  }

  /**
   * What the child session showed before this run, from the nearest earlier run that kept it.
   */
  private previousHistory(threadId: string, run: WorkflowRun) {
    return Result.gen(function* () {
      const visited = new Set([run.runId]);
      let current = run.runId;
      for (;;) {
        const previousId = (yield* this.followUps(threadId, [current])).get(current)?.previousRunId;
        if (!previousId || visited.has(previousId)) return Result.ok([]);
        visited.add(previousId);
        const history = yield* this.runHistory(previousId);
        if (history) return Result.ok(seededHistory(history));
        current = previousId;
      }
    }, this);
  }

  /**
   * What one run's session showed: its stream, which keeps exchanges a compacted transcript
   * summarizes, unless the stream starts at the run's own prompt; then its saved transcript,
   * which holds the whole session. Null when the run kept neither.
   */
  private runHistory(runId: string) {
    return Result.gen(function* () {
      const shown = yield* this.options.native.agentStreamMessages(runId);
      const saved = yield* this.runTranscript(runId);
      // A run canceled before it started leaves an empty stream, which holds no history.
      const usable = shown?.length && !(saved && startsAtOwnPrompt(shown, saved.messages));
      if (usable) return Result.ok(shown);
      if (saved) return Result.ok(withReplyPhases(subagentMessages(saved.messages), true));
      return Result.ok(null);
    }, this);
  }

  private runTranscript(runId: string) {
    return Result.gen(function* () {
      const run = yield* this.options.workflows
        .getRun(runId)
        .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
      if (run?.completionTarget.kind !== "live_parent") return Result.ok(null);
      const requestId = yield* this.childRequestId(run, run.completionTarget.childRequestId);
      return this.savedTranscript(requestId);
    }, this);
  }

  /**
   * Fills in history an ended run's stream lacks: earlier exchanges ahead of a stream that
   * starts at its own prompt, as streams did before follow-ups were seeded, or the session so far
   * in a stream left empty by a run canceled before it started. The rewritten stream no longer
   * matches either case, so this runs once.
   */
  private backfillHistory(
    threadId: string,
    run: WorkflowRun,
    saved: readonly SavedMessage[] | undefined,
  ) {
    return Result.gen(function* () {
      const shown = yield* this.options.native.agentStreamMessages(run.runId);
      if (!shown) return Result.ok(undefined);
      const legacy = (messages: readonly DisplayMessage[]) =>
        !!saved && startsAtOwnPrompt(messages, saved);
      if (shown.length > 0 && !legacy(shown)) return Result.ok(undefined);
      const history =
        shown.length === 0 && saved
          ? withReplyPhases(subagentMessages(saved), run.state === "succeeded")
          : yield* this.previousHistory(threadId, run);
      if (history.length === 0) return Result.ok(undefined);
      return this.options.native.rewriteAgentStream(run.runId, (messages) => {
        if (messages.length === 0) return history;
        return legacy(messages) ? [...history, ...messages] : null;
      });
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

  private summary(
    run: WorkflowRun,
    turnId: string,
    requestId: string,
    followUp?: SubagentFollowUp,
  ) {
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
      const parent = yield* this.parentRun(target);
      return Result.ok({
        id: run.runId,
        ...(parent ? { parentId: parent.runId } : {}),
        ...(followUp
          ? { firstRunId: followUp.firstRunId, previousId: followUp.previousRunId }
          : {}),
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
      const listed = runs.slice(0, 100);
      const followUps = yield* this.followUps(
        input.threadId,
        listed.map((run) => run.runId),
      );
      const items: SubagentSummary[] = [];
      for (const run of listed) {
        const target = run.completionTarget;
        if (target.kind !== "live_parent") continue;
        const parent = yield* this.root(run);
        if (parent?.threadId !== input.threadId) continue;
        if (!parent?.turnId) continue;
        const requestId = yield* this.childRequestId(run, target.childRequestId);
        const summary = yield* this.summary(
          run,
          parent.turnId,
          requestId,
          followUps.get(run.runId),
        );
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
      if (!run || target?.kind !== "live_parent")
        return Result.err(nativeFailure("not-found", "Subagent not found"));
      const parent = yield* this.root(run);
      if (parent?.threadId !== input.threadId || !parent.turnId)
        return Result.err(nativeFailure("not-found", "Subagent not found"));
      const requestId = yield* this.childRequestId(run, target.childRequestId);
      const followUp = (yield* this.followUps(input.threadId, [run.runId])).get(run.runId);
      const agent = (yield* this.summary(run, parent.turnId, requestId, followUp))!;
      const live = this.options
        .live()
        ?.readSubagentSnapshot(target.childSessionId, requestId, true);
      const saved = live ? null : yield* this.savedTranscript(requestId);
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
