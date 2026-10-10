import { describe, expect, it } from "bun:test";
import type { CommandArgument } from "@stanley2058/lilac-client-protocol";
import {
  commandArgumentStep,
  tokenRemainder,
  validateCommandArguments,
} from "../src/command-arguments";

const tarot: CommandArgument[] = [
  { key: "count", type: "number", required: true, description: "Cards to draw" },
  { key: "mode", type: "string", required: false, choices: ["single", "past-present-future"] },
  { key: "reversed", type: "boolean", required: false },
];

const labels = (text: string) => commandArgumentStep(tarot, text).suggestions.map((s) => s.label);

describe("commandArgumentStep", () => {
  it("suggests named arguments for the first free-form argument", () => {
    const step = commandArgumentStep(tarot, "");
    expect(step.active).toBe(0);
    expect(labels("")).toEqual(["count=", "mode=", "reversed="]);
  });

  it("moves to the next argument after a value and offers its choices", () => {
    const step = commandArgumentStep(tarot, "3 ");
    expect(step.active).toBe(1);
    expect(step.values[0]).toBe("3");
    expect(labels("3 ")).toEqual(["single", "past-present-future", "reversed="]);
    expect(labels("3 pa")).toEqual(["past-present-future"]);
  });

  it("completes values for a named argument", () => {
    const step = commandArgumentStep(tarot, "mode=");
    expect(step.active).toBe(1);
    expect(step.suggestions.map((s) => s.insertText)).toEqual([
      "mode=single",
      "mode=past-present-future",
    ]);
    expect(labels("3 reversed=")).toEqual(["true", "false"]);
  });

  it("enters prompt text after the last argument", () => {
    const step = commandArgumentStep(tarot, "3 single yes ");
    expect(step.active).toBeUndefined();
    expect(step.suggestions).toEqual([]);
    expect(step.error).toBeUndefined();
  });

  it("treats an unparsable optional boolean as the start of the prompt", () => {
    expect(commandArgumentStep(tarot, "3 single Please ").active).toBeUndefined();
  });

  it("reports invalid values as the user types", () => {
    expect(commandArgumentStep(tarot, "abc").error?.message).toBe("count must be a number.");
    expect(commandArgumentStep(tarot, "3 mind").error?.message).toContain("mode must be one of");
    expect(commandArgumentStep(tarot, "size=").error?.message).toBe("Unknown argument 'size'.");
    expect(commandArgumentStep(tarot, "-").error).toBeUndefined();
  });

  it("quotes choices that contain spaces", () => {
    const step = commandArgumentStep(
      [{ key: "spread", type: "string", required: true, choices: ["celtic cross"] }],
      "",
    );
    expect(step.suggestions[0]?.insertText).toBe('"celtic cross"');
  });

  it("names positional choices that contain an equals sign", () => {
    const args: CommandArgument[] = [
      { key: "mode", type: "string", required: true, choices: ["a=b"] },
    ];
    const insert = commandArgumentStep(args, "").suggestions[0]?.insertText;
    expect(insert).toBe("mode=a=b");
    expect(validateCommandArguments(args, insert!)).toBeUndefined();
  });

  it("encodes choices with quotes so they parse back exactly", () => {
    const choices = ['Bob\'s "spread"', 'say "hi"', "it's", 'a "b c'];
    const args: CommandArgument[] = [{ key: "mode", type: "string", required: true, choices }];
    const { suggestions } = commandArgumentStep(args, "");
    expect(suggestions).toHaveLength(choices.length);
    for (const suggestion of suggestions)
      expect(validateCommandArguments(args, suggestion.insertText)).toBeUndefined();
  });

  it("measures the rest of a quoted token after the cursor", () => {
    expect(tokenRemainder('3 "cel', 'tic cross" more')).toBe('tic cross"'.length);
    expect(tokenRemainder("3 si", "ngle more")).toBe(4);
    expect(tokenRemainder("3 ", "single")).toBe(6);
    expect(tokenRemainder("3 single ", " more")).toBe(0);
  });

  it("suggests the current argument's key once the user types its prefix", () => {
    expect(labels("3 mo")).toEqual(["mode="]);
  });

  it("keeps quoted values with spaces as one token", () => {
    const args: CommandArgument[] = [{ key: "topic", type: "string", required: true }];
    const step = commandArgumentStep(args, '"career change" ');
    expect(step.values[0]).toBe('"career change"');
    expect(step.active).toBeUndefined();
  });
});

describe("validateCommandArguments", () => {
  it("accepts input that Core accepts", () => {
    expect(validateCommandArguments(tarot, "3")).toBeUndefined();
    expect(validateCommandArguments(tarot, "count=2 mode=single")).toBeUndefined();
    expect(validateCommandArguments(tarot, "3 single Please read this")).toBeUndefined();
  });

  it("rejects input that Core rejects", () => {
    expect(validateCommandArguments(tarot, "")?.message).toBe("count is required.");
    expect(validateCommandArguments(tarot, "count=no")?.index).toBe(0);
    expect(validateCommandArguments(tarot, "3 mind-body-spirit help")?.index).toBe(1);
    expect(validateCommandArguments(tarot, "3 extra=value")?.message).toBe(
      "Unknown argument 'extra'.",
    );
    expect(validateCommandArguments(tarot, '3 "unterminated')?.message).toBe("Close the quote.");
  });
});
