import { createFreshOnlyLineage } from "../../shared/core-primary-lineage";
import { captureError } from "../../shared/error-capture";
import { isDeepStrictEqual } from "node:util";

import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  buildCoreLineageManifestV2,
  areCoreCanonicalMessagesIdentityEqualV2,
  createCorePrimaryLineageFreshOnlyV2,
  type BusMessageV2,
  type CoreLineageAtomV2,
  type CoreLineageSegmentInputV2,
  type CorePrimaryLineageV2,
  type StoredResourcePartV1,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import type { RetentionLimit } from "@stanley2058/lilac-utils";
import {
  withSurfaceRequestReadScope,
  type SurfaceAdapter,
  type SurfaceOperationError,
  type SurfaceOperationResult,
} from "../adapter";
import type { MsgRef, SurfaceMessage } from "../types";
import {
  ResourceStoreFailure,
  type ResourceDescriptor,
  type ResourceRegistrationError,
  type ResourceRegistry,
} from "../../resource";

import {
  parseLeadingContinueDirective,
  stripLeadingContinueDirective,
} from "../discord/discord-request-router/common";
import {
  isDiscordSessionDividerSurfaceMessageAnyAuthor,
  isDiscordSessionDividerSurfaceMessage,
  isDiscordSessionDividerText,
} from "../discord/discord-session-divider";
import { normalizeDiscordRaw } from "../discord/discord-raw-normalizer";

import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  type CoreOwnedBlobIntegrityError,
  type CoreOwnedBlobReference,
  type CoreSurfaceProjection,
  type TranscriptSnapshot,
  type TranscriptStore,
} from "../../transcript/transcript-store";
import {
  hashCanonicalStoredMessagesV2,
  StoredMessageValidationError,
} from "../../transcript/transcript-persistence-codec";
import {
  createDiscordAttachmentState,
  deleteDiscordRequestBlobHandles,
  type DiscordAttachmentPreparationFailed,
  type DiscordRequestBlobCleanupFailed,
  getDiscordAttachmentOwnershipError,
  getDiscordOwnedBlobReferences,
  getDiscordRequestBlobHandles,
  rememberDiscordRequestBlobHandles,
} from "./request-composition/attachments";
import type { DiscordAttachmentCacheAccess } from "../discord/discord-attachment";
import type { DiscordMessageCacheAccess } from "../store/discord-search-store";
import {
  prepareStoredMessagesForBus,
  type DiscordStoredBlobPreparationError,
} from "./request-composition/prepare-bus-messages";
import { selectNewestReachableCheckpoint } from "./request-composition/checkpoint-selection";
import {
  buildAssistantOnlyMessageFromTranscript,
  formatDiscordAttributionHeader,
  normalizeAssistantContextText,
  normalizeText,
} from "./request-composition/normalization";
import { escapeSurfaceMetadataTags } from "./surface-metadata";
import {
  fetchMentionThreadContext,
  fetchReplyChainFrom,
  findEarliestEffectiveReplyAnchor,
  getForwardSnapshotTextFromRaw,
  mergeChainByDiscordWindow,
  resolveMergeBlockEndingAt,
  toReplyChainMessage,
  type ResolveDiscordMessagesByRefs,
} from "./request-composition/reply-chain";
import type {
  ComposeRecentChannelMessagesOpts,
  ComposeRequestOpts,
  ComposeSingleMessageOpts,
  ReplyChainMessage,
  RequestCompositionResult,
} from "./request-composition/types";

export type {
  ComposeRecentChannelMessagesOpts,
  ComposeRequestOpts,
  ComposeSingleMessageOpts,
  ReplyChainMessage,
  RequestCompositionResult,
} from "./request-composition/types";

export type RequestCompositionPrimaryError =
  | CoreOwnedBlobIntegrityError
  | DiscordAttachmentPreparationFailed
  | DiscordStoredBlobPreparationError
  | ResourceRegistrationError
  | StoredMessageValidationError
  | SurfaceOperationError;

export class DiscordRequestCompositionAndCleanupFailed extends TaggedError(
  "DiscordRequestCompositionAndCleanupFailed",
)<{
  readonly primary: RequestCompositionError;
  readonly cleanup: DiscordRequestBlobCleanupFailed;
  readonly message: string;
}> {}

export type RequestCompositionError =
  | RequestCompositionPrimaryError
  | DiscordRequestCompositionAndCleanupFailed;

const DISCORD_SURFACE_ID_PREFIX = "discord:";
const ACTIVE_REQUEST_READ_SCOPE = Symbol("active-request-read-scope");

type StoredLineageSegmentInputV2 = Omit<CoreLineageSegmentInputV2, "canonicalMessages"> & {
  readonly canonicalMessages: readonly StoredMessageV1[];
};

type ProjectionCapableStore = TranscriptStore &
  Required<
    Pick<
      TranscriptStore,
      | "admitCoreSurfaceProjection"
      | "getCoreSurfaceProjection"
      | "putCoreOwnedBlob"
      | "getCoreOwnedBlob"
      | "deleteCoreOwnedBlobIfUnreferenced"
    >
  >;

function isProjectionCapableStore(
  store: TranscriptStore | undefined,
): store is ProjectionCapableStore {
  return Boolean(
    store?.admitCoreSurfaceProjection &&
    store.getCoreSurfaceProjection &&
    store.putCoreOwnedBlob &&
    store.getCoreOwnedBlob &&
    store.deleteCoreOwnedBlobIfUnreferenced,
  );
}

function surfaceIdForDiscordSession(sessionId: string): string {
  return `${DISCORD_SURFACE_ID_PREFIX}${sessionId}`;
}

function surfaceProjectionKey(sessionId: string, messageId: string) {
  return {
    requestClient: "discord" as const,
    surfaceId: surfaceIdForDiscordSession(sessionId),
    sessionId,
    messageId,
    projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  };
}

function mergeProjectedSurfaceMessages(messages: readonly StoredMessageV1[]): StoredMessageV1[] {
  if (messages.length <= 1) return [...messages];
  const role = messages[0]?.role;
  if (role === "assistant" && messages.every((message) => message.role === "assistant")) {
    const content = messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n\n"),
      )
      .filter(Boolean)
      .join("\n\n");
    return [{ role: "assistant", content }];
  }
  if (role !== "user" || !messages.every((message) => message.role === "user")) {
    return [...messages];
  }

  const multipart = messages.some((message) => typeof message.content !== "string");
  if (!multipart) {
    return [
      {
        role: "user",
        content: messages
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n\n"),
      },
    ];
  }

  const parts: Exclude<Extract<StoredMessageV1, { role: "user" }>["content"], string> = [];
  for (const [index, message] of messages.entries()) {
    if (index > 0) parts.push({ type: "text", text: "\n\n" });
    if (typeof message.content === "string") parts.push({ type: "text", text: message.content });
    else parts.push(...message.content);
  }
  return [{ role: "user", content: parts }];
}

