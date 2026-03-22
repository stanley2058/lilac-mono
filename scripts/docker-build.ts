import { spawnSync } from "node:child_process";

import { buildMetadataEnv, collectBuildMetadata } from "./build-metadata";

type Mode = "build" | "compose-build";

function parseMode(value: string | undefined): Mode {
  if (value === "build" || value === "compose-build") return value;
  throw new Error("Usage: bun scripts/docker-build.ts <build|compose-build> [docker args...] [--dry-run]");
}

function formatEnvPreview(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function buildArgFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);
}

function main() {
  const mode = parseMode(process.argv[2]);
  const rawArgs = process.argv.slice(3);
  const dryRunIndex = rawArgs.indexOf("--dry-run");
  const dryRun = dryRunIndex >= 0;
  const passthroughArgs = dryRun ? rawArgs.filter((arg) => arg !== "--dry-run") : rawArgs;

  const metadataEnv = buildMetadataEnv(collectBuildMetadata());
  const dockerArgs =
    mode === "compose-build"
      ? ["compose", "build", ...passthroughArgs]
      : ["build", ...buildArgFlags(metadataEnv), ...passthroughArgs];

  if (dryRun) {
    console.log(formatEnvPreview(metadataEnv));
    console.log(["docker", ...dockerArgs].join(" "));
    return;
  }

  const result = spawnSync("docker", dockerArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...metadataEnv,
    },
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

main();
