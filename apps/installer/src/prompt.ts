import * as clack from "@clack/prompts";
import type { Prompt } from "./types";

type PromptSession = { cancelled: boolean };

function resolvePromptValue<T>(value: T | symbol, session: PromptSession): T {
  if (clack.isCancel(value)) {
    session.cancelled = true;
    throw new DOMException("Setup cancelled.", "AbortError");
  }
  return value;
}

export function createPrompt(): Prompt & { close(): void; cancelled(): boolean } {
  const session: PromptSession = { cancelled: false };

  async function text(options: {
    message: string;
    initial?: string;
    secret?: boolean;
    required?: boolean;
  }): Promise<string> {
    const initial = options.initial ?? "";
    if (options.secret) {
      const answer = await clack.password({
        message: initial ? `${options.message} (Enter to keep existing)` : options.message,
        validate: (value) => {
          if (options.required && !(value?.trim() || initial)) return "Enter a value to continue.";
        },
      });
      return resolvePromptValue(answer, session).trim() || initial;
    }
    const answer = await clack.text({
      message: options.message,
      initialValue: initial,
      validate: (value) => {
        if (options.required && !value?.trim()) return "Enter a value to continue.";
      },
    });
    return resolvePromptValue(answer, session).trim();
  }

  async function select<T extends string>(
    message: string,
    choices: readonly { value: T; label: string }[],
    initial?: T,
  ): Promise<T> {
    const answer = await clack.select({
      message,
      options: choices.map((choice) => ({ value: choice, label: choice.label })),
      initialValue: choices.find((choice) => choice.value === initial),
    });
    return resolvePromptValue(answer, session).value;
  }

  async function confirm(message: string, initial = false): Promise<boolean> {
    return resolvePromptValue(await clack.confirm({ message, initialValue: initial }), session);
  }

  return {
    text,
    select,
    confirm,
    note: (message) => clack.log.message(message),
    close() {},
    cancelled: () => session.cancelled,
  };
}
