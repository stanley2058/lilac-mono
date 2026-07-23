import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  loadProviderRegistry,
  loadRuntimeConfig,
  ModelCatalog,
  MiniLilacSkillCatalog,
  modelCapabilityOverrides,
  SessionService,
} from "@stanley2058/mini-lilac-runtime";
import {
  clearCodexTokens,
  createCodexOAuthProvider,
  readCodexTokens,
  startCodexOAuthLogin,
  writeCodexTokens,
  ModelCapability,
  type CodexOAuthLogin,
} from "@stanley2058/lilac-utils";
import { z } from "zod";

import { createMiniLilacServer } from "./server";

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
  mini-lilac-server [--config <file>] [--database <file>]
  mini-lilac-server auth codex [--status | --logout]

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
    codexOAuthProviderIds: providers.supersededProviderIds,
    onWarning: (warning) => console.warn(`Model catalog warning: ${warning.message}`),
  });
  const initialCatalog = await modelCatalog.get();

  const databasePath = path.resolve(cli.database ?? statePaths.databaseFile);
  await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });

  const sessionService = new SessionService({
    config,
    databasePath,
    providers,
    modelCapability: new ModelCapability({
      overrides: modelCapabilityOverrides(initialCatalog),
    }),
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
  const authToken = config.server.authTokenEnv
    ? process.env[config.server.authTokenEnv]
    : undefined;
  const app = createMiniLilacServer({ config, sessionService, modelCatalog, authToken });

  app.listen({ hostname: config.server.host, port: config.server.port });
  console.log(`Mini Lilac listening on http://${config.server.host}:${config.server.port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.stop();

    const activeSessions = sessionService.store
      .listSessions()
      .filter(
        (session): session is typeof session & { activeRunId: string } =>
          (session.status === "streaming" || session.status === "cancelling") &&
          session.activeRunId !== null,
      );
    await Promise.allSettled(
      activeSessions.map((session) =>
        sessionService.cancel({
          sessionId: session.id,
          runId: session.activeRunId,
          clientCommandId: `shutdown-${crypto.randomUUID()}`,
        }),
      ),
    );

    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      sessionService.store
        .listSessions()
        .some((session) => session.status === "streaming" || session.status === "cancelling")
    ) {
      await Bun.sleep(25);
    }
    sessionService.close();
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
}

if (import.meta.main) {
  await main();
}
