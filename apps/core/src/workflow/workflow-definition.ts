import { createHash } from "node:crypto";
import type ts from "typescript-codegen";
import { typescript } from "./typescript-compiler";
import { z } from "zod";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  jsonObjectSchema,
  compareCodeUnits,
  normalizeWorkflowResourcePolicyResult,
  workflowLimitsSchema,
  workflowMetadataSchema,
  type JsonObject,
  type JsonValue,
  type WorkflowResourcePolicy,
  type WorkflowLimits,
  type WorkflowMetadata,
} from "./workflow-domain";
import {
  REMOVED_AGENT_OPTIONS,
  workflowPipelineOptionsSchema,
  workflowRequestedAgentOptionsSchema,
  workflowWaitForReplyOptionsSchema,
} from "./workflow-operation-policy";

export const WORKFLOW_RUNTIME_VERSION = "lilac-workflow-js-v4";
export const MAX_WORKFLOW_SOURCE_BYTES = 256 * 1024;
export const MAX_WORKFLOW_INPUT_BYTES = 256 * 1024;

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_SCHEMA_ENUM_VALUES = 256;
const MAX_SCHEMA_STRING_LENGTH = 16_384;
const WORKFLOW_HOST_CALL_NAMES = new Set([
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "waitForReply",
  "sleep",
]);
const WORKFLOW_RUN_CONTEXT_NAMES = new Set(["args", ...WORKFLOW_HOST_CALL_NAMES]);
const REMOVED_REVISION_AGENT_FIELDS = [
  "profiles",
  "models",
  "reasoning",
  "allowedRoots",
  "tools",
  "executables",
  "editing",
  "delegation",
] as const;

export const workflowDefinitionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(WORKFLOW_NAME_PATTERN, "workflow name must use strict lowercase kebab-case");

const jsonPrimitiveSchema = z.union([z.null(), z.boolean(), z.number(), z.string()]);
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
      description: z.string().max(MAX_SCHEMA_STRING_LENGTH).optional(),
      sensitive: sensitiveSchema,
    }),
    z.strictObject({
      type: z.enum(["number", "integer"]),
      enum: z.array(jsonPrimitiveSchema).max(MAX_SCHEMA_ENUM_VALUES).optional(),
      const: jsonPrimitiveSchema.optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
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

const sourceResourcePolicySchema = z.strictObject({
  agents: z.strictObject({
    maxConcurrent: z.number().int().min(1).max(64),
    maxTotal: z.number().int().min(1).max(10_000),
  }),
  waits: z
    .array(z.enum(["reply", "sleep"]))
    .max(16)
    .default([]),
  maxNestingDepth: z.number().int().min(1).max(64).default(8),
  operationIdleTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000)
    .default(10 * 60 * 1_000),
});

const sourceLimitsSchema = workflowLimitsSchema
  .partial()
  .strict()
  .transform((limits) => ({
    maxSourceBytes: limits.maxSourceBytes ?? MAX_WORKFLOW_SOURCE_BYTES,
    maxInputBytes: limits.maxInputBytes ?? MAX_WORKFLOW_INPUT_BYTES,
    maxOperationOutputBytes: limits.maxOperationOutputBytes ?? 1024 * 1024,
    maxResultBytes: limits.maxResultBytes ?? 1024 * 1024,
  }))
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
    }),
  );

export type ValidatedWorkflowDefinition = {
  metadata: WorkflowMetadata;
  inputSchema: JsonObject;
  resources: WorkflowResourcePolicy;
  limits: WorkflowLimits;
  sensitiveFields: string[];
  sourceSha256: string;
  inputSchemaSha256: string;
  resourcePolicySha256: string;
  validationSummary: string;
};

export class WorkflowDefinitionInvalid extends TaggedError("WorkflowDefinitionInvalid")<{
  readonly message: string;
}> {}

export class WorkflowArgumentsInvalid extends TaggedError("WorkflowArgumentsInvalid")<{
  readonly message: string;
}> {}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function canonicalJsonSha256(value: JsonValue): string {
  return sha256(canonicalJson(value));
}

type WorkflowValidationState = { error: string | null };

function failValidation(state: WorkflowValidationState, message: string): void {
  state.error ??= message;
}

function propertyName(node: ts.PropertyName, state: WorkflowValidationState): string | undefined {
  if (
    typescript.isIdentifier(node) ||
    typescript.isStringLiteral(node) ||
    typescript.isNumericLiteral(node)
  ) {
    return node.text;
  }
  failValidation(state, "Workflow metadata cannot use computed property names");
  return undefined;
}

