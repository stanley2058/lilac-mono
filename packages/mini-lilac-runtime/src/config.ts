import { readFile } from "node:fs/promises";
import path from "node:path";

import { LEVEL1_TOOL_NAMES } from "@stanley2058/lilac-coding-tools";
import { z } from "zod";

const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...LEVEL1_TOOL_NAMES,
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
]);

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase slug");

const environmentVariableSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const modelRefSchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/.+$/u, "must be a provider/model reference");

const profileSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    promptOverlay: z.string().trim().min(1).optional(),
    subagentOnly: z.boolean().default(false),
    tools: z.array(z.string().trim().min(1)),
    execution: z.boolean(),
    workspaceWrites: z.boolean(),
    delegation: z.boolean(),
  })
  .strict();

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "::1" || normalized === "[::1]") return true;

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

export const runtimeConfigSchema = z
  .object({
    configVersion: z.literal(1),
    server: z
      .object({
        host: z.string().trim().min(1),
        port: z.number().int().min(1).max(65_535),
        authTokenEnv: environmentVariableSchema.optional(),
      })
      .strict(),
    providerConfigFile: z.string().trim().min(1),
    providerAuthFile: z.string().trim().min(1),
    agent: z
      .object({
        systemPrompt: z.string().trim().min(1),
        defaultProfile: slugSchema,
        titleModel: modelRefSchema.optional(),
        idleTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(86_400_000)
          .default(15 * 60 * 1000),
        compaction: z
          .object({
            model: z.union([z.literal("inherit"), modelRefSchema]).default("inherit"),
            earlyCompactionPoint: z.number().min(0.05).max(0.95).default(0.8),
          })
          .strict()
          .default({ model: "inherit", earlyCompactionPoint: 0.8 }),
        subagents: z
          .object({
            enabled: z.boolean().default(true),
            maxDepth: z.number().int().min(0).max(16).default(2),
            maxChildrenPerRun: z.number().int().positive().max(10_000).default(8),
            maxConcurrent: z.number().int().positive().max(256).default(4),
            idleTimeoutMs: z.number().int().positive().max(86_400_000).default(360_000),
          })
          .strict()
          .default({
            enabled: true,
            maxDepth: 2,
            maxChildrenPerRun: 8,
            maxConcurrent: 4,
            idleTimeoutMs: 360_000,
          }),
        profiles: z
          .record(slugSchema, profileSchema)
          .refine((profiles) => Object.keys(profiles).length > 0, {
            message: "at least one profile is required",
          }),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.server.authTokenEnv && !isLoopbackHost(config.server.host)) {
      context.addIssue({
        code: "custom",
        path: ["server", "host"],
        message: "non-loopback hosts require server.authTokenEnv",
      });
    }

    const defaultProfile = config.agent.profiles[config.agent.defaultProfile];
    if (!defaultProfile) {
      context.addIssue({
        code: "custom",
        path: ["agent", "defaultProfile"],
        message: `profile '${config.agent.defaultProfile}' is not defined`,
      });
    } else if (defaultProfile.subagentOnly) {
      context.addIssue({
        code: "custom",
        path: ["agent", "defaultProfile"],
        message: "the default profile cannot be subagent-only",
      });
    }

    for (const [profileId, profile] of Object.entries(config.agent.profiles)) {
      profile.tools.forEach((toolName, index) => {
        if (toolName !== "*" && !KNOWN_TOOL_NAMES.has(toolName)) {
          context.addIssue({
            code: "custom",
            path: ["agent", "profiles", profileId, "tools", index],
            message: `unknown tool '${toolName}'`,
          });
        }
      });
    }
  });

export type AgentProfile = z.infer<typeof profileSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type LoadedRuntimeConfig = RuntimeConfig & { configFile: string };

export type LoadRuntimeConfigOptions = {
  env?: Readonly<Record<string, string | undefined>>;
};

function parseYaml(source: string, file: string): unknown {
  try {
    return Bun.YAML.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML file '${file}': ${message}`, { cause: error });
  }
}

export async function loadRuntimeConfig(
  configFile: string,
  options: LoadRuntimeConfigOptions = {},
): Promise<LoadedRuntimeConfig> {
  const absoluteConfigFile = path.resolve(configFile);
  const source = await readFile(absoluteConfigFile, "utf8");
  const config = runtimeConfigSchema.parse(parseYaml(source, absoluteConfigFile));
  const env = options.env ?? process.env;

  if (config.server.authTokenEnv) {
    const token = env[config.server.authTokenEnv];
    if (!token?.trim()) {
      throw new Error(
        `Server auth token environment variable '${config.server.authTokenEnv}' is missing or empty`,
      );
    }
  }

  const configDirectory = path.dirname(absoluteConfigFile);
  return {
    ...config,
    configFile: absoluteConfigFile,
    providerConfigFile: path.resolve(configDirectory, config.providerConfigFile),
    providerAuthFile: path.resolve(configDirectory, config.providerAuthFile),
  };
}
