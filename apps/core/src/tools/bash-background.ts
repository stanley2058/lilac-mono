import { bashInputSchema } from "@stanley2058/lilac-coding-tools/schemas";
import { createLogger } from "@stanley2058/lilac-utils";
import { Result } from "better-result";
import { z } from "zod";

import { JOB_LIMITS, type JobMode, type JobOwner } from "../jobs/job-domain";
import type { JobService } from "../jobs/job-service";
import { prepareBackgroundBashLaunch, type BashToolInput, type BashToolOutput } from "./bash-impl";
import { redactSecrets } from "./bash-safety/format";
import {
  JobToolInputInvalid,
  JobToolUnavailable,
  jobRequestContextSchema,
  projectJob,
  settled,
  type JobLogFields,
} from "./job";
import { prepareRestrictedBackgroundLaunch, type RestrictedBashContext } from "./restricted-bash";
import { adaptToolResultToHost } from "./tool-result-adapters";

const logger = createLogger({ module: "tool:bash-background" });

const LABEL_MAX_LENGTH = 80;

export type BackgroundJobModes = readonly [JobMode, ...JobMode[]];

/** What a run may start in the background. Absent when the run cannot start jobs. */
export type BashBackgroundOptions = {
  readonly service: JobService;
  readonly modes: BackgroundJobModes;
  readonly runProfile: string;
};

export type BashBackgroundFields = {
  readonly background?: JobMode;
  readonly label?: string;
};

export function bashBackgroundInputSchema(modes: BackgroundJobModes) {
  return bashInputSchema.extend({
    background: z
      .enum(modes)
      .optional()
      .describe(
        `Run the command as a background job instead of waiting for it. The tool description says which mode to choose. timeoutMs becomes the job's time limit, which defaults to ${JOB_LIMITS.awaitDefaultTimeoutMs} ms for await and ${JOB_LIMITS.serviceDefaultTimeoutMs} ms for service, up to ${JOB_LIMITS.maxTimeoutMs} ms. The 3-minute no-output limit does not apply.`,
      ),
    label: z
      .string()
      .min(1)
      .max(LABEL_MAX_LENGTH)
      .optional()
      .describe("Short name shown when a background job reports back. Defaults to the command."),
  });
}

const MODE_GUIDANCE: Readonly<Record<JobMode, string>> = {
  await:
    "- await: report the result in your current reply. The request stays open until the job ends. Do the work that does not need its result, then stop: call skip_reply with the reason you are waiting, or end your turn if you do not have skip_reply. The job_event resumes you in the same request, where you finish the reply. Use it for a build or test run whose result answers the request.",
  service:
    "- service: report in a later turn. Your reply finishes the request, and the job keeps running. When the job ends, its job_event starts a new turn. Use it for a dev server, and for any job you report on after replying, such as a watch on a PR or a site.",
};

export function describeBashBackground(options: BashBackgroundOptions): string {
  const { modes } = options;
  return [
    "",
    "",
    "Set background to run the command as a job. A job_event message tells you when it ends. Use the job tool to list, read, or stop jobs.",
    "Choose the mode by when you report the job's result:",
    ...modes.map((mode) => MODE_GUIDANCE[mode]),
    "To wait for a condition, start a command that exits when it is true, for example: until curl -sf localhost:3000; do sleep 1; done.",
    "A job stops at its time limit, and it is reported lost if Core restarts, so start it again if you still need it. Background jobs cannot run on SSH targets. Restricted Bash writes a job's output only when it ends.",
    ...(modes.includes("service")
      ? [
          "Commands keep their process environment, but Lilac's tools CLI stops working in a service once its request ends.",
        ]
      : []),
    ...(options.runProfile === "primary"
      ? []
      : [
          "As a subagent, every job you start stops when your run ends, and its events go nowhere after that. Use service only for work you need while you are still running.",
        ]),
  ].join("\n");
}

function defaultLabel(command: string): string {
  const firstLine = redactSecrets(command).trim().split("\n")[0] ?? "";
  return firstLine.slice(0, LABEL_MAX_LENGTH) || "background command";
}

function unsupported(message: string): never {
  return adaptToolResultToHost(Result.err(new JobToolInputInvalid({ message })));
}

/** Restricted Bash settings for a run whose commands use the virtual shell. */
export type RestrictedBackgroundTarget = {
  readonly workspaceRoot: string;
  readonly context: RestrictedBashContext;
};

export async function startBackgroundBash(input: {
  readonly args: BashToolInput & { readonly background: JobMode; readonly label?: string };
  readonly options: BashBackgroundOptions;
  readonly context: unknown;
  readonly toolCallId: string;
  readonly controlCapability?: string;
  readonly restricted?: RestrictedBackgroundTarget;
}): Promise<BashToolOutput> {
  const { args, options, toolCallId } = input;
  const decoded = jobRequestContextSchema.safeParse(input.context);
  if (!decoded.success) {
    return adaptToolResultToHost(
      Result.err(
        new JobToolUnavailable({
          message: "Background commands require an authenticated request from a supported surface",
        }),
      ),
    );
  }
  const request = decoded.data;
  if (!options.modes.includes(args.background)) {
    return unsupported(`Background mode ${args.background} is unavailable in this session`);
  }
  const label = args.label ?? defaultLabel(args.command);
  const requestFields: JobLogFields = {
    requestId: request.requestId,
    sessionId: request.sessionId,
    requestClient: request.requestClient,
    toolCallId,
  };
  logger.info("job start", {
    ...requestFields,
    mode: args.background,
    label,
    command: redactSecrets(args.command),
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    dangerouslyAllow: args.dangerouslyAllow === true,
    restricted: input.restricted !== undefined,
  });

  const prepared = input.restricted
    ? prepareRestrictedBackgroundLaunch(args, {
        workspaceRoot: input.restricted.workspaceRoot,
        context: input.restricted.context,
        toolCallId,
      })
    : await prepareBackgroundBashLaunch(args, {
        context: {
          requestId: request.requestId,
          ...(request.requestDeliveryId ? { requestDeliveryId: request.requestDeliveryId } : {}),
          sessionId: request.sessionId,
          requestClient: request.requestClient,
          ...(request.currentTurnUserId ? { currentTurnUserId: request.currentTurnUserId } : {}),
        },
        toolCallId,
        ...(input.controlCapability ? { controlCapability: input.controlCapability } : {}),
        ...(options.runProfile === "primary" ? {} : { subagentProfile: options.runProfile }),
      });
  switch (prepared.kind) {
    case "blocked":
      logger.warn("job blocked", {
        ...requestFields,
        reason: prepared.output.executionError?.type,
      });
      return prepared.output;
    case "unsupported":
      return unsupported(prepared.message);
    case "ready":
      break;
    default: {
      const exhaustive: never = prepared;
      return exhaustive;
    }
  }

  const owner: JobOwner = {
    requestId: request.requestId,
    requestDeliveryId: request.requestDeliveryId ?? null,
    sessionId: request.sessionId,
    platform: request.requestClient,
    userId: request.currentTurnUserId ?? null,
    originMessageId: request.currentTurnMessageRef?.messageId ?? null,
    runProfile: options.runProfile,
  };
  const job = settled(
    "start",
    requestFields,
    await options.service.start({
      owner,
      toolCallId,
      mode: args.background,
      label,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      launch: prepared.launch,
    }),
  );
  logger.info("job start done", { ...requestFields, jobId: job.jobId, status: job.status });
  return {
    stdout: `Started background job ${job.jobId} (${job.mode}). A job_event reports when it ends.`,
    stderr: "",
    exitCode: 0,
    job: projectJob(job),
  };
}