function literalValue(
  node: ts.Expression,
  state: WorkflowValidationState,
  depth = 0,
): JsonValue | undefined {
  if (depth > MAX_SCHEMA_DEPTH + 4) {
    failValidation(state, "Workflow metadata exceeds maximum depth");
    return undefined;
  }
  if (typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (typescript.isNumericLiteral(node)) {
    const value = Number(node.text);
    if (!Number.isFinite(value)) {
      failValidation(state, "Workflow numeric literals must be finite");
      return undefined;
    }
    return value;
  }
  if (node.kind === typescript.SyntaxKind.TrueKeyword) return true;
  if (node.kind === typescript.SyntaxKind.FalseKeyword) return false;
  if (node.kind === typescript.SyntaxKind.NullKeyword) return null;
  if (
    typescript.isPrefixUnaryExpression(node) &&
    (node.operator === typescript.SyntaxKind.MinusToken ||
      node.operator === typescript.SyntaxKind.PlusToken) &&
    typescript.isNumericLiteral(node.operand)
  ) {
    const value = Number(node.operand.text);
    if (!Number.isFinite(value)) {
      failValidation(state, "Workflow numeric literals must be finite");
      return undefined;
    }
    return node.operator === typescript.SyntaxKind.MinusToken ? -value : value;
  }
  if (typescript.isArrayLiteralExpression(node)) {
    const output: JsonValue[] = [];
    for (const element of node.elements) {
      if (typescript.isSpreadElement(element) || typescript.isOmittedExpression(element)) {
        failValidation(state, "Workflow metadata arrays cannot contain spreads or holes");
        return undefined;
      }
      const value = literalValue(element, state, depth + 1);
      if (state.error) return undefined;
      output.push(value!);
    }
    return output;
  }
  if (typescript.isObjectLiteralExpression(node)) {
    const output: Record<string, JsonValue> = {};
    for (const property of node.properties) {
      if (!typescript.isPropertyAssignment(property)) {
        failValidation(state, "Workflow metadata objects require explicit literal properties");
        return undefined;
      }
      const name = propertyName(property.name, state);
      if (name === undefined) return undefined;
      if (FORBIDDEN_KEYS.has(name)) {
        failValidation(state, `Forbidden workflow metadata key: ${name}`);
        return undefined;
      }
      if (Object.hasOwn(output, name)) {
        failValidation(state, `Duplicate workflow metadata key: ${name}`);
        return undefined;
      }
      const value = literalValue(property.initializer, state, depth + 1);
      if (state.error) return undefined;
      output[name] = value!;
    }
    return output;
  }
  failValidation(state, "Workflow metadata must be composed only of static JSON literals");
  return undefined;
}

function syntaxError(source: string): string | null {
  const result = typescript.transpileModule(source, {
    fileName: "workflow.js",
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ESNext,
    },
  });
  const diagnostic = result.diagnostics?.find(
    (item) => item.category === typescript.DiagnosticCategory.Error,
  );
  return diagnostic ? typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n") : null;
}

