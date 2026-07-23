import fs from "node:fs/promises";

import solidPlugin from "@opentui/solid/bun-plugin";

const packageVersion = (await Bun.file("./package.json").json()).version;

await fs.mkdir("./dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./src/main.tsx"],
  outdir: "./dist",
  target: "bun",
  plugins: [solidPlugin],
  external: ["@opentui/core", "@opentui/core/*"],
  banner: "#!/usr/bin/env bun",
  define: {
    PACKAGE_VERSION: `"${packageVersion}"`,
  },
});

if (!result.success) {
  console.error("mini-lilac-tui build failed:");
  for (const log of result.logs) console.error(log);
  throw new Error("Bun.build failed");
}