function storedProjectionSegmentIds(projection: CoreSurfaceProjection | null): string[] | null {
  const value = projection?.sourceFacts["segmentMessageIds"];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function storedStringFact(
  projection: CoreSurfaceProjection | null,
  key: string,
  fallback: string,
): string {
  const value = projection?.sourceFacts[key];
  return typeof value === "string" ? value : fallback;
}

function storedNumberFact(
  projection: CoreSurfaceProjection | null,
  key: string,
  fallback: number,
): number {
  const value = projection?.sourceFacts[key];
  return typeof value === "number" ? value : fallback;
}

function storedProjectionText(projection: CoreSurfaceProjection): string {
  return projection.canonicalMessages
    .flatMap((message) => {
      if (typeof message.content === "string") return [message.content];
      if (!Array.isArray(message.content)) return [];
      return message.content.flatMap((part) =>
        part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      );
    })
    .filter(Boolean)
    .join("\n\n");
}

function surfaceMessageFromStoredProjection(input: {
  projection: CoreSurfaceProjection;
  sessionId: string;
  messageId: string;
}): SurfaceMessage | null {
  const authorId = input.projection.sourceFacts["authorId"];
  const messageTs = input.projection.sourceFacts["messageTs"];
  if (typeof authorId !== "string" || typeof messageTs !== "number") return null;

  const authorName = input.projection.sourceFacts["authorName"];
  return {
    ref: {
      platform: "discord",
      channelId: input.sessionId,
      messageId: input.messageId,
    },
    session: { platform: "discord", channelId: input.sessionId },
    userId: authorId,
    ...(typeof authorName === "string" ? { userName: authorName } : {}),
    text: storedProjectionText(input.projection),
    ts: messageTs,
    raw: { discord: { isChat: true, attachments: [] } },
  };
}

function surfaceMessageFromLinkedTranscript(input: {
  snapshot: TranscriptSnapshot;
  sessionId: string;
  messageId: string;
  botUserId: string;
  botName: string;
}): SurfaceMessage | null {
  const assistant = buildAssistantOnlyMessageFromTranscript(input.snapshot);
  if (!assistant || typeof assistant.content !== "string") return null;

  return {
    ref: {
      platform: "discord",
      channelId: input.sessionId,
      messageId: input.messageId,
    },
    session: { platform: "discord", channelId: input.sessionId },
    userId: input.botUserId,
    userName: input.botName,
    text: assistant.content,
    ts: input.snapshot.updatedTs,
    raw: { discord: { isChat: true, attachments: [] } },
  };
}

function createLayeredDiscordMessageResolver(input: {
  adapter: SurfaceAdapter;
  sessionId: string;
  botUserId: string;
  botName: string;
  transcriptStore?: TranscriptStore;
  ingressMessages?: readonly SurfaceMessage[];
  currentMessageIds?: readonly string[];
}): {
  resolveMessagesByRefs: ResolveDiscordMessagesByRefs;
  projections: ReadonlyMap<string, CoreSurfaceProjection | null>;
} {
  const projectionStore = isProjectionCapableStore(input.transcriptStore)
    ? input.transcriptStore
    : undefined;
  const ingressByMessageId = new Map(
    (input.ingressMessages ?? [])
      .filter(
        (message) =>
          message.ref.platform === "discord" && message.ref.channelId === input.sessionId,
      )
      .map((message) => [message.ref.messageId, message]),
  );
  const projections = new Map<string, CoreSurfaceProjection | null>();
  const linkedTranscripts = new Map<string, TranscriptSnapshot | null>();
  const currentMessageIds = new Set(input.currentMessageIds ?? []);

  const getProjection = (messageId: string): CoreSurfaceProjection | null => {
    if (projections.has(messageId)) return projections.get(messageId) ?? null;
    const stored = projectionStore?.getCoreSurfaceProjection(
      surfaceProjectionKey(input.sessionId, messageId),
    );
    const projection = stored?.match({ ok: (value) => value, err: () => null }) ?? null;
    projections.set(messageId, projection);
    return projection;
  };

  const getLinkedTranscript = (messageId: string): TranscriptSnapshot | null => {
    if (linkedTranscripts.has(messageId)) return linkedTranscripts.get(messageId) ?? null;
    const stored = input.transcriptStore?.getTranscriptBySurfaceMessage({
      platform: "discord",
      channelId: input.sessionId,
      messageId,
    });
    const snapshot =
      stored?.match({
        ok: (value) =>
          value?.requestClient === "discord" && value.sessionId === input.sessionId ? value : null,
        err: () => null,
      }) ?? null;
    linkedTranscripts.set(messageId, snapshot);
    return snapshot;
  };

  const resolveMessagesByRefs: ResolveDiscordMessagesByRefs = async (refs) => {
    const resolvedByMessageId = new Map<string, SurfaceMessage>();
    const refsToFetch: MsgRef[] = [];

    for (const ref of refs) {
      const ingress = ingressByMessageId.get(ref.messageId);
      if (ingress) {
        resolvedByMessageId.set(ref.messageId, ingress);
        continue;
      }

      const projection = getProjection(ref.messageId);
      const projected = projection
        ? surfaceMessageFromStoredProjection({
            projection,
            sessionId: input.sessionId,
            messageId: ref.messageId,
          })
        : null;
      if (projected) {
        resolvedByMessageId.set(ref.messageId, projected);
        continue;
      }

      const snapshot = currentMessageIds.has(ref.messageId)
        ? null
        : getLinkedTranscript(ref.messageId);
      const linked = snapshot
        ? surfaceMessageFromLinkedTranscript({
            snapshot,
            sessionId: input.sessionId,
            messageId: ref.messageId,
            botUserId: input.botUserId,
            botName: input.botName,
          })
        : null;
      if (linked) {
        resolvedByMessageId.set(ref.messageId, linked);
        continue;
      }
      refsToFetch.push(ref);
    }

    const fetched = await mapWithConcurrency({
      items: refsToFetch,
      concurrency: 8,
      run: (ref) => input.adapter.readMsg(ref),
    });
    const fetchedResult = Result.all(fetched);
    const fetchedError = fetchedResult.match({ ok: () => null, err: (error) => error });
    if (fetchedError) return Result.err(fetchedError);
    const fetchedMessages = fetchedResult.match({ ok: (messages) => messages, err: () => [] });
    for (const message of fetchedMessages) {
      if (message) resolvedByMessageId.set(message.ref.messageId, message);
    }

    return Result.ok(
      refs.flatMap((ref) => {
        const message = resolvedByMessageId.get(ref.messageId);
        return message ? [message] : [];
      }),
    );
  };

  return { resolveMessagesByRefs, projections };
}

function collectStoredBoundaryBreaks(input: {
  chain: readonly ReplyChainMessage[];
  sessionId: string;
  projections: ReadonlyMap<string, CoreSurfaceProjection | null>;
  transcriptStore?: TranscriptStore;
}): Set<string> {
  const boundaryKeys = input.chain.map((message) => {
    const stored = input.transcriptStore?.getLatestCoreSurfaceSegment?.(
      surfaceProjectionKey(input.sessionId, message.messageId),
    );
    const storedValue = stored?.match({
      ok: (value) => value,
      err: () => null,
    });
    if (storedValue) return `${storedValue.requestId}:${storedValue.segmentIndex}`;
    const admittedIds = storedProjectionSegmentIds(
      input.projections.get(message.messageId) ?? null,
    );
    return admittedIds ? `admitted:${admittedIds.join("\u0000")}` : null;
  });
  const breaks = new Set<string>();
  for (let index = 1; index < input.chain.length; index += 1) {
    const previous = boundaryKeys[index - 1];
    const current = boundaryKeys[index];
    if ((previous || current) && previous !== current) {
      breaks.add(input.chain[index]!.messageId);
    }
  }
  return breaks;
}

function appendPersistedSyntheticSuffix(input: {
  segmentInputs: StoredLineageSegmentInputV2[];
  requestId: string;
  transcriptStore?: TranscriptStore;
}): boolean {
  const manifest = input.transcriptStore?.getCorePrimaryLineageManifest?.({
    requestId: input.requestId,
  });
  if (!manifest) return true;
  const manifestValue = manifest.match({
    ok: (value) => value,
    err: () => null,
  });
  if (
    !manifestValue ||
    !manifestValue.segments.some((segment) => segment.atoms[0]?.kind === "synthetic")
  ) {
    return true;
  }
  if (input.segmentInputs.length > manifestValue.segments.length) return false;

  const prefixMatches = input.segmentInputs.every((segment, index) => {
    const stored = manifestValue.segments[index];
    return (
      stored !== undefined &&
      isDeepStrictEqual(segment.atoms, stored.atoms) &&
      areCoreCanonicalMessagesIdentityEqualV2(
        segment.canonicalMessages,
        stored.canonicalMessages,
      ) &&
      isDeepStrictEqual(segment.requestSource, stored.requestSource)
    );
  });
  const suffix = manifestValue.segments.slice(input.segmentInputs.length);
  if (!prefixMatches || suffix.some((segment) => segment.atoms[0]?.kind !== "synthetic")) {
    return false;
  }

  input.segmentInputs.push(
    ...suffix.map((segment) => ({
      atoms: segment.atoms,
      canonicalMessages: segment.canonicalMessages,
    })),
  );
  return true;
}

async function renderSurfaceProjectionCandidate(input: {
  message: ReplyChainMessage;
  isBot: boolean;
  sessionId: string;
  reactions: readonly string[];
  discordUserAliasById?: ReadonlyMap<string, string>;
  resourceRegistry?: ResourceRegistry;
}): Promise<
  ResultType<
    {
      messages: StoredMessageV1[];
      ownedBlobs: CoreOwnedBlobReference[];
    },
    RequestCompositionError
  >
> {
  const normalized = normalizeText(input.message.text, {});
  const registered = await registerDiscordResourceParts({
    attachments: input.message.attachments,
    channelId: input.sessionId,
    messageId: input.message.messageId,
    resourceRegistry: input.resourceRegistry,
  });
  return registered.map((resourceParts) => {
    if (input.isBot) {
      const assistantText = normalizeAssistantContextText(normalized);
      return {
        messages: [
          resourceParts.length === 0
            ? { role: "assistant" as const, content: assistantText }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: assistantText }, ...resourceParts],
              },
        ],
        ownedBlobs: [],
      };
    }

    const header = formatDiscordAttributionHeader({
      authorId: input.message.authorId,
      authorName: input.message.authorName,
      userAlias: input.discordUserAliasById?.get(input.message.authorId),
      messageId: input.message.messageId,
      messageTs: input.message.ts,
      reactions: input.reactions,
    });
    const mainText = `${header}\n${escapeSurfaceMetadataTags(normalized)}`.trimEnd();
    return {
      messages: [
        resourceParts.length === 0
          ? { role: "user" as const, content: mainText }
          : {
              role: "user" as const,
              content: [{ type: "text" as const, text: mainText }, ...resourceParts],
            },
      ],
      ownedBlobs: [],
    };
  });
}

async function registerDiscordResourceParts(input: {
  attachments: Readonly<ReplyChainMessage["attachments"]>;
  channelId: string;
  messageId: string;
  resourceRegistry?: ResourceRegistry;
}): Promise<ResultType<StoredResourcePartV1[], ResourceRegistrationError>> {
  if (input.attachments.length === 0) return Result.ok([]);
  if (!input.resourceRegistry) {
    return Result.err(
      new ResourceStoreFailure({
        operation: "register",
        message: "Discord attachment composition requires a ResourceRegistry",
      }),
    );
  }
  const registry = input.resourceRegistry;
  return Result.gen(async function* () {
    const parts: StoredResourcePartV1[] = [];
    for (const [ordinal, attachment] of input.attachments.entries()) {
      const descriptor: ResourceDescriptor = yield* Result.await(
        registry.register({
          origin: {
            version: 1,
            kind: "discord-attachment",
            channelId: input.channelId,
            messageId: input.messageId,
            ordinal,
            ...(attachment.id ? { attachmentId: attachment.id } : {}),
          },
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          ...(attachment.mimeType ? { declaredMediaType: attachment.mimeType } : {}),
          ...(attachment.size !== undefined ? { reportedByteLength: attachment.size } : {}),
        }),
      );
      parts.push({
        type: "resource",
        uri: descriptor.uri,
        ...(descriptor.filename ? { filename: descriptor.filename } : {}),
        ...(descriptor.declaredMediaType ? { mediaType: descriptor.declaredMediaType } : {}),
        ...(descriptor.reportedByteLength !== undefined
          ? { size: descriptor.reportedByteLength }
          : {}),
      });
    }
    return Result.ok(parts);
  });
}

