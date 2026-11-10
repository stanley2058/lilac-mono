import { captureError } from "../shared/error-capture.js";
import Redis from "ioredis";
import { isPanic } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  createLilacBus,
  createRedisStreamsBus,
  RedisEventDeadLetter,
  type CreateLilacBusOptions,
  type EventDeliveryFatalReporter,
  type EventDeliveryLogContext,
  type EventDeliveryLogger,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { loadOrCreateCoreDeadLetterKey, type CoreDeadLetterKeyError } from "./core-dead-letter-key";
import { captureRuntimeError, projectCapturedRuntimeError } from "./error-format";
import { createCoreRuntimeCleanupSupervisor } from "./core-runtime-cleanup";

type CoreEventBusLogSink = {
  warn(message: string, context: EventDeliveryLogContext): void;
  error(message: string, context: EventDeliveryLogContext): void;
};

const CORE_EVENT_BUS_LOG_FIELDS = [
  "topic",
  "cursor",
  "source",
  "stage",
  "eventType",
  "mode",
  "phase",
] as const satisfies readonly (keyof EventDeliveryLogContext)[];

function redactEventDeliveryLogContext(context: EventDeliveryLogContext): EventDeliveryLogContext {
  const redacted: Record<string, string | number | boolean | undefined> = {};
  for (const field of CORE_EVENT_BUS_LOG_FIELDS) {
    if (Object.hasOwn(context, field)) redacted[field] = context[field];
  }
  return redacted;
}

export function createCoreEventBusLogger(logger: CoreEventBusLogSink): EventDeliveryLogger {
  return {
    warn(event, context) {
      logger.warn(event, redactEventDeliveryLogContext(context));
    },
    error(event, context) {
      logger.error(event, redactEventDeliveryLogContext(context));
    },
  };
}

export function createCoreEventBusFatalReporter(
  reportFatalError: (error: Error) => void,
): EventDeliveryFatalReporter {
  const reported = new WeakSet<Error>();
  const normalizedDefects = new WeakMap<object, Error>();

  return {
    report<Cause>(cause: Cause) {
      let errorCause: Error | null = null;
      {
        const captured = Result.try({
          try: () => {
            if (cause instanceof Error) errorCause = cause;
          },
          catch: captureError,
        });

        if (captured.isErr()) {
          // Hostile values are normalized below without inspecting them again.
        }
      }

      let fatalError: Error;
      if (errorCause) {
        fatalError = errorCause;
      } else if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
        const existing = normalizedDefects.get(cause);
        fatalError = existing ?? new Panic({ message: "Event delivery defect" });
        if (!existing) normalizedDefects.set(cause, fatalError);
      } else {
        fatalError = new Panic({ message: "Event delivery defect" });
      }
      if (reported.has(fatalError)) return;
      reported.add(fatalError);
      reportFatalError(fatalError);
    },
  };
}

export function createCoreEventBusDeliveryOptions(params: {
  readonly redis: Redis;
  readonly deadLetterEncryptionKey: Uint8Array;
  readonly evidenceBlobStore: Pick<BlobStore, "startUpload">;
  readonly logger: CoreEventBusLogSink;
  readonly reportFatalError: (error: Error) => void;
  readonly postCommitObserver?: CreateLilacBusOptions["postCommitObserver"];
}): CreateLilacBusOptions {
  return {
    deadLetter: new RedisEventDeadLetter({
      redis: params.redis,
      encryptionKey: params.deadLetterEncryptionKey,
      evidenceBlobStore: params.evidenceBlobStore,
    }),
    logger: createCoreEventBusLogger(params.logger),
    reportFatal: createCoreEventBusFatalReporter(params.reportFatalError),
    ...(params.postCommitObserver ? { postCommitObserver: params.postCommitObserver } : {}),
  };
}

type CoreEventBusRaw = ReturnType<typeof createRedisStreamsBus>;

