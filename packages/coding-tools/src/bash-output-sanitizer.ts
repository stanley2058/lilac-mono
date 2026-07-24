import { StringDecoder } from "node:string_decoder";

type AnsiState = "plain" | "escape" | "csi" | "osc" | "osc-escape";

const REDACTION_PLACEHOLDER = "<redacted>";
const MAX_PATTERN_BUFFER_CHARACTERS = 64 * 1024;
const PATTERN_CANDIDATE_MARKERS = [
  "authorization",
  "github_pat_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "xoxb-",
  "xoxa-",
  "xoxp-",
  "xoxr-",
  "sk-",
  "aiza",
  "http://",
  "https://",
] as const;
const SENSITIVE_KEY_PARTS = ["TOKEN", "SECRET", "PASSWORD", "PASS", "KEY", "CREDENTIALS"] as const;

function redactObviousSecrets(value: string): string {
  return value
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIALS)[A-Z0-9_]*)=([^\s]+)/giu,
      `$1=${REDACTION_PLACEHOLDER}`,
    )
    .replace(/(['"]?\s*authorization\s*:\s*)([^'"\n]+)(['"]?)/giu, `$1${REDACTION_PLACEHOLDER}$3`)
    .replace(/(authorization\s*:\s*)([^\s"']+)(\s+[^\s"']+)?/giu, `$1${REDACTION_PLACEHOLDER}`)
    .replace(
      /(https?:\/\/)([^\s/:@]+):([^\s@]+)@/giu,
      `$1${REDACTION_PLACEHOLDER}:${REDACTION_PLACEHOLDER}@`,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})\b/gu,
      REDACTION_PLACEHOLDER,
    );
}

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
    this.secrets = [...new Set(secrets.filter((value) => value.length >= 8))].sort(
      (left, right) => right.length - left.length,
    );
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
      } else {
        output += input[cursor];
        cursor += 1;
      }
    }
    this.carry = final ? "" : input.slice(cursor);
    return output;
  }
}

class StreamingSensitiveAssignmentRedactor {
  private state: "plain" | "key" | "redacting" = "plain";
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
          output += this.sensitiveKey ? `=${REDACTION_PLACEHOLDER}` : "=";
          this.state = this.sensitiveKey ? "redacting" : "plain";
          this.canStartKey = !this.sensitiveKey;
          continue;
        }
        output += character;
        this.state = "plain";
        this.canStartKey = !isKeyCharacter;
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
    if (SENSITIVE_KEY_PARTS.some((part) => this.keyTail.includes(part))) {
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
      return redactObviousSecrets(completeLines);
    }
    if (this.carry.length < MAX_PATTERN_BUFFER_CHARACTERS) return "";

    const redacted = redactObviousSecrets(this.carry);
    if (redacted !== this.carry) {
      this.suppression = this.carry.toLowerCase().includes("authorization")
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
      for (let length = 1; length < marker.length; length += 1) {
        if (lowerCarry.endsWith(marker.slice(0, length)))
          cut = Math.min(cut, this.carry.length - length);
      }
    }
    if (cut === 0) {
      if (this.carry.length < MAX_PATTERN_BUFFER_CHARACTERS * 2) return "";
      this.carry = "";
      this.suppression = "whitespace";
      return REDACTION_PLACEHOLDER;
    }
    const output = redactObviousSecrets(this.carry.slice(0, cut));
    this.carry = this.carry.slice(cut);
    return output;
  }

  end(): string {
    const output = redactObviousSecrets(this.carry);
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

export type BashOutputSanitizer = {
  write(chunk: Uint8Array): string;
  end(): string;
};

export function createBashOutputSanitizer(literalSecrets: readonly string[]): BashOutputSanitizer {
  const decoder = new StringDecoder("utf8");
  const ansiStripper = new StreamingAnsiStripper();
  const literalRedactor = new StreamingLiteralRedactor(literalSecrets);
  const patternRedactor = new StreamingPatternRedactor();
  return {
    write(chunk: Uint8Array): string {
      return patternRedactor.write(
        literalRedactor.write(ansiStripper.write(decoder.write(Buffer.from(chunk)))),
      );
    },
    end(): string {
      const tail = literalRedactor.write(ansiStripper.write(decoder.end())) + literalRedactor.end();
      return patternRedactor.write(tail) + patternRedactor.end();
    },
  };
}

export function sanitizeBashOutputText(
  value: string,
  literalSecrets: readonly string[] = [],
): string {
  const sanitizer = createBashOutputSanitizer(literalSecrets);
  return sanitizer.write(Buffer.from(value)) + sanitizer.end();
}
