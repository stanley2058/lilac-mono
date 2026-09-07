import { captureError } from "../shared/error-capture.js";
import { z } from "zod";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  MCP_CONFIG_VERSION,
  MCP_MAX_SERVER_ID_LENGTH,
  type McpServerDefinition,
  type UniversalMcpConfig,
} from "./config-types";
import { opaqueErrorMessage } from "./error-format";

export const mcpServerIdSchema = z
  .string()
  .min(1)
  .max(MCP_MAX_SERVER_ID_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "server IDs must start with a letter or digit and contain only letters, digits, '_', or '-'",
  );

const jsonPointerSchema = z.string().refine(
  (pointer) =>
    pointer === "" ||
    (pointer.startsWith("/") &&
      !pointer
        .slice(1)
        .split("/")
        .some((part) => /~(?:[^01]|$)/.test(part))),
  "pointer must be an RFC 6901 JSON Pointer",
);

export const mcpValueSourceSchema = z.union([
  z.string(),
  z.strictObject({ env: z.string().min(1) }),
  z.strictObject({ file: z.string().min(1), pointer: jsonPointerSchema.optional() }),
]);

const staticOAuthClientSchema = z.strictObject({
  type: z.literal("static"),
  clientId: mcpValueSourceSchema,
  clientSecret: mcpValueSourceSchema.optional(),
});

const dynamicOAuthClientSchema = z.strictObject({ type: z.literal("dynamic") });

const authorizationCodeAuthSchema = z.strictObject({
  type: z.literal("oauth"),
  grant: z.literal("authorization_code"),
  scopes: z.array(z.string().min(1)).optional(),
  client: z.union([staticOAuthClientSchema, dynamicOAuthClientSchema]),
});

export const mcpAuthConfigSchema = authorizationCodeAuthSchema;

const stdioServerInputSchemaV1 = z.strictObject({
  transport: z.literal("stdio"),
  allowSubagents: z.boolean().default(false),
  description: z.string().trim().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string().min(1), mcpValueSourceSchema).optional(),
});

const httpServerInputObjectSchemaV1 = z.strictObject({
  transport: z.literal("http"),
  allowSubagents: z.boolean().default(false),
  description: z.string().trim().min(1).optional(),
  url: z.string().min(1),
  headers: z.record(z.string().min(1), mcpValueSourceSchema).optional(),
  auth: mcpAuthConfigSchema.optional(),
});

function validateHttpServerInputV1(
  value: z.infer<typeof httpServerInputObjectSchemaV1>,
  context: z.RefinementCtx,
): void {
  if (!URL.canParse(value.url)) {
    context.addIssue({ code: "custom", path: ["url"], message: "url must be an absolute URL" });
    return;
  }
  const url = new URL(value.url);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "url must use http: or https:; HTTP+SSE is not a supported transport",
    });
  }

  if (!value.auth) return;
  for (const header of Object.keys(value.headers ?? {})) {
    if (header.toLowerCase() !== "authorization") continue;
    context.addIssue({
      code: "custom",
      path: ["headers", header],
      message: "an Authorization header cannot be combined with OAuth configuration",
    });
  }
}

const httpServerInputSchemaV1 =
  httpServerInputObjectSchemaV1.superRefine(validateHttpServerInputV1);

export const mcpServerInputSchemaV1 = z.discriminatedUnion("transport", [
  stdioServerInputSchemaV1,
  httpServerInputSchemaV1,
]);

export const mcpConfigInputSchemaV1 = z.strictObject({
  configVersion: z.literal(MCP_CONFIG_VERSION),
  servers: z.record(mcpServerIdSchema, mcpServerInputSchemaV1).optional(),
});

export type McpConfigInputV1 = z.infer<typeof mcpConfigInputSchemaV1>;
export type McpServerInputV1 = z.infer<typeof mcpServerInputSchemaV1>;

export type McpConfigParseResult =
  | { ok: true; config: UniversalMcpConfig }
  | { ok: false; issues: readonly string[] };

const configVersionProbeSchema = z.object({ configVersion: z.number().int() });

function formatZodIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const issuePath = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `${issuePath}: ${issue.message}`;
  });
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

function toUniversalConfig(input: McpConfigInputV1): UniversalMcpConfig {
  const servers: Record<string, McpServerDefinition> = {};

  for (const id of Object.keys(input.servers ?? {}).sort()) {
    const server = input.servers?.[id];
    if (!server) continue;

    servers[id] = {
      id,
      allowSubagents: server.allowSubagents,
      ...(server.description === undefined ? {} : { description: server.description }),
      transportConfig:
        server.transport === "stdio"
          ? {
              transport: "stdio",
              command: server.command,
              args: [...(server.args ?? [])],
              ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
              env: sortRecord(server.env ?? {}),
            }
          : {
              transport: "http",
              url: server.url,
              headers: sortRecord(server.headers ?? {}),
              ...(server.auth === undefined ? {} : { auth: server.auth }),
            },
    };
  }

  return { configVersion: MCP_CONFIG_VERSION, servers };
}