function assertNoForbiddenSyntax(
  sourceFile: ts.SourceFile,
  source: string,
  state: WorkflowValidationState,
): void {
  if (/[#@]\s*sourceMappingURL\s*=/u.test(source)) {
    failValidation(state, "Workflow source-map indirection is not allowed");
    return;
  }

  const visit = (node: ts.Node): void => {
    if (state.error) return;
    if (typescript.isNumericLiteral(node) && !Number.isFinite(Number(node.text))) {
      failValidation(state, "Workflow numeric literals must be finite");
      return;
    }
    if (typescript.isCallExpression(node)) {
      if (node.expression.kind === typescript.SyntaxKind.ImportKeyword) {
        failValidation(state, "Dynamic import is not allowed in workflows");
        return;
      }
      if (
        typescript.isIdentifier(node.expression) &&
        ["require", "eval", "Function"].includes(node.expression.text)
      ) {
        failValidation(state, `${node.expression.text} is not allowed in workflows`);
        return;
      }
    }
    if (
      typescript.isNewExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === "Function"
    ) {
      failValidation(state, "Function constructor is not allowed in workflows");
      return;
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function assertHelperParameters(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  state: WorkflowValidationState,
): void {
  const seen = new Set<string>();
  for (const parameter of parameters) {
    if (
      parameter.dotDotDotToken ||
      parameter.initializer ||
      parameter.questionToken ||
      !typescript.isIdentifier(parameter.name)
    ) {
      failValidation(state, "Workflow helper parameters must be plain identifiers");
      return;
    }
    if (seen.has(parameter.name.text)) {
      failValidation(state, `Duplicate workflow helper parameter: ${parameter.name.text}`);
      return;
    }
    seen.add(parameter.name.text);
  }
}

function assertHelperFunction(
  helper: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  state: WorkflowValidationState,
): void {
  if (!helper.body) {
    failValidation(state, "Workflow helper functions require a body");
    return;
  }
  if (
    (typescript.isFunctionDeclaration(helper) || typescript.isFunctionExpression(helper)) &&
    helper.name &&
    (helper.name.text === "defineWorkflow" || WORKFLOW_RUN_CONTEXT_NAMES.has(helper.name.text))
  ) {
    failValidation(state, `Workflow helper cannot use reserved binding: ${helper.name.text}`);
    return;
  }
  assertHelperParameters(helper.parameters, state);
  if (state.error) return;
  const parameters = new Set(helper.parameters.map((parameter) => parameter.name.getText()));
  const assertInstrumentableHostCalls = (node: ts.Node): void => {
    if (state.error) return;
    if (
      typescript.isCallExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      WORKFLOW_HOST_CALL_NAMES.has(node.expression.text) &&
      !parameters.has(node.expression.text)
    ) {
      failValidation(
        state,
        `Workflow helper must receive host API ${node.expression.text} as a same-named parameter`,
      );
      return;
    }
    typescript.forEachChild(node, assertInstrumentableHostCalls);
  };
  assertInstrumentableHostCalls(helper.body);
  assertNoShadowedWorkflowBindings(helper.body, state);
}

function assertTopLevelHelpers(
  statements: readonly ts.Statement[],
  state: WorkflowValidationState,
): void {
  const bindings = new Set<string>(["defineWorkflow"]);
  for (const statement of statements) {
    if (typescript.isFunctionDeclaration(statement)) {
      if (!statement.name) {
        failValidation(state, "Workflow helper function declarations must be named");
        return;
      }
      const name = statement.name.text;
      if (bindings.has(name) || WORKFLOW_RUN_CONTEXT_NAMES.has(name)) {
        failValidation(state, `Workflow helper cannot use reserved or duplicate binding: ${name}`);
        return;
      }
      bindings.add(name);
      assertHelperFunction(statement, state);
      if (state.error) return;
      continue;
    }
    if (
      !typescript.isVariableStatement(statement) ||
      !(statement.declarationList.flags & typescript.NodeFlags.Const)
    ) {
      failValidation(
        state,
        "Workflow top level may contain only pure function declarations and const declarations",
      );
      return;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!typescript.isIdentifier(declaration.name) || !declaration.initializer) {
        failValidation(state, "Workflow top-level constants require an identifier and initializer");
        return;
      }
      const name = declaration.name.text;
      if (bindings.has(name) || WORKFLOW_RUN_CONTEXT_NAMES.has(name)) {
        failValidation(state, `Workflow helper cannot use reserved or duplicate binding: ${name}`);
        return;
      }
      bindings.add(name);
      if (
        typescript.isArrowFunction(declaration.initializer) ||
        typescript.isFunctionExpression(declaration.initializer)
      ) {
        assertHelperFunction(declaration.initializer, state);
        if (state.error) return;
      } else {
        literalValue(declaration.initializer, state);
        if (state.error) {
          state.error = `Workflow top-level constant ${name} must be a static JSON literal or function`;
          return;
        }
      }
    }
  }
}

type WorkflowHelperInfo = {
  parameters: readonly string[];
  body: ts.ConciseBody;
};

function assertBindingSafeHostCalls(
  sourceFile: ts.SourceFile,
  definition: ts.ObjectLiteralExpression,
  state: WorkflowValidationState,
): void {
  const helpers = new Map<string, WorkflowHelperInfo>();
  for (const statement of sourceFile.statements.slice(1, -1)) {
    if (typescript.isFunctionDeclaration(statement) && statement.name && statement.body) {
      helpers.set(statement.name.text, {
        parameters: statement.parameters.map((parameter) => parameter.name.getText(sourceFile)),
        body: statement.body,
      });
    } else if (typescript.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          typescript.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (typescript.isArrowFunction(declaration.initializer) ||
            typescript.isFunctionExpression(declaration.initializer))
        ) {
          helpers.set(declaration.name.text, {
            parameters: declaration.initializer.parameters.map((parameter) =>
              parameter.name.getText(sourceFile),
            ),
            body: declaration.initializer.body,
          });
        }
      }
    }
  }

  const run = definition.properties.find(
    (property): property is ts.MethodDeclaration =>
      typescript.isMethodDeclaration(property) &&
      property.name !== undefined &&
      propertyName(property.name, state) === "run",
  );
  if (state.error) return;
  if (
    !run?.body ||
    !run.parameters[0] ||
    !typescript.isObjectBindingPattern(run.parameters[0].name)
  )
    return;

  const assertBody = (body: ts.Node, hostBindings: ReadonlySet<string>): void => {
    const visit = (node: ts.Node): void => {
      if (state.error) return;
      if (typescript.isCallExpression(node)) {
        if (typescript.isPropertyAccessExpression(node.expression)) {
          if (WORKFLOW_HOST_CALL_NAMES.has(node.expression.name.text)) {
            failValidation(
              state,
              `Workflow host API ${node.expression.name.text} must be called directly`,
            );
            return;
          }
        } else if (typescript.isElementAccessExpression(node.expression)) {
          const key = node.expression.argumentExpression;
          if (
            (typescript.isStringLiteral(key) && WORKFLOW_HOST_CALL_NAMES.has(key.text)) ||
            (typescript.isIdentifier(key) && WORKFLOW_HOST_CALL_NAMES.has(key.text))
          ) {
            failValidation(state, "Workflow host APIs cannot be called through computed members");
            return;
          }
        }

        const directHost =
          typescript.isIdentifier(node.expression) &&
          WORKFLOW_HOST_CALL_NAMES.has(node.expression.text);
        if (directHost && !hostBindings.has(node.expression.text)) {
          failValidation(
            state,
            `Workflow host API ${node.expression.text} is not bound in this scope`,
          );
          return;
        }
        if (directHost) {
          let current: ts.Node = node;
          while (current.parent && current.parent !== body) {
            current = current.parent;
            if (typescript.isFunctionLike(current)) {
              if ("body" in current && current.body === body) break;
              const parentCall = current.parent;
              const deterministicallyScoped =
                typescript.isCallExpression(parentCall) &&
                typescript.isIdentifier(parentCall.expression) &&
                (parentCall.expression.text === "pipeline" ||
                  parentCall.expression.text === "phase") &&
                parentCall.arguments.some((argument) => argument === current);
              if (!deterministicallyScoped) {
                failValidation(
                  state,
                  `Workflow host API ${node.expression.text} cannot be called from an unscoped callback`,
                );
                return;
              }
              break;
            }
          }
        }
        const helper = typescript.isIdentifier(node.expression)
          ? helpers.get(node.expression.text)
          : undefined;
        helper?.parameters.forEach((parameter, index) => {
          if (!WORKFLOW_HOST_CALL_NAMES.has(parameter)) return;
          const argument = node.arguments[index];
          if (
            !argument ||
            !typescript.isIdentifier(argument) ||
            argument.text !== parameter ||
            !hostBindings.has(parameter)
          ) {
            failValidation(
              state,
              `Workflow helper ${node.expression.getText(sourceFile)} requires same-named host binding ${parameter}`,
            );
          }
        });
        node.arguments.forEach((argument, index) => {
          if (typescript.isIdentifier(argument) && WORKFLOW_HOST_CALL_NAMES.has(argument.text)) {
            if (!hostBindings.has(argument.text) || helper?.parameters[index] !== argument.text) {
              failValidation(
                state,
                `Workflow host API ${argument.text} may only be forwarded to a same-named helper parameter`,
              );
            }
            return;
          }
          visit(argument);
        });
        if (!directHost) visit(node.expression);
        return;
      }
      if (typescript.isIdentifier(node) && WORKFLOW_HOST_CALL_NAMES.has(node.text)) {
        const parent = node.parent;
        const isPropertyName =
          (typescript.isPropertyAccessExpression(parent) && parent.name === node) ||
          ((typescript.isPropertyAssignment(parent) || typescript.isMethodDeclaration(parent)) &&
            parent.name === node);
        if (!isPropertyName) {
          failValidation(
            state,
            `Workflow host API ${node.text} may only be called directly or forwarded unchanged`,
          );
          return;
        }
      }
      typescript.forEachChild(node, visit);
    };
    visit(body);
  };

  const runBindings = new Set(
    run.parameters[0].name.elements.flatMap((element) =>
      typescript.isIdentifier(element.name) && WORKFLOW_HOST_CALL_NAMES.has(element.name.text)
        ? [element.name.text]
        : [],
    ),
  );
  assertBody(run.body, runBindings);
  if (state.error) return;
  for (const helper of helpers.values()) {
    assertBody(
      helper.body,
      new Set(helper.parameters.filter((parameter) => WORKFLOW_HOST_CALL_NAMES.has(parameter))),
    );
    if (state.error) return;
  }

  const directlyHostCalling = new Set<string>();
  const callsByHelper = new Map<string, Set<string>>();
  for (const [name, helper] of helpers) {
    const called = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (typescript.isCallExpression(node) && typescript.isIdentifier(node.expression)) {
        if (WORKFLOW_HOST_CALL_NAMES.has(node.expression.text)) directlyHostCalling.add(name);
        if (helpers.has(node.expression.text)) called.add(node.expression.text);
      }
      typescript.forEachChild(node, visit);
    };
    visit(helper.body);
    callsByHelper.set(name, called);
  }
  const hostCalling = new Set(directlyHostCalling);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, called] of callsByHelper) {
      if (!hostCalling.has(name) && [...called].some((callee) => hostCalling.has(callee))) {
        hostCalling.add(name);
        changed = true;
      }
    }
  }
  for (const helperName of hostCalling) {
    const invocations: ts.CallExpression[] = [];
    const collect = (node: ts.Node): void => {
      if (
        typescript.isCallExpression(node) &&
        typescript.isIdentifier(node.expression) &&
        node.expression.text === helperName
      ) {
        invocations.push(node);
      }
      typescript.forEachChild(node, collect);
    };
    collect(run.body);
    for (const helper of helpers.values()) collect(helper.body);
    if (invocations.length > 1) {
      failValidation(
        state,
        `Workflow helper ${helperName} contains host calls and cannot be invoked from multiple call sites`,
      );
      return;
    }
    for (const invocation of invocations) {
      let current: ts.Node = invocation;
      while (current.parent && !typescript.isFunctionLike(current.parent)) {
        current = current.parent;
        if (
          typescript.isForStatement(current) ||
          typescript.isForInStatement(current) ||
          typescript.isForOfStatement(current) ||
          typescript.isWhileStatement(current) ||
          typescript.isDoStatement(current)
        ) {
          failValidation(
            state,
            `Workflow helper ${helperName} contains host calls and cannot be invoked from a loop`,
          );
          return;
        }
      }
      const container = current.parent;
      const containerBody = container && "body" in container ? container.body : undefined;
      if (
        container &&
        typescript.isFunctionLike(container) &&
        !typescript.isMethodDeclaration(container) &&
        ![...helpers.values()].some((helper) => helper.body === containerBody)
      ) {
        const parentCall = container.parent;
        const callbackIsDeterministicallyScoped =
          typescript.isCallExpression(parentCall) &&
          typescript.isIdentifier(parentCall.expression) &&
          (parentCall.expression.text === "pipeline" || parentCall.expression.text === "phase") &&
          parentCall.arguments.some((argument) => argument === container);
        if (!callbackIsDeterministicallyScoped) {
          failValidation(
            state,
            `Workflow helper ${helperName} contains host calls and cannot be invoked from an unscoped callback`,
          );
          return;
        }
      }
    }
    const assertDirectReference = (node: ts.Node): void => {
      if (state.error) return;
      if (typescript.isIdentifier(node) && node.text === helperName) {
        const parent = node.parent;
        const declarationName =
          (typescript.isFunctionDeclaration(parent) || typescript.isVariableDeclaration(parent)) &&
          parent.name === node;
        const directCall = typescript.isCallExpression(parent) && parent.expression === node;
        if (!declarationName && !directCall) {
          failValidation(
            state,
            `Workflow helper ${helperName} contains host calls and must be invoked directly`,
          );
          return;
        }
      }
      typescript.forEachChild(node, assertDirectReference);
    };
    assertDirectReference(run.body);
    if (state.error) return;
    for (const helper of helpers.values()) assertDirectReference(helper.body);
    if (state.error) return;
  }
}

