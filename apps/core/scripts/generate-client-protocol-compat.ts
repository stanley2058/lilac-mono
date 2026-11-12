import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { compatSchemas } from "../tests/helpers/client-compat-schemas";

export const baselineDirectory = path.resolve(
  import.meta.dir,
  "../../../packages/client-protocol/compat/previous-release",
);

const EXPORT_OPTIONS = { target: "draft-2020-12", io: "input" } as const;

if (import.meta.main) {
  const check = process.argv.includes("--check");
  if (check) {
    // The baseline intentionally differs from HEAD between releases. Check integrity, never equality.
    const { loadCompatValidators } = await import("../tests/helpers/client-compat");
    const validators = await loadCompatValidators();
    console.log(`Validated ${validators.size} previous-release schemas`);
  } else {
    await mkdir(baselineDirectory, { recursive: true });
    for (const name of await readdir(baselineDirectory)) {
      if (name.endsWith(".schema.json")) await rm(path.join(baselineDirectory, name));
    }
    if (process.argv.includes("--from-head")) {
      for (const [name, schema] of Object.entries(compatSchemas()))
        await Bun.write(
          path.join(baselineDirectory, `${name}.schema.json`),
          JSON.stringify(z.toJSONSchema(schema, EXPORT_OPTIONS)),
        );
    } else if (!(await exportPreviousRelease())) {
      process.exitCode = 1;
    }
    if (!process.exitCode && !(await formatBaseline())) process.exitCode = 1;
  }
}

/** Formats every generated file like the repository so fmt:check accepts them. */
async function formatBaseline(): Promise<boolean> {
  for (const name of await readdir(baselineDirectory)) {
    if (!name.endsWith(".schema.json")) continue;
    const outputPath = path.join(baselineDirectory, name);
    const formatted = Bun.spawnSync(["bunx", "oxfmt", "--stdin-filepath", outputPath], {
      stdin: Bun.file(outputPath),
    });
    if (!formatted.success) {
      console.error(formatted.stderr.toString());
      return false;
    }
    await Bun.write(outputPath, formatted.stdout);
  }
  return true;
}

/**
 * Writes the schemas of the newest release older than HEAD, so the baseline is what deployed
 * clients actually parse. The registry module only uses relative imports that releases share.
 */
async function exportPreviousRelease(): Promise<boolean> {
  const { previousRelease } = await import("../tests/e2e/harness/previous-release");
  const { root, tag } = await previousRelease();
  await Bun.write(
    path.join(root, "apps/core/tests/helpers/client-compat-schemas.ts"),
    Bun.file(path.join(import.meta.dir, "../tests/helpers/client-compat-schemas.ts")),
  );
  const exporter = path.join(root, "apps/core/compat-export.ts");
  await Bun.write(
    exporter,
    `import path from "node:path";
import { z } from "zod";
import { compatSchemas } from "./tests/helpers/client-compat-schemas";
for (const [name, schema] of Object.entries(compatSchemas()))
  await Bun.write(
    path.join(process.argv[2]!, name + ".schema.json"),
    JSON.stringify(z.toJSONSchema(schema, ${JSON.stringify(EXPORT_OPTIONS)})),
  );
`,
  );
  const child = Bun.spawn([process.execPath, exporter, baselineDirectory], {
    cwd: path.dirname(exporter),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    console.error(`Could not export ${tag} schemas: ${stderr}`);
    return false;
  }
  console.log(`Exported client schemas from ${tag}`);
  return true;
}
