import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import ts from "typescript-codegen";

import {
  BLOB_STORAGE_ARCHITECTURE_POLICY,
  architectureManifest,
  type ArchitectureManifest,
  type BlobStorageArchitecturePolicy,
  type ExceptionDirection,
} from "../architecture/manifest.ts";
import {
  type ExceptionFlowKind,
  SYNTACTIC_POLICY,
  type SyntacticPolicy,
} from "./syntax-policy.mts";
import {
  createFinding,
  isExcludedProductionFile,
  normalizeFilePath,
  scriptKindFor,
  type SyntacticFinding,
  sourceIdentity,
} from "./syntax-rule-utils.mts";

export type LocalRecordGuardKind = "local-record-guard";
export type ElseAfterTerminalKind = "else-after-terminal";
export type PresentationDecoderImportKind = "presentation-decoder-import";
export type PreferSwitchTrueChainKind = "prefer-switch-true-chain";
export type ResultCallbackKind = "inline-async-result-callback";
export type StoreInlineDecodingKind = "store-inline-json-decoding" | "store-inline-schema-decoding";
export type DirectSqliteTransactionKind =
  | "direct-sqlite-transaction"
  | "manual-sqlite-transaction-control";
export type BlobStorageSeamKind =
  | "adapter-construction-import"
  | "blob-domain-import"
  | "blob-materialization-locality"
  | "blob-store-close-ownership"
  | "core-inline-blob-column"
  | "current-inline-blob-value"
  | "legacy-blob-decoder-import"
  | "s3-storage-import";

export function parseProductionSyntaxSource(sourceText: string, filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
}

function propertyAccessParts(
  expression: ts.Expression,
): readonly [ts.Expression, string] | undefined {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return [unwrapped.expression, unwrapped.name.text];
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    ts.isStringLiteral(unwrapped.argumentExpression)
  ) {
    return [unwrapped.expression, unwrapped.argumentExpression.text];
  }
  return undefined;
}

function unwrappedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function registrationOwnsSourceSymbol(
  module: string,
  symbol: string,
  identity: { readonly module: string; readonly exportName: string },
): boolean {
  return (
    moduleWithoutExtension(identity.module) === module &&
    (symbol === identity.exportName || symbol.startsWith(`${identity.exportName}.`))
  );
}

function findingOwnedByRegistration<Kind extends string>(
  finding: SyntacticFinding<Kind>,
  registrations: readonly {
    readonly identity: { readonly module: string; readonly exportName: string };
  }[],
): boolean {
  return registrations.some((registration) =>
    registrationOwnsSourceSymbol(finding.module, finding.symbol, registration.identity),
  );
}

function isGlobalThis(expression: ts.Expression): boolean {
  const unwrapped = unwrappedExpression(expression);
  return ts.isIdentifier(unwrapped) && unwrapped.text === "globalThis";
}

function isGlobalPromiseExpression(
  expression: ts.Expression,
  constructorNames: ReadonlyMap<string, number>,
  at: number,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const availableAt = constructorNames.get(unwrapped.text);
    return availableAt !== undefined && availableAt <= at;
  }
  const parts = propertyAccessParts(unwrapped);
  return !!parts && isGlobalThis(parts[0]) && parts[1] === "Promise";
}

function collectBindingNameCounts(sourceFile: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      counts.set(name.text, (counts.get(name.text) ?? 0) + 1);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) add(element.name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) add(node.name);
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name);
    if (ts.isImportClause(node) && node.name) add(node.name);
    if (
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      add(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}

function setProvenance(
  provenance: Map<string, number>,
  counts: ReadonlyMap<string, number>,
  name: string,
  position: number,
): boolean {
  if (counts.get(name) !== 1) return false;
  const current = provenance.get(name);
  if (current !== undefined && current <= position) return false;
  provenance.set(name, position);
  return true;
}

interface PromiseProvenance {
  readonly asyncFunctions: ReadonlyMap<string, number>;
  readonly constructors: ReadonlyMap<string, number>;
  readonly globalFetchAvailable: boolean;
  readonly promiseFunctions: ReadonlyMap<string, number>;
  readonly promiseModuleNamespaces: ReadonlyMap<string, number>;
  readonly promiseValues: ReadonlyMap<string, number>;
  readonly rejectFunctions: ReadonlyMap<string, number>;
}

const PROMISE_STATIC_PRODUCERS = new Set([
  "all",
  "allSettled",
  "any",
  "race",
  "reject",
  "resolve",
  "try",
]);

const PROMISE_ONLY_STANDARD_MODULES = new Set([
  "dns/promises",
  "fs/promises",
  "node:dns/promises",
  "node:fs/promises",
  "node:stream/promises",
  "node:timers/promises",
  "stream/promises",
  "timers/promises",
]);

function isPromiseStaticCall(
  call: ts.CallExpression,
  constructors: ReadonlyMap<string, number>,
): boolean {
  const parts = propertyAccessParts(call.expression);
  return (
    !!parts &&
    PROMISE_STATIC_PRODUCERS.has(parts[1]) &&
    isGlobalPromiseExpression(parts[0], constructors, call.getStart())
  );
}

function isGlobalFetchExpression(
  expression: ts.Expression,
  provenance: PromiseProvenance,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text === "fetch" && provenance.globalFetchAvailable;
  }
  const parts = propertyAccessParts(unwrapped);
  return !!parts && isGlobalThis(parts[0]) && parts[1] === "fetch";
}

function isKnownPromiseExpression(
  expression: ts.Expression,
  provenance: PromiseProvenance,
  at: number,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const availableAt = provenance.promiseValues.get(unwrapped.text);
    return availableAt !== undefined && availableAt <= at;
  }
  if (ts.isAwaitExpression(unwrapped)) return false;
  if (ts.isNewExpression(unwrapped)) {
    return isGlobalPromiseExpression(unwrapped.expression, provenance.constructors, at);
  }
  if (!ts.isCallExpression(unwrapped)) return false;
  if (isPromiseStaticCall(unwrapped, provenance.constructors)) return true;
  const callee = unwrappedExpression(unwrapped.expression);
  if (ts.isIdentifier(callee)) {
    if ((provenance.asyncFunctions.get(callee.text) ?? Number.POSITIVE_INFINITY) <= at) return true;
    if ((provenance.promiseFunctions.get(callee.text) ?? Number.POSITIVE_INFINITY) <= at)
      return true;
  }
  if (isGlobalFetchExpression(callee, provenance)) return true;
  if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
    return (
      callee.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
    );
  }
  const parts = propertyAccessParts(callee);
  if (
    parts &&
    ts.isIdentifier(unwrappedExpression(parts[0])) &&
    (provenance.promiseModuleNamespaces.get(unwrappedExpression(parts[0]).getText()) ??
      Number.POSITIVE_INFINITY) <= at
  ) {
    return true;
  }
  return (
    !!parts &&
    (parts[1] === "catch" || parts[1] === "finally" || parts[1] === "then") &&
    isKnownPromiseExpression(parts[0], provenance, at)
  );
}

