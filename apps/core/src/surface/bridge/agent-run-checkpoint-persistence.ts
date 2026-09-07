import type { McpImageCheckpointRegistry } from "../../mcp/image-checkpoint";
import type { ModelMessage } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { isDeepStrictEqual } from "node:util";

import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import type { CorePrimaryLineageV2, StoredMessageV1 } from "@stanley2058/lilac-event-bus";

import {
  StoredMessageProjectionError,
  type StoredMessageIdentityProjectionV1,
} from "../../transcript/stored-message-materialization";
import { defaultStoredBlobFilename } from "../../transcript/transcript-persistence-codec";
import {
  type AgentRunCheckpointBlobReferenceError,
  type TranscriptStore,
} from "../../transcript/transcript-store";
import type { RequestDeliveryTerminalOutcome } from "./request-delivery";
import {
  createAgentRunCheckpoint,
  type AgentRunJournal,
  type AgentRunJournalError,
  type AgentRunJournalHandle,
} from "./agent-run-journal";

export class AgentRunCheckpointPreparationFailed extends TaggedError(
  "AgentRunCheckpointPreparationFailed",
)<{
  readonly stage: "projection" | "ownership";
  readonly message: string;
}> {}

export class AgentRunCheckpointOwnershipRollbackFailed extends TaggedError(
  "AgentRunCheckpointOwnershipRollbackFailed",
)<{
  readonly message: string;
  readonly journalError: AgentRunJournalError;
  readonly cleanupError: AgentRunCheckpointBlobReferenceError;
}> {}

export type AgentRunCheckpointPersistenceError =
  | AgentRunCheckpointPreparationFailed
  | AgentRunCheckpointOwnershipRollbackFailed
  | AgentRunJournalError;

export type AgentRunCheckpointPersistenceSuccess = {
  readonly handle: AgentRunJournalHandle;
  readonly messages: readonly StoredMessageV1[];
  readonly advanced: boolean;
  readonly cleanupError?: AgentRunCheckpointBlobReferenceError;
};

type PreviousCheckpointProjection = {
  readonly providerMessages: readonly ModelMessage[];
  readonly storedMessages: readonly StoredMessageV1[];
};

function containsStoredBlob(messages: readonly StoredMessageV1[]): boolean {
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "blob") return true;
      if (part.type !== "tool-result" || part.output.type !== "content") continue;
      if (part.output.value.some((output) => output.type === "blob")) return true;
    }
  }
  return false;
}

