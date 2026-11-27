import { Result, TaggedError } from "better-result";
import {
  ConfigFiles,
  type ConfigFileDocument,
  type ConfigFileError,
} from "../../runtime/config-files";
import type { McpRegistryApi, McpReloadOutcome, McpServerStatus } from "../../mcp/registry-types";

export type NativeConfigDocument = ConfigFileDocument;
export class NativeConfigError extends TaggedError("NativeConfigError")<{
  code: "forbidden" | "invalid" | "conflict" | "io" | "reload";
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
    const result = await this.options.registry.reload();
    return result.mapError((error) => failure("reload", error.message));
  }

  mcpStatus(userId: string): Result<readonly McpServerStatus[], NativeConfigError> {
    if (userId !== this.options.ownerId)
      return Result.err(failure("forbidden", "Only the owner can read MCP status"));
    return Result.ok(this.options.registry.list());
  }
}
