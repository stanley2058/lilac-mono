import { conversationReferenceSchema } from "./references.ts";
import type { InferContractRouterInputs, InferContractRouterOutputs } from "@orpc/contract";
import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import {
  hydrationSchema,
  identitySchema,
  liveUpdateSchema,
  replayCheckpointSchema,
  replayReplySchema,
  revisionSchema,
  runIdentitySchema,
  displayMessageSchema,
  displayPartSchema,
  MAX_REPLAY_BATCH_BYTES,
} from "./replay.ts";
import {
  nativeDeploymentSettingsSchema,
  nativeDeploymentDocumentSchema,
  subagentSummarySchema,
  catalogReplySchema,
  agentIdentitySchema,
  catalogIdentifierSchema,
  configDocumentSchema,
  externalThreadSchema,
  nativeDomainErrorSchema,
  nativeInputReceiptSchema,
  nativeInputSchema,
  nativeThreadSchema,
  nativeUserSchema,
  pageInputSchema,
  participantRoleSchema,
  participantSchema,
  queuedInputSchema,
  resourceDisplaySchema,
  searchHitSchema,
  threadListSchema,
  toolModeSchema,
  mcpReloadReplySchema,
  sidebarSectionSchema,
  sidebarPreferencesSchema,
  sidebarPageSchema,
} from "./domain.ts";

export const nativeErrorMap = {
  AUTH_REFRESH_REQUIRED: { status: 401, data: nativeDomainErrorSchema },
  UNAUTHENTICATED: { status: 401, data: nativeDomainErrorSchema },
  FORBIDDEN: { status: 403, data: nativeDomainErrorSchema },
  NOT_FOUND: { status: 404, data: nativeDomainErrorSchema },
  CONFLICT: { status: 409, data: nativeDomainErrorSchema },
  INVALID_INPUT: { status: 422, data: nativeDomainErrorSchema },
  NOT_READY: { status: 503, data: nativeDomainErrorSchema },
};
const procedure = oc.errors(nativeErrorMap);
const threadIdInput = z.strictObject({ threadId: identitySchema });
const mutationInput = threadIdInput.extend({
  commandId: identitySchema,
  historyGeneration: revisionSchema,
});
const successSchema = z.strictObject({ ok: z.literal(true) });
export const threadSyncInputSchema = threadIdInput.extend({
  checkpoint: replayCheckpointSchema.optional(),
});

export const nativeSyncContract = {
  threads: {
    sync: procedure.input(threadSyncInputSchema).output(replayReplySchema),
    watch: procedure.input(threadSyncInputSchema).output(eventIterator(replayReplySchema)),
  },
};

export const threadEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("replay"), reply: replayReplySchema }),
  z.strictObject({ kind: z.literal("update"), update: liveUpdateSchema }),
  z.strictObject({ kind: z.literal("hydration"), hydration: hydrationSchema }),
  z.strictObject({ kind: z.literal("thread"), thread: nativeThreadSchema }),
  z.strictObject({ kind: z.literal("input"), receipt: nativeInputReceiptSchema }),
  z.strictObject({ kind: z.literal("revoked") }),
  z.strictObject({ kind: z.literal("deleted") }),
]);
export const bootstrapInputSchema = z.strictObject({
  threadId: identitySchema.optional(),
  checkpoint: replayCheckpointSchema.optional(),
  catalogRevision: identitySchema.optional(),
});
export const bootstrapReplySchema = z.strictObject({
  installationId: identitySchema,
  viewer: nativeUserSchema,
  threads: threadListSchema,
  catalog: catalogReplySchema,
  selectedThread: replayReplySchema.optional(),
  selectedThreadUnavailable: z.literal(true).optional(),
  catalogCursor: identitySchema,
});
export const catalogEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), thread: nativeThreadSchema, cursor: identitySchema }),
  z.strictObject({ kind: z.literal("removed"), threadId: identitySchema, cursor: identitySchema }),
  z.strictObject({
    kind: z.literal("catalog-invalidated"),
    revision: identitySchema,
    cursor: identitySchema,
  }),
  z.strictObject({ kind: z.literal("resync"), cursor: identitySchema }),
]);
export const hydrationInputSchema = threadIdInput.extend({
  historyGeneration: revisionSchema,
  projectionRevision: revisionSchema,
  slotId: identitySchema,
});
export const turnPageChunkSchema = z.strictObject({
  messageId: identitySchema,
  partIndex: revisionSchema,
  part: displayPartSchema,
});
export const turnPageSchema = z
  .strictObject({
    turnId: identitySchema,
    historyGeneration: revisionSchema,
    projectionRevision: revisionSchema,
    messages: z.array(displayMessageSchema).max(128),
    chunks: z.array(turnPageChunkSchema).max(128).optional(),
    nextCursor: identitySchema.optional(),
  })
  .refine(
    (page) => new TextEncoder().encode(JSON.stringify(page)).byteLength <= MAX_REPLAY_BATCH_BYTES,
    {
      message: "Turn page exceeds the batch byte budget",
    },
  );
