import { withMcpSessionHeaders } from "./session-context";
import { captureError } from "../shared/error-capture.js";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  createMCPClient,
  UnauthorizedError,
  type ListToolsResult,
  type MCPClientConfig,
  type MCPTransport,
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { catalogToolStableId, type CatalogToolIdentity } from "./catalog-identity";
import type { McpServerDefinition } from "./config-types";
import { McpConfigError, readMcpConfigFile } from "./config-file";
import { rethrowPanic, safeMcpErrorText } from "./error-format";
import { enforceModernMcpResultContract, retainTransportPanic } from "./modern-result-validation";
import type {
  McpCatalogTool,
  McpCatalogServer,
  McpConvertedTool,
  McpRegistryApi,
  McpRegistryClient,
  McpRegistryConfigStatus,
  McpRegistryOptions,
  McpRegistryPhase,
  McpRegistryTransportInput,
  McpReloadOutcome,
  McpReloadReconciliation,
  McpServerStatus,
  McpServerInfo,
} from "./registry-types";
import { resolveMcpValueSourceMap, validateHttpHeaders } from "./value-source";

const DEFAULT_INIT_DEADLINE_MS = 30_000;
const mcpNonTerminalExecutionErrorSchema = z.union([
  z.object({
    name: z.literal("MCPClientError"),
    code: z.number(),
  }),
  // @ai-sdk/mcp 2.0.39 does not export a runtime error type for this limitation.
  z.object({
    name: z.literal("MCPClientError"),
    message: z.literal(
      "Server requested additional input, but multi round-trip requests are not supported yet",
    ),
  }),
]);
const optionalHttpInboundSseErrorSchema = z.object({
  name: z.literal("MCPClientError"),
  message: z.string().startsWith("MCP HTTP Transport Error: GET SSE failed:"),
  statusCode: z.number().int(),
  url: z.string(),
});
const mcpServerInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

type RegistryEntry = {
  readonly definition: McpServerDefinition;
  readonly fingerprint: string;
  readonly transportFingerprint?: string;
  readonly client?: McpRegistryClient;
  readonly serverInfo?: McpServerInfo;
  readonly sensitiveValues: readonly string[];
  readonly status: McpServerStatus;
  readonly tools: readonly McpCatalogTool[];
};

type InitializedCandidate = {
  readonly client: McpRegistryClient;
  readonly serverInfo: McpServerInfo;
  readonly sensitiveValues: readonly string[];
  readonly transportFingerprint: string;
  readonly tools: readonly McpCatalogTool[];
};

type ResolvedTransport = {
  readonly input: McpRegistryTransportInput;
  readonly sensitiveValues: readonly string[];
};

type CandidateResult =
  | { readonly ok: true; readonly candidate: InitializedCandidate }
  | {
      readonly ok: false;
      readonly status: "unavailable" | "authentication_required";
      readonly phase: McpRegistryPhase;
      readonly error: string;
    };

export class McpRegistryReloadError extends TaggedError("McpRegistryReloadError")<{
  readonly configPath: string;
  readonly cause: McpConfigError;
  readonly message: string;
}> {}

export class McpRegistryOptionsInvalid extends TaggedError("McpRegistryOptionsInvalid")<{
  readonly field: "initDeadlineMs";
  readonly message: string;
}> {}

export class McpRegistryStateError extends TaggedError("McpRegistryStateError")<{
  readonly state: "not-initialized" | "stopped";
  readonly message: string;
}> {}

export type McpRegistryReloadFailure = McpRegistryReloadError | McpRegistryStateError;

export function createMcpRegistryResult(
  options: McpRegistryOptions,
): ResultType<McpRegistry, McpRegistryOptionsInvalid> {
  const deadline = options.initDeadlineMs ?? DEFAULT_INIT_DEADLINE_MS;
  if (!Number.isFinite(deadline)) {
    return Result.err(
      new McpRegistryOptionsInvalid({
        field: "initDeadlineMs",
        message: "MCP initialization deadline must be finite",
      }),
    );
  }
  if (deadline <= 0) {
    return Result.err(
      new McpRegistryOptionsInvalid({
        field: "initDeadlineMs",
        message: "MCP initialization deadline must be greater than zero",
      }),
    );
  }
  return Result.ok(new McpRegistry(options));
}

