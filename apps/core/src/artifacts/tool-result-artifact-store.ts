import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createLogger } from "@stanley2058/lilac-utils";

export const TOOL_RESULT_URI_PREFIX = "tool-result://";
export const TOOL_RESULT_UNAVAILABLE_MESSAGE =
  "This transient tool result is no longer available because it expired or was evicted. Re-run the original tool call if the output is still needed.";
// Four-byte Unicode characters still fit within the configured 40 KiB raw preview budget.
export const TOOL_RESULT_MAX_PAGE_CHARACTERS = 10 * 1024;

export type ToolResultArtifactStart =
  | { type: "offset"; offset: number }
  | { type: "line"; line: number; column?: number };

type ArtifactMetadata = {
  id: string;
  storageKey: string;
  sessionId: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  createdAt: number;
  expiresAt: number;
  bytes: number;
};

export type CreateToolResultArtifactParams = {
  sessionId: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  content: string;
  ttlMs: number;
  maxBytesPerSession: number;
};

type CreateToolResultArtifactFileParams = Omit<CreateToolResultArtifactParams, "content"> & {
  sourcePath: string;
};

type CreateToolResultArtifactStreamParams = Omit<CreateToolResultArtifactParams, "content"> & {
  source: Readable;
};

type CreatedToolResultArtifact = {
  id: string;
  uri: string;
  bytes: number;
  sessionBytes: number;
  evicted: number;
  oversized: boolean;
};

export type ToolResultArtifactStore = {
  readonly rootDir: string;
  init(): Promise<void>;
  create(params: CreateToolResultArtifactParams): Promise<CreatedToolResultArtifact>;
  createFromFile(params: CreateToolResultArtifactFileParams): Promise<CreatedToolResultArtifact>;
  createFromStream(
    params: CreateToolResultArtifactStreamParams,
  ): Promise<CreatedToolResultArtifact>;
  read(
    uri: string,
    sessionId: string,
  ): Promise<
    | { ok: true; content: string; id: string; bytes: number; createdAt: number; expiresAt: number }
    | { ok: false }
  >;
  readWindow(
    uri: string,
    sessionId: string,
    options: { start: ToolResultArtifactStart; maxCharacters: number; maxLines: number },
  ): Promise<
    | {
        ok: true;
        content: string;
        id: string;
        bytes: number;
        createdAt: number;
        expiresAt: number;
        startOffset: number;
        endOffset: number;
        totalCharacters: number;
        hasMore: boolean;
        nextStart?: ToolResultArtifactStart;
      }
    | { ok: false }
  >;
};

function isArtifactMetadata(value: unknown): value is ArtifactMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["storageKey"] === "string" &&
    typeof record["sessionId"] === "string" &&
    typeof record["requestId"] === "string" &&
    typeof record["toolCallId"] === "string" &&
    typeof record["toolName"] === "string" &&
    typeof record["createdAt"] === "number" &&
    typeof record["expiresAt"] === "number" &&
    typeof record["bytes"] === "number"
  );
}

function artifactIdFromUri(uri: string): string | null {
  if (!uri.startsWith(TOOL_RESULT_URI_PREFIX)) return null;
  const id = uri.slice(TOOL_RESULT_URI_PREFIX.length);
  return /^[0-9a-f-]{36}$/u.test(id) ? id : null;
}

