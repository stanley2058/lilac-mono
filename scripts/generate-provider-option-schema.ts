import path from "node:path";

import ts from "typescript-codegen";

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const INPUT_PATH = path.join(ROOT_DIR, "packages/utils/model-provider-option-types.codegen.ts");
const OUTPUT_PATH = path.join(ROOT_DIR, "packages/utils/model-provider-option-schema.generated.ts");
const CHECK = process.argv.includes("--check");
const MAX_SCHEMA_DEPTH = 12;

/** A JSON Schema subset that only admits values JSON can carry. */
type JsonSchema =
  | Record<string, never>
  | { type: "string"; enum?: string[] }
  | { type: "number"; enum?: number[] }
  | { type: "boolean"; enum?: boolean[] }
  | { type: "null" }
  | { type: "array"; items: JsonSchema }
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties: JsonSchema | false;
    }
  | { anyOf: JsonSchema[] };

const NON_JSON = Symbol("non-json");
type Converted = JsonSchema | typeof NON_JSON;

type Context = {
  checker: ts.TypeChecker;
  active: Set<ts.Type>;
  droppedPaths: string[];
};

const ANY_JSON: JsonSchema = {};

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) return message;

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${path.relative(ROOT_DIR, diagnostic.file.fileName)}:${line + 1}:${character + 1} ${message}`;
}

function isOmittable(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
}

function convertUnion(ctx: Context, types: readonly ts.Type[], pathKey: string, depth: number) {
  const strings = new Set<string>();
  const numbers = new Set<number>();
  const booleans = new Set<boolean>();
  let anyString = false;
  let anyNumber = false;
  let hasNull = false;
  const structured: JsonSchema[] = [];

  for (const branch of types) {
    if (isOmittable(branch)) continue;
    if (branch.flags & ts.TypeFlags.Null) {
      hasNull = true;
      continue;
    }
    if (branch.isStringLiteral()) {
      strings.add(branch.value);
      continue;
    }
    if (branch.isNumberLiteral()) {
      numbers.add(branch.value);
      continue;
    }
    if (branch.flags & ts.TypeFlags.BooleanLiteral) {
      booleans.add(ctx.checker.typeToString(branch) === "true");
      continue;
    }
    const converted = convertType(ctx, branch, pathKey, depth);
    if (converted === NON_JSON) continue;
    if ("anyOf" in converted) {
      structured.push(...converted.anyOf);
      continue;
    }
    if (!("type" in converted)) return ANY_JSON;
    if (converted.type === "string" && !converted.enum) anyString = true;
    else if (converted.type === "number" && !converted.enum) anyNumber = true;
    else structured.push(converted);
  }

  const variants: JsonSchema[] = [];
  if (anyString) variants.push({ type: "string" });
  else if (strings.size > 0) variants.push({ type: "string", enum: [...strings].sort() });
  if (anyNumber) variants.push({ type: "number" });
  else if (numbers.size > 0)
    variants.push({ type: "number", enum: [...numbers].sort((a, b) => a - b) });
  if (booleans.size === 2) variants.push({ type: "boolean" });
  else if (booleans.size === 1) variants.push({ type: "boolean", enum: [...booleans] });
  variants.push(...structured);
  if (hasNull) variants.push({ type: "null" });

  const unique = [...new Map(variants.map((v) => [JSON.stringify(v), v])).values()];
  if (unique.length === 0) return NON_JSON;
  if (unique.length === 1) return unique[0] ?? NON_JSON;
  return { anyOf: unique };
}

function hasMethodMembers(checker: ts.TypeChecker, type: ts.Type): boolean {
  return checker
    .getPropertiesOfType(type)
    .some((property) => (property.flags & ts.SymbolFlags.Method) !== 0);
}

function isOptionalProperty(symbol: ts.Symbol, type: ts.Type): boolean {
  if (symbol.flags & ts.SymbolFlags.Optional) return true;
  if (type.isUnion()) return type.types.some(isOmittable);
  return isOmittable(type) || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function convertObject(ctx: Context, type: ts.Type, pathKey: string, depth: number): Converted {
  const { checker } = ctx;
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return NON_JSON;
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (!elementType) return { type: "array", items: ANY_JSON };
    const items = convertType(ctx, elementType, `${pathKey}[]`, depth + 1);
    return items === NON_JSON ? NON_JSON : { type: "array", items };
  }
  // Class instances such as Date, Map, and Uint8Array declare methods; JSON data does not.
  if (hasMethodMembers(checker, type)) return NON_JSON;

  const indexType =
    checker.getIndexTypeOfType(type, ts.IndexKind.String) ??
    checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  let additionalProperties: JsonSchema | false = false;
  if (indexType) {
    const converted = convertType(ctx, indexType, `${pathKey}.*`, depth + 1);
    if (converted === NON_JSON) return NON_JSON;
    additionalProperties = converted;
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const sortedProperties = [...checker.getPropertiesOfType(type)].sort((a, b) =>
    a.getName().localeCompare(b.getName()),
  );
  for (const property of sortedProperties) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    const name = property.getName();
    const propertyPath = `${pathKey}.${name}`;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    // `key?: never` forbids the key in a union branch; it has no JSON value to describe.
    if (checker.getNonNullableType(propertyType).flags & ts.TypeFlags.Never) continue;
    const converted = convertType(ctx, propertyType, propertyPath, depth + 1);
    if (converted === NON_JSON) {
      ctx.droppedPaths.push(propertyPath);
      continue;
    }
    properties[name] = converted;
    if (!isOptionalProperty(property, propertyType)) required.push(name);
  }

  if (Object.keys(properties).length === 0 && !indexType) {
    // Every member was dropped, or the type has no members at all.
    return sortedProperties.length > 0
      ? NON_JSON
      : { type: "object", properties, additionalProperties: ANY_JSON };
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties,
  };
}

function convertType(ctx: Context, type: ts.Type, pathKey: string, depth: number): Converted {
  if (depth >= MAX_SCHEMA_DEPTH) return ANY_JSON;

  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) {
    return ANY_JSON;
  }
  if (type.isUnion()) return convertUnion(ctx, type.types, pathKey, depth);
  if (type.isStringLiteral()) return { type: "string", enum: [type.value] };
  if (type.isNumberLiteral()) return { type: "number", enum: [type.value] };
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return { type: "boolean", enum: [ctx.checker.typeToString(type) === "true"] };
  }
  if (
    type.flags &
    (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)
  ) {
    return { type: "string" };
  }
  if (type.flags & ts.TypeFlags.Number) return { type: "number" };
  if (type.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
  if (type.flags & ts.TypeFlags.Null) return { type: "null" };
  if (type.isIntersection() && type.types.some((part) => part.flags & ts.TypeFlags.StringLike)) {
    // Branded strings such as `string & {}` keep autocomplete in AI SDK model ID unions.
    return { type: "string" };
  }
  if (!(type.flags & ts.TypeFlags.Object) && !type.isIntersection()) return NON_JSON;

  // Recursive JSON value types refer back to themselves; accept any JSON at the cycle.
  if (ctx.active.has(type)) return ANY_JSON;
  ctx.active.add(type);
  try {
    return convertObject(ctx, type, pathKey, depth);
  } finally {
    ctx.active.delete(type);
  }
}

function getProviderOptionSchemas(): {
  schemas: Record<string, JsonSchema>;
  droppedPaths: string[];
} {
  const program = ts.createProgram([INPUT_PATH], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map(formatDiagnostic).join("\n"));
  }

  const checker = program.getTypeChecker();
  const source = program.getSourceFile(INPUT_PATH);
  if (!source) throw new Error(`Type source was not loaded: ${INPUT_PATH}`);

  const alias = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "ModelProviderOptionTypes",
  );
  if (!alias) throw new Error("ModelProviderOptionTypes type alias was not found");

  const ctx: Context = { checker, active: new Set(), droppedPaths: [] };
  const schemas: Record<string, JsonSchema> = {};
  for (const namespaceSymbol of checker.getPropertiesOfType(checker.getTypeAtLocation(alias))) {
    const namespace = namespaceSymbol.getName();
    const declaration = namespaceSymbol.valueDeclaration ?? namespaceSymbol.declarations?.[0];
    if (!declaration) throw new Error(`No declaration found for namespace '${namespace}'`);

    const optionType = checker.getNonNullableType(
      checker.getTypeOfSymbolAtLocation(namespaceSymbol, declaration),
    );
    const schema = convertType(ctx, optionType, namespace, 0);
    if (schema === NON_JSON || !("type" in schema) || schema.type !== "object") {
      throw new Error(`Provider option namespace '${namespace}' is not a JSON object type`);
    }
    if (Object.keys(schema.properties).length === 0) {
      throw new Error(`Provider option namespace '${namespace}' resolved to no JSON options`);
    }
    schemas[namespace] = schema;
  }

  return {
    schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
    droppedPaths: ctx.droppedPaths.sort(),
  };
}

function renderGeneratedFile(result: ReturnType<typeof getProviderOptionSchemas>): string {
  const unformatted =
    `// Generated by scripts/generate-provider-option-schema.ts. Do not edit.\n` +
    `/** JSON Schema for each AI SDK provider option namespace, limited to JSON-representable values. */\n` +
    `export const MODEL_PROVIDER_OPTION_SCHEMAS = ${JSON.stringify(result.schemas, null, 2)} as const;\n\n` +
    `/** Option paths omitted from the schemas because their values cannot be represented as JSON. */\n` +
    `export const MODEL_PROVIDER_OPTION_NON_JSON_PATHS = ${JSON.stringify(result.droppedPaths, null, 2)} as const;\n`;
  const formatted = Bun.spawnSync(["bunx", "oxfmt", "--stdin-filepath", OUTPUT_PATH], {
    cwd: ROOT_DIR,
    stdin: Buffer.from(unformatted),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!formatted.success) {
    throw new Error(`Failed to format provider option schemas:\n${formatted.stderr.toString()}`);
  }
  return formatted.stdout.toString();
}

const generated = renderGeneratedFile(getProviderOptionSchemas());
const outputFile = Bun.file(OUTPUT_PATH);

if (CHECK) {
  const current = (await outputFile.exists()) ? await outputFile.text() : "";
  if (current !== generated) {
    console.error(
      `${path.relative(ROOT_DIR, OUTPUT_PATH)} is stale. Run 'bun run codegen:model-options'.`,
    );
    process.exit(1);
  }
} else {
  await Bun.write(OUTPUT_PATH, generated);
  console.log(`Generated ${path.relative(ROOT_DIR, OUTPUT_PATH)}`);
}