function assertStaticHostCallArguments(
  sourceFile: ts.SourceFile,
  state: WorkflowValidationState,
): void {
  const agentOptionKeys = new Set(["profile", "model", "reasoning", "cwd", "label"]);

  const assertStaticObject = (input: {
    node: ts.Expression;
    label: string;
    allowedKeys: ReadonlySet<string>;
    schema: z.ZodType;
    partialSchema: z.ZodType;
    requiredKeys?: ReadonlySet<string>;
    removedKeys?: ReadonlySet<string>;
  }): void => {
    if (!typescript.isObjectLiteralExpression(input.node)) return;
    let hasDynamicShape = false;
    let hasDynamicValue = false;
    const keys = new Set<string>();
    const staticValues: Record<string, JsonValue> = {};
    for (const property of input.node.properties) {
      if (typescript.isSpreadAssignment(property)) {
        hasDynamicShape = true;
        continue;
      }
      let name: string;
      if (typescript.isShorthandPropertyAssignment(property)) {
        name = property.name.text;
        hasDynamicValue = true;
      } else if (typescript.isPropertyAssignment(property)) {
        if (
          typescript.isComputedPropertyName(property.name) &&
          (typescript.isStringLiteral(property.name.expression) ||
            typescript.isNumericLiteral(property.name.expression))
        ) {
          name = property.name.expression.text;
        } else {
          const staticName = propertyName(property.name, state);
          if (staticName === undefined) {
            state.error = null;
            hasDynamicShape = true;
            continue;
          }
          name = staticName;
        }
        const staticValue = literalValue(property.initializer, state);
        if (state.error) {
          state.error = null;
          hasDynamicValue = true;
        } else {
          staticValues[name] = staticValue!;
        }
      } else {
        hasDynamicShape = true;
        continue;
      }
      if (input.removedKeys?.has(name)) {
        failValidation(
          state,
          `Workflow agent option '${name}' was removed; migrate to profile-native agent() options`,
        );
        return;
      }
      if (!input.allowedKeys.has(name)) {
        failValidation(state, `Unknown workflow ${input.label} option: ${name}`);
        return;
      }
      keys.add(name);
    }
    if (!hasDynamicShape) {
      for (const required of input.requiredKeys ?? []) {
        if (!keys.has(required)) {
          failValidation(state, `Workflow ${input.label} options require '${required}'`);
          return;
        }
      }
    }
    const parsed = (
      hasDynamicShape || hasDynamicValue ? input.partialSchema : input.schema
    ).safeParse(staticValues);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
      failValidation(state, `Invalid workflow ${input.label} options${path}: ${issue?.message}`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (state.error) return;
    if (typescript.isCallExpression(node) && typescript.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "agent") {
        if (node.arguments.length < 2) {
          failValidation(state, "Workflow agent() requires options with a profile");
          return;
        }
        if (node.arguments.length > 2) {
          failValidation(state, "Workflow agent() accepts exactly a prompt and options");
          return;
        }
        const options = node.arguments[1];
        if (options) {
          assertStaticObject({
            node: options,
            label: "agent",
            allowedKeys: agentOptionKeys,
            requiredKeys: new Set(["profile"]),
            removedKeys: new Set(REMOVED_AGENT_OPTIONS),
            schema: workflowRequestedAgentOptionsSchema,
            partialSchema: workflowRequestedAgentOptionsSchema.partial(),
          });
        }
      } else if (name === "parallel") {
        if (node.arguments.length !== 1) {
          failValidation(state, "Workflow parallel() accepts only an array of promises");
          return;
        }
      } else if (name === "pipeline") {
        if (node.arguments.length > 3) {
          failValidation(
            state,
            "Workflow pipeline() accepts items, a callback, and optional options",
          );
          return;
        }
        const options = node.arguments[2];
        if (options) {
          assertStaticObject({
            node: options,
            label: "pipeline",
            allowedKeys: new Set(["concurrency"]),
            schema: workflowPipelineOptionsSchema,
            partialSchema: workflowPipelineOptionsSchema,
          });
        }
      } else if (name === "waitForReply") {
        if (node.arguments.length > 1) {
          failValidation(state, "Workflow waitForReply() accepts one optional options object");
          return;
        }
        const options = node.arguments[0];
        if (options) {
          assertStaticObject({
            node: options,
            label: "waitForReply",
            allowedKeys: new Set([
              "prompt",
              "platform",
              "channelId",
              "messageId",
              "fromUserId",
              "timeoutMs",
            ]),
            schema: workflowWaitForReplyOptionsSchema,
            partialSchema: workflowWaitForReplyOptionsSchema,
          });
        }
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function extractDefinitionObject(
  source: string,
  state: WorkflowValidationState,
): ts.ObjectLiteralExpression | undefined {
  const parseError = syntaxError(source);
  if (parseError) {
    failValidation(state, `Invalid workflow JavaScript syntax: ${parseError}`);
    return undefined;
  }

  const sourceFile = typescript.createSourceFile(
    "workflow.js",
    source,
    typescript.ScriptTarget.ESNext,
    true,
    typescript.ScriptKind.JS,
  );
  assertNoForbiddenSyntax(sourceFile, source, state);
  if (state.error) return undefined;
  const importStatement = sourceFile.statements[0];
  if (!importStatement || !typescript.isImportDeclaration(importStatement)) {
    failValidation(state, "Workflow first statement must import defineWorkflow");
    return undefined;
  }
  if (
    !typescript.isStringLiteral(importStatement.moduleSpecifier) ||
    importStatement.moduleSpecifier.text !== "@lilac/workflow"
  ) {
    failValidation(state, 'Workflow may import only from "@lilac/workflow"');
    return undefined;
  }
  if (importStatement.attributes) {
    failValidation(state, "Workflow import attributes are not allowed");
    return undefined;
  }
  const clause = importStatement.importClause;
  if (
    !clause ||
    clause.phaseModifier === typescript.SyntaxKind.TypeKeyword ||
    clause.name ||
    !clause.namedBindings ||
    !typescript.isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.length !== 1
  ) {
    failValidation(
      state,
      'Workflow import must be exactly: import { defineWorkflow } from "@lilac/workflow"',
    );
    return undefined;
  }
  const imported = clause.namedBindings.elements[0];
  if (
    !imported ||
    imported.propertyName ||
    imported.name.text !== "defineWorkflow" ||
    imported.isTypeOnly
  ) {
    failValidation(state, "defineWorkflow cannot be aliased or imported as a type");
    return undefined;
  }

  const exportStatement = sourceFile.statements[sourceFile.statements.length - 1];
  if (
    !exportStatement ||
    !typescript.isExportAssignment(exportStatement) ||
    exportStatement.isExportEquals
  ) {
    failValidation(state, "Workflow last statement must be the default defineWorkflow export");
    return undefined;
  }
  assertTopLevelHelpers(sourceFile.statements.slice(1, -1), state);
  if (state.error) return undefined;
  const call = exportStatement.expression;
  if (
    !typescript.isCallExpression(call) ||
    !typescript.isIdentifier(call.expression) ||
    call.expression.text !== "defineWorkflow" ||
    call.arguments.length !== 1
  ) {
    failValidation(state, "Default export must be defineWorkflow({...})");
    return undefined;
  }
  const definition = call.arguments[0];
  if (!definition || !typescript.isObjectLiteralExpression(definition)) {
    failValidation(state, "defineWorkflow requires one object literal");
    return undefined;
  }
  assertBindingSafeHostCalls(sourceFile, definition, state);
  if (state.error) return undefined;
  assertStaticHostCallArguments(sourceFile, state);
  if (state.error) return undefined;
  return definition;
}

function extractStaticMetadata(
  definition: ts.ObjectLiteralExpression,
  state: WorkflowValidationState,
): JsonObject | undefined {
  const allowed = new Set(["name", "description", "input", "resources", "limits", "run"]);
  const output: Record<string, JsonValue> = {};
  const seen = new Set<string>();
  let hasRun = false;

  for (const property of definition.properties) {
    if (!property.name) {
      failValidation(state, "Workflow definition properties must be named");
      return undefined;
    }
    const name = propertyName(property.name, state);
    if (name === undefined) return undefined;
    if (name === "capabilities") {
      failValidation(
        state,
        "Workflow definition property 'capabilities' was removed; rename resource bounds to 'resources'",
      );
      return undefined;
    }
    if (!allowed.has(name)) {
      failValidation(state, `Unknown workflow definition property: ${name}`);
      return undefined;
    }
    if (seen.has(name)) {
      failValidation(state, `Duplicate workflow definition property: ${name}`);
      return undefined;
    }
    seen.add(name);
    if (name === "run") {
      if (!typescript.isMethodDeclaration(property)) {
        failValidation(state, "Workflow run must use async method syntax");
        return undefined;
      }
      const isAsync = property.modifiers?.some(
        (modifier) => modifier.kind === typescript.SyntaxKind.AsyncKeyword,
      );
      if (!isAsync || !property.body || property.parameters.length !== 1) {
        failValidation(
          state,
          "Workflow run must be an async method with exactly one context parameter",
        );
        return undefined;
      }
      const parameter = property.parameters[0];
      if (!parameter || !typescript.isObjectBindingPattern(parameter.name)) {
        failValidation(state, "Workflow run context must use object destructuring");
        return undefined;
      }
      for (const element of parameter.name.elements) {
        if (
          element.dotDotDotToken ||
          element.initializer ||
          !typescript.isIdentifier(element.name) ||
          (element.propertyName !== undefined &&
            propertyName(element.propertyName, state) !== element.name.text) ||
          !WORKFLOW_RUN_CONTEXT_NAMES.has(element.name.text)
        ) {
          failValidation(
            state,
            "Workflow run context may destructure only unaliased declared workflow APIs",
          );
          return undefined;
        }
      }
      assertNoShadowedWorkflowBindings(property.body, state);
      if (state.error) return undefined;
      hasRun = true;
      continue;
    }
    if (!typescript.isPropertyAssignment(property)) {
      failValidation(state, `Workflow ${name} must be an explicit static property`);
      return undefined;
    }
    const value = literalValue(property.initializer, state);
    if (state.error) return undefined;
    output[name] = value!;
  }
  if (!hasRun) {
    failValidation(state, "Workflow definition requires an async run method");
    return undefined;
  }
  const parsed = jsonObjectSchema.safeParse(output);
  if (!parsed.success) {
    failValidation(state, parsed.error.issues[0]?.message ?? "Workflow metadata is invalid");
    return undefined;
  }
  return parsed.data;
}

function bindingNames(name: ts.BindingName): string[] {
  if (typescript.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    typescript.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function assertNoShadowedWorkflowBindings(body: ts.Node, state: WorkflowValidationState): void {
  const reserved = WORKFLOW_RUN_CONTEXT_NAMES;
  const visit = (node: ts.Node): void => {
    if (state.error) return;
    let names: string[];
    if (
      typescript.isVariableDeclaration(node) ||
      typescript.isParameter(node) ||
      typescript.isBindingElement(node)
    ) {
      names = bindingNames(node.name);
    } else if (
      typescript.isFunctionDeclaration(node) ||
      typescript.isClassDeclaration(node) ||
      typescript.isFunctionExpression(node) ||
      typescript.isClassExpression(node)
    ) {
      names = node.name ? [node.name.text] : [];
    } else {
      names = [];
    }
    for (const name of names) {
      if (reserved.has(name)) {
        failValidation(state, `Workflow code cannot shadow reserved host API binding: ${name}`);
        return;
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(body);
}

function matchesWorkflowSchemaType(type: WorkflowJsonSchema["type"], value: JsonValue): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
  }
}

function assertSchemaBounds(
  schema: WorkflowJsonSchema,
  state: WorkflowValidationState,
  depth = 0,
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    failValidation(state, `Input schema exceeds depth ${MAX_SCHEMA_DEPTH}`);
    return;
  }
  if (schema.type === "object") {
    const entries = Object.entries(schema.properties);
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      failValidation(state, `Input schema exceeds ${MAX_SCHEMA_PROPERTIES} properties`);
      return;
    }
    for (const [key, child] of entries) {
      if (FORBIDDEN_KEYS.has(key)) {
        failValidation(state, `Forbidden input schema property: ${key}`);
        return;
      }
      assertSchemaBounds(child, state, depth + 1);
      if (state.error) return;
    }
  } else if (schema.type === "array") {
    assertSchemaBounds(schema.items, state, depth + 1);
    if (state.error) return;
  }
  if (schema.type === "string") {
    if (
      schema.minLength !== undefined &&
      schema.maxLength !== undefined &&
      schema.minLength > schema.maxLength
    ) {
      failValidation(state, "Input schema minLength cannot exceed maxLength");
      return;
    }
  } else if (schema.type === "number" || schema.type === "integer") {
    if (
      schema.minimum !== undefined &&
      schema.maximum !== undefined &&
      schema.minimum > schema.maximum
    ) {
      failValidation(state, "Input schema minimum cannot exceed maximum");
      return;
    }
  } else if (schema.type === "array") {
    if (
      schema.minItems !== undefined &&
      schema.maxItems !== undefined &&
      schema.minItems > schema.maxItems
    ) {
      failValidation(state, "Input schema minItems cannot exceed maxItems");
      return;
    }
  }
  if (schema.type !== "object" && schema.type !== "array") {
    const matchesType = (value: JsonValue): boolean =>
      matchesWorkflowSchemaType(schema.type, value);
    if (schema.const !== undefined && !matchesType(schema.const)) {
      failValidation(state, `Input schema const must match type ${schema.type}`);
      return;
    }
    if (schema.enum?.some((value) => !matchesType(value))) {
      failValidation(state, `Input schema enum values must match type ${schema.type}`);
    }
  }
}

function normalizeInputSchema(
  schema: WorkflowJsonSchema,
  state: WorkflowValidationState,
): WorkflowJsonSchema | undefined {
  if (schema.type === "object") {
    const properties: Record<string, WorkflowJsonSchema> = {};
    for (const [key, value] of Object.entries(schema.properties).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      const normalized = normalizeInputSchema(value, state);
      if (!normalized) return undefined;
      properties[key] = normalized;
    }
    const required = [...new Set(schema.required ?? [])].sort(compareCodeUnits);
    for (const key of required) {
      if (!Object.hasOwn(properties, key)) {
        failValidation(state, `Required input property is not defined: ${key}`);
        return undefined;
      }
    }
    return {
      ...schema,
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }
  if (schema.type === "array") {
    const items = normalizeInputSchema(schema.items, state);
    return items ? { ...schema, items } : undefined;
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
  return fields.sort(compareCodeUnits);
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

function assertPlainJsonObjects(value: JsonValue, state: WorkflowValidationState): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) {
      assertPlainJsonObjects(item, state);
      if (state.error) return;
    }
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failValidation(state, "Workflow arguments must contain only plain JSON objects");
    return;
  }
  for (const child of Object.values(value)) {
    assertPlainJsonObjects(child, state);
    if (state.error) return;
  }
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
  const matches = matchesWorkflowSchemaType(expected, value);
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
  } else if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      addInputIssue(ctx, path, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      addInputIssue(ctx, path, `must be at most ${schema.maximum}`);
  }
}

export function validateWorkflowArgsUnchecked(params: {
  inputSchema: JsonObject;
  args: unknown;
  maxInputBytes: number;
}): ResultType<JsonObject, WorkflowArgumentsInvalid> {
  const parsedArgs = jsonObjectSchema.safeParse(params.args);
  if (!parsedArgs.success) {
    return Result.err(
      new WorkflowArgumentsInvalid({
        message: parsedArgs.error.issues[0]?.message ?? "Workflow arguments are invalid",
      }),
    );
  }
  const args = parsedArgs.data;
  const state: WorkflowValidationState = { error: null };
  assertPlainJsonObjects(args, state);
  if (state.error) return Result.err(new WorkflowArgumentsInvalid({ message: state.error }));
  const forbiddenKey = hasForbiddenJsonKey(args);
  if (forbiddenKey) {
    return Result.err(
      new WorkflowArgumentsInvalid({ message: `Forbidden workflow argument key: ${forbiddenKey}` }),
    );
  }
  const bytes = Buffer.byteLength(canonicalJson(args), "utf8");
  if (bytes > params.maxInputBytes) {
    return Result.err(
      new WorkflowArgumentsInvalid({
        message: `Workflow arguments exceed ${params.maxInputBytes} bytes`,
      }),
    );
  }
  const parsedSchema = workflowJsonSchema.safeParse(params.inputSchema);
  if (!parsedSchema.success) {
    return Result.err(
      new WorkflowArgumentsInvalid({
        message: parsedSchema.error.issues[0]?.message ?? "Workflow input schema is invalid",
      }),
    );
  }
  const validated = jsonObjectSchema
    .superRefine((value, ctx) => validateSchemaValue(parsedSchema.data, value, ctx, []))
    .safeParse(args);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return Result.err(
      new WorkflowArgumentsInvalid({
        message: `${location}${issue?.message ?? "Workflow arguments are invalid"}`,
      }),
    );
  }
  return Result.ok(validated.data);
}

export function validateWorkflowSourceUnchecked(params: {
  name: string;
  source: string;
}): ResultType<ValidatedWorkflowDefinition, WorkflowDefinitionInvalid> {
  return Result.gen(function* () {
    const invalid = (message: string): ResultType<never, WorkflowDefinitionInvalid> =>
      Result.err(new WorkflowDefinitionInvalid({ message }));
    const parsedName = workflowDefinitionNameSchema.safeParse(params.name);
    if (!parsedName.success) {
      return invalid(parsedName.error.issues[0]?.message ?? "Workflow name is invalid");
    }
    const name = parsedName.data;
    const sourceBytes = Buffer.byteLength(params.source, "utf8");
    if (sourceBytes > MAX_WORKFLOW_SOURCE_BYTES) {
      return invalid(`Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`);
    }
    const state: WorkflowValidationState = { error: null };
    const definition = extractDefinitionObject(params.source, state);
    if (!definition || state.error) return invalid(state.error ?? "Workflow definition is invalid");
    const raw = extractStaticMetadata(definition, state);
    if (!raw || state.error) return invalid(state.error ?? "Workflow metadata is invalid");
    const parsedMetadata = workflowMetadataSchema.safeParse({
      name: raw.name,
      description: raw.description,
    });
    if (!parsedMetadata.success) {
      return invalid(parsedMetadata.error.issues[0]?.message ?? "Workflow metadata is invalid");
    }
    const metadata = parsedMetadata.data;
    if (metadata.name !== name)
      return invalid(`Workflow metadata name must match filename: ${name}`);
    const inputResult = workflowJsonSchema.safeParse(raw.input);
    if (!inputResult.success) {
      return invalid(inputResult.error.issues[0]?.message ?? "Workflow input schema is invalid");
    }
    const parsedInput = inputResult.data;
    if (parsedInput.type !== "object")
      return invalid("Workflow input schema root must have type object");
    assertSchemaBounds(parsedInput, state);
    if (state.error) return invalid(state.error);
    const normalizedInput = normalizeInputSchema(parsedInput, state);
    if (!normalizedInput || state.error)
      return invalid(state.error ?? "Workflow input schema is invalid");
    const parsedInputSchema = jsonObjectSchema.safeParse(normalizedInput);
    if (!parsedInputSchema.success) {
      return invalid(
        parsedInputSchema.error.issues[0]?.message ?? "Workflow input schema is invalid",
      );
    }
    const inputSchema = parsedInputSchema.data;
    const rawResources = jsonObjectSchema.safeParse(raw.resources);
    if (rawResources.success) {
      if ("maxWallTimeMs" in rawResources.data) {
        return invalid(
          "Workflow revision field 'resources.maxWallTimeMs' was removed; workflows no longer have a wall-time limit",
        );
      }
      if ("safety" in rawResources.data) {
        return invalid(
          "Workflow revision field 'resources.safety' was removed; delete it from the workflow definition",
        );
      }
      const rawAgents = jsonObjectSchema.safeParse(rawResources.data["agents"]);
      const removedAgentField = rawAgents.success
        ? REMOVED_REVISION_AGENT_FIELDS.find((field) => field in rawAgents.data)
        : undefined;
      if (removedAgentField) {
        return invalid(
          `Workflow revision field 'agents.${removedAgentField}' was removed; migrate to profile-native agent() options`,
        );
      }
      const removedTopLevel = ["level2", "surfaces"].find((field) => field in rawResources.data);
      if (removedTopLevel) {
        return invalid(
          `Workflow revision field '${removedTopLevel}' was removed; profiles now own agent tool access`,
        );
      }
    }
    const rawLimits = jsonObjectSchema.safeParse(raw.limits ?? {});
    if (rawLimits.success && "maxRuntimeMemoryBytes" in rawLimits.data) {
      return invalid(
        "Workflow revision field 'limits.maxRuntimeMemoryBytes' was removed; delete it from the workflow definition",
      );
    }
    const sourceResources = sourceResourcePolicySchema.safeParse(raw.resources);
    if (!sourceResources.success) {
      return invalid(sourceResources.error.issues[0]?.message ?? "Workflow resources are invalid");
    }
    const resources = yield* normalizeWorkflowResourcePolicyResult(sourceResources.data).mapError(
      (error) => new WorkflowDefinitionInvalid({ message: error.message }),
    );
    const limitsResult = sourceLimitsSchema.safeParse(raw.limits ?? {});
    if (!limitsResult.success) {
      return invalid(limitsResult.error.issues[0]?.message ?? "Workflow limits are invalid");
    }
    const limits = limitsResult.data;
    if (sourceBytes > limits.maxSourceBytes) {
      return invalid(
        `Workflow source exceeds its declared maxSourceBytes (${limits.maxSourceBytes})`,
      );
    }
    const sourceSha256 = sha256(params.source);
    const inputSchemaSha256 = canonicalJsonSha256(inputSchema);
    const policyJson = jsonObjectSchema.safeParse({ resources, limits });
    if (!policyJson.success) return invalid("Workflow resource policy is not canonical JSON");
    const resourcePolicySha256 = canonicalJsonSha256(policyJson.data);
    const sensitiveFields = collectSensitiveFields(normalizedInput);
    const validationSummary = [
      `${metadata.name}: ${metadata.description}`,
      `Agents: max=${resources.agents.maxConcurrent}/${resources.agents.maxTotal}`,
      `Waits: ${resources.waits.join(",") || "none"}`,
      `Limits: input=${limits.maxInputBytes} bytes`,
      `Sensitive inputs: ${sensitiveFields.join(", ") || "none declared"}`,
    ].join("\n");

    return Result.ok({
      metadata,
      inputSchema,
      resources,
      limits,
      sensitiveFields,
      sourceSha256,
      inputSchemaSha256,
      resourcePolicySha256,
      validationSummary,
    });
  });
}
