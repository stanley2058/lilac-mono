import { StringDecoder } from "node:string_decoder";
import fs from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";

import { normalizeLiteralSecrets, REDACTION_PLACEHOLDER } from "./bash-literal-redactor";
import { redactSecrets } from "./bash-safety/format";

type AnsiState = "plain" | "escape" | "csi" | "osc" | "osc-escape";
const MAX_PATTERN_REDACTION_BUFFER_CHARS = 64 * 1024;
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

class StreamingAnsiStripper {
  private state: AnsiState = "plain";

  write(input: string): string {
    let output = "";
    for (const character of input) {
      const code = character.charCodeAt(0);
      if (this.state === "plain") {
        if (code === 0x1b) this.state = "escape";
        else if (code === 0x9b) this.state = "csi";
        else if (code === 0x9d) this.state = "osc";
        else if (code === 0x09 || code === 0x0a || (code >= 0x20 && code < 0x7f) || code > 0x9f) {
          output += character;
        }
      } else if (this.state === "escape") {
        if (character === "[") this.state = "csi";
        else if (character === "]") this.state = "osc";
        else this.state = "plain";
      } else if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "plain";
      } else if (this.state === "osc") {
        if (code === 0x07 || code === 0x9c) this.state = "plain";
        else if (code === 0x1b) this.state = "osc-escape";
      } else if (character === "\\" || code === 0x07) {
        this.state = "plain";
      } else if (code !== 0x1b) {
        this.state = "osc";
      }
    }
    return output;
  }
}

class StreamingLiteralRedactor {
  private carry = "";
  private readonly secrets: readonly string[];
  private readonly maxSecretLength: number;

  constructor(secrets: readonly string[]) {
    this.secrets = normalizeLiteralSecrets(secrets);
    this.maxSecretLength = Math.max(0, ...this.secrets.map((value) => value.length));
  }

  write(input: string): string {
    return this.process(this.carry + input, false);
  }

  end(): string {
    return this.process(this.carry, true);
  }

  private process(input: string, final: boolean): string {
    let output = "";
    let cursor = 0;

    while (cursor < input.length) {
      if (!final && input.length - cursor < this.maxSecretLength) break;

      const secret = this.secrets.find((value) => input.startsWith(value, cursor));
      if (secret) {
        output += REDACTION_PLACEHOLDER;
        cursor += secret.length;
        continue;
      }

      const startsSurrogatePair =
        /[\uD800-\uDBFF]/u.test(input[cursor] ?? "") &&
        /[\uDC00-\uDFFF]/u.test(input[cursor + 1] ?? "");
      if (startsSurrogatePair && !final && input.length - (cursor + 1) < this.maxSecretLength) {
        break;
      }

      output += input[cursor];
      cursor += 1;
    }

    this.carry = final ? "" : input.slice(cursor);
    return output;
  }
}

type AssignmentState = "plain" | "key" | "redacting";

class StreamingSensitiveAssignmentRedactor {
  private state: AssignmentState = "plain";
  private canStartKey = true;
  private keyTail = "";
  private sensitiveKey = false;

  write(input: string): string {
    let output = "";

    for (const character of input) {
      const isKeyCharacter = /[A-Z0-9_]/iu.test(character);
      const isWhitespace = /\s/u.test(character);

      if (this.state === "redacting") {
        if (isWhitespace) {
          output += character;
          this.state = "plain";
          this.canStartKey = true;
        }
        continue;
      }

      if (this.state === "key") {
        if (isKeyCharacter) {
          output += character;
          this.updateKey(character);
          continue;
        }

        if (character === "=") {
          output += this.sensitiveKey ? "=<redacted>" : "=";
          this.state = this.sensitiveKey ? "redacting" : "plain";
          this.canStartKey = !this.sensitiveKey;
          continue;
        }

        output += character;
        this.state = "plain";
        this.canStartKey = !/[A-Z0-9_]/iu.test(character);
        continue;
      }

      output += character;
      if (this.canStartKey && isKeyCharacter) {
        this.state = "key";
        this.keyTail = "";
        this.sensitiveKey = false;
        this.updateKey(character);
      }
      this.canStartKey = !isKeyCharacter;
    }

    return output;
  }

