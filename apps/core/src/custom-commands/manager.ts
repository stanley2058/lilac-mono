import { pathToFileURL } from "node:url";

import {
  buildCustomCommandTextName,
  CUSTOM_COMMAND_TEXT_PREFIX,
  CUSTOM_COMMAND_TOOL_NAME,
  discoverCustomCommands,
  isValidCustomCommandResult,
  type CustomCommandContext,
  type CustomCommandModule,
  type CustomCommandResult,
  type DiscoveredCustomCommand,
} from "@stanley2058/lilac-utils";

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

function parseNumberToken(token: string): number {
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected a number, got '${token}'.`);
  }
  return value;
}

function parseBooleanToken(token: string): boolean {
  const value = token.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(value)) return true;
  if (["false", "0", "no", "n", "off"].includes(value)) return false;
  throw new Error(`Expected a boolean, got '${token}'.`);
}

function parseArgValue(type: "string" | "number" | "boolean", raw: string): unknown {
  if (type === "string") return parseStringToken(raw);
  if (type === "number") return parseNumberToken(raw);
  return parseBooleanToken(raw);
}

function tokenize(text: string): string[] {
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
    throw new Error(`Unterminated ${quote} quote in command input.`);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export type LoadedCustomCommand = DiscoveredCustomCommand & {
  textName: string;
};

export type ParsedCustomCommandInvocation = {
  command: LoadedCustomCommand;
  args: unknown[];
  prompt: string | null;
  text: string;
  source: "text" | "discord-slash";
};

type ParsedArgsAndPrompt = {
  args: unknown[];
  prompt: string | null;
};

export class CustomCommandManager {
  private readonly reserved = new Set(["lilac", "model", "divider"]);
  private readonly byName = new Map<string, LoadedCustomCommand>();
  private readonly warnings: string[] = [];

  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {
    this.byName.clear();
    this.warnings.length = 0;

    for (const entry of await discoverCustomCommands({ dataDir: this.dataDir })) {
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

  parseText(text: string): ParsedCustomCommandInvocation | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith(`/${CUSTOM_COMMAND_TEXT_PREFIX}`)) return null;

    const tokens = tokenize(trimmed.slice(1));
    const head = tokens.shift();
    if (!head || !head.startsWith(CUSTOM_COMMAND_TEXT_PREFIX)) return null;

    const name = head.slice(CUSTOM_COMMAND_TEXT_PREFIX.length);
    const command = this.get(name);
    if (!command) return null;
    const parsed = this.parseArgsAndPrompt(command, tokens);

    return {
      command,
      args: parsed.args,
      prompt: parsed.prompt,
      text: trimmed,
      source: "text",
    };
  }

  parseSlash(params: {
    name: string;
    rawArgs: Record<string, unknown>;
    prompt?: string | null;
  }): ParsedCustomCommandInvocation {
    const { name, rawArgs } = params;
    const command = this.get(name);
    if (!command) {
      throw new Error(`Unknown custom command '${name}'.`);
    }

    const args = command.def.args.map((arg) => {
      const value = rawArgs[arg.key];
      if (value === undefined || value === null) {
        if (arg.required) {
          throw new Error(`Missing required argument '${arg.key}'.`);
        }
        return undefined;
      }
      return value;
    });

    return {
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
    };
  }

  async execute(params: {
    command: LoadedCustomCommand;
    args: unknown[];
    context: CustomCommandContext;
  }): Promise<CustomCommandResult> {
    const mod = (await import(
      pathToFileURL(params.command.entrypointPath).href
    )) as Partial<CustomCommandModule>;
    if (typeof mod.execute !== "function") {
      throw new Error(`Command '${params.command.def.name}' must export async execute(args, ctx).`);
    }

    const result = await mod.execute(params.args, params.context);
    if (!isValidCustomCommandResult(result)) {
      throw new Error(
        `Command '${params.command.def.name}' returned an invalid tool result payload.`,
      );
    }
    return result;
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
  ): ParsedArgsAndPrompt {
    const out = Array.from({ length: command.def.args.length }, () => undefined as unknown);
    let pos = 0;
    let promptStartIndex: number | null = null;

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      const eq = token.indexOf("=");
      if (eq > 0) {
        const key = token.slice(0, eq);
        const raw = token.slice(eq + 1);
        const index = command.def.args.findIndex((arg) => arg.key === key);
        if (index < 0) {
          throw new Error(`Unknown argument '${key}' for /${command.textName}.`);
        }
        out[index] = parseArgValue(command.def.args[index]!.type, raw);
        continue;
      }

      while (pos < command.def.args.length && out[pos] !== undefined) {
        pos += 1;
      }
      const arg = command.def.args[pos];
      if (!arg) {
        promptStartIndex = i;
        break;
      }

      try {
        out[pos] = parseArgValue(arg.type, token);
      } catch (error) {
        if (arg.required) throw error;
        promptStartIndex = i;
        break;
      }
      pos += 1;
    }

    for (let i = 0; i < command.def.args.length; i += 1) {
      const arg = command.def.args[i]!;
      if (arg.required && out[i] === undefined) {
        throw new Error(`Missing required argument '${arg.key}'.`);
      }
    }

    return {
      args: out,
      prompt: promptStartIndex === null ? null : tokens.slice(promptStartIndex).join(" "),
    };
  }
}

export function buildCustomCommandToolDisplay(input: {
  command: LoadedCustomCommand;
  text: string;
}): string {
  return `${CUSTOM_COMMAND_TOOL_NAME} ${input.text}`;
}
