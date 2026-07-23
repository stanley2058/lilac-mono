import fs from "node:fs/promises";

import solidPlugin from "@opentui/solid/bun-plugin";
import { z } from "zod";

await fs.rm("./dist", { recursive: true, force: true });
await fs.mkdir("./dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "bun",
  plugins: [solidPlugin],
  external: ["@opentui/core", "@opentui/core/*"],
  banner: "#!/usr/bin/env bun",
});

if (!result.success) {
  console.error("mini-lilac build failed:");
  for (const log of result.logs) console.error(log);
  throw new Error("Bun.build failed");
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
  files: ["main.js", "README.md", "LICENSE"],
};

await Promise.all([
  fs.writeFile("./dist/package.json", `${JSON.stringify(publishedPackage, null, 2)}\n`),
  fs.copyFile("./README.md", "./dist/README.md"),
  fs.copyFile("./LICENSE", "./dist/LICENSE"),
]);