function collectPromiseProvenance(sourceFile: ts.SourceFile): PromiseProvenance {
  const counts = collectBindingNameCounts(sourceFile);
  const constructors = new Map<string, number>();
  const rejectFunctions = new Map<string, number>();
  const promiseFunctions = new Map<string, number>();
  const promiseModuleNamespaces = new Map<string, number>();
  const promiseValues = new Map<string, number>();
  const asyncFunctions = new Map<string, number>();
  if (!counts.has("Promise")) constructors.set("Promise", 0);
  const globalFetchAvailable = !counts.has("fetch");
  const variableDeclarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !PROMISE_ONLY_STANDARD_MODULES.has(statement.moduleSpecifier.text) ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (!importClause) continue;
    if (importClause.name) {
      setProvenance(promiseModuleNamespaces, counts, importClause.name.text, 0);
    }
    const bindings = importClause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      setProvenance(promiseModuleNamespaces, counts, bindings.name.text, 0);
      continue;
    }
    for (const specifier of bindings.elements) {
      if (!specifier.isTypeOnly) {
        setProvenance(promiseFunctions, counts, specifier.name.text, 0);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      setProvenance(asyncFunctions, counts, node.name.text, 0);
    } else if (ts.isVariableDeclaration(node)) {
      variableDeclarations.push(node);
      const initializer = node.initializer && unwrappedExpression(node.initializer);
      if (
        ts.isIdentifier(node.name) &&
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        setProvenance(asyncFunctions, counts, node.name.text, node.getStart(sourceFile));
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of variableDeclarations) {
      const initializer = declaration.initializer;
      if (!initializer || !ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const position = declaration.getStart(sourceFile);
      if (isGlobalPromiseExpression(initializer, constructors, position)) {
        changed = setProvenance(constructors, counts, name, position) || changed;
      }
      const parts = propertyAccessParts(unwrappedExpression(initializer));
      if (
        parts &&
        parts[1] === "reject" &&
        isGlobalPromiseExpression(parts[0], constructors, position)
      ) {
        changed = setProvenance(rejectFunctions, counts, name, position) || changed;
      }
      const current: PromiseProvenance = {
        asyncFunctions,
        constructors,
        globalFetchAvailable,
        promiseFunctions,
        promiseModuleNamespaces,
        promiseValues,
        rejectFunctions,
      };
      if (isKnownPromiseExpression(initializer, current, position)) {
        changed = setProvenance(promiseValues, counts, name, position) || changed;
      }
    }
    for (const assignment of assignments) {
      if (!ts.isIdentifier(assignment.left)) continue;
      const current: PromiseProvenance = {
        asyncFunctions,
        constructors,
        globalFetchAvailable,
        promiseFunctions,
        promiseModuleNamespaces,
        promiseValues,
        rejectFunctions,
      };
      if (isKnownPromiseExpression(assignment.right, current, assignment.getStart(sourceFile))) {
        changed =
          setProvenance(
            promiseValues,
            counts,
            assignment.left.text,
            assignment.getStart(sourceFile),
          ) || changed;
      }
    }
  }
  return {
    asyncFunctions,
    constructors,
    globalFetchAvailable,
    promiseFunctions,
    promiseModuleNamespaces,
    promiseValues,
    rejectFunctions,
  };
}

function promiseRejectCall(call: ts.CallExpression, provenance: PromiseProvenance): boolean {
  const callee = unwrappedExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const availableAt = provenance.rejectFunctions.get(callee.text);
    return availableAt !== undefined && availableAt <= call.getStart();
  }
  const parts = propertyAccessParts(callee);
  return (
    !!parts &&
    parts[1] === "reject" &&
    isGlobalPromiseExpression(parts[0], provenance.constructors, call.getStart())
  );
}

function isNullishCallback(expression: ts.Expression): boolean {
  const unwrapped = unwrappedExpression(expression);
  return (
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") ||
    (ts.isVoidExpression(unwrapped) && unwrapped.expression.kind === ts.SyntaxKind.NumericLiteral)
  );
}

function possibleThenRejectionArgument(call: ts.CallExpression): ts.Expression | undefined {
  let fixedArguments = 0;
  for (const argument of call.arguments) {
    if (ts.isSpreadElement(argument)) {
      if (fixedArguments <= 1) return argument;
      continue;
    }
    if (fixedArguments === 1 && !isNullishCallback(argument)) return argument;
    fixedArguments += 1;
  }
  return undefined;
}

function collectNamedCallbackBodies(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Node> {
  const bodies = new Map<string, ts.Node>();
  const duplicates = new Set<string>();
  const add = (name: string, body: ts.Node): void => {
    if (bodies.has(name)) {
      bodies.delete(name);
      duplicates.add(name);
      return;
    }
    if (!duplicates.has(name)) bodies.set(name, body);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      add(node.name.text, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      add(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bodies;
}

function rejectionCallbackOwner(
  callback: ts.Expression,
  namedCallbackBodies: ReadonlyMap<string, ts.Node>,
): ts.Node {
  const unwrapped = unwrappedExpression(callback);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return unwrapped.body;
  if (ts.isIdentifier(unwrapped)) return namedCallbackBodies.get(unwrapped.text) ?? callback;
  return callback;
}

function usedExecutorRejectCalls(
  node: ts.NewExpression,
  provenance: PromiseProvenance,
): ts.CallExpression[] {
  if (!isGlobalPromiseExpression(node.expression, provenance.constructors, node.getStart()))
    return [];
  const executor = node.arguments?.[0];
  if (!executor || (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor))) return [];
  const rejectParameter = executor.parameters[1]?.name;
  if (!rejectParameter || !ts.isIdentifier(rejectParameter)) return [];
  const aliases = new Set([rejectParameter.text]);
  let changed = true;
  while (changed) {
    changed = false;
    const collect = (child: ts.Node): void => {
      if (
        ts.isVariableDeclaration(child) &&
        ts.isIdentifier(child.name) &&
        child.initializer &&
        ts.isIdentifier(unwrappedExpression(child.initializer)) &&
        aliases.has(unwrappedExpression(child.initializer).getText()) &&
        !aliases.has(child.name.text)
      ) {
        aliases.add(child.name.text);
        changed = true;
      }
      ts.forEachChild(child, collect);
    };
    collect(executor.body);
  }
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(unwrappedExpression(child.expression)) &&
      aliases.has(unwrappedExpression(child.expression).getText())
    ) {
      calls.push(child);
    }
    ts.forEachChild(child, visit);
  };
  visit(executor.body);
  return calls;
}

function collectStreamControllers(sourceFile: ts.SourceFile): Set<string> {
  const controllers = new Set<string>();
  const addParameter = (parameter: ts.ParameterDeclaration | undefined): void => {
    if (parameter && ts.isIdentifier(parameter.name)) controllers.add(parameter.name.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && node.type && /Stream.*Controller/u.test(node.type.getText())) {
      addParameter(node);
    }
    if (
      ts.isNewExpression(node) &&
      /^(?:Readable|Transform)Stream$/u.test(node.expression.getText())
    ) {
      const source = node.arguments?.[0];
      if (source && (ts.isArrowFunction(source) || ts.isFunctionExpression(source))) {
        addParameter(source.parameters[0]);
      } else if (source && ts.isObjectLiteralExpression(source)) {
        for (const member of source.properties) {
          if (!ts.isMethodDeclaration(member)) continue;
          const name = member.name.getText().replaceAll(/["']/gu, "");
          if (name === "start" || name === "pull" || name === "flush") {
            addParameter(member.parameters[0]);
          } else if (name === "transform") {
            addParameter(member.parameters[1]);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return controllers;
}

function looksLikeErrorValue(expression: ts.Expression): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isNewExpression(unwrapped)) return true;
  return ts.isIdentifier(unwrapped) && /^(?:cause|e|err|error|reason)$/iu.test(unwrapped.text);
}

function isExplicitHostErrorSignal(
  call: ts.CallExpression,
  streamControllers: ReadonlySet<string>,
): boolean {
  const parts = propertyAccessParts(call.expression);
  if (!parts) return false;
  const [receiver, method] = parts;
  if (method === "emit") {
    const eventName = call.arguments[0];
    return !!eventName && ts.isStringLiteral(eventName) && eventName.text === "error";
  }
  if (method === "destroy") {
    const error = call.arguments[0];
    return !!error && !ts.isSpreadElement(error) && looksLikeErrorValue(error);
  }
  return method === "error" && ts.isIdentifier(receiver) && streamControllers.has(receiver.text);
}

const DIRECTION_KINDS = {
  "signal-host": [
    "promise-catch",
    "promise-reject",
    "rejection-callback",
    "stream-error-signal",
    "throw",
  ],
  "observe-panic": ["promise-catch", "rejection-callback", "throw"],
} as const satisfies Readonly<Record<ExceptionDirection, readonly ExceptionFlowKind[]>>;

function propertyStringName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

interface BetterResultProvenance {
  readonly captureFunctions: ReadonlyMap<string, number>;
  readonly moduleNamespaces: ReadonlyMap<string, number>;
  readonly resultNamespaces: ReadonlyMap<string, number>;
}

function mutationRootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrappedExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrappedExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function collectMutatedBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const mutated = new Set<string>();
  const aliases: [string, string][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const source = mutationRootIdentifier(node.initializer);
      if (source) aliases.push([node.name.text, source.text]);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const root =
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)
          ? undefined
          : mutationRootIdentifier(node.left);
      if (root) mutated.add(root.text);
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const root = mutationRootIdentifier(node.operand);
      if (root) mutated.add(root.text);
    } else if (ts.isCallExpression(node)) {
      const parts = propertyAccessParts(node.expression);
      const receiver = parts ? unwrappedExpression(parts[0]) : undefined;
      const indirectMutation =
        parts &&
        receiver !== undefined &&
        ts.isIdentifier(receiver) &&
        ((receiver.text === "Object" && (parts[1] === "assign" || parts[1] === "defineProperty")) ||
          (receiver.text === "Reflect" && (parts[1] === "set" || parts[1] === "defineProperty")));
      const target = indirectMutation && node.arguments[0];
      if (target && !ts.isSpreadElement(target)) {
        const root = mutationRootIdentifier(target);
        if (root) mutated.add(root.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [alias, source] of aliases) {
      if (mutated.has(alias) === mutated.has(source)) continue;
      mutated.add(alias);
      mutated.add(source);
      changed = true;
    }
  }
  return mutated;
}

function collectBetterResultProvenance(sourceFile: ts.SourceFile): BetterResultProvenance {
  const counts = collectBindingNameCounts(sourceFile);
  const captureFunctions = new Map<string, number>();
  const moduleNamespaces = new Map<string, number>();
  const resultNamespaces = new Map<string, number>();
  const declarations: ts.VariableDeclaration[] = [];
  const mutated = collectMutatedBindings(sourceFile);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "better-result" ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (!mutated.has(bindings.name.text)) {
        setProvenance(moduleNamespaces, counts, bindings.name.text, statement.getStart(sourceFile));
      }
      continue;
    }
    for (const specifier of bindings.elements) {
      if (
        !specifier.isTypeOnly &&
        (specifier.propertyName?.text ?? specifier.name.text) === "Result" &&
        !mutated.has(specifier.name.text)
      ) {
        setProvenance(
          resultNamespaces,
          counts,
          specifier.name.text,
          statement.getStart(sourceFile),
        );
      }
    }
  }

  const available = (values: ReadonlyMap<string, number>, name: string, at: number): boolean =>
    !mutated.has(name) && (values.get(name) ?? Number.POSITIVE_INFINITY) <= at;
  const isResultNamespace = (expression: ts.Expression, at: number): boolean => {
    const value = unwrappedExpression(expression);
    if (ts.isIdentifier(value)) return available(resultNamespaces, value.text, at);
    const parts = propertyAccessParts(value);
    if (!parts || parts[1] !== "Result") return false;
    const receiver = unwrappedExpression(parts[0]);
    return ts.isIdentifier(receiver) && available(moduleNamespaces, receiver.text, at);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        mutated.has(declaration.name.text)
      ) {
        continue;
      }
      const position = declaration.getStart(sourceFile);
      if (isResultNamespace(declaration.initializer, position)) {
        changed =
          setProvenance(resultNamespaces, counts, declaration.name.text, position) || changed;
      }
      const parts = propertyAccessParts(declaration.initializer);
      if (
        parts &&
        (parts[1] === "try" || parts[1] === "tryPromise") &&
        isResultNamespace(parts[0], position)
      ) {
        changed =
          setProvenance(captureFunctions, counts, declaration.name.text, position) || changed;
      }
    }
  }
  return { captureFunctions, moduleNamespaces, resultNamespaces };
}

function isBetterResultCaptureCall(
  call: ts.CallExpression,
  provenance: BetterResultProvenance,
): boolean {
  const callee = unwrappedExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return (
      (provenance.captureFunctions.get(callee.text) ?? Number.POSITIVE_INFINITY) <= call.getStart()
    );
  }
  const parts = propertyAccessParts(callee);
  if (!parts || (parts[1] !== "try" && parts[1] !== "tryPromise")) return false;
  const receiver = unwrappedExpression(parts[0]);
  if (ts.isIdentifier(receiver)) {
    return (
      (provenance.resultNamespaces.get(receiver.text) ?? Number.POSITIVE_INFINITY) <=
      call.getStart()
    );
  }
  const namespaceParts = propertyAccessParts(receiver);
  if (!namespaceParts || namespaceParts[1] !== "Result") return false;
  const namespace = unwrappedExpression(namespaceParts[0]);
  return (
    ts.isIdentifier(namespace) &&
    (provenance.moduleNamespaces.get(namespace.text) ?? Number.POSITIVE_INFINITY) <= call.getStart()
  );
}