class McpRegistryTransportConfigurationError extends TaggedError(
  "McpRegistryTransportConfigurationError",
)<{
  readonly serverId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

class McpRegistryAuthProviderCreateError extends TaggedError("McpRegistryAuthProviderCreateError")<{
  readonly serverId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

class McpRegistryAuthTokensReadError extends TaggedError("McpRegistryAuthTokensReadError")<{
  readonly serverId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

type McpRegistryTransportError =
  | McpRegistryTransportConfigurationError
  | McpRegistryAuthProviderCreateError
  | McpRegistryAuthTokensReadError
  | McpAuthenticationRequiredError;

class McpRegistryDeadlineError extends Error {
  constructor(serverId: string, deadlineMs: number) {
    super(`MCP server ${JSON.stringify(serverId)} initialization exceeded ${deadlineMs}ms`);
    this.name = "McpRegistryDeadlineError";
  }
}

class McpRegistryCloseDeadlineError extends Error {
  constructor(serverId: string, deadlineMs: number) {
    super(`MCP server ${JSON.stringify(serverId)} client close exceeded ${deadlineMs}ms`);
    this.name = "McpRegistryCloseDeadlineError";
  }
}

class McpRegistryDiscoveryInvalid extends TaggedError("McpRegistryDiscoveryInvalid")<{
  readonly reason:
    | "duplicate-tool"
    | "invalid-server-info"
    | "missing-conversion"
    | "repeated-cursor";
  readonly message: string;
}> {}

function decodeMcpServerInfo(
  value: unknown,
): ResultType<McpServerInfo, McpRegistryDiscoveryInvalid> {
  const parsed = mcpServerInfoSchema.safeParse(value);
  if (!parsed.success) {
    return Result.err(
      new McpRegistryDiscoveryInvalid({
        reason: "invalid-server-info",
        message: `Invalid MCP serverInfo: ${z.prettifyError(parsed.error)}`,
      }),
    );
  }
  return Result.ok(Object.freeze(parsed.data));
}

class McpRegistryTerminalFailure extends TaggedError("McpRegistryTerminalFailure")<{
  readonly status: "unavailable" | "authentication_required";
  readonly message: string;
}> {}

type McpRegistryDiscoveryError = McpRegistryDiscoveryInvalid | McpRegistryTerminalFailure;

export class McpAuthenticationRequiredError extends TaggedError("McpAuthenticationRequiredError")<{
  readonly serverId: string;
  readonly message: string;
}> {
  constructor(serverId: string) {
    super({
      serverId,
      message: `MCP server ${JSON.stringify(serverId)} requires authentication`,
    });
  }
}

function defaultScheduleDeadline(callback: () => void, delayMs: number): () => void {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
}

function defaultCreateTransport(input: McpRegistryTransportInput): MCPClientConfig["transport"] {
  if (input.transport === "stdio") {
    return new Experimental_StdioMCPTransport({
      command: input.command,
      args: [...input.args],
      env: { ...input.env },
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
  }

  return {
    type: "http",
    url: input.url,
    headers: { ...input.headers },
    ...(input.authProvider === undefined ? {} : { authProvider: input.authProvider }),
  };
}

function definitionFingerprint(definition: McpServerDefinition): string {
  return JSON.stringify(definition.transportConfig);
}

function transportFingerprint(input: McpRegistryTransportInput): string {
  const normalized =
    input.transport === "stdio"
      ? input
      : {
          transport: input.transport,
          url: input.url,
          headers: input.headers,
          hasAuthProvider: input.authProvider !== undefined,
        };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function freezeOutcome(outcome: McpReloadOutcome): McpReloadOutcome {
  return Object.freeze(outcome);
}

function safeErrorText(error: unknown, sensitiveValues: readonly string[] = []): string {
  return safeMcpErrorText(error, sensitiveValues);
}

function configErrorStatus(
  error: McpConfigError,
): Extract<McpRegistryConfigStatus, { readonly status: "invalid" }> {
  const detail =
    error.issues.length === 0
      ? "The configuration is invalid."
      : safeErrorText(error.issues.join("; "));
  return Object.freeze({
    status: "invalid",
    error: `Invalid MCP configuration at "${error.configPath}": ${detail} Fix the file, then run mcp.reload.`,
  });
}

function isCustomTransport(transport: MCPClientConfig["transport"]): transport is MCPTransport {
  return (
    "start" in transport &&
    typeof transport.start === "function" &&
    "send" in transport &&
    typeof transport.send === "function" &&
    "close" in transport &&
    typeof transport.close === "function"
  );
}

function observeHttpSessionExpiration(
  transport: MCPClientConfig["transport"],
  onSessionExpired: () => void,
): MCPClientConfig["transport"] {
  if (isCustomTransport(transport) || transport.type !== "http") return transport;
  const sdkOnSessionExpired = transport.onSessionExpired;
  return {
    ...transport,
    onSessionExpired: (sessionId) => {
      sdkOnSessionExpired?.(sessionId);
      onSessionExpired();
    },
  };
}

function isOptionalHttpInboundSseError(
  definition: McpServerDefinition,
  sessionExpired: boolean,
  error: unknown,
): boolean {
  if (definition.transportConfig.transport !== "http" || sessionExpired) return false;
  const parsed = optionalHttpInboundSseErrorSchema.safeParse(error);
  return parsed.success && parsed.data.url === new URL(definition.transportConfig.url).href;
}

export class McpRegistry implements McpRegistryApi {
  private readonly configPath: string;
  private readonly initDeadlineMs: number;
  private readonly valueContext: {
    readonly baseDir: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly readTextFile?: (filePath: string) => Promise<string>;
  };
  private readonly readConfig;
  private readonly createClient;
  private readonly createTransport;
  private readonly createAuthProvider;
  private readonly scheduleDeadline;
  private readonly reportFatalError;
  private readonly clientClosures = new WeakMap<object, Promise<void>>();
  private readonly transportClosures = new WeakMap<object, Promise<void>>();
  private readonly reportedCleanupPanics = new WeakSet<Panic>();
  private entries = new Map<string, RegistryEntry>();
  private configStatus: McpRegistryConfigStatus = Object.freeze({ status: "valid" });
  private statusSnapshot: readonly McpServerStatus[] = Object.freeze([]);
  private catalogServerSnapshot: readonly McpCatalogServer[] = Object.freeze([]);
  private toolSnapshot: readonly McpCatalogTool[] = Object.freeze([]);
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private stopped = false;

  constructor(options: McpRegistryOptions) {
    const deadline = options.initDeadlineMs ?? DEFAULT_INIT_DEADLINE_MS;

    this.configPath = options.configPath;
    this.initDeadlineMs = deadline;
    this.valueContext = {
      baseDir: path.dirname(options.configPath),
      env: options.env ?? process.env,
      ...(options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile }),
    };
    this.readConfig = options.dependencies?.readConfig ?? readMcpConfigFile;
    this.createClient = options.dependencies?.createClient ?? createMCPClient;
    this.createTransport = options.dependencies?.createTransport ?? defaultCreateTransport;
    this.createAuthProvider = options.dependencies?.createAuthProvider;
    this.scheduleDeadline = options.dependencies?.scheduleDeadline ?? defaultScheduleDeadline;
    this.reportFatalError = options.reportFatalError;
  }

  init(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.stopped) throw new Error("MCP registry has been shut down");
      if (this.initialized) return;

      const read = await this.readConfig(this.configPath);
      await read.match({
        err: (error) => async () => {
          this.configStatus = configErrorStatus(error);
          this.initialized = true;
        },
        ok: (snapshot) => async () => {
          this.configStatus = Object.freeze({ status: "valid" });
          const definitions = Object.values(snapshot.config.servers).sort((left, right) =>
            left.id.localeCompare(right.id),
          );
          await Promise.all(
            definitions.map(async (definition) => {
              const result = await this.initializeCandidate(definition);
              this.entries.set(definition.id, this.entryFromResult(definition, result));
              this.publishSnapshots();
            }),
          );
          this.initialized = true;
          this.publishSnapshots();
        },
      })();
    });
  }

  waitUntilInitialized(): Promise<ResultType<void, McpRegistryStateError>> {
    return this.runLifecycle(async () => {
      return this.runningResult();
    });
  }

  reload(
    serverId?: string,
  ): Promise<ResultType<readonly McpReloadOutcome[], McpRegistryReloadFailure>> {
    return this.runLifecycle(async () => {
      const running = this.runningResult();
      const stateFailure = running.match({ ok: () => null, err: (error) => Result.err(error) });
      if (stateFailure) return stateFailure;
      const read = await this.readConfig(this.configPath);
      return read.match<
        () => Promise<ResultType<readonly McpReloadOutcome[], McpRegistryReloadFailure>>
      >({
        err: (error) => async () => {
          const configStatus = configErrorStatus(error);
          this.configStatus = configStatus;
          return Result.err(
            new McpRegistryReloadError({
              configPath: this.configPath,
              cause: error,
              message: configStatus.error,
            }),
          );
        },
        ok: (snapshot) => async () => {
          this.configStatus = Object.freeze({ status: "valid" });
          const ids = new Set<string>();
          if (serverId === undefined) {
            for (const id of this.entries.keys()) ids.add(id);
            for (const id of Object.keys(snapshot.config.servers)) ids.add(id);
          } else {
            ids.add(serverId);
          }

          const outcomes = await Promise.all(
            [...ids].sort().map((id) => this.reconcileServer(id, snapshot.config.servers[id])),
          );
          this.publishSnapshots();
          return Result.ok(Object.freeze(outcomes));
        },
      })();
    });
  }

  list(): readonly McpServerStatus[] {
    return this.statusSnapshot;
  }

  getConfigStatus(): McpRegistryConfigStatus {
    return this.configStatus;
  }

  getCatalogServers(): readonly McpCatalogServer[] {
    return this.catalogServerSnapshot;
  }

  getTools(): readonly McpCatalogTool[] {
    return this.toolSnapshot;
  }

  shutdown(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.stopped) return;
      this.stopped = true;
      const entries = [...this.entries.values()];
      this.entries.clear();
      this.publishSnapshots();

      const failures: string[] = [];
      await Promise.all(
        entries.map(async (entry) => {
          const closeError = this.cleanupErrorText(await this.closeEntry(entry));
          if (closeError !== undefined) failures.push(`${entry.definition.id}: ${closeError}`);
        }),
      );
      if (failures.length > 0) {
        throw new Error(`Failed to close MCP clients: ${failures.sort().join("; ")}`);
      }
    });
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    const observed = Result.tryPromise({
      try: () => result,
      catch: () => new Error("MCP registry lifecycle operation rejected"),
    });
    this.lifecycleQueue = observed.then(() => undefined);
    return result;
  }

  private runningResult(): ResultType<void, McpRegistryStateError> {
    if (this.stopped) {
      return Result.err(
        new McpRegistryStateError({
          state: "stopped",
          message: "MCP registry has been shut down",
        }),
      );
    }
    if (!this.initialized) {
      return Result.err(
        new McpRegistryStateError({
          state: "not-initialized",
          message: "MCP registry has not been initialized",
        }),
      );
    }
    return Result.ok(undefined);
  }

  private async reconcileServer(
    serverId: string,
    definition: McpServerDefinition | undefined,
  ): Promise<McpReloadOutcome> {
    const current = this.entries.get(serverId);
    if (!definition) {
      if (!current) {
        return freezeOutcome({ serverId, reconciliation: "not_found", result: "not_found" });
      }

      this.entries.delete(serverId);
      this.publishSnapshots();
      const closeError = this.cleanupErrorText(await this.closeEntry(current));
      return freezeOutcome({
        serverId,
        reconciliation: "removed",
        result: "removed",
        ...(closeError === undefined ? {} : { error: closeError }),
      });
    }

    let reconciliation = this.classifyReconciliation(current, definition);
    let resolvedTransport: ResolvedTransport | undefined;
    if (reconciliation === "unchanged" && current) {
      const resolution = await this.resolveTransport(definition);
      const resolutionFailure = resolution.match<() => McpReloadOutcome | null>({
        err: (error) => () =>
          freezeOutcome({
            serverId,
            reconciliation,
            result: "retained",
            error: safeErrorText(error, current.sensitiveValues),
          }),
        ok: () => () => null,
      })();
      if (resolutionFailure) return resolutionFailure;
      resolvedTransport = resolution.match({ ok: (value) => value, err: () => undefined });
      const fingerprintChanged = resolution.match({
        ok: (value) => current.transportFingerprint !== transportFingerprint(value.input),
        err: () => false,
      });
      if (fingerprintChanged) {
        reconciliation = "changed";
      }
    }
    if (reconciliation === "unchanged" && current) {
      if (!current.client) {
        return freezeOutcome({
          serverId,
          reconciliation,
          result: "unavailable",
          error: `Available MCP server ${JSON.stringify(serverId)} has no client`,
        });
      }
      const retainedClient = current.client;
      {
        const captured = await Result.tryPromise({
          try: async () => {
            const discovered = await this.withDeadline(definition.id, (signal) =>
              this.discoverTools(definition, retainedClient, signal),
            );
            const discoveryFailure = discovered.match<() => McpReloadOutcome | null>({
              err: (error) => () =>
                freezeOutcome({
                  serverId,
                  reconciliation,
                  result: "retained",
                  error: error.message,
                }),
              ok: () => () => null,
            });
            const failed = discoveryFailure();
            if (failed) return failed;
            const tools = discovered.match({ ok: (value) => value, err: () => [] });
            if (this.entries.get(serverId) !== current || current.status.status !== "available") {
              return freezeOutcome({
                serverId,
                reconciliation,
                result: "unavailable",
                error: "MCP server became unavailable while refreshing its tool manifest",
              });
            }
            this.entries.set(serverId, {
              ...current,
              definition,
              fingerprint: definitionFingerprint(definition),
              tools,
              status: Object.freeze({
                serverId,
                transport: definition.transportConfig.transport,
                status: "available",
                toolCount: tools.length,
              }),
            });
            this.publishSnapshots();
            return freezeOutcome({ serverId, reconciliation, result: "available" });
          },
          catch: captureError,
        });

        if (captured.isErr()) {
          const error = captured.error.cause;
          rethrowPanic(error);
          const latest = this.entries.get(serverId);
          if (!latest || latest.client !== retainedClient || latest.status.status !== "available") {
            return freezeOutcome({
              serverId,
              reconciliation,
              result:
                latest?.status.status === "authentication_required"
                  ? "authentication_required"
                  : "unavailable",
              error:
                latest?.status.status === "unavailable" ||
                latest?.status.status === "authentication_required"
                  ? latest.status.error
                  : "MCP server became unavailable while refreshing its tool manifest",
            });
          }
          return freezeOutcome({
            serverId,
            reconciliation,
            result: "retained",
            error: safeErrorText(error, current.sensitiveValues),
          });
        }
        return captured.value;
      }
    }

    let priorCloseError: string | undefined;
    if (reconciliation === "unavailable" && current) {
      priorCloseError = this.cleanupErrorText(await this.closeEntry(current));
      this.entries.set(serverId, { ...current, client: undefined });
    }

    const result = await this.initializeCandidate(definition, resolvedTransport);
    if (!result.ok) {
      if (reconciliation === "changed" && current?.status.status === "available") {
        return freezeOutcome({
          serverId,
          reconciliation,
          result: "retained",
          error: result.error,
        });
      }

      this.entries.set(serverId, this.entryFromResult(definition, result));
      this.publishSnapshots();
      return freezeOutcome({
        serverId,
        reconciliation,
        result: result.status,
        error:
          priorCloseError === undefined
            ? result.error
            : `${result.error}; failed to close previous client: ${priorCloseError}`,
      });
    }

    const replacement = this.entryFromResult(definition, result);
    this.entries.set(serverId, replacement);
    this.publishSnapshots();
    const closeError =
      current && reconciliation !== "unavailable"
        ? this.cleanupErrorText(await this.closeEntry(current))
        : undefined;
    const cleanupError = closeError ?? priorCloseError;
    return freezeOutcome({
      serverId,
      reconciliation,
      result: "available",
      ...(cleanupError === undefined ? {} : { error: cleanupError }),
    });
  }

  private classifyReconciliation(
    current: RegistryEntry | undefined,
    definition: McpServerDefinition,
  ): McpReloadReconciliation {
    if (!current) return "new";
    if (current.status.status !== "available") return "unavailable";
    return current.fingerprint === definitionFingerprint(definition) ? "unchanged" : "changed";
  }

  private async initializeCandidate(
    definition: McpServerDefinition,
    prefetchedTransport?: ResolvedTransport,
  ): Promise<CandidateResult> {
    let phase: McpRegistryPhase = "configuration";
    let sensitiveValues: readonly string[] = [];
    let client: McpRegistryClient | undefined;
    const holder: {
      client?: McpRegistryClient;
      panic?: Panic;
      terminalFailure?: McpRegistryTerminalFailure;
      sessionExpired?: boolean;
    } = {};

    {
      const captured = await Result.tryPromise({
        try: async () => {
          const resolution: ResultType<ResolvedTransport, McpRegistryTransportError> =
            prefetchedTransport
              ? Result.ok(prefetchedTransport)
              : await this.resolveTransport(definition);
          return await resolution.match<() => Promise<CandidateResult>>({
            err: (error) => async () => ({
              ok: false,
              status: this.failureStatus(definition, error),
              phase,
              error: safeErrorText(error),
            }),
            ok: (resolved) => async () => {
              sensitiveValues = resolved.sensitiveValues;
              const transport = enforceModernMcpResultContract(
                observeHttpSessionExpiration(
                  withMcpSessionHeaders(this.createTransport(resolved.input)),
                  () => {
                    holder.sessionExpired = true;
                  },
                ),
              );
              phase = "connection";

              const candidate = await this.withDeadline(
                definition.id,
                async (signal) => {
                  const createdClient: McpRegistryClient = await this.createClient({
                    transport,
                    clientName: `lilac-mcp-${definition.id}`,
                    maxRetries: 0,
                    protocolVersionDiscovery: true,
                    onUncaughtError: <TError>(error: TError) => {
                      if (
                        isOptionalHttpInboundSseError(
                          definition,
                          holder.sessionExpired === true,
                          error,
                        )
                      ) {
                        return;
                      }
                      retainTransportPanic(error, holder);
                      rethrowPanic(error);
                      const failure = new McpRegistryTerminalFailure({
                        status: this.failureStatus(definition, error),
                        message: safeErrorText(error, sensitiveValues),
                      });
                      holder.terminalFailure = failure;
                      if (holder.client)
                        this.handleTerminalFailure(definition.id, holder.client, failure);
                    },
                  });
                  rethrowPanic(holder.panic);
                  client = createdClient;
                  holder.client = createdClient;
                  this.observeTransportClose(definition.id, createdClient, transport);
                  if (signal.aborted) this.closeClientInBackground(createdClient);
                  signal.throwIfAborted();
                  if (holder.terminalFailure) return Result.err(holder.terminalFailure);

                  phase = "discovery";
                  return await decodeMcpServerInfo(createdClient.serverInfo).match<
                    () => Promise<ResultType<InitializedCandidate, McpRegistryDiscoveryError>>
                  >({
                    err: (error) => async () => Result.err(error),
                    ok: (serverInfo) => async () => {
                      const tools = await this.discoverTools(
                        definition,
                        createdClient,
                        signal,
                        holder,
                      );
                      return tools.map(
                        (value) =>
                          ({
                            client: createdClient,
                            serverInfo,
                            sensitiveValues: Object.freeze([...sensitiveValues]),
                            transportFingerprint: transportFingerprint(resolved.input),
                            tools: value,
                          }) satisfies InitializedCandidate,
                      );
                    },
                  })();
                },
                () => {
                  if (isCustomTransport(transport)) this.closeTransportInBackground(transport);
                },
              );
              return candidate.match<CandidateResult>({
                err: (error) => {
                  if (client) this.closeClientInBackground(client);
                  return {
                    ok: false,
                    status:
                      error._tag === "McpRegistryTerminalFailure" ? error.status : "unavailable",
                    phase,
                    error: error.message,
                  };
                },
                ok: (value) => ({ ok: true, candidate: value }),
              });
            },
          })();
        },
        catch: captureError,
      });

      if (captured.isErr()) {
        const error = holder.panic ?? captured.error.cause;
        if (client) {
          this.closeClientInBackground(client);
        }
        rethrowPanic(error);
        return {
          ok: false,
          status: this.failureStatus(definition, error),
          phase,
          error: safeErrorText(error, sensitiveValues),
        };
      }
      return captured.value;
    }
  }

  private async resolveTransport(
    definition: McpServerDefinition,
  ): Promise<ResultType<ResolvedTransport, McpRegistryTransportError>> {
    const config = definition.transportConfig;
    if (config.transport === "stdio") {
      const resolved = await resolveMcpValueSourceMap(config.env, this.valueContext);
      return resolved
        .mapError(
          (error) =>
            new McpRegistryTransportConfigurationError({
              serverId: definition.id,
              cause: error,
              message: `Failed to resolve stdio environment: ${error.message}`,
            }),
        )
        .map<ResolvedTransport>((env) => ({
          input: {
            transport: "stdio",
            command: config.command,
            args: config.args,
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            env,
          },
          sensitiveValues: Object.freeze(Object.values(env)),
        }));
    }

    const resolved = await resolveMcpValueSourceMap(config.headers, this.valueContext);
    const headersResult = resolved.mapError(
      (error) =>
        new McpRegistryTransportConfigurationError({
          serverId: definition.id,
          cause: error,
          message: `Failed to resolve HTTP headers: ${error.message}`,
        }),
    );
    return headersResult.match({
      err: (error) => async () => Result.err(error),
      ok: (headers) => async () => {
        const quotedServerId = JSON.stringify(definition.id);
        const validHeaders = validateHttpHeaders(headers).mapError(
          (error) =>
            new McpRegistryTransportConfigurationError({
              serverId: definition.id,
              cause: error,
              message: `Invalid HTTP headers: ${error.message}`,
            }),
        );
        const headerFailure = validHeaders.match({
          ok: () => null,
          err: (error) => Result.err(error),
        });
        if (headerFailure) return headerFailure;

        let authProvider;
        if (config.auth) {
          const providerResult = await Result.tryPromise({
            try: async () =>
              await this.createAuthProvider?.({
                server: definition,
                configPath: this.configPath,
                valueContext: this.valueContext,
              }),
            catch: (cause) =>
              Panic.is(cause)
                ? ({ kind: "panic", panic: cause } as const)
                : ({
                    kind: "failure",
                    error: new McpRegistryAuthProviderCreateError({
                      serverId: definition.id,
                      cause,
                      message: `Failed to create OAuth provider for MCP server ${quotedServerId}`,
                    }),
                  } as const),
          });
          const providerOutcome = providerResult.match<
            | {
                readonly kind: "success";
                readonly provider: import("better-result").InferOk<typeof providerResult>;
              }
            | { readonly kind: "panic"; readonly panic: Panic }
            | { readonly kind: "failure"; readonly error: McpRegistryAuthProviderCreateError }
          >({
            ok: (provider) => ({ kind: "success", provider }),
            err: (failure) => failure,
          });
          if (providerOutcome.kind === "panic") {
            rethrowPanic(providerOutcome.panic);
            return Result.err(
              new McpRegistryAuthProviderCreateError({
                serverId: definition.id,
                cause: providerOutcome.panic,
                message: `Failed to create OAuth provider for MCP server ${quotedServerId}`,
              }),
            );
          }
          if (providerOutcome.kind === "failure") return Result.err(providerOutcome.error);
          authProvider = providerOutcome.provider;
          if (!authProvider) {
            return Result.err(new McpAuthenticationRequiredError(definition.id));
          }
          const provider = authProvider;
          const tokensResult = await Result.tryPromise({
            try: async () => await provider.tokens(),
            catch: (cause) =>
              Panic.is(cause)
                ? ({ kind: "panic", panic: cause } as const)
                : ({
                    kind: "failure",
                    error: new McpRegistryAuthTokensReadError({
                      serverId: definition.id,
                      cause,
                      message: `Failed to read OAuth tokens for MCP server ${quotedServerId}`,
                    }),
                  } as const),
          });
          const tokensOutcome = tokensResult.match<
            | {
                readonly kind: "success";
                readonly tokens: import("better-result").InferOk<typeof tokensResult>;
              }
            | { readonly kind: "panic"; readonly panic: Panic }
            | { readonly kind: "failure"; readonly error: McpRegistryAuthTokensReadError }
          >({
            ok: (tokens) => ({ kind: "success", tokens }),
            err: (failure) => failure,
          });
          if (tokensOutcome.kind === "panic") {
            rethrowPanic(tokensOutcome.panic);
            return Result.err(
              new McpRegistryAuthTokensReadError({
                serverId: definition.id,
                cause: tokensOutcome.panic,
                message: `Failed to read OAuth tokens for MCP server ${quotedServerId}`,
              }),
            );
          }
          if (tokensOutcome.kind === "failure") return Result.err(tokensOutcome.error);
          const { tokens } = tokensOutcome;
          if (!tokens) {
            return Result.err(new McpAuthenticationRequiredError(definition.id));
          }
        }

        return Result.ok<ResolvedTransport>({
          input: {
            transport: "http",
            url: config.url,
            headers,
            ...(authProvider === undefined ? {} : { authProvider }),
          },
          sensitiveValues: Object.freeze(Object.values(headers)),
        });
      },
    })();
  }

  private async listAllTools(
    client: McpRegistryClient,
    signal: AbortSignal,
    holder: { readonly terminalFailure?: McpRegistryTerminalFailure },
  ): Promise<ResultType<ListToolsResult, McpRegistryDiscoveryError>> {
    const tools: ListToolsResult["tools"] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      signal.throwIfAborted();
      if (holder.terminalFailure) return Result.err(holder.terminalFailure);
      const page = await client.listTools({
        ...(cursor === undefined ? {} : { params: { cursor } }),
        options: { signal },
      });
      tools.push(...page.tools);
      const nextCursor = page.nextCursor;
      if (nextCursor === undefined) break;
      if (seenCursors.has(nextCursor)) {
        return Result.err(
          new McpRegistryDiscoveryInvalid({
            reason: "repeated-cursor",
            message: "MCP tools/list returned a repeated cursor",
          }),
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    signal.throwIfAborted();
    if (holder.terminalFailure) return Result.err(holder.terminalFailure);
    return Result.ok({ tools });
  }

  private async discoverTools(
    definition: McpServerDefinition,
    client: McpRegistryClient,
    signal: AbortSignal,
    holder: { readonly terminalFailure?: McpRegistryTerminalFailure } = {},
  ): Promise<ResultType<readonly McpCatalogTool[], McpRegistryDiscoveryError>> {
    const definitions = await this.listAllTools(client, signal, holder);
    return definitions.andThen((value) => {
      const names = new Set<string>();
      for (const toolDefinition of value.tools) {
        if (names.has(toolDefinition.name)) {
          return Result.err(
            new McpRegistryDiscoveryInvalid({
              reason: "duplicate-tool",
              message: `MCP tools/list returned duplicate tool name ${JSON.stringify(toolDefinition.name)}`,
            }),
          );
        }
        names.add(toolDefinition.name);
      }

      const sdkTools = client.toolsFromDefinitions(value);
      const tools: McpCatalogTool[] = [];
      for (const toolDefinition of value.tools) {
        const sdkTool = sdkTools[toolDefinition.name];
        if (!sdkTool) {
          return Result.err(
            new McpRegistryDiscoveryInvalid({
              reason: "missing-conversion",
              message: `MCP tool conversion omitted ${JSON.stringify(toolDefinition.name)}`,
            }),
          );
        }
        const identity = Object.freeze({
          source: "mcp",
          sourceId: definition.id,
          rawToolName: toolDefinition.name,
        } satisfies CatalogToolIdentity);
        const title = toolDefinition.title ?? toolDefinition.annotations?.title;
        tools.push(
          Object.freeze({
            serverId: definition.id,
            rawName: toolDefinition.name,
            ...(title === undefined ? {} : { title }),
            ...(toolDefinition.description === undefined
              ? {}
              : { description: toolDefinition.description }),
            identity,
            stableId: catalogToolStableId(identity),
            tool: this.wrapToolExecution(definition.id, client, sdkTool),
          } satisfies McpCatalogTool),
        );
      }
      return Result.ok(Object.freeze(tools));
    });
  }

  private wrapToolExecution(
    serverId: string,
    client: McpRegistryClient,
    sdkTool: McpConvertedTool,
  ): McpConvertedTool {
    const execute = sdkTool.execute;
    if (!execute) return sdkTool;
    return {
      ...sdkTool,
      execute: (...args: Parameters<typeof execute>) => {
        const observeExecution = async <T>(result: Promise<T>): Promise<T> => {
          const captured = await Result.tryPromise({
            try: () => result,
            catch: captureError,
          });
          const outcome = captured.match<
            | { readonly kind: "success"; readonly value: T }
            | { readonly kind: "failure"; readonly failure: { readonly cause: unknown } }
          >({
            ok: (value) => ({ kind: "success", value }),
            err: (failure) => ({ kind: "failure", failure }),
          });
          if (outcome.kind === "success") return outcome.value;
          const cause = outcome.failure.cause;
          rethrowPanic(cause);
          if (!mcpNonTerminalExecutionErrorSchema.safeParse(cause).success) {
            const current = this.entries.get(serverId);
            if (current?.client === client) {
              this.handleTerminalFailure(
                serverId,
                client,
                new McpRegistryTerminalFailure({
                  status: this.failureStatus(current.definition, cause),
                  message: safeErrorText(cause, current.sensitiveValues),
                }),
              );
            }
          }
          return await result;
        };
        {
          const captured = Result.try({
            try: () => {
              const result = execute(...args);
              if (result instanceof Promise) {
                return observeExecution(result);
              }
              return result;
            },
            catch: captureError,
          });

          if (captured.isErr()) {
            const error = captured.error.cause;
            rethrowPanic(error);
            if (!mcpNonTerminalExecutionErrorSchema.safeParse(error).success) {
              const current = this.entries.get(serverId);
              if (current?.client === client) {
                this.handleTerminalFailure(
                  serverId,
                  client,
                  new McpRegistryTerminalFailure({
                    status: this.failureStatus(current.definition, error),
                    message: safeErrorText(error, current.sensitiveValues),
                  }),
                );
              }
            }
            throw error;
          }
          return captured.value;
        }
      },
    };
  }

  private withDeadline<T>(
    serverId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    onDeadline?: () => void,
  ): Promise<T> {
    const controller = new AbortController();
    let rejectDeadline: (error: Error) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const cancelDeadline = this.scheduleDeadline(() => {
      const error = new McpRegistryDeadlineError(serverId, this.initDeadlineMs);
      controller.abort(error);
      onDeadline?.();
      rejectDeadline(error);
    }, this.initDeadlineMs);
    const pending = operation(controller.signal);
    return Promise.race([pending, deadline]).finally(cancelDeadline);
  }

  private failureStatus(
    definition: McpServerDefinition,
    error: unknown,
  ): "unavailable" | "authentication_required" {
    return error instanceof McpAuthenticationRequiredError ||
      (error instanceof UnauthorizedError &&
        definition.transportConfig.transport === "http" &&
        definition.transportConfig.auth?.grant === "authorization_code")
      ? "authentication_required"
      : "unavailable";
  }

  private entryFromResult(definition: McpServerDefinition, result: CandidateResult): RegistryEntry {
    if (!result.ok) {
      return {
        definition,
        fingerprint: definitionFingerprint(definition),
        sensitiveValues: Object.freeze([]),
        status: Object.freeze({
          serverId: definition.id,
          transport: definition.transportConfig.transport,
          status: result.status,
          phase: result.phase,
          error: result.error,
        }),
        tools: Object.freeze([]),
      };
    }

    return {
      definition,
      fingerprint: definitionFingerprint(definition),
      transportFingerprint: result.candidate.transportFingerprint,
      client: result.candidate.client,
      serverInfo: result.candidate.serverInfo,
      sensitiveValues: result.candidate.sensitiveValues,
      status: Object.freeze({
        serverId: definition.id,
        transport: definition.transportConfig.transport,
        status: "available",
        toolCount: result.candidate.tools.length,
      }),
      tools: result.candidate.tools,
    };
  }

  private observeTransportClose(
    serverId: string,
    client: McpRegistryClient,
    transport: MCPClientConfig["transport"],
  ): void {
    if (!isCustomTransport(transport)) return;
    const sdkOnClose = transport.onclose;
    transport.onclose = () => {
      this.handleTerminalFailure(
        serverId,
        client,
        new McpRegistryTerminalFailure({
          status: "unavailable",
          message: "MCP transport closed",
        }),
      );
      sdkOnClose?.();
    };
  }

  private handleTerminalFailure(
    serverId: string,
    client: McpRegistryClient,
    failure: McpRegistryTerminalFailure,
  ): void {
    const current = this.entries.get(serverId);
    if (!current || current.client !== client || current.status.status !== "available") return;

    this.entries.set(serverId, {
      ...current,
      status: Object.freeze({
        serverId,
        transport: current.definition.transportConfig.transport,
        status: failure.status,
        phase: "runtime",
        error: failure.message,
      }),
      tools: Object.freeze([]),
    });
    this.publishSnapshots();
    const observeClose = async (): Promise<void> => {
      const closed = await Result.tryPromise({
        try: () => this.closeClientOnce(client),
        catch: captureError,
      });
      const failure = closed.match({ ok: () => null, err: ({ cause }) => cause });
      if (!failure) return;
      if (Panic.is(failure)) {
        this.reportCleanupPanic(failure);
        return;
      }
      const latest = this.entries.get(serverId);
      if (!latest || latest.client !== client || latest.status.status === "available") return;
      this.entries.set(serverId, {
        ...latest,
        status: Object.freeze({
          ...latest.status,
          error: `${latest.status.error}; cleanup failed: ${safeErrorText(failure, latest.sensitiveValues)}`,
        }),
      });
      this.publishSnapshots();
    };
    void observeClose();
  }

  private async closeEntry(entry: RegistryEntry): Promise<string | Panic | undefined> {
    if (!entry.client) return undefined;
    {
      const captured = await Result.tryPromise({
        try: async () => {
          await this.closeClientWithinDeadline(entry.definition.id, entry.client!);
          return undefined;
        },
        catch: captureError,
      });

      if (captured.isErr()) {
        const error = captured.error.cause;
        if (Panic.is(error)) {
          this.reportCleanupPanic(error);
          return error;
        }
        return safeErrorText(error, entry.sensitiveValues);
      }
      return captured.value;
    }
  }

  private cleanupErrorText(error: string | Panic | undefined): string | undefined {
    if (Panic.is(error)) {
      rethrowPanic(error);
      return undefined;
    }
    return error;
  }

  private async closeClientOnce(client: McpRegistryClient): Promise<void> {
    const existing = this.clientClosures.get(client);
    if (existing) return existing;
    const invokeClose = async (): Promise<void> => await client.close();
    const closure = invokeClose();
    this.clientClosures.set(client, closure);
    await closure;
  }

  private reportCleanupPanic(panic: Panic): void {
    if (this.reportedCleanupPanics.has(panic)) return;
    this.reportedCleanupPanics.add(panic);
    this.reportFatalError(panic);
  }

  private closeClientInBackground(client: McpRegistryClient): void {
    void this.observeBackgroundClose(() => this.closeClientOnce(client));
  }

  private closeClientWithinDeadline(serverId: string, client: McpRegistryClient): Promise<void> {
    let rejectDeadline: (error: Error) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const cancelDeadline = this.scheduleDeadline(() => {
      rejectDeadline(new McpRegistryCloseDeadlineError(serverId, this.initDeadlineMs));
    }, this.initDeadlineMs);
    return Promise.race([this.closeClientOnce(client), deadline]).finally(cancelDeadline);
  }

  private async closeTransportOnce(transport: MCPTransport): Promise<void> {
    const existing = this.transportClosures.get(transport);
    if (existing) return existing;
    const invokeClose = async (): Promise<void> => await transport.close();
    const closure = invokeClose();
    this.transportClosures.set(transport, closure);
    await closure;
  }

  private closeTransportInBackground(transport: MCPTransport): void {
    void this.observeBackgroundClose(() => this.closeTransportOnce(transport));
  }

  private async observeBackgroundClose(close: () => Promise<void>): Promise<void> {
    const closed = await Result.tryPromise({
      try: close,
      catch: captureError,
    });
    const failure = closed.match({ ok: () => null, err: ({ cause }) => cause });
    if (failure && Panic.is(failure)) this.reportCleanupPanic(failure);
  }

  private publishSnapshots(): void {
    const entries = [...this.entries.values()].sort((left, right) =>
      left.definition.id.localeCompare(right.definition.id),
    );
    this.statusSnapshot = Object.freeze(entries.map((entry) => entry.status));
    this.catalogServerSnapshot = Object.freeze(
      entries.flatMap((entry) => {
        if (entry.status.status !== "available" || !entry.serverInfo) return [];
        const description = entry.definition.description ?? entry.serverInfo.description;
        return [
          Object.freeze({
            serverId: entry.definition.id,
            serverInfo: entry.serverInfo,
            ...(description === undefined ? {} : { description }),
          } satisfies McpCatalogServer),
        ];
      }),
    );
    this.toolSnapshot = Object.freeze(
      entries.flatMap((entry) => (entry.status.status === "available" ? entry.tools : [])),
    );
  }
}
