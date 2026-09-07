import { Result, TaggedError } from "better-result";
import { z } from "zod";

export class GatewayFailure extends TaggedError("GatewayFailure")<{
  code:
    | "invalid"
    | "capacity"
    | "unavailable"
    | "not_provisioned"
    | "cancelled"
    | "timeout"
    | "storage"
    | "binding";
  message: string;
  storageReason?: "io" | "unsupported_version" | "corrupt_fields";
}> {}

export const failure = (code: GatewayFailure["code"], message: string) =>
  new GatewayFailure({ code, message });
export const storageFailure = (
  reason: NonNullable<GatewayFailure["storageReason"]>,
  message: string,
) => new GatewayFailure({ code: "storage", storageReason: reason, message });
export const sessionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const idleTimeoutSchema = z.number().int().min(1).max(86400);
export const recordSchema = z.strictObject({
  session: sessionSchema,
  generation: z.string().uuid(),
  containerId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  runtimeId: z.string().uuid().nullable(),
  port: z.number().int().min(1).max(65535),
  state: z.enum(["provisioning", "ready", "terminating"]),
  password: z.string().regex(/^[A-Za-z0-9_-]{8}$/),
  idleSeconds: idleTimeoutSchema,
  expiresAt: z.number().int().nonnegative().safe(),
});
export type RunnerRecord = z.infer<typeof recordSchema>;

export const contentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().max(131072) }),
  z.strictObject({
    type: z.literal("image"),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    data: z.string().max(12582912),
  }),
]);
export const runnerReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    generation: z.string().uuid(),
    content: z.array(contentSchema).max(10).optional(),
    isError: z.boolean().optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    generation: z.string().uuid().optional(),
    error: z.string().max(4096),
  }),
]);
export type RunnerReply = z.infer<typeof runnerReplySchema>;
export type RunnerContent = z.infer<typeof contentSchema>;
export type RunnerRequest =
  | { operation: "info" | "health" }
  | { operation: "execute"; code: string };

export function decodeRecords(value: unknown) {
  const parsed = z.array(recordSchema).safeParse(value);
  if (!parsed.success)
    return Result.err(storageFailure("corrupt_fields", "Invalid computer lifecycle records"));
  return Result.ok(parsed.data);
}

export function decodeRunnerReply(text: string) {
  return Result.gen(function* () {
    const value: unknown = yield* Result.try({
      try: () => JSON.parse(text),
      catch: () => failure("unavailable", "Invalid runner response"),
    });
    const parsed = runnerReplySchema.safeParse(value);
    if (!parsed.success) return Result.err(failure("unavailable", "Invalid runner response"));
    return Result.ok(parsed.data);
  });
}

export type GatewayConfig = {
  bearer: string;
  bindAddress: string;
  renderedHost: string;
  portStart: number;
  portEnd: number;
  image: string;
  database: string;
  seccomp: string;
  owner: string;
  runnerTemplatePath?: string;
};

const configSchema = z.object({
  MCP_BEARER_SECRET: z.string().min(1),
  BIND_ADDR: z.union([z.ipv4(), z.ipv6()]).default("127.0.0.1"),
  RENDERED_HOST: z.string().default("http://localhost"),
  PORT_RANGE_START: z.coerce.number().int().min(1).max(65535).default(17000),
  PORT_RANGE_END: z.coerce.number().int().min(1).max(65535).default(17031),
  RUNNER_TEMPLATE_PATH: z.string().min(1).optional(),
  RUNNER_IMAGE: z.string().min(1).default("lilac-computer:local"),
  DATABASE_PATH: z.string().min(1).default("/data/computer-use.sqlite"),
  SECCOMP_PATH: z.string().min(1).default("/opt/lilac/seccomp-chromium.json"),
  GATEWAY_OWNER: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default("lilac-computer-use"),
});

export function decodeConfig(env: Readonly<Record<string, string | undefined>>) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) return Result.err(failure("invalid", "Invalid gateway configuration"));
  const value = parsed.data;
  if (value.PORT_RANGE_START > value.PORT_RANGE_END || !URL.canParse(value.RENDERED_HOST)) {
    return Result.err(failure("invalid", "Invalid port range or rendered host"));
  }
  const origin = new URL(value.RENDERED_HOST);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    return Result.err(
      failure("invalid", "RENDERED_HOST must contain only an HTTP(S) scheme and hostname"),
    );
  }
  return Result.ok({
    bearer: value.MCP_BEARER_SECRET,
    bindAddress: value.BIND_ADDR,
    renderedHost: origin.origin,
    portStart: value.PORT_RANGE_START,
    portEnd: value.PORT_RANGE_END,
    image: value.RUNNER_IMAGE,
    runnerTemplatePath: value.RUNNER_TEMPLATE_PATH,
    database: value.DATABASE_PATH,
    seccomp: value.SECCOMP_PATH,
    owner: value.GATEWAY_OWNER,
  } satisfies GatewayConfig);
}

export function viewerInfo(record: RunnerRecord, config: GatewayConfig) {
  const url = new URL(config.renderedHost);
  url.port = String(record.port);
  url.pathname = "/vnc.html";
  return {
    status: "ready" as const,
    generation: record.generation,
    viewer_url: url.href,
    idle_timeout_seconds: record.idleSeconds,
    expires_at: new Date(record.expiresAt).toISOString(),
  };
}

export function decodeSessionHeader(value: string | null) {
  const parsed = sessionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
