import type { ModelMessage } from "ai";

export type WorkflowDefinitionV2 = {
  version: 2;

  origin: {
    request_id: string;
    session_id: string;
    request_client: string;
    user_id?: string;
  };

  resumeTarget: {
    session_id: string;
    request_client: string;
    mention_user_id?: string;
  };

  summary: string;
  completion: "all" | "any";
};

export type ScheduledWorkflowMode = "wait_until" | "wait_for" | "cron";

export type WorkflowDefinitionV3 = {
  version: 3;
  kind: "scheduled";

  /** Optional originator context when scheduled from an active request. */
  origin?: {
    request_id: string;
    session_id: string;
    request_client: string;
    user_id?: string;
  };

  schedule:
    | {
        mode: "wait_until";
        runAtMs: number;
      }
    | {
        mode: "wait_for";
        delayMs: number;
        /** Snapshot of when the schedule was created. */
        createdAtMs: number;
        /** Computed run time for convenience/debug. */
        runAtMs: number;
      }
    | {
        mode: "cron";
        expr: string;
        tz?: string;
        startAtMs?: number;
        /** If true, do not replay missed ticks after downtime. */
        skipMissed?: boolean;
      };

  job: {
    summary: string;
    /** Optional extra system prompt for the job run. */
    systemPrompt?: string;
    /** Primary job instruction payload. */
    userPrompt: string;
    /** Require the agent to finish with a literal DONE token. Default: true. */
    requireDone?: boolean;
    doneToken?: string;
  };
};

export type WorkflowState = "queued" | "running" | "blocked" | "resolved" | "failed" | "cancelled";

export type WorkflowTaskState =
  | "queued"
  | "running"
  | "blocked"
  | "resolved"
  | "failed"
  | "cancelled";

export type WorkflowRecord = {
  workflowId: string;
  state: WorkflowState;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  /** When the resume request was successfully published. */
  resumePublishedAt?: number;

  definition: WorkflowDefinitionV2 | WorkflowDefinitionV3;

  /**
   * Monotonic sequence used to build resume request ids.
   * The workflow service increments this when the workflow transitions to resolved.
   */
  resumeSeq: number;
};

export type WorkflowTaskRecord = {
  workflowId: string;
  taskId: string;
  kind: string;
  description: string;
  state: WorkflowTaskState;
  input?: unknown;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;

  /** Used for idempotent task resolution (e.g. replyMessageId). */
  resolvedBy?: string;

  /** Optional kind-specific indexed fields (for persistence-friendly lookups). */
  discordChannelId?: string;
  discordMessageId?: string;
  discordFromUserId?: string;
  timeoutAt?: number;
};

export type ResumeContext = {
  workflow: {
    workflowId: string;
    summary: string;
    origin: WorkflowDefinitionV2["origin"];
    resumeTarget: WorkflowDefinitionV2["resumeTarget"];
    completion: WorkflowDefinitionV2["completion"];
  };
  tasks: Array<{
    taskId: string;
    kind: string;
    description: string;
    state: WorkflowTaskState;
    input?: unknown;
    result?: unknown;
    resolvedAt?: number;
  }>;
};

export type ResumeRequest = {
  requestId: string;
  sessionId: string;
  requestClient: string;
  queue: "prompt";
  messages: ModelMessage[];
  raw: unknown;
};
