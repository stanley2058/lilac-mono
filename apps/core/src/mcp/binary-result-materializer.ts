import { captureError } from "../shared/error-capture.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { CallToolResult } from "@ai-sdk/mcp";
import { errorCode } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import type { McpImageCheckpointReference } from "./image-checkpoint";
import type { McpConvertedTool } from "./registry-types";

type McpToModelOutput = NonNullable<McpConvertedTool["toModelOutput"]>;
type McpModelOutput = Awaited<ReturnType<McpToModelOutput>>;

const DEFAULT_ROOT_DIR = "/tmp/lilac-mcp";
const INITIAL_HASH_LENGTH = 6;
const HASH_LENGTH_INCREMENT = 2;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/gzip": "gz",
  "application/json": "json",
  "application/octet-stream": "bin",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "audio/flac": "flac",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

type CapturedEffect<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "failure"; readonly cause: Error };

type ClaimedDirectory =
  | { readonly kind: "success"; readonly directory: string }
  | { readonly kind: "failure"; readonly cause: Error };

type BinaryContent = {
  readonly outputIndex: number;
  readonly data: string;
  readonly mediaType: string;
  readonly source: "image" | "resource";
};

type MaterializedBinary = {
  readonly bytes: number;
  readonly localPath: string;
  readonly mediaType: string;
  readonly source: BinaryContent["source"];
};

export type McpBinaryResultMaterializer = {
  project(params: {
    readonly modelOutput: McpModelOutput;
    readonly output: CallToolResult;
    readonly toolCallId: string;
  }): Promise<McpModelOutput>;
};

export type McpBinaryResultMaterializerOptions = {
  readonly requestId: string;
  readonly onImageMaterialized?: (reference: McpImageCheckpointReference) => void;
  readonly rootDir?: string;
  readonly hashId?: (domain: "request" | "call", id: string) => string;
};

async function captureEffect<T>(operation: () => Promise<T>): Promise<CapturedEffect<T>> {
  const captured = await Result.tryPromise({
    try: operation,
    catch: captureError,
  });
  return captured.match<CapturedEffect<T>>({
    ok: (value) => ({ kind: "success", value }),
    err: ({ cause }) => ({ kind: "failure", cause }),
  });
}

function defaultHashId(domain: "request" | "call", id: string): string {
  return createHash("sha256").update(`${domain}:${id}`).digest("hex");
}

function extensionFor(mediaType: string): string {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MEDIA_TYPE_EXTENSIONS[normalized] ?? "bin";
}

function binaryContent(output: CallToolResult): BinaryContent[] {
  if (!("content" in output) || !Array.isArray(output.content)) return [];
  return output.content.flatMap((part, outputIndex): BinaryContent[] => {
    if (part.type === "image") {
      return [{ outputIndex, data: part.data, mediaType: part.mimeType, source: "image" }];
    }
    if (part.type === "resource") {
      const blob = part.resource.blob;
      if (typeof blob !== "string") return [];
      return [
        {
          outputIndex,
          data: blob,
          mediaType: part.resource.mimeType ?? "application/octet-stream",
          source: "resource",
        },
      ];
    }
    return [];
  });
}

async function ensureOwnedRoot(rootDir: string): Promise<ClaimedDirectory> {
  const created = await captureEffect(() => fs.mkdir(rootDir, { mode: DIRECTORY_MODE }));
  if (created.kind === "success") return { kind: "success", directory: rootDir };
  if (errorCode(created.cause) !== "EEXIST") return created;

  const inspected = await captureEffect(() => fs.lstat(rootDir));
  if (inspected.kind === "failure") return inspected;
  if (!inspected.value.isDirectory()) {
    return {
      kind: "failure",
      cause: new Error("MCP binary materialization root is not a directory"),
    };
  }
  if (typeof process.getuid === "function" && inspected.value.uid !== process.getuid()) {
    return {
      kind: "failure",
      cause: new Error("MCP binary materialization root is owned by another user"),
    };
  }

  const restricted = await captureEffect(() => fs.chmod(rootDir, DIRECTORY_MODE));
  return restricted.kind === "success" ? { kind: "success", directory: rootDir } : restricted;
}

async function claimHashedDirectory(params: {
  readonly digest: string;
  readonly label: "req" | "call";
  readonly parent: string;
}): Promise<ClaimedDirectory> {
  for (
    let length = INITIAL_HASH_LENGTH;
    length <= params.digest.length;
    length += HASH_LENGTH_INCREMENT
  ) {
    const candidate = path.join(params.parent, `${params.label}-${params.digest.slice(0, length)}`);
    const claimed = await captureEffect(() => fs.mkdir(candidate, { mode: DIRECTORY_MODE }));
    if (claimed.kind === "success") return { kind: "success", directory: candidate };
    if (errorCode(claimed.cause) !== "EEXIST") return claimed;
  }

  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = path.join(params.parent, `${params.label}-${params.digest}-${suffix}`);
    const claimed = await captureEffect(() => fs.mkdir(candidate, { mode: DIRECTORY_MODE }));
    if (claimed.kind === "success") return { kind: "success", directory: candidate };
    if (errorCode(claimed.cause) !== "EEXIST") return claimed;
  }

  return {
    kind: "failure",
    cause: new Error("Unable to claim an MCP binary materialization directory"),
  };
}

