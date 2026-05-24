import path from "node:path";
import fs from "node:fs/promises";

import { env } from "./env";
import { findWorkspaceRoot } from "./find-root";
import {
  buildAgentSystemPrompt,
  CORE_PROMPT_FILES,
  promptWorkspaceSignature,
} from "./agent-prompts";
import {
  CURRENT_CORE_CONFIG_VERSION,
  SUPPORTED_CORE_CONFIG_VERSIONS,
  V1CoreConfigParser,
  coreConfigInputSchemaV1,
  coreConfigSchema,
  parseCoreConfigV1,
} from "./core-config/v1";
import type {
  ConfigParser,
  CoreConfig,
  CoreConfigVersion,
  DiscordSessionAliasConfig,
  DiscordUserAliasConfig,
} from "./core-config/types";

export { coreConfigInputSchemaV1, coreConfigSchema, parseCoreConfigV1 };
export type {
  ConfigParser,
  CoreConfig,
  CoreConfigVersion,
  DiscordSessionAliasConfig,
  DiscordUserAliasConfig,
  JSONValue,
  JSONArray,
  JSONObject,
  UniversalCoreConfig,
} from "./core-config/types";

const CORE_CONFIG_PARSERS: ReadonlyMap<CoreConfigVersion, ConfigParser> = new Map([
  [1, new V1CoreConfigParser()],
]);

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
  // Keep: helps empty dirs survive in git checkouts; harmless in docker.
  await Bun.write(path.join(dataDir, ".gitkeep"), "");

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

function safeParseYaml(raw: string): unknown {
  try {
    return Bun.YAML.parse(raw) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse core-config.yaml: ${msg}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCoreConfigVersion(raw: unknown): CoreConfigVersion {
  if (!isRecord(raw)) return CURRENT_CORE_CONFIG_VERSION;

  const version = raw.configVersion;
  if (version === undefined || version === null) return CURRENT_CORE_CONFIG_VERSION;

  if (version === CURRENT_CORE_CONFIG_VERSION) return version;

  throw new Error(
    `Unsupported core config version: ${String(version)} (supported: ${SUPPORTED_CORE_CONFIG_VERSIONS.join(", ")})`,
  );
}

export async function parseCoreConfig(raw: unknown): Promise<CoreConfig> {
  const version = readCoreConfigVersion(raw);
  const parser = CORE_CONFIG_PARSERS.get(version);

  if (!parser) {
    throw new Error(
      `Unsupported core config version: ${String(version)} (supported: ${SUPPORTED_CORE_CONFIG_VERSIONS.join(", ")})`,
    );
  }

  if (!isRecord(raw)) {
    throw new Error("Core config must be an object");
  }

  return parser.parse(raw);
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
    try {
      const stat = await Bun.file(filePath).stat();
      const promptSig = await promptWorkspaceSignature();

      if (
        cachedMtimeMs !== null &&
        stat.mtimeMs === cachedMtimeMs &&
        cachedPromptMaxMtimeMs !== null &&
        promptSig.maxMtimeMs === cachedPromptMaxMtimeMs
      ) {
        return cached;
      }
    } catch {
      // If stat/signature fails, fall through to re-read to produce a better error.
    }
  }

  const raw = await Bun.file(filePath).text();
  const parsed = safeParseYaml(raw);
  const cfg = await parseCoreConfig(parsed);

  // Always use file-based system prompt (data/prompts/*).
  // This also ensures missing files are created from templates.
  const built = await buildAgentSystemPrompt({ basePrompt: cfg.basePrompt });
  const pendingPromptNewFiles = await listPromptTemplateNewFiles(built.promptDir);
  warnPendingPromptTemplateMerges(pendingPromptNewFiles);

  const nextCfg: CoreConfig = {
    ...cfg,
    agent: {
      ...cfg.agent,
      systemPrompt: built.systemPrompt,
    },
  };

  cached = nextCfg;
  try {
    const stat = await Bun.file(filePath).stat();
    cachedMtimeMs = stat.mtimeMs;
  } catch {
    cachedMtimeMs = null;
  }

  try {
    const sig = await promptWorkspaceSignature();
    cachedPromptMaxMtimeMs = sig.maxMtimeMs;
  } catch {
    cachedPromptMaxMtimeMs = null;
  }

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
  const key = cfg.surface.discord.tokenEnv;
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Discord token missing: env var ${key} is not set (set it or change surface.discord.tokenEnv in core-config.yaml)`,
    );
  }
  return value;
}
