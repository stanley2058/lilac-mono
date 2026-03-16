import fs from "node:fs/promises";

import type { Logger } from "@stanley2058/simple-module-logger";

type WatchReason = "watch";

export type CoreConfigWatchState = {
  lastContent: string;
};

type ReadFileFn = (path: string, encoding: BufferEncoding) => Promise<string>;

export type HandleCoreConfigWatchEventParams = {
  configPath: string;
  configFileName: string;
  eventType: string;
  filename: string | Buffer | null;
  state: CoreConfigWatchState;
  logger: Logger;
  scheduleValidation: (reason: WatchReason) => void;
  readFile?: ReadFileFn;
};

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function normalizeWatchFilename(filename: string | Buffer | null, fallback: string): string {
  if (typeof filename === "string") return filename;
  if (filename instanceof Buffer) return filename.toString("utf8");
  return fallback;
}

export async function handleCoreConfigWatchEvent(
  params: HandleCoreConfigWatchEventParams,
): Promise<void> {
  const readFile = params.readFile ?? fs.readFile;
  const changed = normalizeWatchFilename(params.filename, params.configFileName);

  try {
    const current = await readFile(params.configPath, "utf8");
    if (current === params.state.lastContent) return;

    params.state.lastContent = current;
    params.logger.debug("core-config file change detected", {
      eventType: params.eventType,
      changed,
      path: params.configPath,
    });
    params.scheduleValidation("watch");
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT") {
      params.logger.debug("core-config file temporarily unavailable during watch update", {
        eventType: params.eventType,
        changed,
        path: params.configPath,
      });
      params.scheduleValidation("watch");
      return;
    }

    params.logger.warn(
      "core-config watcher read failed",
      {
        eventType: params.eventType,
        changed,
        path: params.configPath,
      },
      error,
    );
    params.scheduleValidation("watch");
  }
}
