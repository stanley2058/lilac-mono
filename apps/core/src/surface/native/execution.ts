import type { JobService } from "../../jobs/job-service";
import type { ModelMessage } from "ai";
import { isDeepStrictEqual } from "node:util";
import {
  expandAssistantCitations,
  collectCitations,
  CITATION_INPUT_LIMIT,
  DEFAULT_DM_CONTEXT_GAP_MS,
} from "@stanley2058/lilac-client-protocol";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  EventPublishContractInvalid,
  lilacEventTypes,
  type LilacBus,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";
import { CUSTOM_COMMAND_TEXT_PREFIX } from "@stanley2058/lilac-utils/custom-commands";
import type { CustomCommandManager } from "../../custom-commands/manager";
import type { TranscriptSnapshot, TranscriptStore } from "../../transcript/transcript-store";
import { parseNativeRequestEnvelope } from "../authenticated-request";
import { deleteDiscordRequestBlobHandles } from "../bridge/request-composition/attachments";
import { prepareStoredMessagesForBus } from "../bridge/request-composition/prepare-bus-messages";
import {
  escapeSurfaceMetadataTags,
  formatSurfaceMetadataLine,
  parseSurfaceMetadataLine,
} from "../bridge/surface-metadata";
import type { NativeRunnerLifecycle, NativeRunnerRequest } from "../bridge/bus-agent-runner";
import type { NativeInputRecord, NativeThreadRecord } from "./codec";
import { nativeFailure, NativeStoreFailure } from "./errors";
import { nativeSessionId } from "./native-protocol";
import type { NativeStore } from "./store";
import type { NativeMetrics } from "./metrics";
import { opensNativeTurn } from "./turn-transcript";

export type NativeRunnerControl = {
  cancelNativeSession(sessionId: string): Promise<ResultType<void, Error>>;
};

