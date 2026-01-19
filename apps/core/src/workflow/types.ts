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

export type WorkflowState =
  | "queued"
  | "running"
  | "blocked"
  | "resolved"
  | "failed"
  | "cancelled";

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

  definition: WorkflowDefinitionV2;

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
