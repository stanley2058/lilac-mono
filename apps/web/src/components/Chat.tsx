import type { ModelReasoning } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import { RecentContextProvider } from "./RecentContext";
import { currentPushDeviceId } from "../push-device";
import { watchReadLifecycle } from "../read-lifecycle";
import { rewindDraft } from "../rewind-draft";
import type { OptimisticTurn } from "../optimistic-turns";
import { useEventCallback } from "../use-event-callback";
import { useStore } from "zustand";
import { draftAttachment, releaseDraftAttachments, type DraftThread } from "../draft-thread";
import type { ActorIdentity } from "./ActorAvatar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  participantOptions,
  composerDraftOptions,
  updateComposerDraft,
  pendingQuestionsOptions,
  loadComposerDraft,
  queueOptions,
  refreshQueue as refreshQueueQuery,
  useNativeOnline,
  queryNativeRPC,
} from "../queries";
import { MessageIdentityContext } from "./message-identity";
import { ConversationWelcome } from "./ConversationWelcome";
import {
  QuestionReplyContext,
  type QuestionReplyView,
  type QuestionServices,
} from "./message-services";
import {
  activeReplyQuestion,
  answerLabel,
  answerPlaceholder,
  answerableQuestions,
  autoReplyQuestion,
  emptyProgress,
  nextPromptStep,
  promptAnswered,
  questionDraftKey,
  questionPrompts,
  questionReplyStore,
  questionReplyTarget,
  questionSignature,
  questionSlotsChanged,
  mergeClosedReply,
  replyProgressKey,
  replyText,
  type ProgressChange,
  type PromptAnswer,
} from "../question-reply";
import { QuestionPanel, QuestionWaiting } from "./QuestionReply";
import { composerSubmissionMarkdown, createComposerEditor } from "./composer-document";
import { useWorkspace } from "../workspace-context";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RotateCcw } from "lucide-react";
import type {
  NativeInput,
  NativeInputReceipt,
  NativeQuestion,
  QueuedInput,
  DisplayPart,
  NativeThread,
  ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";
import type { ChatCommon, ComposerSubmission } from "../types";
import { resolveAttachmentIds } from "../uploads";
import { inputDeliveryOptions } from "../input-mode";
import { deliverPendingInput, type PendingInput } from "../pending-input";
import { pendingTurnSlot } from "../pending-message";
export type { PendingInput } from "../pending-input";
import { Button } from "./ui/button";
import { Composer, type ComposerProps } from "./Composer";
import { ConversationStatus } from "./ConversationStatus";
import { Timeline, useLatestReadableTurn } from "./Timeline";
import { QueuedMessage, QueuedMessages } from "./QueuedMessage";
import type { OutlineSource } from "../timeline-outline";
import { attempt, Modal } from "./ui";
import { toast } from "./ui/toast";
import { isConnectionFailure } from "../connection-lifecycle";

import { UploadProgressContext } from "../upload-context";

const queueLabels: Record<ComposerSubmission["mode"], string> = {
  steer: "Steering",
  followup: "Follow-up",
};
export type Draft = {
  text: string;
  skillIds: string[];
  commandId?: string;
  attachments: string[];
  savedText?: string;
};
// The compiler cannot memoize a component that contains `import()`.
const loadComposerEditor = () => import("./composer-editor");
const emptyDraft: Draft = { text: "", skillIds: [], attachments: [] };
/** What the conversation needs from a draft. Typing changes only the text, which the composer reads. */
type DraftSummary = Omit<Draft, "text"> & { hasText: boolean };
const summarizeDraft = ({ text, ...draft }: Draft): DraftSummary => ({
  ...draft,
  hasText: !!text.trim(),
});
const emptySummary = summarizeDraft(emptyDraft);
const noPrompts: ReturnType<typeof questionPrompts> = [];
const draftText = (draft: Draft) => draft.text;
export type ChatProps = Pick<ChatCommon, "catalog" | "onError"> & {
  threadId: string;
  thread?: NativeThread;
  loadError?: string;
  onRetryLoad: () => void;
  onLocalChange: (id: string, update: (thread: DraftThread) => DraftThread) => void;
  onLocalSubmit: (id: string, submission: ComposerSubmission) => void;
  header: ReactNode;
  draft?: Draft;
  onDraft: (id: string, draft: Draft) => void;
  readTurns: Map<string, string>;
  pending: PendingInput[];
  onPending: (id: string, update: (pending: PendingInput[]) => PendingInput[]) => void;
  foreground: boolean;
  autoFocus?: boolean;
};

export function Chat(props: ChatProps) {
  const {
    client,
    pool,
    scope,
    upload,
    resourceUrl,
    draftCache,
    drafts: draftStore,
  } = useWorkspace();
  const { thread, threadId } = props;
  const local = threadId.startsWith("draft:");
  const localThread = useStore(draftStore, (state) => state.localDrafts.get(threadId));
  const editable = local ? !!localThread : !!thread?.capabilities.edit;
  const queries = useQueryClient();
  const identity = useContext(MessageIdentityContext);
  const online = useNativeOnline(client);
  const hasThread = !!thread;
  const outline = useMemo<OutlineSource | undefined>(() => {
    if (local || !hasThread) return undefined;
    return {
      online,
      page: (beforePosition, signal) =>
        queryNativeRPC(client, (rpc) =>
          rpc.threads.outline(
            beforePosition === undefined ? { threadId } : { threadId, beforePosition },
            { signal },
          ),
        ),
      previews: (input, signal) =>
        queryNativeRPC(client, (rpc) =>
          rpc.threads.outlinePreviews({ threadId, ...input }, { signal }),
        ),
    };
  }, [local, hasThread, online, client, threadId]);
  const pendingQuestions = useQuery({
    ...pendingQuestionsOptions(client, threadId),
    enabled: online && !local,
  });
  const inFlightReplies = props.pending
    .flatMap((entry) =>
      entry.state !== "rejected" && entry.submission.questionReply
        ? [entry.submission.questionReply.messageId]
        : [],
    )
    .join("\n");
  const answerable = useMemo(
    () =>
      editable
        ? answerableQuestions(pendingQuestions.data, identity.viewerId).filter(
            (question) => !inFlightReplies.split("\n").includes(question.questionCallId),
          )
        : [],
    [editable, pendingQuestions.data, identity.viewerId, inFlightReplies],
  );
  const replyChoice = useStore(questionReplyStore, (state) => state.choices.get(threadId));
  const replyQuestion = activeReplyQuestion(answerable, replyChoice);
  const replyMessageId = replyQuestion?.questionCallId;
  const replyPrompts = replyQuestion ? questionPrompts(replyQuestion) : noPrompts;
  const progressKey = replyMessageId ? replyProgressKey(threadId, replyMessageId) : "";
  const progress = useStore(
    questionReplyStore,
    (state) => state.progress.get(progressKey) ?? emptyProgress,
  );
  const replyStep = Math.min(progress.step, Math.max(replyPrompts.length - 1, 0));
  const replyPrompt = replyPrompts[replyStep];
  const draftKey =
    replyMessageId && replyPrompt
      ? questionDraftKey(threadId, replyMessageId, replyPrompt.ordinal)
      : threadId;
  const draftOptions = composerDraftOptions(scope, draftKey, draftCache);
  // Draft writes wait for a pause in typing; leaving the conversation writes them now.
  useEffect(() => () => void draftCache?.flushDrafts?.(), [draftCache, threadId]);
  const draftInitialData = draftKey === threadId ? props.draft : undefined;
  const draftQuery = useQuery({
    ...draftOptions,
    initialData: draftInitialData,
    enabled: !local,
    select: summarizeDraft,
  });
  const draft = localThread ? summarizeDraft(localThread.draft) : (draftQuery.data ?? emptySummary);
  const draftLoaded = local ? !!localThread : !draftQuery.isPending;
  const draftSource = { local, threadId, options: draftOptions, initialData: draftInitialData };
  const [view, setView] = useState<{
    id: string;
    error?: string;
    historyError?: string;
    rewindTarget?: string;
    rewinding?: boolean;
    latestVisible?: boolean;
    unknownAuthor?: string;
  }>({ id: threadId });
  if (view.id !== threadId) setView({ id: threadId });
  const updateView = useCallback(
    (patch: Partial<Omit<typeof view, "id">>) => {
      setView((current) => {
        if (current.id !== threadId) return current;
        if (
          Object.entries(patch).every(
            ([key, value]) => current[key as keyof typeof current] === value,
          )
        )
          return current;
        return { ...current, ...patch };
      });
    },
    [threadId],
  );
  const setError = useCallback((error?: string) => updateView({ error }), [updateView]);
  const setHistoryError = useCallback(
    (historyError?: string) => updateView({ historyError }),
    [updateView],
  );
  const setRewindTarget = useCallback(
    (rewindTarget?: string) => updateView({ rewindTarget }),
    [updateView],
  );
  const setRewinding = (rewinding: boolean) => updateView({ rewinding });
  const setLatestVisible = useCallback(
    (latestVisible: boolean) => updateView({ latestVisible }),
    [updateView],
  );
  const { error, historyError, rewindTarget, rewinding, latestVisible, unknownAuthor } =
    view.id === threadId ? view : {};
  const currentId = useRef(threadId);
  const getDraft = (key = draftKey) =>
    local
      ? (draftStore.getState().localDrafts.get(threadId)?.draft ?? emptyDraft)
      : (queries.getQueryData(composerDraftOptions(scope, key, draftCache).queryKey) ?? emptyDraft);
  const commitDraft = (value: Draft, key = draftKey) => {
    if (local) {
      props.onLocalChange(threadId, (current) => ({ ...current, draft: value }));
      return;
    }
    updateComposerDraft(queries, key, value);
    if (key === threadId) props.onDraft(threadId, value);
    if (draftCache) void attempt(() => draftCache.saveDraft(scope, key, value), setError);
  };
  // Answered or closed question drafts are never shown again, so their saved row and cached query go.
  const removeQuestionDraft = (key: string) => {
    commitDraft(emptyDraft, key);
    queries.removeQueries({
      queryKey: composerDraftOptions(scope, key, draftCache).queryKey,
      exact: true,
    });
  };
  const pendingEntries = props.pending;
  const commitPending = (update: (entries: PendingInput[]) => PendingInput[]) =>
    props.onPending(threadId, update);
  const store = client.thread(threadId);
  const subscribeHistory = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const historySnapshot = useCallback(() => !!store.checkpoint, [store]);
  const historyLoaded = useSyncExternalStore(subscribeHistory, historySnapshot, historySnapshot);
  const readableTurnId = useLatestReadableTurn(store);
  const sendingEntry = localThread?.sending
    ? localThread.creation?.entry
    : pendingEntries.find((entry) => entry.state === "preparing" || entry.state === "accepted");
  const activeTurnSnapshot = useCallback(() => {
    const slot = store.at(store.size - 1);
    return slot?.kind === "ready" && (slot.state === "pending" || slot.state === "running");
  }, [store]);
  const activeTurn = useSyncExternalStore(subscribeHistory, activeTurnSnapshot, activeTurnSnapshot);
  const serverActive = !!thread?.activeRunId || activeTurn;
  const active = serverActive || !!sendingEntry;
  const previousActive = useRef(active);
  const canEdit = useRef(editable);
  // Async sends compare against the conversation and permission that are on screen now.
  useLayoutEffect(() => {
    currentId.current = threadId;
    canEdit.current = editable;
  });
  const participants = useQuery({
    ...participantOptions(client, threadId),
    enabled: online && !local,
  });
  const setUnknownAuthor = useCallback(
    (unknownAuthor: string) => updateView({ unknownAuthor }),
    [updateView],
  );
  useEffect(() => {
    if (!local && unknownAuthor)
      void queries.invalidateQueries({ queryKey: ["participants", threadId] });
  }, [queries, threadId, unknownAuthor, local]);
  const identities = useMemo(() => {
    const users = new Map<string, ActorIdentity>(
      participants.data?.items.map(({ user }) => [
        user.id,
        { displayName: user.displayName, avatarUrl: user.avatarUrl },
      ]),
    );
    const viewer = identity.viewerId ? identity.users.get(identity.viewerId) : undefined;
    if (identity.viewerId && viewer) users.set(identity.viewerId, viewer);
    return {
      agent: identity.agent,
      viewerId: identity.viewerId,
      users,
      onUnknownAuthor: participants.data ? setUnknownAuthor : undefined,
    };
  }, [identity, participants.data, setUnknownAuthor]);
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.kind === "connection" && event.state === "online") setHistoryError(undefined);
        if (event.kind === "error" && event.error.kind !== "network" && !store.checkpoint)
          setHistoryError(event.error.message);
      }),
    [client, store],
  );
  const queueQuery = useQuery({
    ...queueOptions(client, threadId),
    enabled: online && !local && editable,
  });
  const queuedItems = editable ? (queueQuery.data?.items ?? []) : [];
  const queue = queuedItems.filter((entry) => entry.mode !== "prompt");
  // A steer or a prompt with a turn already shows in the timeline. The rest wait after the last
  // turn, such as a prompt held behind an earlier input that is still uploading.
  const queuedWithoutTurn = queuedItems.filter((entry) => entry.mode !== "steer" && !entry.turnId);
  const subscribe = useCallback(
    (listener: () => void) => pool.subscribe(threadId, listener),
    [pool, threadId],
  );
  const snapshot = useCallback(() => pool.get(threadId), [pool, threadId]);
  const uploads = useSyncExternalStore(subscribe, snapshot, snapshot);
  const uploadProgress = useMemo(() => ({ pool, threadId }), [pool, threadId]);
  const pendingAttachments = useMemo(
    () =>
      sendingEntry?.submission.attachments.map(
        (attachment) => uploads.find((upload) => upload.key === attachment.key) ?? attachment,
      ) ?? [],
    [sendingEntry, uploads],
  );
  const messageResourceUrl = useCallback(
    (id: string) =>
      pendingAttachments.find((attachment) => (attachment.resourceId ?? attachment.key) === id)
        ?.preview ?? resourceUrl(id),
    [pendingAttachments, resourceUrl],
  );
  const pendingTurn = useMemo<ReadyTurnSlot | undefined>(() => {
    if (!sendingEntry || (!sendingEntry.optimisticSlotIds && serverActive)) return;
    return pendingTurnSlot(sendingEntry, pendingAttachments, store.size, scope.principalId);
  }, [sendingEntry, pendingAttachments, serverActive, scope.principalId, store]);
  const optimisticTurn = useMemo<OptimisticTurn | undefined>(() => {
    if (!pendingTurn || !sendingEntry) return;
    return {
      slot: pendingTurn,
      precedingSlotIds: sendingEntry.optimisticSlotIds ?? store.slotIds,
      confirmedSlotId: sendingEntry.receipt?.turnId,
    };
  }, [pendingTurn, sendingEntry, store]);
  const resolveOptimistic = useEventCallback(() => {
    if (!sendingEntry?.receipt) return;
    for (const attachment of sendingEntry.submission.attachments)
      pool.release(threadId, attachment.key);
    commitPending((entries) =>
      entries.filter((entry) => entry.commandId !== sendingEntry.commandId),
    );
  });
  const visiblePendingEntries = pendingEntries.filter(
    (entry) => entry.commandId !== sendingEntry?.commandId || !pendingTurn,
  );

  useEffect(() => {
    if (!editable) setRewindTarget(undefined);
  }, [editable]);
  const recoveryUpload = useCallback(
    (resourceId: string, file: File, onProgress: (fraction: number) => void) =>
      upload(resourceId, file, onProgress, pool.signal),
    [upload, pool],
  );
  const attachments = useMemo(
    () =>
      localThread?.attachments ??
      uploads.filter((attachment) => draft.attachments.includes(attachment.key)),
    [localThread?.attachments, uploads, draft.attachments],
  );
  const refreshQueue = useCallback(() => refreshQueueQuery(queries, threadId), [queries, threadId]);
  useEffect(() => {
    if (queueQuery.error && client.connectionState === "online") setError(queueQuery.error.message);
  }, [client, queueQuery.error]);
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.kind === "input" && event.threadId === threadId) void refreshQueue();
      }),
    [client, threadId, refreshQueue],
  );
  useEffect(() => {
    if (local) return;
    const refresh = () =>
      void queries.invalidateQueries({
        queryKey: pendingQuestionsOptions(client, threadId).queryKey,
        exact: true,
      });
    const seen = new Map(store.slotIds.map((id) => [id, questionSignature(store.get(id))]));
    const stopStore = store.subscribe((change) => {
      if (questionSlotsChanged(seen, change.slotIds, (id) => store.get(id))) refresh();
    });
    const stopClient = client.subscribe((event) => {
      if (event.kind === "connection" && event.state === "online") refresh();
      if (event.kind === "input" && event.threadId === threadId) refresh();
    });
    return () => {
      stopStore();
      stopClient();
    };
  }, [client, store, threadId, local, queries]);
  const regularDraftEmpty =
    draftKey === threadId ? !draft.hasText && !draft.attachments.length : false;
  const autoReply = draftLoaded
    ? autoReplyQuestion(answerable, replyChoice, regularDraftEmpty)
    : undefined;
  const chooseReply = (messageId: string, replying: boolean) =>
    questionReplyStore.getState().choose(threadId, { messageId, replying });
  useEffect(() => {
    if (autoReply) chooseReply(autoReply, true);
  }, [autoReply, threadId]);
  const previousReply = useRef<{ threadId: string; messageId: string; ordinals: number[] }>(
    undefined,
  );
  useEffect(() => {
    const previous = previousReply.current;
    previousReply.current = replyMessageId
      ? { threadId, messageId: replyMessageId, ordinals: replyPrompts.map((item) => item.ordinal) }
      : undefined;
    if (!previous || previous.threadId !== threadId || previous.messageId === replyMessageId)
      return;
    if (pendingQuestions.data?.some((item) => item.questionCallId === previous.messageId)) return;
    questionReplyStore
      .getState()
      .update(replyProgressKey(threadId, previous.messageId), () => undefined);
    // The question closed elsewhere, so unsent typed answers move to the regular draft.
    let moved = false;
    for (const ordinal of previous.ordinals) {
      const key = questionDraftKey(threadId, previous.messageId, ordinal);
      const leftover = getDraft(key);
      removeQuestionDraft(key);
      if (!leftover.text.trim() && !leftover.attachments.length && !leftover.skillIds.length)
        continue;
      commitDraft(mergeClosedReply(getDraft(threadId), leftover), threadId);
      moved = true;
    }
    if (moved) toast.add({ title: "The question closed. Your reply is now a regular draft." });
  }, [replyMessageId, threadId]);
  useEffect(() => {
    const changed = previousActive.current !== active;
    previousActive.current = active;
    if (changed) void refreshQueue();
  }, [active, refreshQueue]);
  useEffect(() => {
    if (local || !props.foreground || !readableTurnId || !latestVisible || active) return;
    const turnId = readableTurnId;
    return watchReadLifecycle(client, async () => {
      if (props.readTurns.get(threadId) === turnId) return true;
      const rpc = client.rpc;
      if (!rpc) return false;
      const result = await attempt(() => rpc.threads.markRead({ threadId, turnId }), setError);
      if (!result) return false;
      props.readTurns.set(threadId, turnId);
      return true;
    });
  }, [
    client,
    threadId,
    local,
    active,
    latestVisible,
    readableTurnId,
    props.readTurns,
    props.foreground,
  ]);

  const setPending = (commandId: string, patch: Partial<PendingInput> | null) => {
    commitPending((entries) =>
      patch
        ? entries.map((entry) => (entry.commandId === commandId ? { ...entry, ...patch } : entry))
        : entries.filter((entry) => entry.commandId !== commandId),
    );
  };
  async function prepareInput(
    entry: PendingInput,
    retryFailed: boolean,
  ): Promise<NativeInput | undefined> {
    const [ids, { resolveComposerAttachments }] = await Promise.all([
      resolveAttachmentIds(pool, threadId, entry.submission.attachments, retryFailed),
      loadComposerEditor(),
    ]);
    if (currentId.current === threadId && !canEdit.current) {
      setPending(entry.commandId, {
        state: "rejected",
        error: "You no longer have permission to send to this conversation.",
      });
      return;
    }
    if (ids.some((id) => !id)) {
      setPending(entry.commandId, {
        state: "rejected",
        error: "A file could not be prepared. Retry this message to retry its upload.",
      });
      return;
    }
    const checkpoint = store.checkpoint;
    if (!checkpoint) {
      setPending(entry.commandId, {
        state: "rejected",
        error: "Connect to this thread before sending",
      });
      return;
    }
    const questionReply = entry.submission.questionReply;
    if (questionReply && !(await questionStillOpen(questionReply))) {
      setPending(entry.commandId, {
        state: "rejected",
        error: "This question closed before your answer arrived.",
        submission: { ...entry.submission, questionReply: undefined },
        questionClosed: true,
      });
      return;
    }
    return {
      threadId: threadId,
      commandId: entry.commandId,
      historyGeneration: checkpoint.historyGeneration,
      deviceId: await currentPushDeviceId(),
      text: entry.submission.attachmentText
        ? resolveComposerAttachments(
            entry.submission.attachmentText,
            new Map(
              entry.submission.attachments.map((attachment, index) => [
                attachment.key,
                ids[index]!,
              ]),
            ),
          )
        : entry.text,
      ...inputDeliveryOptions(
        serverActive,
        entry.submission.mode,
        entry.submission.modelId,
        !!entry.submission.command,
      ),
      reasoning:
        serverActive && entry.submission.mode === "steer" ? undefined : entry.submission.reasoning,
      attachmentIds: ids.filter((id): id is string => !!id),
      skillIds: entry.submission.skillIds,
      command: entry.submission.command,
      ...(questionReply ? { questionReply } : {}),
    };
  }
  async function questionStillOpen(target: { messageId: string; token: string }) {
    const fetched = await Result.tryPromise({
      try: () => queries.query({ ...pendingQuestionsOptions(client, threadId), staleTime: 0 }),
      catch: () => undefined,
    });
    // Without a fresh list the server still rejects a stale token, so let it decide.
    const questions = fetched.match({ ok: (value) => value, err: () => undefined });
    if (!questions) return true;
    return questions.some(
      (question) =>
        question.questionCallId === target.messageId &&
        questionReplyTarget(question)?.token === target.token,
    );
  }
  async function deliver(entry: PendingInput, retryFailed = false) {
    let awaitingProjection = false;
    let sent: NativeInput | undefined;
    const outcome = await deliverPendingInput(
      entry,
      () => prepareInput(entry, retryFailed),
      (input) => client.submit(input),
      (patch) => {
        awaitingProjection = patch?.state === "accepted";
        if (patch?.input) sent = patch.input;
        setPending(entry.commandId, patch);
      },
      currentId.current !== threadId || canEdit.current,
    );
    if (outcome?.kind !== "accepted") return;
    if (sent) showQueued(sent, outcome.receipt);
    if (!awaitingProjection)
      for (const attachment of entry.submission.attachments) pool.release(threadId, attachment.key);
    void refreshQueue();
  }
  /** Puts an accepted input without a turn in the queue right away, so it does not vanish until the refetch. */
  function showQueued(input: NativeInput, receipt: NativeInputReceipt) {
    if (receipt.turnId || receipt.state === "admitted") return;
    // The server keeps a steer a steer during a run and admits other input during a run as a follow-up.
    if (receipt.runId && input.mode === "steer") return;
    const item: QueuedInput = {
      ...receipt,
      authorId: scope.principalId,
      text: input.text.slice(0, 4096),
      mode: receipt.runId ? "followup" : "prompt",
      createdAt: Date.now(),
    };
    queries.setQueryData(queueOptions(client, threadId).queryKey, (current) =>
      current?.items.some((entry) => entry.inputId === receipt.inputId)
        ? current
        : { items: [...(current?.items ?? []), item] },
    );
  }
  function retryPending(entry: PendingInput) {
    void deliver(
      {
        ...entry,
        submission: {
          ...entry.submission,
          attachments: entry.submission.attachments.map(
            (attachment) =>
              uploads.find((candidate) => candidate.key === attachment.key) ?? attachment,
          ),
        },
      },
      true,
    );
  }
  function discardPending(entry: PendingInput) {
    for (const attachment of entry.submission.attachments) pool.release(threadId, attachment.key);
    setPending(entry.commandId, null);
  }
  function removeQueued(inputId: string) {
    const checkpoint = store.checkpoint;
    if (!client.rpc || !checkpoint) return;
    void attempt(
      () =>
        client.rpc!.runs.removeQueued({
          threadId: threadId,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
          inputId,
        }),
      setError,
    ).then(refreshQueue);
  }
  function submit(
    submission: ComposerSubmission,
    questionReply?: ComposerSubmission["questionReply"],
  ) {
    if (local) {
      props.onLocalSubmit(threadId, submission);
      return;
    }
    const entry: PendingInput = {
      commandId: crypto.randomUUID(),
      text: submission.text,
      createdAt: Date.now(),
      submission: questionReply ? { ...submission, questionReply } : submission,
      optimisticSlotIds: serverActive ? undefined : [...store.slotIds],
      state: "preparing",
    };
    commitPending((entries) => [...entries, entry]);
    if (!questionReply)
      commitDraft({ text: "", skillIds: [], attachments: [], savedText: draft.savedText });
    void deliver(entry);
  }
  async function cancel() {
    const rpc = client.rpc,
      checkpoint = store.checkpoint;
    if (!rpc || !checkpoint) return;
    await attempt(
      () =>
        rpc.runs.cancel({
          threadId: threadId,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
          runId: thread?.activeRunId,
        }),
      setError,
    );
    void refreshQueue();
  }
  async function rewind() {
    const rpc = client.rpc,
      checkpoint = store.checkpoint;
    if (
      !draftLoaded ||
      !canEdit.current ||
      !rpc ||
      !checkpoint ||
      !rewindTarget ||
      rewinding ||
      active
    )
      return;
    setRewinding(true);
    let target = store.get(rewindTarget);
    while (target?.kind === "ready" && target.partsCursor) {
      const cursor = target.partsCursor;
      await client.loadTurnPage(threadId, rewindTarget);
      target = store.get(rewindTarget);
      if (target?.kind !== "ready" || target.partsCursor === cursor) {
        setError("Could not load the complete message. Try rewinding again.");
        setRewinding(false);
        return;
      }
    }
    const message =
      target?.kind === "ready"
        ? target.messages.find(
            (item) => item.role === "user" && item.metadata?.inputMode !== "steer",
          )
        : undefined;
    if (!message) {
      setError("The message is no longer available.");
      setRewinding(false);
      return;
    }
    const restored = await rewindDraft({
      parts: message.parts,
      threadId,
      resourceUrl,
      pool,
      onError: setError,
      rewind: async () => {
        if (!canEdit.current || currentId.current !== threadId) return;
        return attempt(
          () =>
            rpc.threads.rewind({
              threadId,
              commandId: crypto.randomUUID(),
              historyGeneration: checkpoint.historyGeneration,
              expectedRevision: checkpoint.projectionRevision,
              turnId: rewindTarget,
            }),
          setError,
        );
      },
    });
    setRewinding(false);
    if (!restored) return;
    const current = getDraft();
    commitDraft({
      ...restored,
      skillIds: [],
      savedText: current.text || current.savedText,
    });
    setRewindTarget(undefined);
    void refreshQueue();
  }
  const onAction = useCallback(
    (messageId: string, part: Extract<DisplayPart, { type: "data-actions" }>, actionId: string) => {
      if (!client.rpc) return;
      void attempt(
        () =>
          client.rpc!.actions.invoke({
            threadId: threadId,
            messageId,
            actionId,
            requestId: part.data.requestId,
            revision: part.data.revision,
            commandId: crypto.randomUUID(),
          }),
        setError,
      );
    },
    [client, threadId, setError],
  );
  const onReaction = useCallback(
    (messageId: string, emoji: string, enabled: boolean) => {
      if (!client.rpc) return;
      void attempt(
        () => client.rpc!.reactions.set({ threadId: threadId, messageId, emoji, active: enabled }),
        setError,
      );
    },
    [client, threadId, setError],
  );
  const updateProgress = (messageId: string, change: ProgressChange) =>
    questionReplyStore.getState().update(replyProgressKey(threadId, messageId), change);
  const loadDraft = async (key: string) =>
    (await loadComposerDraft(queries, composerDraftOptions(scope, key, draftCache))).match({
      ok: (value) => value,
      err: (message) => {
        setError(message);
        return undefined;
      },
    });
  const replyAnswered = replyPrompts.map((prompt) => {
    const current =
      prompt.ordinal === replyPrompt?.ordinal
        ? draft
        : summarizeDraft(getDraft(questionDraftKey(threadId, replyMessageId!, prompt.ordinal)));
    return (
      current.hasText ||
      promptAnswered({
        option: progress.options[prompt.ordinal],
        text: "",
        attachments: current.attachments.length,
      })
    );
  });
  const replyChosen = replyPrompt ? progress.options[replyPrompt.ordinal] : undefined;
  const replyLast =
    nextPromptStep(
      replyAnswered.map((answered, step) => answered || step === replyStep),
      replyStep,
    ) === "submit";
  const sendingReply = useRef(false);
  async function sendReply(question: NativeQuestion) {
    const target = questionReplyTarget(question);
    if (!target || sendingReply.current) return;
    const messageId = question.questionCallId;
    const prompts = questionPrompts(question);
    sendingReply.current = true;
    const drafts = await Promise.all(
      prompts.map((prompt) => loadDraft(questionDraftKey(threadId, messageId, prompt.ordinal))),
    );
    sendingReply.current = false;
    const choice = questionReplyStore.getState().choices.get(threadId);
    if (currentId.current !== threadId || choice?.messageId !== messageId || !choice.replying)
      return;
    const options =
      questionReplyStore.getState().progress.get(replyProgressKey(threadId, messageId))?.options ??
      {};
    const answers = new Map<number, PromptAnswer>();
    const typed = new Map<number, PromptAnswer>();
    for (const [position, prompt] of prompts.entries()) {
      const saved = drafts[position];
      if (!saved) return;
      const answer = { option: options[prompt.ordinal], attachments: saved.attachments.length };
      const text = composerSubmissionMarkdown(createComposerEditor(saved.text));
      answers.set(prompt.ordinal, { ...answer, text });
      typed.set(prompt.ordinal, { ...answer, text: saved.text });
    }
    const missing = prompts.findIndex((prompt) => !promptAnswered(answers.get(prompt.ordinal)!));
    if (missing >= 0) {
      updateProgress(messageId, (current) => ({ ...current, step: missing }));
      return;
    }
    const keys = drafts.flatMap((saved) => saved!.attachments);
    chooseReply(messageId, false);
    updateProgress(messageId, () => undefined);
    submit(
      {
        text: replyText(prompts, answers),
        ...(keys.length ? { attachmentText: replyText(prompts, typed) } : {}),
        // The composer keeps at most 32 skill references per draft.
        skillIds: [...new Set(drafts.flatMap((saved) => saved!.skillIds))].slice(0, 32),
        mode: "followup",
        attachments: pool.get(threadId).filter((attachment) => keys.includes(attachment.key)),
      },
      target,
    );
    for (const prompt of prompts)
      removeQuestionDraft(questionDraftKey(threadId, messageId, prompt.ordinal));
  }
  const questionAdvance = useEventCallback(() => {
    if (!replyQuestion) return;
    const next = nextPromptStep(
      replyAnswered.map((answered, step) => answered || step === replyStep),
      replyStep,
    );
    if (next === "submit") return void sendReply(replyQuestion);
    updateProgress(replyQuestion.questionCallId, (current) => ({ ...current, step: next }));
  });
  const autoAdvance = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(autoAdvance.current), [threadId, replyMessageId, replyStep]);
  const questionChoose = useEventCallback(async (ordinal: number, index: number) => {
    if (!replyQuestion || replyPrompt?.ordinal !== ordinal) return;
    const messageId = replyQuestion.questionCallId;
    const key = draftKey;
    const current = getDraft(key);
    // An option replaces the typed answer, so the text moves to the regular draft instead of vanishing.
    if (current.text.trim()) {
      const regular = await loadDraft(threadId);
      if (!regular) return;
      commitDraft(
        mergeClosedReply<string, Draft>(regular, {
          text: current.text,
          skillIds: current.skillIds,
          attachments: [],
        }),
        threadId,
      );
      commitDraft({ ...current, text: "", skillIds: [] }, key);
      toast.add({ title: "Your typed answer moved to your message draft." });
    }
    updateProgress(messageId, (progress) => ({
      ...progress,
      options: { ...progress.options, [ordinal]: index },
    }));
    clearTimeout(autoAdvance.current);
    // A short pause shows the choice before the next prompt replaces it.
    autoAdvance.current = setTimeout(questionAdvance, 200);
  });
  const questionStep = useEventCallback((step: number) => {
    if (replyMessageId) updateProgress(replyMessageId, (current) => ({ ...current, step }));
  });
  const questionReply = useEventCallback((messageId: string) => chooseReply(messageId, true));
  const questionExit = useEventCallback(() => {
    if (replyMessageId) chooseReply(replyMessageId, false);
  });
  const questionDismiss = useCallback(
    async (question: NativeQuestion) => {
      const rpc = client.rpc;
      const target = questionReplyTarget(question);
      if (!rpc) return "Connection unavailable";
      if (!target) return "This question can't be dismissed";
      let failure: string | undefined;
      await attempt(
        () =>
          rpc.questions.dismiss({
            threadId,
            messageId: target.messageId,
            historyGeneration: question.historyGeneration,
            token: target.token,
          }),
        (message) => {
          failure = message;
          if (isConnectionFailure(message)) void client.checkConnection();
        },
      );
      return failure;
    },
    [client, threadId],
  );
  const dismissReply = useEventCallback(() =>
    replyQuestion ? questionDismiss(replyQuestion) : Promise.resolve(undefined),
  );
  const questionServices: QuestionServices = { onReply: questionReply, onDismiss: questionDismiss };
  const replyView: QuestionReplyView = { messageId: replyMessageId };
  const replyReady = replyChosen !== undefined;
  const replyCount = replyPrompt ? replyPrompts.length : 0;
  // The composer is memoized, so typing and streaming must not hand it a new object each render.
  const composerAnswer = useMemo(
    () =>
      replyCount
        ? {
            label: answerLabel(replyLast, replyCount),
            last: replyLast,
            ready: replyReady,
            onAdvance: questionAdvance,
          }
        : undefined,
    [replyCount, replyLast, replyReady, questionAdvance],
  );
  const composerSkills = useEventCallback((skillIds: string[]) =>
    commitDraft({ ...getDraft(), skillIds }),
  );
  const composerCommand = useEventCallback((commandId: string | undefined) =>
    commitDraft({ ...getDraft(), commandId }),
  );
  const composerText = useEventCallback((text: string) => commitDraft({ ...getDraft(), text }));
  const composerAttach = useEventCallback((files: File[], requireAll?: boolean) => {
    if (local) {
      const current = draftStore.getState().localDrafts.get(threadId);
      if (!current) return [];
      const available = 32 - current.attachments.length;
      if (requireAll && files.length > available) return [];
      const added = files.slice(0, available).map(draftAttachment);
      props.onLocalChange(threadId, (current) => ({
        ...current,
        attachments: [...current.attachments, ...added],
        draft: {
          ...current.draft,
          attachments: [...current.draft.attachments, ...added.map((item) => item.key)],
        },
      }));
      return added;
    }
    const current = getDraft();
    const available = 32 - current.attachments.length;
    if (requireAll && files.length > available) return [];
    const keys = files.slice(0, available).map((file) => pool.add(threadId, file));
    commitDraft({ ...current, attachments: [...current.attachments, ...keys] });
    return keys.map((key) => pool.get(threadId).find((attachment) => attachment.key === key)!);
  });
  const composerRemoveAttachment = useEventCallback((key: string) => {
    if (local) {
      releaseDraftAttachments(attachments.filter((item) => item.key === key));
      props.onLocalChange(threadId, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => item.key !== key),
        draft: {
          ...current.draft,
          attachments: current.draft.attachments.filter((id) => id !== key),
        },
      }));
      return;
    }
    pool.remove(threadId, key);
    const current = getDraft();
    commitDraft({ ...current, attachments: current.attachments.filter((id) => id !== key) });
  });
  const composerRetryAttachment = useEventCallback((key: string) => pool.retry(threadId, key));
  const composerModelChange = useEventCallback((modelId: string, reasoning?: ModelReasoning) => {
    if (local) {
      props.onLocalChange(threadId, (current) => ({ ...current, modelId, reasoning }));
      return;
    }
    const rpc = client.rpc,
      checkpoint = store.checkpoint;
    if (!rpc || !checkpoint) return;
    void attempt(
      () =>
        rpc.threads.update({
          threadId: threadId,
          expectedRevision: checkpoint.projectionRevision,
          modelId,
          reasoning,
        }),
      setError,
    );
  });
  const composerCancel = useEventCallback(() => void cancel());
  const composerSubmit = useEventCallback(submit);
  const composerError = localThread?.error ?? error ?? draftQuery.error?.message ?? historyError;
  const dismissComposerError = useEventCallback((id: string, message: string) => {
    if (id !== threadId || message !== composerError) return;
    setError(undefined);
    setHistoryError(undefined);
    if (local) props.onLocalChange(threadId, (current) => ({ ...current, error: undefined }));
  });
  // Only the source holding this failure is cleared, so a lower-priority error can still appear.
  const dropConnectionError = useEventCallback((message: string) => {
    void client.checkConnection();
    if (local && localThread?.error === message)
      props.onLocalChange(threadId, (current) => ({ ...current, error: undefined }));
    if (error === message) setError(undefined);
    if (historyError === message) setHistoryError(undefined);
  });
  useEffect(() => {
    if (!composerError) return;
    if (isConnectionFailure(composerError)) return dropConnectionError(composerError);
    const id = `composer-error:${threadId}`;
    toast.add({
      id,
      title: composerError,
      type: "error",
      onClose: () => dismissComposerError(threadId, composerError),
    });
    return () => toast.close(id);
  }, [composerError, threadId, dismissComposerError, dropConnectionError]);
  const failedCreation =
    localThread?.creation && !localThread.sending ? localThread.creation.entry : undefined;
  const trailing =
    failedCreation || queuedWithoutTurn.length || visiblePendingEntries.length ? (
      <QueuedMessages>
        {failedCreation ? (
          <QueuedMessage
            text={failedCreation.text}
            state="failed"
            error="Conversation could not be created."
            onRetry={() => props.onLocalSubmit(threadId, failedCreation.submission)}
          />
        ) : null}
        {queuedWithoutTurn.map((entry) => (
          <QueuedMessage
            key={entry.inputId}
            text={entry.text}
            state="queued"
            label={entry.mode === "followup" ? queueLabels.followup : undefined}
            removeLabel="Remove queued message"
            onRemove={() => removeQueued(entry.inputId)}
          />
        ))}
        {visiblePendingEntries.map((entry) => {
          const failed = entry.state === "rejected" || entry.state === "uncertain";
          return (
            <QueuedMessage
              key={entry.commandId}
              text={entry.text}
              state={failed ? "failed" : "sending"}
              label={entry.optimisticSlotIds ? undefined : queueLabels[entry.submission.mode]}
              error={entry.error}
              retryLabel={entry.questionClosed ? "Send as message" : undefined}
              onRetry={failed && editable ? () => retryPending(entry) : undefined}
              onRemove={failed ? () => discardPending(entry) : undefined}
            />
          );
        })}
      </QueuedMessages>
    ) : undefined;
  const composer = (
    <div className="chat-bottom w-full max-w-[var(--ui-chat-width)] my-0 mx-auto pt-2 px-6 pb-6 max-workspace:px-3 max-workspace:pb-3">
      {draft.savedText ? (
        <Button
          type="button"
          variant="ghost"
          className="text-primary py-2 px-3 text-sm"
          onClick={() => {
            const current = getDraft();
            commitDraft({
              ...current,
              text: current.savedText ?? "",
              savedText: current.text || undefined,
            });
          }}
        >
          Restore previous draft
        </Button>
      ) : null}
      <div hidden={!editable}>
        <DraftComposer
          source={draftSource}
          documentKey={draftKey}
          header={questionHeader()}
          placeholder={replyPrompt ? answerPlaceholder(replyChosen !== undefined) : undefined}
          answer={composerAnswer}
          autoFocus={props.autoFocus}
          typeToFocus={props.foreground}
          loadingDraft={!draftLoaded}
          windowDrop={props.foreground}
          catalog={props.catalog}
          skillIds={draft.skillIds}
          onSkills={composerSkills}
          commandId={draft.commandId}
          onCommand={composerCommand}
          onText={composerText}
          attachments={attachments}
          onAttach={composerAttach}
          onRemoveAttachment={composerRemoveAttachment}
          onRetryAttachment={composerRetryAttachment}
          active={active}
          canCancel={active || queue.length > 0}
          disabled={!editable || !draftLoaded || !!rewinding}
          submitting={!!localThread?.creation}
          offline={!online}
          modelId={localThread?.modelId ?? thread?.modelId}
          reasoning={localThread?.reasoning ?? thread?.reasoning}
          onModelChange={composerModelChange}
          onSubmit={composerSubmit}
          onCancel={composerCancel}
        />
      </div>
      {!editable && thread ? <div className="read-only">Read-only</div> : null}
    </div>
  );
  function questionHeader() {
    if (replyQuestion)
      return (
        <QuestionPanel
          question={replyQuestion}
          step={replyStep}
          chosen={replyChosen}
          typed={draft.hasText}
          answered={replyAnswered}
          disabled={!draftLoaded}
          onChoose={questionChoose}
          onStep={questionStep}
          onExit={questionExit}
          onDismiss={dismissReply}
        />
      );
    if (answerable.length) return <QuestionWaiting waiting={answerable} onReply={questionReply} />;
    return undefined;
  }
  function renderEmptyConversation() {
    if (local) return <ConversationWelcome />;
    const retry = thread ? undefined : props.onRetryLoad;
    if (props.loadError)
      return <ConversationStatus state="error" detail={props.loadError} onRetry={retry} />;
    if (!online && !thread) return <ConversationStatus state="offline" onRetry={retry} />;
    if (historyLoaded) return <ConversationWelcome existing />;
    if (!online) return <ConversationStatus state="offline" />;
    return <ConversationStatus state={historyError ? "error" : "loading"} />;
  }
  return (
    <MessageIdentityContext value={identities}>
      <div className="chat-workspace min-h-0 flex flex-col flex-1" data-thread-id={threadId}>
        <UploadProgressContext.Provider value={uploadProgress}>
          <RecentContextProvider thread={thread}>
            <QuestionReplyContext value={replyView}>
              <Timeline
                optimisticTurn={optimisticTurn}
                onOptimisticResolved={resolveOptimistic}
                emptyContent={renderEmptyConversation()}
                centerEmpty={local || (historyLoaded && !props.loadError)}
                header={props.header}
                footer={composer}
                trailing={trailing}
                onLatestVisibleChange={setLatestVisible}
                client={client}
                threadId={threadId}
                canEdit={editable && draftLoaded}
                resourceUrl={messageResourceUrl}
                upload={recoveryUpload}
                onRewind={setRewindTarget}
                rewindDisabled={active || thread?.kind === "dm"}
                timestamps={thread?.kind === "dm"}
                outline={outline}
                onAction={onAction}
                onReaction={onReaction}
                questions={questionServices}
              />
            </QuestionReplyContext>
          </RecentContextProvider>
        </UploadProgressContext.Provider>

        <Modal
          open={editable && !!rewindTarget}
          title="Rewind this conversation?"
          onClose={() => setRewindTarget(undefined)}
        >
          <p>
            The selected turn and everything after it will leave the conversation. Its text and
            attachments return to your composer. File changes and other tool effects remain.
          </p>
          {active ? <p>Wait for the agent to finish before rewinding.</p> : null}
          <div className="dialog-actions flex justify-end gap-2 mt-6">
            <Button
              variant="secondary"
              className="gap-2 rounded-sm px-4"
              onClick={() => setRewindTarget(undefined)}
            >
              Keep conversation
            </Button>
            <Button
              variant="destructive"
              className="gap-2 rounded-sm px-4"
              disabled={rewinding || active}
              onClick={() => void rewind()}
            >
              <RotateCcw />
              Rewind
            </Button>
          </div>
        </Modal>
      </div>
    </MessageIdentityContext>
  );
}

type DraftTextSource = {
  local: boolean;
  threadId: string;
  options: ReturnType<typeof composerDraftOptions>;
  initialData?: Draft;
};

/** Reads the draft text, so typing rerenders the composer instead of the whole conversation. */
function DraftComposer({
  source,
  ...props
}: Omit<ComposerProps, "text"> & { source: DraftTextSource }) {
  const { drafts } = useWorkspace();
  const localText = useStore(drafts, (state) =>
    source.local ? (state.localDrafts.get(source.threadId)?.draft.text ?? "") : "",
  );
  const saved = useQuery({
    ...source.options,
    initialData: source.initialData,
    enabled: !source.local,
    select: draftText,
  });
  return <Composer {...props} text={source.local ? localText : (saved.data ?? "")} />;
}
