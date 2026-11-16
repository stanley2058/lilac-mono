import { captureError } from "../shared/error-capture.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  createEmptyMcpConfig,
  MCP_CONFIG_FILE_NAME,
  type McpServerDefinition,
  type UniversalMcpConfig,
} from "./config-types";
import { mcpServerIdSchema, parseMcpConfigYaml, serializeMcpConfigYaml } from "./config";
import { opaqueErrorMessage, rethrowPanic } from "./error-format";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";

const errorCodeSchema = z.object({ code: z.string() });
const mutationQueues = new Map<string, Promise<void>>();

type McpConfigFileOperation =
  | "create_parent"
  | "open_temporary"
  | "write_temporary"
  | "sync_temporary"
  | "close_temporary"
  | "rename_temporary"
  | "remove_temporary";

type McpConfigFileHandle = Pick<
  Awaited<ReturnType<typeof fs.open>>,
  "writeFile" | "sync" | "close"
>;

export type McpConfigFileDependencies = {
  readonly mkdir: typeof fs.mkdir;
  readonly open: (filePath: string, flags: string, mode: number) => Promise<McpConfigFileHandle>;
  readonly rename: typeof fs.rename;
  readonly rm: typeof fs.rm;
  readonly randomUUID: () => string;
};

const DEFAULT_FILE_DEPENDENCIES: McpConfigFileDependencies = {
  mkdir: fs.mkdir,
  open: fs.open,
  rename: fs.rename,
  rm: fs.rm,
  randomUUID,
};

export class McpConfigError extends TaggedError("McpConfigError")<{
  readonly configPath: string;
  readonly issues: readonly string[];
  readonly cause?: unknown;
  readonly message: string;
}> {
  constructor(options: {
    readonly configPath: string;
    readonly issues: readonly string[];
    readonly cause?: unknown;
  }) {
    super({
      ...options,
      message: `Invalid MCP configuration at ${options.configPath}:\n${options.issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`,
    });
  }
}

