import { Result, type Result as ResultType } from "better-result";

function captureError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Unknown fixture failure", { cause });
}

export function settleCapturedTry(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  if (captured.isErr()) return captured.error.message.length;
  return captured.value;
}

export async function settleCapturedTryPromise(): Promise<number> {
  const captured = await Result.tryPromise({
    try: async () => 42,
    catch: captureError,
  });
  if (captured.isErr()) {
    throw captured.error;
  }
  return captured.value;
}

export function recordCapturedFailure(): string | undefined {
  let message: string | undefined;
  const captured = Result.try({ try: () => undefined, catch: captureError });
  if (captured.isErr()) {
    message = captured.error.message;
  }
  return message;
}

export function settleNestedCapture(enabled: boolean): number {
  if (enabled) {
    const captured = Result.try({ try: () => 42, catch: captureError });
    if (captured.isErr()) return captured.error.message.length;
    return captured.value;
  }
  return 0;
}

function readCount(text: string): ResultType<number, Error> {
  return text ? Result.ok(text.length) : Result.err(new Error("empty"));
}

export function settleImmutableLocal(text: string): number {
  const parsed = readCount(text);
  if (!text) return 0;
  if (parsed.isErr()) return parsed.error.message.length;
  const count = parsed.value;
  return !count ? 0 : count;
}

export function settleUnchangedParameter(parsed: ResultType<number, Error>): number {
  if (parsed.isErr()) return parsed.error.message.length;
  return parsed.value;
}

export function settleImmutableAlias(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  const aliased = captured;
  if (aliased.isErr()) return aliased.error.message.length;
  return aliased.value;
}
