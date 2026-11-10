import { StringDecoder } from "node:string_decoder";
import fs from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";

import { BufferedFileSink } from "@stanley2058/lilac-coding-tools/buffered-file-sink";
import { isPanic } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { normalizeLiteralSecrets, REDACTION_PLACEHOLDER } from "./bash-literal-redactor";
import { redactSecrets } from "./bash-safety/format";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

type AnsiState = "plain" | "escape" | "csi" | "osc" | "osc-escape";
const MAX_PATTERN_REDACTION_BUFFER_CHARS = 64 * 1024;
export const MIN_PRE_OVERFLOW_RAW_BYTES = 1024 * 1024;
/**
 * Hard memory ceiling for raw output retained before sanitized output exceeds
 * its preview cap. Complete overflow retention is abandoned at this boundary.
 */
export const MAX_PRE_OVERFLOW_RAW_BYTES = 64 * 1024 * 1024;

export function getPreOverflowRawByteLimit(maxChars: number): number {
  if (maxChars === Number.POSITIVE_INFINITY) return MAX_PRE_OVERFLOW_RAW_BYTES;
  const normalizedMaxChars = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  const scaledLimit = normalizedMaxChars * 4 + MAX_PATTERN_REDACTION_BUFFER_CHARS;
  return Math.min(MAX_PRE_OVERFLOW_RAW_BYTES, Math.max(MIN_PRE_OVERFLOW_RAW_BYTES, scaledLimit));
}
const PATTERN_CANDIDATE_MARKERS = [
  "authorization",
  "github_pat_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "http://",
  "https://",
] as const;
const SENSITIVE_ASSIGNMENT_KEY_PARTS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASS",
  "KEY",
  "CREDENTIALS",
] as const;

const ESCAPE = 0x1b;
const BELL = 0x07;
const C1_CSI = 0x9b;
const C1_OSC = 0x9d;
const C1_ST = 0x9c;

function isStrippedControlCode(code: number): boolean {
  if (code > 0x9f) return false;
  if (code >= 0x7f) return true;
  return code < 0x20 && code !== 0x09 && code !== 0x0a;
}

function findStrippedControl(input: string, from: number): number {
  for (let index = from; index < input.length; index += 1) {
    if (isStrippedControlCode(input.charCodeAt(index))) return index;
  }
  return -1;
}

type AnsiScan = { readonly input: string; output: string; copiedFrom: number };

export class StreamingAnsiStripper {
  private state: AnsiState = "plain";

  // Text is scanned in runs and copied by slice, because bash output is mostly plain text and
  // a per-character loop made this stage a throughput bottleneck.
  write(input: string): string {
    const scan: AnsiScan = { input, output: "", copiedFrom: 0 };
    let index = 0;
    while (index < input.length) {
      index =
        this.state === "plain" ? this.copyPlainRun(scan, index) : this.skipSequence(scan, index);
    }
    if (scan.copiedFrom === 0) return input;
    return scan.output + input.slice(scan.copiedFrom);
  }

  private copyPlainRun(scan: AnsiScan, from: number): number {
    const { input } = scan;
    const control = findStrippedControl(input, from);
    if (control < 0) return input.length;

    scan.output += input.slice(scan.copiedFrom, control);
    scan.copiedFrom = control + 1;
    const code = input.charCodeAt(control);
    if (code === ESCAPE) this.state = "escape";
    if (code === C1_CSI) this.state = "csi";
    if (code === C1_OSC) this.state = "osc";
    return control + 1;
  }

  private skipSequence(scan: AnsiScan, index: number): number {
    const { input } = scan;
    const code = input.charCodeAt(index);
    // The character after ESC is consumed whole, so an astral character does not leave half of
    // its surrogate pair behind.
    const next = this.state === "escape" ? index + codePointUnits(input, index) : index + 1;
    this.state = nextSequenceState(this.state, code);
    scan.copiedFrom = next;
    return next;
  }
}