async function composeSelectedDiscordChain(input: {
  adapter: SurfaceAdapter;
  sessionId: string;
  botUserId: string;
  chain: readonly ReplyChainMessage[];
  checkpointSelection: ReturnType<typeof selectNewestReachableCheckpoint<ReplyChainMessage>>;
  currentMessageIds: readonly string[];
  transcriptStore?: TranscriptStore;
  discordUserAliasById?: ReadonlyMap<string, string>;
  blobStore?: BlobStore;
  attachmentCache?: DiscordAttachmentCacheAccess;
  attachmentCacheTtl?: RetentionLimit;
  resourceRegistry?: ResourceRegistry;
  resolvedProjections?: ReadonlyMap<string, CoreSurfaceProjection | null>;
}): Promise<
  ResultType<
    {
      messages: RequestCompositionResult["messages"];
      inputHandles: RequestCompositionResult["inputHandles"];
      mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
      corePrimaryLineage: CorePrimaryLineageV2;
    },
    RequestCompositionError
  >
> {
  const projectionStore = isProjectionCapableStore(input.transcriptStore)
    ? input.transcriptStore
    : undefined;
  const attachmentState = createDiscordAttachmentState({
    blobStore: input.blobStore,
    attachmentCache: input.attachmentCache,
    attachmentCacheTtl: input.attachmentCacheTtl,
    ownStoredBlob: projectionStore
      ? ({ blob, mediaType, filename }) => {
          return projectionStore.putCoreOwnedBlob({
            blob,
            mediaType,
            filename,
          });
        }
      : undefined,
  });
  const outcome = await (async () => {
    const projections = new Map<string, CoreSurfaceProjection | null>();
    for (const message of input.chain) {
      if (input.resolvedProjections?.has(message.messageId)) {
        projections.set(
          message.messageId,
          input.resolvedProjections.get(message.messageId) ?? null,
        );
        continue;
      }
      const stored = projectionStore?.getCoreSurfaceProjection(
        surfaceProjectionKey(input.sessionId, message.messageId),
      );
      projections.set(
        message.messageId,
        stored?.match({ ok: (value) => value, err: () => null }) ?? null,
      );
    }
    const immutableChain = input.chain.map((message) => {
      const projection = projections.get(message.messageId) ?? null;
      if (!projection) return message;
      return {
        ...message,
        authorId: storedStringFact(projection, "authorId", message.authorId),
        authorName: storedStringFact(projection, "authorName", message.authorName),
        ts: storedNumberFact(projection, "messageTs", message.ts),
      };
    });
    const hardBreaks = collectStoredBoundaryBreaks({
      chain: immutableChain,
      sessionId: input.sessionId,
      projections,
      transcriptStore: input.transcriptStore,
    });
    const currentMessageIds = new Set(input.currentMessageIds);
    const firstCurrentMessage = immutableChain.find((message) =>
      currentMessageIds.has(message.messageId),
    );
    if (firstCurrentMessage) hardBreaks.add(firstCurrentMessage.messageId);
    const merged = mergeChainByDiscordWindow(immutableChain, hardBreaks);
    const messageById = new Map(immutableChain.map((message) => [message.messageId, message]));
    const unknownUserRefs = immutableChain
      .filter(
        (message) => message.authorId !== input.botUserId && !projections.get(message.messageId),
      )
      .map(
        (message) =>
          ({
            platform: "discord",
            channelId: input.sessionId,
            messageId: message.messageId,
          }) satisfies MsgRef,
      );
    const reactionsByMessageId = await getReactionsByMessageId({
      adapter: input.adapter,
      refs: unknownUserRefs,
    });
    const reactionsError = reactionsByMessageId.match({
      ok: () => null,
      err: (error) => error,
    });
    if (reactionsError) return { status: "return", value: Result.err(reactionsError) } as const;
    const reactionValues = reactionsByMessageId.match({
      ok: (value) => value,
      err: () => new Map<string, readonly string[]>(),
    });
    const projectedByMessageId = new Map<string, readonly StoredMessageV1[]>();
    const candidateOwnedBlobsByMessageId = new Map<string, readonly CoreOwnedBlobReference[]>();
    let lineageComplete = Boolean(projectionStore);
    const transcriptSnapshotByMessageId = new Map<string, TranscriptSnapshot>();
    const aliasMessageIdsByRequestId = new Map<string, string[]>();
    if (input.transcriptStore) {
      for (const message of immutableChain) {
        if (message.authorId !== input.botUserId) continue;
        const snapshot = resolveTranscriptSnapshot({
          platform: "discord",
          channelId: input.sessionId,
          messageId: message.messageId,
          transcriptStore: input.transcriptStore,
          resolvedSnapshotsBySurfaceMessageId:
            input.checkpointSelection.resolvedSnapshotsBySurfaceMessageId,
        });
        if (!snapshot) continue;
        if (snapshot.requestClient !== "discord" || snapshot.sessionId !== input.sessionId) {
          lineageComplete = false;
          continue;
        }
        transcriptSnapshotByMessageId.set(message.messageId, snapshot);
        const aliases = aliasMessageIdsByRequestId.get(snapshot.requestId) ?? [];
        aliases.push(message.messageId);
        aliasMessageIdsByRequestId.set(snapshot.requestId, aliases);
      }
    }

    for (const chunk of merged) {
      for (const messageId of chunk.messageIds) {
        const stored = projections.get(messageId);
        if (stored) {
          projectedByMessageId.set(messageId, stored.canonicalMessages);
          continue;
        }
        // `merged` is derived from `immutableChain`, so every selected ID has this source entry.
        const source = messageById.get(messageId)!;
        const candidateResult = await renderSurfaceProjectionCandidate({
          message: source,
          isBot: source.authorId === input.botUserId,
          sessionId: input.sessionId,
          reactions: reactionValues.get(messageId) ?? [],
          discordUserAliasById: input.discordUserAliasById,
          resourceRegistry: input.resourceRegistry,
        });
        const candidateError = candidateResult.match({
          ok: () => null,
          err: (error) => error,
        });
        if (candidateError) {
          return {
            status: "return",
            value: Result.err(candidateError),
          } as const;
        }
        const candidate = candidateResult.match<{
          messages: StoredMessageV1[];
          ownedBlobs: CoreOwnedBlobReference[];
        }>({
          ok: (value) => value,
          err: () => ({ messages: [], ownedBlobs: [] }),
        });
        const candidateOwnershipError = getDiscordAttachmentOwnershipError(attachmentState);
        if (candidateOwnershipError) {
          return {
            status: "return",
            value: Result.err(candidateOwnershipError),
          } as const;
        }
        if (!projectionStore) {
          projectedByMessageId.set(messageId, candidate.messages);
          continue;
        }
        projectedByMessageId.set(messageId, candidate.messages);
        candidateOwnedBlobsByMessageId.set(messageId, candidate.ownedBlobs);
      }

      const projectionSegmentIdsByMessageId = new Map<string, readonly string[]>();
      if (chunk.authorId !== input.botUserId) {
        for (const messageId of chunk.messageIds) {
          projectionSegmentIdsByMessageId.set(messageId, chunk.messageIds);
        }
      } else {
        let unresolvedIds: string[] = [];
        const flushUnresolved = (): void => {
          for (const unresolvedId of unresolvedIds) {
            projectionSegmentIdsByMessageId.set(unresolvedId, unresolvedIds);
          }
          unresolvedIds = [];
        };
        for (const messageId of chunk.messageIds) {
          if (transcriptSnapshotByMessageId.has(messageId)) {
            flushUnresolved();
            projectionSegmentIdsByMessageId.set(messageId, [messageId]);
          } else {
            unresolvedIds.push(messageId);
          }
        }
        flushUnresolved();
      }
      for (const messageId of chunk.messageIds) {
        if (projections.get(messageId) || !projectionStore) continue;
        const source = messageById.get(messageId)!;
        const segmentMessageIds = projectionSegmentIdsByMessageId.get(messageId) ?? [messageId];
        const segmentMessages = mergeProjectedSurfaceMessages(
          segmentMessageIds.flatMap((id) => projectedByMessageId.get(id) ?? []),
        );
        const segmentDigestResult = hashCanonicalStoredMessagesV2(segmentMessages);
        const segmentDigestError = segmentDigestResult.match({
          ok: () => null,
          err: (error) => error,
        });
        if (segmentDigestError) {
          return {
            status: "return",
            value: Result.err(segmentDigestError),
          } as const;
        }
        const segmentDigest = segmentDigestResult.match({
          ok: (value) => value.hash,
          err: () => "",
        });
        const admitted = projectionStore.admitCoreSurfaceProjection({
          ...surfaceProjectionKey(input.sessionId, messageId),
          canonicalMessages: projectedByMessageId.get(messageId) ?? [],
          sourceFacts: {
            authorId: source.authorId,
            authorName: source.authorName,
            messageTs: source.ts,
            reactions: [...(reactionValues.get(messageId) ?? [])],
            segmentMessageIds: [...segmentMessageIds],
            segmentDigest,
          },
          ownedBlobs: candidateOwnedBlobsByMessageId.get(messageId) ?? [],
        });
        const admittedValue = admitted.match({
          ok: (value) => value,
          err: () => null,
        });
        if (!admittedValue) {
          lineageComplete = false;
          continue;
        }
        projectedByMessageId.set(messageId, admittedValue.canonicalMessages);
      }
    }

    const segmentInputs: StoredLineageSegmentInputV2[] = [];
    if (input.checkpointSelection.checkpoint) {
      const checkpoint = input.checkpointSelection.checkpoint;
      const checkpointDigestResult = hashCanonicalStoredMessagesV2(checkpoint.messages);
      const checkpointDigestError = checkpointDigestResult.match({
        ok: () => null,
        err: (error) => error,
      });
      if (!checkpoint.transcriptDigest && checkpointDigestError) {
        return {
          status: "return",
          value: Result.err(checkpointDigestError),
        } as const;
      }
      const digest =
        checkpoint.transcriptDigest ??
        checkpointDigestResult.match({
          ok: (value) => value.hash,
          err: () => "",
        });
      segmentInputs.push({
        atoms: [
          {
            kind: "checkpoint",
            requestId: checkpoint.requestId,
            transcriptDigest: digest,
          },
        ],
        canonicalMessages: checkpoint.messages,
      });
    }

    const seenRequestIds = new Set<string>(
      input.checkpointSelection.checkpoint ? [input.checkpointSelection.checkpoint.requestId] : [],
    );
    for (const chunk of merged) {
      const appendSurfaceSegment = (messageIds: readonly string[]): void => {
        if (messageIds.length === 0) return;
        const atoms = messageIds.map(
          (messageId) =>
            ({
              kind: "surface",
              requestClient: "discord",
              surfaceId: surfaceIdForDiscordSession(input.sessionId),
              sessionId: input.sessionId,
              messageId,
            }) satisfies CoreLineageAtomV2,
        );
        const canonicalMessages = mergeProjectedSurfaceMessages(
          messageIds.flatMap((messageId) => projectedByMessageId.get(messageId) ?? []),
        );
        const segment = { atoms, canonicalMessages };
        segmentInputs.push(segment);
      };

      const pendingSurfaceIds: string[] = [];
      for (const messageId of chunk.messageIds) {
        const snapshot = transcriptSnapshotByMessageId.get(messageId);
        if (!snapshot || snapshot.messages.length === 0) {
          pendingSurfaceIds.push(messageId);
          continue;
        }
        appendSurfaceSegment(pendingSurfaceIds.splice(0));
        if (seenRequestIds.has(snapshot.requestId)) continue;

        seenRequestIds.add(snapshot.requestId);
        if (
          !appendPersistedSyntheticSuffix({
            segmentInputs,
            requestId: snapshot.requestId,
            transcriptStore: input.transcriptStore,
          })
        ) {
          lineageComplete = false;
        }
        const metadata = input.transcriptStore?.getCoreRequestAtomMetadata?.({
          requestId: snapshot.requestId,
        });
        const metadataValue = metadata?.match({ ok: (value) => value, err: () => null }) ?? null;
        if (!metadataValue) lineageComplete = false;
        const snapshotDigestResult = hashCanonicalStoredMessagesV2(snapshot.messages);
        const snapshotDigestError = snapshotDigestResult.match({
          ok: () => null,
          err: (error) => error,
        });
        if (!metadataValue?.transcriptDigest && !snapshot.transcriptDigest && snapshotDigestError) {
          return {
            status: "return",
            value: Result.err(snapshotDigestError),
          } as const;
        }
        const requestAtom: CoreLineageAtomV2 = {
          kind: "request",
          requestId: snapshot.requestId,
          transcriptDigest:
            metadataValue?.transcriptDigest ??
            snapshot.transcriptDigest ??
            snapshotDigestResult.match({
              ok: (value) => value.hash,
              err: () => "",
            }),
          providerFamily:
            metadataValue?.providerFamily ?? snapshot.providerState?.lastFamily ?? "ai-sdk",
          containsCrossFamilyTurns:
            metadataValue?.containsCrossFamilyTurns ??
            snapshot.providerState?.containsCrossFamilyTurns ??
            true,
        };
        const aliases = [...new Set(aliasMessageIdsByRequestId.get(snapshot.requestId) ?? [])].map(
          (aliasMessageId) => ({
            requestClient: "discord",
            surfaceId: surfaceIdForDiscordSession(input.sessionId),
            sessionId: input.sessionId,
            messageId: aliasMessageId,
          }),
        );
        segmentInputs.push({
          atoms: [requestAtom],
          canonicalMessages: snapshot.messages,
          requestSource: { aliases },
        });
      }
      appendSurfaceSegment(pendingSurfaceIds);
    }

    const messages: StoredMessageV1[] = segmentInputs.flatMap(
      (segment) => segment.canonicalMessages,
    );
    const currentSegmentIndex = segmentInputs.findIndex((segment) =>
      segment.atoms.some(
        (atom) => atom.kind === "surface" && currentMessageIds.has(atom.messageId),
      ),
    );
    if (currentSegmentIndex < 0) lineageComplete = false;
    const currentCanonicalStart =
      currentSegmentIndex < 0
        ? Math.max(
            0,
            messages.findLastIndex((message) => message.role === "user"),
          )
        : segmentInputs
            .slice(0, currentSegmentIndex)
            .reduce((count, segment) => count + segment.canonicalMessages.length, 0);
    const hasEmptyLineageSegment = segmentInputs.some(
      (segment) => segment.canonicalMessages.length === 0,
    );
    let corePrimaryLineage: CorePrimaryLineageV2;
    if (lineageComplete && segmentInputs.length > 0 && !hasEmptyLineageSegment) {
      const built = buildCoreLineageManifestV2(segmentInputs, {
        currentSegmentIndex,
      });
      corePrimaryLineage = built.match({
        ok: (value) => value,
        err: () => createFreshOnlyLineage("lineage-manifest-build-failed", currentCanonicalStart),
      });
    } else {
      let reason: Parameters<typeof createCorePrimaryLineageFreshOnlyV2>[0];
      if (hasEmptyLineageSegment) {
        reason = "empty-lineage-segment";
      } else if (currentSegmentIndex < 0) {
        reason = "current-input-boundary-unreachable";
      } else if (projectionStore) {
        reason = "incomplete-request-metadata";
      } else {
        reason = "projection-store-unavailable";
      }
      corePrimaryLineage = createFreshOnlyLineage(reason, currentCanonicalStart);
    }
    const ownershipError = getDiscordAttachmentOwnershipError(attachmentState);
    if (ownershipError) return { status: "return", value: Result.err(ownershipError) } as const;
    const preparedMessages: BusMessageV2[] = [];
    for (const segment of segmentInputs) {
      const prepared = await prepareStoredMessagesForBus({
        blobStore: input.blobStore,
        messages: segment.canonicalMessages,
      });
      const preparationError = prepared.match({
        ok: () => null,
        err: (error) => error,
      });
      if (preparationError) {
        return {
          status: "return",
          value: Result.err(preparationError),
        } as const;
      }
      prepared.match({
        ok: (value) => {
          rememberDiscordRequestBlobHandles(attachmentState, value.inputHandles);
          preparedMessages.push(...value.messages);
        },
        err: () => undefined,
      });
    }
    return {
      status: "return",
      value: Result.ok({
        messages: preparedMessages,
        inputHandles: [...getDiscordRequestBlobHandles(attachmentState)],
        mergedGroups: merged.map((chunk) => ({
          authorId: chunk.authorId,
          messageIds: [...chunk.messageIds],
        })),
        corePrimaryLineage,
      }),
    } as const;
  })().finally(() => {
    if (projectionStore) {
      for (const reference of getDiscordOwnedBlobReferences(attachmentState)) {
        const deleted = projectionStore.deleteCoreOwnedBlobIfUnreferenced({
          ownerId: reference.ownerId,
        });
        if (deleted && input.blobStore) void input.blobStore.delete(deleted);
      }
    }
  });
  const compositionResult: ResultType<
    {
      messages: RequestCompositionResult["messages"];
      inputHandles: RequestCompositionResult["inputHandles"];
      mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
      corePrimaryLineage: CorePrimaryLineageV2;
    },
    RequestCompositionPrimaryError
  > = outcome.value;
  const cleanupFailedComposition = compositionResult.match<
    () => Promise<
      ResultType<
        {
          messages: RequestCompositionResult["messages"];
          inputHandles: RequestCompositionResult["inputHandles"];
          mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
          corePrimaryLineage: CorePrimaryLineageV2;
        },
        RequestCompositionError
      >
    >
  >({
    ok: (value) => async () => Result.ok(value),
    err: (error) => async () => {
      if (input.blobStore) {
        const cleanup = await deleteDiscordRequestBlobHandles(
          input.blobStore,
          getDiscordRequestBlobHandles(attachmentState),
        );
        return cleanup.match<ResultType<never, RequestCompositionError>>({
          ok: () => Result.err(error),
          err: (cleanupError) =>
            Result.err(
              new DiscordRequestCompositionAndCleanupFailed({
                primary: error,
                cleanup: cleanupError,
                message: "Discord request composition and input handle cleanup failed",
              }),
            ),
        });
      }
      return Result.err(error);
    },
  });
  return cleanupFailedComposition();
}

