import { createInterface, type Interface } from "node:readline";

import type {
  MiniLilacModelSummary,
  MiniLilacProfileSummary,
} from "@stanley2058/mini-lilac-client";

export interface Choice {
  readonly id: string;
  readonly label: string;
  readonly hint: string | undefined;
  readonly isDefault: boolean;
}

/** Index of the default choice, or 0 when none is marked. Pure. */
export function defaultChoiceIndex(choices: readonly Choice[]): number {
  const index = choices.findIndex((choice) => choice.isDefault);
  return index >= 0 ? index : 0;
}

/** Resolve a numbered-selection input to a choice, or `undefined` if invalid. Pure. */
export function resolveChoiceInput(
  input: string,
  choices: readonly Choice[],
  defaultIndex: number,
): Choice | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return choices[defaultIndex];
  if (!/^\d+$/.test(trimmed)) return undefined;
  const position = Number.parseInt(trimmed, 10);
  if (position < 1 || position > choices.length) return undefined;
  return choices[position - 1];
}

export function modelChoices(models: readonly MiniLilacModelSummary[]): Choice[] {
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    hint: model.provider,
    isDefault: model.isDefault === true,
  }));
}

/** Profiles usable interactively (subagent-only profiles are filtered out). */
export function selectableProfileChoices(profiles: readonly MiniLilacProfileSummary[]): Choice[] {
  return profiles
    .filter((profile) => !profile.subagentOnly)
    .map((profile) => ({
      id: profile.id,
      label: profile.label,
      hint: profile.description,
      isDefault: profile.isDefault === true,
    }));
}

export function renderChoiceList(
  title: string,
  choices: readonly Choice[],
  defaultIndex: number,
): string {
  const lines = [title];
  choices.forEach((choice, index) => {
    const marker = index === defaultIndex ? "*" : " ";
    const hint = choice.hint !== undefined && choice.hint.length > 0 ? ` - ${choice.hint}` : "";
    const idNote = choice.id === choice.label ? "" : ` (${choice.id})`;
    lines.push(`  ${marker} ${index + 1}. ${choice.label}${idNote}${hint}`);
  });
  return lines.join("\n");
}

export interface PreflightIO {
  write(text: string): void;
  question(prompt: string): Promise<string>;
}

export function createReadlinePreflightIO(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): PreflightIO & { close(): void } {
  const rl: Interface = createInterface({ input, output });
  return {
    write: (text) => output.write(text),
    question: (prompt) => new Promise<string>((resolve) => rl.question(prompt, resolve)),
    close: () => rl.close(),
  };
}

/**
 * Prompt for a numbered selection, retrying until a valid choice is made.
 * If preselected is provided, resolve it without prompting.
 */
export async function selectChoice(
  io: PreflightIO,
  title: string,
  choices: readonly Choice[],
  preselectedId: string | undefined,
): Promise<Choice> {
  if (choices.length === 0) throw new Error(`No ${title.toLowerCase()} available`);

  if (preselectedId !== undefined) {
    const match = choices.find((choice) => choice.id === preselectedId);
    if (match === undefined) {
      throw new Error(`Unknown selection '${preselectedId}' for ${title.toLowerCase()}`);
    }
    return match;
  }

  const defaultIndex = defaultChoiceIndex(choices);
  io.write(`${renderChoiceList(title, choices, defaultIndex)}\n`);

  for (;;) {
    const answer = await io.question(`Select 1-${choices.length} [${defaultIndex + 1}]: `);
    const choice = resolveChoiceInput(answer, choices, defaultIndex);
    if (choice !== undefined) return choice;
    io.write("Invalid selection, try again.\n");
  }
}
