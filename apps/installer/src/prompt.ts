import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Prompt } from "./types";

export function createPrompt(): Prompt & { close(): void; cancelled(): boolean } {
  let hidden = false;
  const abort = new AbortController();
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  input.on("SIGINT", () => abort.abort());
  input.on("close", () => abort.abort());
  const accent = (value: string) => (process.stdout.isTTY ? `\x1b[36m${value}\x1b[0m` : value);

  async function text(options: {
    message: string;
    initial?: string;
    secret?: boolean;
    required?: boolean;
  }): Promise<string> {
    for (;;) {
      const initial = options.initial ?? "";
      const hint = initial ? ` [${options.secret ? "keep existing" : initial}]` : "";
      process.stdout.write(`${accent("?")} ${options.message}${hint}: `);
      hidden = options.secret === true;
      const answer = await input.question("", { signal: abort.signal });
      if (hidden) process.stdout.write("\n");
      hidden = false;
      const value = answer.trim() || initial;
      if (value || options.required !== true) return value;
      process.stdout.write("  Enter a value to continue.\n");
    }
  }

  async function select<T extends string>(
    message: string,
    choices: readonly { value: T; label: string }[],
    initial?: T,
  ): Promise<T> {
    process.stdout.write(`\n${accent(message)}\n`);
    for (const [index, choice] of choices.entries()) {
      process.stdout.write(`  ${index + 1}. ${choice.label}\n`);
    }
    const defaultIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.value === initial),
    );
    for (;;) {
      const answer = await text({ message: "Choose", initial: String(defaultIndex + 1) });
      const index = Number(answer) - 1;
      const choice = Number.isInteger(index) ? choices[index] : undefined;
      if (choice) return choice.value;
      process.stdout.write(`  Choose a number from 1 to ${choices.length}.\n`);
    }
  }

  async function confirm(message: string, initial = false): Promise<boolean> {
    for (;;) {
      const answer = (
        await text({ message: `${message} (y/n)`, initial: initial ? "y" : "n" })
      ).toLowerCase();
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      process.stdout.write("  Enter y or n.\n");
    }
  }

  return {
    text,
    select,
    confirm,
    note: (message) => process.stdout.write(`\n${message}\n`),
    close: () => input.close(),
    cancelled: () => abort.signal.aborted,
  };
}
