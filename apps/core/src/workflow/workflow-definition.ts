import { createHash } from "node:crypto";
import ts from "typescript-codegen";
import { z } from "zod";

import {
  jsonObjectSchema,
  normalizeWorkflowCapabilityProfile,
  workflowLimitsSchema,
  workflowMetadataSchema,
  type JsonObject,
  type JsonValue,
  type WorkflowCapabilityProfile,
  type WorkflowLimits,
  type WorkflowMetadata,
  type WorkflowSafetyMode,
} from "./workflow-domain";

export const WORKFLOW_RUNTIME_VERSION = "lilac-workflow-js-v1";
export const MAX_WORKFLOW_SOURCE_BYTES = 256 * 1024;
export const MAX_WORKFLOW_INPUT_BYTES = 256 * 1024;

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_SCHEMA_ENUM_VALUES = 256;
const MAX_SCHEMA_STRING_LENGTH = 16_384;
const WORKFLOW_RUN_CONTEXT_NAMES = new Set([
  "args",
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "waitForReply",
  "sleep",
]);

export const workflowDefinitionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(WORKFLOW_NAME_PATTERN, "workflow name must use strict lowercase kebab-case");

const jsonPrimitiveSchema = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);
const sensitiveSchema = z.boolean().optional();

type WorkflowJsonSchema =
  | {
      type: "object";
      properties: Record<string, WorkflowJsonSchema>;
      required?: string[];
      additionalProperties?: false;
      description?: string;
      sensitive?: boolean;
    }
  | {
      type: "array";
      items: WorkflowJsonSchema;
      minItems?: number;
      maxItems?: number;
      description?: string;
      sensitive?: boolean;
    }
  | {
      type: "string";
      enum?: JsonValue[];
      const?: JsonValue;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      description?: string;
      sensitive?: boolean;
    }
  | {
      type: "number" | "integer";
      enum?: JsonValue[];
      const?: JsonValue;
      minimum?: number;
      maximum?: number;
      description?: string;
      sensitive?: boolean;
    }
  | {
      type: "boolean" | "null";
      enum?: JsonValue[];
      const?: JsonValue;
      description?: string;
      sensitive?: boolean;
    };

const workflowJsonSchema: z.ZodType<WorkflowJsonSchema> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("object"),
      properties: z.record(z.string(), workflowJsonSchema).default({}),
      required: z.array(z.string()).max(MAX_SCHEMA_PROPERTIES).optional(),
      additionalProperties: z.literal(false).optional(),
      description: z.string().max(MAX_SCHEMA_STRING_LENGTH).optional(),
      sensitive: sensitiveSchema,
    }),
    z.strictObject({
      type: z.literal("array"),
      items: workflowJsonSchema,
      minItems: z.number().int().nonnegative().max(10_000).optional(),
      maxItems: z.number().int().nonnegative().max(10_000).optional(),
      description: z.string().max(MAX_SCHEMA_STRING_LENGTH).optional(),
      sensitive: sensitiveSchema,
    }),
    z.strictObject({
      type: z.literal("string"),
      enum: z.array(jsonPrimitiveSchema).max(MAX_SCHEMA_ENUM_VALUES).optional(),
      const: jsonPrimitiveSchema.optional(),
      minLength: z.number().int().nonnegative().max(MAX_SCHEMA_STRING_LENGTH).optional(),
      maxLength: z.number().int().nonnegative().max(MAX_SCHEMA_STRING_LENGTH).optional(),
      pattern: z.string().max(1_000).optional(),
      description: z.string().max(MAX_SCHEMA_STRING_LENGTH).optional(),
      sensitive: sensitiveSchema,
    }),
    z.strictObject({
      type: z.enum(["number", "integer"]),
      enum: z.array(jsonPrimitiveSchema).max(MAX_SCHEMA_ENUM_VALUES).optional(),
      const: jsonPrimitiveSchema.optional(),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      description: z.string().max(MAX_SCHEMA_STRING_LENGTH).optional(),
      sensitive: sensitiveSchema,
    }),
    z.strictObject({
      type: z.enum(["boolean", "null"]),
      enum: z.array(jsonPrimitiveSchema).max(MAX_SCHEMA_ENUM_VALUES).optional(),
      const: jsonPrimitiveSchema.optional(),
      description: z.string().max(MAX_SCHEMA_STRING_LENGTH).optional(),
      sensitive: sensitiveSchema,
    }),
  ]),
);

