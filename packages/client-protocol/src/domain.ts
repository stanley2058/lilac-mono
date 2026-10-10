import { z } from "zod";
import { identitySchema, revisionSchema, runIdentitySchema } from "./replay.ts";

export const catalogIdentifierSchema = z.string().min(1).max(512);

export const toolModeSchema = z.enum(["restricted", "full"]);
export const participantRoleSchema = z.enum(["read", "edit"]);
export const nativeUserSchema = z.strictObject({
  id: identitySchema,
  displayName: z.string().min(1).max(256),
  avatarUrl: z.string().max(2048).optional(),
  role: z.enum(["owner", "participant", "service"]),
  toolMode: toolModeSchema,
});
export const threadCapabilitiesSchema = z.strictObject({
  read: z.boolean(),
  edit: z.boolean(),
  share: z.boolean(),
});
export const nativeThreadSchema = z.strictObject({
  id: identitySchema,
  title: z.string().max(512),
  starterId: identitySchema,
  starterAvatarUrl: z.string().max(2048).optional(),
  starterDisplayName: z.string().max(256).optional(),
  displayStatus: z.enum(["idle", "completed", "working", "error"]).optional(),
  activeRunId: runIdentitySchema.optional(),
  archived: z.boolean(),
  updatedAt: revisionSchema,
  revision: revisionSchema,
  capabilities: threadCapabilitiesSchema,
  modelId: catalogIdentifierSchema.optional(),
});
export const participantSchema = z.strictObject({
  user: nativeUserSchema,
  role: participantRoleSchema,
});
export const pageInputSchema = z.strictObject({
  cursor: identitySchema.optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export const threadListSchema = z.strictObject({
  items: z.array(nativeThreadSchema).max(100),
  nextCursor: identitySchema.optional(),
});
export const sidebarSectionSchema = z.enum(["pinned", "active", "settled"]);
export const sidebarPreferencesSchema = z.strictObject({
  autoSettleDays: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7), z.literal(30)]),
});
export const sidebarPageSchema = threadListSchema.extend({ total: revisionSchema });
export type SidebarSection = z.infer<typeof sidebarSectionSchema>;
export type SidebarPreferences = z.infer<typeof sidebarPreferencesSchema>;
export const modelChoiceSchema = z.strictObject({
  id: catalogIdentifierSchema,
  label: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
});
export const skillChoiceSchema = z.strictObject({
  id: catalogIdentifierSchema,
  name: z.string().min(1).max(256),
  description: z.string().max(1024),
  source: z.string().min(1).max(128),
});
export const commandArgumentSchema = z.strictObject({
  key: z.string().min(1).max(32),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().max(100).optional(),
  required: z.boolean(),
  choices: z.array(z.string().min(1).max(100)).max(256).optional(),
});
export type CommandArgument = z.infer<typeof commandArgumentSchema>;
export const commandChoiceSchema = z.strictObject({
  id: catalogIdentifierSchema,
  name: z.string().min(1).max(256),
  description: z.string().max(1024),
  kind: z.enum(["builtin", "custom"]),
  argumentHint: z.string().max(256).optional(),
  arguments: z.array(commandArgumentSchema).max(24).optional(),
});
export const agentIdentitySchema = z.strictObject({
  discordUserId: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .optional(),
  id: z.literal("lilac"),
  displayName: z.string().min(1).max(256),
  avatarUrl: z.string().max(512).optional(),
});
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export const displayCatalogSchema = z.strictObject({
  revision: identitySchema,
  agent: agentIdentitySchema.optional(),
  models: z.array(modelChoiceSchema).max(256),
  skills: z.array(skillChoiceSchema).max(512),
  commands: z.array(commandChoiceSchema).max(512),
});
export const catalogReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unchanged"), revision: identitySchema }),
  z.strictObject({ kind: z.literal("catalog"), catalog: displayCatalogSchema }),
]);
export const nativeInputSchema = z
  .strictObject({
    threadId: identitySchema,
    commandId: identitySchema,
    historyGeneration: revisionSchema,
    text: z.string().max(65_536),
    mode: z.enum(["prompt", "steer", "followup"]),
    attachmentIds: z.array(identitySchema).max(32),
    skillIds: z.array(catalogIdentifierSchema).max(32),
    modelId: catalogIdentifierSchema.optional(),
    command: z
      .strictObject({ id: catalogIdentifierSchema, arguments: z.string().max(65_536) })
      .optional(),
  })
  .refine(
    (input) =>
      input.text.trim().length > 0 ||
      input.attachmentIds.length > 0 ||
      input.skillIds.length > 0 ||
      input.command !== undefined,
    {
      message: "Input requires text, an attachment, a skill, or a command",
    },
  )
  .refine(
    (input) =>
      new Set(input.attachmentIds).size === input.attachmentIds.length &&
      new Set(input.skillIds).size === input.skillIds.length,
    {
      message: "Attachment and skill identities must be unique",
    },
  );
