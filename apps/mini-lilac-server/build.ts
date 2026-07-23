import fs from "node:fs/promises";

await fs.mkdir("./dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "bun",
});

if (!result.success) {
  result.logs.forEach((message) => console.error(message));
  throw new Error("Failed to build mini-lilac-server");
}

await Bun.write(
  "./dist/index.js",
  ["#!/usr/bin/env bun", 'import { main } from "./main.js";', "await main();", ""].join("\n"),
);
