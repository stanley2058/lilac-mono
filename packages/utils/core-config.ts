import path from "node:path";
import fs from "node:fs/promises";

import { Result, TaggedError, type Result as ResultType } from "better-result";

import { env } from "./env";
import { capturePromiseResult, captureResultOutcome, errorMessage, isPanic } from "./runtime-utils";
import { findWorkspaceRoot } from "./find-root";
import { createLogger } from "./logging";
import { formatModelProviderOptionWarning } from "./model-provider-option-validation";
import {
  buildAgentSystemPrompt,
  CORE_PROMPT_FILES,
  promptWorkspaceSignature,
} from "./agent-prompts";
import {
  coreConfigInputSchemaV1,
  coreConfigSchema,
  decodeCoreConfigV1,
  decodeCoreConfigV1ToUniversal,
  parseCoreConfigV1,
  parseCoreConfigV1ToUniversal,
  CoreConfigV1Invalid,
} from "./core-config/v1";
import {
  coreConfigInputSchemaV2,
  decodeCoreConfigV2,
  decodeCoreConfigV2ToUniversal,
  parseCoreConfigV2,
  parseCoreConfigV2ToUniversal,
  CoreConfigV2Invalid,
} from "./core-config/v2";
import { formatCoreConfigKeyPath } from "./core-config/unknown-keys";
import {
  CoreConfigMustBeObject,
  CoreConfigVersionInvalid,
  readCoreConfigVersionResult,
  parseCoreConfigResult as parseCoreConfigValueResult,
} from "./core-config/parse";

export {
  CoreConfigMustBeObject,
  CoreConfigVersionInvalid,
  readCoreConfigVersionResult,
} from "./core-config/parse";
import type {
  CoreConfig,
  CoreConfigParseOptions,
  CoreConfigVersion,
  DiscordSessionAliasConfig,
  DiscordUserAliasConfig,
  RouterSessionConfig,
  RouterSessionConfigScope,
} from "./core-config/types";

export {
  coreConfigInputSchemaV1,
  coreConfigSchema,
  coreConfigInputSchemaV2,
  decodeCoreConfigV1,
  decodeCoreConfigV1ToUniversal,
  decodeCoreConfigV2,
  decodeCoreConfigV2ToUniversal,
  parseCoreConfigV1,
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV2,
  parseCoreConfigV2ToUniversal,
};
export {
  DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS,
  DEFAULT_TRANSCRIPT_RETENTION_MAX_AGE_MS,
  DEFAULT_TRANSCRIPT_RETENTION_MAX_REQUESTS,
  MODEL_REASONING_EFFORTS,
} from "./core-config/types";
export type {
  BlobStorageConfig,
  ConfiguredModelChainEntry,
  ConfiguredModelRef,
  ConfigParser,
  CoreConfig,
  CoreConfigKeyPath,
  CoreConfigModelOptionWarning,
  CoreConfigParseOptions,
  CoreConfigVersion,
  DiscordSessionAliasConfig,
  DiscordUserAliasConfig,
  JSONValue,
  JSONArray,
  JSONObject,
  ModelReasoningEffort,
  RouterSessionConfig,
  RouterSessionConfigScope,
  RetentionLimit,
  SubagentExecution,
  SubagentProfileConfig,
  UniversalCoreConfig,
} from "./core-config/types";

const logger = createLogger({ module: "core-config" });

/** Resolve per-property session overrides from broadest to most specific scope. */
export function resolveRouterSessionConfig(
  cfg: CoreConfig,
  scope: RouterSessionConfigScope,
): RouterSessionConfig {
  const resolved: RouterSessionConfig = {};

  for (const candidate of [scope.guildId, scope.parentChannelId, scope.sessionId]) {
    const configId = candidate?.trim();
    if (!configId) continue;

    Object.assign(resolved, cfg.surface.router.sessionModes[configId]);
  }

  return resolved;
}

export function getDiscordUserAliasValue(alias: DiscordUserAliasConfig | undefined): {
  discordId: string;
  comment?: string;
} | null {
  if (!alias) return null;
  return {
    discordId: alias.discord,
    comment: alias.comment,
  };
}

export function getDiscordSessionAliasValue(alias: DiscordSessionAliasConfig | undefined): {
  discordId: string;
  comment?: string;
} | null {
  if (!alias) return null;
  if (typeof alias === "string") {
    return { discordId: alias };
  }
  return {
    discordId: alias.discord,
    comment: alias.comment,
  };
}
let cached: CoreConfig | null = null;
let cachedMtimeMs: number | null = null;
let cachedPromptMaxMtimeMs: number | null = null;
let warnedPromptNewFilesKey: string | null = null;

export function resolveCoreConfigPath(options?: { dataDir?: string }): string {
  const dataDir = options?.dataDir ?? env.dataDir;
  return path.join(dataDir, "core-config.yaml");
}

