import { createHash } from "node:crypto";
import { basename } from "node:path";

import { getBuildInfo } from "@stanley2058/lilac-utils/build-info";

const buildDefines = {
  __LILAC_TOOL_COMPILED__: "true",
  __LILAC_TOOL_AUTOSTART__: "false",
};

async function buildProbe(): Promise<Bun.BuildOutput> {
  return await Bun.build({
    entrypoints: ["./launcher.ts"],
    target: "bun",
    splitting: true,
    minify: true,
    define: buildDefines,
  });
}

async function buildWorkerExecutable(): Promise<Bun.BuildOutput> {
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
    define: buildDefines,
  });
}

async function buildLauncher(): Promise<void> {
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
      define: buildDefines,
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
      "-s -w",
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

const probe = await buildProbe();
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
const buildId = hasher.digest("hex").slice(0, 8);
const written = await buildWorkerExecutable();
requireSuccessfulBuild(written);
await Bun.write("./dist/tools-build-id", `${buildId}\n`);
if (!process.argv.includes("--worker-only")) {
  await buildLauncher();
  await Bun.write(
    "./dist/tools-build-info.json",
    `${JSON.stringify(getBuildInfo({ cwd: import.meta.dir }), null, 2)}\n`,
  );
}