function resolveTranscriptSnapshot(input: {
  messageId: string;
  platform: "discord";
  channelId: string;
  transcriptStore: TranscriptStore;
  resolvedSnapshotsBySurfaceMessageId: ReadonlyMap<string, TranscriptSnapshot | null>;
}): TranscriptSnapshot | null {
  if (input.resolvedSnapshotsBySurfaceMessageId.has(input.messageId)) {
    return input.resolvedSnapshotsBySurfaceMessageId.get(input.messageId) ?? null;
  }

  const transcript = input.transcriptStore.getTranscriptBySurfaceMessage({
    platform: input.platform,
    channelId: input.channelId,
    messageId: input.messageId,
  });
  return transcript.match({ ok: (value) => value, err: () => null });
}

function shouldIncludeInModelContext(msg: SurfaceMessage): boolean {
  // Listing and surface tools may include platform/system messages (e.g. Discord
  // thread-created notices). By default, do not send those to the model.
  if (msg.session.platform !== "discord") return true;

  const isChat = normalizeDiscordRaw(msg.raw)?.isChat;
  return isChat ?? true;
}

function applyUserTextTransformToReplyChainMessage(input: {
  message: ReplyChainMessage;
  transformUserText?: (text: string) => string;
  shouldTransform: boolean;
}): ReplyChainMessage {
  const { message, transformUserText, shouldTransform } = input;
  if (!shouldTransform || !transformUserText) return message;

  const text = transformUserText(message.text);

  return {
    ...message,
    text,
  };
}

