import { z } from "zod";

export const JOB_LIMITS = {
  awaitDefaultTimeoutMs: 30 * 60 * 1000,
  serviceDefaultTimeoutMs: 4 * 60 * 60 * 1000,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
  maxRunningPerSession: 8,
  maxRunningGlobal: 64,
  maxOutputBytes: 50 * 1024 * 1024,
  eventTailBytes: 4 * 1024,
  defaultReadBytes: 16 * 1024,
  maxReadBytes: 64 * 1024,
  maxConsecutiveWakes: 10,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  wakeDebounceMs: 250,
  wakeRetryDelaysMs: [5_000, 30_000, 120_000, 600_000],
  hardKillDelayMs: 2_000,
  streamDrainMs: 3_000,
} as const;

export const jobModeSchema = z.enum(["await", "service"]);
export type JobMode = z.output<typeof jobModeSchema>;

export const jobPlatformSchema = z.enum(["discord", "native"]);
export type JobPlatform = z.output<typeof jobPlatformSchema>;

export const jobStatusSchema = z.enum([
  "starting",
  "running",
  "exited",
  "stopped",
  "timed_out",
  "lost",
  "failed",
]);
export type JobStatus = z.output<typeof jobStatusSchema>;

export const jobDeliverySchema = z.enum(["none", "pending", "acknowledged", "suppressed"]);
export type JobDelivery = z.output<typeof jobDeliverySchema>;

export const jobStopReasonSchema = z.enum([
  "job_stop",
  "user_stop",
  "time_limit",
  "core_restart",
  "spawn_failed",
  "request_ended",
  "subagent_ended",
  "thread_settled",
  "thread_archived",
  "thread_deleted",
  "thread_rewound",
]);
export type JobStopReason = z.output<typeof jobStopReasonSchema>;

export type JobOwner = {
  readonly requestId: string;
  readonly requestDeliveryId: string | null;
  readonly sessionId: string;
  readonly platform: JobPlatform;
  readonly userId: string | null;
  readonly originMessageId: string | null;
  readonly runProfile: string;
};

export type JobRecord = JobOwner & {
  readonly jobId: string;
  readonly launchKey: string;
  readonly toolCallId: string;
  readonly mode: JobMode;
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly pid: number | null;
  readonly processStartTicks: string | null;
  readonly status: JobStatus;
  readonly exitCode: number | null;
  readonly stopReason: JobStopReason | null;
  readonly delivery: JobDelivery;
  readonly wakeId: string | null;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
  readonly deadlineAt: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
};

export type JobEvent = {
  readonly job: JobRecord;
  readonly outputTail: string;
  readonly outputTailTruncated: boolean;
};

export function isJobActive(status: JobStatus): boolean {
  return status === "starting" || status === "running";
}

export function jobLogFileName(jobId: string): string {
  return `${jobId}.log`;
}

export function describeJobOutcome(job: Pick<JobRecord, "status" | "exitCode">): string {
  switch (job.status) {
    case "exited":
      return `exited with code ${job.exitCode ?? "unknown"}`;
    case "timed_out":
      return "reached its time limit and was stopped";
    case "lost":
      return "was lost when Core restarted";
    case "stopped":
      return "was stopped";
    case "failed":
      return "failed to start";
    case "starting":
    case "running":
      return "is still running";
    default: {
      const exhaustive: never = job.status;
      return exhaustive;
    }
  }
}