export class McpConfigSerializationError extends TaggedError("McpConfigSerializationError")<{
  readonly configPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpConfigMutationValidationError extends TaggedError(
  "McpConfigMutationValidationError",
)<{
  readonly configPath: string;
  readonly serverId: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class McpConfigFileOperationError extends TaggedError("McpConfigFileOperationError")<{
  readonly configPath: string;
  readonly operation: McpConfigFileOperation;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpConfigFileOperationAndCleanupError extends TaggedError(
  "McpConfigFileOperationAndCleanupError",
)<{
  readonly configPath: string;
  readonly primary: McpConfigWriteError;
  readonly cleanup: McpConfigFileOperationError;
  readonly message: string;
}> {}

export type McpConfigReadError = McpConfigError;
export type McpConfigWriteError =
  | McpConfigSerializationError
  | McpConfigFileOperationError
  | McpConfigFileOperationAndCleanupError;
export type McpConfigMutationError =
  | McpConfigReadError
  | McpConfigMutationValidationError
  | McpConfigWriteError;

export type McpConfigFileSnapshot = {
  readonly configPath: string;
  readonly exists: boolean;
  readonly config: UniversalMcpConfig;
};

export type McpConfigFileResult = ResultType<McpConfigFileSnapshot, McpConfigReadError>;

export type McpConfigMutation =
  | { readonly type: "upsert"; readonly server: McpServerDefinition }
  | { readonly type: "remove"; readonly serverId: string };

export type McpConfigMutationResult = {
  readonly configPath: string;
  readonly changed: boolean;
  readonly previousConfig: UniversalMcpConfig;
  readonly config: UniversalMcpConfig;
};

function isMissingFileError(error: unknown): boolean {
  const parsed = errorCodeSchema.safeParse(error);
  return parsed.success && (parsed.data.code === "ENOENT" || parsed.data.code === "ENOTDIR");
}

export function withMcpConfigMutationLock<T, E>(
  configPath: string,
  operation: () => Promise<ResultType<T, E>>,
): Promise<ResultType<T, E>> {
  const previous = mutationQueues.get(configPath) ?? Promise.resolve();
  const result = previous.then(operation);
  const observed = Result.tryPromise({
    try: () => result,
    catch: () => new Error("MCP configuration mutation queue operation rejected"),
  });
  const settled = observed.then(() => undefined);
  mutationQueues.set(configPath, settled);

  return result.finally(() => {
    if (mutationQueues.get(configPath) === settled) mutationQueues.delete(configPath);
  });
}

async function captureFileOperation<T>(options: {
  readonly configPath: string;
  readonly operation: McpConfigFileOperation;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, McpConfigFileOperationError>> {
  const message = `Failed to ${options.operation.replaceAll("_", " ")} for MCP configuration at ${options.configPath}`;
  const captured = await Result.tryPromise({
    try: options.run,
    catch: (cause) => {
      if (Panic.is(cause)) return { kind: "panic", panic: cause } as const;
      if (cause instanceof Error) return { kind: "error", cause } as const;
      return {
        kind: "failure",
        error: new McpConfigFileOperationError({
          configPath: options.configPath,
          operation: options.operation,
          cause,
          message: `${message}: Unknown error`,
        }),
      } as const;
    },
  });
  return captured.match<() => ResultType<T, McpConfigFileOperationError>>({
    ok: (value) => () => Result.ok(value),
    err: (failure) => () => {
      if (failure.kind === "panic") {
        rethrowPanic(failure.panic);
        return Result.err(
          new McpConfigFileOperationError({
            configPath: options.configPath,
            operation: options.operation,
            cause: failure.panic,
            message,
          }),
        );
      }
      if (failure.kind === "error") {
        return Result.err(
          new McpConfigFileOperationError({
            configPath: options.configPath,
            operation: options.operation,
            cause: failure.cause,
            message: `${message}: ${opaqueErrorMessage(failure.cause)}`,
          }),
        );
      }
      return Result.err(failure.error);
    },
  })();
}

async function superviseMcpConfigFilePanicCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  {
    const captured = await Result.tryPromise({
      try: async () => {
        return await operation();
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (!Panic.is(cause)) return adaptToolResultToHost(Result.err(cause));
      {
        const captured = await Result.tryPromise({
          try: async () => {
            await cleanup();
          },
          catch: captureError,
        });

        if (captured.isErr()) {
          void captured.error.cause;
        }
      }
      rethrowPanic(cause);
      return adaptToolResultToHost(Result.err(cause));
    }
    return captured.value;
  }
}

function serializeConfig(
  configPath: string,
  config: UniversalMcpConfig,
): ResultType<string, McpConfigSerializationError> {
  const serialized = Result.try({
    try: () => serializeMcpConfigYaml(config),
    catch: (cause) =>
      Panic.is(cause)
        ? ({ kind: "panic", panic: cause } as const)
        : ({
            kind: "failure",
            ...captureError(cause, "MCP config serialization failed"),
          } as const),
  }).match<
    | { readonly kind: "success"; readonly source: string }
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "failure"; readonly cause: Error; readonly captured: unknown }
  >({
    ok: (source) => ({ kind: "success", source }),
    err: (failure) => failure,
  });
  if (serialized.kind === "panic") {
    rethrowPanic(serialized.panic);
    return Result.err(
      new McpConfigSerializationError({
        configPath,
        cause: serialized.panic,
        message: `Failed to serialize MCP configuration at ${configPath}`,
      }),
    );
  }
  if (serialized.kind === "failure") {
    return Result.err(
      new McpConfigSerializationError({
        configPath,
        cause: serialized.cause,
        message: `Failed to serialize MCP configuration at ${configPath}: ${opaqueErrorMessage(serialized.cause)}`,
      }),
    );
  }
  return Result.ok(serialized.source);
}

function combineOperationAndCleanup(
  configPath: string,
  primary: ResultType<void, McpConfigWriteError>,
  cleanup: ResultType<void, McpConfigFileOperationError>,
): ResultType<void, McpConfigWriteError> {
  return primary.match<ResultType<void, McpConfigWriteError>>({
    ok: () => cleanup,
    err: (primaryError) =>
      cleanup.match<ResultType<void, McpConfigWriteError>>({
        ok: () => Result.err(primaryError),
        err: (cleanupError) =>
          Result.err(
            new McpConfigFileOperationAndCleanupError({
              configPath,
              primary: primaryError,
              cleanup: cleanupError,
              message: `${primaryError.message}; cleanup also failed: ${cleanupError.message}`,
            }),
          ),
      }),
  });
}

function validateMutationServerId(
  configPath: string,
  serverId: string,
): ResultType<void, McpConfigMutationValidationError> {
  const parsed = mcpServerIdSchema.safeParse(serverId);
  if (parsed.success) return Result.ok();
  const issues = parsed.error.issues.map((issue) => issue.message);
  return Result.err(
    new McpConfigMutationValidationError({
      configPath,
      serverId,
      issues,
      message: `Invalid MCP server ID ${JSON.stringify(serverId)}: ${issues.join("; ")}`,
    }),
  );
}

export function resolveMcpConfigPath(options: { dataDir: string }): string {
  return path.join(options.dataDir, MCP_CONFIG_FILE_NAME);
}

export async function readMcpConfigFile(configPath: string): Promise<McpConfigFileResult> {
  let source!: string;
  {
    const readConfig = await Result.tryPromise({
      try: async () => {
        source = await fs.readFile(configPath, "utf8");

        return { status: "fallthrough" } as const;
      },
      catch: captureError,
    });
    if (readConfig.isErr()) {
      const cause = readConfig.error.cause;
      rethrowPanic(cause);
      if (isMissingFileError(cause)) {
        return Result.ok({ configPath, exists: false, config: createEmptyMcpConfig() });
      }
      return Result.err(
        new McpConfigError({
          configPath,
          issues: [`<root>: failed to read file: ${opaqueErrorMessage(cause)}`],
          cause,
        }),
      );
    }
  }

  const parsed = parseMcpConfigYaml(source);
  if (!parsed.ok) return Result.err(new McpConfigError({ configPath, issues: parsed.issues }));
  return Result.ok({ configPath, exists: true, config: parsed.config });
}

/** Write a complete validated config through a same-directory rename. */
export async function writeMcpConfigFileAtomic(
  configPath: string,
  config: UniversalMcpConfig,
  dependencies: McpConfigFileDependencies = DEFAULT_FILE_DEPENDENCIES,
): Promise<ResultType<void, McpConfigWriteError>> {
  const serialized = serializeConfig(configPath, config);
  if (serialized.isErr()) return Result.err(serialized.error);
  const source = serialized.value;

  const parent = path.dirname(configPath);
  const parentResult = await captureFileOperation({
    configPath,
    operation: "create_parent",
    run: () => dependencies.mkdir(parent, { recursive: true }).then(() => undefined),
  });
  const parentFailure = parentResult.match<() => ResultType<void, McpConfigWriteError> | null>({
    ok: () => () => null,
    err: (error) => () => Result.err(error),
  })();
  if (parentFailure) return parentFailure;

  const temporaryPath = path.join(
    parent,
    `.${path.basename(configPath)}.${dependencies.randomUUID()}.tmp`,
  );
  const removeTemporary = () =>
    captureFileOperation({
      configPath,
      operation: "remove_temporary",
      run: () => dependencies.rm(temporaryPath, { force: true }),
    });

  const opened = await superviseMcpConfigFilePanicCleanup(
    () =>
      captureFileOperation({
        configPath,
        operation: "open_temporary",
        run: () => dependencies.open(temporaryPath, "wx", 0o600),
      }),
    async () => {
      await removeTemporary();
    },
  );
  if (opened.isErr()) {
    return combineOperationAndCleanup(
      configPath,
      Result.err(opened.error),
      await removeTemporary(),
    );
  }
  const handle = opened.value;
  const closeTemporary = () =>
    captureFileOperation({
      configPath,
      operation: "close_temporary",
      run: () => handle.close(),
    });
  const written = await superviseMcpConfigFilePanicCleanup(
    async () => {
      let result = await captureFileOperation({
        configPath,
        operation: "write_temporary",
        run: () => handle.writeFile(source, "utf8"),
      });
      const writeSucceeded = result.match({ ok: () => true, err: () => false });
      if (writeSucceeded) {
        result = await captureFileOperation({
          configPath,
          operation: "sync_temporary",
          run: () => handle.sync(),
        });
      }
      return result;
    },
    async () => {
      await closeTemporary().finally(removeTemporary);
    },
  );

  const closed = await superviseMcpConfigFilePanicCleanup(closeTemporary, async () => {
    await removeTemporary();
  });
  const prepared = combineOperationAndCleanup(configPath, written, closed);
  const preparationFailure = await prepared.match<
    () => Promise<ResultType<void, McpConfigWriteError> | null>
  >({
    ok: () => async () => null,
    err: () => async () =>
      combineOperationAndCleanup(configPath, prepared, await removeTemporary()),
  })();
  if (preparationFailure) return preparationFailure;

  const renamed = await superviseMcpConfigFilePanicCleanup(
    () =>
      captureFileOperation({
        configPath,
        operation: "rename_temporary",
        run: () => dependencies.rename(temporaryPath, configPath),
      }),
    async () => {
      await removeTemporary();
    },
  );
  const renameFailure = await renamed.match<
    () => Promise<ResultType<void, McpConfigWriteError> | null>
  >({
    ok: () => async () => null,
    err: () => async () => combineOperationAndCleanup(configPath, renamed, await removeTemporary()),
  })();
  if (renameFailure) return renameFailure;
  return Result.ok();
}

/**
 * Apply one add/replace/remove operation against the latest file contents.
 * Mutations to the same path are serialized within the Core process.
 */
export function mutateMcpConfigFile(options: {
  readonly configPath: string;
  readonly mutation: McpConfigMutation;
  readonly fileDependencies?: McpConfigFileDependencies;
}): Promise<ResultType<McpConfigMutationResult, McpConfigMutationError>> {
  return withMcpConfigMutationLock<McpConfigMutationResult, McpConfigMutationError>(
    options.configPath,
    async () => {
      const read = await readMcpConfigFile(options.configPath);
      return read.match<() => Promise<ResultType<McpConfigMutationResult, McpConfigMutationError>>>(
        {
          err: (error) => async () => Result.err(error),
          ok: (snapshot) => async () => {
            const previousConfig = snapshot.config;
            const servers = { ...previousConfig.servers };

            switch (options.mutation.type) {
              case "upsert": {
                const validated = validateMutationServerId(
                  options.configPath,
                  options.mutation.server.id,
                );
                const failure = validated.match({
                  ok: () => null,
                  err: (error) => Result.err(error),
                });
                if (failure) return failure;
                servers[options.mutation.server.id] = options.mutation.server;
                break;
              }
              case "remove": {
                const validated = validateMutationServerId(
                  options.configPath,
                  options.mutation.serverId,
                );
                const failure = validated.match({
                  ok: () => null,
                  err: (error) => Result.err(error),
                });
                if (failure) return failure;
                delete servers[options.mutation.serverId];
                break;
              }
            }

            const config: UniversalMcpConfig = {
              configVersion: previousConfig.configVersion,
              servers,
            };
            const previousSerialized = serializeConfig(options.configPath, previousConfig);
            if (previousSerialized.isErr()) return Result.err(previousSerialized.error);
            const previousSource = previousSerialized.value;
            const nextSerialized = serializeConfig(options.configPath, config);
            if (nextSerialized.isErr()) return Result.err(nextSerialized.error);
            const nextSource = nextSerialized.value;
            const changed = previousSource !== nextSource;
            if (changed) {
              const written = await writeMcpConfigFileAtomic(
                options.configPath,
                config,
                options.fileDependencies,
              );
              const writeFailure = written.match({
                ok: () => null,
                err: (error) => Result.err(error),
              });
              if (writeFailure) return writeFailure;
            }

            return Result.ok({ configPath: options.configPath, changed, previousConfig, config });
          },
        },
      )();
    },
  );
}
