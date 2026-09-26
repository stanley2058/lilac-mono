import { z } from "zod";

const messageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const conversationReferenceSchema = z
  .strictObject({
    surface: z.enum(["native", "discord", "github"]),
    sessionId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^\s?&]+$/u),
    messageId: messageIdSchema.optional(),
    range: z
      .strictObject({
        startMessageId: messageIdSchema,
        endMessageId: messageIdSchema,
      })
      .optional(),
  })
  .refine((target) => !target.messageId || !target.range, {
    message: "A reference selects either a message or a range",
  });
export type ConversationReference = z.infer<typeof conversationReferenceSchema>;

export function referenceHref(target: ConversationReference): string {
  const query = new URLSearchParams({ ref: `${target.surface}:${target.sessionId}` });
  if (target.messageId) query.set("message", target.messageId);
  if (target.range)
    query.set("range", `${target.range.startMessageId}..${target.range.endMessageId}`);
  return `/?${query}`;
}

export function parseReferenceHref(
  href: string,
  origin?: string,
): ConversationReference | undefined {
  const base = origin ?? "https://lilac.invalid";
  if (!URL.canParse(href, base)) return;
  const url = new URL(href, base);
  if (url.origin !== base || url.pathname !== "/" || url.hash) return;
  const ref = url.searchParams.get("ref");
  const separator = ref?.indexOf(":") ?? -1;
  if (!ref || separator < 1) return;
  const range = url.searchParams.get("range")?.split("..");
  if (range && range.length !== 2) return;
  const decoded = conversationReferenceSchema.safeParse({
    ...(range ? { range: { startMessageId: range[0], endMessageId: range[1] } } : {}),
    surface: ref.slice(0, separator),
    sessionId: ref.slice(separator + 1),
    ...(url.searchParams.has("message") ? { messageId: url.searchParams.get("message") } : {}),
  });
  return decoded.success ? decoded.data : undefined;
}

export function referenceKey(target: ConversationReference): string {
  return `${target.surface}:${target.sessionId}`;
}

export function referencedConversations(text: string, origin?: string): ConversationReference[] {
  const refs = new Map<string, ConversationReference>();
  // Code examples must not become agent context, including unfinished fenced blocks.
  let fence: string | undefined;
  const prose = text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1]![0] === fence[0] &&
          marker[1]!.length >= fence.length &&
          !marker[2]!.trim()
        )
          fence = undefined;
        return "";
      }
      if (marker) {
        fence = marker[1];
        return "";
      }
      return /^( {4}|\t)/.test(line) ? "" : line;
    })
    .join("\n")
    .replace(/(`+)[\s\S]*?\1/g, "");
  const add = (href: string) => {
    const target = parseReferenceHref(href.replace(/\\&/g, "&"), origin);
    if (target) refs.set(referenceHref(target), target);
  };
  const withoutMarkdownLinks = prose.replace(
    /\\?\[[^\]\n]*\]\(([^\s)]+)\)/g,
    (link, href: string) => {
      if (!link.startsWith("\\")) add(href);
      return " ";
    },
  );
  for (const match of withoutMarkdownLinks.matchAll(
    /(?:^|[\s<(])((?:https?:\/\/[^\s<>]+|\/\?[^\s<>]+))/g,
  )) {
    add(match[1]!.replace(/[.,;!?)]+$/u, ""));
  }
  return [...refs.values()];
}