async function resolveCoreConfigTemplatePath(): Promise<string> {
  // Prefer an internal template so docker volume mounts can't hide it.
  const internal = path.join(import.meta.dir, "config-templates", "core-config.example.yaml");
  if (await Bun.file(internal).exists()) return internal;

  // Back-compat for older layouts.
  return path.resolve(findWorkspaceRoot(), "data", "core-config.example.yaml");
}

export async function seedCoreConfig(options?: { dataDir?: string; overwrite?: boolean }): Promise<{
  dataDir: string;
  configPath: string;
  created: boolean;
  overwritten: boolean;
}> {
  const dataDir = options?.dataDir ?? env.dataDir;
  const overwrite = options?.overwrite ?? false;

  await fs.mkdir(dataDir, { recursive: true });

  const configPath = resolveCoreConfigPath({ dataDir });
  const existed = await Bun.file(configPath).exists();

  if (!existed || overwrite) {
    const templatePath = await resolveCoreConfigTemplatePath();
    const template = await Bun.file(templatePath).text();
    await Bun.write(configPath, template);
  }

  return {
    dataDir,
    configPath,
    created: !existed,
    overwritten: existed && overwrite,
  };
}

async function ensureDataDirSeeded() {
  await seedCoreConfig({ overwrite: false });
}

export class CoreConfigYamlInvalid extends TaggedError("CoreConfigYamlInvalid")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export function decodeCoreConfigYaml(raw: string): ResultType<unknown, CoreConfigYamlInvalid> {
  const captured = Result.try({
    try: () => Bun.YAML.parse(raw),
    catch: (cause) => ({ cause }),
  });
  const outcome = captured.match<
    | { readonly kind: "result"; readonly result: ResultType<unknown, CoreConfigYamlInvalid> }
    | { readonly kind: "panic"; readonly panic: import("better-result").Panic }
  >({
    ok: (value) => ({ kind: "result", result: Result.ok(value) }),
    err: ({ cause }) =>
      isPanic(cause)
        ? { kind: "panic", panic: cause }
        : {
            kind: "result",
            result: Result.err(
              new CoreConfigYamlInvalid({
                cause,
                message: `Failed to parse core-config.yaml: ${errorMessage(cause)}`,
              }),
            ),
          },
  });
  if (outcome.kind === "panic") throw outcome.panic;
  return outcome.result;
}