function resultCaptureObjectForProperty(
  property: ts.ObjectLiteralElementLike,
  provenance: BetterResultProvenance,
): ts.CallExpression | undefined {
  if (!property.name || !ts.isObjectLiteralExpression(property.parent)) return undefined;
  const object = property.parent;
  let expression: ts.Expression = object;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const call = expression.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== expression) return undefined;
  return isBetterResultCaptureCall(call, provenance) ? call : undefined;
}

function throwIsCapturedByObjectResult(
  node: ts.ThrowStatement,
  provenance: BetterResultProvenance,
): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const property = current.parent;
    if (
      ts.isPropertyAssignment(property) &&
      propertyStringName(property.name) === "try" &&
      resultCaptureObjectForProperty(property, provenance)
    ) {
      return true;
    }
    break;
  }
  return false;
}

function normalizedAdapterModule(workspaceRoot: string, module: string): string {
  const normalizedRoot = normalizeFilePath(workspaceRoot).replace(/\/$/u, "");
  const normalizedModule = normalizeFilePath(module).replace(/^\.\//u, "");
  const relative = normalizedModule.startsWith(`${normalizedRoot}/`)
    ? normalizedModule.slice(normalizedRoot.length + 1)
    : normalizedModule;
  return relative.replace(/\.(?:[cm]?[jt]sx?)$/iu, "");
}

function adapterAllows(
  finding: SyntacticFinding<ExceptionFlowKind>,
  manifest: ArchitectureManifest,
): boolean {
  const workspace = manifest.workspaces.find((candidate) => candidate.root === finding.workspace);
  if (!workspace) return false;
  return workspace.exceptionAdapters.some(
    (adapter) =>
      normalizedAdapterModule(workspace.root, adapter.identity.module) === finding.module &&
      adapter.identity.exportName === finding.symbol &&
      DIRECTION_KINDS[adapter.direction].some((kind) => kind === finding.kind),
  );
}

export function findExceptionFlowViolations(
  sourceText: string,
  filePath = "apps/example/src/example.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<ExceptionFlowKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  return findExceptionFlowViolationsInSourceFile(
    parseProductionSyntaxSource(sourceText, filePath),
    filePath,
    manifest,
  );
}

export function findExceptionFlowViolationsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<ExceptionFlowKind>[] {
  const provenance = collectPromiseProvenance(sourceFile);
  const betterResultProvenance = collectBetterResultProvenance(sourceFile);
  const namedCallbackBodies = collectNamedCallbackBodies(sourceFile);
  const streamControllers = collectStreamControllers(sourceFile);
  const findings: SyntacticFinding<ExceptionFlowKind>[] = [];
  const add = (
    node: ts.Node,
    kind: ExceptionFlowKind,
    message: string,
    owner: ts.Node = node,
  ): void => {
    const finding = createFinding(sourceFile, filePath, node, kind, message, owner);
    if (!adapterAllows(finding, manifest)) findings.push(finding);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node)) {
      findings.push(
        createFinding(
          sourceFile,
          filePath,
          node,
          "try-statement",
          "Use object-form Result.try or Result.tryPromise; production try statements are forbidden",
          node,
        ),
      );
    } else if (ts.isThrowStatement(node)) {
      if (!throwIsCapturedByObjectResult(node, betterResultProvenance)) {
        add(
          node,
          "throw",
          "Return a typed Result error; throw only in an exactly registered adapter",
        );
      }
    } else if (ts.isNewExpression(node)) {
      for (const call of usedExecutorRejectCalls(node, provenance)) {
        add(
          call,
          "rejection-callback",
          "Return Promise<Result<T, E>> instead of invoking a Promise reject channel",
        );
      }
    } else if (ts.isCallExpression(node)) {
      if (promiseRejectCall(node, provenance)) {
        add(node, "promise-reject", "Return Result.err instead of Promise.reject");
      } else {
        const parts = propertyAccessParts(node.expression);
        if (parts && parts[1] === "catch") {
          const callback = node.arguments[0];
          add(
            node,
            "promise-catch",
            "Use Result.tryPromise for ordinary rejection capture; reserve .catch for an exact host signal contract",
            callback && !ts.isSpreadElement(callback)
              ? rejectionCallbackOwner(callback, namedCallbackBodies)
              : node,
          );
        } else if (parts && parts[1] === "then") {
          const rejection = possibleThenRejectionArgument(node);
          if (rejection) {
            add(
              rejection,
              "rejection-callback",
              "Capture rejection in a named Result-returning adapter before composition",
              rejectionCallbackOwner(rejection, namedCallbackBodies),
            );
          }
        } else if (isExplicitHostErrorSignal(node, streamControllers)) {
          add(
            node,
            "stream-error-signal",
            "Map the Result to the host error signal in an exactly registered framework adapter",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function declarationName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (
    (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return undefined;
}

function declarationFunctionLike(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node;
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertyAssignment(node)) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.initializer;
  }
  return undefined;
}

function returnedGuardExpression(node: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  const body = node.body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body;
  if (body.statements.length !== 1) return undefined;
  const statement = body.statements[0];
  return statement && ts.isReturnStatement(statement) ? statement.expression : undefined;
}

function flattenLogicalAnd(expression: ts.Expression): readonly ts.Expression[] {
  const unwrapped = unwrappedExpression(expression);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [...flattenLogicalAnd(unwrapped.left), ...flattenLogicalAnd(unwrapped.right)];
  }
  return [unwrapped];
}

function flattenLogicalOr(expression: ts.Expression): readonly ts.Expression[] {
  const unwrapped = unwrappedExpression(expression);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    return [...flattenLogicalOr(unwrapped.left), ...flattenLogicalOr(unwrapped.right)];
  }
  return [unwrapped];
}

function isParameterIdentifier(expression: ts.Expression, parameterName: string): boolean {
  const unwrapped = unwrappedExpression(expression);
  return ts.isIdentifier(unwrapped) && unwrapped.text === parameterName;
}

function isObjectTypeofCheck(expression: ts.Expression, parameterName: string): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (!ts.isBinaryExpression(unwrapped)) return false;
  if (
    unwrapped.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    unwrapped.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
  ) {
    return false;
  }
  const matches = (left: ts.Expression, right: ts.Expression): boolean => {
    const unwrappedLeft = unwrappedExpression(left);
    const unwrappedRight = unwrappedExpression(right);
    return (
      ts.isTypeOfExpression(unwrappedLeft) &&
      isParameterIdentifier(unwrappedLeft.expression, parameterName) &&
      ts.isStringLiteral(unwrappedRight) &&
      unwrappedRight.text === "object"
    );
  };
  return matches(unwrapped.left, unwrapped.right) || matches(unwrapped.right, unwrapped.left);
}

