import { Result, type Result as ResultType } from "better-result";

function captureError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Unknown fixture failure", { cause });
}

export function rejectNegatedGuard(): boolean {
  const captured = Result.try({ try: () => 42, catch: captureError });
  if (!captured.isErr()) return true;
  return false;
}

export function rejectConditionalGuard(): boolean {
  const captured = Result.try({ try: () => 42, catch: captureError });
  return captured.isErr() ? false : true;
}

export function rejectSuccessGuard(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  if (captured.isOk()) return captured.value;
  return 0;
}

export function rejectStaticGuard(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  if (Result.isError(captured)) return captured.error.message.length;
  return captured.value;
}

export function rejectMutableCapture(): number {
  let captured = Result.try({ try: () => 42, catch: captureError });
  if (captured.isErr()) return captured.error.message.length;
  return captured.value;
}

export function rejectNestedGuard(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  {
    if (captured.isErr()) return captured.error.message.length;
  }
  return captured.value;
}

export function rejectInlineCapture(): boolean {
  if (Result.try({ try: () => 42, catch: captureError }).isErr()) return false;
  return true;
}

export function rejectNestedParameterGuard(
  parsed: ResultType<number, Error>,
  enabled: boolean,
): number {
  if (enabled) {
    if (parsed.isErr()) return 0;
  }
  return 1;
}

export function rejectReassignedParameter(parsed: ResultType<number, Error>): number {
  parsed = Result.ok(1);
  if (parsed.isErr()) return 0;
  return parsed.value;
}

export function rejectLoopReassignedParameter(
  parsed: ResultType<number, Error>,
  results: readonly ResultType<number, Error>[],
): number {
  for (parsed of results) void parsed;
  if (parsed.isErr()) return 0;
  return parsed.value;
}
