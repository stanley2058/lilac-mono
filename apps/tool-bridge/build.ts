import { createHash } from "node:crypto";
import { basename } from "node:path";

import { getBuildInfo } from "@stanley2058/lilac-utils/build-info";

const BUILD_ID_PLACEHOLDER = "00000000";
const buildInfo = getBuildInfo({ cwd: import.meta.dir });

function buildDefines(buildId: string): Record<string, string> {
  return {
    __LILAC_TOOL_BUILD_ID__: JSON.stringify(buildId),
    __LILAC_TOOL_BUILD_VERSION__: JSON.stringify(buildInfo.version),
    __LILAC_TOOL_BUILD_COMMIT__: JSON.stringify(buildInfo.commit),
    __LILAC_TOOL_BUILD_DIRTY__:
      buildInfo.dirty === undefined ? "undefined" : JSON.stringify(buildInfo.dirty),
    __LILAC_TOOL_BUILT_AT__:
      buildInfo.builtAt === undefined ? "undefined" : JSON.stringify(buildInfo.builtAt),
    __LILAC_TOOL_AUTOSTART__: "false",
  };
}

async function buildProbe(buildId: string): Promise<Bun.BuildOutput> {
  return await Bun.build({
    entrypoints: ["./launcher.ts"],
    target: "bun",
    splitting: true,
    minify: true,
    define: buildDefines(buildId),
  });
}

async function buildWorkerExecutable(buildId: string): Promise<Bun.BuildOutput> {
  return await Bun.build({
    entrypoints: ["./launcher.ts"],
    target: "bun",
    minify: true,
    bytecode: true,
    compile: {
      outfile: "./dist/tools-worker",
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: false,
    },
    define: buildDefines(buildId),
  });
}

async function buildLauncher(buildId: string): Promise<void> {
  if (process.platform !== "linux") {
    const portable = await Bun.build({
      entrypoints: ["./launcher.ts"],
      target: "bun",
      minify: true,
      bytecode: true,
      compile: {
        outfile: "./dist/tools",
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadPackageJson: false,
      },
      define: buildDefines(buildId),
    });
    requireSuccessfulBuild(portable);
    return;
  }
  const compiler = Bun.which("go");
  if (!compiler) {
    process.stderr.write("Go is required to build the tools launcher\n");
    process.exit(1);
  }
  const compiled = Bun.spawnSync(
    [
      compiler,
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-buildmode=pie",
      "-ldflags",
      `-s -w -X main.buildID=${buildId}`,
      "-o",
      "./dist/tools",
      "./native-launcher.go",
    ],
    { env: { ...process.env, CGO_ENABLED: "0" } },
  );
  if (compiled.exitCode === 0) return;
  process.stderr.write(compiled.stderr.toString());
  process.exit(compiled.exitCode || 1);
}

function requireSuccessfulBuild(output: Bun.BuildOutput): void {
  if (output.success) return;
  for (const log of output.logs) process.stderr.write(`${log}\n`);
  process.exit(1);
}

const probe = await buildProbe(BUILD_ID_PLACEHOLDER);
requireSuccessfulBuild(probe);
const hasher = createHash("sha256");
for (const artifact of probe.outputs.toSorted((left, right) =>
  left.path.localeCompare(right.path),
)) {
  hasher.update(basename(artifact.path));
  hasher.update("\0");
  hasher.update(new Uint8Array(await artifact.arrayBuffer()));
  hasher.update("\0");
}
hasher.update("native-launcher.go\0");
hasher.update(new Uint8Array(await Bun.file("./native-launcher.go").arrayBuffer()));
hasher.update("\0");
const buildId = hasher.digest("hex").slice(0, BUILD_ID_PLACEHOLDER.length);
const written = await buildWorkerExecutable(buildId);
requireSuccessfulBuild(written);
await buildLauncher(buildId);
