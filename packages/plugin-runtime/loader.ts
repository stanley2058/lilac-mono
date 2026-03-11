import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LilacToolPlugin, ToolPluginMeta } from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPluginMeta(value: unknown): value is ToolPluginMeta {
  if (!isObject(value)) return false;
  return typeof value.id === "string" && value.id.trim().length > 0;
}

function isLilacToolPlugin(value: unknown): value is LilacToolPlugin<unknown, unknown, unknown> {
  if (!isObject(value)) return false;
  return isPluginMeta(value.meta) && typeof value.create === "function";
}

async function copyDirectoryTree(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const dirents = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const dirent of dirents) {
    if (dirent.name.includes(".lilac-")) continue;

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);

    if (dirent.isDirectory()) {
      await copyDirectoryTree(sourcePath, targetPath);
      continue;
    }

    if (dirent.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath);
      await fs.symlink(target, targetPath);
    }
  }
}

export async function loadToolPluginModule(params: {
  entrypointPath: string;
  pluginDir?: string;
  cacheBustKey: string;
}): Promise<LilacToolPlugin<unknown, unknown, unknown>> {
  const snapshotPath = await (async () => {
    if (!params.pluginDir) {
      const parsedPath = path.parse(params.entrypointPath);
      const extension = parsedPath.ext || ".js";
      const nextPath = path.join(
        parsedPath.dir,
        `.${parsedPath.name}.lilac-${params.cacheBustKey}${extension}`,
      );

      const source = await fs.readFile(params.entrypointPath);
      await fs.writeFile(nextPath, source);
      return nextPath;
    }

    const snapshotDir = path.join(params.pluginDir, `.lilac-${params.cacheBustKey}`);
    await fs.rm(snapshotDir, { recursive: true, force: true });
    await copyDirectoryTree(params.pluginDir, snapshotDir);
    return path.join(snapshotDir, path.relative(params.pluginDir, params.entrypointPath));
  })();

  const url = pathToFileURL(snapshotPath);

  const mod = await import(url.toString());
  const plugin = (mod as Record<string, unknown>).default;
  if (!isLilacToolPlugin(plugin)) {
    throw new Error("Plugin entrypoint must default export a LilacToolPlugin");
  }

  return plugin;
}
