import path from "node:path";

import ts from "typescript-codegen";

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const INPUT_PATH = path.join(ROOT_DIR, "packages/utils/model-provider-option-types.codegen.ts");
const OUTPUT_PATH = path.join(ROOT_DIR, "packages/utils/model-provider-option-shapes.generated.ts");
const CHECK = process.argv.includes("--check");
const MAX_SHAPE_DEPTH = 12;

const LEAF = Symbol("leaf");
const OPEN = Symbol("open");

type InternalOptionShape =
  | typeof LEAF
  | typeof OPEN
  | {
      kind: "object";
      properties: Record<string, InternalOptionShape>;
    }
  | {
      kind: "array";
      element: InternalOptionShape;
    }
  | {
      kind: "union";
      variants: InternalOptionShape[];
    };

type StructuredOptionShape = Exclude<InternalOptionShape, typeof LEAF | typeof OPEN>;
type ObjectOptionShape = Extract<StructuredOptionShape, { kind: "object" }>;
type ArrayOptionShape = Extract<StructuredOptionShape, { kind: "array" }>;

type GeneratedOptionShape =
  | null
  | {
      kind: "object";
      properties: Record<string, GeneratedOptionShape>;
    }
  | {
      kind: "array";
      element: GeneratedOptionShape;
    }
  | {
      kind: "union";
      variants: GeneratedOptionShape[];
    };

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) return message;

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${path.relative(ROOT_DIR, diagnostic.file.fileName)}:${line + 1}:${character + 1} ${message}`;
}

function mergeShapes(shapes: readonly InternalOptionShape[]): InternalOptionShape {
  if (shapes.includes(OPEN)) return OPEN;

  const structured: StructuredOptionShape[] = [];
  for (const shape of shapes) {
    if (shape === LEAF || shape === OPEN) continue;
    if (shape.kind !== "union") {
      structured.push(shape);
      continue;
    }
    for (const variant of shape.variants) {
      if (variant !== LEAF && variant !== OPEN && variant.kind !== "union") {
        structured.push(variant);
      }
    }
  }
  if (structured.length === 0) return LEAF;

  const objectShapes = structured.filter(
    (shape): shape is ObjectOptionShape => shape.kind === "object",
  );
  const arrayShapes = structured.filter(
    (shape): shape is ArrayOptionShape => shape.kind === "array",
  );
  const variants: InternalOptionShape[] = [];

  if (objectShapes.length > 0) {
    const propertyShapes = new Map<string, InternalOptionShape[]>();
    for (const shape of objectShapes) {
      for (const [key, propertyShape] of Object.entries(shape.properties)) {
        const existing = propertyShapes.get(key) ?? [];
        existing.push(propertyShape);
        propertyShapes.set(key, existing);
      }
    }

    variants.push({
      kind: "object",
      properties: Object.fromEntries(
        [...propertyShapes.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, propertyShape]) => [key, mergeShapes(propertyShape)]),
      ),
    });
  }

  if (arrayShapes.length > 0) {
    variants.push({
      kind: "array",
      element: mergeShapes(arrayShapes.map((shape) => shape.element)),
    });
  }

  return variants.length === 1 ? (variants[0] ?? LEAF) : { kind: "union", variants };
}

function buildShape(
  checker: ts.TypeChecker,
  inputType: ts.Type,
  activeTypes: Set<ts.Type>,
  depth: number,
): InternalOptionShape {
  if (depth >= MAX_SHAPE_DEPTH) return OPEN;

  const type = checker.getNonNullableType(inputType);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) {
    return OPEN;
  }
  if (type.isUnion()) {
    return mergeShapes(type.types.map((branch) => buildShape(checker, branch, activeTypes, depth)));
  }
  if (
    type.flags &
    (ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.ESSymbolLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Void |
      ts.TypeFlags.Never)
  ) {
    return LEAF;
  }
  if (activeTypes.has(type)) return OPEN;

  activeTypes.add(type);
  try {
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      return {
        kind: "array",
        element: elementType ? buildShape(checker, elementType, activeTypes, depth + 1) : OPEN,
      };
    }

    if (checker.getIndexTypeOfType(type, ts.IndexKind.String)) return OPEN;

    const properties: Record<string, InternalOptionShape> = {};
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) continue;
      properties[property.getName()] = buildShape(
        checker,
        checker.getTypeOfSymbolAtLocation(property, declaration),
        activeTypes,
        depth + 1,
      );
    }

    return Object.keys(properties).length > 0 ? { kind: "object", properties } : LEAF;
  } finally {
    activeTypes.delete(type);
  }
}

function toGeneratedShape(shape: InternalOptionShape): GeneratedOptionShape {
  if (shape === LEAF || shape === OPEN) return null;
  if (shape.kind === "array") {
    return { kind: "array", element: toGeneratedShape(shape.element) };
  }
  if (shape.kind === "union") {
    return { kind: "union", variants: shape.variants.map(toGeneratedShape) };
  }
  return {
    kind: "object",
    properties: Object.fromEntries(
      Object.entries(shape.properties)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, propertyShape]) => [key, toGeneratedShape(propertyShape)]),
    ),
  };
}

function getProviderOptionShapes(): Record<string, GeneratedOptionShape> {
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

  const providerTypes = checker.getTypeAtLocation(alias);
  const generated: Record<string, GeneratedOptionShape> = {};

  for (const namespaceSymbol of checker.getPropertiesOfType(providerTypes)) {
    const namespace = namespaceSymbol.getName();
    const declaration = namespaceSymbol.valueDeclaration ?? namespaceSymbol.declarations?.[0];
    if (!declaration) throw new Error(`No declaration found for namespace '${namespace}'`);

    const optionType = checker.getTypeOfSymbolAtLocation(namespaceSymbol, declaration);
    const shape = buildShape(checker, optionType, new Set(), 0);
    if (shape === LEAF || shape === OPEN || shape.kind !== "object") {
      throw new Error(
        `Provider option namespace '${namespace}' does not resolve to a finite object shape`,
      );
    }
    if (Object.keys(shape.properties).length === 0) {
      throw new Error(`Provider option namespace '${namespace}' resolved to no keys`);
    }
    generated[namespace] = toGeneratedShape(shape);
  }

  return Object.fromEntries(Object.entries(generated).sort(([a], [b]) => a.localeCompare(b)));
}

function renderGeneratedFile(shapes: Record<string, GeneratedOptionShape>): string {
  const serialized = JSON.stringify(shapes, null, 2);
  const unformatted =
    `// Generated by scripts/generate-provider-option-shapes.ts. Do not edit.\n` +
    `export const MODEL_PROVIDER_OPTION_SHAPES = ${serialized} as const;\n`;
  const formatted = Bun.spawnSync(["bunx", "oxfmt", "--stdin-filepath", OUTPUT_PATH], {
    cwd: ROOT_DIR,
    stdin: Buffer.from(unformatted),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!formatted.success) {
    throw new Error(`Failed to format generated provider options:\n${formatted.stderr.toString()}`);
  }
  return formatted.stdout.toString();
}

const generated = renderGeneratedFile(getProviderOptionShapes());
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