const sourceCapabilitySchema = z.strictObject({
  agents: z.strictObject({
    profiles: z.array(z.string().min(1).max(100)).min(1).max(64),
    models: z.array(z.string().min(1).max(200)).min(1).max(64),
    maxConcurrent: z.number().int().min(1).max(64),
    maxTotal: z.number().int().min(1).max(10_000),
    editing: z.boolean(),
    isolation: z.enum(["shared", "worktree"]),
  }),
  waits: z
    .array(z.enum(["reply", "sleep"]))
    .max(16)
    .default([]),
  maxNestingDepth: z.number().int().min(1).max(64).default(8),
  maxWallTimeMs: z
    .number()
    .int()
    .min(1_000)
    .max(7 * 24 * 60 * 60 * 1_000)
    .default(60 * 60 * 1_000),
  operationIdleTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000)
    .default(10 * 60 * 1_000),
  surfaceSends: z.boolean().default(false),
  externalTools: z.boolean().default(false),
  safety: z
    .strictObject({ escalation: z.enum(["none", "trusted_with_review"]).default("none") })
    .default({ escalation: "none" }),
});

const sourceLimitsSchema = workflowLimitsSchema
  .partial()
  .strict()
  .transform((limits) =>
    workflowLimitsSchema.parse({
      maxSourceBytes: limits.maxSourceBytes ?? MAX_WORKFLOW_SOURCE_BYTES,
      maxInputBytes: limits.maxInputBytes ?? MAX_WORKFLOW_INPUT_BYTES,
      maxOperationOutputBytes: limits.maxOperationOutputBytes ?? 1024 * 1024,
      maxResultBytes: limits.maxResultBytes ?? 1024 * 1024,
      maxRuntimeMemoryBytes: limits.maxRuntimeMemoryBytes ?? 256 * 1024 * 1024,
    }),
  )
  .pipe(
    workflowLimitsSchema.extend({
      maxSourceBytes: z.number().int().positive().max(MAX_WORKFLOW_SOURCE_BYTES),
      maxInputBytes: z.number().int().positive().max(MAX_WORKFLOW_INPUT_BYTES),
      maxOperationOutputBytes: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024),
      maxResultBytes: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024),
      maxRuntimeMemoryBytes: z
        .number()
        .int()
        .min(64 * 1024 * 1024)
        .max(256 * 1024 * 1024),
    }),
  );

export type ValidatedWorkflowDefinition = {
  metadata: WorkflowMetadata;
  inputSchema: JsonObject;
  capabilities: WorkflowCapabilityProfile;
  limits: WorkflowLimits;
  sensitiveFields: string[];
  sourceSha256: string;
  inputSchemaSha256: string;
  capabilitySha256: string;
  reviewSummary: string;
};

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function canonicalJsonSha256(value: JsonValue): string {
  return sha256(canonicalJson(value));
}

function propertyName(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw new Error("Workflow metadata cannot use computed property names");
}

function literalValue(node: ts.Expression, depth = 0): JsonValue {
  if (depth > MAX_SCHEMA_DEPTH + 4) throw new Error("Workflow metadata exceeds maximum depth");
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(node.operand)
  ) {
    const value = Number(node.operand.text);
    return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        throw new Error("Workflow metadata arrays cannot contain spreads or holes");
      }
      return literalValue(element, depth + 1);
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    const output: Record<string, JsonValue> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error("Workflow metadata objects require explicit literal properties");
      }
      const name = propertyName(property.name);
      if (FORBIDDEN_KEYS.has(name)) throw new Error(`Forbidden workflow metadata key: ${name}`);
      if (Object.hasOwn(output, name)) throw new Error(`Duplicate workflow metadata key: ${name}`);
      output[name] = literalValue(property.initializer, depth + 1);
    }
    return output;
  }
  throw new Error("Workflow metadata must be composed only of static JSON literals");
}

function syntaxError(source: string): string | null {
  const result = ts.transpileModule(source, {
    fileName: "workflow.js",
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  });
  const diagnostic = result.diagnostics?.find(
    (item) => item.category === ts.DiagnosticCategory.Error,
  );
  return diagnostic ? ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") : null;
}