function toReplyChainMessageForModelContext(input: {
  message: SurfaceMessage;
  botUserId: string;
  triggerMessageId?: string;
  transformUserText?: (text: string) => string;
}): ReplyChainMessage {
  const base = toReplyChainMessage(input.message);
  return applyUserTextTransformToReplyChainMessage({
    message: base,
    transformUserText: input.transformUserText,
    shouldTransform:
      input.message.userId !== input.botUserId &&
      typeof input.triggerMessageId === "string" &&
      input.message.ref.messageId === input.triggerMessageId,
  });
}

function getSurfaceMessageContextText(message: SurfaceMessage): string {
  return message.text.trim().length > 0
    ? message.text
    : (getForwardSnapshotTextFromRaw(message.raw) ?? message.text);
}

function shouldApplyContinueDirectiveToSurfaceMessage(message: SurfaceMessage): boolean {
  return normalizeDiscordRaw(message.raw)?.replyReference === undefined;
}

function stripContinueDirectiveFromReplyChainMessage(input: {
  message: ReplyChainMessage;
  botUserId: string;
  botMentionNames: readonly string[];
}): ReplyChainMessage {
  if (input.message.authorId === input.botUserId) return input.message;

  const stripped = stripLeadingContinueDirective({
    text: input.message.text,
    botNames: input.botMentionNames,
  });
  if (stripped === input.message.text) return input.message;

  return {
    ...input.message,
    text: stripped,
  };
}

function findVisibleContinueDirectives(input: {
  selected: readonly SurfaceMessage[];
  selectedStartIndex: number;
  botUserId: string;
  botMentionNames: readonly string[];
}): VisibleContinueDirectives | null {
  let desiredFloorIndex: number | null = null;

  for (let i = 0; i < input.selected.length; i++) {
    const message = input.selected[i]!;
    if (message.userId === input.botUserId) continue;
    if (!shouldApplyContinueDirectiveToSurfaceMessage(message)) continue;

    const count = parseLeadingContinueDirective({
      text: getSurfaceMessageContextText(message),
      botNames: input.botMentionNames,
    });
    if (count === undefined) continue;

    const messageAbsoluteIndex = input.selectedStartIndex + i;
    const messageDesiredFloorIndex = messageAbsoluteIndex - count;
    desiredFloorIndex =
      desiredFloorIndex === null
        ? messageDesiredFloorIndex
        : Math.min(desiredFloorIndex, messageDesiredFloorIndex);
  }

  return desiredFloorIndex === null ? null : { desiredFloorIndex };
}

async function listRecentMessagesEndingAt(params: {
  adapter: SurfaceAdapter;
  sessionId: string;
  anchor: SurfaceMessage;
  maxPreviousMessages: number;
  previousMessageTargets?: readonly number[];
  shouldContinue?: (input: {
    collected: readonly SurfaceMessage[];
    exhausted: boolean;
    fetchedPreviousMessages: number;
  }) => boolean;
}): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
  const sessionRef = {
    platform: "discord",
    channelId: params.sessionId,
  } as const;

  const previousMessageTargets = (() => {
    const requested = params.previousMessageTargets ?? [params.maxPreviousMessages];
    const normalized = requested
      .map((target) => Math.min(params.maxPreviousMessages, Math.max(0, Math.floor(target))))
      .filter((target, index, list) => target > 0 && list.indexOf(target) === index)
      .sort((a, b) => a - b);

    if (
      normalized.length === 0 ||
      normalized[normalized.length - 1] !== params.maxPreviousMessages
    ) {
      normalized.push(params.maxPreviousMessages);
    }

    return normalized;
  })();

  const seen = new Set<string>([params.anchor.ref.messageId]);
  const collected: SurfaceMessage[] = [params.anchor];
  let cursor: string | undefined = params.anchor.ref.messageId;
  let remaining = Math.max(0, params.maxPreviousMessages);
  let fetchedPreviousMessages = 0;
  let exhausted = false;

  const getSortedCollected = () =>
    collected
      .slice()
      .sort((a, b) =>
        compareDiscordMsgPosition(
          { ts: a.ts, messageId: a.ref.messageId },
          { ts: b.ts, messageId: b.ref.messageId },
        ),
      );

  for (const target of previousMessageTargets) {
    while (cursor && fetchedPreviousMessages < target && remaining > 0) {
      const page = await params.adapter.listMsg(sessionRef, {
        limit: Math.min(100, remaining, target - fetchedPreviousMessages),
        beforeMessageId: cursor,
      });
      const pageError = page.match({ ok: () => null, err: (error) => error });
      if (pageError) return Result.err(pageError);
      const pageValues = page.match({ ok: (value) => value, err: () => [] });
      if (pageValues.length === 0) {
        exhausted = true;
        cursor = undefined;
        break;
      }

      let oldestInPage: SurfaceMessage | null = null;
      let addedAny = false;

      for (const message of pageValues) {
        if (message.session.channelId !== params.sessionId) continue;
        if (seen.has(message.ref.messageId)) continue;
        seen.add(message.ref.messageId);
        collected.push(message);
        addedAny = true;
        fetchedPreviousMessages += 1;
        remaining -= 1;

        if (
          !oldestInPage ||
          compareDiscordMsgPosition(
            { ts: message.ts, messageId: message.ref.messageId },
            { ts: oldestInPage.ts, messageId: oldestInPage.ref.messageId },
          ) < 0
        ) {
          oldestInPage = message;
        }

        if (remaining <= 0 || fetchedPreviousMessages >= target) break;
      }

      if (!addedAny || !oldestInPage) {
        exhausted = true;
        cursor = undefined;
        break;
      }
      if (oldestInPage.ref.messageId === cursor) {
        exhausted = true;
        cursor = undefined;
        break;
      }
      cursor = oldestInPage.ref.messageId;
    }

    if (
      params.shouldContinue &&
      !params.shouldContinue({
        collected: getSortedCollected(),
        exhausted,
        fetchedPreviousMessages,
      })
    ) {
      return Result.ok(getSortedCollected());
    }

    if (exhausted || remaining <= 0) break;
  }

  return Result.ok(getSortedCollected());
}