function codePointUnits(input: string, index: number): number {
  return (input.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

function nextSequenceState(state: AnsiState, code: number): AnsiState {
  switch (state) {
    case "escape":
      if (code === 0x5b) return "csi";
      return code === 0x5d ? "osc" : "plain";
    case "csi":
      return code >= 0x40 && code <= 0x7e ? "plain" : "csi";
    case "osc":
      if (code === BELL || code === C1_ST) return "plain";
      return code === ESCAPE ? "osc-escape" : "osc";
    case "osc-escape":
      if (code === 0x5c || code === BELL) return "plain";
      return code === ESCAPE ? "osc-escape" : "osc";
    case "plain":
      return "plain";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class StreamingLiteralRedactor {
  private carry = "";
  private readonly secrets: readonly string[];
  private readonly maxSecretLength: number;
  private readonly matcher: RegExp | null;

  constructor(secrets: readonly string[]) {
    this.secrets = normalizeLiteralSecrets(secrets);
    this.maxSecretLength = Math.max(0, ...this.secrets.map((value) => value.length));
    // Alternatives keep the order of `secrets`, so the longest secret still wins at a position.
    this.matcher =
      this.secrets.length > 0 ? new RegExp(this.secrets.map(escapeRegExp).join("|"), "g") : null;
  }

  write(input: string): string {
    return this.process(this.carry + input, false);
  }

  end(): string {
    return this.process(this.carry, true);
  }

  private process(input: string, final: boolean): string {
    const { matcher } = this;
    if (!matcher) return input;

    // Only the last `maxSecretLength - 1` characters can be the start of a secret that the next
    // chunk completes. Everything before them is matched in bulk.
    const tailStart = final ? input.length : Math.max(0, input.length - this.maxSecretLength + 1);
    let output = "";
    let cursor = 0;
    while (cursor < tailStart) {
      matcher.lastIndex = cursor;
      const match = matcher.exec(input);
      if (!match || match.index >= tailStart) {
        output += input.slice(cursor, tailStart);
        cursor = tailStart;
        break;
      }
      output += input.slice(cursor, match.index) + REDACTION_PLACEHOLDER;
      cursor = match.index + match[0].length;
    }

    while (cursor < input.length) {
      // Hold back only text that the next chunk could complete into a secret, so a quiet
      // long-running process still shows its latest output. This runs before matching
      // because a longer secret takes precedence over a shorter one at the same position.
      if (this.couldStartSecret(input, cursor)) break;

      const secret = this.secrets.find((value) => input.startsWith(value, cursor));
      if (secret) {
        output += REDACTION_PLACEHOLDER;
        cursor += secret.length;
        continue;
      }

      const units = codePointUnits(input, cursor);
      output += input.slice(cursor, cursor + units);
      cursor += units;
    }

    this.carry = input.slice(cursor);
    return output;
  }

  private couldStartSecret(input: string, cursor: number): boolean {
    if (input.length - cursor >= this.maxSecretLength) return false;
    const remaining = input.slice(cursor);
    return this.secrets.some(
      (secret) => secret.length > remaining.length && secret.startsWith(remaining),
    );
  }
}

type AssignmentState = "plain" | "key" | "redacting";
type AssignmentScan = { readonly input: string; output: string; copiedFrom: number };

const EQUALS = 0x3d;
// A key part that straddles two chunks has at most this many characters in the first one.
const KEY_TAIL_CHARS = Math.max(...SENSITIVE_ASSIGNMENT_KEY_PARTS.map((part) => part.length)) - 1;

// Matches /[A-Z0-9_]/iu. Unicode case folding makes that class also accept the long s and the
// Kelvin sign.
function isKeyCode(code: number): boolean {
  if (code >= 0x61 && code <= 0x7a) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x30 && code <= 0x39) return true;
  return code === 0x5f || code === 0x17f || code === 0x212a;
}

// Matches /\s/u.
function isWhitespaceCode(code: number): boolean {
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  if (code < 0xa0) return false;
  if (code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)) return true;
  if (code === 0x2028 || code === 0x2029 || code === 0x202f) return true;
  return code === 0x205f || code === 0x3000 || code === 0xfeff;
}

export class StreamingSensitiveAssignmentRedactor {
  private state: AssignmentState = "plain";
  private keyTail = "";
  private sensitiveKey = false;

  // No text is held back between chunks. A chunk is scanned in runs, and a chunk that needs
  // no redaction is returned as is.
  write(input: string): string {
    const scan: AssignmentScan = { input, output: "", copiedFrom: 0 };
    let index = 0;
    while (index < input.length) index = this.advance(scan, index);
    if (scan.copiedFrom === 0) return input;
    return scan.output + input.slice(scan.copiedFrom);
  }

  private advance(scan: AssignmentScan, index: number): number {
    switch (this.state) {
      case "plain":
        return this.findKeyStart(scan.input, index);
      case "key":
        return this.readKey(scan, index);
      case "redacting":
        return this.dropValue(scan, index);
    }
  }

  private findKeyStart(input: string, from: number): number {
    let index = from;
    while (index < input.length && !isKeyCode(input.charCodeAt(index))) index += 1;
    if (index === input.length) return index;

    this.state = "key";
    this.keyTail = "";
    this.sensitiveKey = false;
    return index;
  }

  private readKey(scan: AssignmentScan, from: number): number {
    const { input } = scan;
    let end = from;
    while (end < input.length && isKeyCode(input.charCodeAt(end))) end += 1;
    if (end === input.length) {
      this.noteKeyRun(input.slice(from, end));
      return end;
    }

    // Most identifiers are not assignments, so only a key that reaches "=" is classified.
    if (input.charCodeAt(end) !== EQUALS) {
      this.state = "plain";
      return end + 1;
    }

    this.noteKeyRun(input.slice(from, end));
    if (!this.sensitiveKey) {
      this.state = "plain";
      return end + 1;
    }

    scan.output += `${input.slice(scan.copiedFrom, end)}=${REDACTION_PLACEHOLDER}`;
    scan.copiedFrom = end + 1;
    this.state = "redacting";
    return end + 1;
  }

  private dropValue(scan: AssignmentScan, from: number): number {
    const { input } = scan;
    let index = from;
    while (index < input.length && !isWhitespaceCode(input.charCodeAt(index))) index += 1;
    scan.copiedFrom = index;
    if (index === input.length) return index;

    this.state = "plain";
    return index + 1;
  }

  private noteKeyRun(run: string): void {
    if (this.sensitiveKey || run.length === 0) return;
    const seen = this.keyTail + run.toUpperCase();
    this.sensitiveKey = SENSITIVE_ASSIGNMENT_KEY_PARTS.some((part) => seen.includes(part));
    this.keyTail = seen.slice(-KEY_TAIL_CHARS);
  }
}

class StreamingPatternRedactor {
  private carry = "";
  private suppression: "line" | "whitespace" | null = null;
  private readonly assignmentRedactor = new StreamingSensitiveAssignmentRedactor();

  write(input: string): string {
    this.carry += this.consumeSuppressed(this.assignmentRedactor.write(input));
    const lastNewline = this.carry.lastIndexOf("\n");
    if (lastNewline >= 0) {
      const completeLines = this.carry.slice(0, lastNewline + 1);
      this.carry = this.carry.slice(lastNewline + 1);
      return redactSecrets(completeLines);
    }

    if (this.carry.length >= MAX_PATTERN_REDACTION_BUFFER_CHARS) {
      const redacted = redactSecrets(this.carry);
      if (redacted !== this.carry) {
        const lowerCarry = this.carry.toLowerCase();
        if (lowerCarry.includes("authorization")) {
          this.suppression = "line";
        } else if (!/\s$/u.test(this.carry)) {
          this.suppression = "whitespace";
        } else {
          this.suppression = null;
        }
        this.carry = "";
        return redacted;
      }

      const lowerCarry = this.carry.toLowerCase();
      let cut = this.carry.length;
      for (const marker of PATTERN_CANDIDATE_MARKERS) {
        const candidate = lowerCarry.lastIndexOf(marker);
        if (
          candidate >= 0 &&
          (marker === "authorization" || !/\s/u.test(this.carry.slice(candidate)))
        ) {
          cut = Math.min(cut, candidate);
        }
        for (let prefixLength = 1; prefixLength < marker.length; prefixLength += 1) {
          if (lowerCarry.endsWith(marker.slice(0, prefixLength))) {
            cut = Math.min(cut, this.carry.length - prefixLength);
          }
        }
      }

      if (cut === 0) {
        if (this.carry.length < MAX_PATTERN_REDACTION_BUFFER_CHARS * 2) return "";
        this.carry = "";
        this.suppression = "whitespace";
        return "<redacted>";
      }

      const output = redactSecrets(this.carry.slice(0, cut));
      this.carry = this.carry.slice(cut);
      return output;
    }

    return "";
  }

  end(): string {
    const output = redactSecrets(this.carry);
    this.carry = "";
    return output;
  }

  private consumeSuppressed(input: string): string {
    if (!this.suppression) return input;

    const boundary = this.suppression === "line" ? input.indexOf("\n") : input.search(/\s/u);
    if (boundary < 0) return "";

    this.suppression = null;
    return input.slice(boundary);
  }
}

type BashOutputSanitizer = {
  write(chunk: Uint8Array): string;
  end(): string;
};

export function createBashOutputSanitizer(literalSecrets: readonly string[]): BashOutputSanitizer {
  const decoder = new StringDecoder("utf8");
  const ansiStripper = new StreamingAnsiStripper();
  const redactor = new StreamingLiteralRedactor(literalSecrets);
  const patternRedactor = new StreamingPatternRedactor();

  return {
    write(chunk) {
      return patternRedactor.write(
        redactor.write(ansiStripper.write(decoder.write(Buffer.from(chunk)))),
      );
    },
    end() {
      const literalTail = redactor.write(ansiStripper.write(decoder.end())) + redactor.end();
      return patternRedactor.write(literalTail) + patternRedactor.end();
    },
  };
}

export function sanitizeBashOutputText(
  value: string,
  literalSecrets: readonly string[] = [],
): string {
  const sanitizer = createBashOutputSanitizer(literalSecrets);
  return sanitizer.write(Buffer.from(value, "utf8")) + sanitizer.end();
}

export type SanitizedStreamTextResult = {
  text: string;
  totalChars: number;
  totalBytes: number;
  capped: boolean;
  overflowFilePath?: string;
};

export type StreamOutputBudget = {
  maxBytes: number;
  consumedBytes: number;
  exceeded: boolean;
  onExceeded(): void;
};

export class BashOutputStreamError extends TaggedError("BashOutputStreamError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BashOutputStreamAndCleanupError extends TaggedError(
  "BashOutputStreamAndCleanupError",
)<{
  readonly primary: BashOutputStreamError;
  readonly cleanup: BashOutputCleanupError;
  readonly message: string;
}> {}

export class BashOutputCleanupError extends TaggedError("BashOutputCleanupError")<{
  readonly failures: readonly BashOutputStreamError[];
  readonly message: string;
}> {}

export type BashOutputReadError =
  | BashOutputStreamError
  | BashOutputCleanupError
  | BashOutputStreamAndCleanupError;
type BashOutputSource = BodyInit | number | undefined;

interface BashOverflowSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface BashOutputOverflowOperations {
  open(target: string): Promise<BashOverflowSink>;
  remove(target: string): Promise<void>;
}

const DEFAULT_OVERFLOW_OPERATIONS: BashOutputOverflowOperations = {
  open: (target) => BufferedFileSink.open(target, { flags: "wx", mode: 0o600 }),
  remove: (target) => fs.rm(target, { force: true }),
};

function settleBashOutputCleanup(
  operation: string,
  run: () => Promise<void>,
): Promise<ResultType<void, BashOutputStreamError | Panic>> {
  return Result.tryPromise({
    try: run,
    catch: (caught) =>
      Panic.is(caught)
        ? caught
        : new BashOutputStreamError({
            operation,
            cause: caught,
            message: `Bash output failed while ${operation}`,
          }),
  });
}

function selectResultValue<T, E extends Error>(result: ResultType<T, E>): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => adaptToolResultToHost(Result.err(error)),
  });
  return select();
}