function isNonNullCheck(expression: ts.Expression, parameterName: string): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (!ts.isBinaryExpression(unwrapped)) return false;
  if (
    unwrapped.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    unwrapped.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return false;
  }
  return (
    (isParameterIdentifier(unwrapped.left, parameterName) &&
      unwrapped.right.kind === ts.SyntaxKind.NullKeyword) ||
    (isParameterIdentifier(unwrapped.right, parameterName) &&
      unwrapped.left.kind === ts.SyntaxKind.NullKeyword)
  );
}

function isNonArrayCheck(expression: ts.Expression, parameterName: string): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (
    !ts.isPrefixUnaryExpression(unwrapped) ||
    unwrapped.operator !== ts.SyntaxKind.ExclamationToken
  ) {
    return false;
  }
  const operand = unwrappedExpression(unwrapped.operand);
  if (!ts.isCallExpression(operand) || operand.arguments.length !== 1) return false;
  const parts = propertyAccessParts(operand.expression);
  const receiver = parts && unwrappedExpression(parts[0]);
  const argument = operand.arguments[0];
  return (
    !!parts &&
    !!receiver &&
    ts.isIdentifier(receiver) &&
    receiver.text === "Array" &&
    parts[1] === "isArray" &&
    !!argument &&
    !ts.isSpreadElement(argument) &&
    isParameterIdentifier(argument, parameterName)
  );
}

function isObjectTypeofRejectCheck(expression: ts.Expression, parameterName: string): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (!ts.isBinaryExpression(unwrapped)) return false;
  if (
    unwrapped.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    unwrapped.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return false;
  }
  const matches = (left: ts.Expression, right: ts.Expression): boolean => {
    const unwrappedLeft = unwrappedExpression(left);
    const unwrappedRight = unwrappedExpression(right);
    return (
      ts.isTypeOfExpression(unwrappedLeft) &&
      isParameterIdentifier(unwrappedLeft.expression, parameterName) &&
      ts.isStringLiteral(unwrappedRight) &&
      unwrappedRight.text === "object"
    );
  };
  return matches(unwrapped.left, unwrapped.right) || matches(unwrapped.right, unwrapped.left);
}

function isNullRejectCheck(expression: ts.Expression, parameterName: string): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (!ts.isBinaryExpression(unwrapped)) return false;
  if (
    unwrapped.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    unwrapped.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
  ) {
    return false;
  }
  return (
    (isParameterIdentifier(unwrapped.left, parameterName) &&
      unwrapped.right.kind === ts.SyntaxKind.NullKeyword) ||
    (isParameterIdentifier(unwrapped.right, parameterName) &&
      unwrapped.left.kind === ts.SyntaxKind.NullKeyword)
  );
}

function isArrayRejectCheck(expression: ts.Expression, parameterName: string): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (!ts.isCallExpression(unwrapped) || unwrapped.arguments.length !== 1) return false;
  const parts = propertyAccessParts(unwrapped.expression);
  const receiver = parts && unwrappedExpression(parts[0]);
  const argument = unwrapped.arguments[0];
  return (
    !!parts &&
    !!receiver &&
    ts.isIdentifier(receiver) &&
    receiver.text === "Array" &&
    parts[1] === "isArray" &&
    !!argument &&
    !ts.isSpreadElement(argument) &&
    isParameterIdentifier(argument, parameterName)
  );
}

function returnStatementFrom(node: ts.Statement): ts.ReturnStatement | undefined {
  if (ts.isReturnStatement(node)) return node;
  if (!ts.isBlock(node) || node.statements.length !== 1) return undefined;
  const statement = node.statements[0];
  return statement && ts.isReturnStatement(statement) ? statement : undefined;
}

function isRejectReturn(statement: ts.ReturnStatement): boolean {
  if (!statement.expression) return true;
  const expression = unwrappedExpression(statement.expression);
  return (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined") ||
    ts.isVoidExpression(expression)
  );
}

function hasCanonicalRecordGuardControlFlow(
  functionLike: ts.FunctionLikeDeclaration,
  parameterName: string,
): boolean {
  const body = functionLike.body;
  if (!body || !ts.isBlock(body) || body.statements.length < 2) return false;
  const success = body.statements.at(-1);
  if (!success || !ts.isReturnStatement(success) || !success.expression) return false;
  if (!isParameterIdentifier(success.expression, parameterName)) return false;
  const rejectChecks: ts.Expression[] = [];
  for (const statement of body.statements.slice(0, -1)) {
    if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
    const rejected = returnStatementFrom(statement.thenStatement);
    if (!rejected || !isRejectReturn(rejected)) return false;
    rejectChecks.push(...flattenLogicalOr(statement.expression));
  }
  if (rejectChecks.length !== 3) return false;
  return (
    rejectChecks.some((check) => isObjectTypeofRejectCheck(check, parameterName)) &&
    rejectChecks.some((check) => isNullRejectCheck(check, parameterName)) &&
    rejectChecks.some((check) => isArrayRejectCheck(check, parameterName))
  );
}

function hasCanonicalRecordGuardSemantics(node: ts.Node): boolean {
  const functionLike = declarationFunctionLike(node);
  const parameter = functionLike?.parameters[0];
  if (!functionLike || !parameter || !ts.isIdentifier(parameter.name)) return false;
  const parameterName = parameter.name.text;
  const returned = returnedGuardExpression(functionLike);
  if (returned) {
    const checks = flattenLogicalAnd(returned);
    if (
      checks.length === 3 &&
      checks.some((check) => isObjectTypeofCheck(check, parameterName)) &&
      checks.some((check) => isNonNullCheck(check, parameterName)) &&
      checks.some((check) => isNonArrayCheck(check, parameterName))
    ) {
      return true;
    }
  }
  return hasCanonicalRecordGuardControlFlow(functionLike, parameterName);
}

