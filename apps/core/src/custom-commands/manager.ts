import { captureError } from "../shared/error-capture.js";
import { pathToFileURL } from "node:url";

import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  buildCustomCommandTextName,
  CUSTOM_COMMAND_TEXT_PREFIX,
  CUSTOM_COMMAND_TOOL_NAME,
  decodeCustomCommandResult,
  discoverCustomCommands,
  isPanic,
  isRecord,
  opaqueErrorCause,
  opaqueErrorMessage,
  type CustomCommandArgDef,
  type CustomCommandContext,
  type CustomCommandDiscoveryDependencies,
  type CustomCommandDiscoveryError,
  type CustomCommandResult,
  type DiscoveredCustomCommand,
} from "@stanley2058/lilac-utils";

type CustomCommandErrorDetails = {
  readonly commandName: string;
  readonly entrypointPath: string;
  readonly message: string;
};

type CustomCommandModule = {
  readonly execute: (args: readonly unknown[], context: CustomCommandContext) => unknown;
};

export class CustomCommandImportError extends TaggedError("CustomCommandImportError")<
  CustomCommandErrorDetails & { readonly cause: unknown }
> {}

export class CustomCommandExecuteMissingError extends TaggedError(
  "CustomCommandExecuteMissingError",
)<CustomCommandErrorDetails> {}

export class CustomCommandExecuteThrownError extends TaggedError("CustomCommandExecuteThrownError")<
  CustomCommandErrorDetails & { readonly cause: unknown }
> {}

export class CustomCommandExecuteRejectedError extends TaggedError(
  "CustomCommandExecuteRejectedError",
)<CustomCommandErrorDetails & { readonly cause: unknown }> {}

export class CustomCommandResultInvalidError extends TaggedError(
  "CustomCommandResultInvalidError",
)<CustomCommandErrorDetails> {}

export type CustomCommandExecutionError =
  | CustomCommandImportError
  | CustomCommandExecuteMissingError
  | CustomCommandExecuteThrownError
  | CustomCommandExecuteRejectedError
  | CustomCommandResultInvalidError;

export class CustomCommandUnknownError extends TaggedError("CustomCommandUnknownError")<{
  readonly commandName: string;
  readonly message: string;
}> {}

export class CustomCommandUnterminatedQuoteError extends TaggedError(
  "CustomCommandUnterminatedQuoteError",
)<{
  readonly quote: "'" | '"';
  readonly message: string;
}> {}

export class CustomCommandNumberArgumentError extends TaggedError(
  "CustomCommandNumberArgumentError",
)<{
  readonly token: string;
  readonly message: string;
}> {}

export class CustomCommandBooleanArgumentError extends TaggedError(
  "CustomCommandBooleanArgumentError",
)<{
  readonly token: string;
  readonly message: string;
}> {}

export class CustomCommandArgumentChoiceError extends TaggedError(
  "CustomCommandArgumentChoiceError",
)<{
  readonly argumentKey: string;
  readonly choices: readonly string[];
  readonly value: string;
  readonly message: string;
}> {}

export class CustomCommandUnknownArgumentError extends TaggedError(
  "CustomCommandUnknownArgumentError",
)<{
  readonly argumentKey: string;
  readonly commandTextName: string;
  readonly message: string;
}> {}

export class CustomCommandRequiredArgumentError extends TaggedError(
  "CustomCommandRequiredArgumentError",
)<{
  readonly argumentKey: string;
  readonly message: string;
}> {}

type CustomCommandArgumentValueError =
  | CustomCommandNumberArgumentError
  | CustomCommandBooleanArgumentError;
export type CustomCommandArgumentValue = string | number | boolean;
type ParsedCustomCommandArgument = CustomCommandArgumentValue | undefined;
export type CustomCommandInvocationError =
  | CustomCommandUnknownError
  | CustomCommandUnterminatedQuoteError
  | CustomCommandArgumentValueError
  | CustomCommandArgumentChoiceError
  | CustomCommandUnknownArgumentError
  | CustomCommandRequiredArgumentError;