async function projectCheckpointMessages(input: {
  readonly messages: readonly ModelMessage[];
  readonly previousCheckpoint?: PreviousCheckpointProjection;
  readonly identityProjection: StoredMessageIdentityProjectionV1;
  readonly blobStore: BlobStore;
  readonly transcriptStore: TranscriptStore | undefined;
  readonly shouldAbandon?: () => boolean;
}): Promise<ResultType<StoredMessageV1[], AgentRunCheckpointPreparationFailed>> {
  if (input.shouldAbandon?.()) {
    return Result.err(
      new AgentRunCheckpointPreparationFailed({
        stage: "projection",
        message: "Agent run checkpoint persistence was abandoned",
      }),
    );
  }
  const previous = input.previousCheckpoint;
  const canReusePrevious =
    previous !== undefined &&
    previous.providerMessages.length === previous.storedMessages.length &&
    previous.providerMessages.length <= input.messages.length &&
    previous.providerMessages.every((message, index) =>
      isDeepStrictEqual(message, input.messages[index]),
    );
  const reusableMessages = canReusePrevious ? previous.storedMessages : [];
  const messagesToProject = canReusePrevious
    ? input.messages.slice(previous.providerMessages.length)
    : input.messages;
  const direct = input.identityProjection.project(messagesToProject);
  const directDecision = direct.match<
    | { readonly kind: "projected"; readonly messages: StoredMessageV1[] }
    | { readonly kind: "requires-upload" }
  >({
    ok: (messages) => ({ kind: "projected", messages: [...reusableMessages, ...messages] }),
    err: () => ({ kind: "requires-upload" }),
  });
  if (directDecision.kind === "projected") return Result.ok(directDecision.messages);

  const readToolCallIds = new Set<string>();
  for (const message of messagesToProject) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolName === "read") {
        readToolCallIds.add(part.toolCallId);
      }
    }
  }
  for (const message of messagesToProject) {
    if (typeof message.content === "string") continue;
    const hasInlineFile = message.content.some(
      (part) =>
        part.type === "file" ||
        (part.type === "tool-result" &&
          part.output.type === "content" &&
          part.output.value.some((output) => output.type === "file")),
    );
    if (!hasInlineFile) continue;
    const requiresUpload = input.identityProjection.project([message]).match({
      ok: () => false,
      err: () => true,
    });
    if (!requiresUpload) continue;
    for (const part of message.content) {
      if (part.type === "file") {
        return Result.err(
          new AgentRunCheckpointPreparationFailed({
            stage: "projection",
            message: "Agent run checkpoints upload only binary read results",
          }),
        );
      }
      if (part.type !== "tool-result" || part.output.type !== "content") continue;
      const hasInlineOutputFile = part.output.value.some((output) => output.type === "file");
      if (
        hasInlineOutputFile &&
        part.toolName !== "read" &&
        !readToolCallIds.has(part.toolCallId)
      ) {
        return Result.err(
          new AgentRunCheckpointPreparationFailed({
            stage: "projection",
            message: "Agent run checkpoints upload only binary read results",
          }),
        );
      }
    }
  }

  const putCoreOwnedBlob = input.transcriptStore?.putCoreOwnedBlob;
  if (!putCoreOwnedBlob || !input.transcriptStore) {
    return Result.err(
      new AgentRunCheckpointPreparationFailed({
        stage: "ownership",
        message: "Agent run checkpoint cannot retain provider file blobs",
      }),
    );
  }
  const projected = await input.identityProjection.projectForPersistence({
    providerMessages: messagesToProject,
    blobStore: input.blobStore,
    ...(input.shouldAbandon ? { shouldAbandon: input.shouldAbandon } : {}),
    retainUploadedFile: (file) =>
      putCoreOwnedBlob
        .call(input.transcriptStore, {
          blob: file.blob,
          mediaType: file.mediaType,
          filename: defaultStoredBlobFilename(file),
        })
        .map(() => undefined)
        .mapError(
          (error) =>
            new StoredMessageProjectionError({
              message: `Agent run checkpoint blob could not be retained: ${error.message}`,
            }),
        ),
  });
  return projected
    .map((value) => [...reusableMessages, ...value.messages])
    .mapError(
      (error) =>
        new AgentRunCheckpointPreparationFailed({
          stage: "projection",
          message: error.message,
        }),
    );
}