function compareDiscordSnowflakeLike(a: string, b: string): number {
  {
    const attempt = Result.try({
      try: () => {
        const ai = BigInt(a);
        const bi = BigInt(b);
        if (ai < bi) return -1;
        if (ai > bi) return 1;
        return 0;
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      return a.localeCompare(b);
    }
    return attempt.value;
  }
}

function compareDiscordMsgPosition(
  a: { ts: number; messageId: string },
  b: { ts: number; messageId: string },
): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return compareDiscordSnowflakeLike(a.messageId, b.messageId);
}

const ACTIVE_BURST_HISTORY_CAP = 200;
const ACTIVE_BURST_HISTORY_TARGETS = [16, 48, 112, ACTIVE_BURST_HISTORY_CAP] as const;
const ACTIVE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const ACTIVE_MAX_GAP_MS = 2 * 60 * 60 * 1000;

type ActiveBurstSelection = {
  selected: SurfaceMessage[];
  dividerBoundaryReached: boolean;
  hitAgeCutoff: boolean;
  hitGapCutoff: boolean;
  hasVisibleContinue: boolean;
  unresolvedContinue: boolean;
};

type VisibleContinueDirectives = {
  desiredFloorIndex: number;
};

function filterMessagesUpToAnchor(input: {
  list: readonly SurfaceMessage[];
  anchor: SurfaceMessage;
}): SurfaceMessage[] {
  const anchorTs = input.anchor.ts;
  const anchorId = input.anchor.ref.messageId;

  return input.list.filter((message) => {
    if (message.ts < anchorTs) return true;
    if (message.ts > anchorTs) return false;
    return compareDiscordSnowflakeLike(message.ref.messageId, anchorId) <= 0;
  });
}

function selectActiveBurstMessages(input: {
  contextList: readonly SurfaceMessage[];
  activeAnchor: SurfaceMessage;
  limit: number;
  botUserId: string;
  botMentionNames: readonly string[];
}): ActiveBurstSelection {
  const eligibleToAnchor = filterMessagesUpToAnchor({
    list: input.contextList,
    anchor: input.activeAnchor,
  });

  const eligible = applyDiscordSessionDividerCutoff({
    listOldestToNewest: eligibleToAnchor,
    botUserId: input.botUserId,
  });

  const dividerBoundaryReached = eligible.length !== eligibleToAnchor.length;
  const anchorId = input.activeAnchor.ref.messageId;
  const anchorTs = input.activeAnchor.ts;
  const anchorIndex = eligible.findIndex((message) => message.ref.messageId === anchorId);
  const startIndex = anchorIndex >= 0 ? anchorIndex : eligible.length - 1;

  if (startIndex < 0) {
    return {
      selected: [],
      dividerBoundaryReached,
      hitAgeCutoff: false,
      hitGapCutoff: false,
      hasVisibleContinue: false,
      unresolvedContinue: false,
    };
  }

  const pickedNewestToOldest: SurfaceMessage[] = [];
  let hitAgeCutoff = false;
  let hitGapCutoff = false;

  let prev = eligible[startIndex] ?? null;
  if (prev) pickedNewestToOldest.push(prev);

  for (let i = startIndex - 1; i >= 0 && pickedNewestToOldest.length < input.limit; i--) {
    const cur = eligible[i]!;

    const ageMs = anchorTs - cur.ts;
    if (ageMs > ACTIVE_MAX_AGE_MS) {
      hitAgeCutoff = true;
      break;
    }

    const gapMs = (prev?.ts ?? anchorTs) - cur.ts;
    if (gapMs > ACTIVE_MAX_GAP_MS) {
      hitGapCutoff = true;
      break;
    }

    pickedNewestToOldest.push(cur);
    prev = cur;
  }

  const provisionalSelected = pickedNewestToOldest.reverse();
  const provisionalStartIndex = Math.max(0, startIndex - (provisionalSelected.length - 1));
  let selected = provisionalSelected;
  let selectedStartIndex = provisionalStartIndex;
  let hasVisibleContinue = false;
  let unresolvedContinue = false;

  while (selected.length > 0) {
    const visibleContinueDirectives = findVisibleContinueDirectives({
      selected,
      selectedStartIndex,
      botUserId: input.botUserId,
      botMentionNames: input.botMentionNames,
    });

    if (!visibleContinueDirectives) break;

    hasVisibleContinue = true;
    unresolvedContinue ||= visibleContinueDirectives.desiredFloorIndex < 0;

    const nextSelectedStartIndex = Math.max(0, visibleContinueDirectives.desiredFloorIndex);
    if (nextSelectedStartIndex === selectedStartIndex) break;

    selectedStartIndex = nextSelectedStartIndex;
    selected = eligible.slice(selectedStartIndex, startIndex + 1);
  }

  if (!hasVisibleContinue) {
    return {
      selected: provisionalSelected,
      dividerBoundaryReached,
      hitAgeCutoff,
      hitGapCutoff,
      hasVisibleContinue: false,
      unresolvedContinue: false,
    };
  }

  return {
    selected,
    dividerBoundaryReached,
    hitAgeCutoff,
    hitGapCutoff,
    hasVisibleContinue,
    unresolvedContinue,
  };
}

function shouldContinueLoadingActiveBurstHistory(input: {
  selection: ActiveBurstSelection;
  exhausted: boolean;
  limit: number;
}): boolean {
  if (input.exhausted) return false;
  if (input.selection.dividerBoundaryReached) return false;
  if (input.selection.unresolvedContinue) return true;
  if (input.selection.hasVisibleContinue) return false;
  if (input.selection.selected.length >= input.limit) return false;
  if (input.selection.hitAgeCutoff || input.selection.hitGapCutoff) return false;
  return true;
}

function applyDiscordSessionDividerCutoff(params: {
  listOldestToNewest: readonly SurfaceMessage[];
  botUserId: string;
}): SurfaceMessage[] {
  const { listOldestToNewest, botUserId } = params;

  let lastDividerIndex = -1;
  for (let i = 0; i < listOldestToNewest.length; i++) {
    const m = listOldestToNewest[i]!;
    if (isDiscordSessionDividerSurfaceMessage(m, botUserId)) {
      lastDividerIndex = i;
    }
  }

  if (lastDividerIndex < 0) return [...listOldestToNewest];
  return listOldestToNewest.slice(lastDividerIndex + 1);
}

function applyDiscordSessionDividerCutoffToReplyChain(params: {
  chainOldestToNewest: readonly ReplyChainMessage[];
  botUserId: string;
}): ReplyChainMessage[] {
  let lastDividerIndex = -1;
  for (let i = 0; i < params.chainOldestToNewest.length; i++) {
    const message = params.chainOldestToNewest[i]!;
    if (message.authorId === params.botUserId && isDiscordSessionDividerText(message.text)) {
      lastDividerIndex = i;
    }
  }
  return lastDividerIndex < 0
    ? [...params.chainOldestToNewest]
    : params.chainOldestToNewest.slice(lastDividerIndex + 1);
}

async function findLastDiscordSessionDividerBefore(params: {
  adapter: SurfaceAdapter;
  messageCache?: DiscordMessageCacheAccess;
  channelId: string;
  botUserId: string;
  beforeMessageId: string;
  beforeTs: number;
  stopAt?: { messageId: string; ts: number };
}): Promise<SurfaceOperationResult<{ ts: number; messageId: string } | null>> {
  if (params.messageCache) {
    let before = { messageId: params.beforeMessageId, ts: params.beforeTs };
    let scanned = 0;
    const maxMessages = 2000;
    const pageSize = 200;

    while (scanned < maxMessages) {
      const page = params.messageCache.listIndexedMessagesBefore({
        channelId: params.channelId,
        before,
        limit: Math.min(pageSize, maxMessages - scanned),
      });
      if (page.length === 0) return Result.ok(null);
      scanned += page.length;

      let newestDivider: { ts: number; messageId: string } | null = null;
      for (const message of page) {
        if (message.userId !== params.botUserId || !isDiscordSessionDividerText(message.text)) {
          continue;
        }
        const position = { ts: message.ts, messageId: message.ref.messageId };
        if (params.stopAt && compareDiscordMsgPosition(position, params.stopAt) <= 0) continue;
        if (!newestDivider || compareDiscordMsgPosition(newestDivider, position) < 0) {
          newestDivider = position;
        }
      }
      if (newestDivider) return Result.ok(newestDivider);

      const oldest = page[0]!;
      before = { ts: oldest.ts, messageId: oldest.ref.messageId };
      if (params.stopAt && compareDiscordMsgPosition(before, params.stopAt) <= 0) {
        return Result.ok(null);
      }
    }
    return Result.ok(null);
  }

  const sessionRef = {
    platform: "discord",
    channelId: params.channelId,
  } as const;
  let cursor: string | undefined = params.beforeMessageId;
  let scanned = 0;
  const maxMessages = 2000;
  const pageSize = 200;

  while (cursor && scanned < maxMessages) {
    const page = await params.adapter.listMsg(sessionRef, {
      limit: Math.min(pageSize, maxMessages - scanned),
      beforeMessageId: cursor,
    });
    const pageError = page.match({ ok: () => null, err: (error) => error });
    if (pageError) return Result.err(pageError);
    const pageValues = page.match({ ok: (value) => value, err: () => [] });
    if (pageValues.length === 0) return Result.ok(null);
    scanned += pageValues.length;

    let newestDivider: { ts: number; messageId: string } | null = null;
    for (const message of pageValues) {
      if (!isDiscordSessionDividerSurfaceMessage(message, params.botUserId)) continue;
      const position = { ts: message.ts, messageId: message.ref.messageId };
      if (!newestDivider || compareDiscordMsgPosition(newestDivider, position) < 0) {
        newestDivider = position;
      }
    }
    if (newestDivider) return Result.ok(newestDivider);
    if (
      params.stopAt &&
      pageValues.some((message) => message.ref.messageId === params.stopAt?.messageId)
    ) {
      return Result.ok(null);
    }

    let oldest = pageValues[0]!;
    for (const message of pageValues) {
      if (
        compareDiscordMsgPosition(
          { ts: message.ts, messageId: message.ref.messageId },
          { ts: oldest.ts, messageId: oldest.ref.messageId },
        ) < 0
      ) {
        oldest = message;
      }
    }
    if (oldest.ref.messageId === cursor) return Result.ok(null);
    cursor = oldest.ref.messageId;
  }

  return Result.ok(null);
}

async function mapWithConcurrency<T, R>(input: {
  items: readonly T[];
  concurrency: number;
  run: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
  const { items, run } = input;
  const concurrency = Math.max(1, Math.floor(input.concurrency));

  const out = Array.from({ length: items.length }) as R[];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;

      out[i] = await run(items[i]!, i);
    }
  });

  await Promise.all(workers);
  return out;
}

async function getReactionsByMessageId(input: {
  adapter: SurfaceAdapter;
  refs: readonly MsgRef[];
  concurrency?: number;
}): Promise<SurfaceOperationResult<Map<string, readonly string[]>>> {
  const out = new Map<string, readonly string[]>();
  if (input.refs.length === 0) return Result.ok(out);

  const rows = await mapWithConcurrency({
    items: input.refs,
    concurrency: input.concurrency ?? 8,
    run: async (ref) => {
      const reactions = await input.adapter.listReactions(ref);
      return { messageId: ref.messageId, reactions };
    },
  });

  for (const row of rows) {
    out.set(row.messageId, row.reactions.match({ ok: (value) => value, err: () => [] }));
  }

  return Result.ok(out);
}

/**
 * Build request `ModelMessage[]` with reply-chain + merge-window parity.
 *
 * This intentionally uses the adapter interface so the router does not need
 * direct Discord API access.
 */
