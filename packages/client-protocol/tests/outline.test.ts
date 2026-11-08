import { describe, expect, test } from "bun:test";
import {
  OUTLINE_REPLY_PREVIEW_LENGTH,
  turnPreviewText,
  type DisplayMessage,
} from "../src/index.ts";

const message = (
  role: DisplayMessage["role"],
  text: string,
  phase?: "commentary" | "final",
): DisplayMessage => ({
  id: `${role}-${text.length}-${phase ?? ""}`,
  role,
  ...(phase ? { metadata: { phase } } : {}),
  parts: [{ type: "text", text }],
});

describe("turn preview text", () => {
  test("uses the first prompt and the final reply over commentary", () => {
    expect(
      turnPreviewText([
        message("user", "Check  the\n\nbuild"),
        message("user", "Also the tests"),
        message("assistant", "Looking now", "commentary"),
        message("assistant", "Both pass.", "final"),
        message("assistant", "", "final"),
      ]),
    ).toEqual({ user: "Check the build", reply: "Both pass." });
  });

  test("keeps link labels and truncates long replies", () => {
    const preview = turnPreviewText([
      message("user", "[Assistant quote](lilac-citation://v1/quote?thread=a&message=b) why?"),
      message("assistant", "word ".repeat(200)),
    ]);
    expect(preview.user).toBe("Assistant quote why?");
    expect(preview.reply?.length).toBe(OUTLINE_REPLY_PREVIEW_LENGTH);
    expect(preview.reply?.endsWith("…")).toBe(true);
  });

  test("flattens markdown structure into prose", () => {
    expect(
      turnPreviewText([
        message("user", "## Plan\n\n> quoted"),
        message(
          "assistant",
          "Next steps:\n\n- **Pin** the `cache` key\n1. Rebalance\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
        ),
      ]),
    ).toEqual({
      user: "Plan quoted",
      reply: "Next steps: Pin the cache key Rebalance const a = 1; A B 1 2",
    });
  });

  test("omits a missing side", () => {
    expect(turnPreviewText([message("assistant", "Reminder: stand-up at 10")])).toEqual({
      reply: "Reminder: stand-up at 10",
    });
  });
});