/** Uploads and pins checkpoint blobs before atomically replacing the journal checkpoint. */
export async function persistBlobBackedAgentRunCheckpoint(input: {
  readonly mcpImages?: McpImageCheckpointRegistry;
  readonly handle: AgentRunJournalHandle;
  readonly journal: Pick<AgentRunJournal, "writeCheckpoint">;
  readonly messages: readonly ModelMessage[];
  readonly previousCheckpoint?: PreviousCheckpointProjection;
  readonly retainedPredecessorMessages?: readonly StoredMessageV1[];
  readonly identityProjection: StoredMessageIdentityProjectionV1;
  readonly blobStore: BlobStore;
  readonly transcriptStore?: TranscriptStore;
  readonly shouldAbandon?: () => boolean;
  readonly corePrimaryLineage?: CorePrimaryLineageV2;
  readonly loadedCatalogIds?: readonly string[];
  readonly currentTurnUserId?: string;
  readonly retainedRequestDeliveries: readonly {
    readonly requestDeliveryId: string;
    readonly outcome: RequestDeliveryTerminalOutcome;
  }[];
}): Promise<ResultType<AgentRunCheckpointPersistenceSuccess, AgentRunCheckpointPersistenceError>> {
  const imageProjection = input.mcpImages?.project(input.messages);
  const previousCheckpoint = input.previousCheckpoint;
  const projected = await projectCheckpointMessages({
    messages: imageProjection?.messages ?? input.messages,
    previousCheckpoint: previousCheckpoint && {
      ...previousCheckpoint,
      providerMessages:
        input.mcpImages?.project(previousCheckpoint.providerMessages).messages ??
        previousCheckpoint.providerMessages,
    },
    identityProjection: input.identityProjection,
    blobStore: input.blobStore,
    transcriptStore: input.transcriptStore,
    ...(input.shouldAbandon ? { shouldAbandon: input.shouldAbandon } : {}),
  });
  const projectionDecision = projected.match<
    | { readonly kind: "projected"; readonly messages: StoredMessageV1[] }
    | { readonly kind: "error"; readonly error: AgentRunCheckpointPreparationFailed }
  >({
    ok: (messages) => ({ kind: "projected", messages }),
    err: (error) => ({ kind: "error", error }),
  });
  if (projectionDecision.kind === "error") return Result.err(projectionDecision.error);
  if (input.shouldAbandon?.()) {
    return Result.err(
      new AgentRunCheckpointPreparationFailed({
        stage: "projection",
        message: "Agent run checkpoint persistence was abandoned",
      }),
    );
  }

  const messages = projectionDecision.messages;
  const prospectiveOwnedMessages = [
    ...messages,
    ...(input.previousCheckpoint?.storedMessages ?? []),
    ...(input.retainedPredecessorMessages ?? []),
  ];
  const hasBlobs = containsStoredBlob(prospectiveOwnedMessages);
  const retainCheckpointBlobs = input.transcriptStore?.retainAgentRunCheckpointBlobs;
  const replaceCheckpointBlobs = input.transcriptStore?.replaceAgentRunCheckpointBlobs;
  if (hasBlobs && (!retainCheckpointBlobs || !replaceCheckpointBlobs || !input.transcriptStore)) {
    return Result.err(
      new AgentRunCheckpointPreparationFailed({
        stage: "ownership",
        message: "Agent run checkpoint blob ownership is unavailable",
      }),
    );
  }
  if (hasBlobs && retainCheckpointBlobs && input.transcriptStore) {
    const retained = retainCheckpointBlobs.call(input.transcriptStore, {
      requestDeliveryId: input.handle.runId,
      messages: prospectiveOwnedMessages,
    });
    const retentionError = retained.match({ ok: () => null, err: (error) => error });
    if (retentionError) {
      return Result.err(
        new AgentRunCheckpointPreparationFailed({
          stage: "ownership",
          message: `Agent run checkpoint blobs could not be pinned: ${retentionError.message}`,
        }),
      );
    }
  }

  const checkpoint = createAgentRunCheckpoint({
    messages,
    mcpImages: imageProjection?.references,
    ...(input.corePrimaryLineage ? { corePrimaryLineage: input.corePrimaryLineage } : {}),
    ...(input.loadedCatalogIds ? { loadedCatalogIds: input.loadedCatalogIds } : {}),
    ...(input.currentTurnUserId ? { currentTurnUserId: input.currentTurnUserId } : {}),
    retainedRequestDeliveries: input.retainedRequestDeliveries,
  });
  const written = input.journal.writeCheckpoint(input.handle, checkpoint);
  const writeDecision = written.match<
    | { readonly kind: "written"; readonly handle: AgentRunJournalHandle }
    | { readonly kind: "error"; readonly error: AgentRunJournalError }
  >({
    ok: (handle) => ({ kind: "written", handle }),
    err: (error) => ({ kind: "error", error }),
  });
  if (writeDecision.kind === "error") {
    const ownershipRollbackError = hasBlobs
      ? input.transcriptStore?.replaceAgentRunCheckpointBlobs
          ?.call(input.transcriptStore, {
            requestDeliveryId: input.handle.runId,
            messages: [
              ...(input.previousCheckpoint?.storedMessages ?? []),
              ...(input.retainedPredecessorMessages ?? []),
            ],
          })
          .match({ ok: () => null, err: (error) => error })
      : null;
    if (!ownershipRollbackError) return Result.err(writeDecision.error);
    return Result.err(
      new AgentRunCheckpointOwnershipRollbackFailed({
        message: "Agent run checkpoint blob ownership rollback failed",
        journalError: writeDecision.error,
        cleanupError: ownershipRollbackError,
      }),
    );
  }

  const advanced = writeDecision.handle.sequence !== input.handle.sequence;
  const committedPredecessorMessages = advanced
    ? (input.previousCheckpoint?.storedMessages ?? [])
    : (input.retainedPredecessorMessages ?? []);
  const cleanupError = input.transcriptStore?.replaceAgentRunCheckpointBlobs
    ?.call(input.transcriptStore, {
      requestDeliveryId: input.handle.runId,
      messages: [...messages, ...committedPredecessorMessages],
    })
    .match({ ok: () => undefined, err: (error) => error });
  return Result.ok({
    handle: writeDecision.handle,
    messages,
    advanced,
    ...(cleanupError ? { cleanupError } : {}),
  });
}
