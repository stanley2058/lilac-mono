import { Panic, Result } from "better-result";

export function captureInstallerException(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Opaque installer exception");
}

export function isInstallerCancellation(error: Error): boolean {
  if (error.name === "AbortError") return true;
  // Result.gen wraps a rejected readline question in Panic before setup can handle cancellation.
  if (Panic.is(error) && error.message === "generator body threw" && error.cause instanceof Error) {
    return isInstallerCancellation(error.cause);
  }
  return false;
}

type Attempt<T> = { kind: "value"; value: T } | { kind: "failure"; error: Error };

export async function withInstallerCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  const operationResult = await Result.tryPromise({
    try: operation,
    catch: captureInstallerException,
  });
  const attempted = operationResult.match<Attempt<T>>({
    ok: (value) => ({ kind: "value", value }),
    err: (error) => ({ kind: "failure", error }),
  });
  const cleanupResult = await Result.tryPromise({
    try: async () => cleanup(),
    catch: captureInstallerException,
  });
  const cleanupError = cleanupResult.match({ ok: () => undefined, err: (error) => error });
  if (
    attempted.kind === "failure" &&
    Panic.is(attempted.error) &&
    !isInstallerCancellation(attempted.error)
  )
    throw attempted.error;
  if (cleanupError && Panic.is(cleanupError)) throw cleanupError;
  if (attempted.kind === "failure") throw attempted.error;
  if (cleanupError) throw cleanupError;
  return attempted.value;
}

export async function runInstallerHost(
  operation: () => Promise<number>,
  report: (message: string) => void,
): Promise<number> {
  const attempted = await Result.tryPromise({
    try: operation,
    catch: captureInstallerException,
  });
  const outcome = attempted.match({
    ok: (code) => ({ code, failed: false }),
    err: () => ({ code: 1, failed: true }),
  });
  if (outcome.failed) {
    report(
      "Lilac setup stopped because of an internal error. Update the installer and retry. Error details were withheld to protect credentials.",
    );
  }
  return outcome.code;
}
