declare const __LILAC_TOOL_COMPILED__: boolean | undefined;

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Result } from "better-result";

import { decodeBuildInfo, type BuildInfo } from "@stanley2058/lilac-utils/build-info";

const COMPILED = typeof __LILAC_TOOL_COMPILED__ === "boolean" && __LILAC_TOOL_COMPILED__;

function artifactPath(name: string): string {
  return join(dirname(realpathSync(process.execPath)), name);
}

export function readToolBuildId(): string | undefined {
  if (!COMPILED) return "dev";
  const id = Result.try({
    try: () => readFileSync(artifactPath("tools-build-id"), "utf8").trim(),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
  return id && /^(?:[a-f0-9]{8}|dev)$/.test(id) ? id : undefined;
}

export function readToolBuildInfo(): BuildInfo {
  const fallback = { version: "dev", commit: "dev" };
  if (!COMPILED) return fallback;
  const value = Result.try({
    try: () => JSON.parse(readFileSync(artifactPath("tools-build-info.json"), "utf8")),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
  const info = decodeBuildInfo(value);
  if (!info) return fallback;
  return {
    version: info.version,
    commit: info.commit,
    ...(typeof info.dirty === "boolean" ? { dirty: info.dirty } : {}),
    ...(info.builtAt === undefined ? {} : { builtAt: info.builtAt }),
  };
}
