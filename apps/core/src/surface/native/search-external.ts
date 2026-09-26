import { matchesReferenceMessage } from "./reference-preview";
import type { ConversationReference } from "@stanley2058/lilac-client-protocol";
import {
  decodeSentAttachmentMetadata,
  decodeSentAttachmentStdout,
  isSentAttachmentCommand,
  type SentAttachment,
} from "./external-attachment-codec";
import type { BlobHandleV1 } from "@stanley2058/lilac-blob-storage";
import type { RequestOutputLifecycle } from "../bridge/request-delivery/types";
import type { CoreRequestOutputMetadata } from "../bridge/request-delivery/core-integration";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Result, type Result as ResultType } from "better-result";
import type { ConversationThreadStore } from "../../conversation/thread-store";
import { openAIMessagePhase } from "@stanley2058/lilac-utils";
import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";
import {
  areCoreCanonicalMessagesIdentityEqualV2,
  type StoredFilePartV1,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  type SqliteTranscriptStore,
  type TranscriptDiscoveryRecord,
  type TranscriptSnapshot,
} from "../../transcript/transcript-store";
import { parseRequestId } from "../bridge/request-ids";
import type { SurfaceAdapterResolver } from "../runtime-descriptor";
import type { SurfaceSession } from "../types";
import { parseSurfaceMetadataLine, stripSurfaceMetadataLines } from "../bridge/surface-metadata";
import type { NativeClerkAuthenticator } from "./auth-clerk";
import type { NativeUser } from "./codec";
import { nativeFailure } from "./errors";
import type { NativeStoreError } from "./store";

export type ExternalThreadDisplay = {
  id: string;
  sourceUrl?: string;
  title: string;
  surface: "discord" | "github";
  retrievedAt: number;
  updatedAt?: number;
};
export type ExternalFile =
  | StoredFilePartV1
  | { type: "pending-blob"; blob: BlobHandleV1; mediaType: string; filename?: string };
export type ExternalHistory = Pick<
  ConversationThreadStore,
  "getMessagePosition" | "listMessagePositionsBefore"
>;
export type ExternalOutputs = (
  requestId: string,
) => ResultType<readonly RequestOutputLifecycle<CoreRequestOutputMetadata>[], NativeStoreError>;
function sentAttachments(
  message: StoredMessageV1,
  attachmentCalls: ReadonlySet<string>,
): SentAttachment[] {
  if (message.role !== "tool") return [];
  return message.content.flatMap((part) => {
    if (part.type !== "tool-result" || part.output.type !== "json") return [];
    if (part.toolName === "attachment.add_files")
      return decodeSentAttachmentMetadata(part.output.value);
    if (!attachmentCalls.has(part.toolCallId)) return [];
    return decodeSentAttachmentStdout(part.output.value);
  });
}
function outputResourceId(requestId: string, objectId: string): string {
  return `xo_${runId(requestId)}_${objectId}`;
}
type UserLookup = (userId: string) => ResultType<NativeUser, NativeStoreError>;
type ExternalPlatform = "discord" | "github";
type RetainedRun = {
  record: TranscriptDiscoveryRecord;
  platform: ExternalPlatform;
  channelId: string;
};
type ExternalTranscripts = Pick<
  SqliteTranscriptStore,
  | "listDiscoveryRecords"
  | "getRequestTranscript"
  | "getCorePrimaryLineageManifest"
  | "getCoreSurfaceProjection"
  | "getLatestCoreSurfaceSegment"
>;

