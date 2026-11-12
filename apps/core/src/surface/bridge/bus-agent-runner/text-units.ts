import { isGeneratedMessage } from "@stanley2058/lilac-agent";
import type { ModelMessage, UserContent } from "ai";

import { stripSurfaceMetadataLines } from "../surface-metadata";

export function latestUserText(messages: readonly ModelMessage[]): string {
  return latestUserInput(messages).text;
}

export type LatestUserInput = {
  text: string;
  authoredText: string;
  content: UserContent;
  hasAttachment: boolean;
};

export function latestUserInput(messages: readonly ModelMessage[]): LatestUserInput {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user" || isGeneratedMessage(message)) continue;
    if (typeof message.content === "string") {
      const text = stripSurfaceMetadataLines(message.content).trim();
      return { text, authoredText: text, content: text, hasAttachment: false };
    }
    const content: Exclude<UserContent, string> = [];
    const textParts: string[] = [];
    const authoredParts: string[] = [];
    let hasAttachment = false;
    for (const part of message.content) {
      if (part.type === "text") {
        const text = stripSurfaceMetadataLines(part.text).trim();
        if (!text) continue;
        content.push({ ...part, text });
        textParts.push(text);
        // Transcripts written before the marker was renamed still use the Discord prefix.
        if (text.startsWith("[attachment ") || text.startsWith("[discord_attachment "))
          hasAttachment = true;
        else authoredParts.push(text);
        continue;
      }
      if (part.type === "file" || part.type === "image") hasAttachment = true;
      content.push(part);
    }
    return {
      text: textParts.join("\n"),
      authoredText: authoredParts.join("\n"),
      content,
      hasAttachment,
    };
  }
  return { text: "", authoredText: "", content: "", hasAttachment: false };
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/giu;
const DISCORD_TOKEN_RE = /<(?:(?:a?:\w+:\d+)|(?:[@#]&?\d+)|(?:t:\d+(?::[tTdDfFR])?))>/gu;
const CODE_BLOCK_RE = /```[\s\S]*?```/gu;
const INLINE_CODE_RE = /`[^`]*`/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const CODE_TEXT_UNITS_CAP = 20;

function countMeaningfulTextUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    if (!WORD_CHAR_RE.test(char)) continue;
    units += CJK_RE.test(char) ? 2 : 1;
  }
  return units;
}

export function measureMeaningfulTextUnits(raw: string): number {
  let text = raw.normalize("NFKC");
  text = text.replace(URL_RE, " ");
  text = text.replace(DISCORD_TOKEN_RE, " ");

  let codeUnits = 0;
  text = text.replace(CODE_BLOCK_RE, (match) => {
    codeUnits += countMeaningfulTextUnits(match) * 0.2;
    return " ";
  });
  text = text.replace(INLINE_CODE_RE, (match) => {
    codeUnits += countMeaningfulTextUnits(match) * 0.3;
    return " ";
  });

  return countMeaningfulTextUnits(text) + Math.min(codeUnits, CODE_TEXT_UNITS_CAP);
}

export function shouldRunAutoInjectedThreadSearch(input: {
  text: string;
  minTextUnits: number;
}): boolean {
  return measureMeaningfulTextUnits(input.text) >= input.minTextUnits;
}

export function decisionAutoInjectContext(
  message: string,
  previousMessages: readonly ModelMessage[],
): string {
  return autoInjectPlannerContext(message.slice(0, 4000), previousMessages);
}

export function autoInjectPlannerContext(
  message: string,
  previousMessages: readonly ModelMessage[],
): string {
  const recent = previousMessages
    .filter((item) => item.role === "user" && !isGeneratedMessage(item))
    .slice(-3)
    .map((item) => latestUserInput([item]).authoredText.slice(-800))
    .filter(Boolean);
  if (recent.length === 0) return message;
  return `Recent user messages, oldest first:\n${recent.join("\n")}\nCurrent message:\n${message}`;
}