export function createToolResultArtifactStore(rootDir: string): ToolResultArtifactStore {
  const resolvedRoot = path.resolve(rootDir);
  const logger = createLogger({ module: "tool-result-artifacts" });
  const encryptionKey = randomBytes(32);
  let operationQueue = Promise.resolve();

  function contentPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.bin`);
  }

  function metadataPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.meta`);
  }

  function encrypt(value: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
  }

  function decrypt(value: Buffer): string {
    if (value.length < 28) throw new Error("Invalid encrypted artifact");
    const nonce = value.subarray(0, 12);
    const authTag = value.subarray(value.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(
      "utf8",
    );
  }

  async function readMetadata(storageKey: string): Promise<ArtifactMetadata | null> {
    try {
      const parsed = JSON.parse(decrypt(await fs.readFile(metadataPath(storageKey)))) as unknown;
      return isArtifactMetadata(parsed) && parsed.storageKey === storageKey ? parsed : null;
    } catch {
      return null;
    }
  }

  async function listMetadata(): Promise<ArtifactMetadata[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(resolvedRoot);
    } catch {
      return [];
    }

    const metadata = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".meta"))
        .map(async (entry) => {
          const storageKey = entry.slice(0, -".meta".length);
          const item = await readMetadata(storageKey);
          if (!item) await removeArtifact(storageKey);
          return item;
        }),
    );
    return metadata.filter((item): item is ArtifactMetadata => item !== null);
  }

  async function removeArtifact(storageKey: string): Promise<void> {
    await Promise.all([
      fs.rm(contentPath(storageKey), { force: true }),
      fs.rm(metadataPath(storageKey), { force: true }),
    ]);
  }

  async function cleanupExpired(now: number): Promise<number> {
    const expired = (await listMetadata()).filter((item) => item.expiresAt <= now);
    await Promise.all(expired.map((item) => removeArtifact(item.storageKey)));
    if (expired.length > 0) {
      logger.info("tool.artifact.expired", { count: expired.length });
    }
    return expired.length;
  }

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function writeAtomic(filePath: string, content: Uint8Array): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function writeEncryptedStreamAtomic(filePath: string, source: Readable): Promise<number> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    let bytes = 0;
    const countBytes = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await fs.writeFile(temporaryPath, nonce, { mode: 0o600, flag: "wx" });
      await pipeline(
        source,
        countBytes,
        cipher,
        createWriteStream(temporaryPath, { flags: "a", mode: 0o600 }),
      );
      await fs.appendFile(temporaryPath, cipher.getAuthTag());
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
      return bytes;
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function createArtifact(
    params: Omit<CreateToolResultArtifactParams, "content">,
    writeContent: (filePath: string) => Promise<number>,
  ): Promise<CreatedToolResultArtifact> {
    return exclusive(async () => {
      const now = Date.now();
      await cleanupExpired(now);

      const id = randomUUID();
      const storageKey = randomUUID();
      let bytes: number;
      try {
        bytes = await writeContent(contentPath(storageKey));
      } catch (error) {
        await removeArtifact(storageKey).catch(() => undefined);
        throw error;
      }

      const sessionArtifacts = (await listMetadata())
        .filter((item) => item.sessionId === params.sessionId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      let sessionBytes = sessionArtifacts.reduce((sum, item) => sum + item.bytes, 0);
      let evicted = 0;

      if (bytes > params.maxBytesPerSession) {
        for (const item of sessionArtifacts) {
          await removeArtifact(item.storageKey);
          sessionBytes -= item.bytes;
          evicted += 1;
        }
      } else {
        while (sessionArtifacts.length > 0 && sessionBytes + bytes > params.maxBytesPerSession) {
          const item = sessionArtifacts.shift();
          if (!item) break;
          await removeArtifact(item.storageKey);
          sessionBytes -= item.bytes;
          evicted += 1;
        }
      }

      const metadata: ArtifactMetadata = {
        id,
        storageKey,
        sessionId: params.sessionId,
        requestId: params.requestId,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        createdAt: now,
        expiresAt: now + params.ttlMs,
        bytes,
      };

      try {
        await writeAtomic(metadataPath(storageKey), encrypt(JSON.stringify(metadata)));
      } catch (error) {
        await removeArtifact(storageKey).catch(() => undefined);
        throw error;
      }

      logger.info("tool.artifact.created", {
        toolName: params.toolName,
        bytes,
        sessionBytes: sessionBytes + bytes,
        evicted,
        oversized: bytes > params.maxBytesPerSession,
      });
      if (evicted > 0) logger.info("tool.artifact.evicted", { count: evicted });
      if (bytes > params.maxBytesPerSession) {
        logger.info("tool.artifact.oversized_single", { bytes });
      }

      return {
        id,
        uri: `${TOOL_RESULT_URI_PREFIX}${id}`,
        bytes,
        sessionBytes: sessionBytes + bytes,
        evicted,
        oversized: bytes > params.maxBytesPerSession,
      };
    });
  }

  async function readEncryptedWindow(
    storageKey: string,
    start: ToolResultArtifactStart,
    maxCharacters: number,
    maxLines: number,
  ): Promise<{
    content: string;
    startOffset: number;
    endOffset: number;
    totalCharacters: number;
    endLine: number;
    endColumn: number;
  }> {
    const filePath = contentPath(storageKey);
    const handle = await fs.open(filePath, "r");
    let size: number;
    let nonce: Buffer;
    let authTag: Buffer;
    try {
      size = (await handle.stat()).size;
      if (size < 28) throw new Error("Invalid encrypted artifact");
      nonce = Buffer.alloc(12);
      authTag = Buffer.alloc(16);
      await handle.read(nonce, 0, nonce.length, 0);
      await handle.read(authTag, 0, authTag.length, size - authTag.length);
    } finally {
      await handle.close();
    }

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
    decipher.setAuthTag(authTag);
    const decoder = new StringDecoder("utf8");
    let totalCharacters = 0;
    let line = 1;
    let column = 0;
    let selectedStartOffset: number | undefined;
    let selectedEndOffset: number | undefined;
    let selectedEndLine: number | undefined;
    let selectedEndColumn: number | undefined;
    let selectedLines = 1;
    const selected: string[] = [];
    const consume = (text: string) => {
      for (const character of text) {
        if (selectedStartOffset === undefined) {
          const reachedStart =
            start.type === "offset"
              ? totalCharacters >= start.offset
              : line === start.line && (column >= (start.column ?? 0) || character === "\n");
          if (reachedStart) selectedStartOffset = totalCharacters;
        }
        let selectionEnds = false;
        if (selectedStartOffset !== undefined && selectedEndOffset === undefined) {
          if (character === "\n" && selectedLines >= maxLines) {
            if (start.type === "offset") selected.push(character);
            selectionEnds = true;
          } else {
            selected.push(character);
            if (selected.length >= maxCharacters) {
              selectionEnds = true;
            } else if (character === "\n") {
              selectedLines += 1;
            }
          }
        }
        totalCharacters += 1;
        if (character === "\n") {
          line += 1;
          column = 0;
        } else {
          column += 1;
        }
        if (selectionEnds) {
          selectedEndOffset = totalCharacters;
          selectedEndLine = line;
          selectedEndColumn = column;
        }
      }
    };

    const ciphertextBytes = size - 28;
    if (ciphertextBytes > 0) {
      const decrypted = createReadStream(filePath, { start: 12, end: size - 17 }).pipe(decipher);
      for await (const chunk of decrypted) {
        consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      }
    } else {
      decipher.final();
    }
    consume(decoder.end());
    const startOffset = selectedStartOffset ?? totalCharacters;
    return {
      content: selected.join(""),
      startOffset,
      endOffset: selectedEndOffset ?? totalCharacters,
      totalCharacters,
      endLine: selectedEndLine ?? line,
      endColumn: selectedEndColumn ?? column,
    };
  }

  return {
    rootDir: resolvedRoot,
    async init() {
      await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
      const entries = await fs.readdir(resolvedRoot);
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.endsWith(".bin") ||
              entry.endsWith(".meta") ||
              entry.endsWith(".tmp") ||
              entry.endsWith(".txt") ||
              entry.endsWith(".json"),
          )
          .map(async (entry) => {
            const entryPath = path.join(resolvedRoot, entry);
            const entryStat = await fs.lstat(entryPath).catch(() => null);
            if (entryStat?.isFile() || entryStat?.isSymbolicLink()) {
              await fs.rm(entryPath, { force: true });
            }
          }),
      );
    },
    async create(params) {
      const { content, ...metadata } = params;
      return createArtifact(metadata, async (filePath) => {
        await writeAtomic(filePath, encrypt(content));
        return Buffer.byteLength(content, "utf8");
      });
    },
    async createFromFile(params) {
      const { sourcePath, ...metadata } = params;
      return createArtifact(metadata, (filePath) =>
        writeEncryptedStreamAtomic(filePath, createReadStream(sourcePath)),
      );
    },
    async createFromStream(params) {
      const { source, ...metadata } = params;
      return createArtifact(metadata, (filePath) => writeEncryptedStreamAtomic(filePath, source));
    },
    async read(uri, sessionId) {
      return exclusive(async () => {
        const now = Date.now();
        await cleanupExpired(now);
        const id = artifactIdFromUri(uri);
        if (!id) return { ok: false };
        const metadata = (await listMetadata()).find((item) => item.id === id);
        if (!metadata || metadata.sessionId !== sessionId) return { ok: false };

        try {
          const content = decrypt(await fs.readFile(contentPath(metadata.storageKey)));
          logger.info("tool.artifact.read", { bytes: metadata.bytes });
          return {
            ok: true,
            content,
            id,
            bytes: metadata.bytes,
            createdAt: metadata.createdAt,
            expiresAt: metadata.expiresAt,
          };
        } catch {
          await removeArtifact(metadata.storageKey);
          return { ok: false };
        }
      });
    },
    async readWindow(uri, sessionId, options) {
      return exclusive(async () => {
        const now = Date.now();
        await cleanupExpired(now);
        const id = artifactIdFromUri(uri);
        if (!id) return { ok: false };
        const metadata = (await listMetadata()).find((item) => item.id === id);
        if (!metadata || metadata.sessionId !== sessionId) return { ok: false };

        try {
          const start: ToolResultArtifactStart =
            options.start.type === "offset"
              ? {
                  type: "offset",
                  offset: Number.isFinite(options.start.offset)
                    ? Math.max(0, Math.floor(options.start.offset))
                    : 0,
                }
              : {
                  type: "line",
                  line: Number.isFinite(options.start.line)
                    ? Math.max(1, Math.floor(options.start.line))
                    : 1,
                  column:
                    options.start.column !== undefined && Number.isFinite(options.start.column)
                      ? Math.max(0, Math.floor(options.start.column))
                      : 0,
                };
          const requestedCharacters = Number.isFinite(options.maxCharacters)
            ? Math.floor(options.maxCharacters)
            : TOOL_RESULT_MAX_PAGE_CHARACTERS;
          const maxCharacters = Math.min(
            TOOL_RESULT_MAX_PAGE_CHARACTERS,
            Math.max(1, requestedCharacters),
          );
          const maxLines = Number.isFinite(options.maxLines)
            ? Math.max(1, Math.floor(options.maxLines))
            : 1;
          const window = await readEncryptedWindow(
            metadata.storageKey,
            start,
            maxCharacters,
            maxLines,
          );
          const hasMore = window.endOffset < window.totalCharacters;
          const nextStart = hasMore
            ? start.type === "offset"
              ? ({ type: "offset", offset: window.endOffset } as const)
              : ({ type: "line", line: window.endLine, column: window.endColumn } as const)
            : undefined;
          logger.info("tool.artifact.read", { bytes: metadata.bytes });
          return {
            ok: true,
            content: window.content,
            id,
            bytes: metadata.bytes,
            createdAt: metadata.createdAt,
            expiresAt: metadata.expiresAt,
            startOffset: window.startOffset,
            endOffset: window.endOffset,
            totalCharacters: window.totalCharacters,
            hasMore,
            ...(nextStart ? { nextStart } : {}),
          };
        } catch {
          await removeArtifact(metadata.storageKey);
          return { ok: false };
        }
      });
    },
  };
}
