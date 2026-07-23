import path from "node:path";

import { z } from "zod";

const PACKAGE_NAME = "@stanley2058/mini-lilac";

const npmPackOutputSchema = z
  .array(
    z.object({
      filename: z.string().min(1),
    }),
  )
  .length(1);

async function run(command: readonly string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: import.meta.dir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

async function installLocalPackage(): Promise<void> {
  await run([Bun.which("bun") ?? "bun", "run", "build"]);

  const pack = Bun.spawn(["npm", "pack", "--workspaces=false", "./dist", "--json"], {
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [packOutput, packExitCode] = await Promise.all([
    new Response(pack.stdout).text(),
    pack.exited,
  ]);
  if (packExitCode !== 0) {
    throw new Error(`npm pack failed with exit code ${packExitCode}`);
  }

  const [{ filename }] = npmPackOutputSchema.parse(JSON.parse(packOutput));
  const bun = Bun.which("bun") ?? "bun";
  await run([bun, "remove", "--global", PACKAGE_NAME]);
  await run([bun, "add", "--global", path.resolve(import.meta.dir, filename)]);
}

await installLocalPackage();