export function createNativeExecution(options: {
  metrics?: NativeMetrics;
  store: NativeStore;
  bus: Pick<LilacBus, "publish">;
  transcriptStore: TranscriptStore;
  blobStore?: BlobStore;
  runner: () => NativeRunnerControl | undefined;
  customCommands?: CustomCommandManager;
  expandReferences?: (
    userId: string,
    text: string,
  ) => Promise<ResultType<string, Error>> | ResultType<string, Error>;
  validateSkill?: (skillId: string, starterId: string) => boolean;
  getOldMessageSelectionMaxAgeMs?: () => number | undefined;
  getDmContextGapMs?: () => number;
  now?: () => number;
  deliveryState?: (
    deliveryId: string,
  ) => ResultType<"missing" | "owned" | "completed" | "failed" | "cancelled" | "abandoned", Error>;
  jobs?: Pick<JobService, "stopSession" | "stopSessionJobsSince">;
}) {
  const { store } = options;
  const publications = new Map<string, Promise<ResultType<void, Error>>>();
  const activeCompactions = new Map<string, readonly ModelMessage[]>();
  const cancelingThreads = new Set<string>();
  let accepting = true;

  function validate(request: NativeRunnerRequest): ReturnType<NativeRunnerLifecycle["validate"]> {
    return Result.gen(function* () {
      const native = parseNativeRequestEnvelope(request);
      if (!native)
        return Result.err(nativeFailure("invalid", "Native request metadata is invalid"));
      const input = yield* store.getInput(native.inputId);
      const thread = yield* store.authorizeThread(input.initiatingUserId, input.threadId, true);
      const starter = yield* store.getUser(thread.starterId);
      if (!input.resolvedModelRequest)
        return Result.err(nativeFailure("invalid", "Native input has no pinned model selection"));
      const requestId = input.mode === "steer" ? input.runId : input.requestId;
      if (
        input.state !== "admitted" ||
        thread.deleted ||
        thread.mutationPending ||
        input.historyGeneration !== thread.historyGeneration ||
        native.historyGeneration !== input.historyGeneration ||
        native.threadId !== input.threadId ||
        native.turnId !== input.turnId ||
        !!native.compact !== (input.command?.id === "compact") ||
        native.authorUserId !== input.authorId ||
        native.starterUserId !== starter.id ||
        native.requestDeliveryId !== input.deliveryId ||
        request.requestDeliveryId !== input.deliveryId ||
        request.requestId !== requestId ||
        native.requestId !== requestId ||
        request.sessionId !== nativeSessionId(input.threadId)
      )
        return Result.err(
          nativeFailure("stale", "Native request no longer matches its accepted intent"),
        );
      if (input.mode === "steer" && thread.activeRunId !== input.runId) {
        yield* store.settleInput(input.id, "target-ended");
        return Result.err(nativeFailure("stale", "The steering target has ended"));
      }
      const previousRequestId = yield* store.getLatestCanonicalRequestId(input.threadId);
      const previous = previousRequestId
        ? yield* (
            options.transcriptStore.getRequestTranscript?.({ requestId: previousRequestId }) ??
              Result.ok(null)
          )
        : null;
      return Result.ok({
        ...(previous?.providerState ? { historyProviderState: previous.providerState } : {}),
        safetyMode:
          input.pinnedToolMode === "full" ? ("trusted" as const) : ("restricted" as const),
        resolvedModelRequest: input.resolvedModelRequest,
      });
    });
  }

  function directHistorySuffix(
    threadId: string,
    firstPosition: number,
    canonical: readonly StoredMessageV1[],
  ) {
    return Result.gen(function* () {
      for (const [index, message] of canonical.entries()) {
        if (message.role !== "user") continue;
        let content = "";
        if (typeof message.content === "string") content = message.content;
        else if (message.content[0]?.type === "text") content = message.content[0].text;
        const header = parseSurfaceMetadataLine(content.split("\n")[0] ?? "");
        if (header?.meta.platform !== "native" || header.meta.thread_id !== threadId) continue;
        const direct = yield* store.getInputByRequestId(
          `native:${threadId}:${header.meta.message_id}`,
        );
        if (!direct || direct.mode === "steer" || direct.position < firstPosition) continue;
        return Result.ok({
          messages: canonical.slice(index),
          firstRequestId: direct.requestId,
        });
      }
      return Result.ok({ messages: [] as readonly StoredMessageV1[] });
    });
  }

  function selectFirstInput(
    thread: NativeThreadRecord,
    sessionAt: number,
  ): ResultType<NativeInputRecord | null, Error> {
    if (thread.kind === "dm")
      return store.selectSessionStartInput(thread.id, {
        gapMs: options.getDmContextGapMs?.() ?? DEFAULT_DM_CONTEXT_GAP_MS,
        at: sessionAt,
      });
    const maxAgeMs = options.getOldMessageSelectionMaxAgeMs?.();
    const cutoff =
      maxAgeMs === undefined ? 0 : Math.max(0, (options.now?.() ?? Date.now()) - maxAgeMs);
    return store.selectCanonicalInput(thread.id, { since: cutoff });
  }

  type SelectedHistory = { messages: readonly StoredMessageV1[]; firstRequestId?: string };

  function canonicalSource(threadId: string, turn: NativeInputRecord) {
    return turn.canonicalHistoryStartRequestId
      ? store.getInputByRequestId(turn.canonicalHistoryStartRequestId)
      : store.selectCanonicalInput(threadId);
  }

  /**
   * Trims a full-history row to start at `first`. Rows written before native turn slices, and
   * compaction checkpoints, hold the turn's whole canonical context.
   */
  function fullRowHistory(
    thread: NativeThreadRecord,
    first: NativeInputRecord,
    latest: NativeInputRecord,
    canonical: readonly StoredMessageV1[],
  ): ResultType<SelectedHistory, Error> {
    return Result.gen(function* () {
      const empty = { messages: [] as readonly StoredMessageV1[] };
      const snapshots = new Map<string, readonly StoredMessageV1[]>([
        [latest.requestId, canonical],
      ]);
      const pending: { messages: readonly StoredMessageV1[]; firstRequestId: string }[] = [];
      let turn = latest;
      let selectedTurn = first;
      let selected: SelectedHistory = empty;
      while (true) {
        let messages = snapshots.get(turn.requestId);
        if (!messages) {
          const snapshot = yield* (
            options.transcriptStore.getRequestTranscript?.({ requestId: turn.requestId }) ??
              Result.ok(null)
          );
          if (!snapshot) return Result.ok(empty);
          messages = snapshot.messages;
          snapshots.set(turn.requestId, messages);
        }
        const source = yield* canonicalSource(thread.id, turn);
        if (!source || source.position > turn.position) return Result.ok(empty);
        if (selectedTurn.position <= source.position) {
          selected = { messages, firstRequestId: source.requestId };
          break;
        }
        pending.push({ messages, firstRequestId: selectedTurn.requestId });
        const previous = yield* store.selectCanonicalInput(thread.id, {
          before: selectedTurn.position,
        });
        if (!previous) return Result.ok(empty);
        turn = previous;
        selectedTurn = source;
      }
      for (const boundary of pending.toReversed()) {
        if (
          !isDeepStrictEqual(
            boundary.messages.slice(0, selected.messages.length),
            selected.messages,
          )
        ) {
          if (thread.kind !== "dm") return Result.ok(empty);
          return directHistorySuffix(thread.id, first.position, canonical);
        }
        selected = {
          messages: boundary.messages.slice(selected.messages.length),
          firstRequestId: boundary.firstRequestId,
        };
      }
      return Result.ok(selected);
    });
  }

  /**
   * Rebuilds the canonical context that follows `latestRequestId`. Each native transcript row holds
   * one turn, so the context is the turns from the selected start through the latest one. A
   * full-history row ends the walk. Returns null when the latest turn's transcript is gone.
   */
  function selectedHistory(
    input: NativeInputRecord,
    latestRequestId: string,
    sessionAt: number,
  ): ResultType<SelectedHistory | null, Error> {
    return Result.gen(function* () {
      const empty = { messages: [] as readonly StoredMessageV1[] };
      const latest = yield* store.getInputByRequestId(latestRequestId);
      if (!latest)
        return Result.err(nativeFailure("invalid", "Canonical history has no retained turn"));
      const latestSnapshot = yield* (
        options.transcriptStore.getRequestTranscript?.({ requestId: latestRequestId }) ??
          Result.ok(null)
      );
      if (!latestSnapshot) return Result.ok(null);
      if (input.canonicalHistoryStartRequestId === input.requestId) return Result.ok(empty);
      const thread = yield* store.getThreadRecord(input.threadId);
      const first = input.canonicalHistoryStartRequestId
        ? yield* store.getInputByRequestId(input.canonicalHistoryStartRequestId)
        : yield* selectFirstInput(thread, sessionAt);
      if (!first) return Result.ok(empty);
      const source = yield* canonicalSource(input.threadId, latest);
      if (!source || source.position > latest.position) return Result.ok(empty);
      // The latest turn saw nothing before its own start, so neither does the next one.
      const start = first.position > source.position ? first : source;
      const turns: { requestId: string; messages: readonly StoredMessageV1[] }[] = [];
      let turn: NativeInputRecord | null = latest;
      let snapshot: TranscriptSnapshot | null = latestSnapshot;
      while (turn && turn.position >= start.position) {
        snapshot ??= yield* (
          options.transcriptStore.getRequestTranscript?.({ requestId: turn.requestId }) ??
            Result.ok(null)
        );
        if (!snapshot) return Result.ok(empty);
        if (snapshot.contextMeta || !opensNativeTurn(snapshot.messages[0], turn.requestId)) {
          const full = yield* fullRowHistory(thread, start, turn, snapshot.messages);
          // A full row that cannot reach `start` leaves no valid prefix for the later turns.
          if (full.messages.length === 0) return Result.ok(empty);
          turns.push({ requestId: full.firstRequestId ?? turn.requestId, ...full });
          break;
        }
        turns.push({ requestId: turn.requestId, messages: snapshot.messages });
        snapshot = null;
        turn =
          turn.position === start.position
            ? null
            : yield* store.selectCanonicalInput(input.threadId, { before: turn.position });
      }
      const earliest = turns.at(-1);
      if (!earliest) return Result.ok(empty);
      return Result.ok({
        messages: turns.toReversed().flatMap((selected) => selected.messages),
        firstRequestId: earliest.requestId,
      });
    });
  }

  function messageHeader(message: StoredMessageV1) {
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content.find((part) => part.type === "text")?.text ?? "");
    return parseSurfaceMetadataLine(text.split("\n")[0] ?? "");
  }

  function includeDeliveredPosts(input: NativeInputRecord, canonical: readonly StoredMessageV1[]) {
    return Result.gen(function* () {
      const thread = yield* store.getThreadRecord(input.threadId);
      if (thread.kind !== "dm") return Result.ok([...canonical]);
      const session = yield* store.selectSessionWindow(input.threadId, {
        gapMs: options.getDmContextGapMs?.() ?? DEFAULT_DM_CONTEXT_GAP_MS,
        at: input.createdAt,
        beforePosition: input.position,
        includePosts: true,
      });
      const history = canonical.filter((message) => {
        if (message.role !== "assistant" || session.firstAt === null) return true;
        const header = messageHeader(message);
        if (
          header?.meta.platform !== "native" ||
          header.meta.thread_id !== input.threadId ||
          typeof header.meta.message_time !== "string"
        )
          return true;
        return !(Date.parse(header.meta.message_time) < session.firstAt);
      });
      const knownIds = new Set(
        history.flatMap((message) => {
          const header = messageHeader(message);
          return header?.meta.thread_id === input.threadId &&
            typeof header.meta.message_id === "string"
            ? [header.meta.message_id]
            : [];
        }),
      );
      const anchors: { index: number; position: number }[] = [];
      for (const [index, message] of history.entries()) {
        if (message.role !== "user") continue;
        const header = messageHeader(message);
        if (header?.meta.platform !== "native" || header.meta.thread_id !== input.threadId)
          continue;
        const source = yield* store.getInputByRequestId(
          `native:${input.threadId}:${header.meta.message_id}`,
        );
        if (source) anchors.push({ index, position: source.position });
      }
      const hasSummary = history.some((message) => {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n");
        return text.startsWith("<context-compaction>");
      });
      const insertions = new Map<number, StoredMessageV1[]>();
      for (const turn of session.postedTurns) {
        if (hasSummary && turn.position < (anchors[0]?.position ?? input.position)) continue;
        for (const posted of turn.messages) {
          if (
            posted.role !== "assistant" ||
            posted.metadata?.inputId ||
            posted.id !== turn.turnId ||
            knownIds.has(posted.id)
          )
            continue;
          const content: Extract<StoredMessageV1, { role: "assistant" }>["content"] = [];
          const author = yield* store.getUser(posted.metadata?.authorId ?? "lilac");
          const text = posted.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("");
          content.push({
            type: "text",
            text: `${formatSurfaceMetadataLine({
              platform: "native",
              thread_id: input.threadId,
              user_id: author.id,
              user_name: author.displayName,
              message_id: posted.id,
              message_time: new Date(posted.metadata?.createdAt ?? session.latestAt).toISOString(),
            })}\n${escapeSurfaceMetadataTags(text)}`,
          });
          for (const part of posted.parts) {
            if (part.type !== "data-resource") continue;
            const upload = yield* store.getUpload(part.data.resourceId);
            if (upload.state !== "ready" || !upload.resourceUri) continue;
            yield* store.authorizeThread(thread.starterId, upload.threadId);
            content.push({
              type: "resource",
              uri: upload.resourceUri,
              filename: upload.filename,
              mediaType: upload.mediaType,
              size: upload.size,
            });
          }
          const index =
            anchors.find((anchor) => anchor.position > turn.position)?.index ?? history.length;
          const messages = insertions.get(index) ?? [];
          messages.push({ role: "assistant", content });
          insertions.set(index, messages);
        }
      }
      const messages = history.flatMap((message, index) => [
        ...(insertions.get(index) ?? []),
        message,
      ]);
      messages.push(...(insertions.get(history.length) ?? []));
      return Result.ok(messages);
    });
  }

  async function inputMessages(
    input: NativeInputRecord,
  ): Promise<ResultType<StoredMessageV1[], Error>> {
    return Result.gen(async function* () {
      const thread = yield* store.getThreadRecord(input.threadId);
      for (const skillId of input.skillIds) {
        if (!options.validateSkill?.(skillId, thread.starterId))
          return Result.err(nativeFailure("invalid", `Skill '${skillId}' is unavailable`));
      }
      const skillText = input.skillIds.map((skillId) => `Use the skill $${skillId}.`).join("\n");
      const author = yield* store.getUser(input.authorId);
      const header = formatSurfaceMetadataLine({
        platform: "native",
        thread_id: input.threadId,
        user_id: author.id,
        user_name: author.displayName || `user_${author.id}`,
        message_id: input.messageId,
        message_time: new Date(input.createdAt).toISOString(),
      });
      const expanded = options.expandReferences
        ? yield* Result.await(
            Promise.resolve(options.expandReferences(thread.starterId, input.text)),
          )
        : input.text;
      const cited = expandAssistantCitations(expanded);
      if (collectCitations(input.text).length && cited.length > CITATION_INPUT_LIMIT)
        return Result.err(
          nativeFailure("invalid", "Quoted input is too long. Shorten the quote or comment."),
        );
      const commandText =
        input.command?.id === "compact"
          ? "The user requested context compaction. Briefly acknowledge completion; do not resume earlier tasks."
          : cited;
      const dmInstruction =
        thread.kind === "dm"
          ? "This is an ongoing personal conversation that may span unrelated topics. Follow the latest message, use earlier messages when relevant, and treat completed requests as history. Ask briefly when a reference is ambiguous. Older conversation can be searched.\n\n"
          : "";
      const question = input.questionReply
        ? yield* store.readQuestion(
            input.initiatingUserId,
            input.threadId,
            input.questionReply.messageId,
          )
        : undefined;
      const questionContext = question
        ? `Reply to question ${question.questionCallId}:\n${JSON.stringify((question.prompts ?? []).map((prompt) => ({ header: prompt.header, question: prompt.question, options: prompt.options.map(({ index, label, description }) => ({ index, label, description })) })))}\n\n`
        : "";
      const body =
        dmInstruction +
        questionContext +
        (skillText ? `${skillText}\n\n${commandText}` : commandText);
      const text = `${header}\n${escapeSurfaceMetadataTags(body)}`;
      const parts: Extract<StoredMessageV1, { role: "user" }>["content"] = [{ type: "text", text }];
      for (const attachmentId of input.attachmentIds) {
        const attachment = yield* store.getUpload(attachmentId);
        if (attachment.state !== "ready" || !attachment.resourceUri)
          return Result.err(nativeFailure("conflict", "Attachment is not ready for model input"));
        yield* store.authorizeThread(thread.starterId, attachment.threadId);
        parts.push({
          type: "resource",
          uri: attachment.resourceUri,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          size: attachment.size,
        });
      }
      const message: StoredMessageV1 = { role: "user", content: parts };
      if (input.mode === "steer") return Result.ok([message]);
      const previousRequestId = yield* store.getLatestCanonicalRequestId(input.threadId);
      if (!previousRequestId) {
        yield* store.setInputCanonicalHistoryStart(input.id, input.requestId);
        const posts = yield* includeDeliveredPosts(input, []);
        return Result.ok([...posts, message]);
      }
      const history = yield* selectedHistory(input, previousRequestId, input.createdAt);
      if (!history)
        return Result.err(
          nativeFailure("conflict", "The retained canonical transcript is unavailable"),
        );
      yield* store.setInputCanonicalHistoryStart(
        input.id,
        history.messages.length > 0 ? (history.firstRequestId ?? input.requestId) : input.requestId,
      );
      const messages = yield* includeDeliveredPosts(input, history.messages);
      return Result.ok([...messages, message]);
    });
  }

  function commandMetadata(input: Pick<NativeInputRecord, "command">): ResultType<object, Error> {
    if (!input.command || input.command.id === "compact") return Result.ok({});
    const name = input.command.id.replace(/^custom:/u, "");
    const manager = options.customCommands;
    if (!manager?.get(name))
      return Result.err(nativeFailure("invalid", "Custom command is unavailable"));
    return manager
      .parseText(`/${CUSTOM_COMMAND_TEXT_PREFIX}${name} ${input.command.arguments}`)
      .mapError((error) => nativeFailure("invalid", error.message))
      .andThen((invocation) => {
        if (!invocation)
          return Result.err(nativeFailure("invalid", "Custom command could not be parsed"));
        return Result.ok({
          customCommand: {
            name,
            args: invocation.args,
            prompt: invocation.prompt ?? undefined,
            text: invocation.text,
            source: "text",
          },
        });
      });
  }

  async function publishInput(input: NativeInputRecord): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const thread = yield* store.getThreadRecord(input.threadId);
      const messages = yield* Result.await(inputMessages(input));
      const custom = yield* commandMetadata(input);
      const requestId = input.mode === "steer" ? input.runId : input.requestId;
      if (!input.turnId || !requestId)
        return Result.err(nativeFailure("invalid", "Native input has no admitted turn"));
      if (input.mode !== "steer" && thread.activeRunId !== requestId)
        yield* store.setActiveRun(input.threadId, input.historyGeneration, requestId);
      const prepared = yield* Result.await(
        prepareStoredMessagesForBus({ blobStore: options.blobStore, messages }),
      );
      const published = await options.bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          requestDeliveryId: input.deliveryId,
          queue: input.mode === "steer" ? "steer" : "prompt",
          messages: prepared.messages,
          ...(input.mode !== "steer" && input.modelId ? { modelOverride: input.modelId } : {}),
          raw: {
            native: {
              threadId: input.threadId,
              authorUserId: input.authorId,
              starterUserId: thread.starterId,
              turnId: input.turnId,
              historyGeneration: input.historyGeneration,
              compact: input.command?.id === "compact" || undefined,
              inputId: input.id,
              requestId,
              requestDeliveryId: input.deliveryId,
            },
            authenticatedActor: { platform: "native", userId: thread.starterId },
            authenticatedOrigin: {
              platform: "native",
              userId: thread.starterId,
              messageRef: {
                platform: "native",
                channelId: input.threadId,
                messageId: input.messageId,
              },
            },
            ...(input.mode === "steer" ? { requiresActive: true } : {}),
            ...custom,
          },
        },
        {
          headers: {
            request_id: requestId,
            session_id: nativeSessionId(input.threadId),
            request_client: "native",
          },
        },
      );
      const contractError = published.match({
        ok: () => undefined,
        err: (error) => (EventPublishContractInvalid.is(error) ? error : undefined),
      });
      if (contractError && options.blobStore)
        yield* Result.await(
          deleteDiscordRequestBlobHandles(options.blobStore, prepared.inputHandles).then(
            (cleanup) =>
              cleanup.mapError(
                (error) =>
                  new AggregateError(
                    [contractError, error],
                    "Native request validation and input handle cleanup failed",
                  ),
              ),
          ),
        );
      return published.map(() => undefined);
    });
  }

  async function publishPending(threadId: string): Promise<ResultType<void, Error>> {
    if (cancelingThreads.has(threadId)) return Result.ok(undefined);
    return Result.gen(async function* () {
      const pending = yield* store.listPendingInputs(threadId);
      options.metrics?.queue(
        threadId,
        pending.filter((input) => input.state === "uploading").length,
        pending.filter((input) => input.state === "queued").length,
        pending.filter((input) => input.state === "admitted").length,
      );
      for (const listed of pending) {
        const thread = yield* store.getThreadRecord(threadId);
        if (thread.mutationPending || thread.deleted) return Result.ok(undefined);
        let candidate = listed;
        if (listed.state === "admitted" && options.deliveryState) {
          const state = yield* options.deliveryState(listed.deliveryId);
          if (state === "owned") continue;
          // An automatic steer the runner abandoned is admitted below as a follow-up.
          const requeued = state === "abandoned" ? yield* store.requeueAutoSteer(listed.id) : null;
          if (requeued) candidate = requeued;
          // Any other steer the runner dropped missed its run, which a reader sees as target-ended.
          if (!requeued && state === "abandoned" && listed.mode === "steer") {
            yield* store.settleInput(listed.id, "target-ended");
            continue;
          }
          if (!requeued && state !== "missing") {
            yield* completeInput(listed, state === "abandoned" ? "failed" : state);
            continue;
          }
        }
        if (
          candidate.mode !== "steer" &&
          thread.activeRunId &&
          thread.activeRunId !== candidate.requestId
        )
          continue;
        const prepared = yield* store.prepareInput(candidate.id);
        if (!prepared) continue;
        const admitted = yield* store.settleInput(prepared.id, "admitted");
        const published = await publishInput(admitted);
        const failure = published.match({ ok: () => null, err: (error) => error });
        if (!failure) continue;
        options.metrics?.handoffFailure("admission", admitted.threadId, admitted.requestId);
        if (
          failure instanceof NativeStoreFailure &&
          (failure.code === "invalid" || failure.code === "forbidden")
        )
          yield* store.settleInput(admitted.id, "failed");
        return Result.err(failure);
      }
      return Result.ok(undefined);
    });
  }

  async function kick(threadId?: string): Promise<ResultType<void, Error>> {
    if (!accepting) return Result.ok(undefined);
    if (!threadId) {
      return Result.gen(async function* () {
        const pending = yield* store.listPendingInputs();
        for (const id of new Set(pending.map((input) => input.threadId)))
          yield* Result.await(kick(id));
        return Result.ok(undefined);
      });
    }
    const existing = publications.get(threadId);
    if (existing) {
      return Result.gen(async function* () {
        yield* Result.await(existing);
        yield* Result.await(kick(threadId));
        return Result.ok(undefined);
      });
    }
    const operation = publishPending(threadId);
    publications.set(threadId, operation);
    const result = await operation;
    publications.delete(threadId);
    return result;
  }

  function completeInput(
    input: NativeInputRecord,
    outcome: "completed" | "failed" | "cancelled",
  ): ResultType<void, Error> {
    return Result.gen(function* () {
      const thread = yield* store.getThreadRecord(input.threadId);
      if (thread.historyGeneration !== input.historyGeneration || thread.mutationPending)
        return Result.ok(undefined);
      if (outcome === "cancelled") yield* store.settleInput(input.id, "canceled");
      const requestId = input.mode === "steer" ? input.runId : input.requestId;
      const transcript = requestId
        ? yield* options.transcriptStore.getRequestTranscript?.({ requestId }) ?? Result.ok(null)
        : null;
      if (transcript) yield* store.markInputCompleted(input.id);
      if (!transcript && outcome === "failed") yield* store.settleInput(input.id, "failed");
      if (input.mode !== "steer" && thread.activeRunId === input.requestId)
        yield* store.setActiveRun(input.threadId, input.historyGeneration, undefined);
      return Result.ok(undefined);
    });
  }

  async function settled(
    request: NativeRunnerRequest,
    outcome: "completed" | "failed" | "cancelled",
  ): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const native = parseNativeRequestEnvelope(request);
      if (!native)
        return Result.err(nativeFailure("invalid", "Settled native request metadata is invalid"));
      const input = yield* store.getInput(native.inputId);
      yield* completeInput(input, outcome);
      activeCompactions.delete(input.requestId);
      yield* Result.await(kick(native.threadId));
      return Result.ok(undefined);
    });
  }

  async function rejected(deliveryId: string): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const input = yield* store.getInputByDeliveryId(deliveryId);
      if (!input || input.state === "target-ended") return Result.ok(undefined);
      yield* completeInput(input, "cancelled");
      activeCompactions.delete(input.requestId);
      yield* Result.await(kick(input.threadId));
      return Result.ok(undefined);
    });
  }

  async function cancel(
    actorId: string,
    threadId: string,
    runId?: string,
  ): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const runner = options.runner();
      if (!runner) return Result.err(nativeFailure("conflict", "Native runner is unavailable"));
      yield* store.cancelRun(actorId, threadId, runId);
      cancelingThreads.add(threadId);
      const canceled = await runner.cancelNativeSession(nativeSessionId(threadId));
      cancelingThreads.delete(threadId);
      yield* canceled;
      yield* Result.await(kick(threadId));
      return Result.ok(undefined);
    });
  }

  function reconcileCanonical(threadId: string): ResultType<void, Error> {
    return Result.gen(function* () {
      const requestIds = yield* store.listCanonicalRequestIds(threadId);
      yield* (
        options.transcriptStore.reconcileNativeTranscriptReferences?.({
          sessionId: nativeSessionId(threadId),
          requestIds,
        }) ?? Result.ok(undefined)
      );
      return Result.ok(undefined);
    });
  }

  async function rewind(
    actorId: string,
    request: {
      threadId: string;
      commandId: string;
      turnId: string;
      historyGeneration: number;
      revision: number;
    },
  ): Promise<ResultType<{ text: string; historyGeneration: number }, Error>> {
    return Result.gen(async function* () {
      const rewound = yield* store.beginRewind(actorId, request);
      const runner = options.runner();
      if (!runner) return Result.err(nativeFailure("conflict", "Native runner is unavailable"));
      yield* Result.await(runner.cancelNativeSession(nativeSessionId(request.threadId)));
      const rewindCutoff = yield* store.getTurnInputCreatedAt(request.threadId, request.turnId);
      if (rewindCutoff !== null)
        await options.jobs?.stopSessionJobsSince(
          nativeSessionId(request.threadId),
          rewindCutoff,
          "thread_rewound",
        );
      if (rewound.historyGeneration === undefined || rewound.text === undefined)
        return Result.err(nativeFailure("invalid", "Rewind receipt is incomplete"));
      yield* reconcileCanonical(request.threadId);
      yield* store.finishMutation(request.threadId, rewound.historyGeneration);
      return Result.ok({ text: rewound.text, historyGeneration: rewound.historyGeneration });
    });
  }

  async function deleteThread(
    actorId: string,
    request: { threadId: string; commandId: string; historyGeneration?: number },
  ): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const deleted = yield* store.deleteThread(actorId, request);
      const runner = options.runner();
      if (!runner) return Result.err(nativeFailure("conflict", "Native runner is unavailable"));
      yield* Result.await(runner.cancelNativeSession(nativeSessionId(request.threadId)));
      await options.jobs?.stopSession(nativeSessionId(request.threadId), "thread_deleted");
      if (deleted.historyGeneration === undefined)
        return Result.err(nativeFailure("invalid", "Deletion receipt is incomplete"));
      yield* reconcileCanonical(request.threadId);
      yield* store.finishMutation(request.threadId, deleted.historyGeneration);
      return Result.ok(undefined);
    });
  }

  async function recoverMutations(): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const pending = yield* store.listPendingMutations();
      const runner = options.runner();
      if (!runner && pending.length)
        return Result.err(nativeFailure("conflict", "Native runner is unavailable"));
      for (const thread of pending) {
        if (runner) yield* Result.await(runner.cancelNativeSession(nativeSessionId(thread.id)));
        yield* reconcileCanonical(thread.id);
        yield* store.finishMutation(thread.id, thread.historyGeneration);
      }
      return Result.ok(undefined);
    });
  }

  async function drainPublications(): Promise<ResultType<void, Error>> {
    accepting = false;
    return Result.all(await Promise.all(publications.values())).map(() => undefined);
  }

  function canonicalContext(actorId: string, threadId: string) {
    return Result.gen(function* () {
      const thread = yield* store.authorizeThread(actorId, threadId);
      const evaluatedAt = options.now?.() ?? Date.now();
      const latestId = yield* store.getLatestCanonicalRequestId(threadId);
      const empty = {
        historyGeneration: thread.historyGeneration,
        evaluatedAt,
        firstTurnPosition: null,
        hasSummary: false,
        active: !!thread.activeRunId,
      };
      if (!latestId) return Result.ok(empty);
      const latest = yield* store.getInputByRequestId(latestId);
      if (!latest) return Result.ok(empty);
      const active = thread.activeRunId
        ? yield* store.getInputByRequestId(thread.activeRunId)
        : null;
      const selector = active ?? {
        ...latest,
        requestId: "preview",
        canonicalHistoryStartRequestId: undefined,
      };
      const history = yield* selectedHistory(selector, latestId, active?.createdAt ?? evaluatedAt);
      if (!history) return Result.ok(empty);
      if (active?.turnId && active.canonicalHistoryStartRequestId === active.requestId)
        return Result.ok({
          ...empty,
          firstTurnPosition: yield* store.getTurnPosition(active.turnId),
        });
      if (!history.firstRequestId) return Result.ok(empty);
      const first = yield* store.getInputByRequestId(history.firstRequestId);
      if (!first?.turnId) return Result.ok(empty);
      const firstTurnPosition = yield* store.getTurnPosition(first.turnId);
      const currentMessages = active ? activeCompactions.get(active.requestId) : undefined;
      const texts = (currentMessages ?? history.messages).flatMap((message) => {
        if (message.role !== "user") return [];
        if (typeof message.content === "string") return [message.content];
        return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
      });
      const hasSummary = texts.some((text) => text.startsWith("<context-compaction>"));
      const directHeader = hasSummary
        ? texts
            .map((text) => parseSurfaceMetadataLine(text.split("\n")[0] ?? ""))
            .find(
              (header) => header?.meta.platform === "native" && header.meta.thread_id === threadId,
            )
        : undefined;
      const directInput = directHeader?.meta.message_id
        ? yield* store.getInputByRequestId(`native:${threadId}:${directHeader.meta.message_id}`)
        : null;
      const summarizedBeforePosition = directInput?.turnId
        ? yield* store.getTurnPosition(directInput.turnId)
        : undefined;
      return Result.ok({
        ...empty,
        firstTurnPosition,
        hasSummary,
        summarizedBeforePosition,
        expiresAt: active ? undefined : contextExpiry(thread, first, latest, evaluatedAt),
      });
    });
  }

  function context(actorId: string, threadId: string) {
    return Result.gen(function* () {
      const result = yield* canonicalContext(actorId, threadId);
      const thread = yield* store.authorizeThread(actorId, threadId);
      if (thread.kind !== "dm") return Result.ok(result);
      const active = thread.activeRunId
        ? yield* store.getInputByRequestId(thread.activeRunId)
        : null;
      const gapMs = options.getDmContextGapMs?.() ?? DEFAULT_DM_CONTEXT_GAP_MS;
      const session = yield* store.selectSessionWindow(threadId, {
        gapMs,
        at: active?.createdAt ?? result.evaluatedAt,
        beforePosition: active ? active.position + 1 : undefined,
      });
      return Result.ok({
        ...result,
        firstTurnPosition: session.firstPosition,
        expiresAt:
          active || session.firstPosition === null ? undefined : session.latestAt + gapMs + 1,
      });
    });
  }

  function dmContextExpiry(latest: NativeInputRecord, evaluatedAt: number): number {
    const gapMs = options.getDmContextGapMs?.() ?? DEFAULT_DM_CONTEXT_GAP_MS;
    return Math.max(evaluatedAt + 1, (latest.completedAt ?? evaluatedAt) + gapMs + 1);
  }

  function contextExpiry(
    thread: NativeThreadRecord,
    first: NativeInputRecord,
    latest: NativeInputRecord,
    evaluatedAt: number,
  ): number | undefined {
    if (thread.kind === "dm") return dmContextExpiry(latest, evaluatedAt);
    const maxAgeMs = options.getOldMessageSelectionMaxAgeMs?.();
    if (maxAgeMs === undefined) return undefined;
    return Math.max(evaluatedAt + 1, first.createdAt + maxAgeMs + 1);
  }

  function validateCommand(input: Pick<NativeInputRecord, "command">): ResultType<void, Error> {
    return commandMetadata(input).map(() => undefined);
  }

  return {
    context,
    validateCommand,
    drainPublications,
    kick,
    cancel,
    rewind,
    deleteThread,
    recoverMutations,
    runnerLifecycle: {
      validate,
      settled,
      rejected,
      compacted(requestId: string, messages: readonly ModelMessage[]) {
        activeCompactions.set(requestId, messages);
      },
      waiting(request: Pick<NativeRunnerRequest, "requestId" | "raw">, waiting: boolean) {
        const native = parseNativeRequestEnvelope(request);
        if (native) store.setRunWaiting(native.threadId, request.requestId, waiting);
      },
    } satisfies NativeRunnerLifecycle,
  };
}

export type NativeExecution = ReturnType<typeof createNativeExecution>;