function assertNoForbiddenSyntax(sourceFile: ts.SourceFile, source: string): void {
  if (/[#@]\s*sourceMappingURL\s*=/u.test(source)) {
    throw new Error("Workflow source-map indirection is not allowed");
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw new Error("Dynamic import is not allowed in workflows");
      }
      if (
        ts.isIdentifier(node.expression) &&
        ["require", "eval", "Function"].includes(node.expression.text)
      ) {
        throw new Error(`${node.expression.text} is not allowed in workflows`);
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Function"
    ) {
      throw new Error("Function constructor is not allowed in workflows");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function extractDefinitionObject(source: string): ts.ObjectLiteralExpression {
  const parseError = syntaxError(source);
  if (parseError) throw new Error(`Invalid workflow JavaScript syntax: ${parseError}`);

  const sourceFile = ts.createSourceFile(
    "workflow.js",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  assertNoForbiddenSyntax(sourceFile, source);
  if (sourceFile.statements.length !== 2) {
    throw new Error("Workflow must contain exactly one import and one default export");
  }

  const importStatement = sourceFile.statements[0];
  if (!importStatement || !ts.isImportDeclaration(importStatement)) {
    throw new Error("Workflow first statement must import defineWorkflow");
  }
  if (
    !ts.isStringLiteral(importStatement.moduleSpecifier) ||
    importStatement.moduleSpecifier.text !== "@lilac/workflow"
  ) {
    throw new Error('Workflow may import only from "@lilac/workflow"');
  }
  if (importStatement.attributes) throw new Error("Workflow import attributes are not allowed");
  const clause = importStatement.importClause;
  if (
    !clause ||
    clause.isTypeOnly ||
    clause.name ||
    !clause.namedBindings ||
    !ts.isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.length !== 1
  ) {
    throw new Error(
      'Workflow import must be exactly: import { defineWorkflow } from "@lilac/workflow"',
    );
  }
  const imported = clause.namedBindings.elements[0];
  if (
    !imported ||
    imported.propertyName ||
    imported.name.text !== "defineWorkflow" ||
    imported.isTypeOnly
  ) {
    throw new Error("defineWorkflow cannot be aliased or imported as a type");
  }

  const exportStatement = sourceFile.statements[1];
  if (
    !exportStatement ||
    !ts.isExportAssignment(exportStatement) ||
    exportStatement.isExportEquals
  ) {
    throw new Error("Workflow must have exactly one default export");
  }
  const call = exportStatement.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "defineWorkflow" ||
    call.arguments.length !== 1
  ) {
    throw new Error("Default export must be defineWorkflow({...})");
  }
  const definition = call.arguments[0];
  if (!definition || !ts.isObjectLiteralExpression(definition)) {
    throw new Error("defineWorkflow requires one object literal");
  }
  return definition;
}

function extractStaticMetadata(definition: ts.ObjectLiteralExpression): JsonObject {
  const allowed = new Set(["name", "description", "input", "capabilities", "limits", "run"]);
  const output: Record<string, JsonValue> = {};
  const seen = new Set<string>();
  let hasRun = false;

  for (const property of definition.properties) {
    if (!property.name) throw new Error("Workflow definition properties must be named");
    const name = propertyName(property.name);
    if (!allowed.has(name)) throw new Error(`Unknown workflow definition property: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate workflow definition property: ${name}`);
    seen.add(name);
    if (name === "run") {
      if (!ts.isMethodDeclaration(property)) {
        throw new Error("Workflow run must use async method syntax");
      }
      const isAsync = property.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      );
      if (!isAsync || !property.body || property.parameters.length !== 1) {
        throw new Error("Workflow run must be an async method with exactly one context parameter");
      }
      const parameter = property.parameters[0];
      if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
        throw new Error("Workflow run context must use object destructuring");
      }
      for (const element of parameter.name.elements) {
        if (
          element.dotDotDotToken ||
          element.initializer ||
          !ts.isIdentifier(element.name) ||
          (element.propertyName !== undefined &&
            propertyName(element.propertyName) !== element.name.text) ||
          !WORKFLOW_RUN_CONTEXT_NAMES.has(element.name.text)
        ) {
          throw new Error(
            "Workflow run context may destructure only unaliased declared workflow APIs",
          );
        }
      }
      hasRun = true;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`Workflow ${name} must be an explicit static property`);
    }
    output[name] = literalValue(property.initializer);
  }
  if (!hasRun) throw new Error("Workflow definition requires an async run method");
  return jsonObjectSchema.parse(output);
}