  private updateKey(character: string): void {
    this.keyTail = (this.keyTail + character.toUpperCase()).slice(-11);
    if (SENSITIVE_ASSIGNMENT_KEY_PARTS.some((part) => this.keyTail.includes(part))) {
      this.sensitiveKey = true;
    }
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
        this.suppression = lowerCarry.includes("authorization")
          ? "line"
          : !/\s$/u.test(this.carry)
            ? "whitespace"
            : null;
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

function createBashOutputSanitizer(literalSecrets: readonly string[]): BashOutputSanitizer {
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

async function appendOverflowChunk(params: {
  overflowFilePath: string;
  chunk: Uint8Array;
  initialized: boolean;
}): Promise<boolean> {
  try {
    if (!params.initialized) {
      await fs.writeFile(params.overflowFilePath, params.chunk, {
        mode: 0o600,
      });
    } else {
      await fs.appendFile(params.overflowFilePath, params.chunk);
    }
    return true;
  } catch {
    return false;
  }
}

function isResponseBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ReadableStream
  );
}

export async function readSanitizedStreamTextCapped(
  stream: unknown,
  maxChars: number,
  options?: { overflowFilePath?: string; literalSecrets?: readonly string[] },
): Promise<SanitizedStreamTextResult> {
  if (!stream || typeof stream === "number") {
    return { text: "", totalChars: 0, totalBytes: 0, capped: false };
  }

  const sanitizer = createBashOutputSanitizer(options?.literalSecrets ?? []);
  let text = "";
  let totalChars = 0;
  let totalBytes = 0;
  let capped = false;
  let overflowInitialized = false;
  let overflowWriteFailed = false;
  let overflowFilePath: string | undefined;
  let bufferedRawBytes = 0;
  const bufferedRawChunks: Buffer[] = [];
  const rawBufferLimit = Math.max(256 * 1024, maxChars * 4 + MAX_PATTERN_REDACTION_BUFFER_CHARS);

  const writeOverflowChunk = async (chunk: Uint8Array) => {
    if (chunk.byteLength === 0 || overflowWriteFailed || !options?.overflowFilePath) return;

    const ok = await appendOverflowChunk({
      overflowFilePath: options.overflowFilePath,
      chunk,
      initialized: overflowInitialized,
    });
    if (!ok) {
      overflowWriteFailed = true;
      overflowFilePath = undefined;
      await fs.rm(options.overflowFilePath, { force: true }).catch(() => undefined);
      return;
    }
    overflowInitialized = true;
    overflowFilePath = options.overflowFilePath;
  };

  const flushBufferedRaw = async () => {
    for (const chunk of bufferedRawChunks) await writeOverflowChunk(chunk);
    bufferedRawChunks.length = 0;
    bufferedRawBytes = 0;
  };

  const retainRawChunk = async (chunk: Uint8Array) => {
    if (overflowWriteFailed || !options?.overflowFilePath) return;
    if (overflowInitialized) {
      await writeOverflowChunk(chunk);
      return;
    }

    const copy = Buffer.from(chunk);
    bufferedRawChunks.push(copy);
    bufferedRawBytes += copy.length;
    if (bufferedRawBytes >= rawBufferLimit) await flushBufferedRaw();
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

  const maybeReadable = stream as { getReader?: unknown };
  if (typeof maybeReadable.getReader === "function") {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await retainRawChunk(value);
          await consumeSanitizedText(sanitizer.write(value));
          if (capped && !overflowInitialized) await flushBufferedRaw();
        }
      }
      await consumeSanitizedText(sanitizer.end());
      if (capped && !overflowInitialized) await flushBufferedRaw();
    } finally {
      reader.releaseLock();
    }
  } else {
    const response = new Response(isResponseBodyInit(stream) ? stream : String(stream));
    if (!response.body) return { text: "", totalChars: 0, totalBytes: 0, capped: false };
    return await readSanitizedStreamTextCapped(response.body, maxChars, options);
  }

  if (!capped && options?.overflowFilePath && overflowInitialized) {
    await fs.rm(options.overflowFilePath, { force: true }).catch(() => undefined);
    overflowFilePath = undefined;
  }

  return { text, totalChars, totalBytes, capped, overflowFilePath };
}

export function createBashOutputSanitizerTransform(literalSecrets: readonly string[]): Transform {
  const sanitizer = createBashOutputSanitizer(literalSecrets);

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        callback(null, sanitizer.write(chunk));
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback: TransformCallback) {
      try {
        callback(null, sanitizer.end());
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}
