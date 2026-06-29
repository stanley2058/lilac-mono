import type { ModelMessage } from "ai";

import { stripSurfaceMetadataLines } from "../surface-metadata";

function userContentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type !== "text") continue;
    const text = record.text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

export function latestUserText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const text = stripSurfaceMetadataLines(userContentText(message.content)).trim();
    if (text.length > 0) return text;
  }
  return "";
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