export async function composeRequestMessages(
  adapter: SurfaceAdapter,
  opts: ComposeRequestOpts,
  requestReadScope?: typeof ACTIVE_REQUEST_READ_SCOPE,
): Promise<ResultType<RequestCompositionResult, RequestCompositionError>> {
  if (requestReadScope !== ACTIVE_REQUEST_READ_SCOPE) {
    return withSurfaceRequestReadScope(adapter, () =>
      composeRequestMessages(adapter, opts, ACTIVE_REQUEST_READ_SCOPE),
    );
  }
  const layered = createLayeredDiscordMessageResolver({
    adapter,
    sessionId: opts.trigger.msgRef.channelId,
    botUserId: opts.botUserId,
    botName: opts.botName,
    transcriptStore: opts.transcriptStore,
    ingressMessages: opts.ingressMessages,
    currentMessageIds: opts.currentMessageIds ?? [opts.trigger.msgRef.messageId],
  });
  const triggerMsg = await layered
    .resolveMessagesByRefs([opts.trigger.msgRef])
    .then((resolved) => resolved.map((messages) => messages[0] ?? null));
  const triggerError = triggerMsg.match({
    ok: () => null,
    err: (error) => error,
  });
  if (triggerError) return Result.err(triggerError);
  const triggerValue = triggerMsg.match({
    ok: (value) => value,
    err: () => null,
  });
  if (!triggerValue) {
    return Result.ok({
      messages: [],
      inputHandles: [],
      chainMessageIds: [],
      mergedGroups: [],
      corePrimaryLineage: createFreshOnlyLineage("empty-selection"),
    });
  }

  const chainResult =
    opts.trigger.type === "mention"
      ? await fetchMentionThreadContext(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          triggerMsg: triggerValue,
          maxDepth: opts.maxDepth,
          resolveMessagesByRefs: layered.resolveMessagesByRefs,
        })
      : await fetchReplyChainFrom(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          trigger: opts.trigger,
          startMsgRef: opts.trigger.msgRef,
          maxDepth: opts.maxDepth,
          resolveMessagesByRefs: layered.resolveMessagesByRefs,
        });
  const chainError = chainResult.match({
    ok: () => null,
    err: (error) => error,
  });
  if (chainError) return Result.err(chainError);
  const chain = chainResult.match({ ok: (value) => value, err: () => [] });

  const filteredChain = chain.filter((m) => {
    const isChat = m.isChat;
    if (!(isChat ?? true)) return false;
    return !isDiscordSessionDividerText(m.text);
  });

  const transformedChain = filteredChain.map((m) => {
    const targetMessageId = opts.transformUserTextForMessageId ?? opts.trigger.msgRef.messageId;
    const transformed = applyUserTextTransformToReplyChainMessage({
      message: m,
      transformUserText: opts.transformUserText,
      shouldTransform: m.authorId !== opts.botUserId && m.messageId === targetMessageId,
    });

    return stripContinueDirectiveFromReplyChainMessage({
      message: transformed,
      botUserId: opts.botUserId,
      botMentionNames: [opts.botName],
    });
  });

  // IMPORTANT: session divider cutoff intentionally does NOT apply to explicit reply/mention
  // chains. If the user replies to (or mentions within) an assistant message after a divider,
  // they are explicitly re-opening that thread; we keep the full linked chain.
  // Divider markers are still always excluded from model context.

  const checkpointSelection = selectNewestReachableCheckpoint({
    chainOldestToNewest: transformedChain,
    botUserId: opts.botUserId,
    platform: opts.platform,
    channelId: opts.trigger.msgRef.channelId,
    transcriptStore: opts.transcriptStore,
    currentRequestId: opts.currentRequestId,
    getAuthorId: (message) => message.authorId,
    getMessageId: (message) => message.messageId,
  });

  const composed = await composeSelectedDiscordChain({
    adapter,
    sessionId: opts.trigger.msgRef.channelId,
    botUserId: opts.botUserId,
    chain: checkpointSelection.descendants,
    checkpointSelection,
    currentMessageIds: opts.currentMessageIds ?? [opts.trigger.msgRef.messageId],
    transcriptStore: opts.transcriptStore,
    discordUserAliasById: opts.discordUserAliasById,
    blobStore: opts.blobStore,
    attachmentCache: opts.attachmentCache,
    attachmentCacheTtl: opts.attachmentCacheTtl,
    resourceRegistry: opts.resourceRegistry,
    resolvedProjections: layered.projections,
  });
  return composed.map((value) => ({
    messages: value.messages,
    inputHandles: value.inputHandles,
    chainMessageIds: transformedChain.map((m) => m.messageId),
    mergedGroups: value.mergedGroups,
    corePrimaryLineage: value.corePrimaryLineage,
  }));
}

export async function composeRecentChannelMessages(
  adapter: SurfaceAdapter,
  opts: ComposeRecentChannelMessagesOpts,
  requestReadScope?: typeof ACTIVE_REQUEST_READ_SCOPE,
): Promise<ResultType<RequestCompositionResult, RequestCompositionError>> {
  if (requestReadScope !== ACTIVE_REQUEST_READ_SCOPE) {
    return withSurfaceRequestReadScope(adapter, () =>
      composeRecentChannelMessages(adapter, opts, ACTIVE_REQUEST_READ_SCOPE),
    );
  }
  const layered = createLayeredDiscordMessageResolver({
    adapter,
    sessionId: opts.sessionId,
    botUserId: opts.botUserId,
    botName: opts.botName,
    transcriptStore: opts.transcriptStore,
    ingressMessages: opts.ingressMessages,
    currentMessageIds:
      opts.currentMessageIds ?? (opts.triggerMsgRef ? [opts.triggerMsgRef.messageId] : []),
  });
  // Reply precedence: a mention burst keeps its existing "any reply in the
  // burst" behavior. An active-channel trigger only checks the ingress head.
  //
  // IMPORTANT: this bypasses active-burst guardrails (age/gap/transcript-age).
  // A reply is a strong "continue" signal.
  if (opts.triggerMsgRef && opts.triggerType !== "reply") {
    const triggerMsgResult = await layered
      .resolveMessagesByRefs([opts.triggerMsgRef])
      .then((resolved) => resolved.map((messages) => messages[0] ?? null));
    const triggerError = triggerMsgResult.match({
      ok: () => null,
      err: (error) => error,
    });
    if (triggerError) return Result.err(triggerError);
    const triggerMsg = triggerMsgResult.match({
      ok: (value) => value,
      err: () => null,
    });
    if (triggerMsg) {
      let anchor: SurfaceMessage | null;
      if (opts.triggerType === undefined) {
        anchor = await findEarliestEffectiveReplyAnchor(adapter, [triggerMsg]);
      } else {
        // "Merge block" = a user's short burst of consecutive messages.
        // Mention mode treats the entire burst as a continuation when any
        // message in that burst is a reply.
        const blockResult = await resolveMergeBlockEndingAt(adapter, triggerMsg, {
          resolveMessagesByRefs: layered.resolveMessagesByRefs,
        });
        const blockError = blockResult.match({ ok: () => null, err: (error) => error });
        if (blockError) return Result.err(blockError);
        const block = blockResult.match({ ok: (value) => value, err: () => [] });
        anchor = await findEarliestEffectiveReplyAnchor(adapter, block);
      }
      if (anchor) {
        const anchoredResult = await fetchMentionThreadContext(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          triggerMsg,
          resolveMessagesByRefs: layered.resolveMessagesByRefs,
        });
        const anchoredError = anchoredResult.match({
          ok: () => null,
          err: (error) => error,
        });
        if (anchoredError) return Result.err(anchoredError);
        const anchored = anchoredResult.match({
          ok: (value) => value,
          err: () => [],
        });

        const oldestAnchoredMessageId = anchored[0]?.messageId;
        const dividerResult = oldestAnchoredMessageId
          ? await findLastDiscordSessionDividerBefore({
              adapter,
              messageCache: opts.messageCache,
              channelId: opts.sessionId,
              botUserId: opts.botUserId,
              beforeMessageId: triggerMsg.ref.messageId,
              beforeTs: triggerMsg.ts,
              stopAt: anchored[0]
                ? { messageId: anchored[0].messageId, ts: anchored[0].ts }
                : undefined,
            })
          : Result.ok(null);
        const divider = dividerResult.match({
          ok: (value) => value,
          err: () => null,
        });
        const anchoredAfterDivider = divider
          ? anchored.filter(
              (message) =>
                compareDiscordMsgPosition(
                  { ts: message.ts, messageId: message.messageId },
                  divider,
                ) > 0,
            )
          : anchored;
        const anchoredNoDivider = applyDiscordSessionDividerCutoffToReplyChain({
          chainOldestToNewest: anchoredAfterDivider,
          botUserId: opts.botUserId,
        }).filter((m) => !isDiscordSessionDividerText(m.text));

        const transformedAnchored = anchoredNoDivider.map((m) => {
          const targetMessageId = opts.transformUserTextForMessageId ?? triggerMsg.ref.messageId;
          const transformed = applyUserTextTransformToReplyChainMessage({
            message: m,
            transformUserText: opts.transformUserText,
            shouldTransform: m.authorId !== opts.botUserId && m.messageId === targetMessageId,
          });

          return stripContinueDirectiveFromReplyChainMessage({
            message: transformed,
            botUserId: opts.botUserId,
            botMentionNames: opts.botMentionNames ?? [opts.botName],
          });
        });

        const checkpointSelection = selectNewestReachableCheckpoint({
          chainOldestToNewest: transformedAnchored,
          botUserId: opts.botUserId,
          platform: opts.platform,
          channelId: opts.sessionId,
          transcriptStore: opts.transcriptStore,
          currentRequestId: opts.currentRequestId,
          getAuthorId: (message) => message.authorId,
          getMessageId: (message) => message.messageId,
        });
        const composed = await composeSelectedDiscordChain({
          adapter,
          sessionId: opts.sessionId,
          botUserId: opts.botUserId,
          chain: checkpointSelection.descendants,
          checkpointSelection,
          currentMessageIds: opts.currentMessageIds ?? [triggerMsg.ref.messageId],
          transcriptStore: opts.transcriptStore,
          discordUserAliasById: opts.discordUserAliasById,
          blobStore: opts.blobStore,
          attachmentCache: opts.attachmentCache,
          attachmentCacheTtl: opts.attachmentCacheTtl,
          resolvedProjections: layered.projections,
        });
        return composed.map((value) => ({
          messages: value.messages,
          inputHandles: value.inputHandles,
          chainMessageIds: transformedAnchored.map((m) => m.messageId),
          mergedGroups: value.mergedGroups,
          corePrimaryLineage: value.corePrimaryLineage,
        }));
      }
    }
  }

  const sessionRef = {
    platform: "discord",
    channelId: opts.sessionId,
  } as const;
  const continueDirectiveBotNames = opts.botMentionNames ?? [opts.botName];

  // Active-burst rules are intended for "latest view" prompts, including
  // fresh @mentions that are not replies. They prevent stale context when a
  // channel has been idle.
  const shouldApplyActiveBurstRules = Boolean(opts.triggerMsgRef && opts.triggerType !== "reply");

  let orderedList: SurfaceMessage[];

  if (shouldApplyActiveBurstRules && opts.triggerMsgRef) {
    const triggerMsgResult = await layered
      .resolveMessagesByRefs([opts.triggerMsgRef])
      .then((resolved) => resolved.map((messages) => messages[0] ?? null));
    const triggerError = triggerMsgResult.match({
      ok: () => null,
      err: (error) => error,
    });
    if (triggerError) return Result.err(triggerError);
    const triggerMsg = triggerMsgResult.match({
      ok: (value) => value,
      err: () => null,
    });
    if (triggerMsg) {
      const recent = await listRecentMessagesEndingAt({
        adapter,
        sessionId: opts.sessionId,
        anchor: triggerMsg,
        maxPreviousMessages: ACTIVE_BURST_HISTORY_CAP,
        previousMessageTargets: ACTIVE_BURST_HISTORY_TARGETS,
        shouldContinue: ({ collected, exhausted }) => {
          const activeContextList = collected.filter(shouldIncludeInModelContext);
          const activeTriggerMsg =
            activeContextList.find(
              (message) => message.ref.messageId === opts.triggerMsgRef!.messageId,
            ) ?? null;
          const activeAnchor =
            activeTriggerMsg ??
            (activeContextList.length > 0
              ? activeContextList[activeContextList.length - 1]!
              : null);

          if (!activeAnchor) return !exhausted;

          return shouldContinueLoadingActiveBurstHistory({
            selection: selectActiveBurstMessages({
              contextList: activeContextList,
              activeAnchor,
              limit: opts.limit,
              botUserId: opts.botUserId,
              botMentionNames: continueDirectiveBotNames,
            }),
            exhausted,
            limit: opts.limit,
          });
        },
      });
      const recentError = recent.match({
        ok: () => null,
        err: (error) => error,
      });
      if (recentError) return Result.err(recentError);
      orderedList = recent.match({ ok: (value) => value, err: () => [] });
    } else {
      orderedList = [];
    }
  } else {
    const listed = await adapter.listMsg(sessionRef, { limit: opts.limit });
    const listError = listed.match({ ok: () => null, err: (error) => error });
    if (listError) return Result.err(listError);
    orderedList = [...listed.match({ ok: (value) => value, err: () => [] })];

    if (opts.triggerMsgRef) {
      const exists = orderedList.some((m) => m.ref.messageId === opts.triggerMsgRef!.messageId);
      if (!exists) {
        const fetchedTrigger = await layered
          .resolveMessagesByRefs([opts.triggerMsgRef])
          .then((resolved) => resolved.map((messages) => messages[0] ?? null));
        const fetchError = fetchedTrigger.match({
          ok: () => null,
          err: (error) => error,
        });
        if (fetchError) return Result.err(fetchError);
        const fetchedValue = fetchedTrigger.match({
          ok: (value) => value,
          err: () => null,
        });
        if (fetchedValue) orderedList.push(fetchedValue);
      }
    }

    orderedList.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
    });
  }

  // The surface layer can include Discord system/notification messages (e.g.
  // thread-created). Keep them listable via surface tools, but exclude them from
  // the default model context.
  const contextList = orderedList.filter(shouldIncludeInModelContext);

  const triggerMsg = opts.triggerMsgRef
    ? (contextList.find((m) => m.ref.messageId === opts.triggerMsgRef!.messageId) ?? null)
    : null;

  let activeAnchor: SurfaceMessage | null = null;
  if (shouldApplyActiveBurstRules) {
    activeAnchor = triggerMsg;
    if (activeAnchor === null && contextList.length > 0) {
      activeAnchor = contextList[contextList.length - 1]!;
    }
  }

  const dividerCutContextList =
    shouldApplyActiveBurstRules && activeAnchor
      ? applyDiscordSessionDividerCutoff({
          listOldestToNewest: filterMessagesUpToAnchor({
            list: contextList,
            anchor: activeAnchor,
          }),
          botUserId: opts.botUserId,
        })
      : applyDiscordSessionDividerCutoff({
          listOldestToNewest: contextList,
          botUserId: opts.botUserId,
        });

  let selected: SurfaceMessage[];

  if (shouldApplyActiveBurstRules && activeAnchor) {
    selected = selectActiveBurstMessages({
      contextList,
      activeAnchor,
      limit: opts.limit,
      botUserId: opts.botUserId,
      botMentionNames: continueDirectiveBotNames,
    }).selected;
  } else {
    selected = dividerCutContextList.slice(Math.max(0, dividerCutContextList.length - opts.limit));
  }

  // Safety: exclude divider messages from context even if they are chat-like.
  const selectedNoDivider = selected.filter(
    (m) => !isDiscordSessionDividerSurfaceMessageAnyAuthor(m),
  );

  const chain: ReplyChainMessage[] = selectedNoDivider.map((m) => {
    const transformed = toReplyChainMessageForModelContext({
      message: m,
      botUserId: opts.botUserId,
      triggerMessageId: opts.triggerMsgRef
        ? (opts.transformUserTextForMessageId ?? opts.triggerMsgRef.messageId)
        : undefined,
      transformUserText: opts.transformUserText,
    });

    return stripContinueDirectiveFromReplyChainMessage({
      message: transformed,
      botUserId: opts.botUserId,
      botMentionNames: continueDirectiveBotNames,
    });
  });

  const checkpointSelection = selectNewestReachableCheckpoint({
    chainOldestToNewest: chain,
    botUserId: opts.botUserId,
    platform: opts.platform,
    channelId: opts.sessionId,
    transcriptStore: opts.transcriptStore,
    currentRequestId: opts.currentRequestId,
    getAuthorId: (message) => message.authorId,
    getMessageId: (message) => message.messageId,
  });
  let currentMessageIds = opts.currentMessageIds;
  if (currentMessageIds === undefined) {
    if (opts.triggerMsgRef) {
      currentMessageIds = [opts.triggerMsgRef.messageId];
    } else if (selectedNoDivider.length > 0) {
      currentMessageIds = [selectedNoDivider[selectedNoDivider.length - 1]!.ref.messageId];
    } else {
      currentMessageIds = [];
    }
  }
  const composed = await composeSelectedDiscordChain({
    adapter,
    sessionId: opts.sessionId,
    botUserId: opts.botUserId,
    chain: checkpointSelection.descendants,
    checkpointSelection,
    currentMessageIds,
    transcriptStore: opts.transcriptStore,
    discordUserAliasById: opts.discordUserAliasById,
    blobStore: opts.blobStore,
    attachmentCache: opts.attachmentCache,
    attachmentCacheTtl: opts.attachmentCacheTtl,
    resourceRegistry: opts.resourceRegistry,
    resolvedProjections: layered.projections,
  });
  return composed.map((value) => ({
    messages: value.messages,
    inputHandles: value.inputHandles,
    chainMessageIds: chain.map((m) => m.messageId),
    mergedGroups: value.mergedGroups,
    corePrimaryLineage: value.corePrimaryLineage,
  }));
}