function captureBashOutputOperation<T>(params: {
  readonly operation: string;
  readonly run: () => Awaited<T>;
}): ResultType<T, BashOutputStreamError | Panic> {
  const captured = Result.try({ try: params.run, catch: captureRuntimeError }).mapError((error) =>
    projectCapturedRuntimeError(error, `Opaque Bash output ${params.operation} failure`),
  );
  return captured.match<() => ResultType<T, BashOutputStreamError | Panic>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () =>
      Result.err(
        isPanic(error)
          ? error
          : new BashOutputStreamError({
              operation: params.operation,
              cause: error,
              message: `Bash output failed while ${params.operation}`,
            }),
      ),
  })();
}

async function captureBashOutputPromise<T>(params: {
  readonly operation: string;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, BashOutputStreamError | Panic>> {
  const captured = (
    await Result.tryPromise({ try: params.run, catch: captureRuntimeError })
  ).mapError((error) =>
    projectCapturedRuntimeError(error, `Opaque Bash output ${params.operation} failure`),
  );
  return captured.match<() => ResultType<T, BashOutputStreamError | Panic>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () =>
      Result.err(
        isPanic(error)
          ? error
          : new BashOutputStreamError({
              operation: params.operation,
              cause: error,
              message: `Bash output failed while ${params.operation}`,
            }),
      ),
  })();
}

