import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { compatSchemas } from "../tests/helpers/client-compat-schemas";

export const baselineDirectory = path.resolve(
  import.meta.dir,
  "../../../packages/client-protocol/compat/previous-release",
);

if (import.meta.main) {
  const check = process.argv.includes("--check");
  if (check) {
    // The baseline intentionally differs from HEAD between releases. Check integrity, never equality.
    const { loadCompatValidators } = await import("../tests/helpers/client-compat");
    const validators = await loadCompatValidators();
    console.log(`Validated ${validators.size} previous-release schemas`);
  } else {
    const schemas = process.argv.includes("--from-head")
      ? exportSchemas(compatSchemas())
      : await exportPreviousRelease();
    await mkdir(baselineDirectory, { recursive: true });
    for (const name of await readdir(baselineDirectory)) {
      if (name.endsWith(".schema.json")) await rm(path.join(baselineDirectory, name));
    }
    for (const [name, json] of Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b)))
      await Bun.write(
        path.join(baselineDirectory, `${name}.schema.json`),
        `${JSON.stringify(json, null, 2)}\n`,
      );
  }
}

export function exportSchemas(schemas: Record<string, z.ZodType>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }),
    ]),
  );
}

/**
 * Exports the schemas of the newest release older than HEAD, so the baseline is what deployed
 * clients actually parse. The registry module only uses relative imports that releases share.
 */
async function exportPreviousRelease(): Promise<Record<string, unknown>> {
  const { previousRelease } = await import("../tests/e2e/harness/previous-release");
  const { root, tag } = await previousRelease();
  const helper = path.join(root, "apps/core/tests/helpers/client-compat-schemas.ts");
  await Bun.write(
    helper,
    Bun.file(path.join(import.meta.dir, "../tests/helpers/client-compat-schemas.ts")),
  );
  const exporter = path.join(root, "apps/core/compat-export.ts");
  await Bun.write(
    exporter,
    `import { z } from "zod";
import { compatSchemas } from "./tests/helpers/client-compat-schemas";
const out = Object.fromEntries(Object.entries(compatSchemas()).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" })]));
await Bun.write(Bun.stdout, JSON.stringify(out));
`,
  );
  const child = Bun.spawn([process.execPath, exporter], {
    cwd: path.dirname(exporter),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Could not export ${tag} schemas: ${stderr}`);
  console.log(`Exported client schemas from ${tag}`);
  return JSON.parse(stdout) as Record<string, unknown>;
}