export async function composeSingleMessage(
  adapter: SurfaceAdapter,
  opts: ComposeSingleMessageOpts,
): Promise<ResultType<BusMessageV2 | null, RequestCompositionError>> {
  const composed = await composeSingleMessageWithLineage(adapter, opts);
  return composed.map((value) => value?.messages[0] ?? null);
}

export async function composeSingleMessageWithLineage(
  adapter: SurfaceAdapter,
  opts: ComposeSingleMessageOpts,
  requestReadScope?: typeof ACTIVE_REQUEST_READ_SCOPE,
): Promise<ResultType<RequestCompositionResult | null, RequestCompositionError>> {
  if (requestReadScope !== ACTIVE_REQUEST_READ_SCOPE) {
    return withSurfaceRequestReadScope(adapter, () =>
      composeSingleMessageWithLineage(adapter, opts, ACTIVE_REQUEST_READ_SCOPE),
    );
  }
  const layered = createLayeredDiscordMessageResolver({
    adapter,
    sessionId: opts.msgRef.channelId,
    botUserId: opts.botUserId,
    botName: opts.botName,
    transcriptStore: opts.transcriptStore,
    ingressMessages: opts.ingressMessages,
    currentMessageIds: opts.currentMessageIds ?? [opts.msgRef.messageId],
  });
  const m = await layered
    .resolveMessagesByRefs([opts.msgRef])
    .then((resolved) => resolved.map((messages) => messages[0] ?? null));
  const readError = m.match({ ok: () => null, err: (error) => error });
  if (readError) return Result.err(readError);
  const message = m.match({ ok: (value) => value, err: () => null });
  if (!message) return Result.ok(null);

  if (!shouldIncludeInModelContext(message)) return Result.ok(null);

  // Never include session divider markers in model context.
  if (isDiscordSessionDividerSurfaceMessageAnyAuthor(message)) return Result.ok(null);

  let text =
    message.text.trim().length > 0
      ? message.text
      : (getForwardSnapshotTextFromRaw(message.raw) ?? message.text);
  const contentTransform = message.userId !== opts.botUserId ? opts.transformUserText : undefined;

  if (contentTransform) {
    text = contentTransform(text);
  }

  const chain = [
    toReplyChainMessage(message, {
      overrideText: text,
      authorNameFallback: `user_${message.userId}`,
    }),
  ];
  const checkpointSelection = selectNewestReachableCheckpoint({
    chainOldestToNewest: chain,
    botUserId: opts.botUserId,
    platform: "discord",
    channelId: opts.msgRef.channelId,
    transcriptStore: opts.transcriptStore,
    getAuthorId: (message) => message.authorId,
    getMessageId: (message) => message.messageId,
  });
  const composed = await composeSelectedDiscordChain({
    adapter,
    sessionId: opts.msgRef.channelId,
    botUserId: opts.botUserId,
    chain: checkpointSelection.descendants,
    checkpointSelection,
    currentMessageIds: opts.currentMessageIds ?? [message.ref.messageId],
    transcriptStore: opts.transcriptStore,
    discordUserAliasById: opts.discordUserAliasById,
    blobStore: opts.blobStore,
    attachmentCache: opts.attachmentCache,
    attachmentCacheTtl: opts.attachmentCacheTtl,
    resourceRegistry: opts.resourceRegistry,
    resolvedProjections: layered.projections,
  });
  return composed.map((value) => ({
    messages: value.messages,
    inputHandles: value.inputHandles,
    chainMessageIds: [message.ref.messageId],
    mergedGroups: value.mergedGroups,
    corePrimaryLineage: value.corePrimaryLineage,
  }));
}