export const nativeContract = {
  links: {
    preview: procedure.input(z.strictObject({ url: z.string().min(1).max(8192) })).output(
      z.strictObject({
        title: z.string().max(512).optional(),
        description: z.string().max(2048).optional(),
        image: z.string().max(8192).optional(),
        icon: z.string().max(8192).optional(),
      }),
    ),
  },
  sidebar: {
    preferences: procedure.input(z.strictObject({})).output(sidebarPreferencesSchema),
    configure: procedure.input(sidebarPreferencesSchema).output(sidebarPreferencesSchema),
    list: procedure
      .input(
        pageInputSchema.extend({
          section: sidebarSectionSchema,
          limit: z.number().int().min(0).max(100).default(30),
        }),
      )
      .output(sidebarPageSchema),
    move: procedure
      .input(
        threadIdInput.extend({
          section: sidebarSectionSchema,
          atStart: z.boolean().optional(),
          beforeId: identitySchema.optional(),
          afterId: identitySchema.optional(),
        }),
      )
      .output(successSchema),
  },
  connection: {
    reauthenticate: procedure
      .input(z.strictObject({ token: z.string().min(1).max(16_384) }))
      .output(nativeUserSchema),
    logout: procedure.input(z.strictObject({})).output(successSchema),
  },
  bootstrap: {
    get: procedure.input(bootstrapInputSchema).output(bootstrapReplySchema),
    watch: procedure
      .input(z.strictObject({ cursor: identitySchema }))
      .output(eventIterator(catalogEventSchema)),
  },
  threads: {
    get: procedure.input(threadIdInput).output(nativeThreadSchema),
    list: procedure
      .input(
        pageInputSchema.extend({
          archived: z.boolean().optional(),
          excludeSettled: z.boolean().optional(),
          query: z.string().max(256).optional(),
        }),
      )
      .output(threadListSchema),
    create: procedure
      .input(
        z.strictObject({
          commandId: identitySchema,
          title: z.string().max(512),
          autoTitle: z.boolean().optional(),
          modelId: catalogIdentifierSchema.optional(),
        }),
      )
      .output(nativeThreadSchema),
    update: procedure
      .input(
        threadIdInput.extend({
          expectedRevision: revisionSchema,
          title: z.string().max(512).optional(),
          archived: z.boolean().optional(),
          modelId: catalogIdentifierSchema.optional(),
        }),
      )
      .output(nativeThreadSchema),
    delete: procedure.input(mutationInput).output(successSchema),
    markRead: procedure
      .input(threadIdInput.extend({ turnId: identitySchema }))
      .output(successSchema),
    sync: procedure.input(threadSyncInputSchema).output(replayReplySchema),
    watch: procedure.input(threadSyncInputSchema).output(eventIterator(threadEventSchema)),
    hydrate: procedure.input(hydrationInputSchema).output(hydrationSchema),
    turnPage: procedure
      .input(
        threadIdInput.extend({
          turnId: identitySchema,
          historyGeneration: revisionSchema,
          projectionRevision: revisionSchema,
          cursor: identitySchema,
        }),
      )
      .output(turnPageSchema),
    rewind: procedure
      .input(mutationInput.extend({ turnId: identitySchema, expectedRevision: revisionSchema }))
      .output(z.strictObject({ text: z.string().max(65_536), checkpoint: replayCheckpointSchema })),
  },
  actions: {
    invoke: procedure
      .input(
        threadIdInput.extend({
          messageId: identitySchema,
          actionId: z.string().min(1).max(512),
          requestId: z.string().min(1).max(512),
          revision: revisionSchema,
          commandId: identitySchema,
        }),
      )
      .output(z.strictObject({ outcome: z.enum(["accepted", "already-applied", "stale"]) })),
  },
  reactions: {
    set: procedure
      .input(
        threadIdInput.extend({
          messageId: identitySchema,
          emoji: z.string().min(1).max(128),
          active: z.boolean(),
        }),
      )
      .output(successSchema),
  },
  participants: {
    list: procedure
      .input(threadIdInput)
      .output(z.strictObject({ items: z.array(participantSchema).max(256) })),
    set: procedure
      .input(threadIdInput.extend({ userId: identitySchema, role: participantRoleSchema }))
      .output(successSchema),
    remove: procedure.input(threadIdInput.extend({ userId: identitySchema })).output(successSchema),
  },
  profile: {
    get: procedure.input(z.strictObject({})).output(nativeUserSchema),
    update: procedure
      .input(z.strictObject({ displayName: z.string().trim().min(1).max(256) }))
      .output(nativeUserSchema),
  },
  identity: {
    update: procedure
      .input(
        z.strictObject({
          displayName: z.string().trim().min(1).max(256),
          discordUserId: z
            .string()
            .regex(/^[0-9]{1,20}$/)
            .nullable()
            .optional(),
        }),
      )
      .output(agentIdentitySchema),
  },
  users: {
    list: procedure.input(pageInputSchema).output(
      z.strictObject({
        items: z.array(nativeUserSchema).max(100),
        nextCursor: identitySchema.optional(),
      }),
    ),
    add: procedure
      .input(
        z.strictObject({ providerUserId: z.string().min(1).max(256), toolMode: toolModeSchema }),
      )
      .output(nativeUserSchema),
    setToolMode: procedure
      .input(z.strictObject({ userId: identitySchema, toolMode: toolModeSchema }))
      .output(nativeUserSchema),
  },
  inputs: {
    submit: procedure.input(nativeInputSchema).output(nativeInputReceiptSchema),
  },
  runs: {
    cancel: procedure
      .input(mutationInput.extend({ runId: runIdentitySchema.optional() }))
      .output(successSchema),
    queue: procedure
      .input(threadIdInput)
      .output(z.strictObject({ items: z.array(queuedInputSchema).max(128) })),
    removeQueued: procedure
      .input(mutationInput.extend({ inputId: identitySchema }))
      .output(successSchema),
  },
  catalogs: {
    get: procedure
      .input(z.strictObject({ revision: identitySchema.optional() }))
      .output(catalogReplySchema),
  },
  files: {
    resolve: procedure.input(threadIdInput.extend({ path: z.string().min(1).max(4096) })).output(
      z.strictObject({
        path: z.string(),
        name: z.string(),
        mediaType: z.string(),
        href: z.string(),
      }),
    ),
  },
  resources: {
    reserve: procedure
      .input(
        threadIdInput.extend({
          commandId: identitySchema,
          name: z.string().min(1).max(512),
          mediaType: z.string().min(1).max(256),
          size: revisionSchema,
        }),
      )
      .output(resourceDisplaySchema),
    get: procedure
      .input(z.strictObject({ resourceId: identitySchema }))
      .output(resourceDisplaySchema),
  },
  config: {
    readDeployment: procedure.input(z.strictObject({})).output(nativeDeploymentDocumentSchema),
    setDeployment: procedure
      .input(
        z.strictObject({
          settings: nativeDeploymentSettingsSchema,
          expectedRevision: revisionSchema,
        }),
      )
      .output(nativeDeploymentDocumentSchema),
    read: procedure
      .input(z.strictObject({ kind: z.enum(["core", "mcp"]) }))
      .output(configDocumentSchema),
    save: procedure
      .input(
        z.strictObject({
          kind: z.enum(["core", "mcp"]),
          expectedRevision: identitySchema,
          text: z.string().max(1_048_576),
        }),
      )
      .output(configDocumentSchema),
    reloadMcp: procedure.input(z.strictObject({})).output(mcpReloadReplySchema),
  },
  references: {
    range: procedure.input(conversationReferenceSchema).output(conversationReferenceSchema),
    resolve: procedure.input(conversationReferenceSchema).output(
      z.strictObject({
        title: z.string().max(512),
        conversationThreadId: z.string().max(512).optional(),
        sourceUrl: z.url().optional(),
      }),
    ),
    read: procedure
      .input(
        z.strictObject({
          target: conversationReferenceSchema,
          cursor: identitySchema.optional(),
          direction: z.enum(["before", "after"]).optional(),
        }),
      )
      .output(
        z.strictObject({
          title: z.string().max(512),
          messages: z.array(displayMessageSchema).max(128),
          nextCursor: identitySchema.optional(),
          messageFound: z.boolean(),
          checkpoint: replayCheckpointSchema.optional(),
          anchorMessageId: identitySchema.optional(),
          nextAfter: identitySchema.optional(),
          sourceUrl: z.url().optional(),
        }),
      ),
  },
  search: {
    query: procedure
      .input(
        pageInputSchema.extend({
          query: z.string().min(1).max(1024),
          threadId: identitySchema.optional(),
        }),
      )
      .output(
        z.strictObject({
          items: z.array(searchHitSchema).max(100),
          nextCursor: identitySchema.optional(),
        }),
      ),
  },
  subagents: {
    list: procedure.input(threadIdInput.extend({ cursor: identitySchema.optional() })).output(
      z.strictObject({
        items: z.array(subagentSummarySchema).max(100),
        nextCursor: identitySchema.optional(),
      }),
    ),
    read: procedure
      .input(
        threadIdInput.extend({
          agentId: runIdentitySchema,
          before: z.number().int().nonnegative().optional(),
          from: z.number().int().nonnegative().optional(),
        }),
      )
      .output(
        z.strictObject({
          agent: subagentSummarySchema,
          messages: z.array(displayMessageSchema).max(40),
          nextBefore: z.number().int().nonnegative().optional(),
          unavailable: z.boolean(),
          offset: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        }),
      ),
  },
  external: {
    list: procedure.input(pageInputSchema).output(
      z.strictObject({
        items: z.array(externalThreadSchema).max(100),
        nextCursor: identitySchema.optional(),
      }),
    ),
    read: procedure
      .input(z.strictObject({ threadId: identitySchema, cursor: identitySchema.optional() }))
      .output(
        z.strictObject({
          thread: externalThreadSchema,
          messages: z.array(displayMessageSchema).max(128),
          nextCursor: identitySchema.optional(),
        }),
      ),
  },
};

export type NativeContract = typeof nativeContract;
export type ThreadEvent = z.infer<typeof threadEventSchema>;
export type BootstrapReply = z.infer<typeof bootstrapReplySchema>;
export type BootstrapInput = z.infer<typeof bootstrapInputSchema>;
export type CatalogEvent = z.infer<typeof catalogEventSchema>;
export type TurnPage = z.infer<typeof turnPageSchema>;
export type HydrationInput = z.infer<typeof hydrationInputSchema>;
export type NativeErrorCode = keyof typeof nativeErrorMap;

export type NativeRpcInputs = InferContractRouterInputs<typeof nativeContract>;
export type NativeRpcOutputs = InferContractRouterOutputs<typeof nativeContract>;

export type TurnPageChunk = z.infer<typeof turnPageChunkSchema>;
