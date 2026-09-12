import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const targets = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "darwin-arm64": "bun-darwin-arm64",
} satisfies Record<string, Bun.Build.CompileTarget>;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string", default: `${process.platform}-${process.arch}` },
    outdir: { type: "string", default: resolve(import.meta.dir, "dist") },
  },
  strict: true,
});
const targetEntry = Object.entries(targets).find(([name]) => name === values.target);
if (!targetEntry) {
  console.error(`Unsupported target ${values.target}. Choose ${Object.keys(targets).join(", ")}.`);
  process.exit(1);
}

const version = process.env.LILAC_INSTALLER_VERSION ?? "dev";
const commit = process.env.LILAC_INSTALLER_COMMIT ?? "dev";
const imageOwner = process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase() ?? "stanley2058";
const imageTag = version === "dev" ? "latest" : version;
const defines = {
  "process.env.LILAC_INSTALLER_VERSION": JSON.stringify(version),
  "process.env.LILAC_INSTALLER_COMMIT": JSON.stringify(commit),
  "process.env.LILAC_DEFAULT_IMAGE": JSON.stringify(
    process.env.LILAC_DEFAULT_IMAGE ?? `ghcr.io/${imageOwner}/lilac-mono:${imageTag}`,
  ),
  "process.env.LILAC_DEFAULT_COMPUTER_GATEWAY_IMAGE": JSON.stringify(
    process.env.LILAC_DEFAULT_COMPUTER_GATEWAY_IMAGE ??
      `ghcr.io/${imageOwner}/lilac-computer-gateway:${imageTag}`,
  ),
  "process.env.LILAC_DEFAULT_COMPUTER_RUNNER_IMAGE": JSON.stringify(
    process.env.LILAC_DEFAULT_COMPUTER_RUNNER_IMAGE ??
      `ghcr.io/${imageOwner}/lilac-computer:${imageTag}`,
  ),
};

await mkdir(values.outdir, { recursive: true });
const output = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "src/main.ts")],
  target: "bun",
  minify: true,
  define: defines,
  compile: {
    target: targetEntry[1],
    outfile: resolve(values.outdir, `lilac-${targetEntry[0]}`),
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});
if (!output.success) {
  for (const log of output.logs) console.error(String(log));
  process.exit(1);
}

console.info(`Built lilac-${targetEntry[0]} (${version}).`);