export class CoreEventBusSetupFailed extends TaggedError("CoreEventBusSetupFailed")<{
  readonly operation:
    | "read-config"
    | "create-redis"
    | "prepare-workspace"
    | "load-dead-letter-key"
    | "ping-redis"
    | "create-raw-bus"
    | "create-lilac-bus";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreEventBusCleanupFailed extends TaggedError("CoreEventBusCleanupFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreEventBusSetupAndCleanupFailed extends TaggedError(
  "CoreEventBusSetupAndCleanupFailed",
)<{
  readonly setup: CoreEventBusSetupFailed;
  readonly cleanup: CoreEventBusCleanupFailed;
  readonly message: string;
}> {}

export type CoreEventBusSetupError = CoreEventBusSetupFailed | CoreEventBusSetupAndCleanupFailed;

export type CoreEventBusSetupOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<CoreEventBusResources, CoreEventBusSetupError>;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

export type CoreEventBusResources = {
  readonly redis: Redis;
  readonly raw: CoreEventBusRaw;
  readonly bus: LilacBus;
  readonly canonicalWorkspaceRoot: string;
};

type CoreEventBusOwnership = {
  readonly redis: Redis;
  readonly raw: CoreEventBusRaw | null;
  readonly bus: LilacBus | null;
};

function captureCoreRedisConstruction(
  redisUrl: string,
): ResultType<Redis, CoreEventBusSetupFailed> {
  {
    const captured = Result.try({
      try: () => {
        return Result.ok(new Redis(redisUrl));
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (isPanic(cause)) throw cause;
      return Result.err(
        new CoreEventBusSetupFailed({
          operation: "create-redis",
          cause,
          message: "Core event bus setup failed during create-redis",
        }),
      );
    }
    return captured.value;
  }
}

async function captureCoreWorkspacePreparation(
  cwd: string,
): Promise<ResultType<string, CoreEventBusSetupFailed>> {
  {
    const captured = await Result.tryPromise({
      try: async () => {
        await fs.mkdir(cwd, { recursive: true });
        return Result.ok(await fs.realpath(cwd));
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (isPanic(cause)) throw cause;
      return Result.err(
        new CoreEventBusSetupFailed({
          operation: "prepare-workspace",
          cause,
          message: "Core event bus setup failed during prepare-workspace",
        }),
      );
    }
    return captured.value;
  }
}

async function captureCoreRedisConnection(
  redis: Redis,
): Promise<ResultType<void, CoreEventBusSetupFailed>> {
  {
    const captured = await Result.tryPromise({
      try: async () => {
        await redis.ping();
        return Result.ok(undefined);
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (isPanic(cause)) throw cause;
      return Result.err(
        new CoreEventBusSetupFailed({
          operation: "ping-redis",
          cause,
          message: "Core event bus setup failed during ping-redis",
        }),
      );
    }
    return captured.value;
  }
}

function captureCoreRawBusConstruction(
  redis: Redis,
): ResultType<CoreEventBusRaw, CoreEventBusSetupFailed> {
  {
    const captured = Result.try({
      try: () => {
        return Result.ok(
          createRedisStreamsBus({
            redis,
            ownsRedis: true,
            subscriberPool: {
              // Blocking XREAD/XREADGROUP calls use capped, prewarmed dedicated connections.
              max: 16,
              warm: 8,
              autoscale: {
                enabled: true,
                min: 16,
                cap: 256,
                cooldownMs: 30_000,
              },
            },
          }),
        );
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (isPanic(cause)) throw cause;
      return Result.err(
        new CoreEventBusSetupFailed({
          operation: "create-raw-bus",
          cause,
          message: "Core event bus setup failed during create-raw-bus",
        }),
      );
    }
    return captured.value;
  }
}

function captureCoreLilacBusConstruction(params: {
  readonly redis: Redis;
  readonly raw: CoreEventBusRaw;
  readonly deadLetterEncryptionKey: Uint8Array;
  readonly evidenceBlobStore: Pick<BlobStore, "startUpload">;
  readonly logger: CoreEventBusLogSink;
  readonly reportFatalError: (error: Error) => void;
  readonly postCommitObserver?: CreateLilacBusOptions["postCommitObserver"];
}): ResultType<LilacBus, CoreEventBusSetupFailed> {
  {
    const captured = Result.try({
      try: () => {
        return Result.ok(
          createLilacBus(
            params.raw,
            createCoreEventBusDeliveryOptions({
              redis: params.redis,
              deadLetterEncryptionKey: params.deadLetterEncryptionKey,
              evidenceBlobStore: params.evidenceBlobStore,
              logger: params.logger,
              reportFatalError: params.reportFatalError,
              ...(params.postCommitObserver
                ? { postCommitObserver: params.postCommitObserver }
                : {}),
            }),
          ),
        );
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (isPanic(cause)) throw cause;
      return Result.err(
        new CoreEventBusSetupFailed({
          operation: "create-lilac-bus",
          cause,
          message: "Core event bus setup failed during create-lilac-bus",
        }),
      );
    }
    return captured.value;
  }
}

export async function captureCoreEventBusCleanup(
  ownership: CoreEventBusOwnership,
): Promise<ResultType<void, CoreEventBusCleanupFailed>> {
  {
    const captured = await Result.tryPromise({
      try: async () => {
        if (ownership.bus) {
          const closed = await ownership.bus.close();
          return closed.match<ResultType<void, CoreEventBusCleanupFailed>>({
            ok: () => Result.ok(undefined),
            err: (error) =>
              Result.err(
                new CoreEventBusCleanupFailed({
                  cause: error,
                  message: "Core event bus cleanup failed",
                }),
              ),
          });
        }
        if (ownership.raw) {
          await ownership.raw.close();
          return Result.ok(undefined);
        }
        await ownership.redis.quit();
        return Result.ok(undefined);
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (isPanic(cause)) throw cause;
      return Result.err(
        new CoreEventBusCleanupFailed({
          cause,
          message: "Core event bus cleanup failed",
        }),
      );
    }
    return captured.value;
  }
}

async function coreEventBusSetupFailureWithCleanup(
  setup: CoreEventBusSetupFailed,
  ownership: CoreEventBusOwnership,
): Promise<ResultType<never, CoreEventBusSetupError>> {
  const cleanup = await captureCoreEventBusCleanup(ownership);
  return cleanup.match<ResultType<never, CoreEventBusSetupError>>({
    ok: () => Result.err(setup),
    err: (cleanupError) =>
      Result.err(
        new CoreEventBusSetupAndCleanupFailed({
          setup,
          cleanup: cleanupError,
          message: `${setup.message}; cleanup also failed`,
        }),
      ),
  });
}

export async function setupCoreEventBusResources(params: {
  readonly redisUrl: string;
  readonly cwd: string;
  readonly dataDir: string;
  readonly evidenceBlobStore: Pick<BlobStore, "startUpload">;
  readonly logger: CoreEventBusLogSink;
  readonly reportFatalError: (error: Error) => void;
  readonly postCommitObserver?: CreateLilacBusOptions["postCommitObserver"];
  readonly dependencies?: {
    readonly captureRedisConstruction?: typeof captureCoreRedisConstruction;
    readonly loadDeadLetterKey?: (options: {
      readonly dataDir: string;
    }) => Promise<ResultType<Uint8Array, CoreDeadLetterKeyError>>;
  };
}): Promise<CoreEventBusSetupOutcome> {
  let redis: Redis | null = null;
  let raw: CoreEventBusRaw | null = null;
  let bus: LilacBus | null = null;
  let cleanupAttempted = false;

  const setupWithCleanup = async <T>(
    result: ResultType<T, CoreEventBusSetupFailed>,
    ownedRedis: Redis,
  ): Promise<ResultType<T, CoreEventBusSetupError>> =>
    result.match<() => Promise<ResultType<T, CoreEventBusSetupError>>>({
      ok: (value) => async () => Result.ok(value),
      err: (error) => async () => {
        cleanupAttempted = true;
        return coreEventBusSetupFailureWithCleanup(error, {
          redis: ownedRedis,
          raw,
          bus,
        });
      },
    })();

  const setup = (
    await Result.tryPromise({
      try: async () => {
        const redisCreated = (
          params.dependencies?.captureRedisConstruction ?? captureCoreRedisConstruction
        )(params.redisUrl);
        return redisCreated.match({
          err: (error) => async () => Result.err(error),
          ok: (ownedRedis) => async () => {
            redis = ownedRedis;

            const workspacePrepared = await captureCoreWorkspacePreparation(params.cwd);
            const workspaceResult = await setupWithCleanup(workspacePrepared, ownedRedis);
            const workspaceFailure = workspaceResult.match({
              ok: () => null,
              err: (error) => Result.err(error),
            });
            if (workspaceFailure) return workspaceFailure;
            const canonicalWorkspaceRoot = workspaceResult.match({
              ok: (value) => value,
              err: () => "",
            });

            const deadLetterKeyResult = await (
              params.dependencies?.loadDeadLetterKey ?? loadOrCreateCoreDeadLetterKey
            )({ dataDir: params.dataDir });
            const deadLetterKeyResultWithCleanup = await setupWithCleanup(
              deadLetterKeyResult.mapError(
                (error) =>
                  new CoreEventBusSetupFailed({
                    operation: "load-dead-letter-key",
                    cause: error,
                    message: "Core event bus setup failed during load-dead-letter-key",
                  }),
              ),
              ownedRedis,
            );
            const deadLetterKeyFailure = deadLetterKeyResultWithCleanup.match({
              ok: () => null,
              err: (error) => Result.err(error),
            });
            if (deadLetterKeyFailure) return deadLetterKeyFailure;
            const deadLetterKey = deadLetterKeyResultWithCleanup.match({
              ok: (value) => value,
              err: () => new Uint8Array(),
            });

            const redisConnected = await captureCoreRedisConnection(ownedRedis);
            const connectionResult = await setupWithCleanup(redisConnected, ownedRedis);
            const connectionFailure = connectionResult.match({
              ok: () => null,
              err: (error) => Result.err(error),
            });
            if (connectionFailure) return connectionFailure;

            const rawCreated = captureCoreRawBusConstruction(ownedRedis);
            const rawResult = await setupWithCleanup(rawCreated, ownedRedis);
            const rawFailure = rawResult.match({
              ok: () => null,
              err: (error) => Result.err(error),
            });
            if (rawFailure) return rawFailure;
            raw = rawResult.match({
              ok: (value) => () => value,
              err: (error) => () => {
                throw error;
              },
            })();

            const busCreated = captureCoreLilacBusConstruction({
              redis: ownedRedis,
              raw,
              deadLetterEncryptionKey: deadLetterKey,
              evidenceBlobStore: params.evidenceBlobStore,
              logger: params.logger,
              reportFatalError: params.reportFatalError,
              ...(params.postCommitObserver
                ? { postCommitObserver: params.postCommitObserver }
                : {}),
            });
            const busResult = await setupWithCleanup(busCreated, ownedRedis);
            const busFailure = busResult.match({
              ok: () => null,
              err: (error) => Result.err(error),
            });
            if (busFailure) return busFailure;
            bus = busResult.match({
              ok: (value) => () => value,
              err: (error) => () => {
                throw error;
              },
            })();

            return Result.ok({
              redis: ownedRedis,
              raw,
              bus,
              canonicalWorkspaceRoot,
            });
          },
        })();
      },
      catch: captureRuntimeError,
    })
  ).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Unexpected Core event bus setup rejection"),
  );
  return setup.match<() => Promise<CoreEventBusSetupOutcome>>({
    ok: (value) => async () => ({ kind: "result", result: value }),
    err: (error) => async () => {
      const cause = isPanic(error)
        ? error
        : new Panic({ message: "Unexpected Core event bus setup rejection" });
      if (!redis || cleanupAttempted) return { kind: "panic", panic: cause };
      const ownedRedis = redis;
      const cleanup = createCoreRuntimeCleanupSupervisor(cause);
      await cleanup.run("eventBus.setup.close", async () => {
        adaptCoreEventBusCleanupResultToHost(
          await captureCoreEventBusCleanup({ redis: ownedRedis, raw, bus }),
        );
      });
      if (cleanup.failures.length > 0) {
        params.logger.error("event_bus.setup_cleanup_failed", {
          failureCount: cleanup.failures.length,
        });
      }
      cleanup.finish();
      return { kind: "panic", panic: cause };
    },
  })();
}

export function adaptCoreEventBusCleanupResultToHost(
  result: ResultType<void, CoreEventBusCleanupFailed>,
): void {
  result.match({
    ok: () => () => undefined,
    err: (error) => () => {
      throw new Error(error.message);
    },
  })();
}
