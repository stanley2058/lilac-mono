import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import coreSchema from "../generated/config-schemas/core-config.schema.json";
import mcpSchema from "../generated/config-schemas/mcp-config.schema.json";

const CONFIG_SCHEMAS = {
  "core-config.schema.json": `${JSON.stringify(coreSchema, null, 2)}\n`,
  "mcp-config.schema.json": `${JSON.stringify(mcpSchema, null, 2)}\n`,
};

export async function publishConfigSchemas(dataDir: string): Promise<void> {
  const directory = path.join(dataDir, ".schemas");
  await fs.mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(CONFIG_SCHEMAS)) {
    const destination = path.join(directory, name);
    const current = Bun.file(destination);
    if ((await current.exists()) && (await current.text()) === content) continue;

    const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
    await using _cleanup = {
      [Symbol.asyncDispose]: () => fs.rm(temporary, { force: true }),
    };
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o644 });
    await fs.rename(temporary, destination);
  }
}