export function readCoreConfigVersion(raw: unknown): CoreConfigVersion {
  const result = readCoreConfigVersionResult(raw);
  const resolved = result.match<
    { readonly value: CoreConfigVersion } | { readonly error: CoreConfigVersionInvalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export function parseCoreConfigResult(
  raw: unknown,
  options?: CoreConfigParseOptions,
): ResultType<
  CoreConfig,
  CoreConfigVersionInvalid | CoreConfigMustBeObject | CoreConfigV1Invalid | CoreConfigV2Invalid
> {
  return parseCoreConfigValueResult(raw, {
    onUnknownKey:
      options?.onUnknownKey ??
      ((keyPath) => {
        logger.warn("unknown core-config key ignored", {
          path: formatCoreConfigKeyPath(keyPath),
          parserVersion: readCoreConfigVersion(raw),
        });
      }),
    onUnknownModelOption:
      options?.onUnknownModelOption ??
      ((warning, source) => logger.warn(formatModelProviderOptionWarning(warning, source))),
  });
}

export async function parseCoreConfig(
  raw: unknown,
  options?: CoreConfigParseOptions,
): Promise<CoreConfig> {
  const result = parseCoreConfigResult(raw, options);
  const resolved = result.match<
    | { readonly value: CoreConfig }
    | {
        readonly error:
          | CoreConfigVersionInvalid
          | CoreConfigMustBeObject
          | CoreConfigV1Invalid
          | CoreConfigV2Invalid;
      }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw projectLegacyCoreConfigFailure(resolved.error);
  return resolved.value;
}

function projectLegacyCoreConfigFailure(
  error:
    | CoreConfigVersionInvalid
    | CoreConfigMustBeObject
    | CoreConfigV1Invalid
    | CoreConfigV2Invalid,
): Error {
  switch (error._tag) {
    case "CoreConfigV1Invalid":
    case "CoreConfigV2Invalid":
      return error.cause;
    case "CoreConfigVersionInvalid":
    case "CoreConfigMustBeObject":
      return new Error(error.message);
  }
}

async function listPromptTemplateNewFiles(promptDir: string): Promise<string[]> {
  const pending: string[] = [];
  for (const name of CORE_PROMPT_FILES) {
    const p = path.join(promptDir, `${name}.new`);
    if (await Bun.file(p).exists()) {
      pending.push(p);
    }
  }
  return pending;
}

function warnPendingPromptTemplateMerges(pending: readonly string[]): void {
  if (pending.length === 0) {
    warnedPromptNewFilesKey = null;
    return;
  }

  const key = pending.join("\n");
  if (warnedPromptNewFilesKey === key) {
    return;
  }
  warnedPromptNewFilesKey = key;

  const names = pending.map((p) => path.basename(p)).join(", ");
  console.warn(
    `[lilac-utils] Prompt template updates are waiting in *.new files (${names}). Merge them into prompts/* and delete the .new files when finished.`,
  );
}

export async function getCoreConfig(options?: {
  /** Bypass cache and re-read from disk. */
  forceReload?: boolean;
}): Promise<CoreConfig> {
  const forceReload = options?.forceReload ?? false;

  await ensureDataDirSeeded();

  const filePath = resolveCoreConfigPath();

  if (!forceReload && cached) {
    const inspected = await capturePromiseResult(async () => ({
      stat: await Bun.file(filePath).stat(),
      promptSig: await promptWorkspaceSignature(),
    }));
    const inspectOutcome = captureResultOutcome(inspected);
    if (!inspectOutcome.ok && isPanic(inspectOutcome.error)) throw inspectOutcome.error;
    const cacheMatches =
      inspectOutcome.ok &&
      cachedMtimeMs !== null &&
      inspectOutcome.value.stat.mtimeMs === cachedMtimeMs &&
      cachedPromptMaxMtimeMs !== null &&
      inspectOutcome.value.promptSig.maxMtimeMs === cachedPromptMaxMtimeMs;
    if (cacheMatches) return cached;
  }

  const raw = await Bun.file(filePath).text();
  const decoded = decodeCoreConfigYaml(raw);
  const decodedValue = decoded.match<unknown | CoreConfigYamlInvalid>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (CoreConfigYamlInvalid.is(decodedValue)) throw new Error(decodedValue.message);
  const parsed = parseCoreConfigResult(decodedValue);
  const cfg = parsed.match<
    | CoreConfig
    | CoreConfigVersionInvalid
    | CoreConfigMustBeObject
    | CoreConfigV1Invalid
    | CoreConfigV2Invalid
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (TaggedError.is(cfg)) throw projectLegacyCoreConfigFailure(cfg);

  // Always use file-based system prompt (data/prompts/*).
  // This also ensures missing files are created from templates.
  const built = await buildAgentSystemPrompt();
  const pendingPromptNewFiles = await listPromptTemplateNewFiles(built.promptDir);
  warnPendingPromptTemplateMerges(pendingPromptNewFiles);

  const nextCfg: CoreConfig = {
    ...cfg,
    agent: {
      ...cfg.agent,
      systemPrompt: built.systemPrompt,
      workerSystemPrompt: built.workerSystemPrompt,
    },
  };

  cached = nextCfg;
  const stat = await capturePromiseResult(() => Bun.file(filePath).stat());
  const statOutcome = captureResultOutcome(stat);
  if (!statOutcome.ok && isPanic(statOutcome.error)) throw statOutcome.error;
  cachedMtimeMs = statOutcome.ok ? statOutcome.value.mtimeMs : null;

  const signature = await capturePromiseResult(() => promptWorkspaceSignature());
  const signatureOutcome = captureResultOutcome(signature);
  if (!signatureOutcome.ok && isPanic(signatureOutcome.error)) throw signatureOutcome.error;
  cachedPromptMaxMtimeMs = signatureOutcome.ok ? signatureOutcome.value.maxMtimeMs : null;

  return nextCfg;
}

export function resolveDiscordDbPath(cfg: CoreConfig): string {
  return cfg.surface.discord.dbPath ?? path.join(env.dataDir, "discord-surface.db");
}

export function resolveTranscriptDbPath(): string {
  return path.join(env.dataDir, "agent-transcripts.db");
}

export function resolveDiscordSearchDbPath(): string {
  return path.join(env.dataDir, "discord-search.db");
}

export function resolveDiscoveryDbPath(): string {
  return path.join(env.dataDir, "discovery.db");
}

export function resolveDiscordToken(cfg: CoreConfig): string {
  const result = resolveDiscordTokenResult(cfg);
  const resolved = result.match<
    { readonly value: string } | { readonly error: DiscordTokenMissing }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export class DiscordTokenMissing extends TaggedError("DiscordTokenMissing")<{
  readonly environmentVariable: string;
  readonly message: string;
}> {}

export function resolveDiscordTokenResult(
  cfg: CoreConfig,
): ResultType<string, DiscordTokenMissing> {
  const key = cfg.surface.discord.tokenEnv;
  const value = process.env[key];
  if (!value) {
    return Result.err(
      new DiscordTokenMissing({
        environmentVariable: key,
        message: `Discord token missing: env var ${key} is not set (set it or change surface.discord.tokenEnv in core-config.yaml)`,
      }),
    );
  }
  return Result.ok(value);
}
