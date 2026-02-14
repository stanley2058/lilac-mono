import remend from "remend";

// Null character used as placeholder delimiter (won't appear in normal text)
const CODE_PLACEHOLDER = "\x00";

function escapeCodeBlocks(text: string): {
  escaped: string;
  codeBlocks: Array<{
    type: "fence" | "inline";
    content: string;
    lang: string;
    closed: boolean;
  }>;
} {
  const codeBlocks: Array<{
    type: "fence" | "inline";
    content: string;
    lang: string;
    closed: boolean;
  }> = [];

  let result = text;

  // First handle triple backticks (code fences) - both closed and unclosed
  // Regex captures: optional language, optional newline, content, optional closing ```
  result = result.replace(
    /```(\w*)(\n?)([\s\S]*?)(```|$)/g,
    (_match, lang: string, newline: string, content: string, closing: string) => {
      const idx = codeBlocks.length;
      const isClosed = closing === "```";
      codeBlocks.push({
        type: "fence",
        content,
        lang: lang || "",
        closed: isClosed,
      });

      if (isClosed) {
        // Closed: completely replace with placeholder (no backticks visible)
        return `${CODE_PLACEHOLDER}FENCE${idx}${CODE_PLACEHOLDER}`;
      }

      // Unclosed: keep ``` visible so remend can close it, hide content
      // Preserve original newline (or lack thereof) after language
      return `\`\`\`${lang}${newline}${CODE_PLACEHOLDER}FENCECONTENT${idx}${CODE_PLACEHOLDER}`;
    },
  );

  // Then handle inline code (single backticks) - both closed and unclosed
  // Now safe because all ``` are replaced with placeholders
  result = result.replace(/`([^`\x00]+)(`|$)/g, (_match, content: string, closing: string) => {
    const idx = codeBlocks.length;
    const isClosed = closing === "`";
    codeBlocks.push({ type: "inline", content, lang: "", closed: isClosed });

    if (isClosed) {
      // Closed: completely replace with placeholder
      return `${CODE_PLACEHOLDER}INLINE${idx}${CODE_PLACEHOLDER}`;
    }

    // Unclosed: keep ` visible so remend can close it, hide content
    return `\`${CODE_PLACEHOLDER}INLINECONTENT${idx}${CODE_PLACEHOLDER}`;
  });

  return { escaped: result, codeBlocks };
}

function restoreCodeBlocks(
  text: string,
  codeBlocks: Array<{
    type: "fence" | "inline";
    content: string;
    lang: string;
    closed: boolean;
  }>,
): string {
  let result = text;
  for (let i = 0; i < codeBlocks.length; i++) {
    const block = codeBlocks[i];
    if (!block) continue;

    if (block.type === "fence") {
      if (block.closed) {
        const placeholder = `${CODE_PLACEHOLDER}FENCE${i}${CODE_PLACEHOLDER}`;
        const langPart = block.lang ? block.lang + "\n" : "";
        const restored = "```" + langPart + block.content + "```";
        result = result.replace(placeholder, restored);
      } else {
        const placeholder = `${CODE_PLACEHOLDER}FENCECONTENT${i}${CODE_PLACEHOLDER}`;
        result = result.replace(placeholder, block.content);
      }
      continue;
    }

    if (block.closed) {
      const placeholder = `${CODE_PLACEHOLDER}INLINE${i}${CODE_PLACEHOLDER}`;
      const restored = "`" + block.content + "`";
      result = result.replace(placeholder, restored);
    } else {
      const placeholder = `${CODE_PLACEHOLDER}INLINECONTENT${i}${CODE_PLACEHOLDER}`;
      result = result.replace(placeholder, block.content);
    }
  }
  return result;
}

function closeUnclosedCodeFences(text: string): string {
  // Discord requires fenced code blocks to be explicitly closed to render.
  // `remend` doesn't reliably close fences, so we do a minimal line-based pass.
  const lines = text.split("\n");
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("```")) continue;
    inFence = !inFence;
  }

  if (!inFence) return text;

  let out = text;
  if (!out.endsWith("\n")) out += "\n";
  out += "```";
  return out;
}

function safeRemend(text: string): string {
  const { escaped, codeBlocks } = escapeCodeBlocks(text);
  const completed = remend(escaped);
  const restored = restoreCodeBlocks(completed, codeBlocks);
  return closeUnclosedCodeFences(restored);
}

function longestCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  for (; i < max; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) break;
  }
  return i;
}

function getCloseSuffix(original: string, completed: string): string {
  const lcp = longestCommonPrefixLength(original, completed);
  return completed.slice(lcp);
}

function detectClosedTagsFromSuffix(addedSuffix: string): string[] {
  const openingTags: string[] = [];

  if (!addedSuffix) return openingTags;

  let remaining = addedSuffix;

  while (remaining.length > 0) {
    if (remaining.startsWith("***")) {
      openingTags.unshift("***");
      remaining = remaining.slice(3);
    } else if (remaining.startsWith("**")) {
      openingTags.unshift("**");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("__")) {
      openingTags.unshift("__");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("~~")) {
      openingTags.unshift("~~");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("$$")) {
      openingTags.unshift("$$");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("```")) {
      openingTags.unshift("```");
      remaining = remaining.slice(3);
    } else if (remaining.startsWith("`")) {
      openingTags.unshift("`");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("*")) {
      openingTags.unshift("*");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("_")) {
      openingTags.unshift("_");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("\n$$")) {
      openingTags.unshift("$$");
      remaining = remaining.slice(3);
    } else {
      remaining = remaining.slice(1);
    }
  }

  return openingTags;
}

function detectClosedTags(original: string, completed: string): string[] {
  return detectClosedTagsFromSuffix(getCloseSuffix(original, completed));
}

function findCodeBlockLanguage(text: string): string {
  const matches = text.match(/```([^\n]*)\n[\s\S]*$/);
  if (!matches) return "";

  return (matches[1] || "").trim();
}

function buildOpeningPrefix(closedTags: string[], originalText: string): string {
  return closedTags
    .map((tag) => {
      if (tag === "```") {
        const lang = findCodeBlockLanguage(originalText);
        return "```" + lang + "\n";
      }
      if (tag === "$$") {
        const isBlockMath = /\$\$\n/.test(originalText);
        return isBlockMath ? "$$\n" : "$$";
      }
      return tag;
    })
    .join("");
}

export function tokenComplete(
  input: string,
  maxOutput: number,
): { completed: string; overflow: string } {
  const completed = safeRemend(input);

  if (completed.length <= maxOutput) {
    return {
      completed,
      overflow: "",
    };
  }

  return tokenCompleteAt(input, maxOutput);
}

export function tokenCompleteAt(
  input: string,
  splitAt: number,
): { completed: string; overflow: string } {
  const clampedSplitAt = Math.max(0, Math.min(splitAt, input.length));
  const firstPart = input.slice(0, clampedSplitAt);
  const remainingPart = input.slice(clampedSplitAt);

  const completedFirst = safeRemend(firstPart);
  const closedTags = detectClosedTags(firstPart, completedFirst);
  const openingPrefix = buildOpeningPrefix(closedTags, firstPart);

  return {
    completed: completedFirst,
    overflow: remainingPart.length > 0 ? openingPrefix + remainingPart : "",
  };
}

export function completeMarkdown(input: string): string {
  return safeRemend(input);
}
