import type { ModelMessage, ToolContent } from "ai";
import { Result } from "better-result";

import type { ToolResultOutput } from "./tool-result-output-normalizer";

type ContentOutput = Extract<ToolResultOutput, { type: "content" }>;
type ContentItem = ContentOutput["value"][number];

function decodedBase64Bytes(data: string): number {
  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function inlineDataUrl(value: string | URL): { bytes: number; mediaType: string } | undefined {
  const url = String(value);
  if (!url.toLowerCase().startsWith("data:")) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) {
    return { bytes: Buffer.byteLength(url, "utf8"), mediaType: "application/octet-stream" };
  }
  const metadata = url.slice("data:".length, comma);
  const payload = url.slice(comma + 1);
  const mediaType = metadata.split(";", 1)[0] || "text/plain";
  if (metadata.toLowerCase().split(";").includes("base64")) {
    return { bytes: decodedBase64Bytes(payload), mediaType };
  }
  const decoded = Result.try({
    try: () => decodeURIComponent(payload),
    catch: () => undefined,
  });
  const decodedPayload = decoded.match({ ok: (value) => value, err: () => payload });
  return { bytes: Buffer.byteLength(decodedPayload, "utf8"), mediaType };
}

function inlineMedia(
  item: ContentItem,
): { bytes: number; filename?: string; mediaType: string } | undefined {
  if (item.type === "file" && item.data.type === "data") {
    const data = item.data.data;
    const bytes = typeof data === "string" ? decodedBase64Bytes(data) : data.byteLength;
    return {
      bytes,
      ...(item.filename === undefined ? {} : { filename: item.filename }),
      mediaType: item.mediaType,
    };
  }
  if (item.type === "file" && item.data.type === "url") {
    const media = inlineDataUrl(item.data.url);
    if (media === undefined) return undefined;
    return {
      ...media,
      ...(item.filename === undefined ? {} : { filename: item.filename }),
      mediaType: item.mediaType || media.mediaType,
    };
  }
  if (item.type === "file-data") {
    return {
      bytes: decodedBase64Bytes(item.data),
      ...(item.filename === undefined ? {} : { filename: item.filename }),
      mediaType: item.mediaType,
    };
  }
  if (item.type === "image-data") {
    return { bytes: decodedBase64Bytes(item.data), mediaType: item.mediaType };
  }
  if (item.type === "file-url") {
    const media = inlineDataUrl(item.url);
    if (media === undefined) return undefined;
    return { ...media, mediaType: item.mediaType || media.mediaType };
  }
  if (item.type === "image-url") return inlineDataUrl(item.url);
  return undefined;
}

export function boundToolResultMediaForModelView(
  messages: readonly ModelMessage[],
  limits: { maxBytesPerPart: number; maxBytesTotal: number },
): ModelMessage[] {
  let totalBytes = 0;
  const output = [...messages];

  // Walk newest-first so recent reads remain useful when historical media exceeds the total cap.
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    if (message.role !== "tool") continue;

    let nextContent: ToolContent | undefined;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex];
      if (part?.type !== "tool-result" || part.output.type !== "content") continue;

      let nextValue: typeof part.output.value | undefined;
      for (let valueIndex = part.output.value.length - 1; valueIndex >= 0; valueIndex -= 1) {
        const value = part.output.value[valueIndex];
        if (value === undefined) continue;
        const media = inlineMedia(value);
        if (media === undefined) continue;
        if (
          media.bytes <= limits.maxBytesPerPart &&
          totalBytes + media.bytes <= limits.maxBytesTotal
        ) {
          totalBytes += media.bytes;
          continue;
        }

        nextValue ??= [...part.output.value];
        const detail = [media.filename, media.mediaType].filter(Boolean).join(", ");
        nextValue[valueIndex] = {
          type: "text",
          text: `${media.mediaType.startsWith("image/") ? "Image exceeds the inline limit. Resize the image before reading it again." : "File exceeds the inline limit and must be reduced before reading it again."}${detail ? ` (${detail})` : ""}`,
        };
      }

      if (nextValue === undefined) continue;
      nextContent ??= [...message.content];
      nextContent[partIndex] = {
        ...part,
        output: { type: "content", value: nextValue },
      };
    }

    if (nextContent !== undefined) output[messageIndex] = { ...message, content: nextContent };
  }

  return output;
}
