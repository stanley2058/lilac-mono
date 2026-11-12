import { readdir } from "node:fs/promises";
import path from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { baselineDirectory } from "../../scripts/generate-client-protocol-compat";

/**
 * Payloads that released clients decode with their strict Zod schemas: the bootstrap reply (web
 * and TUI) and IndexedDB cache rows, which also hold every display part. Other RPC results reach
 * clients without validation, so a server may add fields to them but not drop or retype fields.
 */
const STRICTLY_DECODED = new Set(["bootstrap", "bootstrapReplySchema", "cachePatch", "cacheRow"]);

export type CompatValidator = { strict: ValidateFunction; lenient: ValidateFunction };

function allowAdditions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(allowAdditions);
  if (!schema || typeof schema !== "object") return schema;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((key === "additionalProperties" || key === "unevaluatedProperties") && value === false)
      continue;
    copy[key] = allowAdditions(value);
  }
  return copy;
}

export async function loadCompatValidators(): Promise<Map<string, CompatValidator>> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("uri", (value: string) => URL.canParse(value));
  const validators = new Map<string, CompatValidator>();
  for (const file of (await readdir(baselineDirectory)).sort()) {
    if (!file.endsWith(".schema.json")) continue;
    const schema = await Bun.file(path.join(baselineDirectory, file)).json();
    if (!ajv.validateSchema(schema)) throw new Error(`${file}: ${ajv.errorsText()}`);
    validators.set(file.replace(/\.schema\.json$/u, ""), {
      strict: ajv.compile(schema),
      lenient: ajv.compile(allowAdditions(schema) as object),
    });
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
  validators: Map<string, CompatValidator>,
  kind: string,
  payload: unknown,
): void {
  const validator = validators.get(kind);
  if (!validator) throw new Error(`Missing previous-release schema for ${kind}`);
  const validate = STRICTLY_DECODED.has(kind) ? validator.strict : validator.lenient;
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