type McpConfigSerializationInput = Omit<UniversalMcpConfig, "configVersion"> & {
  readonly configVersion: number;
};

export class McpConfigSerializationFailed extends TaggedError("McpConfigSerializationFailed")<{
  readonly reason: "id-mismatch" | "invalid-output" | "unsupported-version";
  readonly message: string;
}> {}

function toConfigInputV1(
  config: McpConfigSerializationInput,
): ResultType<McpConfigInputV1, McpConfigSerializationFailed> {
  const servers: Record<string, McpServerInputV1> = {};
  for (const id of Object.keys(config.servers).sort()) {
    const server = config.servers[id];
    if (!server) continue;
    if (server.id !== id) {
      return Result.err(
        new McpConfigSerializationFailed({
          reason: "id-mismatch",
          message: `Cannot serialize MCP server ${JSON.stringify(id)} with mismatched ID ${JSON.stringify(server.id)}`,
        }),
      );
    }

    const transport = server.transportConfig;
    servers[id] =
      transport.transport === "stdio"
        ? {
            transport: "stdio",
            allowSubagents: server.allowSubagents,
            ...(server.description === undefined ? {} : { description: server.description }),
            command: transport.command,
            ...(transport.args.length === 0 ? {} : { args: [...transport.args] }),
            ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
            ...(Object.keys(transport.env).length === 0 ? {} : { env: sortRecord(transport.env) }),
          }
        : {
            transport: "http",
            allowSubagents: server.allowSubagents,
            ...(server.description === undefined ? {} : { description: server.description }),
            url: transport.url,
            ...(Object.keys(transport.headers).length === 0
              ? {}
              : { headers: sortRecord(transport.headers) }),
            ...(transport.auth === undefined
              ? {}
              : {
                  auth: {
                    type: transport.auth.type,
                    grant: transport.auth.grant,
                    client: transport.auth.client,
                    ...(transport.auth.scopes === undefined
                      ? {}
                      : { scopes: [...transport.auth.scopes] }),
                  },
                }),
          };
  }

  return Result.ok({ configVersion: MCP_CONFIG_VERSION, servers });
}

/** Parse an already-decoded YAML document using its required version discriminator. */
export function parseMcpConfigDocument(raw: unknown): McpConfigParseResult {
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      issues: [
        "<root>: the document is empty; use configVersion: 1 with servers: {} for an empty configuration",
      ],
    };
  }

  const versionProbe = configVersionProbeSchema.safeParse(raw);
  if (!versionProbe.success) return { ok: false, issues: formatZodIssues(versionProbe.error) };
  if (versionProbe.data.configVersion !== MCP_CONFIG_VERSION) {
    return {
      ok: false,
      issues: [
        `configVersion: unsupported value ${JSON.stringify(versionProbe.data.configVersion)} (supported: ${MCP_CONFIG_VERSION})`,
      ],
    };
  }

  const parsed = mcpConfigInputSchemaV1.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: formatZodIssues(parsed.error) };
  return { ok: true, config: toUniversalConfig(parsed.data) };
}

export function parseMcpConfigYaml(source: string): McpConfigParseResult {
  const parsed = Result.try({
    try: () => Bun.YAML.parse(source) as unknown,
    catch: captureError,
  });
  return parsed.match<() => McpConfigParseResult>({
    ok: (document) => () => parseMcpConfigDocument(document),
    err: (error) => () => ({
      ok: false as const,
      issues: [`<root>: failed to parse YAML: ${opaqueErrorMessage(error)}`],
    }),
  })();
}

export function serializeMcpConfigYamlResult(
  config: McpConfigSerializationInput,
): ResultType<string, McpConfigSerializationFailed> {
  if (config.configVersion !== MCP_CONFIG_VERSION) {
    return Result.err(
      new McpConfigSerializationFailed({
        reason: "unsupported-version",
        message: `Cannot serialize unsupported MCP configVersion ${JSON.stringify(config.configVersion)} (supported: ${MCP_CONFIG_VERSION})`,
      }),
    );
  }
  return toConfigInputV1(config).andThen((input) => {
    const source = `${Bun.YAML.stringify(input, null, 2)}\n`;
    const reparsed = parseMcpConfigYaml(source);
    if (!reparsed.ok) {
      return Result.err(
        new McpConfigSerializationFailed({
          reason: "invalid-output",
          message: `Serialized MCP configuration is invalid: ${reparsed.issues.join("; ")}`,
        }),
      );
    }
    return Result.ok(source);
  });
}

/** Framework compatibility adapter for callers that require a throwing serializer. */
export function serializeMcpConfigYaml(config: McpConfigSerializationInput): string {
  return serializeMcpConfigYamlResult(config).match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}