function combineBashOutputAndCleanup(
  primary: BashOutputStreamError,
  cleanup: BashOutputCleanupError,
): BashOutputStreamAndCleanupError {
  return new BashOutputStreamAndCleanupError({
    primary,
    cleanup,
    message: `${primary.message}; cleanup also failed: ${cleanup.message}`,
  });
}

export async function readSanitizedStreamTextCappedResult(
  stream: BashOutputSource,
  maxChars: number,
  options?: {
    overflowFilePath?: string;
    literalSecrets?: readonly string[];
    onActivity?: () => void;
    outputBudget?: StreamOutputBudget;
    overflowOperations?: BashOutputOverflowOperations;
  },
): Promise<ResultType<SanitizedStreamTextResult, BashOutputReadError>> {
  if (!stream || typeof stream === "number") {
    return Result.ok({ text: "", totalChars: 0, totalBytes: 0, capped: false });
  }

  const sanitizer = createBashOutputSanitizer(options?.literalSecrets ?? []);
  let text = "";
  let totalChars = 0;
  let totalBytes = 0;
  let capped = false;
  let overflowWriteFailed = false;
  let overflowFilePath: string | undefined;
  let overflowSink: BashOverflowSink | undefined;
  let overflowFileCreated = false;
  const bufferedRawChunks: Buffer[] = [];
  let bufferedRawBytes = 0;
  const rawBufferLimit = getPreOverflowRawByteLimit(maxChars);
  const overflowOperations = options?.overflowOperations ?? DEFAULT_OVERFLOW_OPERATIONS;
  const cleanupFailures: BashOutputStreamError[] = [];
  let overflowOperationError: BashOutputStreamError | undefined;
  let deferredPanic: Panic | undefined;

  const recordCleanupAttempt = async (operation: string, run: () => Promise<void>) => {
    const attempt = await settleBashOutputCleanup(operation, run);
    const continueAttempt = attempt.match<() => Panic | undefined>({
      ok: () => () => undefined,
      err: (error) => () => {
        if (isPanic(error)) return error;
        cleanupFailures.push(error);
        return undefined;
      },
    });
    return continueAttempt();
  };

  const failOverflow = async (params?: {
    primary?: BashOutputStreamError;
    cleanup?: BashOutputStreamError;
    panic?: Panic;
  }) => {
    if (params?.primary && !overflowOperationError) overflowOperationError = params.primary;
    if (params?.cleanup) cleanupFailures.push(params.cleanup);
    overflowWriteFailed = true;
    overflowFilePath = undefined;
    const sink = overflowSink;
    overflowSink = undefined;
    if (params?.panic && !deferredPanic) deferredPanic = params.panic;
    if (sink) {
      const abortPanic = await recordCleanupAttempt("aborting overflow output", () => sink.abort());
      if (!deferredPanic) deferredPanic = abortPanic;
    }
    if (overflowFileCreated && options?.overflowFilePath) {
      const removePanic = await recordCleanupAttempt("removing incomplete overflow output", () =>
        overflowOperations.remove(options.overflowFilePath!),
      );
      if (!deferredPanic) deferredPanic = removePanic;
    }
    overflowFileCreated = false;
    bufferedRawChunks.length = 0;
    bufferedRawBytes = 0;
  };

  const writeOverflowChunk = async (chunk: Uint8Array) => {
    if (chunk.byteLength === 0 || overflowWriteFailed || !options?.overflowFilePath) return;
    if (!overflowSink) {
      const opened = await captureBashOutputPromise({
        operation: "opening overflow output",
        run: () => overflowOperations.open(options.overflowFilePath!),
      });
      const openError = opened.match({ ok: () => null, err: (error) => error });
      if (openError) {
        await failOverflow(isPanic(openError) ? { panic: openError } : { primary: openError });
        return;
      }
      overflowSink = opened.match({ ok: (value) => value, err: () => undefined });
      overflowFileCreated = true;
    }
    const written = await settleBashOutputCleanup("writing overflow output", () =>
      overflowSink!.write(chunk),
    );
    const continueWritten = written.match<() => Promise<void>>({
      ok: () => () => {
        overflowFilePath = options.overflowFilePath;
        return Promise.resolve();
      },
      err: (error) => () =>
        isPanic(error) ? failOverflow({ panic: error }) : failOverflow({ primary: error }),
    });
    await continueWritten();
  };

  const flushBufferedRaw = async () => {
    for (const chunk of bufferedRawChunks) await writeOverflowChunk(chunk);
    bufferedRawChunks.length = 0;
    bufferedRawBytes = 0;
  };

  const retainRawChunk = async (chunk: Uint8Array) => {
    if (overflowWriteFailed || !options?.overflowFilePath) return;
    if (overflowSink) {
      await writeOverflowChunk(chunk);
      return;
    }

    if (bufferedRawBytes + chunk.byteLength > rawBufferLimit) {
      await failOverflow();
      return;
    }

    bufferedRawChunks.push(Buffer.from(chunk));
    bufferedRawBytes += chunk.byteLength;
  };

  const consumeSanitizedText = async (chunk: string) => {
    if (chunk.length === 0) return;
    totalChars += chunk.length;
    totalBytes += Buffer.byteLength(chunk, "utf8");

    if (capped) return;

    const previousText = text;
    if (previousText.length + chunk.length <= maxChars) {
      text += chunk;
      return;
    }

    capped = true;
    const remaining = Math.max(0, maxChars - previousText.length);
    let sliceEnd = remaining;
    if (
      sliceEnd > 0 &&
      /[\uD800-\uDBFF]/u.test(chunk[sliceEnd - 1] ?? "") &&
      /[\uDC00-\uDFFF]/u.test(chunk[sliceEnd] ?? "")
    ) {
      sliceEnd -= 1;
    }
    text = previousText + chunk.slice(0, sliceEnd);
  };

  if (stream instanceof ReadableStream) {
    const acquired = captureBashOutputOperation({
      operation: "acquiring the stream reader",
      run: () => stream.getReader(),
    });
    const acquireError = acquired.match({ ok: () => null, err: (error) => error });
    if (acquireError) {
      if (isPanic(acquireError)) preserveToolPanic(acquireError);
      return Result.err(acquireError);
    }
    const reader = selectResultValue(acquired);
    let primaryError: BashOutputStreamError | undefined;
    while (true) {
      const read = await captureBashOutputPromise({
        operation: "reading the output stream",
        run: () => reader.read(),
      });
      const readError = read.match({ ok: () => null, err: (error) => error });
      if (readError) {
        if (isPanic(readError)) deferredPanic = readError;
        else primaryError = readError;
        break;
      }
      const readValue = read.match<Awaited<ReturnType<typeof reader.read>>>({
        ok: (value) => value,
        err: () => ({ done: true, value: undefined }),
      });
      const { done, value } = readValue;
      if (done) break;
      if (value && value.byteLength > 0) {
        const activity: ResultType<void, BashOutputStreamError | Panic> = options?.onActivity
          ? captureBashOutputOperation({
              operation: "reporting output activity",
              run: options.onActivity,
            })
          : Result.ok();
        const activityError = activity.match({ ok: () => null, err: (error) => error });
        if (activityError) {
          if (isPanic(activityError)) deferredPanic = activityError;
          else primaryError = activityError;
          break;
        }
        if (options?.outputBudget) {
          options.outputBudget.consumedBytes += value.byteLength;
          if (options.outputBudget.consumedBytes > options.outputBudget.maxBytes) {
            if (!options.outputBudget.exceeded) {
              options.outputBudget.exceeded = true;
              const exceeded = captureBashOutputOperation({
                operation: "reporting the exceeded output budget",
                run: options.outputBudget.onExceeded,
              });
              const exceededError = exceeded.match({ ok: () => null, err: (error) => error });
              if (exceededError) {
                if (isPanic(exceededError)) deferredPanic = exceededError;
                else primaryError = exceededError;
                break;
              }
            }
            primaryError = new BashOutputStreamError({
              operation: "enforcing the cumulative output budget",
              cause: new RangeError("Bash cumulative output budget exceeded"),
              message: `Bash output exceeded the ${options.outputBudget.maxBytes}-byte cumulative budget`,
            });
            break;
          }
        }
        await retainRawChunk(value);
        if (deferredPanic) break;
        const sanitized = captureBashOutputOperation({
          operation: "sanitizing output",
          run: () => sanitizer.write(value),
        });
        const sanitizeError = sanitized.match({ ok: () => null, err: (error) => error });
        if (sanitizeError) {
          if (isPanic(sanitizeError)) deferredPanic = sanitizeError;
          else primaryError = sanitizeError;
          break;
        }
        await consumeSanitizedText(sanitized.match({ ok: (output) => output, err: () => "" }));
        if (capped && !overflowSink) await flushBufferedRaw();
      }
    }
    if (!primaryError && !deferredPanic) {
      const ended = captureBashOutputOperation({
        operation: "finishing output sanitization",
        run: () => sanitizer.end(),
      });
      const endError = ended.match({ ok: () => null, err: (error) => error });
      if (endError) {
        if (isPanic(endError)) deferredPanic = endError;
        else primaryError = endError;
      } else await consumeSanitizedText(ended.match({ ok: (value) => value, err: () => "" }));
      if (!primaryError && !deferredPanic && capped && !overflowSink) await flushBufferedRaw();
      if (!primaryError && !deferredPanic && overflowSink) {
        const closed = await settleBashOutputCleanup("closing overflow output", () =>
          overflowSink!.close(),
        );
        const continueClosed = closed.match<() => Promise<void>>({
          ok: () => () => Promise.resolve(),
          err: (error) => () =>
            isPanic(error) ? failOverflow({ panic: error }) : failOverflow({ cleanup: error }),
        });
        await continueClosed();
      }
      if (primaryError || deferredPanic) await failOverflow();
    } else {
      await failOverflow();
    }

    const released = captureBashOutputOperation({
      operation: "releasing the stream reader",
      run: () => reader.releaseLock(),
    });
    released.match({
      ok: () => undefined,
      err: (error) => {
        if (isPanic(error)) {
          if (!deferredPanic) deferredPanic = error;
        } else {
          cleanupFailures.push(error);
        }
      },
    });

    if (deferredPanic) preserveToolPanic(deferredPanic);

    const cleanupError =
      cleanupFailures.length > 0
        ? new BashOutputCleanupError({
            failures: cleanupFailures,
            message: "Bash output temporary spill cleanup failed",
          })
        : undefined;
    const operationError = primaryError ?? overflowOperationError;
    if (operationError && cleanupError) {
      return Result.err(combineBashOutputAndCleanup(operationError, cleanupError));
    }
    if (primaryError) return Result.err(primaryError);
    if (cleanupError) return Result.err(cleanupError);
  } else {
    const response = new Response(stream);
    if (!response.body) {
      return Result.ok({ text: "", totalChars: 0, totalBytes: 0, capped: false });
    }
    return await readSanitizedStreamTextCappedResult(response.body, maxChars, options);
  }

  return Result.ok({ text, totalChars, totalBytes, capped, overflowFilePath });
}

