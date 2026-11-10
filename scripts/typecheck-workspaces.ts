import { readdir, access } from "node:fs/promises";
import { runCommands } from "./run-gates";

const configs: string[] = [];
for (const root of ["apps", "packages"]) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const config = `${root}/${entry.name}/tsconfig.json`;
    if (
      await access(config).then(
        () => true,
        () => false,
      )
    )
      configs.push(config);
  }
}
process.exitCode = await runCommands(
  configs.sort().map((config) => ["bunx", "tsc", "-p", config, "--noEmit"]),
  4,
);
