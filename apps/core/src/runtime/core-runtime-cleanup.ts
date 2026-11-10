import { isPanic } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";
import { projectRuntimeError, safeRuntimeErrorText } from "./error-format";

export type CoreRuntimeCleanupFailure = {
  readonly label: string;
  readonly error: string;
  readonly panic: boolean;
};

export type CoreRuntimeCleanupSupervisor = {
  readonly failures: readonly CoreRuntimeCleanupFailure[];
  readonly panics: readonly Panic[];
  record(label: string, cause: Error): void;
  run(label: string, cleanup: (() => Promise<void>) | undefined): Promise<void>;
  runOutcome<E extends Error>(
    label: string,
    cleanup:
      | (() => Promise<
          | { readonly kind: "result"; readonly result: ResultType<void, E> }
          | { readonly kind: "panic"; readonly panic: Panic }
        >)
      | undefined,
  ): Promise<void>;
  finish(): void;
};

export function createCoreRuntimeCleanupSupervisor(
  priorPanic: Panic | null,
): CoreRuntimeCleanupSupervisor {
  const failures: CoreRuntimeCleanupFailure[] = [];
  const panics: Panic[] = [];

  function record(label: string, cause: Error, fallback = "Opaque cleanup failure"): void {
    const panic = isPanic(cause);
    if (panic) panics.push(cause);
    failures.push({
      label,
      error: safeRuntimeErrorText(cause, fallback),
      panic,
    });
  }

  async function run(label: string, cleanup: (() => Promise<void>) | undefined): Promise<void> {
    if (!cleanup) return;
    const [settled] = await Promise.allSettled([Promise.resolve().then(cleanup)]);
    if (settled.status === "fulfilled") return;
    const projected = Result.try({
      try: () => projectRuntimeError(settled.reason, "Opaque cleanup failure"),
      catch: () => new Error("Opaque cleanup failure"),
    });
    record(label, projected.match({ ok: (cause) => cause, err: (cause) => cause }));
  }

  async function runOutcome<E extends Error>(
    label: string,
    cleanup:
      | (() => Promise<
          | { readonly kind: "result"; readonly result: ResultType<void, E> }
          | { readonly kind: "panic"; readonly panic: Panic }
        >)
      | undefined,
  ): Promise<void> {
    if (!cleanup) return;
    const outcome = await cleanup();
    if (outcome.kind === "panic") {
      record(label, outcome.panic, "Opaque cleanup panic");
      return;
    }
    const recordOutcome = outcome.result.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () => record(label, error),
    });
    recordOutcome();
  }

  function finish(): void {
    const cleanupPanic = panics[0];
    if (!priorPanic && cleanupPanic) throw cleanupPanic;
  }

  return { failures, panics, record, run, runOutcome, finish };
}