export function customCommandInvocationErrorText(error: CustomCommandInvocationError): string {
  switch (error._tag) {
    case "CustomCommandUnknownError":
    case "CustomCommandUnterminatedQuoteError":
    case "CustomCommandNumberArgumentError":
    case "CustomCommandBooleanArgumentError":
    case "CustomCommandArgumentChoiceError":
    case "CustomCommandUnknownArgumentError":
    case "CustomCommandRequiredArgumentError":
      return error.message;
  }
}

function continueInvocation<T, U>(
  result: ResultType<T, CustomCommandInvocationError>,
  onOk: (value: T) => ResultType<U, CustomCommandInvocationError>,
): ResultType<U, CustomCommandInvocationError> {
  if (result.isErr()) return Result.err(result.error);
  const value = result.value;
  return onOk(value);
}

function decodeCustomCommandModule(value: unknown): CustomCommandModule | null {
  if (!isRecord(value) || typeof value["execute"] !== "function") return null;
  const execute = value["execute"];
  return {
    execute: (args, context) => execute.call(value, args, context),
  };
}

async function importCustomCommandModule(params: {
  commandName: string;
  entrypointPath: string;
}): Promise<
  ResultType<CustomCommandModule, CustomCommandImportError | CustomCommandExecuteMissingError>
> {
  const captured = (
    await Result.tryPromise({
      try: async () =>
        decodeCustomCommandModule(await import(pathToFileURL(params.entrypointPath).href)),
      catch: captureError,
    })
  ).match<
    | { readonly kind: "success"; readonly commandModule: CustomCommandModule | null }
    | { readonly kind: "failure"; readonly failure: Error }
  >({
    ok: (commandModule) => ({ kind: "success", commandModule }),
    err: ({ cause }) => ({ kind: "failure", failure: cause }),
  });
  if (captured.kind === "failure") {
    const caught = captured.failure;
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command import failure");
    return Result.err(
      new CustomCommandImportError({
        ...params,
        cause,
        message: `Failed to import command '${params.commandName}': ${opaqueErrorMessage(cause, "Opaque custom-command import failure")}`,
      }),
    );
  }
  if (captured.commandModule) return Result.ok(captured.commandModule);
  return Result.err(
    new CustomCommandExecuteMissingError({
      ...params,
      message: `Command '${params.commandName}' must export async execute(args, ctx).`,
    }),
  );
}

function invokeCustomCommand(params: {
  commandName: string;
  entrypointPath: string;
  run: () => unknown;
}): ResultType<
  Promise<
    ResultType<
      CustomCommandResult,
      CustomCommandExecuteRejectedError | CustomCommandResultInvalidError
    >
  >,
  CustomCommandExecuteThrownError
> {
  const captured = Result.try({
    try: params.run,
    catch: captureError,
  }).match<
    | { readonly kind: "success"; readonly execution: unknown }
    | { readonly kind: "failure"; readonly failure: Error }
  >({
    ok: (execution) => ({ kind: "success", execution }),
    err: ({ cause }) => ({ kind: "failure", failure: cause }),
  });
  if (captured.kind === "success") {
    return Result.ok(
      settleCustomCommand({
        commandName: params.commandName,
        entrypointPath: params.entrypointPath,
        run: async () => await captured.execution,
      }),
    );
  }
  const caught = captured.failure;
  if (isPanic(caught)) throw caught;
  const cause = opaqueErrorCause(caught, "Opaque custom-command execution failure");
  return Result.err(
    new CustomCommandExecuteThrownError({
      commandName: params.commandName,
      entrypointPath: params.entrypointPath,
      cause,
      message: `Command '${params.commandName}' threw while executing: ${opaqueErrorMessage(cause, "Opaque custom-command execution failure")}`,
    }),
  );
}

async function settleCustomCommand(params: {
  commandName: string;
  entrypointPath: string;
  run: () => Promise<unknown>;
}): Promise<
  ResultType<
    CustomCommandResult,
    CustomCommandExecuteRejectedError | CustomCommandResultInvalidError
  >
