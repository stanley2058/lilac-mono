import fs from "node:fs/promises";

import solidPlugin from "@opentui/solid/bun-plugin";

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
