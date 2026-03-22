import fs from "node:fs/promises";
import path from "node:path";

import { findWorkspaceRoot } from "../packages/utils/find-root";
import { collectBuildMetadata } from "./build-metadata";

const DEFAULT_BUILD_INFO_PATH = path.join("build", "build-info.json");

function readArg(prefix: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : undefined;
}

function parseBooleanish(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

async function main() {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const outputPath = path.resolve(
    workspaceRoot,
    readArg("--output=") ?? DEFAULT_BUILD_INFO_PATH,
  );
  const metadata = collectBuildMetadata(workspaceRoot);
  const overrideVersion = readArg("--version=");
  const overrideCommit = readArg("--commit=");
  const overrideDirty = parseBooleanish(readArg("--dirty="));
  const overrideBuiltAt = readArg("--built-at=");

  const payload = {
    ...metadata,
    ...(overrideVersion ? { version: overrideVersion } : {}),
    ...(overrideCommit ? { commit: overrideCommit } : {}),
    ...(overrideDirty === undefined ? {} : { dirty: overrideDirty }),
    ...(overrideBuiltAt ? { builtAt: overrideBuiltAt } : {}),
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const relativeOutputPath = path.relative(workspaceRoot, outputPath) || outputPath;
  console.log(`Wrote ${relativeOutputPath}`);
}

await main();
