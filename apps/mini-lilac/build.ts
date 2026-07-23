import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import solidPlugin from "@opentui/solid/bun-plugin";
import { z } from "zod";

await fs.rm("./dist", { recursive: true, force: true });
await fs.mkdir("./dist", { recursive: true });

const openTuiEntry = fileURLToPath(import.meta.resolve("@opentui/core"));
const openTuiSource = await fs.readFile(openTuiEntry, "utf8");
if (!openTuiSource.includes('forceTableRefresh && block.token.type === "table"')) {
  throw new Error("The required @opentui/core Markdown patch is not installed");
}

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "bun",
  plugins: [solidPlugin],
  external: ["@opentui/core-darwin-*", "@opentui/core-linux-*", "@opentui/core-win32-*"],
  banner: "#!/usr/bin/env bun",
});

if (!result.success) {
  console.error("mini-lilac build failed:");
  for (const log of result.logs) console.error(log);
  throw new Error("Bun.build failed");
}

const isOpenTuiCoreImport = (specifier: string | undefined) =>
  specifier === "@opentui/core" || specifier?.startsWith("@opentui/core/") === true;
const transpiler = new Bun.Transpiler({ loader: "js" });
const bundledImports = (
  await Promise.all(
    result.outputs
      .filter((output) => output.path.endsWith(".js"))
      .map(async (output) =>
        transpiler.scanImports((await output.text()).replace(/^#![^\n]*\n/u, "")),
      ),
  )
).flat();
const retainedOpenTuiCoreImport = bundledImports.some((importRecord) =>
  isOpenTuiCoreImport(importRecord.path),
);
if (retainedOpenTuiCoreImport) {
  throw new Error("The published bundle still imports unpatched @opentui/core JavaScript");
}

const sourcePackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  license: z.string(),
  repository: z.object({
    type: z.string(),
    url: z.string(),
    directory: z.string(),
  }),
  homepage: z.string(),
  publishConfig: z.object({ access: z.literal("public") }),
  engines: z.object({ bun: z.string() }),
  dependencies: z.record(z.string(), z.string()),
});
const sourcePackage = sourcePackageSchema.parse(await Bun.file("./package.json").json());
const publishedPackage = {
  ...sourcePackage,
  type: "module",
  bin: { "mini-lilac": "main.js" },
  files: ["main.js", "parser.worker.js", "*.scm", "*.wasm", "README.md", "LICENSE"],
};

await Promise.all([
  fs.writeFile("./dist/package.json", `${JSON.stringify(publishedPackage, null, 2)}\n`),
  fs.copyFile(path.join(path.dirname(openTuiEntry), "parser.worker.js"), "./dist/parser.worker.js"),
  fs.copyFile("./README.md", "./dist/README.md"),
  fs.copyFile("./LICENSE", "./dist/LICENSE"),
]);
