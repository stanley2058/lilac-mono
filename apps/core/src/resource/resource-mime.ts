import { extname } from "node:path";

import { fileTypeFromBuffer } from "file-type";
import { Result, TaggedError, type Result as ResultType } from "better-result";

export const RESOURCE_MIME_PREFIX_MAX_BYTES = 8 * 1024;

export type ResourceClassification =
  | {
      readonly kind: "text";
      readonly mediaType: string;
      readonly encoding: "utf-8";
    }
  | {
      readonly kind: "image";
      readonly mediaType: string;
    }
  | {
      readonly kind: "pdf";
      readonly mediaType: "application/pdf";
    }
  | {
      readonly kind: "binary";
      readonly mediaType?: string;
    };

export type ResourceMimeClassification = ResourceClassification;

export type ResourceMimeClassifierOptions = {
  readonly declaredMediaType?: string;
  readonly filename?: string;
  readonly maxPrefixBytes?: number;
};

export type ResourceMimeClassifier = {
  /** Observe each byte chunk in order. The classifier retains only a bounded prefix. */
  observe(chunk: Uint8Array): void;
  /** Finish UTF-8 validation and resolve the classification. Call this after the final chunk. */
  finish(): Promise<ResourceClassification>;
};

export class ResourceUtf8ValidationError extends TaggedError("ResourceUtf8ValidationError")<{
  readonly reason: "invalid_utf8" | "already_finished";
  readonly message: string;
}> {}

export type Utf8ResourceValidator = {
  observe(chunk: Uint8Array): ResultType<void, ResourceUtf8ValidationError>;
  finish(): ResultType<void, ResourceUtf8ValidationError>;
};

const TEXT_EXTENSIONS: Readonly<Record<string, string>> = {
  ".c": "text/x-c",
  ".cjs": "text/javascript",
  ".conf": "text/plain",
  ".cpp": "text/x-c++",
  ".css": "text/css",
  ".csv": "text/csv",
  ".cts": "text/typescript",
  ".env": "text/plain",
  ".go": "text/x-go",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".htm": "text/html",
  ".html": "text/html",
  ".java": "text/x-java-source",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".jsx": "text/javascript",
  ".log": "text/plain",
  ".lua": "text/x-lua",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".mjs": "text/javascript",
  ".mts": "text/typescript",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rust",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export function hasResourceTextFilenameHint(filename: string | undefined): boolean {
  return filename !== undefined && TEXT_EXTENSIONS[extname(filename).toLowerCase()] !== undefined;
}

function normalizeMediaType(mediaType: string | undefined): string | undefined {
  const normalized = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

export function isResourceTextMediaType(mediaType: string): boolean {
  const normalized = normalizeMediaType(mediaType) ?? "";
  if (normalized.startsWith("text/")) return true;
  if (normalized.endsWith("+json") || normalized.endsWith("+xml")) return true;

  return [
    "application/ecmascript",
    "application/graphql",
    "application/javascript",
    "application/json",
    "application/ld+json",
    "application/sql",
    "application/toml",
    "application/typescript",
    "application/x-httpd-php",
    "application/x-ndjson",
    "application/x-sh",
    "application/x-yaml",
    "application/xml",
    "application/yaml",
    "image/svg+xml",
  ].includes(normalized);
}

function textMediaTypeHint(options: ResourceMimeClassifierOptions): string | undefined {
  const declared = normalizeMediaType(options.declaredMediaType);
  if (declared && isResourceTextMediaType(declared)) return declared;
  if (!options.filename) return undefined;
  return TEXT_EXTENSIONS[extname(options.filename).toLowerCase()];
}

export type InlineMediaKind = "audio" | "video";

// Formats Gemini documents for inline audio and video input.
const INLINE_MEDIA_TYPES: ReadonlyMap<string, InlineMediaKind> = new Map([
  ["audio/aac", "audio"],
  ["audio/aiff", "audio"],
  ["audio/flac", "audio"],
  ["audio/mpeg", "audio"],
  ["audio/ogg", "audio"],
  ["audio/wav", "audio"],
  ["video/3gpp", "video"],
  ["video/mp4", "video"],
  ["video/mpeg", "video"],
  ["video/quicktime", "video"],
  ["video/webm", "video"],
  ["video/x-flv", "video"],
]);

/** The base media type when it is an audio or video format models can take inline. */
export function inlineMediaType(
  mediaType: string | undefined,
): { readonly kind: InlineMediaKind; readonly mediaType: string } | undefined {
  const normalized = normalizeMediaType(mediaType);
  const kind = normalized === undefined ? undefined : INLINE_MEDIA_TYPES.get(normalized);
  return kind && normalized ? { kind, mediaType: normalized } : undefined;
}

function concatenatePrefix(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  const prefix = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    prefix.set(part, offset);
    offset += part.byteLength;
  }
  return prefix;
}

function fallbackSignatureMediaType(prefix: Uint8Array): string | undefined {
  const startsWith = (signature: readonly number[]): boolean =>
    signature.every((byte, index) => prefix[index] === byte);

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    prefix[8] === 0x57 &&
    prefix[9] === 0x45 &&
    prefix[10] === 0x42 &&
    prefix[11] === 0x50
  ) {
    return "image/webp";
  }
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return undefined;
}

