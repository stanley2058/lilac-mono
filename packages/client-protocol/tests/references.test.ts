import { expect, test } from "bun:test";
import { referenceHref, parseReferenceHref, referencedConversations } from "../src/references";

test("reference URLs preserve exact session and message coordinates", () => {
  for (const target of [
    { surface: "native" as const, sessionId: "uuid-with-hyphens" },
    {
      surface: "discord" as const,
      sessionId: "123456789012345678",
      messageId: "987654321098765432",
    },
    { surface: "github" as const, sessionId: "owner/repo#45", messageId: "99" },
  ]) {
    const href = referenceHref(target);
    expect(parseReferenceHref(href)).toEqual(target);
    expect(parseReferenceHref(`https://chat.example${href}`, "https://chat.example")).toEqual(
      target,
    );
    expect(
      parseReferenceHref(`https://other.example${href}`, "https://chat.example"),
    ).toBeUndefined();
  }
  expect(parseReferenceHref("/?ref=unknown:123")).toBeUndefined();
  expect(parseReferenceHref("/?ref=native:")).toBeUndefined();
  expect(parseReferenceHref("/?ref=discord:123&message=../foo")).toBeUndefined();
});

test("agent references exclude code and deduplicate repeated targets", () => {
  const target = { surface: "native" as const, sessionId: "thread" };
  const link = `[thread](${referenceHref(target)})`;
  expect(
    referencedConversations(
      `${link} ${link}\n\`[code](/?ref=native%3Aother)\`\n\`\`\`md\n[code](/?ref=native%3Ahidden)\n\`\`\``,
    ),
  ).toEqual([target]);
});

test("unfinished fences, indented code and escaped link examples do not expand", () => {
  for (const text of [
    "```md\n[example](/?ref=native%3Ahidden)",
    "    [example](/?ref=native%3Ahidden)",
    "\\[example](/?ref=native%3Ahidden)",
  ])
    expect(referencedConversations(text)).toEqual([]);
});

test("agent references accept same-origin pasted URLs, autolinks and Markdown links", () => {
  const target = { surface: "native" as const, sessionId: "thread", messageId: "message" };
  const href = referenceHref(target);
  const absolute = `https://chat.example${href}`;
  expect(
    referencedConversations(
      `${absolute}. <${absolute}> [thread](${absolute}) ${href}`,
      "https://chat.example",
    ),
  ).toEqual([target]);
  expect(referencedConversations(`https://other.example${href}`, "https://chat.example")).toEqual(
    [],
  );
  expect(referencedConversations(absolute)).toEqual([]);
  expect(
    referencedConversations(
      "https://chat.example/?message=message&ref=native%3Athread",
      "https://chat.example",
    ),
  ).toEqual([target]);
});

test("absolute references preserve code exclusion and reject malformed targets", () => {
  const url = "https://chat.example/?ref=native%3Athread";
  for (const text of [
    `\`${url}\``,
    `\`\`\`\n${url}\n\`\`\``,
    `    ${url}`,
    `\\[example](${url})`,
    `${url}#fragment`,
    `${url}&message=`,
    "https://chat.example/other?ref=native%3Athread",
  ])
    expect(referencedConversations(text, "https://chat.example")).toEqual([]);
  expect(
    referencedConversations(
      "[issue](https://chat.example/?ref=github%3Aowner%2Frepo%2345&message=99)",
      "https://chat.example",
    ),
  ).toEqual([{ surface: "github", sessionId: "owner/repo#45", messageId: "99" }]);
});

test("range links round trip without changing session or message link semantics", () => {
  const target = {
    surface: "discord" as const,
    sessionId: "123",
    range: { startMessageId: "xm_start_0", endMessageId: "xm_end_0" },
  };
  expect(parseReferenceHref(referenceHref(target))).toEqual(target);
  expect(referencedConversations(`[thread](${referenceHref(target)})`)).toEqual([target]);
  for (const suffix of ["a", "a..", "..b", "a..b..c", "a..b&message=c", "a%20b..c"])
    expect(parseReferenceHref(`/?ref=discord:123&range=${suffix}`)).toBeUndefined();
});