export function externalThreadId(platform: ExternalPlatform, sessionId: string): string {
  return `${platform}_${Buffer.from(sessionId).toString("base64url")}`;
}
function runId(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex");
}
function parseExternalThreadId(
  id: string,
): ResultType<{ platform: ExternalPlatform; sessionId: string }, NativeStoreError> {
  const match = /^(discord|github)_([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) return Result.err(nativeFailure("invalid", "Invalid external thread identifier"));
  const platform = match[1] === "discord" ? "discord" : "github";
  const sessionId = Buffer.from(match[2]!, "base64url").toString("utf8");
  if (!sessionId || externalThreadId(platform, sessionId) !== id)
    return Result.err(nativeFailure("invalid", "Invalid external thread identifier"));
  return Result.ok({ platform, sessionId });
}
function owner(getUser: UserLookup, userId: string): ResultType<void, NativeStoreError> {
  return getUser(userId).andThen((user) =>
    user.role === "owner"
      ? Result.ok()
      : Result.err(nativeFailure("forbidden", "Only the owner can read external threads")),
  );
}
function retainedRuns(transcripts: ExternalTranscripts): RetainedRun[] {
  return transcripts
    .listDiscoveryRecords()
    .flatMap((record) => {
      if (record.requestClient !== "discord" && record.requestClient !== "github") return [];
      const ref = record.surfaceRefs.find((ref) => ref.platform === record.requestClient);
      if (!ref) return [];
      return [{ record, platform: record.requestClient, channelId: ref.channelId }];
    })
    .sort(
      (a, b) =>
        b.record.updatedTs - a.record.updatedTs ||
        b.record.requestId.localeCompare(a.record.requestId),
    );
}

function discordTrigger(requestId: string) {
  let parsed = parseRequestId(requestId);
  while (parsed?.kind === "queued") parsed = parseRequestId(parsed.requestId);
  return parsed?.kind === "discord_message" ? parsed : null;
}

function rememberConversationGroup(
  groups: Map<string, string>,
  path: readonly string[],
  group: string,
): string {
  for (const requestId of path) groups.set(requestId, group);
  return group;
}

function conversationGroup(
  transcripts: ExternalTranscripts,
  requestId: string,
  groups: Map<string, string>,
  records: ReadonlyMap<string, TranscriptDiscoveryRecord>,
  history?: ExternalHistory,
): ResultType<string, NativeStoreError> {
  return Result.gen(function* () {
    const path: string[] = [];
    let current = requestId;
    while (true) {
      const cached = groups.get(current);
      if (cached) return Result.ok(rememberConversationGroup(groups, path, cached));
      path.push(current);
      // Seed before following retained parents so a corrupt cycle terminates.
      groups.set(current, runId(current));
      const lineage = yield* transcripts
        .getCorePrimaryLineageManifest({ requestId: current })
        .mapError(() => nativeFailure("sqlite", "Run history is unavailable"));
      const parent = lineage?.segments
        .filter((segment) => segment.canonicalStart < lineage.currentCanonicalStart)
        .flatMap((segment) => segment.atoms)
        .find((atom) => atom.kind === "request" || atom.kind === "checkpoint");
      // Partial output indexing must not split a retained reply chain.
      if (parent?.kind === "request" || parent?.kind === "checkpoint") {
        current = parent.requestId;
        continue;
      }
      const position = history ? cachedPosition(history, records.get(current)) : null;
      if (position)
        return Result.ok(rememberConversationGroup(groups, path, runId(position.threadId)));
      const first = lineage?.segments
        .flatMap((segment) => segment.atoms)
        .find((atom) => atom.kind !== "synthetic");
      if (first?.kind === "request" || first?.kind === "checkpoint") {
        current = first.requestId;
        continue;
      }
      const trigger = discordTrigger(current);
      const fallback = trigger ? `discord:${trigger.channelId}:${trigger.messageId}` : current;
      const group = runId(
        first?.kind === "surface" ? `${first.surfaceId}:${first.messageId}` : fallback,
      );
      return Result.ok(rememberConversationGroup(groups, path, group));
    }
  });
}

function cachedPosition(history: ExternalHistory, record?: TranscriptDiscoveryRecord) {
  const positions =
    record?.surfaceRefs.flatMap((ref) => {
      if (ref.platform !== "discord") return [];
      const position = history.getMessagePosition(ref.channelId, ref.messageId);
      return position ? [{ ...position, channelId: ref.channelId }] : [];
    }) ?? [];
  return positions.sort((a, b) => a.ordinal - b.ordinal)[0] ?? null;
}

function cachedInputs(
  transcripts: ExternalTranscripts,
  history: ExternalHistory,
  record?: TranscriptDiscoveryRecord,
): ResultType<StoredMessageV1[], NativeStoreError> {
  return Result.gen(function* () {
    const position = cachedPosition(history, record);
    if (!position) return Result.ok([]);
    const inputs: StoredMessageV1[] = [];
    let end = position.ordinal;
    while (end > 0) {
      const preceding = history.listMessagePositionsBefore(position.threadId, end);
      for (const message of preceding) {
        if (message.authorId === position.authorId) return Result.ok(inputs);
        const projection = yield* transcripts
          .getCoreSurfaceProjection({
            requestClient: "discord",
            surfaceId: `discord:${position.channelId}`,
            sessionId: position.channelId,
            messageId: message.messageId,
            projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
          })
          .mapError(() => nativeFailure("sqlite", "Run input is unavailable"));
        inputs.unshift(
          ...(projection?.canonicalMessages.filter((message) => message.role === "user") ?? []),
        );
      }
      end = preceding.at(-1)?.ordinal ?? 0;
    }
    return Result.ok(inputs);
  });
}

function retainedTriggerInputs(
  transcripts: ExternalTranscripts,
  trigger: NonNullable<ReturnType<typeof discordTrigger>>,
): ResultType<readonly StoredMessageV1[], NativeStoreError> {
  return Result.gen(function* () {
    const key = {
      requestClient: "discord" as const,
      surfaceId: `discord:${trigger.channelId}`,
      sessionId: trigger.channelId,
      messageId: trigger.messageId,
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    };
    const projection = yield* transcripts
      .getCoreSurfaceProjection(key)
      .mapError(() => nativeFailure("sqlite", "Run input is unavailable"));
    const segment = yield* transcripts
      .getLatestCoreSurfaceSegment(key)
      .mapError(() => nativeFailure("sqlite", "Run input is unavailable"));
    return Result.ok(segment?.canonicalMessages ?? projection?.canonicalMessages ?? []);
  });
}

function canonicalRun(
  transcripts: ExternalTranscripts,
  snapshot: TranscriptSnapshot,
  history?: ExternalHistory,
  record?: TranscriptDiscoveryRecord,
): ResultType<StoredMessageV1[], NativeStoreError> {
  return Result.gen(function* () {
    const lineage = yield* transcripts
      .getCorePrimaryLineageManifest({ requestId: snapshot.requestId })
      .mapError(() => nativeFailure("sqlite", "Run history is unavailable"));
    let inputs: readonly StoredMessageV1[] =
      lineage?.segments
        .filter(
          (segment) =>
            segment.canonicalStart >= lineage.currentCanonicalStart &&
            segment.atoms.every((atom) => atom.kind === "surface"),
        )
        .flatMap((segment) => segment.canonicalMessages) ?? [];
    const trigger = discordTrigger(snapshot.requestId);
    if (
      inputs.length === 0 &&
      snapshot.requestClient === "discord" &&
      trigger?.kind === "discord_message" &&
      trigger.channelId === snapshot.sessionId
    ) {
      inputs = yield* retainedTriggerInputs(transcripts, trigger);
    }
    if (inputs.length === 0 && history && snapshot.requestClient === "discord")
      inputs = yield* cachedInputs(transcripts, history, record);
    if (snapshot.contextMeta) return Result.ok([...inputs, ...checkpointOutput(snapshot, inputs)]);
    return Result.ok([...inputs, ...snapshot.messages]);
  });
}

function checkpointOutput(
  snapshot: TranscriptSnapshot,
  inputs: readonly StoredMessageV1[],
): StoredMessageV1[] {
  const lastInput = inputs.at(-1);
  const inputIndex = lastInput
    ? snapshot.messages.findLastIndex((message) =>
        areCoreCanonicalMessagesIdentityEqualV2([message], [lastInput]),
      )
    : -1;
  if (inputIndex >= 0) return snapshot.messages.slice(inputIndex + 1);
  const checkpointBoundary = snapshot.messages.findLastIndex((message) => message.role === "user");
  if (checkpointBoundary >= 0)
    return checkpointSuffix(snapshot, checkpointBoundary, inputs.length === 0);
  // A checkpoint can omit the trigger. Its final assistant message still retains file parts.
  const lastAssistant = snapshot.messages.findLast((message) => message.role === "assistant");
  if (lastAssistant) return [lastAssistant];
  return snapshot.finalText ? [{ role: "assistant", content: snapshot.finalText }] : [];
}

function checkpointSuffix(
  snapshot: TranscriptSnapshot,
  boundary: number,
  recoverInput: boolean,
): StoredMessageV1[] {
  const message = snapshot.messages[boundary]!;
  const textParts =
    typeof message.content === "string"
      ? [message.content]
      : message.content.filter((part) => part.type === "text").map((part) => part.text);
  const attributed = textParts.some((text) => parseSurfaceMetadataLine(text));
  return snapshot.messages.slice(boundary + (attributed && recoverInput ? 0 : 1));
}

function projectRun(input: {
  snapshot: TranscriptSnapshot;
  messages: readonly StoredMessageV1[];
  platform: ExternalPlatform;
  agentName: string;
  conversationId: string;
  viewerId?: string;
  linkedDiscordIds?: readonly string[];
  outputs?: readonly RequestOutputLifecycle<CoreRequestOutputMetadata>[];
  reference: ConversationReference;
}): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const id = runId(input.snapshot.requestId);
  const available = [...(input.outputs ?? [])];
  const attachmentCalls = new Set<string>();
  for (const message of input.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolName !== "bash") continue;
      if (isSentAttachmentCommand(part.input)) attachmentCalls.add(part.toolCallId);
    }
  }
  function projectSentAttachments(message: StoredMessageV1, index: number): void {
    const attachments = sentAttachments(message, attachmentCalls).map(
      (attachment, ordinal): DisplayPart => {
        const match = available.findIndex(
          (output) =>
            output.metadata.filename === attachment.filename &&
            output.metadata.mimeType === attachment.mimeType,
        );
        const output = match >= 0 ? available.splice(match, 1)[0] : undefined;
        const resourceId = output
          ? outputResourceId(input.snapshot.requestId, output.target.blob.objectId)
          : `xu_${id}_${index}_${ordinal}`;
        return {
          type: "data-resource",
          id: resourceId,
          data: {
            resourceId,
            name: attachment.filename.slice(0, 512),
            mediaType: attachment.mimeType.slice(0, 256),
            size: attachment.bytes,
            state: output ? "ready" : "failed",
            ...(!output ? { error: "File unavailable" } : {}),
          },
        };
      },
    );
    for (let offset = 0; offset < attachments.length; offset += 128)
      messages.push({
        id: `xm_${id}_${index}_files_${offset}`,
        role: "assistant",
        metadata: {
          externalRunId: input.conversationId,
          createdAt: input.snapshot.createdTs,
          reference: { surface: input.reference.surface, sessionId: input.reference.sessionId },
        },
        parts: attachments.slice(offset, offset + 128),
      });
  }
  for (const [index, message] of input.messages.entries()) {
    if (message.role === "tool") {
      projectSentAttachments(message, index);
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const leading = content.find((part) => part.type === "text");
    const metadata =
      leading?.type === "text" ? parseSurfaceMetadataLine(leading.text)?.meta : undefined;
    const parts: DisplayPart[] = [];
    let text = "";
    const flushText = () => {
      for (let start = 0; start < text.length; start += 65_536)
        parts.push({ type: "text", text: text.slice(start, start + 65_536) });
      text = "";
    };
    for (const [partIndex, part] of content.entries()) {
      if (part.type === "text") {
        const phase =
          openAIMessagePhase(part.providerOptions) ?? openAIMessagePhase(message.providerOptions);
        if (message.role === "assistant" && phase === "commentary") continue;
        text += stripSurfaceMetadataLines(part.text);
        continue;
      }
      if (part.type !== "resource" && part.type !== "blob") continue;
      flushText();
      const resourceId =
        part.type === "resource"
          ? part.uri.slice("resource://".length)
          : `xf_${id}_${index}_${partIndex}`;
      parts.push({
        type: "data-resource",
        id: resourceId,
        data: {
          resourceId,
          name: (part.filename ?? "attachment").slice(0, 512),
          mediaType: (part.mediaType ?? "application/octet-stream").slice(0, 256),
          size: part.type === "blob" ? part.blob.byteLength : (part.size ?? 0),
          state: "ready",
        },
      });
    }
    flushText();
    if (!parts.length) continue;
    const participantName =
      typeof metadata?.user_name === "string" ? metadata.user_name : "Participant";
    const authorName = message.role === "assistant" ? input.agentName : participantName;
    const authorId =
      typeof metadata?.user_id === "string" && input.linkedDiscordIds?.includes(metadata.user_id)
        ? input.viewerId
        : undefined;
    for (let offset = 0; offset < parts.length; offset += 128) {
      messages.push({
        id: `xm_${id}_${index}_${offset}`,
        role: message.role,
        metadata: {
          reference:
            message.role === "assistant"
              ? input.reference
              : {
                  surface: input.reference.surface,
                  sessionId: input.reference.sessionId,
                  ...(typeof metadata?.message_id === "string"
                    ? { messageId: metadata.message_id }
                    : {}),
                },
          externalRunId: input.conversationId,
          createdAt: input.snapshot.createdTs,
          authorDisplayName: `${authorName.slice(0, 240)} (${input.platform === "discord" ? "Discord" : "GitHub"})`,
          ...(authorId ? { authorId } : {}),
        },
        parts: parts.slice(offset, offset + 128),
      });
    }
  }
  for (const output of available) {
    const resourceId = outputResourceId(input.snapshot.requestId, output.target.blob.objectId);
    messages.push({
      id: resourceId,
      role: "assistant",
      metadata: {
        externalRunId: input.conversationId,
        createdAt: input.snapshot.createdTs,
        reference: { surface: input.reference.surface, sessionId: input.reference.sessionId },
      },
      parts: [
        {
          type: "data-resource",
          id: resourceId,
          data: {
            resourceId,
            name: (output.metadata.filename ?? "attachment").slice(0, 512),
            mediaType: output.metadata.mimeType.slice(0, 256),
            size: output.target.kind === "reference" ? output.target.blob.byteLength : 0,
            state: "ready",
          },
        },
      ],
    });
  }
  return messages;
}

