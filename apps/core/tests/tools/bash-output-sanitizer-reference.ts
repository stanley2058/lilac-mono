// The per-character stages that the run-scanning stages in
// src/tools/bash-output-sanitizer.ts replaced. The equivalence test holds the faster stages to
// this behavior, write by write.
import {
  normalizeLiteralSecrets,
  REDACTION_PLACEHOLDER,
} from "../../src/tools/bash-literal-redactor";

type AnsiState = "plain" | "escape" | "csi" | "osc" | "osc-escape";
const SENSITIVE_ASSIGNMENT_KEY_PARTS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASS",
  "KEY",
  "CREDENTIALS",
] as const;

export class ReferenceAnsiStripper {
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

export class ReferenceLiteralRedactor {
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
      // Hold back only text that the next chunk could complete into a secret, so a quiet
      // long-running process still shows its latest output. This runs before matching
      // because a longer secret takes precedence over a shorter one at the same position.
      if (!final && this.couldStartSecret(input, cursor)) break;

      const secret = this.secrets.find((value) => input.startsWith(value, cursor));
      if (secret) {
        output += REDACTION_PLACEHOLDER;
        cursor += secret.length;
        continue;
      }

      const codePoint = String.fromCodePoint(input.codePointAt(cursor) ?? 0);
      output += codePoint;
      cursor += codePoint.length;
    }

    this.carry = final ? "" : input.slice(cursor);
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

export class ReferenceSensitiveAssignmentRedactor {
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
