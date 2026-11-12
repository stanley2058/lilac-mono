import { readdir } from "node:fs/promises";
import path from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { baselineDirectory } from "../../scripts/generate-client-protocol-compat";

export async function loadCompatValidators(): Promise<Map<string, ValidateFunction>> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("uri", (value: string) => URL.canParse(value));
  const validators = new Map<string, ValidateFunction>();
  for (const file of (await readdir(baselineDirectory)).sort()) {
    if (!file.endsWith(".schema.json")) continue;
    const schema = await Bun.file(path.join(baselineDirectory, file)).json();
    if (!ajv.validateSchema(schema)) throw new Error(`${file}: ${ajv.errorsText()}`);
    validators.set(file.replace(/\.schema\.json$/u, ""), ajv.compile(schema));
  }
  for (const required of [
    "bootstrap",
    "streams.watch",
    "threads.sync",
    "cachePatch",
    "cacheRow",
    "questions.pending",
    "subagents.read",
    "workflows.get",
    "config.readDeployment",
  ]) {
    if (!validators.has(required)) throw new Error(`Missing previous-release schema: ${required}`);
  }
  return validators;
}

export function assertCompatible(
  validators: Map<string, ValidateFunction>,
  kind: string,
  payload: unknown,
): void {
  const validate = validators.get(kind);
  if (!validate) throw new Error(`Missing previous-release schema for ${kind}`);
  if (validate(payload)) return;
  const errors = validate.errors
    ?.map(
      (error) => `${error.instancePath || "/"}: ${error.message} ${JSON.stringify(error.params)}`,
    )
    .join("\n");
  throw new Error(
    `Client compatibility failure (${kind}):\n${errors}\nMake the change backward compatible, or bump the protocol/projection version, record a MIGRATIONS.md entry, and refresh the snapshot.`,
  );
}
