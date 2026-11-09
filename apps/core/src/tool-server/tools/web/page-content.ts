import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

export type PageFormat = "markdown" | "text" | "html";
export type PagePreprocessor = "none" | "readability";

export type PageAcquisitionInput = {
  url: string;
  format?: PageFormat;
  preprocessor?: PagePreprocessor;
  startOffset?: number;
  maxCharacters?: number;
  timeout?: number;
};

export type ParsedPageContent = {
  url: string;
  title: string;
  markdown: string;
  text: string;
  raw: string;
};

export type PageContentSuccess = {
  isError: false;
  content: ParsedPageContent;
  sourceTruncated?: boolean;
  rawHtml?: string;
};

export type PageContentError = {
  isError: true;
  error: string;
  aborted?: true;
  status?: number;
  contentType?: string | null;
  contentLength?: number | null;
};

export type PageContentResult = PageContentSuccess | PageContentError;

const MIN_EXTRACT_USEFUL_CHARACTERS = 200;
const STRONG_EXTRACT_CHARACTERS = 600;
const WEAK_CONTENT_PATTERNS = [
  /enable javascript/i,
  /javascript (is )?required/i,
  /please wait/i,
  /loading/i,
  /sign in/i,
  /log in/i,
  /cookie/i,
  /privacy policy/i,
  /terms of service/i,
] as const;
const SPA_SHELL_MARKERS = [
  "__next",
  "__nuxt",
  "data-reactroot",
  'id="root"',
  'id="app"',
  "webpack",
  "hydration",
] as const;

function createAbortError(message = "request aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function getAbortReasonError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return createAbortError(reason);
  return createAbortError();
}

export function checkPageSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw getAbortReasonError(signal);
}

export function normalizePageWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildTextContent(input: {
  url: string;
  title?: string | null;
  text: string;
  markdown?: string;
  raw?: string;
}): ParsedPageContent {
  const text = input.text.trim();
  const markdown = input.markdown ?? text;
  return {
    url: input.url,
    title: input.title?.trim() || input.url,
    markdown,
    text,
    raw: input.raw ?? markdown,
  };
}

function extractTitleFromHtml(html: string, url: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title && title.length > 0 ? title : url;
}

export function simpleHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function markdownToText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSimpleHtmlContent(html: string, url: string): ParsedPageContent {
  const text = simpleHtmlToText(html);
  return {
    url,
    title: extractTitleFromHtml(html, url),
    markdown: text,
    text,
    raw: html,
  };
}

function countUniqueWords(text: string): number {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).size;
}

function countSubstantiveParagraphs(markdown: string): number {
  return markdown
    .split(/\n{2,}/)
    .map((paragraph) => normalizePageWhitespace(paragraph.replace(/[#>*`\-_[\]()]/g, " ")))
    .filter((paragraph) => paragraph.length >= 80).length;
}

export function assessPageContent(params: { content: ParsedPageContent; rawHtml?: string }): {
  isWeak: boolean;
  reasons: readonly string[];
} {
  const text = normalizePageWhitespace(params.content.text);
  const uniqueWordCount = countUniqueWords(text);
  const paragraphCount = countSubstantiveParagraphs(params.content.markdown);
  const boilerplateHits = WEAK_CONTENT_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const normalizedHtml = params.rawHtml?.toLowerCase() ?? "";
  const hasSpaShell = SPA_SHELL_MARKERS.some((marker) => normalizedHtml.includes(marker));
  const reasons: string[] = [];

  if (text.length === 0) reasons.push("empty text");
  if (text.length < MIN_EXTRACT_USEFUL_CHARACTERS) reasons.push("too short");
  if (uniqueWordCount < 40) reasons.push("low vocabulary");
  if (paragraphCount === 0) reasons.push("no substantive paragraphs");
  if (boilerplateHits > 0) reasons.push("boilerplate text");
  if (hasSpaShell && text.length < STRONG_EXTRACT_CHARACTERS) reasons.push("spa shell");
  if (text.length > 0 && normalizePageWhitespace(params.content.title) === text) {
    reasons.push("title only");
  }

  const suspicious = boilerplateHits > 0 || hasSpaShell || paragraphCount === 0;
  const isWeak =
    text.length === 0 ||
    text.length < 120 ||
    (text.length < MIN_EXTRACT_USEFUL_CHARACTERS && suspicious) ||
    (text.length < STRONG_EXTRACT_CHARACTERS && reasons.length >= 3);

  return { isWeak, reasons };
}

export function slicePageContent(params: {
  content: ParsedPageContent;
  format: PageFormat;
  startOffset: number;
  maxCharacters: number;
  sourceTruncated?: boolean;
}) {
  const value = params.content[params.format === "html" ? "raw" : params.format];
  return {
    isError: false,
    title: params.content.title,
    content: value.slice(params.startOffset, params.startOffset + params.maxCharacters),
    length: value.length,
    rearTruncated: value.length > params.startOffset + params.maxCharacters,
    sourceTruncated: params.sourceTruncated ?? false,
  } as const;
}

export class PageContent {
  private readonly turndown = new TurndownService();

  parse(
    html: string,
    url: string,
    params: { preprocessor: PagePreprocessor; signal?: AbortSignal },
  ): ParsedPageContent {
    checkPageSignal(params.signal);
    // Loaded on first parse: jsdom costs about 40 MiB of RSS, and this method is synchronous.
    const { JSDOM }: typeof import("jsdom") = require("jsdom");
    const dom = new JSDOM(html, { url });

    if (params.preprocessor === "readability") {
      checkPageSignal(params.signal);
      const article = new Readability(dom.window.document).parse();
      if (article) {
        return {
          url,
          title: article.title || dom.window.document.title || url,
          markdown: this.turndown.turndown(article.content || ""),
          text: article.textContent ?? "",
          raw: article.content ?? "",
        };
      }
    }

    checkPageSignal(params.signal);
    const body = dom.window.document.body?.innerHTML ?? "";
    return {
      url,
      title: dom.window.document.title || url,
      markdown: this.turndown.turndown(body),
      text: dom.window.document.body?.textContent ?? "",
      raw: body,
    };
  }
}
