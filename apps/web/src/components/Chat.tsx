import type { ModelReasoning } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import { RecentContextProvider } from "./RecentContext";
import { currentPushDeviceId } from "../push-device";
import { watchReadLifecycle } from "../read-lifecycle";
import { useDmRewind } from "../use-dm-rewind";
import {
  rewindRestrictionReason,
  rewindRejectionReason,
  type RewindReason,
} from "../rewind-policy";
import { RewindDialog } from "./RewindDialog";
import { prepareRewindDraft, type RewindAttempt } from "../rewind-draft";
import type { OptimisticTurn } from "../optimistic-turns";
import { useEventCallback } from "../use-event-callback";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
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
import { useConfirmedOffline } from "../use-connection-notice";
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
import type {
  NativeInput,
  NativeInputReceipt,
  NativeQuestion,
  QueuedInput,
  DisplayPart,
  NativeThread,
  ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";
import type { Attachment, ChatCommon, ComposerSubmission, UploadReference } from "../types";
import { resolveAttachmentIds } from "../uploads";
import {
  attachmentStaging,
  canUseStagedUpload,
  draftAttachments,
  readyUploadReference,
  referencedAttachment,
} from "../attachment-reference";
import { inputDeliveryOptions } from "../input-mode";
import { deliverPendingInput, type PendingInput } from "../pending-input";
import { pendingTurnSlot } from "../pending-message";
import { Button } from "./ui/button";
import { ConversationStatus } from "./ConversationStatus";
import { Timeline, useLatestReadableTurn } from "./Timeline";
import { QueuedMessage, QueuedMessages } from "./QueuedMessage";
import type { OutlineSource } from "../timeline-outline";
import { attempt } from "./ui";
import { toast } from "./ui/toast";
import { isConnectionFailure } from "../connection-lifecycle";
import { UploadProgressContext } from "../upload-context";
import {
  type Draft,
  emptyDraft,
  summarizeDraft,
  emptySummary,
  DraftComposer,
  localDraftSummary,
  localThreadSettings,
} from "./chat-draft";
export type { PendingInput } from "../pending-input";
export type { Draft } from "./chat-draft";

const queueLabels: Record<ComposerSubmission["mode"], string> = {
  steer: "Steering",
  followup: "Follow-up",
};
// The compiler cannot memoize a component that contains `import()`.
const loadComposerEditor = () => import("./composer-editor");
const noPrompts: ReturnType<typeof questionPrompts> = [];
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
  const rewindAttempt = useStore(draftStore, (state) => state.rewinds.get(threadId));
  const local = threadId.startsWith("draft:");
  const localThread = useStore(
    draftStore,
    useShallow((state) => localThreadSettings(state.localDrafts.get(threadId))),
  );
  const localDraft = useStore(
    draftStore,
    useShallow((state) => localDraftSummary(state.localDrafts.get(threadId))),
  );
  const editable = local ? !!localThread : !!thread?.capabilities.edit;
  const queries = useQueryClient();
  const identity = useContext(MessageIdentityContext);
  const online = useNativeOnline(client);
  const offline = useConfirmedOffline(online);
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
    rewindAttempt?.draftKey ??
    (replyMessageId && replyPrompt
      ? questionDraftKey(threadId, replyMessageId, replyPrompt.ordinal)
      : threadId);
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
  const draft = localDraft ?? draftQuery.data ?? emptySummary;
  const draftLoaded = local ? !!localThread : !draftQuery.isPending;
  const draftSource = { local, threadId, options: draftOptions, initialData: draftInitialData };
  const [view, setView] = useState<{
    id: string;
    error?: string;
    historyError?: string;
    rewindTarget?: string;
    rewindRejected?: RewindReason;
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
    (rewindTarget?: string) => updateView({ rewindTarget, rewindRejected: undefined }),
    [updateView],
  );
  const setRewinding = (rewinding: boolean) => updateView({ rewinding });
  const setLatestVisible = useCallback(
    (latestVisible: boolean) => updateView({ latestVisible }),
    [updateView],
  );
  const {
    error,
    historyError,
    rewindTarget,
    rewindRejected,
    rewinding,
    latestVisible,
    unknownAuthor,
  } = view.id === threadId ? view : {};
  const currentId = useRef(threadId);
  const composerElement = useRef<HTMLDivElement>(null);
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
  const historySnapshot = useCallback(() => store.checkpoint?.historyGeneration, [store]);
  const historyGeneration = useSyncExternalStore(
    subscribeHistory,
    historySnapshot,
    historySnapshot,
  );
  const historyLoaded = historyGeneration !== undefined;
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
  const rewindRestriction = useDmRewind({
    client,
    threadId,
    ownerId: scope.principalId,
    dm: thread?.kind === "dm",
    online,
    busy:
      active ||
      queuedItems.length > 0 ||
      pendingEntries.some((entry) => entry.state !== "rejected"),
  });
  const rewindReason =
    rewindRejected ??
    (rewindAttempt ? undefined : rewindRestrictionReason(rewindRestriction, rewindTarget));

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
      draftAttachments(draft.attachments, draft.attachmentReferences, uploads),
    [localThread?.attachments, uploads, draft.attachments, draft.attachmentReferences],
  );
  const attachmentAvailable = useCallback(
    (item: Attachment) =>
      pool.isPublished(item.resourceId) ||
      canUseStagedUpload(
        attachmentStaging(item),
        threadId,
        store.checkpoint?.historyGeneration ?? historyGeneration,
      ),
    [historyGeneration, pool, store, threadId],
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
  const autoReply =
    draftLoaded && !rewindAttempt
      ? autoReplyQuestion(answerable, replyChoice, regularDraftEmpty)
      : undefined;
  const chooseReply = (messageId: string, replying: boolean) => {
    if (draftStore.getState().rewinds.has(threadId)) return;
    questionReplyStore.getState().choose(threadId, { messageId, replying });
  };
  useEffect(() => {
    if (autoReply) chooseReply(autoReply, true);
  }, [autoReply, threadId]);
  const previousReply = useRef<{ threadId: string; messageId: string; ordinals: number[] }>(
    undefined,
  );
  useEffect(() => {
    if (rewindAttempt) return;
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
      const regular = getDraft(threadId);
      commitDraft(
        {
          ...mergeClosedReply(regular, leftover),
          attachmentReferences: [
            ...(regular.attachmentReferences ?? []),
            ...(leftover.attachmentReferences ?? []),
          ],
        },
        threadId,
      );
      moved = true;
    }
    if (moved) toast.add({ title: "The question closed. Your reply is now a regular draft." });
  }, [replyMessageId, threadId, rewindAttempt]);
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
    if (
      entry.submission.attachments.some(
        (item) =>
          !pool.isPublished(item.resourceId) &&
          !canUseStagedUpload(attachmentStaging(item), threadId, checkpoint.historyGeneration),
      )
    ) {
      setPending(entry.commandId, {
        state: "rejected",
        error: "Reattach or remove the missing files before sending.",
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
      attachmentIds: [...new Set(ids.filter((id): id is string => !!id))],
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
    if (sent) {
      pool.markPublished(sent.attachmentIds);
      showQueued(sent, outcome.receipt);
    }
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
    if (submission.attachments.some((item) => !attachmentAvailable(item))) {
      setError("Reattach or remove the missing files before sending.");
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
  async function prepareRewind(): Promise<RewindAttempt["prepared"]> {
    const rpc = client.rpc;
    const checkpoint = store.checkpoint;
    if (!rpc || !checkpoint || !rewindTarget) return;
    let target = store.get(rewindTarget);
    while (target?.kind === "ready" && target.partsCursor) {
      const cursor = target.partsCursor;
      await client.loadTurnPage(threadId, rewindTarget);
      target = store.get(rewindTarget);
      if (target?.kind !== "ready" || target.partsCursor === cursor) {
        setError("Could not load the complete message. Try rewinding again.");
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
      return;
    }
    const request = {
      threadId,
      commandId: crypto.randomUUID(),
      historyGeneration: checkpoint.historyGeneration,
      expectedRevision: checkpoint.projectionRevision,
      turnId: rewindTarget,
    };
    const finish = await prepareRewindDraft({
      parts: message.parts,
      threadId,
      pool,
      onError: setError,
    });
    return finish ? { request, finish } : undefined;
  }

  async function rewind() {
    if (
      !draftLoaded ||
      !canEdit.current ||
      !rewindTarget ||
      rewinding ||
      rewindAttempt?.running ||
      rewindAttempt?.completed ||
      rewindReason ||
      (!rewindAttempt && active)
    )
      return;
    const pending = draftStore.getState().claimRewind(threadId, rewindTarget, draftKey);
    if (!pending) return;
    const setPendingAttempt = (next?: RewindAttempt) =>
      draftStore.getState().setRewind(threadId, pending.owner, next);
    setRewinding(true);
    const prepared = pending.prepared ?? (await prepareRewind());
    if (!prepared) {
      setPendingAttempt();
      setRewinding(false);
      return;
    }
    const ready = { ...pending, prepared };
    setPendingAttempt(ready);
    const restored = await prepared.finish({
      onError: setError,
      rewind: async () => {
        const rpc = client.rpc;
        if (!rpc) return;
        return attempt(
          () => rpc.threads.rewind(prepared.request),
          (message) => {
            const reason = rewindRejectionReason(message);
            if (reason) {
              setPendingAttempt();
              updateView({ rewindRejected: reason });
              return;
            }
            setError(message);
          },
        );
      },
    });
    setRewinding(false);
    if (!restored) {
      setPendingAttempt({ ...ready, running: false });
      return;
    }
    setPendingAttempt({ ...ready, running: false, completed: restored });
    void refreshQueue();
  }
  const applyRewindReplacement = useEventCallback(() => {
    const pending = draftStore.getState().rewinds.get(threadId);
    if (!pending?.completed || !props.foreground) return;
    previousReply.current = undefined;
    if (pending.draftKey && pending.draftKey !== threadId) removeQuestionDraft(pending.draftKey);
    const choice = questionReplyStore.getState().choices.get(threadId);
    if (choice) questionReplyStore.getState().choose(threadId, { ...choice, replying: false });
    const completed = pending.completed;
    const ready = draftAttachments(
      completed.attachments,
      completed.attachmentReferences,
      pool.get(threadId),
    ).flatMap((item) => {
      const reference = readyUploadReference(item);
      return reference ? [reference] : [];
    });
    commitDraft({ ...completed, skillIds: [], attachmentReferences: ready }, threadId);
    draftStore.getState().setRewind(threadId, pending.owner);
    updateView({ rewindTarget: undefined, rewindRejected: undefined });
  });

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
    const [drafts, { composerSubmission }] = await Promise.all([
      Promise.all(
        prompts.map((prompt) => loadDraft(questionDraftKey(threadId, messageId, prompt.ordinal))),
      ),
      loadComposerEditor(),
    ]);
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
      const text = composerSubmission(saved.text);
      answers.set(prompt.ordinal, { ...answer, text });
      typed.set(prompt.ordinal, { ...answer, text: saved.text });
    }
    const missing = prompts.findIndex((prompt) => !promptAnswered(answers.get(prompt.ordinal)!));
    if (missing >= 0) {
      updateProgress(messageId, (current) => ({ ...current, step: missing }));
      return;
    }
    const keys = drafts.flatMap((saved) => saved!.attachments);
    const replies = draftAttachments(
      keys,
      drafts.flatMap((saved) => saved?.attachmentReferences ?? []),
      pool.get(threadId),
    );
    if (replies.length !== keys.length || replies.some((item) => !attachmentAvailable(item))) {
      setError("Reattach or remove the missing files before sending.");
      return;
    }
    if (replies.length > 32) {
      toast.add({ title: "A message can contain at most 32 attachments.", type: "error" });
      return;
    }
    chooseReply(messageId, false);
    updateProgress(messageId, () => undefined);
    submit(
      {
        text: replyText(prompts, answers),
        ...(keys.length ? { attachmentText: replyText(prompts, typed) } : {}),
        // The composer keeps at most 32 skill references per draft.
        skillIds: [...new Set(drafts.flatMap((saved) => saved!.skillIds))].slice(0, 32),
        mode: "followup",
        attachments: replies,
      },
      target,
    );
    for (const prompt of prompts)
      removeQuestionDraft(questionDraftKey(threadId, messageId, prompt.ordinal));
  }
  const questionAdvance = useEventCallback(() => {
    if (rewindAttempt || !replyQuestion) return;
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
    if (rewindAttempt || !replyQuestion || replyPrompt?.ordinal !== ordinal) return;
    const messageId = replyQuestion.questionCallId;
    const key = draftKey;
    const current = getDraft(key);
    // An option replaces the typed answer, so the text moves to the regular draft instead of vanishing.
    if (current.text.trim()) {
      const regular = await loadDraft(threadId);
      if (!regular || draftStore.getState().rewinds.has(threadId)) return;
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
    if (rewindAttempt) return;
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
  function addDraftAttachments(
    items: readonly (File | { reference: UploadReference; file?: File })[],
    requireAll?: boolean,
    keys?: readonly string[],
  ) {
    const current = getDraft();
    const available = keys ? items.length : Math.max(0, 32 - current.attachments.length);
    if (requireAll && items.length > available) return [];
    const historyGeneration = store.checkpoint?.historyGeneration;
    if (!keys && !local && historyGeneration === undefined) return [];
    const added = items.slice(0, available).map((item, index) => {
      const key = keys?.[index];
      if (!(item instanceof File)) {
        const reference = { ...item.reference, key: key ?? crypto.randomUUID() };
        return item.file && reference.staging
          ? pool.keepFile(threadId, reference.key, item.file, reference)
          : referencedAttachment(reference);
      }
      if (local) return { ...draftAttachment(item), ...(key ? { key } : {}) };
      if (key && historyGeneration === undefined) return pool.keepFile(threadId, key, item);
      const uploadKey = pool.add(threadId, item, historyGeneration, key, draftKey);
      return pool.get(threadId).find((attachment) => attachment.key === uploadKey)!;
    });
    const next = {
      ...current,
      attachments: [...current.attachments, ...added.map((item) => item.key)],
      attachmentReferences: [
        ...(current.attachmentReferences ?? []),
        ...added.flatMap((item) => {
          const reference = readyUploadReference(item);
          return reference ? [reference] : [];
        }),
      ],
    };
    if (local) {
      props.onLocalChange(threadId, (current) => ({
        ...current,
        attachments: [...current.attachments, ...added],
        draft: next,
      }));
    } else {
      commitDraft(next);
    }
    return added;
  }
  const composerAttach = useEventCallback((files: File[], requireAll?: boolean) =>
    addDraftAttachments(files, requireAll),
  );
  const composerPasteAttachments = useEventCallback(
    (attachments: readonly Attachment[], restoreKeys?: boolean) => {
      if (!restoreKeys && !local && !store.checkpoint) return;
      const generation = store.checkpoint?.historyGeneration;
      const items = attachments.flatMap<File | { reference: UploadReference; file?: File }>(
        (attachment) => {
          const reference = readyUploadReference(attachment);
          if (reference && pool.isPublished(reference.resourceId))
            return [{ reference: { ...reference, staging: undefined }, file: attachment.file }];
          if (
            reference &&
            (restoreKeys || canUseStagedUpload(reference.staging, threadId, generation))
          )
            return [{ reference, file: attachment.file }];
          return attachment.file ? [attachment.file] : [];
        },
      );
      if (items.length !== attachments.length) {
        setError("An attachment is unavailable in this conversation.");
        return;
      }
      const added = addDraftAttachments(
        items,
        true,
        restoreKeys ? attachments.map((item) => item.key) : undefined,
      );
      if (added.length === items.length) return added;
      toast.add({ title: "A message can contain at most 32 attachments.", type: "error" });
    },
  );
  const composerRemoveAttachment = useEventCallback((key: string) => {
    const current = getDraft();
    const next = {
      ...current,
      attachments: current.attachments.filter((id) => id !== key),
      attachmentReferences: current.attachmentReferences?.filter((item) => item.key !== key),
    };
    if (local) {
      releaseDraftAttachments(attachments.filter((item) => item.key === key));
      props.onLocalChange(threadId, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => item.key !== key),
        draft: next,
      }));
      return;
    }
    pool.remove(threadId, key);
    commitDraft(next);
  });
  const composerRetryAttachment = useEventCallback((key: string) => {
    const generation = store.checkpoint?.historyGeneration;
    const attachment = pool.get(threadId).find((item) => item.key === key);
    if (
      attachment &&
      generation !== undefined &&
      (!attachment.staging || !canUseStagedUpload(attachment.staging, threadId, generation))
    ) {
      const current = getDraft();
      pool.remove(threadId, key);
      pool.add(threadId, attachment.file, generation, key, draftKey);
      commitDraft({
        ...current,
        attachmentReferences: current.attachmentReferences?.filter((item) => item.key !== key),
      });
      return;
    }
    pool.retry(threadId, key);
  });
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
    <div
      ref={composerElement}
      className="chat-bottom w-full max-w-[var(--ui-chat-width)] my-0 mx-auto pt-2 px-6 pb-6 max-workspace:px-3 max-workspace:pb-3"
    >
      {rewindAttempt && !rewindTarget ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => setRewindTarget(rewindAttempt.target)}
        >
          Finish rewind
        </Button>
      ) : null}
      <div hidden={!editable}>
        <DraftComposer
          source={draftSource}
          documentKey={draftKey}
          replacement={
            props.foreground && rewindAttempt?.completed
              ? {
                  id: rewindAttempt.owner,
                  text: rewindAttempt.completed.text,
                  documentKey: threadId,
                  previous:
                    rewindAttempt.draftKey !== threadId
                      ? {
                          text: getDraft(threadId).text,
                          skills:
                            props.catalog?.skills.filter((skill) =>
                              getDraft(threadId).skillIds.includes(skill.id),
                            ) ?? [],
                        }
                      : undefined,
                }
              : undefined
          }
          onReplacementApplied={applyRewindReplacement}
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
          onPasteAttachments={composerPasteAttachments}
          attachmentAvailable={attachmentAvailable}
          attachmentDisabled={!local && !historyLoaded}
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
    if (offline && !thread) return <ConversationStatus state="offline" onRetry={retry} />;
    if (historyLoaded) return <ConversationWelcome existing />;
    if (offline) return <ConversationStatus state="offline" />;
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
                rewindDisabled={active || !!rewindAttempt}
                rewindRestriction={rewindRestriction}
                timestamps={thread?.kind === "dm"}
                outline={outline}
                onAction={onAction}
                onReaction={onReaction}
                questions={questionServices}
              />
            </QuestionReplyContext>
          </RecentContextProvider>
        </UploadProgressContext.Provider>

        <RewindDialog
          open={editable && !!rewindTarget}
          reason={rewindReason}
          active={!rewindAttempt && active}
          rewinding={rewinding || rewindAttempt?.running}
          focusTarget={() =>
            composerElement.current?.querySelector<HTMLElement>('[contenteditable="true"]') ?? null
          }
          onClose={() => setRewindTarget(undefined)}
          onRewind={() => void rewind()}
        />
      </div>
    </MessageIdentityContext>
  );
}
