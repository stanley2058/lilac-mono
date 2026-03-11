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

export async function loadToolPluginModule(params: {
  entrypointPath: string;
  cacheBustKey: string;
}): Promise<LilacToolPlugin<unknown, unknown, unknown>> {
  const parsedPath = path.parse(params.entrypointPath);
  const extension = parsedPath.ext || ".js";
  const snapshotPath = path.join(
    parsedPath.dir,
    `.${parsedPath.name}.lilac-${params.cacheBustKey}${extension}`,
  );

  const source = await fs.readFile(params.entrypointPath);
  await fs.writeFile(snapshotPath, source);

  const url = pathToFileURL(snapshotPath);

  const mod = await import(url.toString());
  const plugin = (mod as Record<string, unknown>).default;
  if (!isLilacToolPlugin(plugin)) {
    throw new Error("Plugin entrypoint must default export a LilacToolPlugin");
  }

  return plugin;
}