export async function readSanitizedStreamTextCapped(
  stream: BashOutputSource,
  maxChars: number,
  options?: {
    overflowFilePath?: string;
    literalSecrets?: readonly string[];
    onActivity?: () => void;
    outputBudget?: StreamOutputBudget;
    overflowOperations?: BashOutputOverflowOperations;
  },
): Promise<SanitizedStreamTextResult> {
  return adaptToolResultToHost(
    await readSanitizedStreamTextCappedResult(stream, maxChars, options),
  );
}

export function createBashOutputSanitizerTransform(literalSecrets: readonly string[]): Transform {
  const sanitizer = createBashOutputSanitizer(literalSecrets);

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      const transformed = captureBashOutputOperation({
        operation: "sanitizing a transform chunk",
        run: () => sanitizer.write(chunk),
      });
      transformed.match<() => void>({
        err: (error) => () => (isPanic(error) ? preserveToolPanic(error) : callback(error)),
        ok: (value) => () => callback(null, value),
      })();
    },
    flush(callback: TransformCallback) {
      const flushed = captureBashOutputOperation({
        operation: "flushing the sanitizer transform",
        run: () => sanitizer.end(),
      });
      flushed.match<() => void>({
        err: (error) => () => (isPanic(error) ? preserveToolPanic(error) : callback(error)),
        ok: (value) => () => callback(null, value),
      })();
    },
  });
}
