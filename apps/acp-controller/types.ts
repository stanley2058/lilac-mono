import { z } from "zod";

export const runStatusSchema = z.enum(["submitted", "running", "completed", "failed", "cancelled"]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const sessionPlanEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export type SessionPlanEntry = z.infer<typeof sessionPlanEntrySchema>;

export const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

export type HistoryMessage = z.infer<typeof historyMessageSchema>;

export const permissionCountersSchema = z.object({
  permissionsApproved: z.number().int().nonnegative(),
  permissionsRejected: z.number().int().nonnegative(),
  permissionsCancelled: z.number().int().nonnegative(),
});

export type PermissionCounters = z.infer<typeof permissionCountersSchema>;

export const sessionSummarySchema = z.object({
  title: z.string().optional(),
  cwd: z.string(),
  updatedAt: z.string().optional(),
  capabilities: z.array(z.string()),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const promptRunRecordSchema = z.object({
  id: z.string().regex(/^run_[a-f0-9-]+$/),
  status: runStatusSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  directory: z.string().min(1),
  harnessId: z.string().min(1),
  targetKind: z.enum(["new", "existing"]),
  remoteSessionId: z.string().min(1).optional(),
  sessionRef: z.string().min(1).optional(),
  requestedTitle: z.string().min(1).optional(),
  promptText: z.string(),
  textPreview: z.string(),
  workerPid: z.number().int().positive().optional(),
  cancelRequestedAt: z.number().int().optional(),
  stopReason: z.string().min(1).optional(),
  userMessageId: z.string().uuid().optional(),
  requestedMode: z.string().min(1).optional(),
  requestedModel: z.string().min(1).optional(),
  session: sessionSummarySchema.optional(),
  plan: z.array(sessionPlanEntrySchema).optional(),
  history: z.array(historyMessageSchema).optional(),
  resultText: z.string().optional(),
  permissions: permissionCountersSchema,
  error: z.string().optional(),
});

export type PromptRunRecord = z.infer<typeof promptRunRecordSchema>;

export const sessionIndexEntrySchema = z.object({
  sessionRef: z.string().min(1),
  harnessId: z.string().min(1),
  remoteSessionId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().optional(),
  updatedAt: z.string().optional(),
  capabilities: z.array(z.string()),
  lastSeenAt: z.number().int(),
  localTitle: z.string().optional(),
});

export type SessionIndexEntry = z.infer<typeof sessionIndexEntrySchema>;

export const sessionIndexSchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionIndexEntrySchema),
});

export type SessionIndex = z.infer<typeof sessionIndexSchema>;

export type HarnessDescriptor = {
  id: string;
  title: string;
  description: string;
  launchCandidates: ReadonlyArray<{
    command: string;
    args: readonly string[];
    source: "path" | "fallback";
  }>;
  installHint: string;
};

export type ResolvedHarness = {
  descriptor: HarnessDescriptor;
  command: string;
  args: readonly string[];
  source: "path" | "fallback";
};

export type PermissionBehavior = "once" | "always" | "reject";

export function formatSessionRef(harnessId: string, remoteSessionId: string): string {
  return `${harnessId}::${remoteSessionId}`;
}

export function parseSessionRef(sessionRef: string): {
  harnessId: string;
  remoteSessionId: string;
} | null {
  const marker = sessionRef.indexOf("::");
  if (marker === -1) return null;
  const harnessId = sessionRef.slice(0, marker).trim();
  const remoteSessionId = sessionRef.slice(marker + 2).trim();
  if (!harnessId || !remoteSessionId) return null;
  return { harnessId, remoteSessionId };
}

export function textPreview(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function createEmptyPermissionCounters(): PermissionCounters {
  return {
    permissionsApproved: 0,
    permissionsRejected: 0,
    permissionsCancelled: 0,
  };
}
