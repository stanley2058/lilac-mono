import { describe, expect, it } from "bun:test";

import {
  isMarkedGithubAgentComment,
  markGithubAgentComment,
} from "../../src/github/github-comment-marker";
import { parseIssueCommentTrigger } from "../../src/github/webhook/github-webhook-server";

const BOT_LOGINS = ["catalinna-df[bot]", "DF-wu"] as const;

describe("github issue comment trigger parsing", () => {
  it("parses a leading /lilac command and preserves following lines", () => {
    const parsed = parseIssueCommentTrigger(
      "/lilac inspect this\n\nKeep the stack trace in the reply.",
      BOT_LOGINS,
    );

    expect(parsed).toBe("inspect this\nKeep the stack trace in the reply.");
  });

  it("parses a leading mention command and strips only the trigger mention", () => {
    const parsed = parseIssueCommentTrigger(
      "@catalinna-df[bot] please review\n\nFocus on the webhook path.",
      BOT_LOGINS,
    );

    expect(parsed).toBe("please review\nFocus on the webhook path.");
  });

  it("parses a leading mention command followed by punctuation", () => {
    expect(parseIssueCommentTrigger("@catalinna-df[bot], please review", BOT_LOGINS)).toBe(
      "please review",
    );
    expect(parseIssueCommentTrigger("@DF-wu: please inspect", BOT_LOGINS)).toBe("please inspect");
  });

  it("ignores quoted lines before evaluating the first real trigger line", () => {
    const parsed = parseIssueCommentTrigger(
      "> @catalinna-df[bot] old trigger\n> /lilac old trigger\n\n@catalinna-df[bot] new trigger",
      BOT_LOGINS,
    );

    expect(parsed).toBe("new trigger");
  });

  it("does not trigger on fenced code that contains bot mentions or /lilac", () => {
    const parsed = parseIssueCommentTrigger(
      [
        "In reply to 4152921803:",
        "",
        "```md",
        "@catalinna-df[bot] hi",
        "/lilac inspect this issue",
        "```",
      ].join("\n"),
      BOT_LOGINS,
    );

    expect(parsed).toBeNull();
  });

  it("does not trigger on tilde fenced code that contains bot mentions or /lilac", () => {
    const parsed = parseIssueCommentTrigger(
      [
        "~~~md",
        "@catalinna-df[bot] hi",
        "/lilac inspect this issue",
        "~~~",
        "",
        "@catalinna-df[bot] real trigger",
      ].join("\n"),
      BOT_LOGINS,
    );

    expect(parsed).toBe("real trigger");
  });

  it("does not trigger when a later line mentions the bot after normal prose", () => {
    const parsed = parseIssueCommentTrigger(
      "I am summarizing the previous attempt.\n\n@catalinna-df[bot] this should not retrigger.",
      BOT_LOGINS,
    );

    expect(parsed).toBeNull();
  });
});

describe("github agent comment marker", () => {
  it("marks outbound GitHub comments with a hidden marker", () => {
    const marked = markGithubAgentComment("hello");

    expect(marked).toBe("<!-- lilac:agent-comment -->\nhello");
    expect(isMarkedGithubAgentComment(marked)).toBe(true);
  });

  it("prepends a marker when marker-like text is not on its own content line", () => {
    const marked = markGithubAgentComment("<!-- lilac:agent-comment --> hello");

    expect(marked).toBe("<!-- lilac:agent-comment -->\n<!-- lilac:agent-comment --> hello");
    expect(isMarkedGithubAgentComment(marked)).toBe(true);
  });

  it("does not treat normal comments as marked agent comments", () => {
    expect(isMarkedGithubAgentComment("/lilac hello")).toBe(false);
  });
});
