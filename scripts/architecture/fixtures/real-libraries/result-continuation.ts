import { Result, type Result as ResultType } from "better-result";

function readCount(text: string): ResultType<number, Error> {
  return text ? Result.ok(text.length) : Result.err(new Error("empty"));
}

export function rejectRepeatedLocalMatch(text: string): number {
  const parsed = readCount(text);
  const failure = parsed.match({ ok: () => null, err: (error) => error });
  if (failure) return 0;
  return parsed.match({ ok: (value) => value, err: () => 0 });
}

export function rejectRepeatedParameterMatch(parsed: ResultType<number, Error>): string {
  const label = parsed.match({ ok: () => "ok", err: () => "err" });
  return `${label}:${parsed.match({ ok: (value) => value, err: () => -1 })}`;
}

export function rejectNestedContinuation(text: string): number {
  return readCount(text).match<() => number>({
    err: () => () => 0,
    ok: (first) => () =>
      readCount(String(first)).match<() => number>({
        err: () => () => 0,
        ok: (second) => () => first + second,
      })(),
  })();
}

export function permitDistinctMatches(text: string): number {
  const first = readCount(text);
  const second = readCount(`${text}!`);
  return (
    first.match({ ok: (value) => value, err: () => 0 }) +
    second.match({ ok: (value) => value, err: () => 0 })
  );
}

export function permitSingleContinuation(text: string): number {
  return readCount(text).match<() => number>({
    ok: (value) => () => value,
    err: () => () => 0,
  })();
}

export function rejectRepeatedStaticMatch(text: string): number {
  const parsed = readCount(text);
  const handlers = { ok: (value: number) => value, err: () => 0 };
  return Result.match(parsed, handlers) + Result.match(parsed, handlers);
}

export function permitCurriedMatchesOfDistinctResults(text: string): number {
  const count = Result.match({ ok: (value: number) => value, err: () => 0 });
  return count(readCount(text)) + count(readCount(`${text}!`));
}

const stop = (): number => 0;

export function rejectNestedContinuationWithNamedArm(text: string): number {
  return readCount(text).match<() => number>({
    err: () => stop,
    ok: (first) => () =>
      readCount(String(first)).match<() => number>({
        err: () => stop,
        ok: (second) => () => first + second,
      })(),
  })();
}

export function rejectNestedContinuationThroughNamedHandlers(text: string): number {
  const handlers = {
    err: () => stop,
    ok: (first: number) => () =>
      readCount(String(first)).match<() => number>({
        err: () => stop,
        ok: (second) => () => first + second,
      })(),
  };
  return readCount(text).match<() => number>(handlers)();
}