export const nativeInputStateSchema = z.enum([
  "uploading",
  "queued",
  "admitted",
  "target-ended",
  "canceled",
  "failed",
]);
export const nativeInputReceiptSchema = z.strictObject({
  inputId: identitySchema,
  messageId: identitySchema,
  turnId: identitySchema.optional(),
  state: nativeInputStateSchema,
  runId: runIdentitySchema.optional(),
});
export const queuedInputSchema = nativeInputReceiptSchema.extend({
  authorId: identitySchema,
  text: z.string().max(4096),
  mode: z.enum(["prompt", "steer", "followup"]),
  createdAt: revisionSchema,
});
export const uploadStateSchema = z.enum(["pending", "ready", "failed", "canceled"]);
export const resourceDisplaySchema = z.strictObject({
  id: identitySchema,
  name: z.string().min(1).max(512),
  mediaType: z.string().min(1).max(256),
  size: revisionSchema,
  state: uploadStateSchema,
  error: z.string().max(512).optional(),
});
export const configDocumentSchema = z.strictObject({
  kind: z.enum(["core", "mcp"]),
  revision: identitySchema,
  text: z.string().max(1_048_576),
});
export const searchHitSchema = z.strictObject({
  threadId: identitySchema,
  turnId: identitySchema.optional(),
  title: z.string().max(512),
  excerpt: z.string().max(2048),
  surface: z.enum(["native", "discord", "github"]),
});
export const externalThreadSchema = z.strictObject({
  sourceUrl: z.url().max(2048).optional(),
  id: identitySchema,
  title: z.string().max(512),
  surface: z.enum(["discord", "github"]),
  updatedAt: revisionSchema.optional(),
  retrievedAt: revisionSchema,
});
export const nativeDomainErrorSchema = z.strictObject({
  message: z.string().min(1).max(4096),
  field: z.string().max(256).optional(),
  currentRevision: z.union([revisionSchema, identitySchema]).optional(),
});

export type NativeUser = z.infer<typeof nativeUserSchema>;
export type NativeThread = z.infer<typeof nativeThreadSchema>;
export type NativeInput = z.infer<typeof nativeInputSchema>;
export type NativeInputReceipt = z.infer<typeof nativeInputReceiptSchema>;
export type NativeInputState = z.infer<typeof nativeInputStateSchema>;
export type DisplayCatalog = z.infer<typeof displayCatalogSchema>;
export type ResourceDisplay = z.infer<typeof resourceDisplaySchema>;
export type NativeDomainError = z.infer<typeof nativeDomainErrorSchema>;
export type QueuedInput = z.infer<typeof queuedInputSchema>;
export type ModelChoice = z.infer<typeof modelChoiceSchema>;
export type SkillChoice = z.infer<typeof skillChoiceSchema>;
export type CommandChoice = z.infer<typeof commandChoiceSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ToolMode = z.infer<typeof toolModeSchema>;

export const mcpReloadReplySchema = z.strictObject({
  servers: z
    .array(
      z.strictObject({
        name: z.string().max(256),
        state: z.enum([
          "available",
          "unavailable",
          "authentication_required",
          "removed",
          "retained",
          "not_found",
        ]),
        reconciliation: z
          .enum(["new", "changed", "removed", "unchanged", "unavailable", "not_found"])
          .optional(),
        error: z.string().max(4096).optional(),
      }),
    )
    .max(256),
});
export type McpReloadReply = z.infer<typeof mcpReloadReplySchema>;
export type ConfigDocument = z.infer<typeof configDocumentSchema>;

export const resourcePreviewSchema = z.strictObject({
  text: z.string().max(65_536),
  truncated: z.boolean(),
  byteLength: z.number().int().nonnegative(),
});
export type ResourcePreview = z.infer<typeof resourcePreviewSchema>;

export const subagentSummarySchema = z.strictObject({
  id: runIdentitySchema,
  activityId: identitySchema,
  turnId: identitySchema,
  profile: z.enum(["explore", "general", "self"]),
  name: z.string().max(256),
  title: z.string().max(256),
  state: z.enum(["running", "complete", "failed", "canceled"]),
  startedAt: revisionSchema,
});
export type SubagentSummary = z.infer<typeof subagentSummarySchema>;

export const workingIndicatorsSchema = z.array(z.string().trim().min(1)).min(1);

export const nativeDeploymentSettingsSchema = z.strictObject({
  titleModel: z.string().trim().min(1),
  outputStreaming: z.enum(["paragraph", "complete"]),
  oldMessageSelectionMaxAgeMs: z.number().int().positive().nullable(),
  storageRetentionMaxAgeMs: z.number().int().positive().nullable(),
  crossThreadSend: z.strictObject({ triggerRun: z.boolean() }),
});
export type NativeDeploymentSettings = z.infer<typeof nativeDeploymentSettingsSchema>;
export const nativeDeploymentDocumentSchema = z.strictObject({
  settings: nativeDeploymentSettingsSchema,
  revision: z.number().int().nonnegative(),
});
