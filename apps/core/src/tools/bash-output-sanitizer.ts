import { StringDecoder } from "node:string_decoder";
import { Transform, type TransformCallback } from "node:stream";

type AnsiState = "plain" | "escape" | "csi" | "osc" | "osc-escape";

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
  private readonly overlap: number;

  constructor(secrets: readonly string[]) {
    this.secrets = [...new Set(secrets.filter((value) => value.length > 0))].sort(
      (a, b) => b.length - a.length,
    );
    this.overlap = Math.max(0, ...this.secrets.map((value) => value.length - 1));
  }

  write(input: string): string {
    const combined = this.carry + input;
    let cut = Math.max(0, combined.length - this.overlap);
    for (const secret of this.secrets) {
      let match = combined.indexOf(secret, Math.max(0, cut - secret.length + 1));
      while (match >= 0 && match < cut) {
        if (match + secret.length > cut) {
          cut = match;
          break;
        }
        match = combined.indexOf(secret, match + 1);
      }
    }
    if (
      cut > 0 &&
      cut < combined.length &&
      /[\uD800-\uDBFF]/u.test(combined[cut - 1] ?? "") &&
      /[\uDC00-\uDFFF]/u.test(combined[cut] ?? "")
    ) {
      cut -= 1;
    }
    this.carry = combined.slice(cut);
    return this.redact(combined.slice(0, cut));
  }

  end(): string {
    const output = this.redact(this.carry);
    this.carry = "";
    return output;
  }

  private redact(input: string): string {
    let output = input;
    for (const secret of this.secrets) output = output.split(secret).join("<redacted>");
    return output;
  }
}

export function createBashOutputSanitizerTransform(literalSecrets: readonly string[]): Transform {
  const decoder = new StringDecoder("utf8");
  const ansiStripper = new StreamingAnsiStripper();
  const redactor = new StreamingLiteralRedactor(literalSecrets);

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        callback(null, redactor.write(ansiStripper.write(decoder.write(chunk))));
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback: TransformCallback) {
      try {
        const decodedTail = decoder.end();
        callback(null, redactor.write(ansiStripper.write(decodedTail)) + redactor.end());
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}