> {
  const captured = (
    await Result.tryPromise({
      try: async () => decodeCustomCommandResult(await params.run()),
      catch: captureError,
    })
  ).match<
    | { readonly kind: "success"; readonly value: CustomCommandResult | null }
    | { readonly kind: "failure"; readonly failure: Error }
  >({
    ok: (value) => ({ kind: "success", value }),
    err: ({ cause }) => ({ kind: "failure", failure: cause }),
  });
  if (captured.kind === "failure") {
    const caught = captured.failure;
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command rejection");
    return Result.err(
      new CustomCommandExecuteRejectedError({
        commandName: params.commandName,
        entrypointPath: params.entrypointPath,
        cause,
        message: `Command '${params.commandName}' rejected while executing: ${opaqueErrorMessage(cause, "Opaque custom-command rejection")}`,
      }),
    );
  }
  if (captured.value !== null) return Result.ok(captured.value);
  return Result.err(
    new CustomCommandResultInvalidError({
      commandName: params.commandName,
      entrypointPath: params.entrypointPath,
      message: `Command '${params.commandName}' returned an invalid tool result payload.`,
    }),
  );
}

function validateArgChoice(
  arg: CustomCommandArgDef,
  value: CustomCommandArgumentValue,
): ResultType<CustomCommandArgumentValue, CustomCommandArgumentChoiceError> {
  if (arg.type !== "string" || typeof value !== "string" || !arg.choices?.length) {
    return Result.ok(value);
  }
  if (arg.choices.includes(value)) return Result.ok(value);

  return Result.err(
    new CustomCommandArgumentChoiceError({
      argumentKey: arg.key,
      choices: arg.choices,
      value,
      message: `Argument '${arg.key}' must be one of: ${arg.choices.join(", ")}.`,
    }),
  );
}

function parseStringToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function parseNumberToken(token: string): ResultType<number, CustomCommandNumberArgumentError> {
  const value = Number(token);
  if (!Number.isFinite(value)) {
    return Result.err(
      new CustomCommandNumberArgumentError({
        token,
        message: `Expected a number, got '${token}'.`,
      }),
    );
  }
  return Result.ok(value);
}

function parseBooleanToken(token: string): ResultType<boolean, CustomCommandBooleanArgumentError> {
  const value = token.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(value)) return Result.ok(true);
  if (["false", "0", "no", "n", "off"].includes(value)) return Result.ok(false);
  return Result.err(
    new CustomCommandBooleanArgumentError({
      token,
      message: `Expected a boolean, got '${token}'.`,
    }),
  );
}

function parseArgValue(
  type: "string" | "number" | "boolean",
  raw: string,
): ResultType<CustomCommandArgumentValue, CustomCommandArgumentValueError> {
  if (type === "string") return Result.ok(parseStringToken(raw));
  if (type === "number") return parseNumberToken(raw);
  return parseBooleanToken(raw);
}

function tokenize(text: string): ResultType<string[], CustomCommandUnterminatedQuoteError> {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        cur += ch;
        continue;
      }
      cur += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }

    if (/\s/u.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (quote) {
    return Result.err(
      new CustomCommandUnterminatedQuoteError({
        quote,
        message: `Unterminated ${quote} quote in command input.`,
      }),
    );
  }
  if (cur.length > 0) out.push(cur);
  return Result.ok(out);
}

export type LoadedCustomCommand = DiscoveredCustomCommand & {
  textName: string;
};

export type ParsedCustomCommandInvocation = {
  command: LoadedCustomCommand;
  args: ParsedCustomCommandArgument[];
  prompt: string | null;
  text: string;
  source: "text" | "discord-slash";
};

type ParsedArgsAndPrompt = {
  args: ParsedCustomCommandArgument[];
  prompt: string | null;
};

export class CustomCommandManager {
  private readonly reserved = new Set(["lilac", "model", "divider"]);
  private readonly byName = new Map<string, LoadedCustomCommand>();
  private readonly warnings: string[] = [];

  constructor(
    private readonly dataDir: string,
    private readonly discoveryDependencies?: Partial<CustomCommandDiscoveryDependencies>,
  ) {}

  async init(): Promise<ResultType<void, CustomCommandDiscoveryError>> {
    this.byName.clear();
    this.warnings.length = 0;

    const discovered = await discoverCustomCommands({
      dataDir: this.dataDir,
      dependencies: this.discoveryDependencies,
    });
    return discovered.map((entries) => {
      for (const entry of entries) {
        if (entry.type === "invalid") {
          this.warnings.push(`${entry.invalid.dir}: ${entry.invalid.reason}`);
          continue;
        }

        const cmd = entry.command;
        if (this.reserved.has(cmd.def.name)) {
          this.warnings.push(`${cmd.dir}: command name '${cmd.def.name}' is reserved`);
          continue;
        }
        if (this.byName.has(cmd.def.name)) {
          this.warnings.push(`${cmd.dir}: duplicate command name '${cmd.def.name}'`);
          continue;
        }

        this.byName.set(cmd.def.name, {
          ...cmd,
          textName: buildCustomCommandTextName(cmd.def.name),
        });
      }
    });
  }

