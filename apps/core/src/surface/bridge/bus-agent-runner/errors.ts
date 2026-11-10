import { captureError } from "../../../shared/error-capture";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import {
  extractAiErrorLogDetails,
  isPanic,
  isRecord,
  opaqueErrorMessage,
} from "@stanley2058/lilac-utils";
import { type DeliveryDisposition } from "@stanley2058/lilac-event-bus";
import { AgentIdleTimeoutError } from "@stanley2058/lilac-agent";
import {
  type RequestIdentityAliasTargetOccupied,
  type RequestIdentitySourceMissing,
  type RequestMessageCacheAdmissionError,
} from "../../../tool-server/request-message-cache";
import { AuthenticatedRequestProjectionInvalid } from "../../authenticated-request";
import { formatUnknownErrorForDisplay } from "./error-display";

export function rethrowBusAgentRunnerPanic(
  cause: unknown,
  beforeRethrow?: (panic: Panic) => void,
): void {
  if (!isPanic(cause)) return;
  beforeRethrow?.(cause);
  throw cause;
}

export class BusAgentRunnerRequestHeadersInvalid extends TaggedError(
  "BusAgentRunnerRequestHeadersInvalid",
)<{
  readonly missing: readonly ("request_id" | "session_id")[];
  readonly message: string;
}> {}

export class BusAgentRunnerQueueAttemptRouteInvalid extends TaggedError(
  "BusAgentRunnerQueueAttemptRouteInvalid",
)<{
  readonly eventId: string;
  readonly message: string;
}> {}

export class BusAgentRunnerRecoveryStopped extends TaggedError("BusAgentRunnerRecoveryStopped")<{
  readonly message: string;
}> {}

export class BusAgentRunnerIntakeFailed extends TaggedError("BusAgentRunnerIntakeFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BusAgentRunnerAuthenticationProjectionInvalid extends TaggedError(
  "BusAgentRunnerAuthenticationProjectionInvalid",
)<{
  readonly cause:
    | AuthenticatedRequestProjectionInvalid
    | RequestMessageCacheAdmissionError
    | RequestIdentitySourceMissing
    | RequestIdentityAliasTargetOccupied
    | AuthenticatedRequestProjectionInvalid;
  readonly message: string;
}> {}

export class BusAgentRunnerOperationFailed extends TaggedError("BusAgentRunnerOperationFailed")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly failureKind: "idle-timeout" | "pre-agent-cancelled" | "shutdown-draining" | "other";
  readonly displayMessage: string;
  readonly details?: ReturnType<typeof extractAiErrorLogDetails>;
  readonly message: string;
}> {}

export async function captureBusAgentRunnerOperation<T>(
  operation: string,
  run: () => T | Promise<T>,
  beforePanicRethrow?: (panic: Panic) => void,
): Promise<ResultType<Awaited<T>, BusAgentRunnerOperationFailed>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        return Result.ok(await run());
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      rethrowBusAgentRunnerPanic(cause, beforePanicRethrow);
      const projection = projectBusAgentRunnerError(cause, `${operation} failed`);
      let failureKind: BusAgentRunnerOperationFailed["failureKind"] = "other";
      if (cause instanceof AgentIdleTimeoutError) failureKind = "idle-timeout";
      if (cause instanceof PreAgentRunCancelledError) failureKind = "pre-agent-cancelled";
      if (cause instanceof ShutdownDrainingAbort) failureKind = "shutdown-draining";
      return Result.err(
        new BusAgentRunnerOperationFailed({
          operation,
          cause,
          failureKind,
          displayMessage: formatUnknownErrorForDisplay(cause),
          details: projection.details,
          message: projection.message,
        }),
      );
    }
    return attempt.value;
  }
}

export function signalBusAgentRunnerHostFailure(
  failure: Error | BusAgentRunnerOperationFailed,
): never {
  throw failure instanceof BusAgentRunnerOperationFailed ? failure.cause : failure;
}

export type BusAgentRunnerErrorProjection = {
  readonly message: string;
  readonly details?: ReturnType<typeof extractAiErrorLogDetails>;
};

export function projectBusAgentRunnerError(
  cause: unknown,
  fallback = "Agent runner operation failed",
): BusAgentRunnerErrorProjection {
  const projectedCause =
    isRecord(cause) && cause["loaded"] === false && "error" in cause ? cause["error"] : cause;
  const message = opaqueErrorMessage(projectedCause, fallback);
  {
    const attempt = Result.try({
      try: () => {
        const details = extractAiErrorLogDetails(projectedCause);
        return details ? { message, details } : { message };
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      return { message };
    }
    return attempt.value;
  }
}

export type BusAgentRunnerDeliveryError =
  | BusAgentRunnerRequestHeadersInvalid
  | BusAgentRunnerQueueAttemptRouteInvalid
  | BusAgentRunnerRecoveryStopped
  | BusAgentRunnerAuthenticationProjectionInvalid
  | BusAgentRunnerIntakeFailed;

export function busAgentRunnerDeliveryDisposition(
  error: BusAgentRunnerDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "BusAgentRunnerRequestHeadersInvalid":
    case "BusAgentRunnerQueueAttemptRouteInvalid":
    case "BusAgentRunnerAuthenticationProjectionInvalid":
      return "dead-letter";
    case "BusAgentRunnerRecoveryStopped":
      return "stop";
    case "BusAgentRunnerIntakeFailed":
      return "park-pending";
  }
}

export async function rethrowBusAgentRunnerCleanupDefect(
  cleanup: () => void | Promise<void>,
): Promise<void> {
  await cleanup();
}

export type BusAgentRunnerTerminalCleanup = {
  readonly label:
    | "workflow-claim-timer-clear"
    | "control-capability-expire"
    | "workflow-request-expire"
    | "run-idle-watchdog-stop"
    | "questions-cancel"
    | "agent-unsubscribe"
    | "compaction-unsubscribe"
    | "output-publisher-drain"
    | "core-named-retire"
    | "core-primary-retire"
    | "claude-dispose"
    | "level1-toolset-release"
    | "live-close";
  readonly run: () => void | Promise<void>;
};

export type BusAgentRunnerTerminalCleanupOperation = {
  readonly label: BusAgentRunnerTerminalCleanup["label"];
  readonly operation: Promise<void>;
};

export type BusAgentRunnerTerminalCleanupBatch = {
  readonly operations: readonly BusAgentRunnerTerminalCleanupOperation[];
  readonly completion: Promise<void>;
};

export function startBusAgentRunnerTerminalCleanup(
  cleanups: readonly BusAgentRunnerTerminalCleanup[],
): BusAgentRunnerTerminalCleanupBatch {
  const operations = cleanups.map((cleanup) => {
    const operation = rethrowBusAgentRunnerCleanupDefect(cleanup.run);
    return { label: cleanup.label, operation };
  });
  const completion = Promise.allSettled(operations.map(({ operation }) => operation)).then(
    () => undefined,
  );
  return { operations, completion };
}

export class ShutdownDrainingAbort extends Error {
  constructor() {
    super("server shutting down");
    this.name = "ShutdownDrainingAbort";
  }
}

export class PreAgentRunCancelledError extends Error {
  constructor() {
    super("cancelled before agent start");
    this.name = "PreAgentRunCancelledError";
  }
}