export function findLocalRecordGuardViolations(
  sourceText: string,
  filePath = "apps/example/src/example.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
): SyntacticFinding<LocalRecordGuardKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  const sourceFile = parseProductionSyntaxSource(sourceText, filePath);
  const identity = sourceIdentity(filePath);
  const findings: SyntacticFinding<LocalRecordGuardKind>[] = [];
  const visit = (node: ts.Node): void => {
    const name = declarationName(node);
    if (name && hasCanonicalRecordGuardSemantics(node)) {
      const canonical = policy.canonicalRecordGuards.some(
        (guard) =>
          guard.workspace === identity.workspace &&
          guard.module === identity.module &&
          guard.symbol === name,
      );
      if (!canonical) {
        findings.push(
          createFinding(
            sourceFile,
            filePath,
            node,
            "local-record-guard",
            "Import the canonical isRecord utility instead of declaring a local duplicate",
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function hasRuntimeImport(importDeclaration: ts.ImportDeclaration): boolean {
  const clause = importDeclaration.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((specifier) => !specifier.isTypeOnly);
}

function moduleWithoutExtension(module: string): string {
  return module.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
}

function importedWorkspaceModule(
  sourceModule: string,
  sourceWorkspace: string,
  specifier: string,
  manifest: ArchitectureManifest,
):
  | { readonly module?: string; readonly workspace: ArchitectureManifest["workspaces"][number] }
  | undefined {
  if (specifier.startsWith(".")) {
    const module = path.posix.normalize(
      path.posix.join(path.posix.dirname(sourceModule), specifier),
    );
    const workspace = manifest.workspaces.find((candidate) => candidate.name === sourceWorkspace);
    if (!workspace) return undefined;
    return {
      module: moduleWithoutExtension(module),
      workspace,
    };
  }
  const workspace = manifest.workspaces.find(
    (candidate) =>
      specifier === candidate.packageName || specifier.startsWith(`${candidate.packageName}/`),
  );
  if (!workspace) return undefined;
  const suffix = specifier.slice(workspace.packageName.length).replace(/^\//u, "");
  return { ...(suffix ? { module: moduleWithoutExtension(suffix) } : {}), workspace };
}

function staticPropertyName(name: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function registeredPackageModule(
  workspace: string,
  module: string,
  registrations: readonly { readonly workspace: string; readonly module: string }[],
): boolean {
  return registrations.some(
    (registration) =>
      registration.workspace === workspace &&
      moduleWithoutExtension(registration.module) === moduleWithoutExtension(module),
  );
}

function importedNames(statement: ts.ImportDeclaration): readonly string[] {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) return [];
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return [];
  return bindings.elements
    .filter((specifier) => !specifier.isTypeOnly)
    .map((specifier) => (specifier.propertyName ?? specifier.name).text);
}

function localImportedName(
  statement: ts.ImportDeclaration,
  importedName: string,
): string | undefined {
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return undefined;
  const specifier = bindings.elements.find(
    (candidate) => (candidate.propertyName ?? candidate.name).text === importedName,
  );
  return specifier?.name.text;
}

function bindingNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function expressionContainsOwnedName(
  expression: ts.Expression,
  ownedNames: ReadonlySet<string>,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && ownedNames.has(node.text)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

export function findBlobStorageSeamViolations(
  sourceText: string,
  filePath = "apps/example/src/blob-consumer.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
  manifest: ArchitectureManifest = architectureManifest,
  blobPolicy: BlobStorageArchitecturePolicy = BLOB_STORAGE_ARCHITECTURE_POLICY,
): SyntacticFinding<BlobStorageSeamKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  return findBlobStorageSeamViolationsInSourceFile(
    parseProductionSyntaxSource(sourceText, filePath),
    filePath,
    manifest,
    blobPolicy,
  );
}

export function findBlobStorageSeamViolationsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  manifest: ArchitectureManifest = architectureManifest,
  blobPolicy: BlobStorageArchitecturePolicy = BLOB_STORAGE_ARCHITECTURE_POLICY,
): SyntacticFinding<BlobStorageSeamKind>[] {
  if (!manifest.workspaces.some(({ name }) => name === blobPolicy.storageWorkspace)) return [];
  const identity = sourceIdentity(filePath);
  const findings: SyntacticFinding<BlobStorageSeamKind>[] = [];
  const add = (node: ts.Node, kind: BlobStorageSeamKind, message: string): void => {
    findings.push(createFinding(sourceFile, filePath, node, kind, message));
  };

  const blobStoreTypeNames = new Set<string>();
  const blobStoreValueNames = new Set<string>();
  const s3ValueNames = new Set<string>();
  const blobPackageNamespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const names = importedNames(statement);
    if (specifier === "bun") {
      const s3Imports = names.filter((name) => name === "S3Client" || name === "S3File");
      if (s3Imports.length > 0 && identity.workspace !== blobPolicy.storageWorkspace) {
        add(
          statement,
          "s3-storage-import",
          "Only the blob-storage package may import Bun S3 storage operations",
        );
      }
      for (const name of s3Imports) {
        s3ValueNames.add(localImportedName(statement, name) ?? name);
      }
    }

    const target = importedWorkspaceModule(
      `${identity.module}.ts`,
      identity.workspace,
      specifier,
      manifest,
    );
    const relativeImportEscapesStorage =
      identity.workspace === blobPolicy.storageWorkspace &&
      specifier.startsWith(".") &&
      path.posix
        .normalize(path.posix.join(path.posix.dirname(identity.module), specifier))
        .startsWith("../");
    if (
      identity.workspace === blobPolicy.storageWorkspace &&
      ((target && target.workspace.name !== blobPolicy.storageWorkspace) ||
        relativeImportEscapesStorage)
    ) {
      add(
        statement,
        "blob-domain-import",
        "The blob-storage package cannot import another Lilac workspace domain",
      );
    }

    if (specifier === blobPolicy.storagePackage) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && !statement.importClause?.isTypeOnly) {
        blobPackageNamespaces.add(bindings.name.text);
      }
      const typeBindings = statement.importClause?.namedBindings;
      if (typeBindings && ts.isNamedImports(typeBindings)) {
        for (const binding of typeBindings.elements) {
          const imported = (binding.propertyName ?? binding.name).text;
          if (imported === "BlobStore") blobStoreTypeNames.add(binding.name.text);
        }
      }
      const importedFactories = names.filter((name) =>
        blobPolicy.adapterFactoryExports.includes(name),
      );
      if (
        importedFactories.length > 0 &&
        !registeredPackageModule(
          identity.workspace,
          identity.module,
          blobPolicy.adapterFactoryOwners,
        )
      ) {
        add(
          statement,
          "adapter-construction-import",
          "Construct blob adapters only in registered composition or benchmark modules",
        );
      }
    }

    const legacyNames = names.filter((name) => name.startsWith("decodeLegacy"));
    const legacyModule =
      /legacy/iu.test(specifier) && /blob|attachment|artifact|binary|media/iu.test(specifier);
    if (legacyNames.length > 0 || legacyModule) {
      add(statement, "legacy-blob-decoder-import", "Legacy blob decoders are no longer supported");
    }
  }

  const typeMentionsBlobStore = (type: ts.TypeNode | undefined): boolean =>
    !!type &&
    [...blobStoreTypeNames].some((name) => new RegExp(`\\b${name}\\b`, "u").test(type.getText()));
  const collectBlobStoreBindings = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      typeMentionsBlobStore(node.type)
    ) {
      for (const name of bindingNames(node.name)) blobStoreValueNames.add(name);
    } else if (ts.isPropertyDeclaration(node) && typeMentionsBlobStore(node.type)) {
      const name = staticPropertyName(node.name);
      if (name) blobStoreValueNames.add(name);
    } else if (ts.isPropertySignature(node) && typeMentionsBlobStore(node.type)) {
      const name = staticPropertyName(node.name);
      if (name) blobStoreValueNames.add(name);
    }
    ts.forEachChild(node, collectBlobStoreBindings);
  };
  collectBlobStoreBindings(sourceFile);

  const eventSchemaModule = registeredPackageModule(
    identity.workspace,
    identity.module,
    blobPolicy.eventSchemaModules,
  );
  const allowedBlobColumns = new Set(blobPolicy.allowedCoreBlobColumns);
  const managedFieldNames = new Set(["bytes", "content", "data", "payload"]);
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const constructed = unwrappedExpression(node.expression);
      const directS3 = ts.isIdentifier(constructed) && s3ValueNames.has(constructed.text);
      const bunS3 =
        ts.isPropertyAccessExpression(constructed) &&
        ts.isIdentifier(constructed.expression) &&
        constructed.expression.text === "Bun" &&
        (constructed.name.text === "S3Client" || constructed.name.text === "S3File");
      if ((directS3 || bunS3) && identity.workspace !== blobPolicy.storageWorkspace) {
        add(
          node,
          "s3-storage-import",
          "Only the blob-storage package may construct Bun S3 clients",
        );
      }
    }

    if (eventSchemaModule && ts.isPropertyAssignment(node)) {
      const name = staticPropertyName(node.name);
      const text = node.initializer.getText();
      if (
        name === "dataBase64" ||
        (name && managedFieldNames.has(name) && /\b(?:ArrayBuffer|Buffer|Uint8Array)\b/u.test(text))
      ) {
        add(
          node,
          "current-inline-blob-value",
          "Current event schemas must carry BlobHandleV1 or BlobRefV1 instead of managed inline bytes",
        );
      }
    }
    if (
      eventSchemaModule &&
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^data:[^,]*,/iu.test(node.text)
    ) {
      add(
        node,
        "current-inline-blob-value",
        "Current event schemas cannot persist managed data URLs",
      );
    }

    if (
      identity.workspace === blobPolicy.coreWorkspace &&
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /\b(?:ADD\s+COLUMN|ALTER\s+TABLE|CREATE\s+TABLE)\b/iu.test(node.text)
    ) {
      const columnPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s+BLOB\b/giu;
      for (const match of node.text.matchAll(columnPattern)) {
        const column = match[1];
        if (column && !allowedBlobColumns.has(column)) {
          add(
            node,
            "core-inline-blob-column",
            `Core SQLite column '${column}' cannot store managed opaque bytes; persist a BlobRefV1 instead`,
          );
        }
      }
    }

    if (
      identity.workspace === blobPolicy.coreWorkspace &&
      /(?:^|\/)(?:[^/]*persistence-codec|[^/]*store|migrations?)(?:$|\/)/u.test(identity.module) &&
      ts.isPropertyAssignment(node)
    ) {
      const name = staticPropertyName(node.name);
      const text = node.initializer.getText();
      if (
        name === "dataBase64" ||
        (name &&
          managedFieldNames.has(name) &&
          /\b(?:ArrayBuffer|Buffer|Uint8Array)\b/u.test(text)) ||
        /^data:[^,]*,/iu.test(text.replaceAll(/["'`]/gu, ""))
      ) {
        add(
          node,
          "current-inline-blob-value",
          "Current Core persistence must store BlobRefV1 metadata instead of managed inline bytes",
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const called = propertyAccessParts(node.expression);
      if (
        called &&
        ts.isIdentifier(called[0]) &&
        blobPackageNamespaces.has(called[0].text) &&
        blobPolicy.adapterFactoryExports.includes(called[1]) &&
        !registeredPackageModule(
          identity.workspace,
          identity.module,
          blobPolicy.adapterFactoryOwners,
        )
      ) {
        add(
          node,
          "adapter-construction-import",
          "Construct blob adapters only in registered composition or benchmark modules",
        );
      }
      if (called && (called[1] === "close" || called[1] === "open")) {
        const receiver = called[0];
        if (expressionContainsOwnedName(receiver, blobStoreValueNames)) {
          if (
            called[1] === "close" &&
            !registeredPackageModule(
              identity.workspace,
              identity.module,
              blobPolicy.closeOwnerModules,
            )
          ) {
            add(
              node,
              "blob-store-close-ownership",
              "Only the registered Core runtime owner may close the composed BlobStore",
            );
          }
          if (
            called[1] === "open" &&
            !registeredPackageModule(
              identity.workspace,
              identity.module,
              blobPolicy.materializationModules,
            )
          ) {
            add(
              node,
              "blob-materialization-locality",
              "Open BlobRefV1 content only in a registered hydration or materialization module",
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export function findPresentationDecoderImportViolations(
  sourceText: string,
  filePath = "apps/example/src/render.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<PresentationDecoderImportKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  return findPresentationDecoderImportViolationsInSourceFile(
    parseProductionSyntaxSource(sourceText, filePath),
    filePath,
    manifest,
  );
}

export function findPresentationDecoderImportViolationsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<PresentationDecoderImportKind>[] {
  const identity = sourceIdentity(filePath);
  const sourceModule = `${identity.module}.ts`;
  const enforced = manifest.workspaces
    .find((workspace) => workspace.name === identity.workspace)
    ?.unknownFreeModules.some(
      (registration) => registration.module.replace(/\.(?:[cm]?[jt]sx?)$/u, ".ts") === sourceModule,
    );
  if (!enforced) return [];

  const findings: SyntacticFinding<PresentationDecoderImportKind>[] = [];
  const forbiddenValues = new Set<string>();
  const forbiddenNamespaces = new Map<string, ReadonlySet<string>>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.moduleSpecifier.text === "zod" && hasRuntimeImport(statement)) {
      findings.push(
        createFinding(
          sourceFile,
          filePath,
          statement,
          "presentation-decoder-import",
          "Unknown-free presentation modules cannot import Zod parsers; decode in the registered projection boundary",
        ),
      );
    }

    const target = importedWorkspaceModule(
      sourceModule,
      identity.workspace,
      statement.moduleSpecifier.text,
      manifest,
    );
    const clause = statement.importClause;
    if (!target || !clause || clause.isTypeOnly) continue;
    const registered = [
      ...target.workspace.boundaryDecoders.map(({ identity: decoder }) => decoder),
      ...target.workspace.resultDecoders.map(({ identity: decoder }) => decoder),
      ...target.workspace.openProtocolAdapters.map(({ identity: adapter }) => adapter),
      ...target.workspace.toolCodecRegistries.flatMap((registry) => [
        registry.identity,
        ...registry.aliases,
      ]),
    ].filter(
      (decoder) =>
        target.module === undefined || moduleWithoutExtension(decoder.module) === target.module,
    );
    if (registered.length === 0) continue;
    const registeredNames = new Set(registered.map(({ exportName }) => exportName.split(".")[0]!));
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      findings.push(
        createFinding(
          sourceFile,
          filePath,
          statement,
          "presentation-decoder-import",
          "Unknown-free presentation modules cannot value-import a registered projection or decoder boundary",
        ),
      );
      forbiddenNamespaces.set(bindings.name.text, registeredNames);
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      if (specifier.isTypeOnly) continue;
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (!registeredNames.has(importedName)) continue;
      findings.push(
        createFinding(
          sourceFile,
          filePath,
          specifier,
          "presentation-decoder-import",
          `Unknown-free presentation modules cannot value-import registered boundary ${importedName}`,
        ),
      );
      forbiddenValues.add(specifier.name.text);
    }
  }
  if (forbiddenValues.size === 0 && forbiddenNamespaces.size === 0) return findings;

  const isForbiddenValue = (expression: ts.Expression): boolean => {
    const unwrapped = unwrappedExpression(expression);
    if (ts.isIdentifier(unwrapped)) return forbiddenValues.has(unwrapped.text);
    const parts = propertyAccessParts(unwrapped);
    if (parts) {
      const base = unwrappedExpression(parts[0]);
      if (ts.isIdentifier(base) && forbiddenNamespaces.get(base.text)?.has(parts[1]) === true) {
        return true;
      }
      return isForbiddenValue(parts[0]);
    }
    if (ts.isElementAccessExpression(unwrapped)) return isForbiddenValue(unwrapped.expression);
    return false;
  };

  const bindingCounts = collectBindingNameCounts(sourceFile);
  const aliases: { readonly name: string; readonly value: ts.Expression }[] = [];
  const collectAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      bindingCounts.get(node.name.text) === 1
    ) {
      aliases.push({ name: node.name.text, value: node.initializer });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      bindingCounts.get(node.left.text) === 1
    ) {
      aliases.push({ name: node.left.text, value: node.right });
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      if (!forbiddenValues.has(alias.name) && isForbiddenValue(alias.value)) {
        forbiddenValues.add(alias.name);
        changed = true;
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isForbiddenValue(node.expression)) {
      findings.push(
        createFinding(
          sourceFile,
          filePath,
          node,
          "presentation-decoder-import",
          "Unknown-free presentation modules cannot invoke a registered projection, decoder, or tool codec registry value",
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

const RESULT_COMBINATORS = new Set([
  "andThen",
  "andThenAsync",
  "map",
  "mapError",
  "match",
  "tap",
  "tapAsync",
  "tapBoth",
  "tapBothAsync",
  "tapError",
  "tapErrorAsync",
  "tryRecover",
  "tryRecoverAsync",
]);
const RESULT_PRODUCERS = new Set(["err", "ok", "try"]);

interface ResultProvenance {
  readonly moduleNamespaces: ReadonlySet<string>;
  readonly resultFactories: ReadonlyMap<string, number>;
  readonly resultNamespaces: ReadonlyMap<string, number>;
  readonly resultValues: ReadonlyMap<string, number>;
}

function isResultNamespaceExpression(
  expression: ts.Expression,
  provenance: ResultProvenance,
  at: number,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const availableAt = provenance.resultNamespaces.get(unwrapped.text);
    return availableAt !== undefined && availableAt <= at;
  }
  const parts = propertyAccessParts(unwrapped);
  return (
    !!parts &&
    parts[1] === "Result" &&
    ts.isIdentifier(parts[0]) &&
    provenance.moduleNamespaces.has(parts[0].text)
  );
}

function isKnownResultExpression(
  expression: ts.Expression,
  provenance: ResultProvenance,
  at: number,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const availableAt = provenance.resultValues.get(unwrapped.text);
    return availableAt !== undefined && availableAt <= at;
  }
  if (!ts.isCallExpression(unwrapped)) return false;
  if (ts.isIdentifier(unwrapped.expression)) {
    const availableAt = provenance.resultFactories.get(unwrapped.expression.text);
    return availableAt !== undefined && availableAt <= at;
  }
  const parts = propertyAccessParts(unwrapped.expression);
  if (!parts) return false;
  if (
    RESULT_PRODUCERS.has(parts[1]) &&
    isResultNamespaceExpression(parts[0], provenance, unwrapped.getStart())
  ) {
    return true;
  }
  return (
    RESULT_COMBINATORS.has(parts[1]) &&
    isKnownResultExpression(parts[0], provenance, unwrapped.getStart()) &&
    !parts[1].endsWith("Async") &&
    parts[1] !== "match"
  );
}

function typeIsImportedResult(
  type: ts.TypeNode | undefined,
  resultNames: ReadonlySet<string>,
): boolean {
  if (!type) return false;
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName;
    return ts.isIdentifier(name) && resultNames.has(name.text);
  }
  return false;
}

function collectResultProvenance(sourceFile: ts.SourceFile): ResultProvenance {
  const counts = collectBindingNameCounts(sourceFile);
  const mutated = collectMutatedBindings(sourceFile);
  const moduleNamespaces = new Set<string>();
  const importedResultTypeNames = new Set<string>();
  const resultFactories = new Map<string, number>();
  const resultNamespaces = new Map<string, number>();
  const resultValues = new Map<string, number>();
  const declarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "better-result"
    ) {
      continue;
    }
    for (const specifier of statement.importClause?.namedBindings
      ? ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements
        : [statement.importClause.namedBindings]
      : []) {
      if (ts.isNamespaceImport(specifier)) {
        if (!mutated.has(specifier.name.text)) moduleNamespaces.add(specifier.name.text);
        continue;
      }
      const importedName = (specifier.propertyName ?? specifier.name).text;
      if (importedName === "Result") {
        if (!mutated.has(specifier.name.text)) {
          setProvenance(
            resultNamespaces,
            counts,
            specifier.name.text,
            statement.getStart(sourceFile),
          );
          importedResultTypeNames.add(specifier.name.text);
        }
      } else if (importedName === "ok" || importedName === "err") {
        if (!mutated.has(specifier.name.text)) {
          setProvenance(
            resultFactories,
            counts,
            specifier.name.text,
            statement.getStart(sourceFile),
          );
        }
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      !mutated.has(node.name.text) &&
      typeIsImportedResult(node.type, importedResultTypeNames)
    ) {
      setProvenance(resultValues, counts, node.name.text, node.getStart(sourceFile));
    }
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      !mutated.has(node.name.text) &&
      typeIsImportedResult(node.type, importedResultTypeNames)
    ) {
      setProvenance(resultValues, counts, node.name.text, node.getStart(sourceFile));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    const current: ResultProvenance = {
      moduleNamespaces,
      resultFactories,
      resultNamespaces,
      resultValues,
    };
    for (const declaration of declarations) {
      if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (mutated.has(name)) continue;
      const position = declaration.getStart(sourceFile);
      if (isResultNamespaceExpression(declaration.initializer, current, position)) {
        changed = setProvenance(resultNamespaces, counts, name, position) || changed;
      }
      if (isKnownResultExpression(declaration.initializer, current, position)) {
        changed = setProvenance(resultValues, counts, name, position) || changed;
      }
    }
    for (const assignment of assignments) {
      if (!ts.isIdentifier(assignment.left)) continue;
      if (mutated.has(assignment.left.text)) continue;
      if (isKnownResultExpression(assignment.right, current, assignment.getStart(sourceFile))) {
        changed =
          setProvenance(
            resultValues,
            counts,
            assignment.left.text,
            assignment.getStart(sourceFile),
          ) || changed;
      }
    }
  }
  return { moduleNamespaces, resultFactories, resultNamespaces, resultValues };
}

function inlineAsyncCallbacks(node: ts.Node): ts.FunctionLikeDeclaration[] {
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return [node];
  }
  if (!ts.isObjectLiteralExpression(node)) return [];
  const callbacks: ts.FunctionLikeDeclaration[] = [];
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      callbacks.push(...inlineAsyncCallbacks(property.initializer));
    } else if (
      ts.isMethodDeclaration(property) &&
      property.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      callbacks.push(property);
    }
  }
  return callbacks;
}

export function findInlineAsyncResultCallbackViolations(
  sourceText: string,
  filePath = "apps/example/src/example.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
): SyntacticFinding<ResultCallbackKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  return findInlineAsyncResultCallbackViolationsInSourceFile(
    parseProductionSyntaxSource(sourceText, filePath),
    filePath,
  );
}

export function findInlineAsyncResultCallbackViolationsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
): SyntacticFinding<ResultCallbackKind>[] {
  const provenance = collectResultProvenance(sourceFile);
  const findings: SyntacticFinding<ResultCallbackKind>[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const parts = propertyAccessParts(node.expression);
      if (parts && RESULT_COMBINATORS.has(parts[1])) {
        const isStatic = isResultNamespaceExpression(
          parts[0],
          provenance,
          node.getStart(sourceFile),
        );
        const isInstance = isKnownResultExpression(parts[0], provenance, node.getStart(sourceFile));
        if (isStatic || isInstance) {
          for (const argument of node.arguments) {
            for (const callback of inlineAsyncCallbacks(argument)) {
              findings.push(
                createFinding(
                  sourceFile,
                  filePath,
                  callback,
                  "inline-async-result-callback",
                  "Use a named Result-returning adapter or declarative Result.gen workflow",
                ),
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

const STORE_SCHEMA_DECODER_MEMBERS = new Set([
  "parse",
  "parseAsync",
  "safeParse",
  "safeParseAsync",
]);

function collectMemberFunctionAliases(
  sourceFile: ts.SourceFile,
  members: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const counts = collectBindingNameCounts(sourceFile);
  const aliases = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      counts.get(node.name.text) === 1
    ) {
      const parts = propertyAccessParts(node.initializer);
      if (parts && members.has(parts[1])) {
        const receiver = unwrappedExpression(parts[0]);
        const member =
          parts[1] === "parse" && ts.isIdentifier(receiver) && receiver.text === "JSON"
            ? "JSON.parse"
            : parts[1];
        aliases.set(node.name.text, member);
      }
      const source = unwrappedExpression(node.initializer);
      if (ts.isIdentifier(source)) {
        const member = aliases.get(source.text);
        if (member) aliases.set(node.name.text, member);
      }
    }
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      counts.get(node.name.text) === 1
    ) {
      const property = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) &&
        members.has(property.text)
      ) {
        const pattern = node.parent;
        const declaration = ts.isObjectBindingPattern(pattern) ? pattern.parent : undefined;
        const initializer =
          declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
            ? unwrappedExpression(declaration.initializer)
            : undefined;
        const member =
          property.text === "parse" &&
          initializer &&
          ts.isIdentifier(initializer) &&
          initializer.text === "JSON"
            ? "JSON.parse"
            : property.text;
        aliases.set(node.name.text, member);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

export function findStoreInlineDecodingViolations(
  sourceText: string,
  filePath = "apps/example/src/store.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<StoreInlineDecodingKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  return findStoreInlineDecodingViolationsInSourceFile(
    parseProductionSyntaxSource(sourceText, filePath),
    filePath,
    manifest,
  );
}

export function findStoreInlineDecodingViolationsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<StoreInlineDecodingKind>[] {
  const identity = sourceIdentity(filePath);
  const registrations =
    manifest.workspaces.find((workspace) => workspace.name === identity.workspace)
      ?.persistedStoreConsumers ?? [];
  if (registrations.length === 0) return [];
  const decoderAliases = collectMemberFunctionAliases(
    sourceFile,
    new Set(["parse", ...STORE_SCHEMA_DECODER_MEMBERS]),
  );
  const findings: SyntacticFinding<StoreInlineDecodingKind>[] = [];
  const add = (node: ts.Node, kind: StoreInlineDecodingKind, message: string): void => {
    const finding = createFinding(sourceFile, filePath, node, kind, message);
    if (findingOwnedByRegistration(finding, registrations)) findings.push(finding);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrappedExpression(node.expression);
      if (ts.isIdentifier(callee)) {
        const aliasedMember = decoderAliases.get(callee.text);
        if (aliasedMember === "JSON.parse") {
          add(
            node,
            "store-inline-json-decoding",
            "Call the registered persisted codec instead of an aliased JSON parser inside this registered store scope",
          );
        } else if (aliasedMember && STORE_SCHEMA_DECODER_MEMBERS.has(aliasedMember)) {
          add(
            node,
            "store-inline-schema-decoding",
            "Call the registered persisted codec instead of an aliased schema decoder inside this registered store scope",
          );
        }
      }
      const parts = propertyAccessParts(node.expression);
      if (parts) {
        const receiver = unwrappedExpression(parts[0]);
        if (parts[1] === "parse" && ts.isIdentifier(receiver) && receiver.text === "JSON") {
          add(
            node,
            "store-inline-json-decoding",
            "Call the registered persisted codec instead of JSON.parse inside this registered store scope",
          );
        } else if (STORE_SCHEMA_DECODER_MEMBERS.has(parts[1])) {
          add(
            node,
            "store-inline-schema-decoding",
            "Call the registered persisted codec instead of invoking a schema decoder inside this registered store scope",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function collectStaticStrings(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const counts = collectBindingNameCounts(sourceFile);
  const values = new Map<string, string>();
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (counts.get(declaration.name.getText(sourceFile)) !== 1) continue;
      const name = declaration.name.getText(sourceFile);
      if (values.has(name)) continue;
      const initializer = declaration.initializer && unwrappedExpression(declaration.initializer);
      let value: string | undefined;
      if (initializer && ts.isStringLiteralLike(initializer)) {
        value = initializer.text;
      } else if (initializer && ts.isIdentifier(initializer)) {
        value = values.get(initializer.text);
      }
      if (value !== undefined) {
        values.set(name, value);
        changed = true;
      }
    }
  }
  return values;
}

function staticSqlText(
  expression: ts.Expression,
  staticStrings: ReadonlyMap<string, string>,
): string | undefined {
  const unwrapped = unwrappedExpression(expression);
  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
  if (ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text;
  if (ts.isIdentifier(unwrapped)) return staticStrings.get(unwrapped.text);
  return undefined;
}

export function findDirectSqliteTransactionViolations(
  sourceText: string,
  filePath = "apps/example/src/store.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<DirectSqliteTransactionKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  return findDirectSqliteTransactionViolationsInSourceFile(
    parseProductionSyntaxSource(sourceText, filePath),
    filePath,
    manifest,
  );
}

export function findDirectSqliteTransactionViolationsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  manifest: ArchitectureManifest = architectureManifest,
): SyntacticFinding<DirectSqliteTransactionKind>[] {
  const identity = sourceIdentity(filePath);
  const registrations =
    manifest.workspaces.find((workspace) => workspace.name === identity.workspace)
      ?.sqliteTransactionConsumers ?? [];
  if (registrations.length === 0) return [];
  const transactionAliases = collectMemberFunctionAliases(sourceFile, new Set(["transaction"]));
  const staticStrings = collectStaticStrings(sourceFile);
  const findings: SyntacticFinding<DirectSqliteTransactionKind>[] = [];
  const add = (node: ts.Node, kind: DirectSqliteTransactionKind, message: string): void => {
    const finding = createFinding(sourceFile, filePath, node, kind, message);
    if (findingOwnedByRegistration(finding, registrations)) findings.push(finding);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrappedExpression(node.expression);
      if (ts.isIdentifier(callee) && transactionAliases.get(callee.text) === "transaction") {
        add(
          node,
          "direct-sqlite-transaction",
          "Call the registered SQLite Result adapter instead of an aliased Database.transaction",
        );
      }
      const parts = propertyAccessParts(node.expression);
      if (parts?.[1] === "transaction") {
        add(
          node,
          "direct-sqlite-transaction",
          "Call the registered SQLite Result adapter instead of Database.transaction in this registered consumer",
        );
      }
      for (const argument of node.arguments) {
        if (ts.isSpreadElement(argument)) continue;
        const sql = staticSqlText(argument, staticStrings);
        if (sql && /(?:^\s*|[;\n]\s*)(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql)) {
          add(
            argument,
            "manual-sqlite-transaction-control",
            "Use the registered SQLite Result adapter instead of manual BEGIN, COMMIT, or ROLLBACK",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function isConditionalChainRoot(node: ts.IfStatement): boolean {
  return !(ts.isIfStatement(node.parent) && node.parent.elseStatement === node);
}

function topLevelOrTermCount(expression: ts.Expression): number {
  const unwrapped = unwrappedExpression(expression);
  if (
    !ts.isBinaryExpression(unwrapped) ||
    unwrapped.operatorToken.kind !== ts.SyntaxKind.BarBarToken
  ) {
    return 1;
  }
  return topLevelOrTermCount(unwrapped.left) + topLevelOrTermCount(unwrapped.right);
}

function conditionalChainExpressions(root: ts.IfStatement): readonly ts.Expression[] {
  const expressions: ts.Expression[] = [];
  let current: ts.IfStatement | undefined = root;
  while (current) {
    expressions.push(current.expression);
    current =
      current.elseStatement && ts.isIfStatement(current.elseStatement)
        ? current.elseStatement
        : undefined;
  }
  return expressions;
}

export function findPreferSwitchTrueChainViolations(
  sourceText: string,
  filePath = "apps/example/src/service.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
): SyntacticFinding<PreferSwitchTrueChainKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  return findPreferSwitchTrueChainViolationsInSourceFile(
    parseProductionSyntaxSource(sourceText, filePath),
    filePath,
  );
}

export function findPreferSwitchTrueChainViolationsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
): SyntacticFinding<PreferSwitchTrueChainKind>[] {
  const findings: SyntacticFinding<PreferSwitchTrueChainKind>[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && isConditionalChainRoot(node)) {
      const expressions = conditionalChainExpressions(node);
      const disjunctiveArms = expressions.filter(
        (expression) => topLevelOrTermCount(expression) > 1,
      ).length;
      if (expressions.length >= 3 && disjunctiveArms >= 2) {
        findings.push(
          createFinding(
            sourceFile,
            filePath,
            node,
            "prefer-switch-true-chain",
            "Use switch (true) with one ordered predicate group per case instead of this disjunctive if/else-if chain",
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function terminalBranchStatement(statement: ts.Statement): ts.Statement | undefined {
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isContinueStatement(statement) ||
    ts.isBreakStatement(statement)
  ) {
    return statement;
  }
  if (!ts.isBlock(statement)) return undefined;
  const last = statement.statements.at(-1);
  return last ? terminalBranchStatement(last) : undefined;
}

function terminalBranchKeyword(statement: ts.Statement): string {
  if (ts.isReturnStatement(statement)) return "return";
  if (ts.isThrowStatement(statement)) return "throw";
  if (ts.isContinueStatement(statement)) return "continue";
  return "break";
}

export function findElseAfterTerminalViolations(
  sourceText: string,
  filePath = "apps/example/src/service.ts",
  policy: SyntacticPolicy = SYNTACTIC_POLICY,
): SyntacticFinding<ElseAfterTerminalKind>[] {
  if (isExcludedProductionFile(filePath, policy.productionExclusions)) return [];
  return findElseAfterTerminalViolationsInSourceFile(
    parseProductionSyntaxSource(sourceText, filePath),
    filePath,
  );
}

export function findElseAfterTerminalViolationsInSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
): SyntacticFinding<ElseAfterTerminalKind>[] {
  const findings: SyntacticFinding<ElseAfterTerminalKind>[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.elseStatement) {
      const terminal = terminalBranchStatement(node.thenStatement);
      if (terminal) {
        findings.push(
          createFinding(
            sourceFile,
            filePath,
            node.elseStatement,
            "else-after-terminal",
            `Remove this else and continue the workflow after the terminal ${terminalBranchKeyword(terminal)}`,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function ruleFromFinder<Kind extends string>(
  description: string,
  finder: (sourceText: string, filePath: string) => readonly SyntacticFinding<Kind>[],
) {
  return defineRule({
    meta: { type: "problem", docs: { description }, schema: [] },
    create(context) {
      return {
        Program() {
          for (const violation of finder(context.sourceCode.text, context.filename)) {
            context.report({
              loc: { line: violation.line, column: violation.column - 1 },
              message: violation.message,
            });
          }
        },
      };
    },
  });
}

export const noExceptionFlowRule = ruleFromFinder(
  "Disallow production exception flow outside exactly registered adapters",
  findExceptionFlowViolations,
);
export const noElseAfterTerminalRule = ruleFromFinder(
  "Keep the workflow flat after terminal branches",
  findElseAfterTerminalViolations,
);
export const blobStorageSeamRule = ruleFromFinder(
  "Keep managed opaque bytes behind the unified blob-storage seam",
  findBlobStorageSeamViolations,
);
export const noLocalIsRecordRule = ruleFromFinder(
  "Disallow local duplicates of canonical record guards",
  findLocalRecordGuardViolations,
);
export const noInlineAsyncResultCallbackRule = ruleFromFinder(
  "Disallow inline async callbacks in proven Result combinators",
  findInlineAsyncResultCallbackViolations,
);
export const noPresentationDecoderImportRule = ruleFromFinder(
  "Disallow Zod parser imports in activated unknown-free presentation modules",
  findPresentationDecoderImportViolations,
);
export const preferSwitchTrueChainRule = ruleFromFinder(
  "Use switch (true) for ordered disjunctive branch chains",
  findPreferSwitchTrueChainViolations,
);
export const noStoreInlineDecodingRule = ruleFromFinder(
  "Disallow inline JSON and schema decoding in exact registered store scopes",
  findStoreInlineDecodingViolations,
);
export const noDirectSqliteTransactionRule = ruleFromFinder(
  "Disallow raw SQLite transactions and manual transaction control in exact registered consumers",
  findDirectSqliteTransactionViolations,
);