export class NativeExternalThreads {
  constructor(
    private readonly params: {
      getUser: UserLookup;
      getAgent?: () => ResultType<NativeUser, NativeStoreError>;
      profileProvider?: Pick<NativeClerkAuthenticator, "lookupUser">;
      adapters: SurfaceAdapterResolver;
      transcripts: ExternalTranscripts;
      history?: ExternalHistory;
      outputs?: ExternalOutputs;
      now?: () => number;
    },
  ) {}

  private async sessions(): Promise<SurfaceSession[]> {
    const adapter = this.params.adapters.resolve("discord")?.adapter;
    if (!adapter) return [];
    return (await adapter.listSessions({ limit: Number.MAX_SAFE_INTEGER })).match({
      ok: (sessions) => sessions,
      err: () => [],
    });
  }

  private display(run: RetainedRun, sessions: readonly SurfaceSession[]): ExternalThreadDisplay {
    const session = sessions.find((session) => session.ref.channelId === run.channelId);
    const ref = session?.ref;
    const sourceUrl =
      run.platform === "discord"
        ? `https://discord.com/channels/${ref?.platform === "discord" ? (ref.guildId ?? "@me") : "@me"}/${run.channelId}`
        : undefined;
    return {
      id: externalThreadId(run.platform, run.channelId),
      title: (session?.title ?? run.channelId).slice(0, 512),
      surface: run.platform,
      retrievedAt: this.params.now?.() ?? Date.now(),
      updatedAt: run.record.updatedTs,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }

  async list(
    userId: string,
    input: { cursor?: string; limit?: number },
  ): Promise<
    ResultType<{ items: ExternalThreadDisplay[]; nextCursor?: string }, NativeStoreError>
  > {
    return Result.gen(async function* () {
      yield* owner(this.params.getUser, userId);
      const sessions = await this.sessions();
      const byId = new Map<string, ExternalThreadDisplay>();
      for (const run of retainedRuns(this.params.transcripts)) {
        const item = this.display(run, sessions);
        if (item.id.length <= 128 && !byId.has(item.id)) byId.set(item.id, item);
      }
      const items = [...byId.values()];
      const cursorIndex = input.cursor ? items.findIndex((item) => item.id === input.cursor) : -1;
      if (input.cursor && cursorIndex < 0) return Result.ok({ items: [] });
      const start = cursorIndex + 1;
      const page = items.slice(start, start + Math.min(100, Math.max(1, input.limit ?? 30)));
      return Result.ok({
        items: page,
        ...(start + page.length < items.length ? { nextCursor: page.at(-1)!.id } : {}),
      });
    }, this);
  }

  private async linkedDiscordIds(userId: string): Promise<readonly string[]> {
    if (!this.params.profileProvider) return [];
    const user = this.params.getUser(userId).match({ ok: (value) => value, err: () => null });
    if (!user) return [];
    return (await this.params.profileProvider.lookupUser(user.providerId)).match({
      ok: (profile) =>
        profile.providerUserId === user.providerId ? (profile.discordUserIds ?? []) : [],
      err: () => [],
    });
  }

  file(userId: string, resourceId: string): ResultType<ExternalFile, NativeStoreError> {
    return Result.gen(function* () {
      yield* owner(this.params.getUser, userId);
      const outputMatch = /^xo_([a-f0-9]{64})_(b1_[a-f0-9]{32})$/.exec(resourceId);
      if (outputMatch) return this.outputFile(outputMatch[1]!, outputMatch[2]!);
      const match = /^xf_([a-f0-9]{64})_(\d+)_(\d+)$/.exec(resourceId);
      if (!match) return Result.err(nativeFailure("not-found", "File is unavailable"));
      const run = retainedRuns(this.params.transcripts).find(
        (run) => runId(run.record.requestId) === match[1],
      );
      if (!run) return Result.err(nativeFailure("not-found", "File is unavailable"));
      const snapshot = yield* this.params.transcripts
        .getRequestTranscript({ requestId: run.record.requestId })
        .mapError(() => nativeFailure("sqlite", "Run history is unavailable"));
      if (!snapshot) return Result.err(nativeFailure("not-found", "File is unavailable"));
      const canonical = yield* canonicalRun(
        this.params.transcripts,
        snapshot,
        this.params.history,
        run.record,
      );
      const message = canonical[Number(match[2])];
      if (
        !message ||
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content === "string"
      )
        return Result.err(nativeFailure("not-found", "File is unavailable"));
      const part = message.content[Number(match[3])];
      return part?.type === "blob"
        ? Result.ok(part)
        : Result.err(nativeFailure("not-found", "File is unavailable"));
    }, this);
  }

  private outputFile(
    requestHash: string,
    objectId: string,
  ): ResultType<ExternalFile, NativeStoreError> {
    return Result.gen(function* () {
      const run = retainedRuns(this.params.transcripts).find(
        (run) => runId(run.record.requestId) === requestHash,
      );
      if (!run || !this.params.outputs)
        return Result.err(nativeFailure("not-found", "File is unavailable"));
      const outputs = yield* this.params.outputs(run.record.requestId);
      const output = outputs.find((output) => output.target.blob.objectId === objectId);
      if (!output) return Result.err(nativeFailure("not-found", "File is unavailable"));
      if (output.target.kind === "handle")
        return Result.ok({
          type: "pending-blob" as const,
          blob: output.target.blob,
          mediaType: output.metadata.mimeType,
          filename: output.metadata.filename,
        });
      return Result.ok({
        type: "blob" as const,
        blob: output.target.blob,
        mediaType: output.metadata.mimeType,
        filename: output.metadata.filename,
      });
    }, this);
  }

  resolveReference(
    userId: string,
    target: ConversationReference,
  ): ResultType<{ conversationThreadId?: string }, NativeStoreError> {
    return Result.gen(function* () {
      yield* owner(this.params.getUser, userId);
      if (!target.messageId) return Result.ok({});
      const position = this.params.history?.getMessagePosition(target.sessionId, target.messageId);
      if (position) return Result.ok({ conversationThreadId: position.threadId });
      const run = retainedRuns(this.params.transcripts).find(
        (run) =>
          run.platform === target.surface &&
          run.channelId === target.sessionId &&
          run.record.surfaceRefs.some((ref) => ref.messageId === target.messageId),
      );
      const origin =
        run && this.params.history ? cachedPosition(this.params.history, run.record) : null;
      return Result.ok(origin ? { conversationThreadId: origin.threadId } : {});
    }, this);
  }

  async describeReference(userId: string, target: ConversationReference) {
    return Result.gen(async function* () {
      const resolved = yield* this.resolveReference(userId, target);
      const run = retainedRuns(this.params.transcripts).find(
        (run) => run.platform === target.surface && run.channelId === target.sessionId,
      );
      if (!run) return Result.err(nativeFailure("not-found", "Conversation is unavailable"));
      const display = this.display(run, await this.sessions());
      const sourceUrl =
        display.sourceUrl && target.messageId
          ? `${display.sourceUrl}/${target.messageId}`
          : display.sourceUrl;
      return Result.ok({ title: display.title, ...resolved, ...(sourceUrl ? { sourceUrl } : {}) });
    }, this);
  }

  async read(userId: string, input: { threadId: string; cursor?: string }) {
    return (await this.readPage(userId, input)).map(
      ({ messageFound: _found, nextAfter: _after, anchorMessageId: _anchor, ...page }) => page,
    );
  }

  async readReference(
    userId: string,
    input: { target: ConversationReference; cursor?: string; direction?: "before" | "after" },
  ) {
    if (input.target.surface === "native")
      return Result.err(nativeFailure("invalid", "Expected an external reference"));
    return (
      await this.readPage(userId, {
        threadId: externalThreadId(input.target.surface, input.target.sessionId),
        cursor: input.cursor,
        messageId: input.target.messageId,
        direction: input.direction,
      })
    ).map((page) => ({
      title: page.thread.title,
      messages: page.messages,
      nextCursor: page.nextCursor,
      nextAfter: page.nextAfter,
      messageFound: page.messageFound,
      anchorMessageId: page.anchorMessageId,
      sourceUrl:
        page.thread.sourceUrl && input.target.messageId
          ? `${page.thread.sourceUrl}/${input.target.messageId}`
          : page.thread.sourceUrl,
    }));
  }

  private async readPage(
    userId: string,
    input: {
      threadId: string;
      cursor?: string;
      messageId?: string;
      direction?: "before" | "after";
    },
  ): Promise<
    ResultType<
      {
        thread: ExternalThreadDisplay;
        messages: DisplayMessage[];
        nextCursor?: string;
        nextAfter?: string;
        anchorMessageId?: string;
        messageFound: boolean;
      },
      NativeStoreError
    >
  > {
    return Result.gen(async function* () {
      yield* owner(this.params.getUser, userId);
      const ref = yield* parseExternalThreadId(input.threadId);
      const runs = retainedRuns(this.params.transcripts).filter(
        (run) => run.platform === ref.platform && run.channelId === ref.sessionId,
      );
      const newest = runs[0];
      if (!newest) return Result.err(nativeFailure("not-found", "Conversation is unavailable"));
      const cursor = input.cursor ? /^([a-f0-9]{64})_(\d+)$/.exec(input.cursor) : null;
      let index = cursor ? runs.findIndex((run) => runId(run.record.requestId) === cursor[1]) : 0;
      if ((input.cursor && !cursor) || index < 0)
        return Result.err(nativeFailure("invalid", "Invalid conversation cursor"));
      let end = cursor ? Number(cursor[2]) : undefined;
      if (end !== undefined && !Number.isSafeInteger(end))
        return Result.err(nativeFailure("invalid", "Invalid conversation cursor"));
      const agent = this.params.getAgent ? yield* this.params.getAgent() : undefined;
      const linkedDiscordIds =
        ref.platform === "discord" ? await this.linkedDiscordIds(userId) : [];
      const messages: DisplayMessage[] = [];
      const groups = new Map<string, string>();
      const records = new Map(runs.map((run) => [run.record.requestId, run.record]));
      let nextCursor: string | undefined;
      let nextAfter: string | undefined;
      let anchorMessageId: string | undefined;
      let anchored = false;
      const forward = input.direction === "after";
      let messageFound = !input.messageId || !!input.cursor;
      let targetGroup: string | undefined;
      if (input.messageId) {
        const linked = runs.find((run) =>
          run.record.surfaceRefs.some((item) => item.messageId === input.messageId),
        );
        if (linked)
          targetGroup = yield* conversationGroup(
            this.params.transcripts,
            linked.record.requestId,
            groups,
            records,
            this.params.history,
          );
      }
      const runGroups = new Map<string, string>();
      for (const run of runs) {
        runGroups.set(
          run.record.requestId,
          yield* conversationGroup(
            this.params.transcripts,
            run.record.requestId,
            groups,
            records,
            this.params.history,
          ),
        );
      }
      function adjacentCursor(from: number, step: -1 | 1): string | undefined {
        for (let next = from + step; next >= 0 && next < runs.length; next += step) {
          const run = runs[next]!;
          if (targetGroup && runGroups.get(run.record.requestId) !== targetGroup) continue;
          return `${runId(run.record.requestId)}_${step === -1 ? 0 : Number.MAX_SAFE_INTEGER}`;
        }
        return undefined;
      }
      for (; index >= 0 && index < runs.length; index += forward ? -1 : 1) {
        const run = runs[index]!;
        const group = yield* conversationGroup(
          this.params.transcripts,
          run.record.requestId,
          groups,
          records,
          this.params.history,
        );
        if (targetGroup && group !== targetGroup) continue;
        const snapshot = yield* this.params.transcripts
          .getRequestTranscript({ requestId: run.record.requestId })
          .mapError(() => nativeFailure("sqlite", "Run history is unavailable"));
        if (!snapshot) {
          end = undefined;
          continue;
        }
        const canonical = yield* canonicalRun(
          this.params.transcripts,
          snapshot,
          this.params.history,
          run.record,
        );
        const outputs = this.params.outputs ? yield* this.params.outputs(run.record.requestId) : [];
        const projected = projectRun({
          snapshot,
          conversationId: yield* conversationGroup(
            this.params.transcripts,
            snapshot.requestId,
            groups,
            records,
            this.params.history,
          ),
          messages: canonical,
          platform: ref.platform,
          agentName: agent?.displayName ?? "Lilac",
          viewerId: userId,
          linkedDiscordIds,
          outputs,
          reference: {
            surface: ref.platform,
            sessionId: ref.sessionId,
            messageId: run.record.surfaceRefs.find(
              (item) => item.platform === ref.platform && item.channelId === ref.sessionId,
            )?.messageId,
          },
        });
        if (!targetGroup && input.messageId && input.cursor) targetGroup = group;
        if (!messageFound) {
          const anchor = projected.findIndex((message) =>
            matchesReferenceMessage(message, input.messageId!),
          );
          const linked = run.record.surfaceRefs.some((item) => item.messageId === input.messageId);
          if (anchor < 0 && !linked) continue;
          messageFound = true;
          anchorMessageId =
            projected[anchor]?.id ??
            projected.find(
              (message) => message.role === "assistant" && message.metadata?.reference?.messageId,
            )?.id;
          targetGroup = group;
          if (anchor >= 0) end = Math.min(projected.length, anchor + 21);
        }
        const stop = forward
          ? Math.min(projected.length, (end ?? 0) + 100 - messages.length)
          : Math.min(end ?? projected.length, projected.length);
        const start = forward ? (end ?? 0) : Math.max(0, stop - (100 - messages.length));
        if (forward) messages.push(...projected.slice(start, stop));
        else messages.unshift(...projected.slice(start, stop));
        if (forward && !anchored) {
          anchored = true;
          if (start > 0) nextCursor = `${runId(run.record.requestId)}_${start}`;
          else nextCursor = adjacentCursor(index, 1);
        }
        if (!forward && (input.messageId || input.cursor) && !anchored) {
          anchored = true;
          if (stop < projected.length) nextAfter = `${runId(run.record.requestId)}_${stop}`;
          else nextAfter = adjacentCursor(index, -1);
        }
        if (forward && stop < projected.length) {
          nextAfter = `${runId(run.record.requestId)}_${stop}`;
          break;
        }
        if (!forward && start > 0) {
          nextCursor = `${runId(run.record.requestId)}_${start}`;
          break;
        }
        end = undefined;
        if (messages.length === 100) {
          if (forward) nextAfter = adjacentCursor(index, -1);
          else nextCursor = adjacentCursor(index, 1);
          break;
        }
      }
      const sessions = await this.sessions();
      return Result.ok({
        thread: this.display(newest, sessions),
        messageFound,
        ...(anchorMessageId ? { anchorMessageId } : {}),
        ...(nextAfter ? { nextAfter } : {}),
        messages,
        ...(nextCursor ? { nextCursor } : {}),
      });
    }, this);
  }
}