async function writeBinaryFile(params: {
  readonly content: Buffer;
  readonly directory: string;
  readonly extension: string;
  readonly index: number;
}): Promise<CapturedEffect<string>> {
  for (let suffix = 0; suffix <= 10_000; suffix += 1) {
    const basename = suffix === 0 ? `${params.index}` : `${params.index}-${suffix}`;
    const filePath = path.join(params.directory, `${basename}.${params.extension}`);
    const written = await captureEffect(() =>
      fs.writeFile(filePath, params.content, { flag: "wx", mode: FILE_MODE }),
    );
    if (written.kind === "success") return { kind: "success", value: filePath };
    if (errorCode(written.cause) !== "EEXIST") return written;
  }
  return {
    kind: "failure",
    cause: new Error("Unable to claim an MCP binary materialization file"),
  };
}

function appendMaterializationNotice(
  modelOutput: McpModelOutput,
  files: readonly MaterializedBinary[],
  failed: number,
): McpModelOutput {
  if (modelOutput.type !== "content") return modelOutput;
  const notice = {
    mcpBinaryFiles: files,
    ...(failed === 0 ? {} : { materializationFailures: failed }),
  };
  return {
    ...modelOutput,
    value: [
      ...modelOutput.value,
      {
        type: "text",
        text: `Local MCP binary materializations:\n${JSON.stringify(notice, null, 2)}`,
      },
    ],
  };
}

export function createMcpBinaryResultMaterializer(
  options: McpBinaryResultMaterializerOptions,
): McpBinaryResultMaterializer {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  const hashId = options.hashId ?? defaultHashId;
  let requestDirectory: Promise<ClaimedDirectory> | undefined;
  const callDirectories = new Map<string, Promise<ClaimedDirectory>>();

  const getRequestDirectory = (): Promise<ClaimedDirectory> => {
    requestDirectory ??= (async () => {
      const root = await ensureOwnedRoot(rootDir);
      if (root.kind === "failure") return root;
      return claimHashedDirectory({
        digest: hashId("request", options.requestId),
        label: "req",
        parent: root.directory,
      });
    })();
    return requestDirectory;
  };

  const getCallDirectory = (toolCallId: string): Promise<ClaimedDirectory> => {
    const existing = callDirectories.get(toolCallId);
    if (existing) return existing;
    const claimed = (async () => {
      const request = await getRequestDirectory();
      if (request.kind === "failure") return request;
      return claimHashedDirectory({
        digest: hashId("call", toolCallId),
        label: "call",
        parent: request.directory,
      });
    })();
    callDirectories.set(toolCallId, claimed);
    return claimed;
  };

  return {
    async project({ modelOutput, output, toolCallId }) {
      const binary = binaryContent(output);
      if (binary.length === 0) return modelOutput;

      const call = await getCallDirectory(toolCallId);
      if (call.kind === "failure") {
        return appendMaterializationNotice(modelOutput, [], binary.length);
      }

      const files: MaterializedBinary[] = [];
      let failed = 0;
      for (const [index, item] of binary.entries()) {
        const content = Buffer.from(item.data, "base64");
        const written = await writeBinaryFile({
          content,
          directory: call.directory,
          extension: extensionFor(item.mediaType),
          index,
        });
        if (written.kind === "failure") {
          failed += 1;
          continue;
        }
        const modelPart =
          modelOutput.type === "content" ? modelOutput.value[item.outputIndex] : undefined;
        if (
          item.source === "image" &&
          modelPart?.type === "file" &&
          modelPart.data.type === "data" &&
          modelPart.data.data === item.data &&
          modelPart.mediaType === item.mediaType
        ) {
          options.onImageMaterialized?.({
            toolCallId,
            outputIndex: item.outputIndex,
            localPath: written.value,
            mediaType: item.mediaType,
            byteLength: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
            ...(modelPart.filename === undefined ? {} : { filename: modelPart.filename }),
          });
        }
        files.push({
          bytes: content.byteLength,
          localPath: written.value,
          mediaType: item.mediaType,
          source: item.source,
        });
      }
      return appendMaterializationNotice(modelOutput, files, failed);
    },
  };
}

export function wrapMcpToolWithBinaryMaterialization(
  tool: McpConvertedTool,
  materializer: McpBinaryResultMaterializer,
): McpConvertedTool {
  const toModelOutput = tool.toModelOutput;
  if (!toModelOutput) return tool;
  return {
    ...tool,
    toModelOutput: async (options) => {
      const modelOutput = await toModelOutput(options);
      return materializer.project({
        modelOutput,
        output: options.output,
        toolCallId: options.toolCallId,
      });
    },
  };
}
