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
    await mkdir(baselineDirectory, { recursive: true });
    for (const name of await readdir(baselineDirectory)) {
      if (name.endsWith(".schema.json")) await rm(path.join(baselineDirectory, name));
    }
    for (const [name, schema] of Object.entries(compatSchemas()).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
      await Bun.write(
        path.join(baselineDirectory, `${name}.schema.json`),
        `${JSON.stringify(json, null, 2)}\n`,
      );
    }
  }
}