function assertSchemaBounds(schema: WorkflowJsonSchema, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`Input schema exceeds depth ${MAX_SCHEMA_DEPTH}`);
  if (schema.type === "object") {
    const entries = Object.entries(schema.properties);
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      throw new Error(`Input schema exceeds ${MAX_SCHEMA_PROPERTIES} properties`);
    }
    for (const [key, child] of entries) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden input schema property: ${key}`);
      assertSchemaBounds(child, depth + 1);
    }
  } else if (schema.type === "array") {
    assertSchemaBounds(schema.items, depth + 1);
  }
  if (schema.type === "string") {
    if (
      schema.minLength !== undefined &&
      schema.maxLength !== undefined &&
      schema.minLength > schema.maxLength
    ) {
      throw new Error("Input schema minLength cannot exceed maxLength");
    }
  } else if (schema.type === "number" || schema.type === "integer") {
    if (
      schema.minimum !== undefined &&
      schema.maximum !== undefined &&
      schema.minimum > schema.maximum
    ) {
      throw new Error("Input schema minimum cannot exceed maximum");
    }
  } else if (schema.type === "array") {
    if (
      schema.minItems !== undefined &&
      schema.maxItems !== undefined &&
      schema.minItems > schema.maxItems
    ) {
      throw new Error("Input schema minItems cannot exceed maxItems");
    }
  }
  if (schema.type !== "object" && schema.type !== "array") {
    const matchesType = (value: JsonValue): boolean =>
      schema.type === "null"
        ? value === null
        : schema.type === "integer"
          ? typeof value === "number" && Number.isInteger(value)
          : typeof value === schema.type;
    if (schema.const !== undefined && !matchesType(schema.const)) {
      throw new Error(`Input schema const must match type ${schema.type}`);
    }
    if (schema.enum?.some((value) => !matchesType(value))) {
      throw new Error(`Input schema enum values must match type ${schema.type}`);
    }
  }
}

function normalizeInputSchema(schema: WorkflowJsonSchema): WorkflowJsonSchema {
  if (schema.type === "object") {
    const properties = Object.fromEntries(
      Object.entries(schema.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, normalizeInputSchema(value)]),
    );
    const required = [...new Set(schema.required ?? [])].sort((left, right) =>
      left.localeCompare(right),
    );
    for (const key of required) {
      if (!Object.hasOwn(properties, key))
        throw new Error(`Required input property is not defined: ${key}`);
    }
    return {
      ...schema,
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }
  if (schema.type === "array") return { ...schema, items: normalizeInputSchema(schema.items) };
  if (schema.type === "string" && schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern, "u");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid input schema pattern: ${message}`);
    }
  }
  return schema;
}

function collectSensitiveFields(schema: WorkflowJsonSchema, path: string[] = []): string[] {
  const fields = schema.sensitive && path.length > 0 ? [path.join(".")] : [];
  if (schema.type === "object") {
    for (const [key, child] of Object.entries(schema.properties)) {
      fields.push(...collectSensitiveFields(child, [...path, key]));
    }
  } else if (schema.type === "array") {
    fields.push(...collectSensitiveFields(schema.items, [...path, "*"]));
  }
  return fields.sort((left, right) => left.localeCompare(right));
}

function hasForbiddenJsonKey(value: JsonValue): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = hasForbiddenJsonKey(item);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return key;
    const found = hasForbiddenJsonKey(child);
    if (found) return found;
  }
  return null;
}

function assertPlainJsonObjects(value: JsonValue): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(assertPlainJsonObjects);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Workflow arguments must contain only plain JSON objects");
  }
  Object.values(value).forEach(assertPlainJsonObjects);
}

function addInputIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function validateSchemaValue(
  schema: WorkflowJsonSchema,
  value: JsonValue,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const expected = schema.type;
  const matches =
    expected === "null"
      ? value === null
      : expected === "array"
        ? Array.isArray(value)
        : expected === "object"
          ? value !== null && typeof value === "object" && !Array.isArray(value)
          : expected === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : typeof value === expected;
  if (!matches) {
    addInputIssue(ctx, path, `expected ${expected}`);
    return;
  }
  if (
    schema.type !== "object" &&
    schema.type !== "array" &&
    schema.const !== undefined &&
    canonicalJson(value) !== canonicalJson(schema.const)
  ) {
    addInputIssue(ctx, path, "value does not match const");
  }
  if (
    schema.type !== "object" &&
    schema.type !== "array" &&
    schema.enum &&
    !schema.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))
  ) {
    addInputIssue(ctx, path, "value is not in enum");
  }
  if (
    schema.type === "object" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required))
        addInputIssue(ctx, [...path, required], "required property is missing");
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties[key];
      if (!childSchema) addInputIssue(ctx, [...path, key], "unknown property");
      else validateSchemaValue(childSchema, child, ctx, [...path, key]);
    }
  } else if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      addInputIssue(ctx, path, `requires at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      addInputIssue(ctx, path, `allows at most ${schema.maxItems} items`);
    value.forEach((item, index) => validateSchemaValue(schema.items, item, ctx, [...path, index]));
  } else if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      addInputIssue(ctx, path, `requires at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      addInputIssue(ctx, path, `allows at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      addInputIssue(ctx, path, "does not match pattern");
  } else if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      addInputIssue(ctx, path, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      addInputIssue(ctx, path, `must be at most ${schema.maximum}`);
  }
}

export function validateWorkflowArgs(params: {
  inputSchema: JsonObject;
  args: unknown;
  maxInputBytes: number;
}): JsonObject {
  const args = jsonObjectSchema.parse(params.args);
  assertPlainJsonObjects(args);
  const forbiddenKey = hasForbiddenJsonKey(args);
  if (forbiddenKey) throw new Error(`Forbidden workflow argument key: ${forbiddenKey}`);
  const bytes = Buffer.byteLength(canonicalJson(args), "utf8");
  if (bytes > params.maxInputBytes) {
    throw new Error(`Workflow arguments exceed ${params.maxInputBytes} bytes`);
  }
  const schema = workflowJsonSchema.parse(params.inputSchema);
  return jsonObjectSchema
    .superRefine((value, ctx) => validateSchemaValue(schema, value, ctx, []))
    .parse(args);
}

export function validateWorkflowSource(params: {
  name: string;
  source: string;
  safetyMode?: WorkflowSafetyMode;
}): ValidatedWorkflowDefinition {
  const name = workflowDefinitionNameSchema.parse(params.name);
  const sourceBytes = Buffer.byteLength(params.source, "utf8");
  if (sourceBytes > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(`Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`);
  }
  const definition = extractDefinitionObject(params.source);
  const raw = extractStaticMetadata(definition);
  const metadata = workflowMetadataSchema.parse({ name: raw.name, description: raw.description });
  if (metadata.name !== name)
    throw new Error(`Workflow metadata name must match filename: ${name}`);
  const parsedInput = workflowJsonSchema.parse(raw.input);
  if (parsedInput.type !== "object")
    throw new Error("Workflow input schema root must have type object");
  assertSchemaBounds(parsedInput);
  const normalizedInput = normalizeInputSchema(parsedInput);
  const inputSchema = jsonObjectSchema.parse(normalizedInput);
  const sourceCapabilities = sourceCapabilitySchema.parse(raw.capabilities);
  const capabilities = normalizeWorkflowCapabilityProfile({
    ...sourceCapabilities,
    safety: {
      originatingMode: params.safetyMode ?? "trusted",
      escalation: sourceCapabilities.safety.escalation,
    },
  });
  const limits = sourceLimitsSchema.parse(raw.limits ?? {});
  if (sourceBytes > limits.maxSourceBytes) {
    throw new Error(
      `Workflow source exceeds its declared maxSourceBytes (${limits.maxSourceBytes})`,
    );
  }
  const sourceSha256 = sha256(params.source);
  const inputSchemaSha256 = canonicalJsonSha256(inputSchema);
  const capabilitySha256 = canonicalJsonSha256(jsonObjectSchema.parse({ capabilities, limits }));
  const sensitiveFields = collectSensitiveFields(normalizedInput);
  const reviewSummary = [
    `${metadata.name}: ${metadata.description}`,
    `Agents: profiles=${capabilities.agents.profiles.join(",")}; models=${capabilities.agents.models.join(",")}; max=${capabilities.agents.maxConcurrent}/${capabilities.agents.maxTotal}`,
    `Editing: ${capabilities.agents.editing ? `yes (${capabilities.agents.isolation})` : "no"}; waits=${capabilities.waits.join(",") || "none"}`,
    `Limits: wall=${capabilities.maxWallTimeMs}ms; input=${limits.maxInputBytes} bytes`,
    `Sensitive inputs: ${sensitiveFields.join(", ") || "none declared"}`,
  ].join("\n");

  return {
    metadata,
    inputSchema,
    capabilities,
    limits,
    sensitiveFields,
    sourceSha256,
    inputSchemaSha256,
    capabilitySha256,
    reviewSummary,
  };
}
