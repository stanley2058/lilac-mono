import { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type DiscoveredExternalToolPlugin = {
  type: "plugin";
  pluginId: string;
  pluginDir: string;
  packageJsonPath: string;
  entrypointPath: string;
  packageJsonMtimeMs: number;
  entrypointMtimeMs: number;
};

export type InvalidExternalToolPlugin = {
  type: "invalid";
  pluginId: string;
  pluginDir: string;
  packageJsonPath?: string;
  reason: string;
  packageJsonMtimeMs?: number;
};

export type ExternalToolPluginDiscovery = DiscoveredExternalToolPlugin | InvalidExternalToolPlugin;

type PackageJsonWithLilac = {
  lilac?: {
    plugin?: unknown;
  };
};

async function statMtimeMs(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.mtimeMs;
}

async function hashFile(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath);
  return Bun.hash(raw).toString(16);
}

async function readPackageJson(filePath: string): Promise<PackageJsonWithLilac> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read package.json: ${message}`);
  }

  try {
    return JSON.parse(raw) as PackageJsonWithLilac;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse package.json: ${message}`);
  }
}

export function resolveExternalPluginsDir(dataDir: string): string {
  return path.join(dataDir, "plugins");
}

export async function discoverExternalToolPlugins(params: {
  dataDir: string;
}): Promise<ExternalToolPluginDiscovery[]> {
  const pluginsDir = resolveExternalPluginsDir(params.dataDir);

  let dirents: Dirent[] = [];
  try {
    dirents = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") return [];
    throw error;
  }

  const entries: ExternalToolPluginDiscovery[] = [];

  for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;

    const pluginId = dirent.name;
    const pluginDir = path.join(pluginsDir, pluginId);
    const packageJsonPath = path.join(pluginDir, "package.json");

    let packageJsonMtimeMs: number | undefined;
    try {
      packageJsonMtimeMs = await statMtimeMs(packageJsonPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === "ENOENT") {
        entries.push({
          type: "invalid",
          pluginId,
          pluginDir,
          reason: "missing package.json",
        });
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs,
        reason: message,
      });
      continue;
    }

    let packageJson: PackageJsonWithLilac;
    try {
      packageJson = await readPackageJson(packageJsonPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs,
        reason: message,
      });
      continue;
    }

    const relativeEntrypoint = packageJson.lilac?.plugin;
    if (typeof relativeEntrypoint !== "string" || relativeEntrypoint.trim().length === 0) {
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs,
        reason: "package.json missing lilac.plugin string",
      });
      continue;
    }

    const entrypointPath = path.resolve(pluginDir, relativeEntrypoint);

    try {
      const entrypointMtimeMs = await statMtimeMs(entrypointPath);
      entries.push({
        type: "plugin",
        pluginId,
        pluginDir,
        packageJsonPath,
        entrypointPath,
        packageJsonMtimeMs,
        entrypointMtimeMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push({
        type: "invalid",
        pluginId,
        pluginDir,
        packageJsonPath,
        packageJsonMtimeMs,
        reason: `plugin entrypoint missing or unreadable: ${message}`,
      });
    }
  }

  return entries;
}

export async function buildExternalToolPluginFreshnessKey(params: {
  dataDir: string;
  configPath?: string;
}): Promise<string> {
  const discovered = await discoverExternalToolPlugins({ dataDir: params.dataDir });
  const configMtimeMs = await (async () => {
    if (!params.configPath) return null;
    try {
      return await statMtimeMs(params.configPath);
    } catch {
      return null;
    }
  })();

  const payload = {
    configMtimeMs,
    discovered: await Promise.all(
      discovered.map(async (entry) =>
        entry.type === "plugin"
          ? {
              type: entry.type,
              pluginId: entry.pluginId,
              packageJsonMtimeMs: entry.packageJsonMtimeMs,
              packageJsonHash: await hashFile(entry.packageJsonPath),
              entrypointMtimeMs: entry.entrypointMtimeMs,
              entrypointHash: await hashFile(entry.entrypointPath),
              entrypointPath: entry.entrypointPath,
            }
          : {
              type: entry.type,
              pluginId: entry.pluginId,
              reason: entry.reason,
              packageJsonMtimeMs: entry.packageJsonMtimeMs ?? null,
              packageJsonHash: entry.packageJsonPath ? await hashFile(entry.packageJsonPath) : null,
            },
      ),
    ),
  };

  return Bun.hash(JSON.stringify(payload)).toString(16);
}
