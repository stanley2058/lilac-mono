import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  loadProviderRegistry,
  loadRuntimeConfig,
  ModelCatalog,
  MiniLilacSkillCatalog,
  SessionService,
} from "@stanley2058/mini-lilac-runtime";
import {
  clearCodexTokens,
  createCodexOAuthProvider,
  readCodexTokens,
  startCodexOAuthLogin,
  writeCodexTokens,
  type CodexOAuthLogin,
} from "@stanley2058/lilac-utils";
import { z } from "zod";

import { createMiniLilacServer } from "./server";

const FLOCK_CONTENTION_EXIT_CODE = 200;
const FLOCK_READY_BYTE = 0x6c;
const SHUTDOWN_GRACE_MS = 10_000;
const SHUTDOWN_POLL_INTERVAL_MS = 25;

export type MiniLilacDatabaseLock = {
  readonly lockPath: string;
  release(): Promise<void>;
};

export class MiniLilacDatabaseLockError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MiniLilacDatabaseLockError";
  }
}

export function databaseLockPath(databasePath: string): string {
  return `${path.resolve(databasePath)}.mini-lilac.lock`;
}

export async function acquireDatabaseLock(databasePath: string): Promise<MiniLilacDatabaseLock> {
  const resolvedDatabasePath = path.resolve(databasePath);
  const lockPath = databaseLockPath(resolvedDatabasePath);
  await mkdir(path.dirname(resolvedDatabasePath), { recursive: true, mode: 0o700 });

  let holder;
  try {
    holder = Bun.spawn(
      [
        "flock",
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        String(FLOCK_CONTENTION_EXIT_CODE),
        "--no-fork",
        lockPath,
        "cat",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  } catch (error) {
    throw new MiniLilacDatabaseLockError(
      `Failed to start database lock holder for '${lockPath}'; ensure 'flock' is installed`,
      lockPath,
      { cause: error },
    );
  }

  const reader = holder.stdout.getReader();
  let readyByte: number | undefined;
  let handshakeError: unknown;
  try {
    holder.stdin.write(new Uint8Array([FLOCK_READY_BYTE]));
    await holder.stdin.flush();
    readyByte = (await reader.read()).value?.[0];
  } catch (error) {
    handshakeError = error;
  } finally {
    reader.releaseLock();
  }

  if (readyByte !== FLOCK_READY_BYTE) {
    holder.stdin.end();
    const [exitCode, stderr] = await Promise.all([
      holder.exited,
      new Response(holder.stderr).text(),
    ]);
    if (exitCode === FLOCK_CONTENTION_EXIT_CODE) {
      throw new MiniLilacDatabaseLockError(
        `Mini Lilac is already using database '${resolvedDatabasePath}'`,
        lockPath,
      );
    }
    const detail = stderr.trim();
    throw new MiniLilacDatabaseLockError(
      `Failed to acquire database lock '${lockPath}' (flock exited with code ${exitCode})${
        detail ? `: ${detail}` : ""
      }`,
      lockPath,
      handshakeError === undefined ? undefined : { cause: handshakeError },
    );
  }

  let releasePromise: Promise<void> | undefined;
  return {
    lockPath,
    release() {
      releasePromise ??= (async () => {
        holder.stdin.end();
        const exitCode = await holder.exited;
        if (exitCode !== 0) {
          throw new MiniLilacDatabaseLockError(
            `Failed to release database lock '${lockPath}' (flock exited with code ${exitCode})`,
            lockPath,
          );
        }
      })();
      return releasePromise;
    },
  };
}

export type MiniLilacShutdownOptions = {
  readonly stopListener: (force: boolean) => void | Promise<void>;
  readonly listActiveRuns: () => readonly { readonly sessionId: string; readonly runId: string }[];
  readonly cancelRun: (run: {
    readonly sessionId: string;
    readonly runId: string;
  }) => Promise<void>;
  readonly closeRuntime: () => void | Promise<void>;
  readonly graceMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export async function shutdownMiniLilacServer(options: MiniLilacShutdownOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SHUTDOWN_POLL_INTERVAL_MS;
  const deadline = now() + graceMs;
  let listenerSettled = false;
  let listenerFailed = false;
  let stopResult: void | Promise<void> = undefined;
  try {
    stopResult = options.stopListener(false);
  } catch {
    listenerSettled = true;
    listenerFailed = true;
  }
  const gracefulStop = Promise.resolve(stopResult).then(
    () => void (listenerSettled = true),
    () => {
      listenerSettled = true;
      listenerFailed = true;
    },
  );

  let cancellationsSettled = false;
  const cancellations = Promise.allSettled(
    options.listActiveRuns().map((run) => options.cancelRun(run)),
  ).then(() => void (cancellationsSettled = true));

  while (
    (!listenerSettled || !cancellationsSettled || options.listActiveRuns().length > 0) &&
    now() < deadline
  ) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }

  const force =
    listenerFailed ||
    !listenerSettled ||
    !cancellationsSettled ||
    options.listActiveRuns().length > 0;
  if (force) {
    await options.stopListener(true);
  } else {
    await Promise.all([gracefulStop, cancellations]);
  }
  await options.closeRuntime();
}

const serveOptionsSchema = z.object({
  command: z.literal("serve"),
  config: z.string().trim().min(1).optional(),
  database: z.string().trim().min(1).optional(),
});

const authOptionsSchema = z.object({
  command: z.literal("auth"),
  provider: z.literal("codex"),
  action: z.enum(["login", "status", "logout"]),
});

const helpOptionsSchema = z.object({ command: z.literal("help") });

export type MiniLilacServerCliOptions =
  | z.infer<typeof serveOptionsSchema>
  | z.infer<typeof authOptionsSchema>
  | z.infer<typeof helpOptionsSchema>;

export const MINI_LILAC_SERVER_HELP = `Usage:
  mini-lilac server [--config <file>] [--database <file>]
  mini-lilac server auth codex [--status | --logout]

Commands:
  auth codex           Sign in with OpenAI Codex OAuth and store Lilac-owned tokens
  auth codex --status  Show Codex OAuth status without printing tokens
  auth codex --logout  Clear stored Lilac Codex OAuth tokens

Options:
  --config <file>    Server config (default: $XDG_STATE_HOME/mini-lilac/config.yaml)
  --database <file>  SQLite database (default: $XDG_STATE_HOME/mini-lilac/mini-lilac.sqlite)
  --help             Show this help`;

export function parseCliArgs(args: readonly string[]): MiniLilacServerCliOptions {
  if (args.includes("--help")) return helpOptionsSchema.parse({ command: "help" });
  if (args[0] === "auth") {
    const provider = args[1];
    const parsed = parseArgs({
      args: args.slice(2),
      options: {
        status: { type: "boolean", default: false },
        logout: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    if (parsed.values.status && parsed.values.logout) {
      throw new Error("Choose only one of --status or --logout");
    }
    return authOptionsSchema.parse({
      command: "auth",
      provider,
      action: parsed.values.status ? "status" : parsed.values.logout ? "logout" : "login",
    });
  }

  const parsed = parseArgs({
    args: [...args],
    options: {
      config: { type: "string" },
      database: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  return serveOptionsSchema.parse({ command: "serve", ...parsed.values });
}

export type MiniLilacAuthDependencies = {
  startLogin: () => Promise<CodexOAuthLogin>;
  readTokens: typeof readCodexTokens;
  clearTokens: typeof clearCodexTokens;
  storagePath: () => string;
  log: (message: string) => void;
};

export type MiniLilacStatePaths = {
  readonly directory: string;
  readonly configFile: string;
  readonly databaseFile: string;
  readonly codexOAuthFile: string;
  readonly modelsDevCacheFile: string;
};

export function miniLilacStatePaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MiniLilacStatePaths {
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");
  const directory = path.join(stateHome, "mini-lilac");
  return {
    directory,
    configFile: path.join(directory, "config.yaml"),
    databaseFile: path.join(directory, "mini-lilac.sqlite"),
    codexOAuthFile: path.join(directory, "codex.json"),
    modelsDevCacheFile: path.join(directory, "models-dev.json"),
  };
}

export function createMiniLilacAuthDependencies(
  paths: MiniLilacStatePaths = miniLilacStatePaths(),
): MiniLilacAuthDependencies {
  return {
    startLogin: () => startCodexOAuthLogin({ storagePath: paths.codexOAuthFile }),
    readTokens: () => readCodexTokens(paths.codexOAuthFile),
    clearTokens: () => clearCodexTokens(paths.codexOAuthFile),
    storagePath: () => paths.codexOAuthFile,
    log: console.log,
  };
}

export async function runAuthCommand(
  cli: z.infer<typeof authOptionsSchema>,
  dependencies: MiniLilacAuthDependencies = createMiniLilacAuthDependencies(),
): Promise<void> {
  const storagePath = dependencies.storagePath();
  if (cli.action === "status") {
    const tokens = await dependencies.readTokens();
    dependencies.log(tokens ? "Codex OAuth: configured" : "Codex OAuth: not configured");
    dependencies.log(`Storage: ${storagePath}`);
    if (tokens?.accountId) dependencies.log(`Account: ${tokens.accountId}`);
    if (tokens) dependencies.log(`Expires: ${new Date(tokens.expires).toISOString()}`);
    return;
  }
  if (cli.action === "logout") {
    await dependencies.clearTokens();
    dependencies.log(`Codex OAuth cleared from ${storagePath}`);
    return;
  }

  const login = await dependencies.startLogin();
  dependencies.log(`Open this URL to authorize Codex:\n${login.authorizeUrl}`);
  dependencies.log(`Tokens will be stored at ${login.storagePath}`);
  dependencies.log(`Waiting for callback on ${login.redirectUri} ...`);
  try {
    const result = await login.result;
    dependencies.log(
      result.accountId
        ? `Codex OAuth configured for account ${result.accountId}`
        : "Codex OAuth configured",
    );
  } finally {
    await login.close();
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  authDependencies?: MiniLilacAuthDependencies,
): Promise<void> {
  const cli = parseCliArgs(args);
  const statePaths = miniLilacStatePaths();
  if (cli.command === "help") {
    console.log(MINI_LILAC_SERVER_HELP);
    return;
  }
  if (cli.command === "auth") {
    await runAuthCommand(cli, authDependencies ?? createMiniLilacAuthDependencies(statePaths));
    return;
  }
  const databasePath = path.resolve(cli.database ?? statePaths.databaseFile);
  const databaseLock = await acquireDatabaseLock(databasePath);
  let sessionService: SessionService | undefined;
  let stopListener: (() => Promise<void>) | undefined;

  try {
    await mkdir(statePaths.directory, { recursive: true, mode: 0o700 });
    const config = await loadRuntimeConfig(cli.config ?? statePaths.configFile);
    const providers = await loadProviderRegistry(config, {
      readCodexTokens: () => readCodexTokens(statePaths.codexOAuthFile),
      createCodexOAuthProvider: () =>
        createCodexOAuthProvider({
          readTokens: () => readCodexTokens(statePaths.codexOAuthFile),
          writeTokens: (tokens) => writeCodexTokens(tokens, statePaths.codexOAuthFile),
        }),
    });
    const modelCatalog = new ModelCatalog(providers.config, providers.auth, {
      cacheFilePath: statePaths.modelsDevCacheFile,
      codexOAuthProviderIds: providers.supersededProviderIds,
      onWarning: (warning) => console.warn(`Model catalog warning: ${warning.message}`),
    });
    await modelCatalog.get({ backgroundRefresh: true });

    const runtime = new SessionService({
      config,
      databasePath,
      providers,
      modelLimitsResolver: async (specifier) => {
        const model = (await modelCatalog.get()).models.find(
          (entry) => entry.ref.value === specifier,
        );
        return model?.limits && model.limits.context > 0 ? model.limits : undefined;
      },
      skillCatalog: new MiniLilacSkillCatalog({
        dataDir: statePaths.directory,
        onWarning: (warning) =>
          console.warn(`Skill warning (${warning.location}): ${warning.message}`),
      }),
      protectedToolPaths: [statePaths.codexOAuthFile],
    });
    sessionService = runtime;
    const authToken = config.server.authTokenEnv
      ? process.env[config.server.authTokenEnv]
      : undefined;
    const app = createMiniLilacServer({ config, sessionService: runtime, modelCatalog, authToken });

    app.listen({ hostname: config.server.host, port: config.server.port });
    stopListener = () => app.stop(true).then(() => undefined);
    console.log(`Mini Lilac listening on http://${config.server.host}:${config.server.port}`);

    const listActiveRuns = () =>
      runtime.store
        .listSessions()
        .filter(
          (session): session is typeof session & { activeRunId: string } =>
            (session.status === "streaming" || session.status === "cancelling") &&
            session.activeRunId !== null,
        )
        .map((session) => ({ sessionId: session.id, runId: session.activeRunId }));
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await shutdownMiniLilacServer({
        stopListener: (force) => app.stop(force).then(() => undefined),
        listActiveRuns,
        cancelRun: (run) =>
          runtime
            .cancel({
              ...run,
              clientCommandId: `shutdown-${crypto.randomUUID()}`,
            })
            .then(() => undefined),
        closeRuntime: () => runtime.shutdown({ graceMs: SHUTDOWN_GRACE_MS }),
      });
      await databaseLock.release();
    };

    const handleSignal = () => {
      void shutdown().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Mini Lilac shutdown failed: ${message}`);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  } catch (error) {
    try {
      await stopListener?.();
    } finally {
      try {
        await sessionService?.shutdown({ graceMs: SHUTDOWN_GRACE_MS });
      } finally {
        await databaseLock.release();
      }
    }
    throw error;
  }
}

if (import.meta.main) {
  await main();
}
