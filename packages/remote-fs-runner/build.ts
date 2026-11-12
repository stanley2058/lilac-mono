import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

export const RUNNER_PACKAGE_DIR = import.meta.dir;

// The published bundle and the version fingerprint both derive from these options.
export const runnerBuildOptions = {
  entrypoints: [path.join(RUNNER_PACKAGE_DIR, "src/cli.ts")],
  target: "node",
  format: "esm",
  sourcemap: "none",
  minify: true,
  external: ["@ff-labs/fff-node"],
  banner: "#!/usr/bin/env node",
} as const;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { outdir: { type: "string" } } });
  const outdir = path.resolve(values.outdir ?? path.join(RUNNER_PACKAGE_DIR, "dist"));
  const packageVersion = (await Bun.file(path.join(RUNNER_PACKAGE_DIR, "package.json")).json())
    .version;

  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const result = await Bun.build({
    ...runnerBuildOptions,
    entrypoints: [...runnerBuildOptions.entrypoints],
    external: [...runnerBuildOptions.external],
    outdir,
    define: {
      PACKAGE_VERSION: `"${packageVersion}"`,
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  await chmod(path.join(outdir, "cli.js"), 0o755);
}

if (import.meta.main) await main();
