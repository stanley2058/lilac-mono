import fs from "node:fs/promises";

const packageVersion = (await Bun.file("./package.json").json()).version;

await fs.mkdir("./dist", { recursive: true });

await Bun.build({
  entrypoints: ["./client.ts"],
  outdir: "./dist",
  target: "node",
  define: {
    PACKAGE_VERSION: `"${packageVersion}"`,
  },
});

// Keep a stable executable entrypoint (committed, not generated).
// This mirrors apps/tool-bridge/dist/index.js.
await Bun.write("./dist/index.js", ["#!/usr/bin/env bun", 'import "./client.js";', ""].join("\n"));

await Bun.write(
  "./dist/opencode-alias.js",
  [
    "#!/usr/bin/env bun",
    'process.env.LILAC_ACP_COMPAT_BIN = "lilac-opencode";',
    'process.env.LILAC_ACP_ENTRYPOINT = new URL("./index.js", import.meta.url).pathname;',
    'process.argv.push("--harness", "opencode");',
    'import "./client.js";',
    "",
  ].join("\n"),
);
