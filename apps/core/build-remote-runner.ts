import { mkdir, rename, rm, stat } from "node:fs/promises";

await mkdir("./src/ssh/remote-js", { recursive: true });

const outdir = "./src/ssh/remote-js";
const sourceEntrypoint = "./src/ssh/remote-js/remote-runner-entry.ts";
const generatedJsPath = `${outdir}/remote-runner-entry.js`;
const targetCjsPath = `${outdir}/remote-runner.cjs`;

const result = await Bun.build({
  entrypoints: [sourceEntrypoint],
  outdir,
  target: "node",
  format: "cjs",
  sourcemap: "none",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await rm(targetCjsPath, { force: true });

try {
  await stat(generatedJsPath);
  await rename(generatedJsPath, targetCjsPath);
} catch {
  // Bun may already emit .cjs in some versions/configs.
}
