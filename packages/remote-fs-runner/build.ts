import { chmod, mkdir, rm } from "node:fs/promises";

const packageVersion = (await Bun.file("./package.json").json()).version;

await rm("./dist", { recursive: true, force: true });
await mkdir("./dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "none",
  minify: true,
  external: ["@ff-labs/fff-node"],
  banner: "#!/usr/bin/env node",
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

await chmod("./dist/cli.js", 0o755);
