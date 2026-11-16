import { CronExpressionParser } from "cron-parser";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";

export type CronScheduleInput = {
  expr: string;
  tz?: string;
  startAtMs?: number;
  /** If true, compute next run strictly after now/start. Default: true. */
  skipMissed?: boolean;
};

export class WorkflowCronInvalid extends TaggedError("WorkflowCronInvalid")<{
  readonly expression: string;
  readonly message: string;
}> {}

function ensureFiveFieldCron(expr: string): ResultType<string, WorkflowCronInvalid> {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/g).filter(Boolean);
  if (parts.length !== 5) {
    return Result.err(
      new WorkflowCronInvalid({
        expression: expr,
        message: `Invalid cron expression '${expr}'. Expected 5 fields (minute precision).`,
      }),
    );
  }
  return Result.ok(trimmed);
}

/** Compute the next cron run timestamp (ms since epoch). */
export function computeNextCronAtMsResult(
  input: CronScheduleInput,
  nowMs: number,
): ResultType<number, WorkflowCronInvalid> {
  const compute = ensureFiveFieldCron(input.expr).match<
    () => ResultType<number, WorkflowCronInvalid>
  >({
    err: (error) => () => Result.err(error),
    ok: (expression) => () => {
      const tz = input.tz ?? "UTC";
      const startAtMs =
        typeof input.startAtMs === "number" && Number.isFinite(input.startAtMs)
          ? Math.trunc(input.startAtMs)
          : undefined;
      const baseMs = startAtMs !== undefined ? Math.max(nowMs, startAtMs) : nowMs;

      // cron-parser's next() is strict (> currentDate). Subtract 1ms so boundary-aligned
      // schedules can fire exactly at baseMs.
      const currentDate = new Date(baseMs - 1);
      const parsed = Result.try({
        try: () =>
          CronExpressionParser.parse(expression, { currentDate, tz }).next().toDate().getTime(),
        catch: captureRuntimeError,
      }).mapError((captured) =>
        projectCapturedRuntimeError(captured, "Opaque workflow cron failure"),
      );
      if (parsed.isErr()) {
        const cause = preserveToolPanic(parsed.error);
        return Result.err(
          new WorkflowCronInvalid({
            expression: input.expr,
            message: opaqueErrorMessage(cause, "Invalid workflow cron expression"),
          }),
        );
      }
      return Result.ok(parsed.value);
    },
  });
  return compute();
}

export function computeNextCronAtMs(input: CronScheduleInput, nowMs: number): number {
  return adaptToolResultToHost(computeNextCronAtMsResult(input, nowMs));
}
