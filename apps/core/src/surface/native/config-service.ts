import { Result, TaggedError } from "better-result";
import {
  ConfigFiles,
  type ConfigFileDocument,
  type ConfigFileError,
} from "../../runtime/config-files";
import type { McpRegistryApi, McpReloadOutcome, McpServerStatus } from "../../mcp/registry-types";
import type { McpOAuthControl } from "../../mcp/oauth-control";
import type { McpOAuthStartResult } from "../../mcp/oauth-provider";

export type NativeConfigDocument = ConfigFileDocument;
export class NativeConfigError extends TaggedError("NativeConfigError")<{
  code: "forbidden" | "invalid" | "conflict" | "io" | "reload" | "not-found";
  message: string;
  currentRevision?: string;
}> {}

function failure(code: NativeConfigError["code"], message: string): NativeConfigError {
  return new NativeConfigError({ code, message });
}

function fromFileError(error: ConfigFileError): NativeConfigError {
  return new NativeConfigError({
    code: error.code,
    message: error.message,
    ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}),
  });
}

export class NativeConfigService {
  private readonly files: ConfigFiles;

  constructor(
    private readonly options: {
      dataDir: string;
      ownerId: string;
      registry: Pick<McpRegistryApi, "reload" | "list">;
      mcpOAuth?: McpOAuthControl;
    },
  ) {
    this.files = new ConfigFiles({ dataDir: options.dataDir });
  }

  async read(
    userId: string,
    kind: NativeConfigDocument["kind"],
  ): Promise<Result<NativeConfigDocument, NativeConfigError>> {
    if (userId !== this.options.ownerId)
      return Result.err(failure("forbidden", "Only the owner can read configuration"));
    return (await this.files.read(kind)).mapError(fromFileError);
  }

  async save(
    userId: string,
    input: { kind: NativeConfigDocument["kind"]; text: string; expectedRevision: string },
  ): Promise<Result<NativeConfigDocument, NativeConfigError>> {
    if (userId !== this.options.ownerId)
      return Result.err(failure("forbidden", "Only the owner can change configuration"));
    return (await this.files.save(input)).mapError(fromFileError);
  }

  async reloadMcp(userId: string): Promise<Result<readonly McpReloadOutcome[], NativeConfigError>> {
    if (userId !== this.options.ownerId)
      return Result.err(failure("forbidden", "Only the owner can reload MCP configuration"));
    // A server saved with OAuth needs its provider before the registry connects it.
    await this.options.mcpOAuth?.reconcile();
    const result = await this.options.registry.reload();
    return result.mapError((error) => failure("reload", error.message));
  }

  mcpStatus(
    userId: string,
  ): Result<{ servers: readonly McpServerStatus[]; oauthCallbackUrl?: string }, NativeConfigError> {
    if (userId !== this.options.ownerId)
      return Result.err(failure("forbidden", "Only the owner can read MCP status"));
    const callbackUrl = this.options.mcpOAuth?.callbackUrl;
    return Result.ok({
      servers: this.options.registry.list(),
      ...(callbackUrl ? { oauthCallbackUrl: callbackUrl } : {}),
    });
  }

  async authorizeMcp(
    userId: string,
    serverId: string,
  ): Promise<Result<McpOAuthStartResult, NativeConfigError>> {
    if (userId !== this.options.ownerId)
      return Result.err(failure("forbidden", "Only the owner can sign in to MCP servers"));
    const oauth = this.options.mcpOAuth;
    if (!oauth) return Result.err(failure("invalid", "MCP OAuth is not available"));
    const started = await oauth.authorize(serverId);
    // Owner-facing details, such as a server without client registration, explain the next step.
    return started.mapError((error) =>
      failure(error.code === "not-found" ? "not-found" : "invalid", error.message),
    );
  }
}
