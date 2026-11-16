import { captureError } from "../shared/error-capture.js";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { errorCode } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";

const CORE_DEAD_LETTER_KEY_BYTES = 32;
const CORE_DEAD_LETTER_KEY_FILE = "event-dead-letter.key";

export type CoreDeadLetterKeyOperation =
  | "prepare-directory"
  | "read-key"
  | "generate-key"
  | "open-temporary-key"
  | "write-temporary-key"
  | "publish-key"
  | "remove-temporary-key";

export class CoreDeadLetterKeyAccessFailed extends TaggedError("CoreDeadLetterKeyAccessFailed")<{
  readonly operation: CoreDeadLetterKeyOperation;
  readonly keyPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreDeadLetterKeyCleanupFailed extends TaggedError("CoreDeadLetterKeyCleanupFailed")<{
  readonly keyPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreDeadLetterKeyAccessAndCleanupFailed extends TaggedError(
  "CoreDeadLetterKeyAccessAndCleanupFailed",
)<{
  readonly access: CoreDeadLetterKeyAccessFailed;
  readonly cleanup: CoreDeadLetterKeyCleanupFailed;
  readonly message: string;
}> {}

export type CoreDeadLetterKeyError =
  | CoreDeadLetterKeyAccessFailed
  | CoreDeadLetterKeyCleanupFailed
  | CoreDeadLetterKeyAccessAndCleanupFailed;

export function resolveCoreDeadLetterKeyPath(dataDir: string): string {
  return path.join(dataDir, "secret", CORE_DEAD_LETTER_KEY_FILE);
}

export async function readCoreDeadLetterKey(keyPath: string): Promise<Uint8Array> {
  const handle = await fs.open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let outcome!:
    | { readonly status: "ok"; readonly key: Uint8Array }
    | { readonly status: "error"; readonly cause: Error };
  {
    const captured = await Result.tryPromise({
      try: async () => {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new Error("Core dead-letter key path is not a regular file");
        const key = await handle.readFile();
        if (key.byteLength !== CORE_DEAD_LETTER_KEY_BYTES) {
          throw new Error(`Core dead-letter key must contain ${CORE_DEAD_LETTER_KEY_BYTES} bytes`);
        }
        await handle.chmod(0o600);
        outcome = { status: "ok", key: Buffer.from(key) };
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      outcome = { status: "error", cause };
    }
  }
  let closeCause: Error | undefined;
  {
    const captured = await Result.tryPromise({
      try: async () => {
        await handle.close();
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      closeCause = cause;
    }
  }
  if (outcome.status === "error") {
    if (Panic.is(outcome.cause) || closeCause === undefined) {
      preserveToolPanic(outcome.cause);
      return adaptToolResultToHost(Result.err(outcome.cause));
    }
    preserveToolPanic(closeCause);
    return adaptToolResultToHost(Result.err(closeCause));
  }
  if (closeCause !== undefined) {
    preserveToolPanic(closeCause);
    return adaptToolResultToHost(Result.err(closeCause));
  }
  return outcome.key;
}

/** Loads the persistent key, or publishes one new candidate with a no-replace hard link. */
export async function loadOrCreateCoreDeadLetterKey(options: {
  readonly dataDir: string;
}): Promise<ResultType<Uint8Array, CoreDeadLetterKeyError>> {
  const keyPath = resolveCoreDeadLetterKeyPath(options.dataDir);
  const directory = path.dirname(keyPath);
  let operation: CoreDeadLetterKeyOperation = "prepare-directory";
  let temporaryPath: string | null = null;
  let temporaryHandle: FileHandle | null = null;

  {
    const captured = await Result.tryPromise({
      try: async () => {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.chmod(directory, 0o700);

        operation = "read-key";
        {
          const readKey = await Result.tryPromise({
            try: async () => {
              return {
                status: "return",
                value: Result.ok(await readCoreDeadLetterKey(keyPath)),
              } as const;
            },
            catch: captureError,
          });
          if (readKey.isErr()) {
            const cause = readKey.error.cause;
            if (errorCode(cause) !== "ENOENT") throw cause;
          } else if (readKey.value.status === "return") {
            return readKey.value.value;
          }
        }

        operation = "generate-key";
        const candidate = randomBytes(CORE_DEAD_LETTER_KEY_BYTES);
        temporaryPath = path.join(directory, `.${CORE_DEAD_LETTER_KEY_FILE}.${randomUUID()}.tmp`);

        operation = "open-temporary-key";
        temporaryHandle = await fs.open(temporaryPath, "wx", 0o600);
        operation = "write-temporary-key";
        await temporaryHandle.writeFile(candidate);
        await temporaryHandle.chmod(0o600);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = null;

        operation = "publish-key";
        {
          const captured = await Result.tryPromise({
            try: async () => {
              await fs.link(temporaryPath!, keyPath);
            },
            catch: captureError,
          });

          if (captured.isErr()) {
            const cause = captured.error.cause;
            if (errorCode(cause) !== "EEXIST") throw cause;
          }
        }

        operation = "remove-temporary-key";
        await fs.rm(temporaryPath);
        temporaryPath = null;

        operation = "read-key";
        return Result.ok(await readCoreDeadLetterKey(keyPath));
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      let cleanupCause: unknown;
      if (temporaryHandle) {
        const captured = await Result.tryPromise({
          try: async () => {
            await temporaryHandle!.close();
          },
          catch: captureError,
        });

        if (captured.isErr()) {
          const closeCause = captured.error.cause;
          cleanupCause = closeCause;
        }
      }
      if (temporaryPath) {
        const captured = await Result.tryPromise({
          try: async () => {
            await fs.rm(temporaryPath!, { force: true });
          },
          catch: captureError,
        });

        if (captured.isErr()) {
          const removeCause = captured.error.cause;
          cleanupCause ??= removeCause;
        }
      }

      if (Panic.is(cause)) preserveToolPanic(cause);
      if (cleanupCause !== undefined && Panic.is(cleanupCause)) preserveToolPanic(cleanupCause);
      const access = new CoreDeadLetterKeyAccessFailed({
        operation,
        keyPath,
        cause,
        message: `Core dead-letter key access failed during ${operation}`,
      });
      if (cleanupCause === undefined) return Result.err(access);
      const cleanup = new CoreDeadLetterKeyCleanupFailed({
        keyPath,
        cause: cleanupCause,
        message: "Core dead-letter temporary key cleanup failed",
      });
      return Result.err(
        new CoreDeadLetterKeyAccessAndCleanupFailed({
          access,
          cleanup,
          message: `${access.message}; cleanup also failed`,
        }),
      );
    }
    return captured.value;
  }
}