  list(): LoadedCustomCommand[] {
    return [...this.byName.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  listWarnings(): string[] {
    return [...this.warnings];
  }

  get(name: string): LoadedCustomCommand | null {
    return this.byName.get(name) ?? null;
  }

  peekTextName(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith(`/${CUSTOM_COMMAND_TEXT_PREFIX}`)) return null;
    const token = trimmed.slice(1).split(/\s/u, 1)[0]?.trim();
    if (!token?.startsWith(CUSTOM_COMMAND_TEXT_PREFIX)) return null;
    const name = token.slice(CUSTOM_COMMAND_TEXT_PREFIX.length).trim();
    return name.length > 0 ? name : null;
  }

  parseText(
    text: string,
  ): ResultType<ParsedCustomCommandInvocation | null, CustomCommandInvocationError> {
    const trimmed = text.trim();
    if (!trimmed.startsWith(`/${CUSTOM_COMMAND_TEXT_PREFIX}`)) return Result.ok(null);

    const tokenized = tokenize(trimmed.slice(1));
    return continueInvocation(tokenized, (tokens) => {
      const head = tokens.shift();
      if (!head || !head.startsWith(CUSTOM_COMMAND_TEXT_PREFIX)) return Result.ok(null);

      const name = head.slice(CUSTOM_COMMAND_TEXT_PREFIX.length);
      const command = this.get(name);
      if (!command) return Result.ok(null);
      const parsed = this.parseArgsAndPrompt(command, tokens);
      return continueInvocation(parsed, (value) =>
        Result.ok({
          command,
          args: value.args,
          prompt: value.prompt,
          text: trimmed,
          source: "text",
        }),
      );
    });
  }

  parseSlash(params: {
    name: string;
    rawArgs: Record<string, CustomCommandArgumentValue>;
    prompt?: string | null;
  }): ResultType<ParsedCustomCommandInvocation, CustomCommandInvocationError> {
    const { name, rawArgs } = params;
    const command = this.get(name);
    if (!command) {
      return Result.err(
        new CustomCommandUnknownError({
          commandName: name,
          message: `Unknown custom command '${name}'.`,
        }),
      );
    }

    const args: ParsedCustomCommandArgument[] = [];
    const parseAt = (index: number): ResultType<void, CustomCommandInvocationError> => {
      const arg = command.def.args[index];
      if (!arg) return Result.ok(undefined);
      const value = rawArgs[arg.key];
      if (value === undefined || value === null) {
        if (arg.required) {
          return Result.err(
            new CustomCommandRequiredArgumentError({
              argumentKey: arg.key,
              message: `Missing required argument '${arg.key}'.`,
            }),
          );
        }
        args.push(undefined);
        return parseAt(index + 1);
      }
      const choice = validateArgChoice(arg, value);
      return continueInvocation(choice, (parsed) => {
        args.push(parsed);
        return parseAt(index + 1);
      });
    };
    return continueInvocation(parseAt(0), () =>
      Result.ok({
        command,
        args,
        prompt: params.prompt?.trim() ? params.prompt.trim() : null,
        text: this.formatText(
          command,
          command.def.args.flatMap((arg, index) => {
            const value = args[index];
            if (value === undefined) return [];
            return [`${arg.key}=${String(value)}`];
          }),
          params.prompt ?? null,
        ),
        source: "discord-slash",
      }),
    );
  }

  async execute(params: {
    command: LoadedCustomCommand;
    args: unknown[];
    context: CustomCommandContext;
  }): Promise<ResultType<CustomCommandResult, CustomCommandExecutionError>> {
    const commandName = params.command.def.name;
    const entrypointPath = params.command.entrypointPath;
    const imported = await importCustomCommandModule({ commandName, entrypointPath });
    if (imported.isErr()) return Result.err(imported.error);
    const commandModule = imported.value;
    const invoked = invokeCustomCommand({
      commandName,
      entrypointPath,
      run: () => commandModule.execute(params.args, params.context),
    });
    if (invoked.isErr()) return Result.err(invoked.error);
    const execution = invoked.value;
    return execution;
  }

  formatPreview(invocation: ParsedCustomCommandInvocation): string {
    const baseText = this.formatText(
      invocation.command,
      invocation.command.def.args.flatMap((arg, index) => {
        const value = invocation.args[index];
        if (value === undefined) return [];
        return [`${arg.key}=${String(value)}`];
      }),
    );

    if (!invocation.prompt) return baseText;
    return `${baseText}\nPrompt: ${invocation.prompt}`;
  }

  private formatText(
    command: LoadedCustomCommand,
    parts: readonly string[],
    prompt?: string | null,
  ): string {
    const trimmedPrompt = prompt?.trim() ? prompt.trim() : null;
    if (parts.length === 0 && !trimmedPrompt) return `/${command.textName}`;
    if (parts.length === 0) return `/${command.textName} ${trimmedPrompt}`;
    if (!trimmedPrompt) return `/${command.textName} ${parts.join(" ")}`;
    return `/${command.textName} ${parts.join(" ")} ${trimmedPrompt}`;
  }

  private parseArgsAndPrompt(
    command: LoadedCustomCommand,
    tokens: readonly string[],
  ): ResultType<ParsedArgsAndPrompt, CustomCommandInvocationError> {
    const out: ParsedCustomCommandArgument[] = Array.from({
      length: command.def.args.length,
    });
    let pos = 0;
    let promptStartIndex: number | null = null;

    const parseAt = (i: number): ResultType<void, CustomCommandInvocationError> => {
      const token = tokens[i];
      if (token === undefined) return Result.ok(undefined);
      const eq = token.indexOf("=");
      if (eq > 0) {
        const key = token.slice(0, eq);
        const raw = token.slice(eq + 1);
        const index = command.def.args.findIndex((arg) => arg.key === key);
        if (index < 0) {
          return Result.err(
            new CustomCommandUnknownArgumentError({
              argumentKey: key,
              commandTextName: command.textName,
              message: `Unknown argument '${key}' for /${command.textName}.`,
            }),
          );
        }
        const arg = command.def.args[index]!;
        const parsedValue = parseArgValue(arg.type, raw);
        return continueInvocation(parsedValue, (value) => {
          const choice = validateArgChoice(arg, value);
          return continueInvocation(choice, (selected) => {
            out[index] = selected;
            return parseAt(i + 1);
          });
        });
      }

      while (pos < command.def.args.length && out[pos] !== undefined) {
        pos += 1;
      }
      const arg = command.def.args[pos];
      if (!arg) {
        promptStartIndex = i;
        return Result.ok(undefined);
      }

      const parsedValue = parseArgValue(arg.type, token);
      const continueParsed = parsedValue.match<
        () => ResultType<void, CustomCommandInvocationError>
      >({
        err: (error) => () => {
          if (arg.required) return Result.err(error);
          promptStartIndex = i;
          return Result.ok(undefined);
        },
        ok: (value) => () =>
          continueInvocation(validateArgChoice(arg, value), (selected) => {
            out[pos] = selected;
            pos += 1;
            return parseAt(i + 1);
          }),
      });
      return continueParsed();
    };

    const validateRequiredAt = (
      index: number,
    ): ResultType<ParsedArgsAndPrompt, CustomCommandInvocationError> => {
      const arg = command.def.args[index];
      if (!arg) {
        return Result.ok({
          args: out,
          prompt: promptStartIndex === null ? null : tokens.slice(promptStartIndex).join(" "),
        });
      }
      if (arg.required && out[index] === undefined) {
        return Result.err(
          new CustomCommandRequiredArgumentError({
            argumentKey: arg.key,
            message: `Missing required argument '${arg.key}'.`,
          }),
        );
      }
      return validateRequiredAt(index + 1);
    };
    return continueInvocation(parseAt(0), () => validateRequiredAt(0));
  }
}

export function buildCustomCommandToolDisplay(input: {
  command: LoadedCustomCommand;
  text: string;
}): string {
  return `${CUSTOM_COMMAND_TOOL_NAME} ${input.text}`;
}