async function detectSignatureMediaType(prefix: Uint8Array): Promise<string | undefined> {
  const fallback = fallbackSignatureMediaType(prefix);
  const detected = await Result.tryPromise({
    try: () => fileTypeFromBuffer(prefix),
    catch: () => undefined,
  });
  return detected.match({
    ok: (fileType) => fileType?.mime ?? fallback,
    err: () => fallback,
  });
}

function classificationFromSignature(mediaType: string): ResourceClassification {
  if (mediaType === "application/pdf") return { kind: "pdf", mediaType };
  if (mediaType.startsWith("image/")) return { kind: "image", mediaType };
  return { kind: "binary", mediaType };
}

function invalidUtf8(reason: ResourceUtf8ValidationError["reason"]): ResourceUtf8ValidationError {
  return new ResourceUtf8ValidationError({
    reason,
    message:
      reason === "invalid_utf8"
        ? "Resource text is not valid UTF-8"
        : "Resource UTF-8 validation has already finished",
  });
}

export function createUtf8ResourceValidator(): Utf8ResourceValidator {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let failure: ResourceUtf8ValidationError | undefined;
  let finished = false;

  return {
    observe(chunk) {
      if (failure) return Result.err(failure);
      if (finished) return Result.err(invalidUtf8("already_finished"));

      const decoded = Result.try({
        try: () => decoder.decode(chunk, { stream: true }),
        catch: () => invalidUtf8("invalid_utf8"),
      });
      if (decoded.isErr()) {
        failure = decoded.error;
        return Result.err(failure);
      }
      return Result.ok(undefined);
    },

    finish() {
      if (failure) return Result.err(failure);
      if (finished) return Result.ok(undefined);
      finished = true;

      const decoded = Result.try({
        try: () => decoder.decode(),
        catch: () => invalidUtf8("invalid_utf8"),
      });
      if (decoded.isErr()) {
        failure = decoded.error;
        return Result.err(failure);
      }
      return Result.ok(undefined);
    },
  };
}

export async function classifyResourcePrefix(
  options: ResourceMimeClassifierOptions & { readonly prefix: Uint8Array },
): Promise<ResourceClassification> {
  const maxPrefixBytes = Math.max(
    0,
    Math.floor(options.maxPrefixBytes ?? RESOURCE_MIME_PREFIX_MAX_BYTES),
  );
  const prefix = options.prefix.subarray(0, maxPrefixBytes);
  const signatureMediaType = await detectSignatureMediaType(prefix);
  if (signatureMediaType) return classificationFromSignature(signatureMediaType);
  if (prefix.includes(0)) return { kind: "binary" };

  const textHint = textMediaTypeHint(options);
  if (!textHint) return { kind: "binary" };

  const validator = createUtf8ResourceValidator();
  const validPrefix = validator.observe(prefix);
  return validPrefix.match<ResourceClassification>({
    ok: () => ({ kind: "text", mediaType: textHint, encoding: "utf-8" }),
    err: () => ({ kind: "binary" }),
  });
}

export function createResourceMimeClassifier(
  options: ResourceMimeClassifierOptions = {},
): ResourceMimeClassifier {
  const configuredPrefixBytes = options.maxPrefixBytes ?? RESOURCE_MIME_PREFIX_MAX_BYTES;
  const maxPrefixBytes = Math.max(0, Math.floor(configuredPrefixBytes));
  const prefixParts: Uint8Array[] = [];
  const utf8Validator = createUtf8ResourceValidator();
  let prefixByteLength = 0;
  let utf8Failure: ResourceUtf8ValidationError | undefined;
  let finished = false;

  return {
    observe(chunk) {
      if (finished) return;

      if (!utf8Failure) {
        utf8Failure = utf8Validator.observe(chunk).match({
          ok: () => undefined,
          err: (error) => error,
        });
      }

      const remainingPrefixBytes = maxPrefixBytes - prefixByteLength;
      if (remainingPrefixBytes <= 0 || chunk.byteLength === 0) return;

      const retained = chunk.slice(0, remainingPrefixBytes);
      prefixParts.push(retained);
      prefixByteLength += retained.byteLength;
    },

    async finish() {
      if (!finished) {
        finished = true;
        if (!utf8Failure) {
          utf8Failure = utf8Validator.finish().match({
            ok: () => undefined,
            err: (error) => error,
          });
        }
      }

      const prefix = concatenatePrefix(prefixParts, prefixByteLength);
      const prefixClassification = await classifyResourcePrefix({ ...options, prefix });
      if (prefixClassification.kind !== "text" || !utf8Failure) return prefixClassification;
      return { kind: "binary" };
    },
  };
}

export async function classifyResourceMime(
  options: ResourceMimeClassifierOptions & {
    readonly chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  },
): Promise<ResourceClassification> {
  const classifier = createResourceMimeClassifier(options);
  for await (const chunk of options.chunks) classifier.observe(chunk);
  return classifier.finish();
}
