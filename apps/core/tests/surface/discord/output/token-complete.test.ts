import { describe, expect, it } from "bun:test";
import {
  completeMarkdown,
  tokenComplete,
  tokenCompleteAt,
} from "../../../../src/surface/discord/output/token-complete";

// Intentionally copied/adapted from ref/js-llmcord.
// Keep these tests to prevent regressions in markdown completion / streaming behavior.

describe("token-complete", () => {
  describe("no splitting needed", () => {
    it("should return input unchanged when within limit (no open tags)", () => {
      const result = tokenComplete("hello world", 100);
      expect(result.completed).toBe("hello world");
      expect(result.overflow).toBe("");
    });

    it("should return input unchanged when exactly at limit", () => {
      const result = tokenComplete("hello", 5);
      expect(result.completed).toBe("hello");
      expect(result.overflow).toBe("");
    });

    it("should close open tags even when within limit (for streaming)", () => {
      const result = tokenComplete("**bold text", 100);
      expect(result.completed).toBe("**bold text**");
      expect(result.overflow).toBe("");
    });

    it("should close multiple open tags when within limit", () => {
      const result = tokenComplete("*italic and **bold", 100);
      expect(result.completed).toBe("*italic and **bold***");
      expect(result.overflow).toBe("");
    });
  });

  describe("bold text (**)", () => {
    it("should close and reopen bold tags when split", () => {
      const input = "**this is bold text**";
      const result = tokenComplete(input, 10);
      // remend may trim trailing whitespace at the split boundary.
      expect(result.completed).toBe("**this is**");
      expect(result.overflow).toBe("**bold text**");
    });

    it("should handle unclosed bold at split point", () => {
      const input = "**bold text continues here";
      const result = tokenComplete(input, 8);
      expect(result.completed).toBe("**bold t**");
      expect(result.overflow).toBe("**ext continues here");
    });
  });

  describe("italic text (*)", () => {
    it("should close and reopen italic tags when split", () => {
      const input = "*this is italic text*";
      const result = tokenComplete(input, 10);
      expect(result.completed).toBe("*this is i*");
      expect(result.overflow).toBe("*talic text*");
    });
  });

  describe("bold + italic (***)", () => {
    it("should close and reopen bold+italic tags when split", () => {
      const input = "***bold and italic***";
      const result = tokenComplete(input, 10);
      expect(result.completed).toBe("***bold an***");
      expect(result.overflow).toBe("***d italic***");
    });
  });

  describe("inline code (`)", () => {
    it("should close and reopen inline code when split", () => {
      const input = "`some code here`";
      const result = tokenComplete(input, 8);
      expect(result.completed).toBe("`some co`");
      expect(result.overflow).toBe("`de here`");
    });
  });

  describe("code blocks (```)", () => {
    it("should close and reopen code fence when split", () => {
      const input = "```js\nhello world\n```";
      const result = tokenComplete(input, 8);
      expect(result.completed).toBe("```js\nhe\n```");
      expect(result.overflow).toBe("```js\nllo world\n```");
    });
  });

  describe("strikethrough (~~)", () => {
    it("should close and reopen strikethrough when split", () => {
      const input = "~~deleted text here~~";
      const result = tokenComplete(input, 12);
      expect(result.completed).toBe("~~deleted te~~");
      expect(result.overflow).toBe("~~xt here~~");
    });
  });

  describe("underscore bold (__)", () => {
    it("should close and reopen underscore bold when split", () => {
      const input = "__bold text here__";
      const result = tokenComplete(input, 10);
      expect(result.completed).toBe("__bold tex__");
      expect(result.overflow).toBe("__t here__");
    });
  });

  describe("block math ($$)", () => {
    it("should close and reopen block math when split", () => {
      const input = "$$\nx = y + z\n$$";
      const result = tokenComplete(input, 8);
      expect(result.completed).toBe("$$\nx = y\n$$");
      expect(result.overflow).toBe("$$\n + z\n$$");
    });
  });

  describe("nested formatting", () => {
    it("should handle nested bold and italic", () => {
      const input = "**bold *and italic* text**";
      const result = tokenComplete(input, 15);
      expect(result.completed).toContain("**");
    });
  });

  describe("code block protection", () => {
    it("should not add closing * for asterisks inside inline code", () => {
      const input = "Use `response.*` pattern";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe(input);
    });

    it("should not add closing * for asterisks inside code fences", () => {
      const input = "```js\nconst x = 5 * 2;\n```";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe(input);
    });

    it("should still close unclosed italic outside code blocks", () => {
      const input = "*italic with `code*` inside";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe("*italic with `code*` inside*");
    });

    it("should handle mixed code and formatting", () => {
      const input = "**bold** and `code with *` here";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe(input);
    });

    it("should handle multiple code blocks with asterisks", () => {
      const input = "First `a*b` then `c*d` end";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe(input);
    });

    it("should close unclosed inline code without adding extra *", () => {
      const input = "`response.*";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe("`response.*`");
    });

    it("should handle unclosed code with asterisks and spaces", () => {
      const input = "`a * b";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe("`a * b`");
    });

    it("should close unclosed code fence with asterisks", () => {
      const input = "```js\nconst x = 5 *";
      const result = tokenComplete(input, 100);
      expect(result.completed).toBe("```js\nconst x = 5 *\n```");
    });
  });

  describe("real-world scenarios", () => {
    it("should handle LLM response split mid-sentence", () => {
      const input = "*this is a sentence generated by a large language model*";
      const result = tokenComplete(input, 20);
      // remend may trim trailing whitespace at the split boundary.
      expect(result.completed).toBe("*this is a sentence*");
      expect(result.overflow).toBe("*generated by a large language model*");
    });

    it("should handle multiple paragraphs with formatting", () => {
      const input = "Normal text\n\n**Bold paragraph that is very long**";
      const result = tokenComplete(input, 25);
      expect(result.completed).toBe("Normal text\n\n**Bold parag**");
      expect(result.overflow).toBe("**raph that is very long**");
    });
  });

  describe("streaming buffer simulation", () => {
    it("should not accumulate closing tags when simulating streaming chunks", () => {
      const maxLength = 100;

      const chunk1 = "*this is a sentence";
      let rawBuffer = chunk1;
      const display1 = tokenComplete(rawBuffer, maxLength).completed;
      expect(display1).toBe("*this is a sentence*");

      const chunk2 = " generated by a large language model*";
      rawBuffer = rawBuffer + chunk2;
      const display2 = tokenComplete(rawBuffer, maxLength).completed;

      expect(rawBuffer).toBe("*this is a sentence generated by a large language model*");
      expect(display2).toBe("*this is a sentence generated by a large language model*");
    });

    it("should handle overflow case with proper tag continuation", () => {
      const maxLength = 21;

      const chunk1 = "*this is a very long bold sentence*";

      const { completed: display1, overflow: overflowPrefix } = tokenComplete(chunk1, maxLength);

      // remend may trim trailing whitespace at the split boundary.
      expect(display1).toBe("*this is a very long*");
      expect(overflowPrefix).toBe("*bold sentence*");

      const finalDisplay2 = tokenComplete(overflowPrefix, maxLength).completed;
      expect(finalDisplay2).toBe("*bold sentence*");
    });

    it("should handle multiple overflows correctly", () => {
      const maxLength = 10;

      const fullContent = "**this is a very very long bold text**";

      const { completed: msg1, overflow: overflow1 } = tokenComplete(fullContent, maxLength);
      // remend may trim trailing whitespace at the split boundary.
      expect(msg1).toBe("**this is**");
      expect(overflow1.startsWith("**")).toBe(true);

      const { completed: msg2, overflow: overflow2 } = tokenComplete(overflow1, maxLength);
      expect(msg2).toContain("**");
      expect(msg2.endsWith("**")).toBe(true);

      let remaining = overflow2;
      const messages = [msg1, msg2];
      while (remaining.length > 0) {
        const { completed, overflow } = tokenComplete(remaining, maxLength);
        messages.push(completed);
        remaining = overflow;
      }

      for (const msg of messages) {
        const openCount = (msg.match(/\*\*/g) || []).length;
        expect(openCount % 2).toBe(0);
      }
    });
  });

  describe("tokenCompleteAt / completeMarkdown", () => {
    it("should split at exact position", () => {
      const result = tokenCompleteAt("hello", 2);
      expect(result.completed).toBe("he");
      expect(result.overflow).toBe("llo");
    });

    it("should close and reopen markdown tags when split", () => {
      const input = "**bold text**";
      const result = tokenCompleteAt(input, 8);
      expect(result.completed).toBe("**bold t**");
      expect(result.overflow).toBe("**ext**");
    });

    it("completeMarkdown should close dangling tags", () => {
      expect(completeMarkdown("*hi")).toBe("*hi*");
    });

    it("completeMarkdown should close unclosed code fences", () => {
      const input = "text\n```javascript\nconsole.log(1)\n";
      expect(completeMarkdown(input)).toBe("text\n```javascript\nconsole.log(1)\n```");
    });

    it("completeMarkdown should close fences even without trailing newline", () => {
      const input = "text\n```js\nconsole.log(1)";
      expect(completeMarkdown(input)).toBe("text\n```js\nconsole.log(1)\n```");
    });
  });
});
