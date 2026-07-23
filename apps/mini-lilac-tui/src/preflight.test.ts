import { describe, expect, it } from "bun:test";

import {
  defaultChoiceIndex,
  resolveChoiceInput,
  selectableProfileChoices,
  selectChoice,
  type Choice,
  type PreflightIO,
} from "./preflight";

const CHOICES: readonly Choice[] = [
  { id: "a", label: "Alpha", hint: undefined, isDefault: false },
  { id: "b", label: "Beta", hint: undefined, isDefault: true },
  { id: "c", label: "Gamma", hint: undefined, isDefault: false },
];

describe("preflight selection helpers", () => {
  it("finds the default choice index and falls back to 0", () => {
    expect(defaultChoiceIndex(CHOICES)).toBe(1);
    expect(defaultChoiceIndex([{ id: "x", label: "X", hint: undefined, isDefault: false }])).toBe(
      0,
    );
  });

  it("resolves empty input to the default and valid numbers to the choice", () => {
    expect(resolveChoiceInput("", CHOICES, 1)).toEqual(CHOICES[1]);
    expect(resolveChoiceInput("  ", CHOICES, 1)).toEqual(CHOICES[1]);
    expect(resolveChoiceInput("3", CHOICES, 1)).toEqual(CHOICES[2]);
  });

  it("rejects out-of-range and non-numeric input", () => {
    expect(resolveChoiceInput("0", CHOICES, 1)).toBeUndefined();
    expect(resolveChoiceInput("4", CHOICES, 1)).toBeUndefined();
    expect(resolveChoiceInput("b", CHOICES, 1)).toBeUndefined();
  });

  it("filters subagent-only profiles from selectable choices", () => {
    const choices = selectableProfileChoices([
      { id: "general", label: "General", subagentOnly: false, isDefault: true },
      { id: "explore", label: "Explore", subagentOnly: true },
    ]);
    expect(choices.map((choice) => choice.id)).toEqual(["general"]);
  });
});

describe("selectChoice", () => {
  function stubIo(answers: string[]): PreflightIO & { writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      write: (text) => {
        writes.push(text);
      },
      question: async () => answers.shift() ?? "",
    };
  }

  it("returns a preselected choice without prompting", async () => {
    const io = stubIo([]);
    const choice = await selectChoice(io, "Model", CHOICES, "c");
    expect(choice.id).toBe("c");
    expect(io.writes).toEqual([]);
  });

  it("throws when a preselected id is unknown", async () => {
    const io = stubIo([]);
    await expect(selectChoice(io, "Model", CHOICES, "zzz")).rejects.toThrow();
  });

  it("prompts and retries until a valid selection is entered", async () => {
    const io = stubIo(["9", "1"]);
    const choice = await selectChoice(io, "Model", CHOICES, undefined);
    expect(choice.id).toBe("a");
  });

  it("uses the default choice on empty input", async () => {
    const io = stubIo([""]);
    const choice = await selectChoice(io, "Model", CHOICES, undefined);
    expect(choice.id).toBe("b");
  });
});
