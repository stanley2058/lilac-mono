import { isPanic } from "@stanley2058/lilac-utils/runtime-utils";
import { Result, type Panic, type Result as ResultType } from "better-result";

export function preserveToolPanic(cause: Panic): never;
export function preserveToolPanic(cause: Error): Error;
export function preserveToolPanic(cause: Error | Panic): Error {
  if (isPanic(cause)) return adaptToolResultToHost(Result.err(cause));
  return cause;
}

/** Translate an internal Result back to a host API whose contract requires rejection. */
export function adaptToolResultToHost<T, E extends Error>(result: ResultType<T, E>): T {
  return result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}
