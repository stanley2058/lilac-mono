export const CHECK_GATES = [
  "codegen:config-schemas:check",
  "codegen:model-options:check",
  "codegen:design-tool-activities:check",
  "lint:oxlint",
  "lint:architecture",
  "test:ci",
  "typecheck",
  "fmt:check",
] as const;

export async function runCommands(commands: readonly string[][], workers: number): Promise<number> {
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(workers, commands.length) }, async () => {
      while (next < commands.length) {
        const command = commands[next++];
        if (!command) return;
        const child = Bun.spawn(command, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        if ((await child.exited) !== 0) failed = true;
      }
    }),
  );
  return Number(failed);
}

if (import.meta.main) {
  const workers = process.argv[2] === "ci" ? 1 : 2;
  process.exitCode = await runCommands(
    CHECK_GATES.map((gate) => ["bun", "run", gate]),
    workers,
  );
}
