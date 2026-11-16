import path from "node:path";

import ts from "typescript-codegen";

import { createFingerprint, createFingerprintIdentity, relativeModulePath } from "./fingerprint.ts";
import { APPROVED_EXCEPTION_ADAPTER_CATALOG, PERSISTED_CODEC_FIXTURE_CASES } from "./manifest.ts";
import {
  CORE_FATAL_SIGNAL_IDENTITIES,
  CORE_REVIEWED_PANIC_IDENTITIES,
  PRECISE_EXCEPTION_IDENTITIES,
} from "./precise-exception-identities.ts";
import type {
  ApprovedExceptionAdapter,
  CompatibilitySink,
  EventCodecRegistryRegistration,
  EventDeliveryApiRegistration,
  EventDeliveryConsumerRegistration,
  PackageSymbolIdentity,
  PersistedCodecRegistration,
  PersistedStoreConsumerRegistration,
  RawEventMessageBoundaryRegistration,
  ResultDecoderRegistration,
  SqliteTransactionAdapterRegistration,
  SqliteTransactionConsumerRegistration,
  SymbolIdentity,
  ToolCodecRegistryRegistration,
  UnknownFreeModuleRegistration,
  WorkspaceArchitecture,
} from "./manifest.ts";
import { ARCHITECTURE_RULES, type ArchitectureDiagnostic, type ArchitectureRule } from "./model.ts";
import { isProductionFileName } from "./source-policy.ts";

interface NodeIdentity extends SymbolIdentity {
  readonly symbolPath: string;
}

function symbolIdentityKey(identity: SymbolIdentity): string {
  return `${identity.module}#${identity.exportName}`;
}

export interface WorkspacePackageRoot {
  readonly packageName: string;
  readonly root: string;
}

export interface ActivePersistenceInfrastructure {
  readonly persistedCodecs: readonly {
    readonly packageName: string;
    readonly identity: SymbolIdentity;
  }[];
  readonly sqliteTransactionAdapters: readonly {
    readonly packageName: string;
    readonly identity: SymbolIdentity;
  }[];
  readonly scanAllProductionModules?: boolean;
}

const ZOD_PARSE_MEMBERS = new Set(["parse", "parseAsync", "safeParse", "safeParseAsync"]);
const UNSAFE_RESULT_MEMBERS = new Set(["deserializeUnsafe", "serializeUnsafe", "unwrap"]);
const MANUAL_RESULT_BRANCH_MEMBERS = new Set(["isError", "isErr", "isOk"]);
const RESULT_CAPTURE_MEMBERS = new Set(["try", "tryPromise"]);
const MAX_TYPE_DEPTH = 6;
const MAX_VISITED_PROPERTIES = 256;
const MAX_PERSISTED_CODEC_PROPERTIES = 1024;
const canonicalPathCache = new Map<string, string>();
const declarationPackageCache = new WeakMap<
  readonly WorkspacePackageRoot[],
  Map<string, string | null>
>();

interface SourceAnalysisIndex {
  readonly aliases: readonly (readonly [source: string, target: string])[];
  readonly calls: readonly ts.CallExpression[];
}

interface ProgramProductionSourceIndex {
  readonly files: readonly ts.SourceFile[];
  readonly modules: ReadonlyMap<string, ts.SourceFile>;
}

const SOURCE_ANALYSIS_INDEXES = new WeakMap<ts.SourceFile, SourceAnalysisIndex>();
const PROGRAM_PRODUCTION_SOURCE_INDEXES = new WeakMap<
  ts.Program,
  Map<string, ProgramProductionSourceIndex>
>();
const NODE_IDENTITIES = new WeakMap<ts.Node, Map<string, NodeIdentity>>();
const RESOLVED_SIGNATURES = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.CallLikeExpression, ts.Signature | null>
>();
const NODE_STARTS = new WeakMap<ts.Node, number>();
const SYMBOL_ASSIGNMENT_INDEXES = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, ReadonlyMap<ts.Symbol, readonly SymbolSource[]>>
>();
const MUTATED_SYMBOL_INDEXES = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, ReadonlySet<ts.Symbol>>
>();
const TYPE_FLAG_FACTS = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.Node, WeakMap<ts.Type, Map<ts.TypeFlags, boolean>>>
>();
const PACKAGE_TYPE_FACTS = new WeakMap<
  ts.TypeChecker,
  WeakMap<readonly WorkspacePackageRoot[], WeakMap<ts.Node, WeakMap<ts.Type, Map<string, boolean>>>>
>();
const INTRINSIC_RESULT_CATCH_MAPPERS = new WeakMap<
  ts.TypeChecker,
  ReadonlySet<ts.SignatureDeclaration>
>();
const INTRINSIC_RESULT_MATCH_HANDLERS = new WeakMap<
  ts.TypeChecker,
  ReadonlySet<ts.SignatureDeclaration>
>();
const INTRINSIC_RESULT_CLASSIFIER_PARAMETERS = new WeakMap<
  ts.TypeChecker,
  ReadonlySet<ts.ParameterDeclaration>
>();

function normalizedPath(value: string): string {
  return value.split(path.sep).join("/");
}

function canonicalPath(value: string): string {
  const cached = canonicalPathCache.get(value);
  if (cached) return cached;
  const canonical = normalizedPath(path.resolve(ts.sys.realpath?.(value) ?? value));
  canonicalPathCache.set(value, canonical);
  return canonical;
}

function isProductionSource(sourceFile: ts.SourceFile, workspaceRoot: string): boolean {
  return !sourceFile.isDeclarationFile && isProductionFileName(sourceFile.fileName, workspaceRoot);
}

function productionSourceIndex(
  program: ts.Program,
  workspaceRoot: string,
): ProgramProductionSourceIndex {
  const root = canonicalPath(workspaceRoot);
  let programIndexes = PROGRAM_PRODUCTION_SOURCE_INDEXES.get(program);
  if (!programIndexes) {
    programIndexes = new Map();
    PROGRAM_PRODUCTION_SOURCE_INDEXES.set(program, programIndexes);
  }
  const cached = programIndexes.get(root);
  if (cached) return cached;

  const files = program
    .getSourceFiles()
    .filter((sourceFile) => isProductionSource(sourceFile, workspaceRoot));
  const index = {
    files,
    modules: new Map(
      files.map((sourceFile) => [relativeModulePath(workspaceRoot, sourceFile), sourceFile]),
    ),
  };
  programIndexes.set(root, index);
  return index;
}

function matchesPattern(file: string, pattern: string): boolean {
  if (pattern === "**") return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3).replace(/\/$/u, "");
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${expression}$`, "u").test(file);
}

function ruleApplies(
  workspace: WorkspaceArchitecture,
  rule: ArchitectureRule,
  module: string,
): boolean {
  return (workspace.ruleZones[rule] ?? []).some((zone) => matchesPattern(module, zone.include));
}

function expressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    return expression.argumentExpression.text;
  }
  if (ts.isParenthesizedExpression(expression)) return expressionName(expression.expression);
  return undefined;
}

function sourceAnalysisIndex(sourceFile: ts.SourceFile): SourceAnalysisIndex {
  const cached = SOURCE_ANALYSIS_INDEXES.get(sourceFile);
  if (cached) return cached;

  const aliases: Array<readonly [source: string, target: string]> = [];
  const calls: ts.CallExpression[] = [];
  const addAlias = (source: string | undefined, target: ts.BindingName | ts.PropertyName): void => {
    if (!source || !ts.isIdentifier(target)) return;
    aliases.push([source, target.text]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isImportSpecifier(node)) {
      aliases.push([node.propertyName?.text ?? node.name.text, node.name.text]);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      addAlias(expressionName(node.initializer), node.name);
    } else if (ts.isBindingElement(node)) {
      const source = node.propertyName;
      if (source && (ts.isIdentifier(source) || ts.isStringLiteral(source))) {
        addAlias(source.text, node.name);
      }
    } else if (ts.isPropertyAssignment(node)) {
      addAlias(expressionName(node.initializer), node.name);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      addAlias(expressionName(node.right), node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const index = { aliases, calls };
  SOURCE_ANALYSIS_INDEXES.set(sourceFile, index);
  return index;
}

function resolvedSignature(
  checker: ts.TypeChecker,
  node: ts.CallLikeExpression,
): ts.Signature | undefined {
  let checkerCache = RESOLVED_SIGNATURES.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    RESOLVED_SIGNATURES.set(checker, checkerCache);
  }
  const cached = checkerCache.get(node);
  if (cached !== undefined) return cached ?? undefined;
  const signature = checker.getResolvedSignature(node);
  checkerCache.set(node, signature ?? null);
  return signature;
}

function nodeStart(node: ts.Node): number {
  const cached = NODE_STARTS.get(node);
  if (cached !== undefined) return cached;
  const start = node.getStart(node.getSourceFile());
  NODE_STARTS.set(node, start);
  return start;
}

function callCandidateNames(
  sourceFile: ts.SourceFile,
  workspace: WorkspaceArchitecture,
  activeRules: ReadonlySet<ArchitectureRule>,
): ReadonlySet<string> {
  const names = new Set<string>();
  if (activeRules.has("architecture/no-unregistered-decoder")) {
    for (const name of ZOD_PARSE_MEMBERS) names.add(name);
  }
  if (activeRules.has("architecture/no-production-unwrap")) {
    for (const name of UNSAFE_RESULT_MEMBERS) names.add(name);
  }
  if (activeRules.has("architecture/no-unmapped-result-capture")) {
    for (const name of RESULT_CAPTURE_MEMBERS) names.add(name);
  }
  if (activeRules.has("architecture/registered-panic-site")) names.add("panic");
  if (activeRules.has("architecture/no-result-wire-leak")) {
    names.add("stringify");
    for (const output of workspace.compatibilityOutputs) names.add(output.sink.exportName);
  }
  if (activeRules.has("architecture/no-unredacted-tagged-error-log")) {
    names.add("stringify");
    names.add("toJSON");
    for (const logger of workspace.structuredLoggers) names.add(logger.sink.exportName);
  }
  if (activeRules.has("architecture/no-result-err-in-sqlite-callback")) {
    names.add("transaction");
  }

  return aliasExpandedNames(sourceFile, names);
}

function aliasExpandedNames(
  sourceFile: ts.SourceFile,
  initialNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set(initialNames);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [source, target] of sourceAnalysisIndex(sourceFile).aliases) {
      if (!names.has(source) || names.has(target)) continue;
      names.add(target);
      changed = true;
    }
  }
  return names;
}

function declarationName(node: ts.Node | undefined): string | undefined {
  for (let current = node; current; current = current.parent) {
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isMethodSignature(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name
    ) {
      if (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name))
        return current.name.text;
    }
  }
  return undefined;
}

export function declarationPackageName(
  node: ts.Node | undefined,
  packageRoots: readonly WorkspacePackageRoot[],
): string | undefined {
  if (!node) return undefined;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name))
      return current.name.text;
  }

  const sourceFile = node.getSourceFile().fileName;
  let packageCache = declarationPackageCache.get(packageRoots);
  if (!packageCache) {
    packageCache = new Map();
    declarationPackageCache.set(packageRoots, packageCache);
  }
  const cached = packageCache.get(sourceFile);
  if (cached !== undefined) return cached ?? undefined;
  const file = canonicalPath(sourceFile);
  const workspacePackage = packageRoots
    .map((candidate) => ({ ...candidate, root: canonicalPath(candidate.root) }))
    .sort((left, right) => right.root.length - left.root.length)
    .find((candidate) => file === candidate.root || file.startsWith(`${candidate.root}/`));
  if (workspacePackage) {
    packageCache.set(sourceFile, workspacePackage.packageName);
    return workspacePackage.packageName;
  }

  const marker = "/node_modules/";
  const index = file.lastIndexOf(marker);
  if (index < 0) {
    packageCache.set(sourceFile, null);
    return undefined;
  }
  const packagePath = file.slice(index + marker.length).split("/");
  const packageName = packagePath[0]?.startsWith("@")
    ? packagePath.slice(0, 2).join("/")
    : packagePath[0];
  packageCache.set(sourceFile, packageName ?? null);
  return packageName;
}

function packageForSignature(
  signature: ts.Signature | undefined,
  packageRoots: readonly WorkspacePackageRoot[],
): string | undefined {
  return declarationPackageName(signature?.declaration, packageRoots);
}

function objectLiteralPath(object: ts.ObjectLiteralExpression): string | undefined {
  const parent = object.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) {
    const property = parent.name.getText();
    const owner = ts.isObjectLiteralExpression(parent.parent)
      ? objectLiteralPath(parent.parent)
      : undefined;
    return owner ? `${owner}.${property}` : property;
  }
  if (ts.isPropertyDeclaration(parent)) return parent.name.getText();
  return undefined;
}

function rawCallablePart(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
    return node.name?.text ?? "<class>";
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.name) return node.name.getText();
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
    return node.name.getText();
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (node.name) return node.name.text;
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name))
      return node.parent.name.text;
    if (ts.isPropertyDeclaration(node.parent)) return node.parent.name.getText();
    if (ts.isPropertyAssignment(node.parent)) {
      const property = node.parent.name.getText();
      const owner = ts.isObjectLiteralExpression(node.parent.parent)
        ? objectLiteralPath(node.parent.parent)
        : undefined;
      return owner ? `${owner}.${property}` : property;
    }
    if (ts.isCallExpression(node.parent)) {
      const argumentIndex = node.parent.arguments.indexOf(node as ts.Expression);
      const called = expressionName(node.parent.expression);
      if (argumentIndex >= 0 && called) return `${called}.<callback@${argumentIndex + 1}>`;
    }
    let owner: ts.Node | undefined = node.parent;
    while (
      owner &&
      (ts.isCallExpression(owner) ||
        ts.isPropertyAccessExpression(owner) ||
        ts.isElementAccessExpression(owner) ||
        ts.isParenthesizedExpression(owner))
    ) {
      owner = owner.parent;
    }
    if (owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) {
      return `${owner.name.text}.<callback>`;
    }
    return "<callback>";
  }
  return undefined;
}

const DISAMBIGUATED_CALLABLE_PARTS = new WeakMap<ts.SourceFile, ReadonlyMap<ts.Node, string>>();

function rawSymbolPath(node: ts.Node): string {
  const parts: string[] = [];
  for (
    let current: ts.Node | undefined = node;
    current && !ts.isSourceFile(current);
    current = current.parent
  ) {
    const part = rawCallablePart(current);
    if (part) parts.unshift(part);
  }
  return parts.join(".") || "<module>";
}

function disambiguatedCallableParts(sourceFile: ts.SourceFile): ReadonlyMap<ts.Node, string> {
  const cached = DISAMBIGUATED_CALLABLE_PARTS.get(sourceFile);
  if (cached) return cached;
  const groups = new Map<string, (ts.ArrowFunction | ts.FunctionExpression)[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const key = rawSymbolPath(node.body);
      const group = groups.get(key) ?? [];
      group.push(node);
      groups.set(key, group);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const parts = new Map<ts.Node, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.forEach((node, index) => {
      parts.set(node, `${rawCallablePart(node) ?? "<callback>"}@${index + 1}`);
    });
  }
  DISAMBIGUATED_CALLABLE_PARTS.set(sourceFile, parts);
  return parts;
}

function callablePart(node: ts.Node): string | undefined {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return disambiguatedCallableParts(node.getSourceFile()).get(node) ?? rawCallablePart(node);
  }
  return rawCallablePart(node);
}

function nodeIdentity(node: ts.Node, workspaceRoot: string): NodeIdentity {
  const root = canonicalPath(workspaceRoot);
  let identities = NODE_IDENTITIES.get(node);
  const cached = identities?.get(root);
  if (cached) return cached;

  const parts: string[] = [];
  for (
    let current: ts.Node | undefined = node;
    current && !ts.isSourceFile(current);
    current = current.parent
  ) {
    const part = callablePart(current);
    if (part) parts.unshift(part);
  }
  let signatureContractPath: string | undefined;
  if (
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isFunctionTypeNode(node)
  ) {
    let container: ts.Node | undefined = node.parent;
    while (
      container &&
      !ts.isInterfaceDeclaration(container) &&
      !ts.isTypeAliasDeclaration(container)
    ) {
      container = container.parent;
    }
    if (
      container &&
      (ts.isInterfaceDeclaration(container) || ts.isTypeAliasDeclaration(container))
    ) {
      const member = ts.isMethodSignature(node)
        ? node.name.getText()
        : ts.isFunctionTypeNode(node) && ts.isPropertySignature(node.parent)
          ? node.parent.name.getText()
          : "<call>";
      signatureContractPath = `${container.name.text}.${member}`;
    }
  }
  const declaredContractName =
    ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? node.name.text : undefined;
  const symbolPath = parts.join(".") || signatureContractPath || declaredContractName || "<module>";
  const identity = {
    module: relativeModulePath(workspaceRoot, node.getSourceFile()),
    exportName:
      parts[0] ?? signatureContractPath?.split(".")[0] ?? declaredContractName ?? "<module>",
    symbolPath,
  };
  if (!identities) {
    identities = new Map();
    NODE_IDENTITIES.set(node, identities);
  }
  identities.set(root, identity);
  return identity;
}

function identityOwns(owner: SymbolIdentity, candidate: NodeIdentity): boolean {
  return (
    owner.module === candidate.module &&
    (candidate.symbolPath === owner.exportName ||
      candidate.symbolPath.startsWith(`${owner.exportName}.`))
  );
}

function identityMatches(owner: SymbolIdentity, candidate: NodeIdentity): boolean {
  return owner.module === candidate.module && owner.exportName === candidate.symbolPath;
}

function parameterContractIdentity(
  node: ts.ParameterDeclaration,
  workspaceRoot: string,
): NodeIdentity | undefined {
  const signature = node.parent;
  if (
    !ts.isMethodSignature(signature) &&
    !ts.isCallSignatureDeclaration(signature) &&
    !ts.isFunctionTypeNode(signature)
  ) {
    return undefined;
  }
  return nodeIdentity(signature, workspaceRoot);
}

function isUnknown(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Unknown) !== 0;
}

interface UnknownTraversalState {
  readonly inspectMethodProperties: boolean;
  readonly seen: Set<ts.Type>;
  remainingProperties: number;
}

const CLOSED_PLATFORM_TYPE_NAMES = new Set(["ArrayBuffer", "SharedArrayBuffer", "Uint8Array"]);

function isClosedPlatformType(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.symbol;
  if (!symbol) return false;
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return false;
  if (CLOSED_PLATFORM_TYPE_NAMES.has(symbol.name)) {
    return declarations.every(isDefaultLibraryDeclaration);
  }
  if (symbol.name === "URL") {
    return declarations.every(
      (declaration) =>
        isDefaultLibraryDeclaration(declaration) ||
        /(?:^|\/)@types\/node\/url\.d\.ts$/u.test(
          normalizedPath(declaration.getSourceFile().fileName),
        ),
    );
  }
  return (
    symbol.name === "Buffer" &&
    declarations.every((declaration) =>
      /(?:^|\/)@types\/node\/buffer(?:\.buffer)?\.d\.ts$/u.test(
        normalizedPath(declaration.getSourceFile().fileName),
      ),
    )
  );
}

function typeContainsFlags(
  type: ts.Type,
  forbiddenFlags: ts.TypeFlags,
  checker: ts.TypeChecker,
  location: ts.Node,
  state?: UnknownTraversalState,
): boolean {
  if (!state) {
    let checkerCache = TYPE_FLAG_FACTS.get(checker);
    if (!checkerCache) {
      checkerCache = new WeakMap();
      TYPE_FLAG_FACTS.set(checker, checkerCache);
    }
    let locationCache = checkerCache.get(location);
    if (!locationCache) {
      locationCache = new WeakMap();
      checkerCache.set(location, locationCache);
    }
    let typeCache = locationCache.get(type);
    if (!typeCache) {
      typeCache = new Map();
      locationCache.set(type, typeCache);
    }
    const cached = typeCache.get(forbiddenFlags);
    if (cached !== undefined) return cached;
    const result = typeContainsFlags(type, forbiddenFlags, checker, location, {
      inspectMethodProperties: true,
      seen: new Set(),
      remainingProperties: MAX_VISITED_PROPERTIES,
    });
    typeCache.set(forbiddenFlags, result);
    return result;
  }
  if ((type.flags & forbiddenFlags) !== 0) return true;
  if (isClosedPlatformType(type)) return false;
  if (state.seen.has(type)) return false;
  state.seen.add(type);

  if (
    type.isUnionOrIntersection() &&
    type.types.some((member) => typeContainsFlags(member, forbiddenFlags, checker, location, state))
  ) {
    return true;
  }
  if (
    typeArguments(type, checker).some((argument) =>
      typeContainsFlags(argument, forbiddenFlags, checker, location, state),
    )
  ) {
    return true;
  }
  const constraint = checker.getBaseConstraintOfType(type);
  if (
    constraint &&
    constraint !== type &&
    typeContainsFlags(constraint, forbiddenFlags, checker, location, state)
  ) {
    return true;
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  for (const signature of [
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Call),
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct),
  ]) {
    if (typeContainsFlags(signature.getReturnType(), forbiddenFlags, checker, location, state)) {
      return true;
    }
    for (const parameter of signature.getTypeParameters() ?? []) {
      const parameterConstraint = checker.getBaseConstraintOfType(parameter);
      if (
        parameterConstraint &&
        typeContainsFlags(parameterConstraint, forbiddenFlags, checker, location, state)
      ) {
        return true;
      }
    }
    for (const parameter of signature.parameters) {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? location;
      if (
        typeContainsFlags(
          checker.getTypeOfSymbolAtLocation(parameter, declaration),
          forbiddenFlags,
          checker,
          location,
          state,
        )
      ) {
        return true;
      }
    }
  }
  for (const kind of [ts.IndexKind.String, ts.IndexKind.Number]) {
    const indexed = checker.getIndexTypeOfType(type, kind);
    if (indexed && typeContainsFlags(indexed, forbiddenFlags, checker, location, state)) {
      return true;
    }
  }
  for (const property of checker.getPropertiesOfType(type)) {
    if (state.remainingProperties <= 0) return true;
    const declarations = property.declarations ?? [];
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      property.valueDeclaration ?? property.declarations?.[0] ?? location,
    );
    if (
      declarations.length > 0 &&
      (declarations.some(isDefaultLibraryDeclaration) ||
        (!state.inspectMethodProperties &&
          declarations.every(
            (declaration) =>
              ts.isMethodDeclaration(declaration) ||
              ts.isMethodSignature(declaration) ||
              ts.isFunctionDeclaration(declaration),
          )))
    ) {
      continue;
    }
    if (
      !state.inspectMethodProperties &&
      (checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call).length > 0 ||
        checker.getSignaturesOfType(propertyType, ts.SignatureKind.Construct).length > 0)
    ) {
      continue;
    }
    state.remainingProperties -= 1;
    if (typeContainsFlags(propertyType, forbiddenFlags, checker, location, state)) return true;
  }
  return baseTypes(type).some((baseType) =>
    typeContainsFlags(baseType, forbiddenFlags, checker, location, state),
  );
}

function typeContainsUnknown(type: ts.Type, checker: ts.TypeChecker, location: ts.Node): boolean {
  return typeContainsFlags(type, ts.TypeFlags.Unknown, checker, location);
}

function isStructured(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) !== 0) return true;
  if (type.isUnionOrIntersection()) return type.types.some(isStructured);
  return false;
}

function symbolComesFromPackage(
  symbol: ts.Symbol | undefined,
  packageName: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  return (
    symbol?.declarations?.some(
      (declaration) => declarationPackageName(declaration, packageRoots) === packageName,
    ) ?? false
  );
}

interface TypeTraversalState {
  readonly seen: Set<ts.Type>;
  remainingProperties: number;
}

function typeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  const argumentsFromAlias = type.aliasTypeArguments ?? [];
  if ((type.flags & ts.TypeFlags.Object) === 0) return argumentsFromAlias;
  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & ts.ObjectFlags.Reference) === 0) return argumentsFromAlias;
  return [...argumentsFromAlias, ...checker.getTypeArguments(objectType as ts.TypeReference)];
}

function baseTypes(type: ts.Type): readonly ts.BaseType[] {
  if ((type.flags & ts.TypeFlags.Object) === 0) return [];
  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) === 0) return [];
  return objectType.getBaseTypes() ?? [];
}

function typeContainsPackageType(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  packageName: string,
  symbolNames: ReadonlySet<string>,
  location: ts.Node,
  state?: TypeTraversalState,
  depth = 0,
): boolean {
  if (!state) {
    let checkerCache = PACKAGE_TYPE_FACTS.get(checker);
    if (!checkerCache) {
      checkerCache = new WeakMap();
      PACKAGE_TYPE_FACTS.set(checker, checkerCache);
    }
    let rootsCache = checkerCache.get(packageRoots);
    if (!rootsCache) {
      rootsCache = new WeakMap();
      checkerCache.set(packageRoots, rootsCache);
    }
    let locationCache = rootsCache.get(location);
    if (!locationCache) {
      locationCache = new WeakMap();
      rootsCache.set(location, locationCache);
    }
    let typeCache = locationCache.get(type);
    if (!typeCache) {
      typeCache = new Map();
      locationCache.set(type, typeCache);
    }
    const key = `${packageName}\0${[...symbolNames].sort().join("\0")}`;
    const cached = typeCache.get(key);
    if (cached !== undefined) return cached;
    const result = typeContainsPackageType(
      type,
      checker,
      packageRoots,
      packageName,
      symbolNames,
      location,
      { seen: new Set(), remainingProperties: MAX_VISITED_PROPERTIES },
      depth,
    );
    typeCache.set(key, result);
    return result;
  }
  if (depth > MAX_TYPE_DEPTH || state.seen.has(type)) return false;
  state.seen.add(type);

  if (
    symbolComesFromPackage(type.aliasSymbol, packageName, packageRoots) ||
    symbolComesFromPackage(type.getSymbol(), packageName, packageRoots)
  ) {
    const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    if (name && symbolNames.has(name)) return true;
  }
  if (
    type.isUnionOrIntersection() &&
    type.types.some((member) =>
      typeContainsPackageType(
        member,
        checker,
        packageRoots,
        packageName,
        symbolNames,
        location,
        state,
        depth + 1,
      ),
    )
  ) {
    return true;
  }

  if (
    typeArguments(type, checker).some((argument) =>
      typeContainsPackageType(
        argument,
        checker,
        packageRoots,
        packageName,
        symbolNames,
        location,
        state,
        depth + 1,
      ),
    )
  ) {
    return true;
  }

  if (
    baseTypes(type).some((baseType) =>
      typeContainsPackageType(
        baseType,
        checker,
        packageRoots,
        packageName,
        symbolNames,
        location,
        state,
        depth + 1,
      ),
    )
  ) {
    return true;
  }

  const constraint = checker.getBaseConstraintOfType(type);
  if (
    constraint &&
    constraint !== type &&
    typeContainsPackageType(
      constraint,
      checker,
      packageRoots,
      packageName,
      symbolNames,
      location,
      state,
      depth + 1,
    )
  ) {
    return true;
  }

  for (const property of checker.getPropertiesOfType(type)) {
    if (state.remainingProperties <= 0) return false;
    if (
      property.declarations?.every(
        (declaration) =>
          ts.isMethodDeclaration(declaration) ||
          ts.isMethodSignature(declaration) ||
          ts.isFunctionDeclaration(declaration),
      )
    ) {
      continue;
    }
    state.remainingProperties -= 1;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, location);
    if (
      typeContainsPackageType(
        propertyType,
        checker,
        packageRoots,
        packageName,
        symbolNames,
        location,
        state,
        depth + 1,
      )
    ) {
      return true;
    }
  }

  const apparent = checker.getApparentType(type);
  return (
    apparent !== type &&
    typeContainsPackageType(
      apparent,
      checker,
      packageRoots,
      packageName,
      symbolNames,
      location,
      state,
      depth + 1,
    )
  );
}

function typeContainsBetterResult(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  const resultNames = new Set(["AnyTaggedError", "Err", "Ok", "Result", "TaggedErrorInstance"]);
  if (
    typeContainsPackageType(type, checker, packageRoots, "better-result", resultNames, location)
  ) {
    return true;
  }
  const tag = type.getProperty("_tag");
  const match = type.getProperty("match");
  return Boolean(tag && symbolComesFromPackage(match, "better-result", packageRoots));
}

function typeContainsResult(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  return typeContainsPackageType(
    type,
    checker,
    packageRoots,
    "better-result",
    new Set(["Err", "Ok", "Result"]),
    location,
  );
}

function typeContainsUnhandledException(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  return typeContainsPackageType(
    type,
    checker,
    packageRoots,
    "better-result",
    new Set(["UnhandledException"]),
    location,
  );
}

function typeContainsPanic(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  return typeContainsPackageType(
    type,
    checker,
    packageRoots,
    "better-result",
    new Set(["Panic"]),
    location,
  );
}

function typeContainsTaggedError(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  if (
    typeContainsPackageType(
      type,
      checker,
      packageRoots,
      "better-result",
      new Set(["AnyTaggedError", "TaggedErrorInstance"]),
      location,
    )
  ) {
    return true;
  }
  const toJSON = type.getProperty("toJSON");
  return Boolean(
    type.getProperty("_tag") && symbolComesFromPackage(toJSON, "better-result", packageRoots),
  );
}

function typeIsTaggedError(
  type: ts.Type,
  packageRoots: readonly WorkspacePackageRoot[],
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (
    typeIsPackageType(
      type,
      "better-result",
      new Set(["AnyTaggedError", "TaggedErrorInstance"]),
      packageRoots,
    )
  ) {
    return true;
  }
  const toJSON = type.getProperty("toJSON");
  if (type.getProperty("_tag") && symbolComesFromPackage(toJSON, "better-result", packageRoots)) {
    return true;
  }
  if (
    type.isUnionOrIntersection() &&
    type.types.some((member) => typeIsTaggedError(member, packageRoots, seen))
  ) {
    return true;
  }
  return baseTypes(type).some((baseType) => typeIsTaggedError(baseType, packageRoots, seen));
}

function typeIsPackageType(
  type: ts.Type,
  packageName: string,
  symbolNames: ReadonlySet<string>,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const symbols = [type.aliasSymbol, type.getSymbol()];
  return symbols.some((symbol) => {
    const name = symbol?.getName();
    return Boolean(
      name && symbolNames.has(name) && symbolComesFromPackage(symbol, packageName, packageRoots),
    );
  });
}

function isDirectResultType(type: ts.Type, packageRoots: readonly WorkspacePackageRoot[]): boolean {
  if (typeIsPackageType(type, "better-result", new Set(["Err", "Ok", "Result"]), packageRoots)) {
    return true;
  }
  return (
    type.isUnion() &&
    type.types.length > 0 &&
    type.types.every((member) =>
      typeIsPackageType(member, "better-result", new Set(["Err", "Ok"]), packageRoots),
    )
  );
}

function isFallibleResultContract(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (isDirectResultType(type, packageRoots)) return true;
  const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (
    symbolName !== "Promise" &&
    symbolName !== "AsyncIterable" &&
    symbolName !== "AsyncGenerator"
  ) {
    return baseTypes(type).some((baseType) =>
      isFallibleResultContract(baseType, checker, packageRoots),
    );
  }
  const [valueType] = typeArguments(type, checker);
  return Boolean(valueType && isDirectResultType(valueType, packageRoots));
}

function callReceiver(node: ts.CallExpression): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.expression;
  if (ts.isElementAccessExpression(node.expression)) return node.expression.expression;
  return undefined;
}

function importDeclarationFor(node: ts.Node): ts.ImportDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current)) return current;
  }
  return undefined;
}

function isDirectImmutableResultBinding(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    const symbol = checker.getSymbolAtLocation(value);
    if (!symbol || symbolIsMutated(symbol, value.getSourceFile(), checker)) return false;
    return (symbol.declarations ?? []).some((declaration) => {
      if (!ts.isImportSpecifier(declaration)) return false;
      const imported = (declaration.propertyName ?? declaration.name).text;
      return (
        imported === "Result" &&
        importDeclarationFor(declaration)?.moduleSpecifier.getText().replaceAll(/["']/gu, "") ===
          "better-result"
      );
    });
  }
  const selected = selectedProperty(value);
  if (!selected || selected.name !== "Result") return false;
  const namespace = unwrapExpression(selected.receiver);
  if (!ts.isIdentifier(namespace)) return false;
  const symbol = checker.getSymbolAtLocation(namespace);
  if (!symbol || symbolIsMutated(symbol, namespace.getSourceFile(), checker)) return false;
  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isNamespaceImport(declaration) &&
      importDeclarationFor(declaration)?.moduleSpecifier.getText().replaceAll(/["']/gu, "") ===
        "better-result",
  );
}

function isDirectImmutableResultCaptureCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const selected = selectedProperty(call.expression);
  return Boolean(
    selected &&
    RESULT_CAPTURE_MEMBERS.has(selected.name) &&
    isDirectImmutableResultBinding(selected.receiver, checker),
  );
}

function callableExpressionDeclaration(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.FunctionLikeDeclaration | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return unwrapped;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  const resolvedSymbol = symbol && canonicalSymbol(symbol, checker);
  if (!resolvedSymbol || seenSymbols.has(resolvedSymbol)) return undefined;
  seenSymbols.add(resolvedSymbol);
  for (const declaration of resolvedSymbol?.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
      if (declaration.body) return declaration;
      continue;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        return initializer;
      const callable = callableExpressionDeclaration(initializer, checker, seenSymbols);
      if (callable) return callable;
    }
  }
  return undefined;
}

function immutableCallableExpressionDeclaration(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | undefined {
  const value = unwrapExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
  if (!ts.isIdentifier(value)) {
    const root = rootIdentifier(value);
    const rootSymbol = root && checker.getSymbolAtLocation(root);
    const immutableRoot = rootSymbol?.declarations?.some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
    );
    if (
      !root ||
      !rootSymbol ||
      !immutableRoot ||
      symbolIsMutated(rootSymbol, root.getSourceFile(), checker)
    ) {
      return undefined;
    }
    const implementation = callableExpressionDeclaration(value, checker);
    return implementation?.body ? implementation : undefined;
  }
  const symbol = checker.getSymbolAtLocation(value);
  if (!symbol || symbolIsMutated(symbol, value.getSourceFile(), checker)) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration)) return declaration.body ? declaration : undefined;
    if (
      ts.isVariableDeclaration(declaration) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      declaration.initializer
    ) {
      const initializer = unwrapExpression(declaration.initializer);
      return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
        ? initializer
        : undefined;
    }
    if (ts.isImportSpecifier(declaration)) {
      const implementation = callableExpressionDeclaration(value, checker);
      return implementation?.body ? implementation : undefined;
    }
  }
  return undefined;
}

interface CatchMapperResolution {
  readonly expression?: ts.Expression;
  readonly mapper?: ts.FunctionLikeDeclaration;
  readonly unresolved: boolean;
}

function resultCaptureCatchMapperResolution(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): CatchMapperResolution {
  const options = node.arguments[0];
  if (!options || ts.isSpreadElement(options)) return { unresolved: false };
  const object = returnedObjectLiteral(options, checker);
  if (!object) {
    const value = unwrapExpression(options);
    return ts.isArrowFunction(value) || ts.isFunctionExpression(value)
      ? { unresolved: false }
      : { expression: options, unresolved: true };
  }
  const mapper = object && objectPropertyExpression(object, "catch", checker, new Set());
  if (!mapper) return { unresolved: true };
  const expression = unwrapExpression(mapper);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return { expression, mapper: expression, unresolved: false };
  }
  if (!ts.isIdentifier(expression)) return { expression, unresolved: true };
  const implementation = immutableCallableExpressionDeclaration(expression, checker);
  return implementation?.body
    ? { expression, mapper: implementation, unresolved: false }
    : { expression, unresolved: true };
}

function resultCaptureCatchMapper(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | undefined {
  return resultCaptureCatchMapperResolution(node, checker).mapper;
}

function mapperHasExplicitExceptionChannel(
  mapper: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (!mapper.body) return false;
  let found = false;
  const visitedCallables = new Set<ts.FunctionLikeDeclaration>([mapper]);
  const visit = (node: ts.Node): void => {
    if (found || (node !== mapper.body && ts.isFunctionLike(node))) return;
    if (ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const signature = resolvedSignature(checker, node);
      const member = declarationName(signature?.declaration) ?? expressionName(node.expression);
      if (
        packageForSignature(signature, packageRoots) === "better-result" &&
        member !== undefined &&
        RESULT_CAPTURE_MEMBERS.has(member) &&
        isDirectImmutableResultCaptureCall(node, checker)
      ) {
        const nestedMapper = resultCaptureCatchMapper(node, checker);
        if (!nestedMapper?.body || visitedCallables.has(nestedMapper)) {
          found = true;
          return;
        }
        visitedCallables.add(nestedMapper);
        visit(nestedMapper.body);
        return;
      }
      if (packageForSignature(signature, packageRoots) === "better-result" && member === "match") {
        const input = resultMatchInputExpression(node, signature, checker, packageRoots);
        const handlers = resultMatchHandlersArgument(node, signature, checker, packageRoots);
        if (input && handlers && resolvesToDirectLocalResultCapture(input, checker, packageRoots)) {
          const ok = resultMatchHandler(handlers, "ok", checker);
          const err = resultMatchHandler(handlers, "err", checker);
          if (!ok?.body || !err?.body) {
            found = true;
            return;
          }
          for (const branch of new Set([ok, err])) {
            const body = branch.body;
            if (!body || visitedCallables.has(branch)) {
              found = true;
              return;
            }
            visitedCallables.add(branch);
            visit(body);
          }
          return;
        }
      }
      if (
        isDefaultLibraryDeclaration(signature?.declaration) &&
        declarationOwnerName(signature?.declaration) === "PromiseConstructor" &&
        member === "reject"
      ) {
        found = true;
        return;
      }
      const declaration = signature?.declaration;
      if (
        declaration &&
        workspace.exceptionAdapters.some(
          (adapter) =>
            adapter.direction === "signal-host" &&
            identityOwns(adapter.identity, nodeIdentity(declaration, workspaceRoot)),
        )
      ) {
        found = true;
        return;
      }
      const called = immutableCallableExpressionDeclaration(node.expression, checker);
      if (called?.body && !visitedCallables.has(called)) {
        visitedCallables.add(called);
        visit(called.body);
      } else if (
        !called?.body &&
        !(
          (isDefaultLibraryDeclaration(signature?.declaration) &&
            ["BooleanConstructor", "NumberConstructor", "StringConstructor"].includes(
              declarationOwnerName(signature?.declaration) ?? "",
            )) ||
          externalCallMatches(
            node,
            { package: "better-result", exportName: "Panic.is" },
            checker,
            packageRoots,
          )
        )
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(mapper.body);
  return found;
}

function analyzeMappedResultCapture(
  node: ts.CallExpression,
  member: string,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  if (!isDirectImmutableResultCaptureCall(node, checker)) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-unmapped-result-capture",
        node,
        `Result.${member} is not invoked through a direct immutable better-result import binding.`,
        "Call Result.try or Result.tryPromise directly through its immutable import binding.",
      ),
    );
    return;
  }
  const resolution = resultCaptureCatchMapperResolution(node, checker);
  if (!resolution.expression && !resolution.unresolved) return;
  const mapper = resolution.mapper;
  if (resolution.unresolved || !mapper?.body) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-unmapped-result-capture",
        resolution.expression ?? node,
        `Result.${member} catch mapper has no directly resolvable immutable implementation.`,
        "Use an inline mapper or a direct immutable function binding with a visible implementation.",
      ),
    );
    return;
  }
  if (mapperHasExplicitExceptionChannel(mapper, checker, workspace, workspaceRoot, packageRoots)) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-unmapped-result-capture",
        mapper,
        `Result.${member} catch mapper explicitly throws, rejects, or signals a registered host failure, or transitively calls an unresolved helper.`,
        "Return a specific expected error value from the catch mapper; signal host failure only after Result policy is resolved.",
      ),
    );
  }
}

function resultExpectedErrorType(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): ts.Type | undefined {
  if (!isDirectResultType(type, packageRoots)) {
    const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    if (name !== "Promise") return undefined;
    const [value] = typeArguments(type, checker);
    return value && resultExpectedErrorType(value, checker, packageRoots, location);
  }
  const members = type.isUnion() ? type.types : [type];
  for (const member of members) {
    if (!typeIsPackageType(member, "better-result", new Set(["Err"]), packageRoots)) continue;
    const error = member.getProperty("error");
    if (error) return checker.getTypeOfSymbolAtLocation(error, location);
    return typeArguments(member, checker).at(-1);
  }
  return undefined;
}

function analyzeSqliteTransactionCallback(
  node: ts.CallExpression,
  signature: ts.Signature | undefined,
  sourcePackage: string | undefined,
  member: string | undefined,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  if (sourcePackage !== "bun:sqlite" || member !== "transaction") return;
  const callbackExpression = node.arguments[0];
  if (!callbackExpression || ts.isSpreadElement(callbackExpression)) return;
  const callback = callableExpressionDeclaration(callbackExpression, checker);
  const callbackSignature = checker.getSignaturesOfType(
    checker.getTypeAtLocation(callbackExpression),
    ts.SignatureKind.Call,
  )[0];
  const returned = callbackSignature?.getReturnType();
  const callbackReturnsErr = Boolean(
    returned &&
    typeContainsPackageType(
      returned,
      checker,
      packageRoots,
      "better-result",
      new Set(["Err"]),
      callbackExpression,
    ),
  );
  let resultErrCall: ts.CallExpression | undefined;
  if (callback) {
    const visit = (child: ts.Node): void => {
      if (resultErrCall || (child !== callback && ts.isFunctionLike(child))) return;
      if (ts.isCallExpression(child)) {
        const childSignature = resolvedSignature(checker, child);
        if (
          packageForSignature(childSignature, packageRoots) === "better-result" &&
          declarationName(childSignature?.declaration) === "err"
        ) {
          resultErrCall = child;
          return;
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(callback);
  }
  if (!callbackReturnsErr && !resultErrCall) return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-result-err-in-sqlite-callback",
      resultErrCall ?? callbackExpression,
      "Raw bun:sqlite transaction callback can produce a better-result Err without forcing rollback.",
      "Return a plain value from the raw driver callback and throw only the registered private rollback sentinel inside the SQLite Result adapter.",
    ),
  );
  void signature;
}

function isDefaultLibraryDeclaration(node: ts.Node | undefined): boolean {
  if (!node) return false;
  return /(?:^|\/)lib\.[^/]+\.d\.ts$/u.test(normalizedPath(node.getSourceFile().fileName));
}

function outputIdentityMatches(
  identity: CompatibilitySink,
  signature: ts.Signature | undefined,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (!signature?.declaration) return false;
  switch (identity.kind) {
    case "external":
      return (
        packageForSignature(signature, packageRoots) === identity.package &&
        declarationName(signature.declaration) === identity.exportName
      );
    case "local":
      return identityMatches(identity, nodeIdentity(signature.declaration, workspaceRoot));
  }
}

function isRegisteredFormatterCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const signature = resolvedSignature(checker, node);
  return workspace.taggedErrorFormatters.some((formatter) =>
    outputIdentityMatches(formatter, signature, workspaceRoot, packageRoots),
  );
}

function bindingElementSource(
  element: ts.BindingElement,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const selectors: Array<
    | { readonly kind: "array"; readonly index: number }
    | { readonly kind: "object"; readonly name: string }
  > = [];
  let current = element;
  while (true) {
    const pattern = current.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      const name = current.propertyName ?? current.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) {
        return undefined;
      }
      selectors.unshift({ kind: "object", name: name.text });
    } else if (ts.isArrayBindingPattern(pattern)) {
      const index = pattern.elements.indexOf(current);
      if (index < 0) return undefined;
      selectors.unshift({ kind: "array", index });
    } else {
      return undefined;
    }

    if (!ts.isBindingElement(pattern.parent)) {
      if (!ts.isVariableDeclaration(pattern.parent) || !pattern.parent.initializer)
        return undefined;
      let source: ts.Expression = pattern.parent.initializer;
      const expandedSymbols = new Set<ts.Symbol>();
      for (const selector of selectors) {
        while (ts.isIdentifier(source)) {
          const sourceSymbol = checker.getSymbolAtLocation(source);
          if (!sourceSymbol || expandedSymbols.has(sourceSymbol)) break;
          expandedSymbols.add(sourceSymbol);
          const declaration = sourceSymbol.declarations?.find(
            (candidate): candidate is ts.VariableDeclaration =>
              ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
          );
          if (!declaration?.initializer) break;
          source = declaration.initializer;
        }
        if (selector.kind === "object" && ts.isObjectLiteralExpression(source)) {
          const property = source.properties.find((candidate) => {
            if (
              !ts.isPropertyAssignment(candidate) &&
              !ts.isShorthandPropertyAssignment(candidate)
            ) {
              return false;
            }
            const propertyName = candidate.name;
            return (
              (ts.isIdentifier(propertyName) ||
                ts.isStringLiteral(propertyName) ||
                ts.isNumericLiteral(propertyName)) &&
              propertyName.text === selector.name
            );
          });
          if (property && ts.isPropertyAssignment(property)) {
            source = property.initializer;
            continue;
          }
          if (property && ts.isShorthandPropertyAssignment(property)) {
            source = property.name;
            continue;
          }
          return source;
        }
        if (selector.kind === "array" && ts.isArrayLiteralExpression(source)) {
          const selected = source.elements[selector.index];
          if (!selected || ts.isOmittedExpression(selected) || ts.isSpreadElement(selected)) {
            return source;
          }
          source = selected;
          continue;
        }
        return source;
      }
      return source;
    }
    current = pattern.parent;
  }
}

interface SymbolSource {
  readonly position: number;
  readonly expression: ts.Expression;
}

function symbolAssignmentIndex(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyMap<ts.Symbol, readonly SymbolSource[]> {
  let checkerCache = SYMBOL_ASSIGNMENT_INDEXES.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    SYMBOL_ASSIGNMENT_INDEXES.set(checker, checkerCache);
  }
  const cached = checkerCache.get(sourceFile);
  if (cached) return cached;

  const assignments = new Map<ts.Symbol, SymbolSource[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) {
        const sources = assignments.get(symbol) ?? [];
        sources.push({ position: nodeStart(node), expression: node.right });
        assignments.set(symbol, sources);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const sources of assignments.values()) {
    sources.sort((left, right) => left.position - right.position);
  }
  checkerCache.set(sourceFile, assignments);
  return assignments;
}

function latestSymbolSource(
  symbol: ts.Symbol,
  use: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const usePosition = nodeStart(use);
  let latest: SymbolSource | undefined;
  for (const declaration of symbol.declarations ?? []) {
    let expression: ts.Expression | undefined;
    if (ts.isVariableDeclaration(declaration)) expression = declaration.initializer;
    if (ts.isBindingElement(declaration)) expression = bindingElementSource(declaration, checker);
    const position = nodeStart(declaration);
    if (expression && position < usePosition) {
      latest = { position, expression };
    }
  }
  const assignments = symbolAssignmentIndex(use.getSourceFile(), checker).get(symbol) ?? [];
  let left = 0;
  let right = assignments.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (assignments[middle]!.position < usePosition) left = middle + 1;
    else right = middle;
  }
  const assignment = assignments[left - 1];
  if (assignment && (!latest || assignment.position > latest.position)) latest = assignment;
  return latest?.expression;
}

function stableSymbolSource(
  symbol: ts.Symbol,
  use: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  if (symbolIsMutated(symbol, use.getSourceFile(), checker)) return undefined;
  const usePosition = nodeStart(use);
  const assignments = symbolAssignmentIndex(use.getSourceFile(), checker).get(symbol) ?? [];
  if (assignments.some(({ position }) => position < usePosition)) return undefined;
  const declarations = (symbol.declarations ?? []).flatMap((declaration) => {
    let expression: ts.Expression | undefined;
    if (ts.isVariableDeclaration(declaration)) expression = declaration.initializer;
    if (ts.isBindingElement(declaration)) expression = bindingElementSource(declaration, checker);
    return expression && nodeStart(declaration) < usePosition ? [expression] : [];
  });
  return declarations.length === 1 ? declarations[0] : undefined;
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function mutatedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlySet<ts.Symbol> {
  let checkerCache = MUTATED_SYMBOL_INDEXES.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    MUTATED_SYMBOL_INDEXES.set(checker, checkerCache);
  }
  const cached = checkerCache.get(sourceFile);
  if (cached) return cached;
  const bindingMutated = new Set<ts.Symbol>();
  const objectMutated = new Set<ts.Symbol>();
  const aliases: [ts.Symbol, ts.Symbol][] = [];
  const add = (symbols: Set<ts.Symbol>, expression: ts.Expression): void => {
    const identifier = rootIdentifier(expression);
    const symbol = identifier && checker.getSymbolAtLocation(identifier);
    if (symbol) symbols.add(canonicalSymbol(symbol, checker));
  };
  const addAssignmentTarget = (target: ts.Expression): void => {
    const value = unwrapExpression(target);
    if (ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) {
        if (ts.isOmittedExpression(element)) continue;
        addAssignmentTarget(ts.isSpreadElement(element) ? element.expression : element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(property);
          if (symbol) bindingMutated.add(canonicalSymbol(symbol, checker));
          else add(bindingMutated, property.name);
        }
        if (ts.isPropertyAssignment(property)) addAssignmentTarget(property.initializer);
        if (ts.isSpreadAssignment(property)) addAssignmentTarget(property.expression);
      }
      return;
    }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      addAssignmentTarget(value.left);
      return;
    }
    add(ts.isIdentifier(value) ? bindingMutated : objectMutated, value);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const source = rootIdentifier(node.initializer);
      const aliasSymbol = checker.getSymbolAtLocation(node.name);
      const sourceSymbol = source && checker.getSymbolAtLocation(source);
      if (aliasSymbol && sourceSymbol) {
        aliases.push([
          canonicalSymbol(aliasSymbol, checker),
          canonicalSymbol(sourceSymbol, checker),
        ]);
      }
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      addAssignmentTarget(node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      addAssignmentTarget(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const operand = unwrapExpression(node.operand);
      add(ts.isIdentifier(operand) ? bindingMutated : objectMutated, operand);
    } else if (ts.isCallExpression(node)) {
      const selected = selectedProperty(node.expression);
      const receiver = selected && unwrapExpression(selected.receiver);
      if (
        selected &&
        receiver !== undefined &&
        ts.isIdentifier(receiver) &&
        ((receiver.text === "Object" &&
          (selected.name === "assign" || selected.name === "defineProperty")) ||
          (receiver.text === "Reflect" &&
            (selected.name === "set" || selected.name === "defineProperty")))
      ) {
        const target = node.arguments[0];
        if (target && !ts.isSpreadElement(target)) add(objectMutated, target);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [alias, source] of aliases) {
      if (objectMutated.has(alias) === objectMutated.has(source)) continue;
      objectMutated.add(alias);
      objectMutated.add(source);
      changed = true;
    }
  }
  const mutated = new Set([...bindingMutated, ...objectMutated]);
  checkerCache.set(sourceFile, mutated);
  return mutated;
}

function symbolIsMutated(
  symbol: ts.Symbol,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  return mutatedSymbols(sourceFile, checker).has(canonicalSymbol(symbol, checker));
}

function expressionContainsUnformattedTaggedError(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const visit = (node: ts.Node): boolean => {
    if (
      ts.isCallExpression(node) &&
      isRegisteredFormatterCall(node, checker, workspace, workspaceRoot, packageRoots)
    ) {
      return false;
    }
    if (ts.isExpression(node)) {
      const type = checker.getTypeAtLocation(node);
      if (
        typeIsTaggedError(type, packageRoots) ||
        (!typeContainsResult(type, checker, packageRoots, node) &&
          typeContainsTaggedError(type, checker, packageRoots, node))
      ) {
        return true;
      }
    }
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol && !seenSymbols.has(symbol)) {
        seenSymbols.add(symbol);
        const source = latestSymbolSource(symbol, node, checker);
        if (source && visit(source)) return true;
      }
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && visit(child)) found = true;
    });
    return found;
  };
  return visit(expression);
}

function makeDiagnostic(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  rule: ArchitectureRule,
  node: ts.Node,
  message: string,
  suggestion: string,
): ArchitectureDiagnostic {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const identity = nodeIdentity(node, workspaceRoot);
  const fingerprintInput = {
    workspace: workspace.name,
    rule,
    module: identity.module,
    symbolPath: identity.symbolPath,
    node,
  } as const;
  return {
    rule,
    severity: "error",
    workspace: workspace.name,
    message,
    suggestion,
    identity: createFingerprintIdentity(fingerprintInput),
    fingerprint: createFingerprint(fingerprintInput),
    location: {
      file: relativeModulePath(workspaceRoot, sourceFile),
      line: start.line + 1,
      column: start.character + 1,
    },
  };
}

interface SuggestionProgram extends ts.Program {
  getSuggestionDiagnostics(sourceFile: ts.SourceFile): readonly ts.DiagnosticWithLocation[];
}

function hasSuggestionDiagnostics(program: ts.Program): program is SuggestionProgram {
  return (
    "getSuggestionDiagnostics" in program && typeof program.getSuggestionDiagnostics === "function"
  );
}

function diagnosticNode(sourceFile: ts.SourceFile, start: number, length: number): ts.Node {
  const end = start + length;
  const find = (node: ts.Node): ts.Node => {
    return (
      ts.forEachChild(node, (child) => {
        if (child.getStart(sourceFile) > start || child.end < end) return undefined;
        return find(child);
      }) ?? node
    );
  };
  return find(sourceFile);
}

function analyzeDeprecatedReferences(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  diagnostics: ArchitectureDiagnostic[],
): void {
  // TS6 exposes editor suggestions on Program at runtime but omits this method from its public types.
  // Reusing it preserves TypeScript's alias and overload handling without creating a second Program.
  if (!hasSuggestionDiagnostics(program)) {
    throw new Error(
      `TypeScript ${ts.version} cannot provide architecture deprecation diagnostics.`,
    );
  }
  for (const diagnostic of program.getSuggestionDiagnostics(sourceFile)) {
    if (!diagnostic.reportsDeprecated) continue;
    const guidance = diagnostic.relatedInformation
      ?.flatMap((related) => {
        if (!related.file || related.start === undefined || related.length === undefined) return [];
        const text = related.file.text.slice(related.start, related.start + related.length);
        if (!text.startsWith("@deprecated")) return [];
        return [
          text
            .replace(/^@deprecated\s*/u, "")
            .replace(/\n\s*\*\s?/gu, "\n")
            .trim(),
        ];
      })
      .filter(Boolean)
      .join(" ");
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-deprecated",
        diagnosticNode(sourceFile, diagnostic.start, diagnostic.length),
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        guidance || "Replace this deprecated API.",
      ),
    );
  }
}

function literalPropertyName(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!expression) return undefined;
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteralLike(unwrapped) || ts.isNumericLiteral(unwrapped)) {
    return unwrapped.text;
  }
  const type = checker.getTypeAtLocation(unwrapped);
  return type.isStringLiteral() || type.isNumberLiteral() ? String(type.value) : undefined;
}

function assignmentPatternSource(
  node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): ts.Expression | undefined {
  let pattern: ts.Expression = node.parent;
  while (ts.isParenthesizedExpression(pattern.parent)) pattern = pattern.parent;
  const assignment = pattern.parent;
  return ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assignment.left === pattern
    ? assignment.right
    : undefined;
}

function sameExpressionSymbol(
  left: ts.Expression,
  right: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const unwrappedLeft = unwrapExpression(left);
  const unwrappedRight = unwrapExpression(right);
  if (unwrappedLeft === unwrappedRight) return true;
  const leftSymbol = checker.getSymbolAtLocation(unwrappedLeft);
  const rightSymbol = checker.getSymbolAtLocation(unwrappedRight);
  return Boolean(leftSymbol && rightSymbol && leftSymbol === rightSymbol);
}

function registeredSentinelThrowUsesResult(
  statement: ts.Statement,
  result: ts.Expression,
  adapter: SqliteTransactionAdapterRegistration,
  checker: ts.TypeChecker,
  workspaceRoot: string,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== statement && ts.isFunctionLike(node))) return;
    if (ts.isThrowStatement(node) && node.expression) {
      let thrown = unwrapExpression(node.expression);
      if (ts.isIdentifier(thrown)) {
        const thrownSymbol = checker.getSymbolAtLocation(thrown);
        const source = thrownSymbol && latestSymbolSource(thrownSymbol, thrown, checker);
        if (source) thrown = unwrapExpression(source);
      }
      if (ts.isNewExpression(thrown)) {
        const sentinelSymbol = checker.getSymbolAtLocation(unwrapExpression(thrown.expression));
        const sentinelDeclaration =
          sentinelSymbol && canonicalSymbol(sentinelSymbol, checker).declarations?.[0];
        const argument = thrown.arguments?.[0];
        if (
          sentinelDeclaration &&
          identityMatches(
            adapter.rollbackSentinel,
            nodeIdentity(sentinelDeclaration, workspaceRoot),
          ) &&
          argument &&
          sameExpressionSymbol(argument, result, checker)
        ) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
}

function enclosingInlineCallbackCall(
  node: ts.Node,
): { readonly callback: ts.FunctionLikeDeclaration; readonly call: ts.CallExpression } | undefined {
  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) return undefined;
    callback = current;
    break;
  }
  if (!callback) return undefined;
  let expression: ts.Expression = callback;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const call = expression.parent;
  return ts.isCallExpression(call) && call.arguments.some((argument) => argument === expression)
    ? { callback, call }
    : undefined;
}

function isRegisteredSqliteRollbackStatusRead(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  result: ts.Expression,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const callbackCall = enclosingInlineCallbackCall(node);
  if (!callbackCall) return false;
  const signature = resolvedSignature(checker, callbackCall.call);
  if (
    packageForSignature(signature, packageRoots) !== "bun:sqlite" ||
    declarationName(signature?.declaration) !== "transaction"
  ) {
    return false;
  }
  const adapter = workspace.sqliteTransactionAdapters.find((candidate) =>
    identityOwns(candidate.identity, nodeIdentity(callbackCall.callback, workspaceRoot)),
  );
  if (!adapter) return false;

  let comparison: ts.Node = node;
  while (
    ts.isParenthesizedExpression(comparison.parent) ||
    ts.isAsExpression(comparison.parent) ||
    ts.isSatisfiesExpression(comparison.parent) ||
    ts.isTypeAssertionExpression(comparison.parent) ||
    ts.isNonNullExpression(comparison.parent)
  ) {
    comparison = comparison.parent;
  }
  const binary = comparison.parent;
  if (
    !ts.isBinaryExpression(binary) ||
    (binary.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      binary.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken)
  ) {
    return false;
  }
  const discriminator = binary.left === comparison ? binary.right : binary.left;
  if (literalPropertyName(discriminator, checker) !== "error") return false;

  let condition: ts.Expression = binary;
  while (ts.isParenthesizedExpression(condition.parent)) condition = condition.parent;
  const branch = condition.parent;
  return (
    ts.isIfStatement(branch) &&
    branch.expression === condition &&
    registeredSentinelThrowUsesResult(branch.thenStatement, result, adapter, checker, workspaceRoot)
  );
}

function betterResultBranchMemberFromExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol> = new Set(),
): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isCallExpression(unwrapped)) {
    const selected = selectedProperty(unwrapped.expression);
    if (selected?.name === "bind") {
      return betterResultBranchMemberFromExpression(
        selected.receiver,
        checker,
        packageRoots,
        seenSymbols,
      );
    }
  }
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (symbol) {
    const canonical = canonicalSymbol(symbol, checker);
    if (seenSymbols.has(canonical)) return undefined;
    seenSymbols.add(canonical);
    const declarations = canonical.declarations ?? [];
    const localDeclarations = declarations.filter(
      (declaration) => declarationPackageName(declaration, packageRoots) !== "better-result",
    );
    if (localDeclarations.length > 0) {
      for (const declaration of localDeclarations) {
        let source: ts.Expression | undefined;
        if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) {
          source = declaration.initializer;
        }
        if (source) {
          const member = betterResultBranchMemberFromExpression(
            source,
            checker,
            packageRoots,
            seenSymbols,
          );
          if (member) return member;
        }
        if (ts.isBindingElement(declaration)) {
          const property = declaration.propertyName ?? declaration.name;
          const member =
            (ts.isIdentifier(property) || ts.isStringLiteral(property)) && property.text;
          const bindingSource = bindingElementSource(declaration, checker);
          const bindingSymbol = bindingSource && checker.getSymbolAtLocation(bindingSource);
          if (
            member &&
            MANUAL_RESULT_BRANCH_MEMBERS.has(member) &&
            bindingSymbol &&
            symbolComesFromPackage(
              canonicalSymbol(bindingSymbol, checker),
              "better-result",
              packageRoots,
            )
          ) {
            return member;
          }
        }
      }
      return undefined;
    }
  }
  for (const signature of checker.getSignaturesOfType(
    checker.getTypeAtLocation(unwrapped),
    ts.SignatureKind.Call,
  )) {
    const member = declarationName(signature.declaration);
    if (
      packageForSignature(signature, packageRoots) === "better-result" &&
      member &&
      MANUAL_RESULT_BRANCH_MEMBERS.has(member)
    ) {
      return member;
    }
  }
  return undefined;
}

function invokedBetterResultBranchMember(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): string | undefined {
  const selected = selectedProperty(node.expression);
  if (selected?.name === "call" || selected?.name === "apply") {
    return betterResultBranchMemberFromExpression(selected.receiver, checker, packageRoots);
  }
  return betterResultBranchMemberFromExpression(node.expression, checker, packageRoots);
}

function directResultCaptureCall(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): ts.CallExpression | undefined {
  let value = unwrapExpression(expression);
  if (ts.isAwaitExpression(value)) value = unwrapExpression(value.expression);
  if (!ts.isCallExpression(value)) return undefined;
  const signature = resolvedSignature(checker, value);
  const member = declarationName(signature?.declaration) ?? expressionName(value.expression);
  return packageForSignature(signature, packageRoots) === "better-result" &&
    member !== undefined &&
    RESULT_CAPTURE_MEMBERS.has(member) &&
    isDirectImmutableResultCaptureCall(value, checker) &&
    resultCaptureCatchMapper(value, checker)
    ? value
    : undefined;
}

function resolvesToDirectLocalResultCapture(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (directResultCaptureCall(expression, checker, packageRoots)) return true;
  const value = unwrapExpression(expression);
  if (!ts.isIdentifier(value)) return false;
  const symbol = checker.getSymbolAtLocation(value);
  if (!symbol || symbolIsMutated(symbol, value.getSourceFile(), checker)) return false;
  const declarations = canonicalSymbol(symbol, checker).declarations?.filter(
    ts.isVariableDeclaration,
  );
  if (declarations?.length !== 1) return false;
  const [declaration] = declarations;
  return Boolean(
    declaration?.initializer &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    directResultCaptureCall(declaration.initializer, checker, packageRoots),
  );
}

function isImmutableLocalResultErrGuard(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (node.arguments.length !== 0) return false;
  const selected = selectedProperty(node.expression);
  if (selected?.name !== "isErr") return false;

  let condition: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(condition.parent) ||
    ts.isAsExpression(condition.parent) ||
    ts.isSatisfiesExpression(condition.parent) ||
    ts.isTypeAssertionExpression(condition.parent) ||
    ts.isNonNullExpression(condition.parent)
  ) {
    condition = condition.parent;
  }
  const branch = condition.parent;
  if (!ts.isIfStatement(branch) || branch.expression !== condition) return false;

  const receiver = unwrapExpression(selected.receiver);
  if (!ts.isIdentifier(receiver)) return false;
  const receiverSymbol = checker.getSymbolAtLocation(receiver);
  if (!receiverSymbol || symbolIsMutated(receiverSymbol, receiver.getSourceFile(), checker)) {
    return false;
  }
  const parameter = canonicalSymbol(receiverSymbol, checker).declarations?.find(ts.isParameter);
  if (parameter) {
    return (
      ts.isIdentifier(parameter.name) &&
      ts.isFunctionLike(parameter.parent) &&
      "body" in parameter.parent &&
      parameter.parent.body === branch.parent
    );
  }
  const declarations = canonicalSymbol(receiverSymbol, checker).declarations?.filter(
    ts.isVariableDeclaration,
  );
  if (declarations?.length !== 1) return false;
  const [declaration] = declarations;
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }

  const variableStatement = declaration.parent.parent;
  if (!ts.isVariableStatement(variableStatement) || variableStatement.parent !== branch.parent) {
    return false;
  }
  const statements =
    ts.isBlock(branch.parent) || ts.isSourceFile(branch.parent)
      ? branch.parent.statements
      : undefined;
  return Boolean(statements && statements.indexOf(variableStatement) < statements.indexOf(branch));
}

function expressionReferencesBetterResultStaticMatch(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (symbol) {
    const canonical = canonicalSymbol(symbol, checker);
    if (seenSymbols.has(canonical)) return false;
    seenSymbols.add(canonical);
    const localDeclarations = (canonical.declarations ?? []).filter(
      (declaration) => declarationPackageName(declaration, packageRoots) !== "better-result",
    );
    if (localDeclarations.length > 0) {
      for (const declaration of localDeclarations) {
        let source: ts.Expression | undefined;
        if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) {
          source = declaration.initializer;
        }
        if (ts.isBindingElement(declaration)) source = bindingElementSource(declaration, checker);
        if (
          source &&
          expressionReferencesBetterResultStaticMatch(
            source,
            checker,
            packageRoots,
            new Set(seenSymbols),
          )
        ) {
          return true;
        }
      }
      return false;
    }
  }

  return checker
    .getSignaturesOfType(checker.getTypeAtLocation(unwrapped), ts.SignatureKind.Call)
    .some(
      (signature) =>
        packageForSignature(signature, packageRoots) === "better-result" &&
        declarationName(signature.declaration) === "match" &&
        Boolean(signature.declaration && ts.isCallSignatureDeclaration(signature.declaration)),
    );
}

function resultMatchHandlersArgument(
  node: ts.CallExpression,
  signature: ts.Signature | undefined,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): ts.Expression | undefined {
  if (
    packageForSignature(signature, packageRoots) !== "better-result" ||
    declarationName(signature?.declaration) !== "match"
  ) {
    return undefined;
  }

  const selected = selectedProperty(node.expression);
  if (
    selected?.name === "match" &&
    isDirectResultType(checker.getTypeAtLocation(selected.receiver), packageRoots)
  ) {
    return node.arguments[0];
  }

  if (
    signature?.declaration &&
    ts.isCallSignatureDeclaration(signature.declaration) &&
    expressionReferencesBetterResultStaticMatch(node.expression, checker, packageRoots)
  ) {
    return node.arguments.length > 1 ? node.arguments[1] : node.arguments[0];
  }
  return undefined;
}

function resultMatchInputExpression(
  node: ts.CallExpression,
  signature: ts.Signature | undefined,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): ts.Expression | undefined {
  const handlers = resultMatchHandlersArgument(node, signature, checker, packageRoots);
  if (!handlers) return undefined;
  if (handlers === node.arguments[0]) return callReceiver(node);
  const input = node.arguments[0];
  return input && !ts.isSpreadElement(input) ? input : undefined;
}

function resolvedPropertyNameText(
  name: ts.PropertyName,
  checker: ts.TypeChecker,
): string | undefined {
  if (ts.isComputedPropertyName(name)) return literalPropertyName(name.expression, checker);
  if (ts.isPrivateIdentifier(name)) return undefined;
  return name.text;
}

function functionLikeFromExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.FunctionLikeDeclaration | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return unwrapped;
  if (!ts.isIdentifier(unwrapped)) return undefined;

  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol) return undefined;
  const canonical = canonicalSymbol(symbol, checker);
  if (seenSymbols.has(canonical)) return undefined;
  seenSymbols.add(canonical);
  for (const declaration of canonical.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
    if (ts.isMethodDeclaration(declaration) && declaration.body) return declaration;
    if (
      (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
      declaration.initializer
    ) {
      const resolved = functionLikeFromExpression(
        declaration.initializer,
        checker,
        new Set(seenSymbols),
      );
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function resultMatchHandler(
  expression: ts.Expression,
  branch: "ok" | "err",
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.FunctionLikeDeclaration | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (!symbol) return undefined;
    const canonical = canonicalSymbol(symbol, checker);
    if (seenSymbols.has(canonical)) return undefined;
    seenSymbols.add(canonical);
    const source = latestSymbolSource(symbol, unwrapped, checker);
    return source ? resultMatchHandler(source, branch, checker, new Set(seenSymbols)) : undefined;
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) return undefined;

  for (const property of [...unwrapped.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) {
      const handler = resultMatchHandler(
        property.expression,
        branch,
        checker,
        new Set(seenSymbols),
      );
      if (handler) return handler;
      continue;
    }
    if (resolvedPropertyNameText(property.name, checker) !== branch) continue;
    if (ts.isMethodDeclaration(property) && property.body) return property;
    if (ts.isPropertyAssignment(property)) {
      return functionLikeFromExpression(property.initializer, checker);
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return functionLikeFromExpression(property.name, checker);
    }
  }
  return undefined;
}

function handlerReturnExpressions(handler: ts.FunctionLikeDeclaration): readonly ts.Expression[] {
  if (!handler.body) return [];
  if (!ts.isBlock(handler.body)) return [handler.body];

  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== handler.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(handler.body);
  return returns;
}

function objectPropertyExpression(
  object: ts.ObjectLiteralExpression,
  name: string,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol>,
): ts.Expression | undefined {
  for (const property of [...object.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) {
      const spread = returnedObjectLiteral(property.expression, checker, new Set(seenSymbols));
      const expression =
        spread && objectPropertyExpression(spread, name, checker, new Set(seenSymbols));
      if (expression) return expression;
      continue;
    }
    if (resolvedPropertyNameText(property.name, checker) !== name) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    return undefined;
  }
  return undefined;
}

function returnedObjectLiteral(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.ObjectLiteralExpression | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
  if (!ts.isIdentifier(unwrapped)) return undefined;

  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol) return undefined;
  const canonical = canonicalSymbol(symbol, checker);
  if (seenSymbols.has(canonical)) return undefined;
  seenSymbols.add(canonical);
  const source = latestSymbolSource(symbol, unwrapped, checker);
  return source ? returnedObjectLiteral(source, checker, seenSymbols) : undefined;
}

function handlerReconstructsBranchEnvelope(
  handler: ts.FunctionLikeDeclaration,
  status: "ok" | "error",
  payload: "value" | "error",
  checker: ts.TypeChecker,
): boolean {
  return handlerReturnExpressions(handler).some((expression) => {
    const object = returnedObjectLiteral(expression, checker);
    if (!object) return false;
    const statusExpression = objectPropertyExpression(object, "status", checker, new Set());
    return (
      literalPropertyName(statusExpression, checker) === status &&
      objectPropertyExpression(object, payload, checker, new Set()) !== undefined
    );
  });
}

function reconstructsResultBranchEnvelopes(
  handlers: ts.Expression | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!handlers) return false;
  const ok = resultMatchHandler(handlers, "ok", checker);
  const err = resultMatchHandler(handlers, "err", checker);
  return Boolean(
    ok &&
    err &&
    handlerReconstructsBranchEnvelope(ok, "ok", "value", checker) &&
    handlerReconstructsBranchEnvelope(err, "error", "error", checker),
  );
}

function handlerReturnsContinuation(
  handler: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const returns = handlerReturnExpressions(handler);
  return (
    returns.length > 0 &&
    returns.every(
      (expression) =>
        checker.getTypeAtLocation(unwrapExpression(expression)).getCallSignatures().length > 0,
    )
  );
}

function selectsResultContinuation(
  handlers: ts.Expression | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!handlers) return false;
  const ok = resultMatchHandler(handlers, "ok", checker);
  const err = resultMatchHandler(handlers, "err", checker);
  return Boolean(
    ok &&
    err &&
    handlerReturnsContinuation(ok, checker) &&
    handlerReturnsContinuation(err, checker),
  );
}

function resultContinuationMatch(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): ts.Expression | undefined {
  const handlers = resultMatchHandlersArgument(
    call,
    resolvedSignature(checker, call),
    checker,
    packageRoots,
  );
  return handlers && selectsResultContinuation(handlers, checker) ? handlers : undefined;
}

/** Result matches that consume `handlers`, either inline or through a named immutable binding. */
function handlerObjectConsumers(
  handlers: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): ts.CallExpression[] {
  const parent = handlers.parent;
  if (ts.isCallExpression(parent)) {
    return resultContinuationMatch(parent, checker, packageRoots) === handlers ? [parent] : [];
  }
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return [];
  const symbol = checker.getSymbolAtLocation(parent.name);
  if (!symbol) return [];
  const target = canonicalSymbol(symbol, checker);
  const consumers: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const argument = resultContinuationMatch(node, checker, packageRoots);
      const value = argument && unwrapExpression(argument);
      const argumentSymbol = value && ts.isIdentifier(value) && checker.getSymbolAtLocation(value);
      if (argumentSymbol && canonicalSymbol(argumentSymbol, checker) === target) {
        consumers.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(handlers.getSourceFile());
  return consumers;
}

function enclosingResultContinuationMatch(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): ts.CallExpression | undefined {
  let child: ts.Node = node;
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      resultContinuationMatch(current, checker, packageRoots) === child
    ) {
      return current;
    }
    if (ts.isObjectLiteralExpression(current) && current.properties.some((p) => p === child)) {
      const consumer = handlerObjectConsumers(current, checker, packageRoots)[0];
      if (consumer) return consumer;
    }
    child = current;
  }
  return undefined;
}

function analyzeRepeatedResultMatches(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const matched = new Set<ts.Symbol>();
  const matchedInput = (node: ts.Node): ts.Identifier | undefined => {
    if (!ts.isCallExpression(node)) return undefined;
    const input = resultMatchInputExpression(
      node,
      resolvedSignature(checker, node),
      checker,
      packageRoots,
    );
    const value = input && unwrapExpression(input);
    if (!value || !ts.isIdentifier(value)) return undefined;
    return isDirectResultType(checker.getTypeAtLocation(value), packageRoots) ? value : undefined;
  };
  const visit = (node: ts.Node): void => {
    const input = matchedInput(node);
    const symbol = input && checker.getSymbolAtLocation(input);
    const canonical = symbol && canonicalSymbol(symbol, checker);
    if (input && canonical && matched.has(canonical)) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/no-repeated-result-match",
          node,
          `better-result ${input.text} is matched more than once.`,
          "Settle the Result once with Result.gen, or with an `if (result.isErr())` guard on the immutable local followed by `result.value`.",
        ),
      );
    }
    if (canonical) matched.add(canonical);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function analyzeManualResultStatusRead(
  node:
    | ts.PropertyAccessExpression
    | ts.ElementAccessExpression
    | ts.BindingElement
    | ts.PropertyAssignment
    | ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  let sourceType: ts.Type;
  let statusSymbol: ts.Symbol | undefined;
  let sourceExpression: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text !== "status") return;
    sourceExpression = node.expression;
    sourceType = checker.getTypeAtLocation(node.expression);
    statusSymbol = checker.getSymbolAtLocation(node.name) ?? sourceType.getProperty("status");
  } else if (ts.isElementAccessExpression(node)) {
    if (literalPropertyName(node.argumentExpression, checker) !== "status") return;
    sourceExpression = node.expression;
    sourceType = checker.getTypeAtLocation(node.expression);
    statusSymbol = sourceType.getProperty("status");
  } else if (ts.isBindingElement(node)) {
    if (!ts.isObjectBindingPattern(node.parent)) return;
    const property = node.propertyName ?? node.name;
    if (
      (!ts.isIdentifier(property) && !ts.isStringLiteral(property)) ||
      property.text !== "status"
    ) {
      return;
    }
    sourceType = checker.getTypeAtLocation(node.parent);
    statusSymbol = sourceType.getProperty("status");
  } else {
    const property = node.name;
    if (
      (!ts.isIdentifier(property) && !ts.isStringLiteral(property)) ||
      property.text !== "status"
    ) {
      return;
    }
    sourceExpression = assignmentPatternSource(node);
    if (!sourceExpression) return;
    sourceType = checker.getTypeAtLocation(sourceExpression);
    statusSymbol = sourceType.getProperty("status");
  }

  if (
    !isDirectResultType(sourceType, packageRoots) ||
    !symbolComesFromPackage(statusSymbol, "better-result", packageRoots)
  ) {
    return;
  }
  if (
    sourceExpression &&
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isRegisteredSqliteRollbackStatusRead(
      node,
      sourceExpression,
      checker,
      workspace,
      workspaceRoot,
      packageRoots,
    )
  ) {
    return;
  }
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-manual-result-branching",
      node,
      "better-result Result status is read directly to discriminate a branch.",
      "Compose with Result.match, Result.gen, map, mapError, andThen, or tryRecover instead.",
    ),
  );
}

function analyzeCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  activeRules: ReadonlySet<ArchitectureRule>,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const signature = resolvedSignature(checker, node);
  const sourcePackage = packageForSignature(signature, packageRoots);
  const member = declarationName(signature?.declaration);
  const manualResultBranchMember = activeRules.has("architecture/no-manual-result-branching")
    ? invokedBetterResultBranchMember(node, checker, packageRoots)
    : undefined;
  const reconstructedResultEnvelopes =
    activeRules.has("architecture/no-manual-result-branching") &&
    reconstructsResultBranchEnvelopes(
      resultMatchHandlersArgument(node, signature, checker, packageRoots),
      checker,
    );

  if (activeRules.has("architecture/no-result-err-in-sqlite-callback")) {
    analyzeSqliteTransactionCallback(
      node,
      signature,
      sourcePackage,
      member,
      checker,
      workspace,
      workspaceRoot,
      packageRoots,
      diagnostics,
    );
  }

  if (
    activeRules.has("architecture/no-unregistered-decoder") &&
    sourcePackage === "zod" &&
    member &&
    ZOD_PARSE_MEMBERS.has(member)
  ) {
    const identity = nodeIdentity(node, workspaceRoot);
    const registered =
      workspace.boundaryDecoders.some((decoder) => identityOwns(decoder.identity, identity)) ||
      workspace.resultDecoders.some((decoder) => identityOwns(decoder.identity, identity));
    if (!registered) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/no-unregistered-decoder",
          node,
          `Zod ${member} is owned by unregistered symbol ${identity.symbolPath}.`,
          "Move validation to a registered boundary decoder, projection, or persistence codec.",
        ),
      );
    }
  }

  if (
    activeRules.has("architecture/no-production-unwrap") &&
    sourcePackage === "better-result" &&
    member &&
    UNSAFE_RESULT_MEMBERS.has(member)
  ) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-production-unwrap",
        node,
        `better-result ${member} performs unsafe Result extraction.`,
        "Compose with Result.match, Result.gen, unwrapOr, or map at the owning policy boundary.",
      ),
    );
  }

  if (
    activeRules.has("architecture/no-manual-result-branching") &&
    manualResultBranchMember &&
    !(manualResultBranchMember === "isErr" && isImmutableLocalResultErrGuard(node, checker))
  ) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-manual-result-branching",
        node,
        `better-result ${manualResultBranchMember} manually discriminates a Result branch.`,
        "Compose with Result.match, Result.gen, map, mapError, andThen, or tryRecover instead.",
      ),
    );
  }

  if (
    activeRules.has("architecture/no-nested-result-continuation") &&
    selectsResultContinuation(
      resultMatchHandlersArgument(node, signature, checker, packageRoots),
      checker,
    ) &&
    enclosingResultContinuationMatch(node, checker, packageRoots)
  ) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-nested-result-continuation",
        node,
        "better-result match selects a continuation inside another match continuation.",
        "Settle the outer Result first with Result.gen or an `if (result.isErr())` guard, then continue at the function's base indentation.",
      ),
    );
  }

  if (reconstructedResultEnvelopes) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-manual-result-branching",
        node,
        "better-result match reconstructs both Result branch envelopes.",
        "Return a domain projection, or use Result.codec when a serialized Result envelope is required.",
      ),
    );
  }

  if (
    activeRules.has("architecture/no-unmapped-result-capture") &&
    sourcePackage === "better-result" &&
    member &&
    RESULT_CAPTURE_MEMBERS.has(member)
  ) {
    analyzeMappedResultCapture(
      node,
      member,
      checker,
      workspace,
      workspaceRoot,
      packageRoots,
      diagnostics,
    );
    if (
      typeContainsUnhandledException(checker.getTypeAtLocation(node), checker, packageRoots, node)
    ) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/no-unmapped-result-capture",
          node,
          `Result.${member} exposes UnhandledException.`,
          "Use the object overload and map the caught cause to a specific domain-owned error.",
        ),
      );
    }
  }

  if (
    activeRules.has("architecture/registered-panic-site") &&
    sourcePackage === "better-result" &&
    member === "panic"
  ) {
    const finding = makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/registered-panic-site",
      node,
      "Panic callsite is not registered as a hard invariant.",
      "Register this exact fingerprint with an invariant reason, or return a typed expected error.",
    );
    if (!workspace.panicSites.some((site) => site.fingerprint === finding.fingerprint)) {
      diagnostics.push(finding);
    }
  }

  if (activeRules.has("architecture/no-result-wire-leak")) {
    const intrinsicStringify =
      member === "stringify" && isDefaultLibraryDeclaration(signature?.declaration);
    const serialized = node.arguments[0];
    if (
      intrinsicStringify &&
      serialized &&
      typeContainsResult(checker.getTypeAtLocation(serialized), checker, packageRoots, serialized)
    ) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/no-result-wire-leak",
          serialized,
          "JSON.stringify would serialize a Result object instead of an existing wire representation.",
          "Use Result.match to serialize an explicit compatibility payload.",
        ),
      );
    }
    const output = workspace.compatibilityOutputs.find((candidate) =>
      outputIdentityMatches(candidate.sink, signature, workspaceRoot, packageRoots),
    );
    if (output) {
      for (const argument of node.arguments) {
        if (
          !typeContainsBetterResult(
            checker.getTypeAtLocation(argument),
            checker,
            packageRoots,
            argument,
          )
        )
          continue;
        diagnostics.push(
          makeDiagnostic(
            workspace,
            workspaceRoot,
            "architecture/no-result-wire-leak",
            argument,
            `better-result value is passed directly to registered ${output.category} output ${output.sink.exportName}.`,
            "Map Result or TaggedError to the existing wire representation before crossing this boundary.",
          ),
        );
      }
    }
  }

  if (activeRules.has("architecture/no-unredacted-tagged-error-log")) {
    const receiver = callReceiver(node);
    const intrinsicStringify =
      member === "stringify" && isDefaultLibraryDeclaration(signature?.declaration);
    if (intrinsicStringify) {
      const value = node.arguments[0];
      if (
        value &&
        expressionContainsUnformattedTaggedError(
          value,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
        )
      ) {
        diagnostics.push(
          makeDiagnostic(
            workspace,
            workspaceRoot,
            "architecture/no-unredacted-tagged-error-log",
            value,
            "JSON.stringify receives data manually derived from a TaggedError and may expose its cause or message.",
            "Pass the redacting formatter formatTaggedErrorForLog(error) output to JSON.stringify instead.",
          ),
        );
      }
    } else if (
      member === "toJSON" &&
      receiver &&
      typeContainsTaggedError(checker.getTypeAtLocation(receiver), checker, packageRoots, receiver)
    ) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/no-unredacted-tagged-error-log",
          node,
          "Direct TaggedError.toJSON() exposes the external cause.",
          "Use the approved redacting TaggedError formatter and log only its safe fields.",
        ),
      );
    }

    const logger = workspace.structuredLoggers.find((candidate) =>
      outputIdentityMatches(candidate.sink, signature, workspaceRoot, packageRoots),
    );
    if (logger) {
      for (const argument of node.arguments) {
        if (
          !expressionContainsUnformattedTaggedError(
            argument,
            checker,
            workspace,
            workspaceRoot,
            packageRoots,
          )
        ) {
          continue;
        }
        diagnostics.push(
          makeDiagnostic(
            workspace,
            workspaceRoot,
            "architecture/no-unredacted-tagged-error-log",
            argument,
            `TaggedError is passed directly to structured logger ${logger.sink.exportName}.`,
            "Pass the redacting formatter formatTaggedErrorForLog(error) output and omit manual TaggedError fields.",
          ),
        );
      }
    }
  }
}

function canonicalSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function exportedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlySet<ts.Symbol> {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return new Set();
  return new Set(
    checker.getExportsOfModule(moduleSymbol).map((symbol) => canonicalSymbol(symbol, checker)),
  );
}

function contractOwnerSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent)
  ) {
    return checker.getSymbolAtLocation(node.parent.name);
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node)
  ) {
    const owner = node.parent;
    if (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) {
      return owner.name && checker.getSymbolAtLocation(owner.name);
    }
  }
  if (ts.isFunctionTypeNode(node)) {
    let owner: ts.Node | undefined = node.parent;
    while (owner && !ts.isTypeAliasDeclaration(owner)) owner = owner.parent;
    if (owner && ts.isTypeAliasDeclaration(owner)) return checker.getSymbolAtLocation(owner.name);
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)) &&
    node.name
  ) {
    return checker.getSymbolAtLocation(node.name);
  }
  return undefined;
}

function isExportedContract(
  node: ts.Node,
  checker: ts.TypeChecker,
  exports: ReadonlySet<ts.Symbol>,
): boolean {
  const symbol = contractOwnerSymbol(node, checker);
  return Boolean(symbol && exports.has(canonicalSymbol(symbol, checker)));
}

function analyzeResultContract(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  activeRules: ReadonlySet<ArchitectureRule>,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
  exports: ReadonlySet<ts.Symbol>,
): void {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return;
  const returnType = checker.getReturnTypeOfSignature(signature);
  const identity = nodeIdentity(node, workspaceRoot);
  const key = `${identity.module}#${identity.symbolPath}`;

  if (
    activeRules.has("architecture/no-unhandled-exception-contract") &&
    (isExportedContract(node, checker, exports) ||
      workspace.operationalResultApis.some((api) => identityMatches(api, identity))) &&
    typeContainsUnhandledException(returnType, checker, packageRoots, node) &&
    !reported.has(`unhandled:${key}`)
  ) {
    reported.add(`unhandled:${key}`);
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-unhandled-exception-contract",
        node,
        `API ${identity.symbolPath} exposes better-result UnhandledException in its return contract.`,
        "Use mapped Result.try/Result.tryPromise capture and return a specific domain-owned error.",
      ),
    );
  }

  const expectedError = resultExpectedErrorType(returnType, checker, packageRoots, node);
  if (
    activeRules.has("architecture/no-unhandled-exception-contract") &&
    (isExportedContract(node, checker, exports) ||
      workspace.operationalResultApis.some((api) => identityMatches(api, identity))) &&
    expectedError &&
    ((expectedError.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
      typeContainsPanic(expectedError, checker, packageRoots, node)) &&
    !reported.has(`invalid-error:${key}`)
  ) {
    reported.add(`invalid-error:${key}`);
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/no-unhandled-exception-contract",
        node,
        `API ${identity.symbolPath} exposes Panic or unknown as an expected Result error.`,
        "Return a closed domain-owned expected error union and keep Panic or unknown defects on the defect channel.",
      ),
    );
  }

  if (
    activeRules.has("architecture/fallible-api-result") &&
    workspace.operationalResultApis.some((api) => identityMatches(api, identity)) &&
    !ts.isFunctionTypeNode(node) &&
    !isFallibleResultContract(returnType, checker, packageRoots) &&
    !reported.has(`fallible:${key}`)
  ) {
    reported.add(`fallible:${key}`);
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/fallible-api-result",
        node,
        `Registered fallible API ${identity.symbolPath} does not return Result, Promise<Result>, or AsyncIterable<Result>.`,
        "Return a typed Result value; asynchronous APIs should resolve Promise<Result<T, E>> rather than reject.",
      ),
    );
  }
}

function analyzeDeclaredResultContract(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  if (
    ts.isTypeAliasDeclaration(node) &&
    (ts.isFunctionTypeNode(node.type) ||
      (ts.isTypeLiteralNode(node.type) &&
        node.type.members.some((member) => ts.isCallSignatureDeclaration(member))))
  ) {
    return;
  }
  const type = checker.getTypeAtLocation(node.name);
  if (!typeContainsUnhandledException(type, checker, packageRoots, node)) return;
  const identity = nodeIdentity(node, workspaceRoot);
  const key = `unhandled:${identity.module}#${identity.symbolPath}`;
  if (reported.has(key)) return;
  reported.add(key);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-unhandled-exception-contract",
      node,
      `Declared contract ${identity.symbolPath} exposes better-result UnhandledException.`,
      "Replace it with a specific domain-owned error type produced by mapped external capture.",
    ),
  );
}

function analyzeParameter(
  node: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  if (!isUnknown(checker.getTypeAtLocation(node))) return;
  const identity = nodeIdentity(node, workspaceRoot);
  const signalHostParameter = workspace.exceptionAdapters.some(
    (adapter) => adapter.direction === "signal-host" && identityMatches(adapter.identity, identity),
  );
  if (
    !signalHostParameter &&
    (intrinsicResultCatchParameter(node, checker, packageRoots) ||
      intrinsicResultCaptureMatchParameter(node, checker, packageRoots) ||
      intrinsicResultClassifierParameter(node, checker))
  ) {
    return;
  }
  if (workspace.boundaryDecoders.some((decoder) => identityOwns(decoder.identity, identity)))
    return;
  if (
    workspace.capabilityPredicates.some((predicate) =>
      identityMatches(predicate.identity, identity),
    )
  )
    return;
  if (
    workspace.exceptionAdapters.some(
      (adapter) =>
        adapter.direction === "observe-panic" && identityMatches(adapter.identity, identity),
    )
  ) {
    return;
  }
  const contractIdentity = parameterContractIdentity(node, workspaceRoot);
  if (
    workspace.opaqueUnknown.some(
      (exception) =>
        identityMatches(exception.identity, identity) ||
        (contractIdentity !== undefined && identityMatches(exception.identity, contractIdentity)),
    )
  )
    return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-domain-unknown",
      node,
      `Internal parameter ${node.name.getText()} carries domain data as unknown.`,
      "Decode at the external boundary and type this internal parameter with the decoded domain type.",
    ),
  );
}

function registeredUnknownInterpreterOwns(
  workspace: WorkspaceArchitecture,
  identity: NodeIdentity,
): boolean {
  return (
    workspace.boundaryDecoders.some((decoder) => identityOwns(decoder.identity, identity)) ||
    workspace.resultDecoders.some((decoder) => identityOwns(decoder.identity, identity)) ||
    workspace.persistedCodecs.some((codec) => identityOwns(codec.identity, identity)) ||
    workspace.openProtocolAdapters.some((adapter) => identityOwns(adapter.identity, identity)) ||
    workspace.capabilityPredicates.some((predicate) =>
      identityOwns(predicate.identity, identity),
    ) ||
    workspace.opaqueUnknown.some((exception) => identityOwns(exception.identity, identity)) ||
    workspace.exceptionAdapters.some(
      (adapter) =>
        adapter.direction === "observe-panic" && identityOwns(adapter.identity, identity),
    )
  );
}

function typeDirectlyContainsUnknown(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
): boolean {
  if (isUnknown(type)) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => typeDirectlyContainsUnknown(member, checker, location));
  }
  for (const kind of [ts.IndexKind.String, ts.IndexKind.Number]) {
    const indexed = checker.getIndexTypeOfType(type, kind);
    if (indexed && isUnknown(indexed)) return true;
  }
  return checker
    .getPropertiesOfType(type)
    .some((property) =>
      isUnknown(
        checker.getTypeOfSymbolAtLocation(
          property,
          property.valueDeclaration ?? property.declarations?.[0] ?? location,
        ),
      ),
    );
}

function analyzeUnknownMemberRead(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.BindingElement,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  if (!isUnknown(checker.getTypeAtLocation(node))) return;
  const identity = nodeIdentity(node, workspaceRoot);
  if (registeredUnknownInterpreterOwns(workspace, identity)) return;
  if (ts.isBindingElement(node)) {
    for (let owner: ts.Node | undefined = node.parent; owner; owner = owner.parent) {
      if (!ts.isParameter(owner)) continue;
      if (
        intrinsicResultCatchParameter(owner, checker, packageRoots) ||
        intrinsicResultCaptureMatchParameter(owner, checker, packageRoots) ||
        intrinsicResultClassifierParameter(owner, checker)
      ) {
        return;
      }
      break;
    }
  }
  if (
    !ts.isBindingElement(node) &&
    (intrinsicResultCaptureOwnsUnknown(node.expression, checker, packageRoots) ||
      intrinsicResultBoundaryOwnsUnknown(node.expression, checker, packageRoots))
  ) {
    return;
  }
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-unknown-member-read",
      node,
      `Member ${node.getText()} in ${identity.symbolPath} is read as unknown outside a registered boundary interpreter.`,
      "Move the read into an exact registered decoder, capability check, or external exception adapter and return a closed typed projection.",
    ),
  );
}

function declarationOwnerName(declaration: ts.Declaration | undefined): string | undefined {
  let current = declaration?.parent;
  while (current) {
    if (
      (ts.isInterfaceDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isModuleDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText().replaceAll(/["']/gu, "");
    }
    current = current.parent;
  }
  return undefined;
}

function expressionIsIntrinsicCoercer(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const signatures = checker.getTypeAtLocation(expression).getCallSignatures();
  return signatures.some((signature) => {
    const declaration = signature.declaration;
    return (
      isDefaultLibraryDeclaration(declaration) &&
      ["BooleanConstructor", "NumberConstructor", "StringConstructor"].includes(
        declarationOwnerName(declaration) ?? "",
      )
    );
  });
}

type UnknownExtractionIntrinsic = "collection" | "coercer" | "reflection";

interface ResolvedUnknownExtractionIntrinsic {
  readonly kind: UnknownExtractionIntrinsic;
  readonly boundSource?: ts.Expression;
}

function intrinsicFromCallSignatures(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): UnknownExtractionIntrinsic | undefined {
  for (const signature of checker.getTypeAtLocation(expression).getCallSignatures()) {
    const declaration = signature.declaration;
    if (!isDefaultLibraryDeclaration(declaration)) continue;
    const owner = declarationOwnerName(declaration);
    const name = declaration && "name" in declaration ? declaration.name : undefined;
    const callableName = name && ts.isIdentifier(name) ? name.text : undefined;
    if (owner === "ObjectConstructor" && ["entries", "values"].includes(callableName ?? "")) {
      return "collection";
    }
    if (owner === "Reflect" && ["get", "has"].includes(callableName ?? "")) {
      return "reflection";
    }
    if (["BooleanConstructor", "NumberConstructor", "StringConstructor"].includes(owner ?? "")) {
      return "coercer";
    }
  }
  return undefined;
}

function variableInitializer(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
}

function applyArgument(
  expression: ts.Expression,
  index: number,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
): ts.Expression | undefined {
  const unwrapped = unwrapExpression(expression);
  if (seen.has(unwrapped)) return undefined;
  seen.add(unwrapped);
  if (ts.isArrayLiteralExpression(unwrapped)) {
    const element = unwrapped.elements[index];
    return element && !ts.isSpreadElement(element) ? element : undefined;
  }
  const initializer = variableInitializer(unwrapped, checker);
  return initializer ? applyArgument(initializer, index, checker, seen) : undefined;
}

function resolveUnknownExtractionIntrinsic(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set(),
): ResolvedUnknownExtractionIntrinsic | undefined {
  const unwrapped = unwrapExpression(expression);
  if (seen.has(unwrapped)) return undefined;
  seen.add(unwrapped);
  const direct = intrinsicFromCallSignatures(unwrapped, checker);
  if (direct) return { kind: direct };
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    unwrapped.expression.name.text === "bind"
  ) {
    const intrinsic = resolveUnknownExtractionIntrinsic(
      unwrapped.expression.expression,
      checker,
      seen,
    );
    if (!intrinsic) return undefined;
    const boundSource = unwrapped.arguments[1];
    return {
      kind: intrinsic.kind,
      ...(boundSource && !ts.isSpreadElement(boundSource) ? { boundSource } : {}),
    };
  }
  const initializer = variableInitializer(unwrapped, checker);
  return initializer ? resolveUnknownExtractionIntrinsic(initializer, checker, seen) : undefined;
}

function intrinsicUnknownExtractionArgument(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const expression = unwrapExpression(node.expression);
  if (
    ts.isPropertyAccessExpression(expression) &&
    (expression.name.text === "call" || expression.name.text === "apply")
  ) {
    const intrinsic = resolveUnknownExtractionIntrinsic(expression.expression, checker);
    if (!intrinsic) return undefined;
    if (expression.name.text === "call") {
      const argument = node.arguments[1];
      return argument && !ts.isSpreadElement(argument) ? argument : undefined;
    }
    const argumentsList = node.arguments[1];
    return argumentsList && !ts.isSpreadElement(argumentsList)
      ? applyArgument(argumentsList, 0, checker, new Set())
      : undefined;
  }
  const intrinsic = resolveUnknownExtractionIntrinsic(expression, checker);
  if (intrinsic?.boundSource) return intrinsic.boundSource;
  const argument = node.arguments[0];
  if (intrinsic && argument && !ts.isSpreadElement(argument)) return argument;
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "map" &&
    argument &&
    expressionIsIntrinsicCoercer(argument, checker)
  ) {
    return expression.expression;
  }
  return undefined;
}

function expressionHasUnknownProvenance(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (seen.has(unwrapped)) return false;
  seen.add(unwrapped);
  if (typeDirectlyContainsUnknown(checker.getTypeAtLocation(unwrapped), checker, unwrapped)) {
    return true;
  }
  if ((checker.getTypeAtLocation(unwrapped).flags & ts.TypeFlags.Any) === 0) return false;
  if (ts.isCallExpression(unwrapped)) {
    const source = intrinsicUnknownExtractionArgument(unwrapped, checker);
    if (source && expressionHasUnknownProvenance(source, checker, seen)) return true;
  }
  const initializer = variableInitializer(unwrapped, checker);
  return initializer ? expressionHasUnknownProvenance(initializer, checker, seen) : false;
}

function unknownExtractionSource(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  if (ts.isForOfStatement(node)) {
    return ts.isCallExpression(node.expression) &&
      intrinsicUnknownExtractionArgument(node.expression, checker)
      ? undefined
      : node.expression;
  }
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return node.expression;
  if (ts.isCallExpression(node)) return intrinsicUnknownExtractionArgument(node, checker);
  return undefined;
}

function analyzeUnknownExtraction(
  node: ts.ForOfStatement | ts.SpreadElement | ts.SpreadAssignment | ts.CallExpression,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const source = unknownExtractionSource(node, checker);
  if (!source || !expressionHasUnknownProvenance(source, checker)) {
    return;
  }
  const identity = nodeIdentity(node, workspaceRoot);
  if (registeredUnknownInterpreterOwns(workspace, identity)) return;
  if (
    intrinsicResultCaptureOwnsUnknown(source, checker, packageRoots) ||
    intrinsicResultBoundaryOwnsUnknown(source, checker, packageRoots)
  ) {
    return;
  }
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-unknown-member-read",
      node,
      `Operation ${node.getText()} in ${identity.symbolPath} extracts values from an unknown-bearing collection outside a registered boundary interpreter.`,
      "Move iteration, reflective access, coercion, or manual assembly into an exact registered decoder and return a closed typed projection.",
    ),
  );
}

function functionInterpretsUnknown(
  node: ts.SignatureDeclaration,
  body: ts.ConciseBody,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (current !== node && ts.isFunctionLike(current)) return;
    if (
      (ts.isForOfStatement(current) ||
        ts.isSpreadElement(current) ||
        ts.isSpreadAssignment(current) ||
        ts.isCallExpression(current)) &&
      unknownExtractionSource(current, checker)
    ) {
      const source = unknownExtractionSource(current, checker);
      if (source && expressionHasUnknownProvenance(source, checker)) {
        found = true;
        return;
      }
    }
    if (
      ts.isTypeOfExpression(current) &&
      isUnknown(checker.getTypeAtLocation(current.expression))
    ) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      isUnknown(checker.getTypeAtLocation(current.left))
    ) {
      found = true;
      return;
    }
    if (
      (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
      isUnknown(checker.getTypeAtLocation(current))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(body);
  return found;
}

function analyzeCustomDecoder(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isConstructorDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isArrowFunction(node)
  ) {
    return;
  }
  if (!node.body) return;
  const identity = nodeIdentity(node, workspaceRoot);
  const callableName = identity.symbolPath.split(".").at(-1) ?? identity.symbolPath;
  const decoderName = /^(?:decode|normalize|parse|project|read[A-Z])/u.test(callableName);
  if (
    !node.parameters.some((parameter) =>
      typeDirectlyContainsUnknown(checker.getTypeAtLocation(parameter), checker, parameter),
    )
  ) {
    return;
  }
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return;
  const returnType = checker.getReturnTypeOfSignature(signature);
  if (!isStructured(returnType) || typeContainsUnknown(returnType, checker, node)) return;
  if (!decoderName && !functionInterpretsUnknown(node, node.body, checker)) return;
  if (registeredUnknownInterpreterOwns(workspace, identity)) return;
  const key = `${identity.module}#${identity.symbolPath}`;
  if (reported.has(key)) return;
  reported.add(key);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-unregistered-custom-decoder",
      node,
      `Custom decoder ${identity.symbolPath} converts an unknown-bearing input to a structured output without registered boundary provenance.`,
      "Register the exact decoder at its trust boundary or type the input if decoding already happened upstream.",
    ),
  );
}

function analyzeAssertion(
  node: ts.AsExpression | ts.TypeAssertion,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  diagnostics: ArchitectureDiagnostic[],
): void {
  if (!isUnknown(checker.getTypeAtLocation(node.expression))) return;
  if (!isStructured(checker.getTypeFromTypeNode(node.type))) return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-unknown-assertion",
      node,
      "Structured domain type is asserted directly from unknown.",
      "Use a registered complete decoder and pass its typed output to domain code.",
    ),
  );
}

function analyzePredicate(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  if (!node.type || !ts.isTypePredicateNode(node.type)) return;
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return;
  const predicate = checker.getTypePredicateOfSignature(signature);
  if (!predicate?.type || predicate.parameterIndex === undefined) return;
  const parameter = node.parameters[predicate.parameterIndex];
  if (
    !parameter ||
    !isUnknown(checker.getTypeAtLocation(parameter)) ||
    !isStructured(predicate.type)
  )
    return;

  const identity = nodeIdentity(node, workspaceRoot);
  if (
    workspace.capabilityPredicates.some((exception) =>
      identityMatches(exception.identity, identity),
    )
  )
    return;
  const key = `${identity.module}#${identity.symbolPath}`;
  if (reported.has(key)) return;
  reported.add(key);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/no-rich-unknown-predicate",
      node,
      `Predicate ${identity.symbolPath} promises a structured type from unknown.`,
      "Replace it with a complete boundary schema decoder or register a narrow exact capability check.",
    ),
  );
}

interface LiteralDomain {
  readonly keys: ReadonlyMap<string, string>;
}

function isProjectDeclaration(
  declaration: ts.Node,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const sourceFile = declaration.getSourceFile();
  if (sourceFile.isDeclarationFile) return false;
  const file = canonicalPath(sourceFile.fileName);
  return packageRoots.some((candidate) => {
    const root = canonicalPath(candidate.root);
    return file === root || file.startsWith(`${root}/`);
  });
}

function typeNodeIsProjectOwned(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol>,
): boolean {
  if (ts.isLiteralTypeNode(node) || ts.isTypeLiteralNode(node)) return true;
  if (ts.isParenthesizedTypeNode(node)) {
    return typeNodeIsProjectOwned(node.type, checker, packageRoots, seenSymbols);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.every((member) =>
      typeNodeIsProjectOwned(member, checker, packageRoots, seenSymbols),
    );
  }
  if (ts.isTypeReferenceNode(node)) {
    const referenced = checker.getSymbolAtLocation(node.typeName);
    if (!referenced) return false;
    const symbol = canonicalSymbol(referenced, checker);
    if (seenSymbols.has(symbol)) return true;
    seenSymbols.add(symbol);
    const declarations = symbol.declarations ?? [];
    if (
      declarations.length === 0 ||
      declarations.some((declaration) => !isProjectDeclaration(declaration, packageRoots))
    ) {
      return false;
    }
    return declarations.every((declaration) => {
      if (ts.isTypeAliasDeclaration(declaration)) {
        return typeNodeIsProjectOwned(declaration.type, checker, packageRoots, seenSymbols);
      }
      if (ts.isTypeParameterDeclaration(declaration)) {
        return Boolean(
          declaration.constraint &&
          typeNodeIsProjectOwned(declaration.constraint, checker, packageRoots, seenSymbols),
        );
      }
      return true;
    });
  }
  return false;
}

function typeIsProjectOwned(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenTypes: Set<ts.Type> = new Set(),
): boolean {
  if (seenTypes.has(type)) return true;
  seenTypes.add(type);
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const declarations = type.getSymbol()?.declarations ?? [];
    if (
      declarations.some((declaration) => {
        if (!ts.isTypeParameterDeclaration(declaration) || !declaration.constraint) return false;
        return (
          isProjectDeclaration(declaration, packageRoots) &&
          typeNodeIsProjectOwned(declaration.constraint, checker, packageRoots, new Set())
        );
      })
    ) {
      return true;
    }
    const constraint = checker.getBaseConstraintOfType(type);
    return Boolean(constraint && typeIsProjectOwned(constraint, checker, packageRoots, seenTypes));
  }
  const alias = type.aliasSymbol;
  if (alias) {
    const declarations = alias.declarations ?? [];
    return (
      declarations.length > 0 &&
      declarations.every(
        (declaration) =>
          isProjectDeclaration(declaration, packageRoots) &&
          (!ts.isTypeAliasDeclaration(declaration) ||
            typeNodeIsProjectOwned(declaration.type, checker, packageRoots, new Set([alias]))),
      )
    );
  }
  if (type.isUnionOrIntersection()) {
    return type.types.every((member) =>
      typeIsProjectOwned(member, checker, packageRoots, seenTypes),
    );
  }
  const symbol = type.getSymbol();
  const declarations = symbol?.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => isProjectDeclaration(declaration, packageRoots))
  );
}

function literalKey(type: ts.Type, checker: ts.TypeChecker): readonly [string, string] | undefined {
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    const value = (type as ts.StringLiteralType).value;
    return [`string:${value}`, JSON.stringify(value)];
  }
  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    const value = (type as ts.NumberLiteralType).value;
    return [`number:${value}`, String(value)];
  }
  if ((type.flags & ts.TypeFlags.EnumLiteral) !== 0) {
    const value = checker.typeToString(type);
    return [`enum:${value}`, value];
  }
  return undefined;
}

function literalDomain(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  ownershipType: ts.Type = type,
  ownershipConfirmed = false,
): LiteralDomain | undefined {
  let resolved = type;
  if ((resolved.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(resolved);
    if (!constraint) return undefined;
    resolved = constraint;
  }
  const members = resolved.isUnion() ? resolved.types : [resolved];
  if (
    members.length < 2 ||
    (!ownershipConfirmed && !typeIsProjectOwned(ownershipType, checker, packageRoots))
  ) {
    return undefined;
  }
  const keys = new Map<string, string>();
  for (const member of members) {
    const key = literalKey(member, checker);
    if (!key) return undefined;
    keys.set(key[0], key[1]);
  }
  return keys.size < 2 ? undefined : { keys };
}

function declaredTypeNode(node: ts.Declaration): ts.TypeNode | undefined {
  if (
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node)
  ) {
    return node.type;
  }
  return undefined;
}

function expressionTypeIsProjectOwned(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const type = checker.getTypeAtLocation(expression);
  if (typeIsProjectOwned(type, checker, packageRoots)) return true;
  if (ts.isCallExpression(expression)) {
    return expressionInfersLiteralUnion(expression, checker, packageRoots, new Set());
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const property = checker.getSymbolAtLocation(expression.name);
    const declarations = property?.declarations ?? [];
    const declaredOwned =
      declarations.length > 0 &&
      declarations.every((declaration) => {
        const typeNode = declaredTypeNode(declaration);
        return Boolean(
          typeNode &&
          isProjectDeclaration(declaration, packageRoots) &&
          typeNodeIsProjectOwned(typeNode, checker, packageRoots, new Set()),
        );
      });
    return (
      declaredOwned ||
      expressionInfersObjectDiscriminant(
        expression.expression,
        expression.name.text,
        checker,
        packageRoots,
        new Set(),
      )
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (!argument || !ts.isStringLiteralLike(argument)) return false;
    const property = checker.getTypeAtLocation(expression.expression).getProperty(argument.text);
    const declarations = property?.declarations ?? [];
    const declaredOwned =
      declarations.length > 0 &&
      declarations.every((declaration) => {
        const typeNode = declaredTypeNode(declaration);
        return Boolean(
          typeNode &&
          isProjectDeclaration(declaration, packageRoots) &&
          typeNodeIsProjectOwned(typeNode, checker, packageRoots, new Set()),
        );
      });
    return (
      declaredOwned ||
      expressionInfersObjectDiscriminant(
        expression.expression,
        argument.text,
        checker,
        packageRoots,
        new Set(),
      )
    );
  }
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  return (
    symbol?.declarations?.some((declaration) => {
      const typeNode = declaredTypeNode(declaration);
      if (
        typeNode &&
        isProjectDeclaration(declaration, packageRoots) &&
        typeNodeIsProjectOwned(typeNode, checker, packageRoots, new Set())
      ) {
        return true;
      }
      return (
        ts.isVariableDeclaration(declaration) &&
        Boolean(declaration.initializer) &&
        isProjectDeclaration(declaration, packageRoots) &&
        expressionInfersLiteralUnion(
          declaration.initializer as ts.Expression,
          checker,
          packageRoots,
          new Set(),
        )
      );
    }) ?? false
  );
}

function expressionInfersLiteralUnion(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteralLike(unwrapped) || ts.isNumericLiteral(unwrapped)) return true;
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      expressionInfersLiteralUnion(
        unwrapped.whenTrue,
        checker,
        packageRoots,
        new Set(seenSymbols),
      ) &&
      expressionInfersLiteralUnion(unwrapped.whenFalse, checker, packageRoots, new Set(seenSymbols))
    );
  }
  if (ts.isCallExpression(unwrapped)) {
    const declaration = resolvedSignature(checker, unwrapped)?.declaration;
    return Boolean(
      declaration &&
      isProjectDeclaration(declaration, packageRoots) &&
      functionReturnExpressions(declaration).every((returned) =>
        expressionInfersLiteralUnion(returned, checker, packageRoots, new Set(seenSymbols)),
      ) &&
      functionReturnExpressions(declaration).length > 0,
    );
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = ts.isShorthandPropertyAssignment(unwrapped.parent)
    ? checker.getShorthandAssignmentValueSymbol(unwrapped.parent)
    : checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        Boolean(declaration.initializer) &&
        expressionInfersLiteralUnion(
          declaration.initializer as ts.Expression,
          checker,
          packageRoots,
          new Set(seenSymbols),
        ),
    ) ?? false
  );
}

function functionReturnExpressions(
  node: ts.SignatureDeclaration | ts.JSDocSignature,
): readonly ts.Expression[] {
  const body =
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
      ? node.body
      : undefined;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const returned: ts.Expression[] = [];
  const visit = (child: ts.Node): void => {
    if (child !== body && ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) && child.expression) {
      returned.push(child.expression);
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(body);
  return returned;
}

function expressionInfersObjectDiscriminant(
  expression: ts.Expression,
  propertyName: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const property = unwrapped.properties.find(
      (candidate) =>
        (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
        (ts.isIdentifier(candidate.name) || ts.isStringLiteralLike(candidate.name)) &&
        candidate.name.text === propertyName,
    );
    let initializer: ts.Expression | undefined;
    if (property && ts.isPropertyAssignment(property)) initializer = property.initializer;
    if (property && ts.isShorthandPropertyAssignment(property)) initializer = property.name;
    return Boolean(
      initializer &&
      expressionInfersLiteralUnion(initializer, checker, packageRoots, new Set(seenSymbols)),
    );
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      expressionInfersObjectDiscriminant(
        unwrapped.whenTrue,
        propertyName,
        checker,
        packageRoots,
        new Set(seenSymbols),
      ) &&
      expressionInfersObjectDiscriminant(
        unwrapped.whenFalse,
        propertyName,
        checker,
        packageRoots,
        new Set(seenSymbols),
      )
    );
  }
  if (ts.isCallExpression(unwrapped)) {
    const declaration = resolvedSignature(checker, unwrapped)?.declaration;
    if (!declaration || !isProjectDeclaration(declaration, packageRoots)) return false;
    const returned = functionReturnExpressions(declaration);
    return (
      returned.length > 0 &&
      returned.every((value) =>
        expressionInfersObjectDiscriminant(
          value,
          propertyName,
          checker,
          packageRoots,
          new Set(seenSymbols),
        ),
      )
    );
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        Boolean(declaration.initializer) &&
        expressionInfersObjectDiscriminant(
          declaration.initializer as ts.Expression,
          propertyName,
          checker,
          packageRoots,
          new Set(seenSymbols),
        ),
    ) ?? false
  );
}

function switchDomain(
  node: ts.SwitchStatement,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): LiteralDomain | undefined {
  const direct = literalDomain(
    checker.getTypeAtLocation(node.expression),
    checker,
    packageRoots,
    checker.getTypeAtLocation(node.expression),
    expressionTypeIsProjectOwned(node.expression, checker, packageRoots),
  );
  if (direct) return direct;
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  return symbol && canonicalSymbol(symbol, checker);
}

function switchSourceExpressions(expression: ts.Expression): readonly ts.Expression[] {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return [unwrapped, unwrapExpression(unwrapped.expression)];
  }
  return [unwrapped];
}

function selectedProperty(
  expression: ts.Expression,
): { readonly receiver: ts.Expression; readonly name: string } | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return { receiver: unwrapped.expression, name: unwrapped.name.text };
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    ts.isStringLiteralLike(unwrapped.argumentExpression)
  ) {
    return { receiver: unwrapped.expression, name: unwrapped.argumentExpression.text };
  }
  return undefined;
}

function expressionDerivesFromSwitch(
  expression: ts.Expression,
  switched: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  for (const source of switchSourceExpressions(switched)) {
    if (unwrapped === source) return true;
    const expressionOwner = expressionSymbol(unwrapped, checker);
    const sourceOwner = expressionSymbol(source, checker);
    if (expressionOwner && sourceOwner && expressionOwner === sourceOwner) return true;
    const expressionProperty = selectedProperty(unwrapped);
    const sourceProperty = selectedProperty(source);
    if (expressionProperty && sourceProperty && expressionProperty.name === sourceProperty.name) {
      const expressionReceiver = expressionSymbol(expressionProperty.receiver, checker);
      const sourceReceiver = expressionSymbol(sourceProperty.receiver, checker);
      if (expressionReceiver && sourceReceiver && expressionReceiver === sourceReceiver)
        return true;
    }
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some((declaration) => {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return expressionDerivesFromSwitch(declaration.initializer, switched, checker, seenSymbols);
      }
      if (ts.isBindingElement(declaration)) {
        const source = bindingElementSource(declaration, checker);
        return Boolean(
          source && expressionDerivesFromSwitch(source, switched, checker, seenSymbols),
        );
      }
      return false;
    }) ?? false
  );
}

function defaultContainsNeverSink(
  clause: ts.DefaultClause,
  switched: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const signature = resolvedSignature(checker, node);
      for (const [index, argument] of node.arguments.entries()) {
        const parameter = signature?.parameters[Math.min(index, signature.parameters.length - 1)];
        if (!parameter) continue;
        const parameterType = checker.getTypeOfSymbolAtLocation(parameter, argument);
        const argumentType = checker.getTypeAtLocation(argument);
        if (
          (parameterType.flags & ts.TypeFlags.Never) !== 0 &&
          (argumentType.flags & ts.TypeFlags.Never) !== 0 &&
          expressionDerivesFromSwitch(argument, switched, checker)
        ) {
          found = true;
          return;
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      node.initializer &&
      (checker.getTypeFromTypeNode(node.type).flags & ts.TypeFlags.Never) !== 0 &&
      (checker.getTypeAtLocation(node.initializer).flags & ts.TypeFlags.Never) !== 0 &&
      expressionDerivesFromSwitch(node.initializer, switched, checker)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(clause);
  return found;
}

function analyzeClosedUnionSwitch(
  node: ts.SwitchStatement,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const domain = switchDomain(node, checker, packageRoots);
  if (!domain) return;
  const handled = new Set<string>();
  let defaultClause: ts.DefaultClause | undefined;
  for (const clause of node.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      defaultClause = clause;
      continue;
    }
    const caseDomain = literalDomain(
      checker.getTypeAtLocation(clause.expression),
      checker,
      packageRoots,
    );
    if (caseDomain) {
      for (const key of caseDomain.keys.keys()) handled.add(key);
      continue;
    }
    const key = literalKey(checker.getTypeAtLocation(clause.expression), checker);
    if (key) handled.add(key[0]);
  }
  const missing = [...domain.keys]
    .filter(([key]) => !handled.has(key))
    .map(([, display]) => display);
  const silentDefault =
    defaultClause && !defaultContainsNeverSink(defaultClause, node.expression, checker);
  if (missing.length === 0 && !silentDefault) return;
  const detail = missing.length
    ? `missing ${missing.join(", ")}`
    : "uses a silent default after handling every known member";
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/closed-union-exhaustiveness",
      defaultClause ?? node,
      `Switch over a project-owned closed union is not exhaustive: ${detail}.`,
      "Handle every union member directly; omit default, or use a default that passes the narrowed value to a never sink.",
    ),
  );
}

interface MapResolution {
  readonly object: ts.ObjectLiteralExpression;
  readonly checkedTypeNodes: readonly ts.TypeNode[];
  readonly assertedTypeNodes: readonly ts.TypeNode[];
}

function mapResolutionFromExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): MapResolution | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return mapResolutionFromExpression(expression.expression, checker, seenSymbols);
  }
  if (ts.isSatisfiesExpression(expression)) {
    const resolution = mapResolutionFromExpression(expression.expression, checker, seenSymbols);
    return resolution
      ? {
          ...resolution,
          checkedTypeNodes: [...resolution.checkedTypeNodes, expression.type],
        }
      : undefined;
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    const resolution = mapResolutionFromExpression(expression.expression, checker, seenSymbols);
    return resolution
      ? {
          ...resolution,
          assertedTypeNodes: [...resolution.assertedTypeNodes, expression.type],
        }
      : undefined;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return { object: expression, checkedTypeNodes: [], assertedTypeNodes: [] };
  }
  const located = ts.isIdentifier(expression)
    ? checker.getSymbolAtLocation(expression)
    : ts.isPropertyAccessExpression(expression)
      ? checker.getSymbolAtLocation(expression.name)
      : ts.isElementAccessExpression(expression) &&
          expression.argumentExpression &&
          ts.isStringLiteralLike(expression.argumentExpression)
        ? checker.getSymbolAtLocation(expression.argumentExpression)
        : undefined;
  if (!located) return undefined;
  const symbol = canonicalSymbol(located, checker);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  const declaration = symbol.declarations?.find(
    (
      candidate,
    ): candidate is ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertyAssignment =>
      (ts.isVariableDeclaration(candidate) ||
        ts.isPropertyDeclaration(candidate) ||
        ts.isPropertyAssignment(candidate)) &&
      candidate.initializer !== undefined,
  );
  if (!declaration?.initializer) return undefined;
  const resolution = mapResolutionFromExpression(declaration.initializer, checker, seenSymbols);
  if (!resolution || ts.isPropertyAssignment(declaration) || !declaration.type) return resolution;
  return {
    ...resolution,
    checkedTypeNodes: [...resolution.checkedTypeNodes, declaration.type],
  };
}

function domainsInTypeNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): readonly LiteralDomain[] {
  const domains: LiteralDomain[] = [];
  const seenAliases = new Set<ts.Symbol>();
  const visit = (child: ts.Node): void => {
    if (ts.isTypeNode(child)) {
      const domain = literalDomain(checker.getTypeFromTypeNode(child), checker, packageRoots);
      const ownedDomain =
        domain ??
        literalDomain(
          checker.getTypeFromTypeNode(child),
          checker,
          packageRoots,
          checker.getTypeFromTypeNode(child),
          isProjectDeclaration(child, packageRoots) &&
            typeNodeIsProjectOwned(child, checker, packageRoots, new Set()),
        );
      if (ownedDomain) domains.push(ownedDomain);
      if (ts.isTypeReferenceNode(child)) {
        const located = checker.getSymbolAtLocation(child.typeName);
        const symbol = located && canonicalSymbol(located, checker);
        if (symbol && !seenAliases.has(symbol)) {
          seenAliases.add(symbol);
          for (const declaration of symbol.declarations ?? []) {
            if (ts.isTypeAliasDeclaration(declaration)) visit(declaration.type);
          }
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return domains;
}

function typeNodeHasDomainProperties(
  typeNode: ts.TypeNode,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
): boolean {
  const contract = checker.getTypeFromTypeNode(typeNode);
  return [...domain.keys.keys()].every((key) => {
    const name = propertyNameForLiteralKey(key);
    return name !== undefined && checker.getPropertyOfType(contract, name) !== undefined;
  });
}

function typeNodeIsMapContract(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenAliases: Set<ts.Symbol> = new Set(),
): boolean {
  if (ts.isMappedTypeNode(node)) return true;
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) {
    return typeNodeIsMapContract(node.type, checker, packageRoots, seenAliases);
  }
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
    return node.types.some((type) =>
      typeNodeIsMapContract(type, checker, packageRoots, seenAliases),
    );
  }
  if (!ts.isTypeReferenceNode(node)) return false;
  const referenceName = ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
  if (referenceName === "Record") return true;
  if (
    node.typeArguments?.some((type) =>
      typeNodeIsMapContract(type, checker, packageRoots, seenAliases),
    )
  ) {
    return true;
  }
  const located = checker.getSymbolAtLocation(node.typeName);
  const symbol = located && canonicalSymbol(located, checker);
  if (!symbol || seenAliases.has(symbol)) return false;
  seenAliases.add(symbol);
  return (
    symbol.declarations?.some(
      (declaration) =>
        ts.isTypeAliasDeclaration(declaration) &&
        isProjectDeclaration(declaration, packageRoots) &&
        typeNodeIsMapContract(declaration.type, checker, packageRoots, seenAliases),
    ) ?? false
  );
}

function propertyNameForLiteralKey(key: string): string | undefined {
  const separator = key.indexOf(":");
  if (separator < 0) return undefined;
  return key.slice(separator + 1);
}

function typeNodeRequiresDomain(
  typeNode: ts.TypeNode,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
): boolean {
  const contract = checker.getTypeFromTypeNode(typeNode);
  return [...domain.keys.keys()].every((key) => {
    const name = propertyNameForLiteralKey(key);
    if (name === undefined) return false;
    const property = checker.getPropertyOfType(contract, name);
    return Boolean(property && (property.flags & ts.SymbolFlags.Optional) === 0);
  });
}

function typeNodeMatchesDomain(
  typeNode: ts.TypeNode,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  return domainsInTypeNode(typeNode, checker, packageRoots).some(
    (candidate) =>
      candidate.keys.size === domain.keys.size &&
      [...candidate.keys.keys()].every((key) => domain.keys.has(key)),
  );
}

function mapIsCompilerChecked(
  resolution: MapResolution,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (
    resolution.assertedTypeNodes.some((typeNode) =>
      typeNodeMatchesDomain(typeNode, domain, checker, packageRoots),
    )
  ) {
    return false;
  }
  return resolution.checkedTypeNodes.some(
    (typeNode) =>
      typeNodeMatchesDomain(typeNode, domain, checker, packageRoots) &&
      typeNodeRequiresDomain(typeNode, domain, checker),
  );
}

function analyzeClosedUnionMap(
  resolution: MapResolution,
  domain: LiteralDomain,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  const object = resolution.object;
  const reportKey = `${canonicalPath(object.getSourceFile().fileName)}:${object.getStart()}`;
  if (reported.has(reportKey) || mapIsCompilerChecked(resolution, domain, checker, packageRoots)) {
    return;
  }
  reported.add(reportKey);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/closed-union-map-exhaustiveness",
      object,
      "Map keyed by a project-owned closed union is not compiler-checked as exhaustive.",
      "Declare or satisfy a required mapped type such as Record<Union, Value>; do not use Partial, a broad index signature, or a type assertion.",
    ),
  );
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function propertyTypeNodeInContract(
  contract: ts.TypeNode,
  propertyName: string,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.TypeNode | undefined {
  if (ts.isParenthesizedTypeNode(contract) || ts.isTypeOperatorNode(contract)) {
    return propertyTypeNodeInContract(contract.type, propertyName, checker, seenSymbols);
  }
  if (ts.isIntersectionTypeNode(contract) || ts.isUnionTypeNode(contract)) {
    for (const member of contract.types) {
      const selected = propertyTypeNodeInContract(member, propertyName, checker, seenSymbols);
      if (selected) return selected;
    }
    return undefined;
  }
  if (ts.isTypeLiteralNode(contract)) {
    for (const member of contract.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      if (propertyNameText(member.name) === propertyName) return member.type;
    }
    return undefined;
  }
  if (!ts.isTypeReferenceNode(contract)) return undefined;
  const located = checker.getSymbolAtLocation(contract.typeName);
  const symbol = located && canonicalSymbol(located, checker);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      const selected = propertyTypeNodeInContract(
        declaration.type,
        propertyName,
        checker,
        seenSymbols,
      );
      if (selected) return selected;
    }
    if (ts.isInterfaceDeclaration(declaration)) {
      for (const member of declaration.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        if (propertyNameText(member.name) === propertyName) return member.type;
      }
    }
  }
  return undefined;
}

interface NestedPropertyContracts {
  readonly asserted: readonly ts.TypeNode[];
  readonly checked: readonly ts.TypeNode[];
}

function selectPropertyContractPath(
  root: ts.TypeNode,
  path: readonly string[],
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  let selected: ts.TypeNode | undefined = root;
  for (const segment of path) {
    selected = propertyTypeNodeInContract(selected, segment, checker);
    if (!selected) return undefined;
  }
  return selected;
}

function nestedPropertyContracts(
  node: ts.PropertyAssignment,
  checker: ts.TypeChecker,
): NestedPropertyContracts {
  const path: string[] = [];
  const asserted: ts.TypeNode[] = [];
  const checked: ts.TypeNode[] = [];
  let property: ts.PropertyAssignment = node;
  while (true) {
    const name = propertyNameText(property.name);
    if (!name) return { asserted, checked };
    path.unshift(name);
    const object = property.parent;
    let expression: ts.Expression = object;
    while (true) {
      const wrapper = expression.parent;
      if (ts.isParenthesizedExpression(wrapper) && wrapper.expression === expression) {
        expression = wrapper;
        continue;
      }
      if (
        (ts.isAsExpression(wrapper) ||
          ts.isSatisfiesExpression(wrapper) ||
          ts.isTypeAssertionExpression(wrapper)) &&
        wrapper.expression === expression
      ) {
        const selected = selectPropertyContractPath(wrapper.type, path, checker);
        if (selected) {
          if (ts.isSatisfiesExpression(wrapper)) checked.push(selected);
          else asserted.push(selected);
        }
        expression = wrapper;
        continue;
      }
      break;
    }
    const owner = expression.parent;
    if (ts.isPropertyAssignment(owner) && owner.initializer === expression) {
      property = owner;
      continue;
    }
    const rootType =
      (ts.isVariableDeclaration(owner) || ts.isPropertyDeclaration(owner)) &&
      owner.initializer === expression
        ? owner.type
        : undefined;
    if (rootType) {
      const selected = selectPropertyContractPath(rootType, path, checker);
      if (selected) checked.push(selected);
    }
    return { asserted, checked };
  }
}

function analyzeDeclaredClosedUnionMap(
  node: ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertyAssignment,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
  reported: Set<string>,
): void {
  if (!node.initializer) return;
  const initial = mapResolutionFromExpression(node.initializer, checker);
  if (!initial) return;
  const nestedContracts = ts.isPropertyAssignment(node)
    ? nestedPropertyContracts(node, checker)
    : { asserted: [], checked: node.type ? [node.type] : [] };
  const resolution: MapResolution = {
    ...initial,
    assertedTypeNodes: [...initial.assertedTypeNodes, ...nestedContracts.asserted],
    checkedTypeNodes: [...initial.checkedTypeNodes, ...nestedContracts.checked],
  };
  const contracts = [...resolution.checkedTypeNodes, ...resolution.assertedTypeNodes];
  for (const contract of contracts) {
    if (!typeNodeIsMapContract(contract, checker, packageRoots)) continue;
    for (const domain of domainsInTypeNode(contract, checker, packageRoots)) {
      if (!typeNodeHasDomainProperties(contract, domain, checker)) continue;
      analyzeClosedUnionMap(
        resolution,
        domain,
        checker,
        workspace,
        workspaceRoot,
        packageRoots,
        diagnostics,
        reported,
      );
    }
  }
}

function symbolIsExternalProtocol(
  symbol: ts.Symbol,
  packageName: string,
  exportName: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const canonical = canonicalSymbol(symbol, checker);
  return (
    canonical.getName() === exportName &&
    symbolComesFromPackage(canonical, packageName, packageRoots)
  );
}

function typeNodeIsExactExternalProtocol(
  node: ts.TypeNode,
  packageName: string,
  exportName: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  if (ts.isParenthesizedTypeNode(node)) {
    return typeNodeIsExactExternalProtocol(
      node.type,
      packageName,
      exportName,
      checker,
      packageRoots,
      seenSymbols,
    );
  }
  if (!ts.isTypeReferenceNode(node)) return false;
  const located = checker.getSymbolAtLocation(node.typeName);
  if (!located) return false;
  const symbol = canonicalSymbol(located, checker);
  if (symbolIsExternalProtocol(symbol, packageName, exportName, checker, packageRoots)) return true;
  if (node.typeArguments?.length) return false;
  if (seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  const aliases = symbol.declarations?.filter(ts.isTypeAliasDeclaration) ?? [];
  return (
    aliases.length > 0 &&
    aliases.every(
      (declaration) =>
        isProjectDeclaration(declaration, packageRoots) &&
        typeNodeIsExactExternalProtocol(
          declaration.type,
          packageName,
          exportName,
          checker,
          packageRoots,
          seenSymbols,
        ),
    )
  );
}

function expressionIsExactExternalProtocol(
  expression: ts.Expression,
  packageName: string,
  exportName: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  const type = checker.getTypeAtLocation(unwrapped);
  if (typeIsPackageType(type, packageName, new Set([exportName]), packageRoots)) return true;
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return expressionIsExactExternalProtocol(
      unwrapped.expression,
      packageName,
      exportName,
      checker,
      packageRoots,
      seenSymbols,
    );
  }
  if (!ts.isIdentifier(unwrapped)) return false;
  const located = checker.getSymbolAtLocation(unwrapped);
  if (!located) return false;
  const symbol = canonicalSymbol(located, checker);
  if (seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some((declaration) => {
      const typeNode = declaredTypeNode(declaration);
      if (
        typeNode &&
        typeNodeIsExactExternalProtocol(typeNode, packageName, exportName, checker, packageRoots)
      ) {
        return true;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return expressionIsExactExternalProtocol(
          declaration.initializer,
          packageName,
          exportName,
          checker,
          packageRoots,
          seenSymbols,
        );
      }
      if (ts.isBindingElement(declaration)) {
        const source = bindingElementSource(declaration, checker);
        return Boolean(
          source &&
          expressionIsExactExternalProtocol(
            source,
            packageName,
            exportName,
            checker,
            packageRoots,
            seenSymbols,
          ),
        );
      }
      return false;
    }) ?? false
  );
}

function discriminantValue(
  type: ts.Type,
  discriminant: string,
  checker: ts.TypeChecker,
  location: ts.Node,
): string | undefined {
  const property = checker.getPropertyOfType(type, discriminant);
  if (!property) return undefined;
  const propertyType = checker.getTypeOfSymbolAtLocation(property, location);
  if ((propertyType.flags & ts.TypeFlags.StringLiteral) === 0) return undefined;
  return (propertyType as ts.StringLiteralType).value;
}

function isClosedLocalDiscriminatedUnion(
  type: ts.Type,
  discriminant: string,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  location: ts.Node,
): boolean {
  if (!type.isUnion() || type.types.length < 2) {
    return false;
  }
  const aliasDeclarations = type.aliasSymbol?.declarations ?? [];
  const hasLocalAlias =
    aliasDeclarations.length > 0 &&
    aliasDeclarations.every((declaration) => isProjectDeclaration(declaration, packageRoots));
  const hasLocalDiscriminants = type.types.every((member) => {
    const property = checker.getPropertyOfType(member, discriminant);
    const declarations = property?.declarations ?? [];
    return (
      declarations.length > 0 &&
      declarations.every((declaration) => isProjectDeclaration(declaration, packageRoots))
    );
  });
  if (
    !typeIsProjectOwned(type, checker, packageRoots) &&
    !(hasLocalAlias && hasLocalDiscriminants)
  ) {
    return false;
  }
  const values = type.types.map((member) =>
    discriminantValue(member, discriminant, checker, location),
  );
  return values.every((value) => value !== undefined) && new Set(values).size === values.length;
}

function expressionHasFallback(
  expression: ts.Expression,
  discriminant: string,
  fallback: string,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const unwrapped = ts.isParenthesizedExpression(expression)
    ? expression.expression
    : ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isTypeAssertionExpression(expression)
      ? expression.expression
      : expression;
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const property = unwrapped.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
        candidate.name.text === discriminant,
    );
    if (
      property &&
      (ts.isStringLiteral(property.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(property.initializer))
    ) {
      return property.initializer.text === fallback;
    }
  }
  const value = discriminantValue(
    checker.getTypeAtLocation(unwrapped),
    discriminant,
    checker,
    unwrapped,
  );
  if (value === fallback) return true;
  if (!ts.isIdentifier(unwrapped)) return false;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  const declaration = symbol.declarations?.find(
    (candidate): candidate is ts.VariableDeclaration =>
      ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
  );
  return Boolean(
    declaration?.initializer &&
    expressionHasFallback(declaration.initializer, discriminant, fallback, checker, seenSymbols),
  );
}

function functionReturnsFallback(
  node: ts.SignatureDeclaration,
  discriminant: string,
  fallback: string,
  checker: ts.TypeChecker,
): boolean {
  const body =
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
      ? node.body
      : undefined;
  if (!body) return false;
  if (!ts.isBlock(body)) return expressionHasFallback(body, discriminant, fallback, checker);
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child !== body && ts.isFunctionLike(child)) return;
    if (
      ts.isReturnStatement(child) &&
      child.expression &&
      expressionHasFallback(child.expression, discriminant, fallback, checker)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(body);
  return found;
}

function functionHasImplementation(node: ts.SignatureDeclaration): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body !== undefined;
  }
  return false;
}

function isCallableImplementation(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    functionHasImplementation(node)
  );
}

function isNamedCallableDeclaration(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    (ts.isMethodSignature(node) && ts.isInterfaceDeclaration(node.parent))
  );
}

function registeredNodes<T extends ts.Node>(
  identity: PackageSymbolIdentity,
  workspaceRoot: string,
  program: ts.Program,
  predicate: (node: ts.Node) => node is T,
  packageRoots: readonly WorkspacePackageRoot[] = [],
): readonly T[] {
  const identityRoot =
    identity.package === undefined
      ? workspaceRoot
      : packageRoots.find(({ packageName }) => packageName === identity.package)?.root;
  if (!identityRoot) return [];
  const candidates = registeredDeclarationIndex(program, identityRoot)
    .get(identity.module)
    ?.get(identity.exportName);
  return (candidates ?? []).filter(predicate);
}

type ModuleDeclarationIndex = ReadonlyMap<string, ReadonlyMap<string, readonly ts.Node[]>>;

const PROGRAM_DECLARATION_INDEXES = new WeakMap<ts.Program, Map<string, ModuleDeclarationIndex>>();

function isRegisteredDeclarationCandidate(node: ts.Node): boolean {
  return (
    ts.isVariableDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    (ts.isFunctionLike(node) && (functionHasImplementation(node) || ts.isMethodSignature(node)))
  );
}

function registeredDeclarationIndex(
  program: ts.Program,
  identityRoot: string,
): ModuleDeclarationIndex {
  const canonicalRoot = canonicalPath(identityRoot);
  const programIndexes = PROGRAM_DECLARATION_INDEXES.get(program) ?? new Map();
  PROGRAM_DECLARATION_INDEXES.set(program, programIndexes);
  const cached = programIndexes.get(canonicalRoot);
  if (cached) return cached;

  const modules = new Map<string, Map<string, ts.Node[]>>();
  for (const sourceFile of productionSourceIndex(program, identityRoot).files) {
    const module = relativeModulePath(identityRoot, sourceFile);
    const identities = new Map<string, ts.Node[]>();
    const visit = (node: ts.Node): void => {
      if (isRegisteredDeclarationCandidate(node)) {
        const exportName =
          ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            ? node.name.text
            : nodeIdentity(node, identityRoot).symbolPath;
        if (exportName !== "<module>") {
          const declarations = identities.get(exportName) ?? [];
          declarations.push(node);
          identities.set(exportName, declarations);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    modules.set(module, identities);
  }
  programIndexes.set(canonicalRoot, modules);
  return modules;
}

function requireOneRegisteredNode<T extends ts.Node>(
  description: string,
  identity: PackageSymbolIdentity,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  predicate: (node: ts.Node) => node is T,
  packageRoots: readonly WorkspacePackageRoot[] = [],
): T {
  const matches = registeredNodes(identity, workspaceRoot, program, predicate, packageRoots);
  if (matches.length !== 1) {
    throw new Error(
      `${description} ${identity.package ?? workspace.name}/${identity.module}#${identity.exportName} must resolve to exactly one declaration; found ${matches.length}.`,
    );
  }
  return matches[0]!;
}

function isObjectRegistryDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return ts.isVariableDeclaration(node) && node.initializer !== undefined;
}

function objectLiteralInitializer(
  declaration: ts.VariableDeclaration,
): ts.ObjectLiteralExpression | undefined {
  if (!declaration.initializer) return undefined;
  const initializer = unwrapExpression(declaration.initializer);
  return ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
}

function propertyStringValue(
  property: ts.ObjectLiteralElementLike,
  checker: ts.TypeChecker,
): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const type = checker.getTypeAtLocation(name.expression);
    return (type.flags & ts.TypeFlags.StringLiteral) !== 0
      ? (type as ts.StringLiteralType).value
      : undefined;
  }
  return undefined;
}

function canonicalToolExpressionValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol>,
): readonly string[] | undefined {
  const initializer = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(initializer)) {
    let symbol = checker.getSymbolAtLocation(initializer);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
      symbol = checker.getAliasedSymbol(symbol);
    if (!symbol || seenSymbols.has(symbol)) return undefined;
    seenSymbols.add(symbol);
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
    );
    const values = declaration?.initializer
      ? canonicalToolExpressionValues(declaration.initializer, checker, seenSymbols)
      : undefined;
    seenSymbols.delete(symbol);
    return values;
  }
  const values: string[] = [];
  for (const element of initializer.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = canonicalToolExpressionValues(element.expression, checker, seenSymbols);
      if (!spread) return undefined;
      values.push(...spread);
      continue;
    }
    const value = unwrapExpression(element);
    if (!ts.isStringLiteralLike(value)) return undefined;
    values.push(value.text);
  }
  return values;
}

function canonicalToolValues(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
): readonly string[] | undefined {
  return declaration.initializer
    ? canonicalToolExpressionValues(declaration.initializer, checker, new Set())
    : undefined;
}

function codecRegistryValues(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
): readonly string[] | undefined {
  const object = objectLiteralInitializer(declaration);
  if (!object) return undefined;
  const values: string[] = [];
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return undefined;
    const value = propertyStringValue(property, checker);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): readonly string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function registeredIdentityKey(identity: SymbolIdentity): string {
  return `${identity.module}#${identity.exportName}`;
}

function callTargetsDeclaredHelper(
  call: ts.CallExpression,
  declaration: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const target = expressionSymbol(call.expression, checker);
  const declared = declaration.name && checker.getSymbolAtLocation(declaration.name);
  return Boolean(target && declared && target === canonicalSymbol(declared, checker));
}

function explicitPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name || ts.isComputedPropertyName(name)) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function eventCatalogDslProblems(
  declaration: ts.VariableDeclaration,
  helper: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
): readonly string[] {
  const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
  if (!initializer || !ts.isCallExpression(initializer)) {
    return ["catalog must be a defineLilacEvents({ ... }) call"];
  }
  const problems: string[] = [];
  if (!callTargetsDeclaredHelper(initializer, helper, checker)) {
    problems.push("catalog must call its registered defineLilacEvents symbol");
  }
  if (initializer.arguments.length !== 1) {
    problems.push("defineLilacEvents must receive exactly one argument");
    return problems;
  }
  const catalog = unwrapExpression(initializer.arguments[0]!);
  if (!ts.isObjectLiteralExpression(catalog)) {
    problems.push("defineLilacEvents input must be an explicit object literal");
    return problems;
  }
  if (catalog.properties.length === 0) {
    problems.push("event catalog must contain at least one event");
  }
  const wireTypes = new Set<string>();
  for (const property of catalog.properties) {
    if (!ts.isPropertyAssignment(property) || explicitPropertyName(property) === undefined) {
      problems.push("catalog entries must be explicit non-computed property assignments");
      continue;
    }
    const entryName = explicitPropertyName(property)!;
    if (entryName === "__proto__") {
      problems.push("catalog entry name __proto__ is reserved by object literal semantics");
      continue;
    }
    const entry = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(entry)) {
      problems.push(`catalog entry ${entryName} must be an explicit object literal`);
      continue;
    }
    let wireType: string | undefined;
    let family: string | undefined;
    let malformedEntry = false;
    for (const metadata of entry.properties) {
      if (ts.isSpreadAssignment(metadata) || explicitPropertyName(metadata) === undefined) {
        malformedEntry = true;
        continue;
      }
      const metadataName = explicitPropertyName(metadata)!;
      if (metadataName !== "type" && metadataName !== "family") continue;
      if (!ts.isPropertyAssignment(metadata)) {
        malformedEntry = true;
        continue;
      }
      const value = unwrapExpression(metadata.initializer);
      if (!ts.isStringLiteralLike(value)) {
        problems.push(`catalog entry ${entryName} ${metadataName} must be a string literal`);
        continue;
      }
      if (metadataName === "type") {
        if (wireType !== undefined) malformedEntry = true;
        wireType = value.text;
      } else {
        if (family !== undefined) malformedEntry = true;
        family = value.text;
      }
    }
    if (malformedEntry) {
      problems.push(`catalog entry ${entryName} must not use spreads or computed metadata`);
    }
    if (!wireType) {
      problems.push(`catalog entry ${entryName} must declare a nonempty literal type`);
    } else if (wireTypes.has(wireType)) {
      problems.push(`catalog contains duplicate wire type ${wireType}`);
    } else {
      wireTypes.add(wireType);
    }
    if (!family) {
      problems.push(`catalog entry ${entryName} must declare a nonempty literal family`);
    }
  }
  return problems;
}

function eventRegistryProjectionProblems(
  registry: ts.VariableDeclaration,
  catalog: ts.VariableDeclaration,
  helper: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
): readonly string[] {
  const initializer = registry.initializer && unwrapExpression(registry.initializer);
  if (!initializer || !ts.isCallExpression(initializer)) {
    return ["registry must be a createLilacEventCodecRegistry(catalog) call"];
  }
  const problems: string[] = [];
  if (!callTargetsDeclaredHelper(initializer, helper, checker)) {
    problems.push("registry must call its registered createLilacEventCodecRegistry symbol");
  }
  if (initializer.arguments.length !== 1) {
    problems.push("createLilacEventCodecRegistry must receive exactly one catalog");
    return problems;
  }
  const registeredCatalogSymbol = checker.getSymbolAtLocation(catalog.name);
  const projectedCatalogSymbol = expressionSymbol(initializer.arguments[0]!, checker);
  if (
    !registeredCatalogSymbol ||
    !projectedCatalogSymbol ||
    canonicalSymbol(registeredCatalogSymbol, checker) !== projectedCatalogSymbol
  ) {
    problems.push("registry must be projected from its registered catalog symbol");
  }
  return problems;
}

function analyzeEventCodecRegistry(
  registration: EventCodecRegistryRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  diagnostics: ArchitectureDiagnostic[],
): void {
  const registry = requireOneRegisteredNode(
    "Event codec registry",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isObjectRegistryDeclaration,
  );
  const catalog = requireOneRegisteredNode(
    "Lilac event catalog",
    registration.catalog,
    workspace,
    workspaceRoot,
    program,
    isObjectRegistryDeclaration,
  );
  const catalogHelper = requireOneRegisteredNode(
    "Lilac event catalog helper",
    registration.catalogHelper,
    workspace,
    workspaceRoot,
    program,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.body !== undefined,
  );
  const registryHelper = requireOneRegisteredNode(
    "Lilac event codec registry helper",
    registration.registryHelper,
    workspace,
    workspaceRoot,
    program,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.body !== undefined,
  );
  const details = [
    ...eventCatalogDslProblems(catalog, catalogHelper, checker),
    ...eventRegistryProjectionProblems(registry, catalog, registryHelper, checker),
  ];
  if (details.length === 0) return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/complete-event-codec-registry",
      registry,
      `Registered Lilac event infrastructure is invalid: ${details.join("; ")}.`,
      "Define every event with literal type and family metadata in defineLilacEvents({ ... }), then derive the registry with createLilacEventCodecRegistry(catalog).",
    ),
  );
}

function analyzeToolCodecRegistry(
  registration: ToolCodecRegistryRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const registry = requireOneRegisteredNode(
    "Tool codec registry",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isObjectRegistryDeclaration,
    packageRoots,
  );
  const registrySymbol = checker.getSymbolAtLocation(registry.name);
  const invalidAliases: string[] = [];
  for (const aliasIdentity of registration.aliases) {
    const alias = requireOneRegisteredNode(
      "Tool codec registry alias",
      aliasIdentity,
      workspace,
      workspaceRoot,
      program,
      isObjectRegistryDeclaration,
      packageRoots,
    );
    const initializer = alias.initializer && unwrapExpression(alias.initializer);
    let aliasTarget = initializer && checker.getSymbolAtLocation(initializer);
    if (aliasTarget && (aliasTarget.flags & ts.SymbolFlags.Alias) !== 0) {
      aliasTarget = checker.getAliasedSymbol(aliasTarget);
    }
    if (!registrySymbol || aliasTarget !== registrySymbol) {
      invalidAliases.push(aliasIdentity.exportName);
    }
  }
  const canonical = requireOneRegisteredNode(
    "Canonical tool catalog",
    registration.canonicalTools,
    workspace,
    workspaceRoot,
    program,
    isObjectRegistryDeclaration,
    packageRoots,
  );
  const sourceCanonicalValues = canonicalToolValues(canonical, checker);
  const broadCatalog = !checker.isTupleType(checker.getTypeAtLocation(canonical.name));
  const registryValues = codecRegistryValues(registry, checker);
  const registryType = checker.getTypeAtLocation(registry.name);
  const broadRegistry =
    checker.getIndexTypeOfType(registryType, ts.IndexKind.String) !== undefined ||
    checker.getIndexTypeOfType(registryType, ts.IndexKind.Number) !== undefined;
  const sourceCanonical = new Set(sourceCanonicalValues ?? []);
  const sourceRegistry = new Set(registryValues ?? []);
  const malformed = sourceCanonicalValues === undefined || registryValues === undefined;
  const codecMissing = setDifference(sourceCanonical, sourceRegistry);
  const codecExtra = setDifference(sourceRegistry, sourceCanonical);
  const duplicateCatalog =
    sourceCanonicalValues !== undefined && sourceCanonical.size !== sourceCanonicalValues.length;
  const duplicateRegistry =
    registryValues !== undefined && sourceRegistry.size !== registryValues.length;
  if (
    !malformed &&
    codecMissing.length === 0 &&
    codecExtra.length === 0 &&
    !duplicateCatalog &&
    !duplicateRegistry &&
    !broadCatalog &&
    !broadRegistry &&
    invalidAliases.length === 0
  ) {
    return;
  }
  const details = [
    malformed
      ? "catalog must be an explicit or const-tuple-composed string tuple and registry must be an explicit object literal with statically named members"
      : undefined,
    codecMissing.length ? `codecs missing ${codecMissing.join(", ")}` : undefined,
    codecExtra.length ? `codecs contain noncanonical ${codecExtra.join(", ")}` : undefined,
    duplicateCatalog ? "canonical tool catalog contains duplicates" : undefined,
    duplicateRegistry ? "tool codec registry contains duplicate canonical keys" : undefined,
    broadCatalog ? "canonical tool catalog is not a literal tuple" : undefined,
    broadRegistry ? "tool codec registry has a broad index signature" : undefined,
    invalidAliases.length
      ? `registry aliases do not reference the registered value: ${invalidAliases.join(", ")}`
      : undefined,
  ].filter((detail): detail is string => detail !== undefined);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/complete-tool-codec-registry",
      registry,
      `Registered tool codec registry is incomplete: ${details.join("; ")}.`,
      "Keep the shared executable-plus-transcript tool catalog and codec registry as exhaustive one-to-one declarations without broad keys or manifest member copies.",
    ),
  );
}

function resultTypeArguments(
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly [ts.Type, ts.Type] | undefined {
  const arguments_ = type.aliasTypeArguments ?? typeArguments(type, checker);
  const success = arguments_[0];
  const error = arguments_[1];
  if (success && error) return [success, error];
  if (!type.isUnion()) return undefined;
  let unionSuccess: ts.Type | undefined;
  let unionError: ts.Type | undefined;
  for (const member of type.types) {
    const memberArguments = member.aliasTypeArguments ?? typeArguments(member, checker);
    unionSuccess ??= memberArguments[0];
    unionError ??= memberArguments[1];
  }
  return unionSuccess && unionError ? [unionSuccess, unionError] : undefined;
}

function analyzeResultDecoder(
  registration: ResultDecoderRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const declaration = requireOneRegisteredNode(
    "Result decoder",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isCallableImplementation,
  );
  const signature = checker.getSignatureFromDeclaration(declaration);
  const input = declaration.parameters[registration.inputParameter];
  const returnType = signature?.getReturnType();
  const resultArguments =
    returnType && isDirectResultType(returnType, packageRoots)
      ? resultTypeArguments(returnType, checker)
      : undefined;
  const invalidFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
  const failures = [
    declaration.typeParameters?.length ? "decoder is generic" : undefined,
    input ? undefined : "registered input parameter does not exist",
    input &&
    typeContainsUnknown(
      input.type ? checker.getTypeFromTypeNode(input.type) : checker.getTypeAtLocation(input),
      checker,
      input,
    )
      ? undefined
      : "registered input does not contain unknown boundary data",
    resultArguments ? undefined : "return type is not a direct better-result Result<T, E>",
    resultArguments && !typeContainsFlags(resultArguments[0], invalidFlags, checker, declaration)
      ? undefined
      : "Result success type is not fully decoded",
    resultArguments &&
    !typeContainsFlags(resultArguments[1], invalidFlags, checker, declaration, {
      inspectMethodProperties: false,
      seen: new Set(),
      remainingProperties: MAX_VISITED_PROPERTIES,
    })
      ? undefined
      : "Result error type is not specific",
  ].filter((failure): failure is string => failure !== undefined);
  if (failures.length === 0) return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/result-decoder-contract",
      input ?? declaration,
      `Registered Result decoder ${registration.identity.exportName} is invalid: ${failures.join("; ")}.`,
      "Decode the exact boundary input with a non-generic callable returning Result<Decoded, SpecificError>.",
    ),
  );
}

function unknownFreeDeclarationType(node: ts.Node, checker: ts.TypeChecker): ts.Type | undefined {
  if (ts.isTypeAliasDeclaration(node)) return checker.getTypeFromTypeNode(node.type);
  if (
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node)
  ) {
    return node.type ? checker.getTypeFromTypeNode(node.type) : checker.getTypeAtLocation(node);
  }
  if (ts.isFunctionLike(node) && !ts.isConstructorDeclaration(node)) {
    return checker.getSignatureFromDeclaration(node)?.getReturnType();
  }
  return undefined;
}

function unknownFreeDeclarationDescription(node: ts.Node): string {
  if (ts.isParameter(node)) return `parameter ${node.name.getText()}`;
  if (ts.isVariableDeclaration(node)) return `local ${node.name.getText()}`;
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    return `property ${node.name.getText()}`;
  }
  if (ts.isTypeAliasDeclaration(node)) return `type alias ${node.name.text}`;
  return "return type";
}

function analyzeUnknownFreeModule(
  registration: UnknownFreeModuleRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  diagnostics: ArchitectureDiagnostic[],
): void {
  const sourceFile = productionSourceIndex(program, workspaceRoot).modules.get(registration.module);
  if (!sourceFile) {
    throw new Error(
      `Unknown-free module ${workspace.name}/${registration.module} must resolve to exactly one source module; found 0.`,
    );
  }
  const reported = new Set<number>();
  const visit = (node: ts.Node): void => {
    const type = unknownFreeDeclarationType(node, checker);
    if (
      type &&
      typeContainsUnknown(type, checker, node) &&
      !reported.has(node.getStart(sourceFile))
    ) {
      reported.add(node.getStart(sourceFile));
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/unknown-free-module",
          node,
          `Unknown-free module ${registration.module} exposes unknown through ${unknownFreeDeclarationDescription(node)}.`,
          "Project boundary data before rendering; parameters, returns, aliases, properties, generics, maps, unions, and locals must be recursively unknown-free.",
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function literalStringValues(type: ts.Type): readonly string[] | undefined {
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return [(type as ts.StringLiteralType).value];
  }
  if (!type.isUnion()) return undefined;
  const values = type.types.flatMap((member) => literalStringValues(member) ?? []);
  return values.length === type.types.length ? values : undefined;
}

function propertyType(
  type: ts.Type,
  property: string,
  checker: ts.TypeChecker,
  location: ts.Node,
): ts.Type | undefined {
  const symbol = checker.getPropertyOfType(type, property);
  return symbol && checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? location);
}

function fixtureCaseExpectation(
  value: ts.Expression,
  checker: ts.TypeChecker,
): { readonly outcome?: string; readonly provenance?: string } {
  const object = unwrapExpression(value);
  if (!ts.isObjectLiteralExpression(object)) return {};
  const literalProperty = (name: string): string | undefined => {
    const property = object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) && propertyStringValue(candidate, checker) === name,
    );
    const initializer = property && unwrapExpression(property.initializer);
    return initializer && ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
  };
  return { outcome: literalProperty("outcome"), provenance: literalProperty("provenance") };
}

function analyzePersistedCodec(
  registration: PersistedCodecRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const declaration = requireOneRegisteredNode(
    "Persisted codec",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isCallableImplementation,
  );
  const signature = checker.getSignatureFromDeclaration(declaration);
  const input = declaration.parameters[registration.inputParameter];
  const returnType = signature?.getReturnType();
  const resultArguments =
    returnType && isDirectResultType(returnType, packageRoots)
      ? resultTypeArguments(returnType, checker)
      : undefined;
  const success = resultArguments?.[0];
  const error = resultArguments?.[1];
  const value = success && propertyType(success, "value", checker, declaration);
  const provenance = success && propertyType(success, "provenance", checker, declaration);
  const actualProvenance = new Set(provenance ? literalStringValues(provenance) : undefined);
  const expectedProvenance = new Set(registration.provenance);
  const invalidFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
  const failures = [
    input ? undefined : "registered input parameter does not exist",
    input && (checker.getTypeAtLocation(input).flags & ts.TypeFlags.Any) === 0
      ? undefined
      : "registered input is any or missing",
    resultArguments ? undefined : "return type is not a direct better-result Result<T, E>",
    value &&
    !typeContainsFlags(value, invalidFlags, checker, declaration, {
      inspectMethodProperties: true,
      seen: new Set(),
      remainingProperties: MAX_PERSISTED_CODEC_PROPERTIES,
    })
      ? undefined
      : "Result success value is not fully decoded",
    provenance ? undefined : "Result success lacks provenance",
    setDifference(expectedProvenance, actualProvenance).length === 0 &&
    setDifference(actualProvenance, expectedProvenance).length === 0
      ? undefined
      : `provenance must be exactly ${[...expectedProvenance].join(" | ")}`,
    error &&
    !typeContainsFlags(error, invalidFlags, checker, declaration, {
      inspectMethodProperties: false,
      seen: new Set(),
      remainingProperties: MAX_VISITED_PROPERTIES,
    })
      ? undefined
      : "Result error type is not specific",
  ].filter((failure): failure is string => failure !== undefined);
  if (failures.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/persisted-codec-contract",
        input ?? declaration,
        `Persisted codec ${registration.identity.exportName} is invalid: ${failures.join("; ")}.`,
        "Return Result<{ value: Decoded; provenance: the exact declared provenance union }, SpecificStorageError> from the exact persisted boundary.",
      ),
    );
  }

  const catalog = requireOneRegisteredNode(
    "Persisted codec fixture catalog",
    registration.fixtureCatalog,
    workspace,
    workspaceRoot,
    program,
    isObjectRegistryDeclaration,
  );
  const object = objectLiteralInitializer(catalog);
  const cases = new Map<string, { readonly outcome?: string; readonly provenance?: string }>();
  if (object) {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyStringValue(property, checker);
      if (name) cases.set(name, fixtureCaseExpectation(property.initializer, checker));
    }
  }
  const expectedCases = new Set<string>(PERSISTED_CODEC_FIXTURE_CASES);
  const actualCases = new Set(cases.keys());
  const expectedOutcomes = new Map<string, readonly [string, string | undefined]>([
    ["current", ["ok", "current"]],
    [
      "legacy",
      registration.legacyOutcome === "rejected" ? ["error", undefined] : ["ok", "migrated"],
    ],
    [
      "missing-defaulted",
      registration.provenance.includes("missing-defaulted")
        ? ["ok", "missing-defaulted"]
        : ["error", undefined],
    ],
    ["unsupported-version", ["error", undefined]],
    ["malformed-serialization", ["error", undefined]],
    ["corrupt-fields", ["error", undefined]],
  ]);
  const invalidCases = [...expectedOutcomes].flatMap(([name, [outcome, caseProvenance]]) => {
    const actual = cases.get(name);
    return actual?.outcome === outcome && actual.provenance === caseProvenance ? [] : [name];
  });
  const fixtureFailures = [
    object ? undefined : "catalog is not an explicit object literal",
    setDifference(expectedCases, actualCases).length
      ? `missing ${setDifference(expectedCases, actualCases).join(", ")}`
      : undefined,
    setDifference(actualCases, expectedCases).length
      ? `contains extra ${setDifference(actualCases, expectedCases).join(", ")}`
      : undefined,
    invalidCases.length ? `invalid outcome/provenance for ${invalidCases.join(", ")}` : undefined,
  ].filter((failure): failure is string => failure !== undefined);
  if (fixtureFailures.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/persisted-codec-fixture-catalog",
        catalog,
        `Persisted codec fixture catalog ${registration.fixtureCatalog.exportName} is invalid: ${fixtureFailures.join("; ")}.`,
        "Declare all six explicit compatibility cases; missing-defaulted must be an error unless that provenance is declared.",
      ),
    );
  }
}

function resolvedCallMatchesIdentity(
  call: ts.CallExpression,
  identity: PackageSymbolIdentity,
  checker: ts.TypeChecker,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const declaration = resolvedSignature(checker, call)?.declaration;
  if (!declaration) return false;
  const identityRoot =
    identity.package === undefined
      ? workspaceRoot
      : packageRoots.find((candidate) => candidate.packageName === identity.package)?.root;
  return Boolean(
    identityRoot && identityMatches(identity, nodeIdentity(declaration, identityRoot)),
  );
}

function registeredOwnerCalls(
  owner: ts.Node,
  identity: PackageSymbolIdentity,
  checker: ts.TypeChecker,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      resolvedCallMatchesIdentity(node, identity, checker, workspaceRoot, packageRoots)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(owner);
  return found;
}

function sameRegisteredTarget(
  target: PackageSymbolIdentity,
  active: { readonly packageName: string; readonly identity: SymbolIdentity },
  workspacePackageName: string,
): boolean {
  return (
    (target.package ?? workspacePackageName) === active.packageName &&
    identityMatches(active.identity, {
      ...active.identity,
      symbolPath: target.exportName,
      module: target.module,
    })
  );
}

function assertPersistenceInfrastructureCallsResolve(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  active: ActivePersistenceInfrastructure,
): void {
  const registeredConsumers = workspace.persistedStoreConsumers;
  const registeredTransactions = workspace.sqliteTransactionConsumers;
  const registeredCatalogs = new Set(
    workspace.persistedCodecs.map(({ fixtureCatalog }) => registeredIdentityKey(fixtureCatalog)),
  );
  const packageRootByName = new Map<string, string>();
  for (const candidate of packageRoots) {
    if (!packageRootByName.has(candidate.packageName)) {
      packageRootByName.set(candidate.packageName, candidate.root);
    }
  }
  const codecTargets = active.persistedCodecs.map((codec) => ({
    value: codec,
    identityRoot: packageRootByName.get(codec.packageName),
  }));
  const transactionTargets = active.sqliteTransactionAdapters.map((adapter) => ({
    value: adapter,
    identityRoot: packageRootByName.get(adapter.packageName),
  }));
  const codecModules = new Set([
    ...registeredConsumers.map(({ identity }) => identity.module),
    ...workspace.boundaryDecoders.map(({ identity }) => identity.module),
    ...workspace.persistedCodecs.map(({ identity }) => identity.module),
  ]);
  const transactionModules = new Set(registeredTransactions.map(({ identity }) => identity.module));
  const localCodecOwners = active.persistedCodecs.filter(
    ({ packageName }) => packageName === workspace.packageName,
  );

  for (const sourceFile of productionSourceIndex(program, workspaceRoot).files) {
    const module = relativeModulePath(workspaceRoot, sourceFile);
    const scanCodecCalls =
      codecTargets.length > 0 &&
      (active.scanAllProductionModules === true || codecModules.has(module));
    const scanTransactionCalls =
      transactionTargets.length > 0 &&
      (active.scanAllProductionModules === true || transactionModules.has(module));
    if (ruleApplies(workspace, "architecture/persisted-codec-fixture-catalog", module)) {
      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith("CodecCases")) {
            continue;
          }
          const key = registeredIdentityKey({ module, exportName: declaration.name.text });
          if (!registeredCatalogs.has(key)) {
            throw new Error(
              `Unregistered persisted codec fixture catalog in ${workspace.name}: ${key}.`,
            );
          }
        }
      }
    }

    if (scanCodecCalls || scanTransactionCalls) {
      for (const node of sourceAnalysisIndex(sourceFile).calls) {
        const declaration = resolvedSignature(checker, node)?.declaration;
        if (!declaration) {
          continue;
        }
        const declarationModules = new Map<string, string>();
        const declarationIdentities = new Map<string, NodeIdentity>();
        const matchesTarget = (
          identity: SymbolIdentity,
          identityRoot: string | undefined,
        ): boolean => {
          if (!identityRoot) return false;
          let declarationModule = declarationModules.get(identityRoot);
          if (!declarationModule) {
            declarationModule = relativeModulePath(identityRoot, declaration.getSourceFile());
            declarationModules.set(identityRoot, declarationModule);
          }
          if (declarationModule !== identity.module) return false;
          let declarationIdentity = declarationIdentities.get(identityRoot);
          if (!declarationIdentity) {
            declarationIdentity = nodeIdentity(declaration, identityRoot);
            declarationIdentities.set(identityRoot, declarationIdentity);
          }
          return identityMatches(identity, declarationIdentity);
        };
        const matchingCodecs = scanCodecCalls
          ? codecTargets.filter(({ value, identityRoot }) =>
              matchesTarget(value.identity, identityRoot),
            )
          : [];
        const matchingTransactions = scanTransactionCalls
          ? transactionTargets.filter(({ value, identityRoot }) =>
              matchesTarget(value.identity, identityRoot),
            )
          : [];
        if (matchingCodecs.length > 0 || matchingTransactions.length > 0) {
          const callIdentity = nodeIdentity(node, workspaceRoot);
          for (const { value: codec } of matchingCodecs) {
            if (
              localCodecOwners.some((owner) => identityOwns(owner.identity, callIdentity)) ||
              workspace.boundaryDecoders.some(
                (decoder) =>
                  decoder.category === "persistence" &&
                  identityOwns(decoder.identity, callIdentity),
              )
            ) {
              continue;
            }
            const registered = registeredConsumers.some(
              (consumer) =>
                identityOwns(consumer.identity, callIdentity) &&
                consumer.codecs.some((candidate) =>
                  sameRegisteredTarget(candidate, codec, workspace.packageName),
                ),
            );
            if (!registered) {
              throw new Error(
                `Unregistered persisted store consumer in ${workspace.name}: ${module}#${callIdentity.symbolPath} calls ${codec.packageName}#${registeredIdentityKey(codec.identity)}.`,
              );
            }
          }
          for (const { value: adapter } of matchingTransactions) {
            if (
              adapter.packageName === workspace.packageName &&
              identityOwns(adapter.identity, callIdentity)
            ) {
              continue;
            }
            const registered = registeredTransactions.some(
              (consumer) =>
                identityOwns(consumer.identity, callIdentity) &&
                sameRegisteredTarget(consumer.adapter, adapter, workspace.packageName),
            );
            if (!registered) {
              throw new Error(
                `Unregistered SQLite transaction consumer in ${workspace.name}: ${module}#${callIdentity.symbolPath} calls ${adapter.packageName}#${registeredIdentityKey(adapter.identity)}.`,
              );
            }
          }
        }
      }
    }
  }
}

function analyzePersistedStoreConsumer(
  registration: PersistedStoreConsumerRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const owner = requireOneRegisteredNode(
    "Persisted store consumer",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isCallableImplementation,
  );
  const missing = registration.codecs.filter(
    (codec) => !registeredOwnerCalls(owner, codec, checker, workspaceRoot, packageRoots),
  );
  if (missing.length === 0) return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/persisted-codec-contract",
      owner,
      `Persisted store consumer ${registration.identity.exportName} does not call registered codecs ${missing.map(registeredIdentityKey).join(", ")}.`,
      "Decode persisted values through every registered codec before passing typed values into store policy.",
    ),
  );
}

function hasExportModifier(
  node: ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> },
): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function externalCallMatches(
  call: ts.CallExpression,
  identity: { readonly package: string; readonly exportName: string },
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const signature = resolvedSignature(checker, call);
  return (
    packageForSignature(signature, packageRoots) === identity.package &&
    declarationName(signature?.declaration) === identity.exportName.split(".").at(-1)
  );
}

function typeContainsExactSymbol(
  type: ts.Type,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  const typeSymbol = type.aliasSymbol ?? type.getSymbol();
  if (typeSymbol && canonicalSymbol(typeSymbol, checker) === canonicalSymbol(symbol, checker)) {
    return true;
  }
  return (
    type.isUnionOrIntersection() &&
    type.types.some((member) => typeContainsExactSymbol(member, symbol, checker, seen))
  );
}

function nodeIsWithin(node: ts.Node, owner: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === owner) return true;
  }
  return false;
}

function expressionDerivesFromSymbols(
  expression: ts.Expression,
  sources: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    const symbol = checker.getSymbolAtLocation(value);
    if (symbol) {
      const canonical = canonicalSymbol(symbol, checker);
      if (sources.has(canonical)) return true;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        const source = stableSymbolSource(canonical, value, checker);
        if (source && expressionDerivesFromSymbols(source, sources, checker, seen)) return true;
      }
    }
  }
  let found = false;
  ts.forEachChild(value, (child) => {
    if (found || !ts.isExpression(child)) return;
    found = expressionDerivesFromSymbols(child, sources, checker, new Set(seen));
  });
  return found;
}

function expressionDerivesExclusivelyFromSymbols(
  expression: ts.Expression,
  sources: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    const symbol = ts.isShorthandPropertyAssignment(value.parent)
      ? checker.getShorthandAssignmentValueSymbol(value.parent)
      : checker.getSymbolAtLocation(value);
    if (!symbol) return false;
    const canonical = canonicalSymbol(symbol, checker);
    if (sources.has(canonical)) return true;
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    const source = stableSymbolSource(canonical, value, checker);
    return Boolean(
      source && expressionDerivesExclusivelyFromSymbols(source, sources, checker, seen),
    );
  }
  if (ts.isPropertyAccessExpression(value)) {
    return expressionDerivesExclusivelyFromSymbols(value.expression, sources, checker, seen);
  }
  if (ts.isElementAccessExpression(value)) {
    return (
      expressionDerivesExclusivelyFromSymbols(value.expression, sources, checker, seen) &&
      (ts.isStringLiteralLike(value.argumentExpression) ||
        ts.isNumericLiteral(value.argumentExpression))
    );
  }
  if (ts.isConditionalExpression(value)) {
    return (
      expressionDerivesExclusivelyFromSymbols(value.whenTrue, sources, checker, new Set(seen)) &&
      expressionDerivesExclusivelyFromSymbols(value.whenFalse, sources, checker, new Set(seen))
    );
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return (
      expressionDerivesExclusivelyFromSymbols(value.left, sources, checker, new Set(seen)) &&
      expressionDerivesExclusivelyFromSymbols(value.right, sources, checker, new Set(seen))
    );
  }
  return false;
}

function callableProjectsUnknownOnlyFromSymbols(
  callable: ts.FunctionLikeDeclaration,
  sources: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  if (!callable.body || handlerReturnExpressions(callable).length === 0) return false;
  let safe = true;
  let observedSource = false;
  const visit = (node: ts.Node): void => {
    if (!safe || (node !== callable && ts.isFunctionLike(node))) return;
    if (
      ts.isThrowStatement(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isCallExpression(node) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      ts.isPostfixUnaryExpression(node)
    ) {
      safe = false;
      return;
    }
    const isPropertyName =
      ts.isIdentifier(node) &&
      ((ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
        (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node));
    if (!isPropertyName && ts.isExpression(node) && isUnknown(checker.getTypeAtLocation(node))) {
      if (!expressionDerivesExclusivelyFromSymbols(node, sources, checker)) {
        safe = false;
        return;
      }
      observedSource = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(callable.body);
  return safe && observedSource;
}

function visibleImmutableProjectionCallDerivesFromSymbols(
  expression: ts.Expression,
  sources: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value) || value.arguments.some(ts.isSpreadElement)) return false;
  const callable = immutableCallableExpressionDeclaration(value.expression, checker);
  if (!callable?.body) return false;

  const projectedSources = new Set<ts.Symbol>();
  for (const [index, argument] of value.arguments.entries()) {
    if (!expressionHasUnknownProvenance(argument, checker)) continue;
    if (!expressionDerivesExclusivelyFromSymbols(argument, sources, checker)) return false;
    const parameter = callable.parameters[Math.min(index, callable.parameters.length - 1)];
    if (!parameter) return false;
    const symbol = checker.getSymbolAtLocation(parameter.name);
    if (!symbol) return false;
    projectedSources.add(canonicalSymbol(symbol, checker));
  }
  return (
    projectedSources.size > 0 &&
    callableProjectsUnknownOnlyFromSymbols(callable, projectedSources, checker)
  );
}

function enclosingResultTryCapture(
  node: ts.Node,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): ts.CallExpression | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    const signature = resolvedSignature(checker, current);
    if (
      packageForSignature(signature, packageRoots) === "better-result" &&
      (declarationName(signature?.declaration) === "try" ||
        expressionName(current.expression) === "try") &&
      isDirectImmutableResultCaptureCall(current, checker) &&
      resultCaptureCatchMapper(current, checker)
    ) {
      return current;
    }
  }
  return undefined;
}

function variableSymbolForExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  let current: ts.Node = expression;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAwaitExpression(current.parent) ||
    (ts.isCallExpression(current.parent) &&
      current.parent.arguments.includes(current as ts.Expression))
  ) {
    current = current.parent;
  }
  const declaration = current.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== current)
    return undefined;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  return symbol && canonicalSymbol(symbol, checker);
}

function intrinsicResultCaptureOwnsUnknown(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const derives = (
    candidate: ts.Expression,
    seenSymbols: Set<ts.Symbol>,
    seenCallables: Set<ts.FunctionLikeDeclaration>,
  ): boolean => {
    const value = unwrapExpression(candidate);
    if (ts.isCallExpression(value)) {
      const signature = resolvedSignature(checker, value);
      if (
        packageForSignature(signature, packageRoots) === "better-result" &&
        RESULT_CAPTURE_MEMBERS.has(declarationName(signature?.declaration) ?? "") &&
        isDirectImmutableResultCaptureCall(value, checker) &&
        resultCaptureCatchMapper(value, checker)
      ) {
        return true;
      }
      const matchInput = resultMatchInputExpression(value, signature, checker, packageRoots);
      if (matchInput && derives(matchInput, new Set(seenSymbols), new Set(seenCallables))) {
        return true;
      }
      const called = callableExpressionDeclaration(value.expression, checker);
      if (called?.body && !seenCallables.has(called)) {
        const calledSignature = checker.getSignatureFromDeclaration(called);
        if (
          calledSignature &&
          !isFallibleResultContract(calledSignature.getReturnType(), checker, packageRoots)
        ) {
          const nextCallables = new Set(seenCallables).add(called);
          const returned = handlerReturnExpressions(called);
          if (
            returned.length > 0 &&
            returned.every((result) =>
              derives(result, new Set(seenSymbols), new Set(nextCallables)),
            )
          ) {
            return true;
          }
        }
      }
      const receiver = callReceiver(value);
      if (receiver && derives(receiver, new Set(seenSymbols), new Set(seenCallables))) {
        return true;
      }
      const callee = unwrapExpression(value.expression);
      return (
        ts.isCallExpression(callee) && derives(callee, new Set(seenSymbols), new Set(seenCallables))
      );
    }
    if (ts.isIdentifier(value)) {
      const symbol = checker.getSymbolAtLocation(value);
      if (symbol) {
        const canonical = canonicalSymbol(symbol, checker);
        if (!seenSymbols.has(canonical)) {
          seenSymbols.add(canonical);
          const source = stableSymbolSource(canonical, value, checker);
          if (source && derives(source, seenSymbols, seenCallables)) return true;
        }
      }
    }
    if (ts.isPropertyAccessExpression(value)) {
      return derives(value.expression, seenSymbols, seenCallables);
    }
    if (ts.isElementAccessExpression(value)) {
      return (
        (ts.isStringLiteralLike(value.argumentExpression) ||
          ts.isNumericLiteral(value.argumentExpression)) &&
        derives(value.expression, seenSymbols, seenCallables)
      );
    }
    if (ts.isConditionalExpression(value)) {
      return (
        derives(value.whenTrue, new Set(seenSymbols), new Set(seenCallables)) &&
        derives(value.whenFalse, new Set(seenSymbols), new Set(seenCallables))
      );
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      return (
        derives(value.left, new Set(seenSymbols), new Set(seenCallables)) &&
        derives(value.right, new Set(seenSymbols), new Set(seenCallables))
      );
    }
    return false;
  };
  return derives(expression, new Set(), new Set());
}

function intrinsicResultCatchParameter(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (!ts.isFunctionLike(parameter.parent) || parameter.parent.parameters[0] !== parameter) {
    return false;
  }
  void packageRoots;
  return INTRINSIC_RESULT_CATCH_MAPPERS.get(checker)?.has(parameter.parent) === true;
}

function intrinsicResultCaptureMatchParameter(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (!ts.isFunctionLike(parameter.parent) || parameter.parent.parameters[0] !== parameter) {
    return false;
  }
  void packageRoots;
  return INTRINSIC_RESULT_MATCH_HANDLERS.get(checker)?.has(parameter.parent) === true;
}

function intrinsicResultClassifierParameter(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): boolean {
  return INTRINSIC_RESULT_CLASSIFIER_PARAMETERS.get(checker)?.has(parameter) === true;
}

function intrinsicResultBoundaryOwnsUnknown(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  for (let owner: ts.Node | undefined = expression; owner; owner = owner.parent) {
    if (!isImplementedCallable(owner)) continue;
    const sources = new Set<ts.Symbol>();
    for (const parameter of owner.parameters) {
      if (
        !intrinsicResultCatchParameter(parameter, checker, packageRoots) &&
        !intrinsicResultCaptureMatchParameter(parameter, checker, packageRoots) &&
        !intrinsicResultClassifierParameter(parameter, checker)
      ) {
        continue;
      }
      const symbol = checker.getSymbolAtLocation(parameter.name);
      if (symbol) sources.add(canonicalSymbol(symbol, checker));
    }
    if (sources.size > 0) {
      if (expressionDerivesExclusivelyFromSymbols(expression, sources, checker)) return true;
      if (visibleImmutableProjectionCallDerivesFromSymbols(expression, sources, checker)) {
        return true;
      }
    }
  }
  return false;
}

function indexIntrinsicResultUnknownBoundaries(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): void {
  const calls = sourceFiles.flatMap((sourceFile) => [...sourceAnalysisIndex(sourceFile).calls]);
  const catchMappers = new Set<ts.SignatureDeclaration>();
  for (const call of calls) {
    const signature = resolvedSignature(checker, call);
    if (
      packageForSignature(signature, packageRoots) !== "better-result" ||
      !RESULT_CAPTURE_MEMBERS.has(declarationName(signature?.declaration) ?? "") ||
      !isDirectImmutableResultCaptureCall(call, checker)
    ) {
      continue;
    }
    const mapper = resultCaptureCatchMapper(call, checker);
    if (mapper) catchMappers.add(mapper);
  }
  INTRINSIC_RESULT_CATCH_MAPPERS.set(checker, catchMappers);

  const matchHandlers = new Set<ts.SignatureDeclaration>();
  for (const call of calls) {
    const signature = resolvedSignature(checker, call);
    const member = declarationName(signature?.declaration) ?? expressionName(call.expression);
    if (packageForSignature(signature, packageRoots) !== "better-result") continue;
    if (member === "mapError") {
      const selected = selectedProperty(call.expression);
      const handlerExpression = call.arguments[0];
      if (
        !selected ||
        selected.name !== "mapError" ||
        !handlerExpression ||
        ts.isSpreadElement(handlerExpression) ||
        !intrinsicResultCaptureOwnsUnknown(selected.receiver, checker, packageRoots)
      ) {
        continue;
      }
      const handler = callableExpressionDeclaration(handlerExpression, checker);
      if (handler) matchHandlers.add(handler);
      continue;
    }
    if (member !== "match") {
      continue;
    }
    const receiver = resultMatchInputExpression(call, signature, checker, packageRoots);
    const handlers = resultMatchHandlersArgument(call, signature, checker, packageRoots);
    if (
      !receiver ||
      !handlers ||
      ts.isSpreadElement(handlers) ||
      !intrinsicResultCaptureOwnsUnknown(receiver, checker, packageRoots)
    ) {
      continue;
    }
    for (const branch of ["ok", "err"] as const) {
      const handler = resultMatchHandler(handlers, branch, checker);
      if (handler) matchHandlers.add(handler);
    }
  }
  INTRINSIC_RESULT_MATCH_HANDLERS.set(checker, matchHandlers);

  const classifierCalls = new Map<ts.ParameterDeclaration, { safe: boolean; unsafe: boolean }>();
  for (const call of calls) {
    const argument = call.arguments[0];
    if (!argument || ts.isSpreadElement(argument)) continue;
    const called = callableExpressionDeclaration(call.expression, checker);
    if (!called?.body || !ts.isFunctionDeclaration(called) || hasExportModifier(called)) continue;
    const parameter = called.parameters[0];
    if (!parameter || !isUnknown(checker.getTypeAtLocation(parameter))) continue;
    const state = classifierCalls.get(parameter) ?? { safe: false, unsafe: false };
    if (
      intrinsicResultCaptureOwnsUnknown(argument, checker, packageRoots) ||
      intrinsicResultBoundaryOwnsUnknown(argument, checker, packageRoots)
    ) {
      state.safe = true;
    } else {
      state.unsafe = true;
    }
    classifierCalls.set(parameter, state);
  }
  INTRINSIC_RESULT_CLASSIFIER_PARAMETERS.set(
    checker,
    new Set(
      [...classifierCalls].flatMap(([parameter, state]) =>
        state.safe && !state.unsafe ? [parameter] : [],
      ),
    ),
  );
}

function capturedCauseSymbols(
  adapter: ts.Node,
  capture: ts.CallExpression,
  checker: ts.TypeChecker,
): ReadonlySet<ts.Symbol> {
  const captureSymbol = variableSymbolForExpression(capture, checker);
  if (!captureSymbol) return new Set();
  const sources = new Set([captureSymbol]);
  const causes = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const initializer = unwrapExpression(node.initializer);
      const property =
        ts.isPropertyAccessExpression(initializer) && initializer.name.text === "cause"
          ? initializer
          : undefined;
      if (property && expressionDerivesFromSymbols(property.expression, sources, checker)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) causes.add(canonicalSymbol(symbol, checker));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(adapter);
  return causes;
}

function expressionDerivesFromCapturedCause(
  expression: ts.Expression,
  capture: ts.CallExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  const captureSymbol = variableSymbolForExpression(capture, checker);
  if (!captureSymbol) return false;
  const value = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(value) &&
    value.name.text === "cause" &&
    expressionDerivesFromSymbols(value.expression, new Set([captureSymbol]), checker)
  ) {
    return true;
  }
  if (ts.isIdentifier(value)) {
    const symbol = checker.getSymbolAtLocation(value);
    if (symbol) {
      const canonical = canonicalSymbol(symbol, checker);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        const source = stableSymbolSource(canonical, value, checker);
        if (source && expressionDerivesFromCapturedCause(source, capture, checker, seen))
          return true;
      }
    }
  }
  if (ts.isPropertyAccessExpression(value)) {
    return expressionDerivesFromCapturedCause(value.expression, capture, checker, seen);
  }
  if (ts.isElementAccessExpression(value)) {
    return (
      (ts.isStringLiteralLike(value.argumentExpression) ||
        ts.isNumericLiteral(value.argumentExpression)) &&
      expressionDerivesFromCapturedCause(value.expression, capture, checker, seen)
    );
  }
  if (ts.isConditionalExpression(value)) {
    return (
      expressionDerivesFromCapturedCause(value.whenTrue, capture, checker, new Set(seen)) &&
      expressionDerivesFromCapturedCause(value.whenFalse, capture, checker, new Set(seen))
    );
  }
  return false;
}

function symbolsAssignedWithin(node: ts.Node, checker: ts.TypeChecker): ReadonlySet<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  const visit = (current: ts.Node): void => {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapExpression(current.left))
    ) {
      const symbol = checker.getSymbolAtLocation(unwrapExpression(current.left));
      if (symbol) symbols.add(canonicalSymbol(symbol, checker));
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return symbols;
}

function symbolsDerivedWithin(
  node: ts.Node,
  sources: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
): ReadonlySet<ts.Symbol> {
  const derived = new Set(sources);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (current: ts.Node): void => {
      if (
        ts.isVariableDeclaration(current) &&
        ts.isIdentifier(current.name) &&
        current.initializer &&
        expressionDerivesExclusivelyFromSymbols(current.initializer, derived, checker)
      ) {
        const symbol = checker.getSymbolAtLocation(current.name);
        if (symbol && !symbolIsMutated(symbol, current.getSourceFile(), checker)) {
          const canonical = canonicalSymbol(symbol, checker);
          if (!derived.has(canonical)) {
            derived.add(canonical);
            changed = true;
          }
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
  }
  return derived;
}

function analyzeSqliteTransactionAdapter(
  registration: SqliteTransactionAdapterRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const adapter = requireOneRegisteredNode(
    "SQLite transaction adapter",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isCallableImplementation,
  );
  const sentinel = requireOneRegisteredNode(
    "SQLite rollback sentinel",
    registration.rollbackSentinel,
    workspace,
    workspaceRoot,
    program,
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name !== undefined,
  );
  const classifier = requireOneRegisteredNode(
    "SQLite driver error classifier",
    registration.driverErrorClassifier,
    workspace,
    workspaceRoot,
    program,
    isCallableImplementation,
  );
  const adapterSignature = checker.getSignatureFromDeclaration(adapter);
  const database = adapter.parameters[registration.databaseParameter];
  const operation = adapter.parameters[registration.operationParameter];
  const operationSignature = operation
    ? checker.getSignaturesOfType(checker.getTypeAtLocation(operation), ts.SignatureKind.Call)[0]
    : undefined;
  const classifierSignature = checker.getSignatureFromDeclaration(classifier);
  const classifierInput = classifier.parameters[0];
  const classifierReturn = classifierSignature?.getReturnType();
  let transactionCall: ts.CallExpression | undefined;
  let transactionCallback: ts.FunctionLikeDeclaration | undefined;
  let sentinelThrow = false;
  let sentinelCheck = false;
  const storedSentinelSymbols = new Set<ts.Symbol>();
  const panicClassifierCalls: ts.CallExpression[] = [];
  const driverClassifierCalls: ts.CallExpression[] = [];
  const ordinaryClassificationPositions: number[] = [];
  let unknownRethrow = false;
  let atomicityUnknown = false;
  const sentinelSymbol = sentinel.name && checker.getSymbolAtLocation(sentinel.name);
  const findTransaction = (node: ts.Node): void => {
    if (transactionCall || !ts.isCallExpression(node)) {
      ts.forEachChild(node, findTransaction);
      return;
    }
    const signature = resolvedSignature(checker, node);
    if (
      packageForSignature(signature, packageRoots) === "bun:sqlite" &&
      declarationName(signature?.declaration) === "transaction"
    ) {
      transactionCall = node;
      const callback = node.arguments[0];
      if (callback && !ts.isSpreadElement(callback)) {
        transactionCallback = callableExpressionDeclaration(callback, checker);
      }
      return;
    }
    ts.forEachChild(node, findTransaction);
  };
  findTransaction(adapter);
  const capture =
    transactionCall && enclosingResultTryCapture(transactionCall, checker, packageRoots);
  const causeSymbols = capture
    ? capturedCauseSymbols(adapter, capture, checker)
    : new Set<ts.Symbol>();
  const causeDataSymbols = symbolsDerivedWithin(adapter, causeSymbols, checker);
  const callbackStateSymbols = transactionCallback
    ? symbolsAssignedWithin(transactionCallback, checker)
    : new Set<ts.Symbol>();
  const expressionIsExactCapturedCause = (expression: ts.Expression): boolean => {
    const value = unwrapExpression(expression);
    if (!ts.isIdentifier(value)) return false;
    const symbol = checker.getSymbolAtLocation(value);
    return Boolean(
      symbol &&
      causeDataSymbols.has(canonicalSymbol(symbol, checker)) &&
      !symbolIsMutated(symbol, value.getSourceFile(), checker),
    );
  };
  const expressionIsCapturedCause = (expression: ts.Expression): boolean =>
    expressionDerivesExclusivelyFromSymbols(expression, causeDataSymbols, checker) ||
    (capture !== undefined && expressionDerivesFromCapturedCause(expression, capture, checker));
  const expressionIsSentinel = (expression: ts.Expression): boolean => {
    if (!sentinelSymbol) return false;
    const value = unwrapExpression(expression);
    if (ts.isNewExpression(value)) {
      const symbol = checker.getSymbolAtLocation(value.expression);
      return Boolean(
        symbol && canonicalSymbol(symbol, checker) === canonicalSymbol(sentinelSymbol, checker),
      );
    }
    return typeContainsExactSymbol(checker.getTypeAtLocation(value), sentinelSymbol, checker);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const argument = node.arguments[0];
      if (
        externalCallMatches(node, registration.panicClassifier, checker, packageRoots) &&
        argument &&
        !ts.isSpreadElement(argument) &&
        expressionIsExactCapturedCause(argument)
      ) {
        panicClassifierCalls.push(node);
      }
      if (
        resolvedCallMatchesIdentity(
          node,
          registration.driverErrorClassifier,
          checker,
          workspaceRoot,
          packageRoots,
        ) &&
        argument &&
        !ts.isSpreadElement(argument) &&
        expressionIsExactCapturedCause(argument)
      ) {
        driverClassifierCalls.push(node);
      }
    }
    if (
      transactionCallback &&
      nodeIsWithin(node, transactionCallback) &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapExpression(node.left)) &&
      ts.isNewExpression(unwrapExpression(node.right)) &&
      expressionIsSentinel(node.right)
    ) {
      const created = unwrapExpression(node.right) as ts.NewExpression;
      const logicalResult = created.arguments?.[0];
      if (logicalResult && ts.isIdentifier(unwrapExpression(logicalResult))) {
        const resultIdentifier = unwrapExpression(logicalResult) as ts.Identifier;
        const resultSymbol = checker.getSymbolAtLocation(resultIdentifier);
        const resultSource =
          resultSymbol &&
          stableSymbolSource(canonicalSymbol(resultSymbol, checker), resultIdentifier, checker);
        const operationSymbol = operation && checker.getSymbolAtLocation(operation.name);
        const resultValue = resultSource && unwrapExpression(resultSource);
        const callsOperation =
          resultValue &&
          ts.isCallExpression(resultValue) &&
          operationSymbol &&
          checker.getSymbolAtLocation(resultValue.expression) === operationSymbol;
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isIfStatement(parent) && parent !== transactionCallback) {
          parent = parent.parent;
        }
        if (
          callsOperation &&
          resultSymbol &&
          parent &&
          ts.isIfStatement(parent) &&
          parent.expression.getText().includes('"error"') &&
          expressionDerivesFromSymbols(
            parent.expression,
            new Set([canonicalSymbol(resultSymbol, checker)]),
            checker,
          )
        ) {
          const stored = checker.getSymbolAtLocation(unwrapExpression(node.left));
          if (stored) storedSentinelSymbols.add(canonicalSymbol(stored, checker));
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    ) {
      if (
        expressionIsCapturedCause(node.left) &&
        unwrapExpression(node.right).getText() === "Error"
      ) {
        ordinaryClassificationPositions.push(nodeStart(node));
      }
      const symbol = checker.getSymbolAtLocation(unwrapExpression(node.right));
      if (
        sentinelSymbol &&
        expressionIsCapturedCause(node.left) &&
        symbol &&
        canonicalSymbol(symbol, checker) === canonicalSymbol(sentinelSymbol!, checker)
      ) {
        sentinelCheck = true;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      ((expressionIsCapturedCause(node.left) && expressionIsSentinel(node.right)) ||
        (expressionIsCapturedCause(node.right) && expressionIsSentinel(node.left)))
    ) {
      sentinelCheck = true;
    }
    if (ts.isThrowStatement(node)) {
      const expression = unwrapExpression(node.expression);
      if (
        transactionCallback &&
        nodeIsWithin(node, transactionCallback) &&
        ts.isIdentifier(expression)
      ) {
        const symbol = checker.getSymbolAtLocation(expression);
        if (symbol && storedSentinelSymbols.has(canonicalSymbol(symbol, checker))) {
          sentinelThrow = true;
        }
      }
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression);
        if (symbol && expressionIsCapturedCause(expression)) unknownRethrow = true;
      }
    }
    if (ts.isNewExpression(node)) {
      const symbol = checker.getSymbolAtLocation(unwrapExpression(node.expression));
      if (
        symbol &&
        symbolComesFromPackage(canonicalSymbol(symbol, checker), "better-result", packageRoots) &&
        canonicalSymbol(symbol, checker).getName() === "Panic" &&
        node.getText().includes("atomicity is unknown")
      ) {
        let thrown: ts.Node | undefined = node.parent;
        while (thrown && !ts.isThrowStatement(thrown) && thrown !== adapter) {
          thrown = thrown.parent;
        }
        if (!thrown || !ts.isThrowStatement(thrown)) {
          ts.forEachChild(node, visit);
          return;
        }
        let parent: ts.Node | undefined = thrown.parent;
        while (parent && !ts.isIfStatement(parent) && parent !== adapter) parent = parent.parent;
        if (
          parent &&
          ts.isIfStatement(parent) &&
          expressionDerivesFromSymbols(parent.expression, callbackStateSymbols, checker)
        ) {
          atomicityUnknown = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(adapter);
  let panicControl = false;
  let panicControlPosition = Number.POSITIVE_INFINITY;
  let driverClassifierReturn = false;
  const sameCanonicalExpression = (left: ts.Expression, right: ts.Expression): boolean => {
    const leftValue = unwrapExpression(left);
    const rightValue = unwrapExpression(right);
    if (!ts.isIdentifier(leftValue) || !ts.isIdentifier(rightValue)) return false;
    const leftSymbol = checker.getSymbolAtLocation(leftValue);
    const rightSymbol = checker.getSymbolAtLocation(rightValue);
    return Boolean(
      leftSymbol &&
      rightSymbol &&
      canonicalSymbol(leftSymbol, checker) === canonicalSymbol(rightSymbol, checker),
    );
  };
  const panicClassifierControls = (condition: ts.Expression, call: ts.CallExpression): boolean => {
    const value = unwrapExpression(condition);
    if (value === call) return true;
    if (!ts.isIdentifier(value)) return false;
    const symbol = checker.getSymbolAtLocation(value);
    const source = symbol && stableSymbolSource(canonicalSymbol(symbol, checker), value, checker);
    return Boolean(source && unwrapExpression(source) === call);
  };
  const branchGuaranteesThrow = (branch: ts.Statement, thrown: ts.ThrowStatement): boolean => {
    if (branch === thrown) return true;
    return (
      ts.isBlock(branch) &&
      branch.statements.length === 1 &&
      branchGuaranteesThrow(branch.statements[0]!, thrown)
    );
  };
  const proveClassifierFlow = (node: ts.Node): void => {
    if (ts.isThrowStatement(node) && expressionIsCapturedCause(node.expression)) {
      for (
        let parent: ts.Node | undefined = node.parent;
        parent && parent !== adapter;
        parent = parent.parent
      ) {
        if (ts.isIfStatement(parent) && branchGuaranteesThrow(parent.thenStatement, node)) {
          const controlled = panicClassifierCalls.some((call) => {
            const argument = call.arguments[0];
            return Boolean(
              argument &&
              !ts.isSpreadElement(argument) &&
              sameCanonicalExpression(argument, node.expression) &&
              panicClassifierControls(parent.expression, call),
            );
          });
          if (!controlled) continue;
          panicControl = true;
          panicControlPosition = Math.min(panicControlPosition, nodeStart(node));
          break;
        }
      }
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const returned = unwrapExpression(node.expression);
      if (
        ts.isCallExpression(returned) &&
        externalCallMatches(
          returned,
          { package: "better-result", exportName: "Result.err" },
          checker,
          packageRoots,
        )
      ) {
        const error = returned.arguments[0];
        if (
          error &&
          !ts.isSpreadElement(error) &&
          driverClassifierCalls.some((call) => {
            const symbol = variableSymbolForExpression(call, checker);
            const value = unwrapExpression(error);
            if (!symbol || !ts.isIdentifier(value)) return false;
            const errorSymbol = checker.getSymbolAtLocation(value);
            if (!errorSymbol || canonicalSymbol(errorSymbol, checker) !== symbol) return false;
            const declarations = symbol.declarations ?? [];
            if (declarations.length !== 1) return false;
            const declaration = declarations[0];
            return Boolean(
              declaration &&
              ts.isVariableDeclaration(declaration) &&
              (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
              declaration.initializer &&
              unwrapExpression(declaration.initializer) === call &&
              !symbolIsMutated(symbol, value.getSourceFile(), checker),
            );
          })
        ) {
          driverClassifierReturn = true;
        }
      }
    }
    ts.forEachChild(node, proveClassifierFlow);
  };
  proveClassifierFlow(adapter);
  const firstOrdinaryClassification = Math.min(
    ...driverClassifierCalls.map(nodeStart),
    ...ordinaryClassificationPositions,
  );
  if (panicControlPosition >= firstOrdinaryClassification) panicControl = false;
  const transactionCallbackReturn = transactionCallback
    ? checker.getSignatureFromDeclaration(transactionCallback)?.getReturnType()
    : undefined;
  const invalidFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
  const failures = [
    database &&
    typeIsPackageType(
      checker.getTypeAtLocation(database),
      "bun:sqlite",
      new Set(["Database"]),
      packageRoots,
    )
      ? undefined
      : "registered database parameter is not bun:sqlite Database",
    operationSignature && isDirectResultType(operationSignature.getReturnType(), packageRoots)
      ? undefined
      : "registered operation callback does not return Result",
    adapterSignature && isDirectResultType(adapterSignature.getReturnType(), packageRoots)
      ? undefined
      : "adapter does not return a direct Result",
    transactionCall ? undefined : "adapter does not call bun:sqlite Database.transaction",
    capture ? undefined : "raw driver call is not captured by object-form Result.try",
    transactionCallbackReturn &&
    !typeContainsResult(transactionCallbackReturn, checker, packageRoots, transactionCallback!)
      ? undefined
      : "raw driver callback returns Result",
    sentinelThrow ? undefined : "raw driver callback does not throw the rollback sentinel",
    sentinelCheck ? undefined : "adapter does not recognize the exact rollback sentinel",
    panicControl
      ? undefined
      : "exact Panic classifier result does not control rethrow of the captured cause",
    driverClassifierReturn
      ? undefined
      : "returned driver Err does not derive from the exact SQLite driver classifier result",
    unknownRethrow ? undefined : "adapter does not rethrow unknown defects",
    atomicityUnknown ? undefined : "adapter does not escalate unknown transaction atomicity",
    !hasExportModifier(sentinel) ? undefined : "rollback sentinel is exported instead of private",
    classifierInput &&
    (checker.getTypeAtLocation(classifierInput).flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ===
      0
      ? undefined
      : "driver classifier input is missing or untyped",
    classifierReturn &&
    !typeContainsFlags(classifierReturn, invalidFlags, checker, classifier, {
      inspectMethodProperties: false,
      seen: new Set(),
      remainingProperties: MAX_VISITED_PROPERTIES,
    })
      ? undefined
      : "driver classifier return is not a closed specific type",
  ].filter((failure): failure is string => failure !== undefined);
  if (failures.length === 0) return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/sqlite-transaction-adapter-contract",
      adapter,
      `SQLite transaction adapter ${registration.identity.exportName} is invalid: ${failures.join("; ")}.`,
      "Use one private rollback sentinel inside the raw callback, preserve Panic exactly, map only classified driver failures, and rethrow unknown defects.",
    ),
  );
}

function analyzeSqliteTransactionConsumer(
  registration: SqliteTransactionConsumerRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const owner = requireOneRegisteredNode(
    "SQLite transaction consumer",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isCallableImplementation,
  );
  if (registeredOwnerCalls(owner, registration.adapter, checker, workspaceRoot, packageRoots))
    return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/sqlite-transaction-consumer",
      owner,
      `SQLite transaction consumer ${registration.identity.exportName} does not call registered adapter ${registeredIdentityKey(registration.adapter)}.`,
      "Route the transaction through the registered Result adapter; do not call the raw driver transaction API directly.",
    ),
  );
}

function messageTypeIsUnknown(
  type: ts.Type,
  registration: RawEventMessageBoundaryRegistration,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const direct = typeIsPackageType(
    type,
    registration.messageType.package,
    new Set([registration.messageType.exportName]),
    packageRoots,
  );
  const argument = type.aliasTypeArguments?.[0];
  if (direct) return argument !== undefined && isUnknown(argument);
  return (
    type.isUnion() &&
    type.types.some((member) => messageTypeIsUnknown(member, registration, packageRoots))
  );
}

function messageTypeContainsSpecialization(
  type: ts.Type,
  registration: RawEventMessageBoundaryRegistration,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const direct = typeIsPackageType(
    type,
    registration.messageType.package,
    new Set([registration.messageType.exportName]),
    packageRoots,
  );
  if (direct) {
    const argument = type.aliasTypeArguments?.[0];
    return argument === undefined || !isUnknown(argument);
  }
  return (
    type.isUnion() &&
    type.types.some((member) =>
      messageTypeContainsSpecialization(member, registration, packageRoots),
    )
  );
}

function typeNodeSpecializesMessage(
  node: ts.TypeNode,
  registration: RawEventMessageBoundaryRegistration,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  if (!ts.isTypeReferenceNode(node) || node.typeArguments?.length !== 1) return false;
  const type = checker.getTypeFromTypeNode(node);
  if (
    !typeIsPackageType(
      type,
      registration.messageType.package,
      new Set([registration.messageType.exportName]),
      packageRoots,
    )
  ) {
    return false;
  }
  return node.typeArguments[0]?.kind !== ts.SyntaxKind.UnknownKeyword;
}

function analyzeRawEventMessageBoundary(
  registration: RawEventMessageBoundaryRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const declaration = requireOneRegisteredNode(
    "Raw event message boundary",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isNamedCallableDeclaration,
  );
  const handler = declaration.parameters[registration.handlerParameter];
  const handlerSignature = handler
    ? checker.getSignaturesOfType(checker.getTypeAtLocation(handler), ts.SignatureKind.Call)[0]
    : undefined;
  const message = handlerSignature?.parameters[registration.messageParameter];
  const messageDeclaration = message?.valueDeclaration ?? message?.declarations?.[0];
  const messageType = messageDeclaration
    ? checker.getTypeOfSymbolAtLocation(message!, messageDeclaration)
    : undefined;
  const context = handlerSignature?.parameters[registration.contextParameter];
  const contextDeclaration = context?.valueDeclaration ?? context?.declarations?.[0];
  const contextType = contextDeclaration
    ? checker.getTypeOfSymbolAtLocation(context!, contextDeclaration)
    : undefined;
  const failures = [
    declaration.typeParameters?.length ? "raw receive API is generic" : undefined,
    contextType && !checker.getPropertyOfType(contextType, "commit")
      ? undefined
      : "raw handler context exposes commit",
  ].filter((failure): failure is string => failure !== undefined);
  if (
    !messageType ||
    !messageTypeIsUnknown(messageType, registration, packageRoots) ||
    messageTypeContainsSpecialization(messageType, registration, packageRoots)
  ) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/raw-event-message-boundary",
        handler ?? declaration,
        `Raw event boundary ${registration.identity.exportName} does not receive the registered Message<unknown> type.`,
        "Expose decoded transport messages as Message<unknown>; specialize payloads only after codec validation.",
      ),
    );
  }
  if (failures.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/raw-event-message-boundary",
        handler ?? declaration,
        `Raw event boundary ${registration.identity.exportName} is invalid: ${failures.join("; ")}.`,
        "Use a non-generic Message<unknown> receive boundary with transport-owned acknowledgement.",
      ),
    );
  }
  const container = declaration.parent;
  if (ts.isInterfaceDeclaration(container) || ts.isClassDeclaration(container)) {
    const legacy = container.members.find((member) => {
      if (!ts.isMethodSignature(member) && !ts.isMethodDeclaration(member)) return false;
      const name = member.name;
      return (
        (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "subscribeDelivery"
      );
    });
    if (legacy) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/raw-event-message-boundary",
          legacy,
          `Legacy raw event delivery API ${legacy.name?.getText() ?? "<unknown>"} remains declared beside the enforced receive boundary.`,
          "Remove legacy raw subscription aliases and keep one non-generic transport-owned delivery API.",
        ),
      );
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      typeNodeSpecializesMessage(node.type, registration, checker, packageRoots)
    ) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/raw-event-message-boundary",
          node,
          `Raw event boundary ${registration.identity.exportName} specializes a message through an assertion.`,
          "Keep Message<unknown> through the raw receive boundary and invoke a registered codec before specialization.",
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
}

function isTypedHandlerResult(
  type: ts.Type,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (symbolName !== "Promise") return false;
  const result = typeArguments(type, checker)[0];
  if (!result || !isDirectResultType(result, packageRoots)) return false;
  const resultArguments = result.aliasTypeArguments ?? typeArguments(result, checker);
  const success = resultArguments[0];
  const error = resultArguments[1];
  return Boolean(
    success &&
    (success.flags & ts.TypeFlags.Void) !== 0 &&
    error &&
    (error.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) === 0,
  );
}

function analyzeEventDeliveryHandler(
  registration: EventDeliveryApiRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): ts.SignatureDeclaration {
  const declaration = requireOneRegisteredNode(
    "Event delivery API",
    registration.identity,
    workspace,
    workspaceRoot,
    program,
    isNamedCallableDeclaration,
  );
  const handler = declaration.parameters[registration.handlerParameter];
  const handlerSignature = handler
    ? checker.getSignaturesOfType(checker.getTypeAtLocation(handler), ts.SignatureKind.Call)[0]
    : undefined;
  const returnType = handlerSignature?.getReturnType();
  const context = handlerSignature?.parameters[registration.handlerContextParameter];
  const contextDeclaration = context?.valueDeclaration ?? context?.declarations?.[0];
  const contextType = contextDeclaration
    ? checker.getTypeOfSymbolAtLocation(context!, contextDeclaration)
    : undefined;
  const failures = [
    returnType && isTypedHandlerResult(returnType, checker, packageRoots)
      ? undefined
      : "handler does not return Promise<Result<void, E>> with a typed error",
    contextType && !checker.getPropertyOfType(contextType, "commit")
      ? undefined
      : "handler context exposes commit",
    handlerSignature?.parameters[registration.handlerMessageParameter]
      ? undefined
      : "registered handler message parameter does not exist",
  ].filter((failure): failure is string => failure !== undefined);
  if (failures.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        workspace,
        workspaceRoot,
        "architecture/event-handler-result",
        handler ?? declaration,
        `Event delivery API ${registration.identity.exportName} is invalid: ${failures.join("; ")}.`,
        "Use a decoded-message handler returning Promise<Result<void, E>> and keep acknowledgement out of handler context.",
      ),
    );
  }
  const container = declaration.parent;
  if (ts.isInterfaceDeclaration(container) || ts.isClassDeclaration(container)) {
    const forbidden = new Set(["subscribeTopicResult", "fetchTopicResult", "subscribeType"]);
    const legacy = container.members.find((member) => {
      if (!ts.isMethodSignature(member) && !ts.isMethodDeclaration(member)) return false;
      const name = member.name;
      return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && forbidden.has(name.text);
    });
    if (legacy) {
      diagnostics.push(
        makeDiagnostic(
          workspace,
          workspaceRoot,
          "architecture/event-handler-result",
          legacy,
          `Legacy event delivery API ${legacy.name?.getText() ?? "<unknown>"} remains declared beside the enforced Result API.`,
          "Remove legacy handler-owned or pre-final Result API aliases instead of preserving compatibility shims.",
        ),
      );
    }
  }
  return declaration;
}

function switchUsesParameter(
  node: ts.SwitchStatement,
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isIdentifier(parameter.name)) return false;
  if (expressionDerivesFromSwitch(node.expression, parameter.name, checker)) return true;
  const selected = selectedProperty(node.expression);
  return Boolean(
    selected && expressionDerivesFromSwitch(selected.receiver, parameter.name, checker),
  );
}

function deliveryPolicySwitchIssue(
  node: ts.SwitchStatement,
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): string | undefined {
  const parameterType = checker.getTypeAtLocation(parameter);
  const domain =
    switchDomain(node, checker, packageRoots) ??
    literalDomain(
      checker.getTypeAtLocation(node.expression),
      checker,
      packageRoots,
      parameterType,
      typeIsProjectOwned(parameterType, checker, packageRoots),
    );
  if (!domain) return "delivery error is not a project-owned closed union";
  const handled = new Set<string>();
  let defaultClause: ts.DefaultClause | undefined;
  for (const clause of node.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      defaultClause = clause;
      continue;
    }
    const key = literalKey(checker.getTypeAtLocation(clause.expression), checker);
    if (key) handled.add(key[0]);
  }
  const missing = [...domain.keys]
    .filter(([key]) => !handled.has(key))
    .map(([, display]) => display);
  if (missing.length > 0) return `missing ${missing.join(", ")}`;
  if (defaultClause && !defaultContainsNeverSink(defaultClause, node.expression, checker)) {
    return "uses a silent default";
  }
  return undefined;
}

function analyzeEventDeliveryPolicy(
  registration: EventDeliveryApiRegistration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const policy = requireOneRegisteredNode(
    "Event delivery policy",
    registration.deliveryPolicy,
    workspace,
    workspaceRoot,
    program,
    isNamedCallableDeclaration,
  );
  const error = policy.parameters[registration.deliveryErrorParameter];
  const switches: ts.SwitchStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== policy && ts.isFunctionLike(node)) return;
    if (error && ts.isSwitchStatement(node) && switchUsesParameter(node, error, checker)) {
      switches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(policy);
  const issues = switches.map((node) =>
    deliveryPolicySwitchIssue(node, error!, checker, packageRoots),
  );
  if (switches.length > 0 && issues.every((issue) => issue === undefined)) return;
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/event-delivery-policy-exhaustiveness",
      switches.find((_node, index) => issues[index] !== undefined) ?? error ?? policy,
      `Event delivery policy ${registration.deliveryPolicy.exportName} is not exhaustive: ${issues.find((issue) => issue !== undefined) ?? "no switch over the registered error parameter"}.`,
      "Map every delivery error variant explicitly to commit, retry, park-pending, dead-letter, or stop without a silent default.",
    ),
  );
}

function assertEventDeliveryConsumersResolve(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  activeEventDeliveryApiPackages: ReadonlySet<string>,
): void {
  for (const registration of workspace.eventDeliveryConsumers) {
    const owner = requireOneRegisteredNode(
      "Event delivery consumer",
      registration.identity,
      workspace,
      workspaceRoot,
      program,
      isCallableImplementation,
    );
    const actual = new Set<EventDeliveryConsumerRegistration["operations"][number]>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const operation = expressionName(node.expression);
        if (operation === "subscribeTopic" || operation === "fetchTopic") {
          const signature = resolvedSignature(checker, node);
          if (packageForSignature(signature, packageRoots) === registration.apiPackage) {
            actual.add(operation);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(owner);
    const missing = registration.operations.filter((operation) => !actual.has(operation));
    const undeclared = [...actual].filter(
      (operation) => !registration.operations.includes(operation),
    );
    if (missing.length > 0 || undeclared.length > 0) {
      throw new Error(
        `Event delivery consumer ${workspace.name}/${registration.identity.module}#${registration.identity.exportName} operation registration drifted; missing ${missing.join(", ") || "none"}; undeclared ${undeclared.join(", ") || "none"}.`,
      );
    }
  }
  if (activeEventDeliveryApiPackages.size === 0) return;
  for (const sourceFile of productionSourceIndex(program, workspaceRoot).files) {
    for (const node of sourceAnalysisIndex(sourceFile).calls) {
      const operation = expressionName(node.expression);
      if (operation === "subscribeTopic" || operation === "fetchTopic") {
        const signature = resolvedSignature(checker, node);
        const apiPackage = packageForSignature(signature, packageRoots);
        if (apiPackage && activeEventDeliveryApiPackages.has(apiPackage)) {
          const identity = nodeIdentity(node, workspaceRoot);
          const registered = workspace.eventDeliveryConsumers.some(
            (registration) =>
              registration.apiPackage === apiPackage &&
              registration.operations.includes(operation) &&
              identityOwns(registration.identity, identity),
          );
          if (!registered) {
            throw new Error(
              `Unregistered event delivery consumer in ${workspace.name}: ${identity.module}#${identity.symbolPath} calls ${apiPackage}#${operation}.`,
            );
          }
        }
      }
    }
  }
}

function analyzeRegisteredEventInfrastructure(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  for (const registration of workspace.eventCodecRegistries) {
    if (
      ruleApplies(
        workspace,
        "architecture/complete-event-codec-registry",
        registration.identity.module,
      )
    ) {
      analyzeEventCodecRegistry(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.toolCodecRegistries) {
    if (
      ruleApplies(
        workspace,
        "architecture/complete-tool-codec-registry",
        registration.identity.module,
      )
    ) {
      analyzeToolCodecRegistry(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.resultDecoders) {
    if (
      ruleApplies(workspace, "architecture/result-decoder-contract", registration.identity.module)
    ) {
      analyzeResultDecoder(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.unknownFreeModules) {
    if (ruleApplies(workspace, "architecture/unknown-free-module", registration.module)) {
      analyzeUnknownFreeModule(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.persistedCodecs) {
    if (
      ruleApplies(
        workspace,
        "architecture/persisted-codec-contract",
        registration.identity.module,
      ) ||
      ruleApplies(
        workspace,
        "architecture/persisted-codec-fixture-catalog",
        registration.identity.module,
      )
    ) {
      analyzePersistedCodec(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.persistedStoreConsumers) {
    if (
      ruleApplies(workspace, "architecture/persisted-codec-contract", registration.identity.module)
    ) {
      analyzePersistedStoreConsumer(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.sqliteTransactionAdapters) {
    if (
      ruleApplies(
        workspace,
        "architecture/sqlite-transaction-adapter-contract",
        registration.identity.module,
      )
    ) {
      analyzeSqliteTransactionAdapter(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.sqliteTransactionConsumers) {
    if (
      ruleApplies(
        workspace,
        "architecture/sqlite-transaction-consumer",
        registration.identity.module,
      )
    ) {
      analyzeSqliteTransactionConsumer(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.rawEventMessageBoundaries) {
    if (
      ruleApplies(
        workspace,
        "architecture/raw-event-message-boundary",
        registration.identity.module,
      )
    ) {
      analyzeRawEventMessageBoundary(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
  }
  for (const registration of workspace.eventDeliveryApis) {
    if (ruleApplies(workspace, "architecture/event-handler-result", registration.identity.module)) {
      analyzeEventDeliveryHandler(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
    if (
      ruleApplies(
        workspace,
        "architecture/event-delivery-policy-exhaustiveness",
        registration.deliveryPolicy.module,
      )
    ) {
      analyzeEventDeliveryPolicy(
        registration,
        checker,
        workspace,
        workspaceRoot,
        program,
        packageRoots,
        diagnostics,
      );
    }
  }
}

function assertOpenProtocolAdaptersResolve(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
): void {
  for (const adapter of workspace.openProtocolAdapters) {
    const matches = registeredNodes(
      adapter.identity,
      workspaceRoot,
      program,
      isImplementedCallable,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Open-protocol adapter ${workspace.name}/${adapter.identity.module}#${adapter.identity.exportName} must resolve to exactly one callable implementation; found ${matches.length}.`,
      );
    }
  }
}

function assertOperationalResultApisResolve(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
): void {
  for (const api of workspace.operationalResultApis) {
    const matches = registeredNodes(
      api,
      workspaceRoot,
      program,
      (node): node is ts.SignatureDeclaration =>
        (ts.isFunctionLike(node) && functionHasImplementation(node)) || ts.isMethodSignature(node),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Operational Result API ${workspace.name}/${api.module}#${api.exportName} must resolve to exactly one callable implementation; found ${matches.length}.`,
      );
    }
  }
}

function isImplementedCallable(node: ts.Node): node is ts.SignatureDeclaration {
  return ts.isFunctionLike(node) && functionHasImplementation(node);
}

const LANGUAGE_HOST_FAILURE_SIGNAL = "language host failure signal";

function callableBody(node: ts.SignatureDeclaration): ts.ConciseBody | undefined {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node.body;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body;
  }
  return undefined;
}

function callableHasControlledPanicObservation(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  workspaceRoot: string,
  signalAdapterKeys: ReadonlySet<string>,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const body = callableBody(node);
  if (!body) return false;
  const inputs = node.parameters.flatMap((parameter) => {
    const symbol = checker.getSymbolAtLocation(parameter.name);
    return symbol ? [canonicalSymbol(symbol, checker)] : [];
  });
  const sameCanonicalExpression = (left: ts.Expression, right: ts.Expression): boolean => {
    const leftValue = unwrapExpression(left);
    const rightValue = unwrapExpression(right);
    if (ts.isIdentifier(leftValue) && ts.isIdentifier(rightValue)) {
      const leftSymbol = checker.getSymbolAtLocation(leftValue);
      const rightSymbol = checker.getSymbolAtLocation(rightValue);
      return Boolean(
        leftSymbol &&
        rightSymbol &&
        canonicalSymbol(leftSymbol, checker) === canonicalSymbol(rightSymbol, checker),
      );
    }
    if (ts.isPropertyAccessExpression(leftValue) && ts.isPropertyAccessExpression(rightValue)) {
      return (
        leftValue.name.text === rightValue.name.text &&
        sameCanonicalExpression(leftValue.expression, rightValue.expression)
      );
    }
    if (ts.isElementAccessExpression(leftValue) && ts.isElementAccessExpression(rightValue)) {
      return (
        leftValue.argumentExpression.getText() === rightValue.argumentExpression.getText() &&
        sameCanonicalExpression(leftValue.expression, rightValue.expression)
      );
    }
    return false;
  };
  const classifiers: { readonly argument: ts.Expression; readonly call: ts.CallExpression }[] = [];
  const signals: { readonly node: ts.Node; readonly expression: ts.Expression }[] = [];
  const visit = (current: ts.Node): void => {
    if (current !== body && ts.isFunctionLike(current)) return;
    if (ts.isCallExpression(current)) {
      if (
        externalCallMatches(
          current,
          { package: "better-result", exportName: "Panic.is" },
          checker,
          packageRoots,
        )
      ) {
        const argument = current.arguments[0];
        if (argument && !ts.isSpreadElement(argument)) {
          const source = inputs.find((candidate) =>
            expressionDerivesExclusivelyFromSymbols(argument, new Set([candidate]), checker),
          );
          if (source) classifiers.push({ argument, call: current });
        }
      }
      const calledDeclaration = resolvedSignature(checker, current)?.declaration;
      if (calledDeclaration && isImplementedCallable(calledDeclaration)) {
        const calledKey = symbolIdentityKey(nodeIdentity(calledDeclaration, workspaceRoot));
        if (signalAdapterKeys.has(calledKey)) {
          const argument = current.arguments[0];
          if (argument && !ts.isSpreadElement(argument)) {
            signals.push({ node: current, expression: argument });
          }
        }
      }
    } else if (ts.isThrowStatement(current)) {
      signals.push({ node: current, expression: current.expression });
    }
    ts.forEachChild(current, visit);
  };
  visit(body);
  const branchGuaranteesSignal = (branch: ts.Statement, signal: ts.Node): boolean => {
    if (branch === signal || branch === signal.parent) return true;
    return (
      ts.isBlock(branch) &&
      branch.statements.length === 1 &&
      branchGuaranteesSignal(branch.statements[0]!, signal)
    );
  };
  return signals.some((signal) =>
    classifiers.some(({ argument, call }) => {
      if (!sameCanonicalExpression(signal.expression, argument)) return false;
      for (
        let parent: ts.Node | undefined = signal.node.parent;
        parent && parent !== node;
        parent = parent.parent
      ) {
        if (!ts.isIfStatement(parent)) continue;
        if (!branchGuaranteesSignal(parent.thenStatement, signal.node)) return false;
        const condition = unwrapExpression(parent.expression);
        if (
          ts.isPrefixUnaryExpression(condition) ||
          ts.isBinaryExpression(condition) ||
          ts.isConditionalExpression(condition)
        ) {
          return false;
        }
        if (condition === call) return true;
        if (!ts.isIdentifier(condition)) return false;
        const conditionSymbol = checker.getSymbolAtLocation(condition);
        const source =
          conditionSymbol &&
          stableSymbolSource(canonicalSymbol(conditionSymbol, checker), condition, checker);
        return Boolean(source && unwrapExpression(source) === call);
      }
      return false;
    }),
  );
}

function callableHasExceptionRelationship(
  node: ts.SignatureDeclaration,
  direction: "signal-host" | "observe-panic",
  checker: ts.TypeChecker,
  workspaceRoot: string,
  signalAdapterKeys: ReadonlySet<string>,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const body = callableBody(node);
  if (!body) return false;
  if (direction === "observe-panic") {
    return callableHasControlledPanicObservation(
      node,
      checker,
      workspaceRoot,
      signalAdapterKeys,
      packageRoots,
    );
  }
  const callableKey = symbolIdentityKey(nodeIdentity(node, workspaceRoot));
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isThrowStatement(current)) {
      found = direction === "signal-host";
      if (found) return;
    }
    if (ts.isCallExpression(current)) {
      const called = expressionName(current.expression) ?? "";
      if (
        direction === "signal-host" &&
        (called.startsWith("reject") ||
          ["error", "throwIfAborted", "reportFatalPanic"].includes(called))
      ) {
        found = true;
        return;
      }
      const calledDeclaration = resolvedSignature(checker, current)?.declaration;
      if (calledDeclaration && isImplementedCallable(calledDeclaration)) {
        const calledKey = symbolIdentityKey(nodeIdentity(calledDeclaration, workspaceRoot));
        if (calledKey !== callableKey && signalAdapterKeys.has(calledKey)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(body);
  return found;
}

function importDeclarationPackage(declaration: ts.Declaration): string | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isStringLiteral(current.moduleSpecifier)
    ? current.moduleSpecifier.text
    : undefined;
}

function declarationReferencesPackage(declaration: ts.Declaration, packageName: string): boolean {
  const imported = importDeclarationPackage(declaration);
  if (imported === packageName || imported?.startsWith(`${packageName}/`)) return true;
  const normalized = normalizedPath(declaration.getSourceFile().fileName);
  return normalized.includes(`/node_modules/${packageName}/`);
}

function callableReferencesExternalApi(
  node: ts.SignatureDeclaration,
  adapter: WorkspaceArchitecture["exceptionAdapters"][number],
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
): boolean {
  const body = callableBody(node);
  if (!body) return false;
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found || (current !== body && ts.isFunctionLike(current))) return;
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (
        symbol?.declarations?.some(
          (declaration) =>
            declarationReferencesPackage(declaration, adapter.externalApi.package) ||
            declarationPackageName(declaration, packageRoots) === adapter.externalApi.package,
        )
      ) {
        found = true;
        return;
      }
    }
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      const declaration = resolvedSignature(checker, current)?.declaration;
      if (
        declaration &&
        (declarationReferencesPackage(declaration, adapter.externalApi.package) ||
          declarationPackageName(declaration, packageRoots) === adapter.externalApi.package)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(body);
  return found;
}

function callableReferencesPlatformApi(
  node: ts.SignatureDeclaration,
  packageName: string,
  checker: ts.TypeChecker,
): boolean {
  if (packageName !== "Intl") return false;
  const body = callableBody(node);
  if (!body) return false;
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found || (current !== body && ts.isFunctionLike(current))) return;
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      const declaration = resolvedSignature(checker, current)?.declaration;
      if (
        isDefaultLibraryDeclaration(declaration) &&
        /DateTimeFormat/u.test(declarationOwnerName(declaration) ?? "")
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(body);
  return found;
}

function hasRecognizableExceptionExternalApi(
  adapter: WorkspaceArchitecture["exceptionAdapters"][number],
  approval: ApprovedExceptionAdapter,
  declaration: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  packageRoots: readonly WorkspacePackageRoot[],
  workspacePackageName: string,
  workspaceRoot: string,
  signalAdapterKeys: ReadonlySet<string>,
): boolean {
  const { package: packageName, exportName } = adapter.externalApi;
  switch (approval.relationship) {
    case "language-runtime":
      if (packageName === "global" && exportName === LANGUAGE_HOST_FAILURE_SIGNAL) {
        return callableHasExceptionRelationship(
          declaration,
          adapter.direction,
          checker,
          workspaceRoot,
          signalAdapterKeys,
          packageRoots,
        );
      }
      if (packageName === "global") return exportName.trim().length > 0;
      return callableReferencesPlatformApi(declaration, packageName, checker);
    case "panic-brand":
      return (
        packageName === "better-result" &&
        exportName === "Panic.is" &&
        adapter.direction === "observe-panic" &&
        callableHasExceptionRelationship(
          declaration,
          adapter.direction,
          checker,
          workspaceRoot,
          signalAdapterKeys,
          packageRoots,
        )
      );
    case "host-contract":
      return adapter.direction === "signal-host";
    case "external-package":
      if (packageName === workspacePackageName) return false;
      return callableReferencesExternalApi(declaration, adapter, checker, packageRoots);
  }
}

function exceptionAdapterCatalogKey(
  workspace: string,
  identity: SymbolIdentity,
  direction: WorkspaceArchitecture["exceptionAdapters"][number]["direction"],
): string {
  return `${workspace}/${symbolIdentityKey(identity)}@${direction}`;
}

function adapterMatchesApproval(
  adapter: WorkspaceArchitecture["exceptionAdapters"][number],
  approval: ApprovedExceptionAdapter,
): boolean {
  return (
    symbolIdentityKey(adapter.identity) === symbolIdentityKey(approval.callable) &&
    adapter.category === approval.category &&
    adapter.externalApi.package === approval.externalApi.package &&
    adapter.externalApi.exportName === approval.externalApi.exportName &&
    adapter.direction === approval.mode &&
    adapter.reason === approval.reason
  );
}

function normalizedExceptionCallbackIdentity(identity: string): string {
  return identity.replace(/@\d+(?=\.|$)/gu, "");
}

function exceptionAdapterDeclarations(
  adapter: WorkspaceArchitecture["exceptionAdapters"][number],
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  signalAdapterKeys: ReadonlySet<string>,
  packageRoots: readonly WorkspacePackageRoot[],
): readonly ts.SignatureDeclaration[] {
  const direct = registeredNodes(adapter.identity, workspaceRoot, program, isImplementedCallable);
  if (direct.length > 0) return direct;

  const normalizedIdentity = normalizedExceptionCallbackIdentity(adapter.identity.exportName);
  const registeredIdentities = Array.from(
    new Set(
      workspace.exceptionAdapters
        .filter(
          (candidate) =>
            candidate.identity.module === adapter.identity.module &&
            normalizedExceptionCallbackIdentity(candidate.identity.exportName) ===
              normalizedIdentity,
        )
        .map((candidate) => candidate.identity.exportName),
    ),
  );
  const candidates = Array.from(
    registeredDeclarationIndex(program, workspaceRoot).get(adapter.identity.module) ?? [],
  )
    .filter(([identity]) => normalizedExceptionCallbackIdentity(identity) === normalizedIdentity)
    .flatMap(([, declarations]) => declarations)
    .filter(isImplementedCallable)
    .filter((declaration) =>
      callableHasExceptionRelationship(
        declaration,
        adapter.direction,
        checker,
        workspaceRoot,
        signalAdapterKeys,
        packageRoots,
      ),
    )
    .sort((left, right) => left.getStart() - right.getStart());
  if (registeredIdentities.length !== candidates.length) return [];
  const index = registeredIdentities.indexOf(adapter.identity.exportName);
  return index < 0 ? [] : [candidates[index]!];
}

export function assertEveryExceptionAdapterResolves(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  approvedExceptionAdapters: readonly ApprovedExceptionAdapter[] = APPROVED_EXCEPTION_ADAPTER_CATALOG,
  packageRoots: readonly WorkspacePackageRoot[] = [],
): void {
  const approvals = new Map(
    approvedExceptionAdapters
      .filter((approval) => approval.workspace === workspace.name)
      .map((approval) => [
        exceptionAdapterCatalogKey(approval.workspace, approval.callable, approval.mode),
        approval,
      ]),
  );
  const signalAdapterKeys = new Set(
    workspace.exceptionAdapters
      .filter((adapter) => adapter.direction === "signal-host")
      .map((adapter) => symbolIdentityKey(adapter.identity)),
  );
  const failures: string[] = [];
  for (const adapter of workspace.exceptionAdapters) {
    const key = `${adapter.identity.module}#${adapter.identity.exportName}`;
    const catalogKey = exceptionAdapterCatalogKey(
      workspace.name,
      adapter.identity,
      adapter.direction,
    );
    const approval = approvals.get(catalogKey);
    if (!approval || !adapterMatchesApproval(adapter, approval)) {
      failures.push(
        `Exception adapter ${workspace.name}/${key} is not an exact member of the approved global catalog.`,
      );
      continue;
    }
    if (adapter.identity.exportName === "<module>") {
      failures.push(
        `Exception adapter ${workspace.name}/${key} is not an exact callable identity.`,
      );
      continue;
    }
    const declarations = exceptionAdapterDeclarations(
      adapter,
      workspace,
      workspaceRoot,
      program,
      checker,
      signalAdapterKeys,
      packageRoots,
    );
    if (declarations.length !== 1) {
      failures.push(
        `Exception adapter ${workspace.name}/${key} does not resolve to production code as exactly one callable; found ${declarations.length}.`,
      );
      continue;
    }
    const declaration = declarations[0];
    if (
      !declaration ||
      !hasRecognizableExceptionExternalApi(
        adapter,
        approval,
        declaration,
        checker,
        packageRoots,
        workspace.packageName,
        workspaceRoot,
        signalAdapterKeys,
      )
    ) {
      failures.push(
        `Exception adapter ${workspace.name}/${key} has no recognizable externalApi or host relationship.`,
      );
      continue;
    }
    if (
      !callableHasExceptionRelationship(
        declaration,
        adapter.direction,
        checker,
        workspaceRoot,
        signalAdapterKeys,
        packageRoots,
      )
    ) {
      failures.push(
        `Exception adapter ${workspace.name}/${key} has no smallest-callable ${adapter.direction} relationship.`,
      );
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

function moduleHasHostSignal(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const called = expressionName(node.expression) ?? "";
      if (["reject", "error", "exit", "abort"].includes(called)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

export function assertCoreFinalExceptionAdaptersResolve(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  exceptionIdentities: readonly (readonly [
    module: string,
    exportName: string,
    mode: "signal",
  ])[] = PRECISE_EXCEPTION_IDENTITIES["apps/core"],
  panicIdentities: readonly (readonly [
    module: string,
    exportName: string,
  ])[] = CORE_REVIEWED_PANIC_IDENTITIES,
  fatalSignalIdentities: readonly (readonly [
    module: string,
    exportName: string,
  ])[] = CORE_FATAL_SIGNAL_IDENTITIES,
  packageRoots: readonly WorkspacePackageRoot[] = [],
): void {
  if (workspace.name !== "apps/core") return;
  type ExpectedCoreExceptionAdapter = {
    readonly module: string;
    readonly exportName: string;
    readonly direction: "signal-host" | "observe-panic";
  };
  const expected: ExpectedCoreExceptionAdapter[] = [];
  for (const [module, exportName] of exceptionIdentities) {
    const signalDirection = exportName.startsWith("preserve")
      ? ("observe-panic" as const)
      : ("signal-host" as const);
    expected.push({ module, exportName, direction: signalDirection });
  }
  for (const [module, exportName] of panicIdentities) {
    expected.push({ module, exportName, direction: "observe-panic" });
  }
  for (const [module, exportName] of fatalSignalIdentities) {
    expected.push({ module, exportName, direction: "signal-host" });
  }

  const resolved = new Map<string, readonly (ts.SignatureDeclaration | ts.SourceFile)[]>();
  const signalAdapterKeys = new Set(
    workspace.exceptionAdapters
      .filter((adapter) => adapter.direction === "signal-host")
      .map((adapter) => symbolIdentityKey(adapter.identity)),
  );
  for (const registration of expected) {
    const key = `${registration.module}#${registration.exportName}`;
    const adapter = workspace.exceptionAdapters.find(
      (candidate) =>
        symbolIdentityKey(candidate.identity) === key &&
        candidate.direction === registration.direction,
    );
    if (!adapter) {
      throw new Error(`Core final exception adapter ${key} lacks ${registration.direction}.`);
    }
    const isFatalSignal = fatalSignalIdentities.some(
      ([module, exportName]) =>
        module === registration.module && exportName === registration.exportName,
    );
    const expectedCategory =
      registration.direction === "observe-panic" || isFatalSignal
        ? "defect-supervisor"
        : "compatibility";
    const expectedApi =
      registration.direction === "signal-host" && !isFatalSignal
        ? { package: "global", exportName: LANGUAGE_HOST_FAILURE_SIGNAL }
        : registration.direction === "observe-panic"
          ? { package: "better-result", exportName: "Panic.is" }
          : { package: "@stanley2058/lilac-core", exportName: "fatal Panic reporter" };
    if (
      adapter.category !== expectedCategory ||
      adapter.externalApi.package !== expectedApi.package ||
      adapter.externalApi.exportName !== expectedApi.exportName
    ) {
      throw new Error(
        `Core final exception adapter ${key} has fabricated or mismatched ${registration.direction} metadata.`,
      );
    }

    let declarations = resolved.get(key);
    if (!declarations) {
      if (registration.exportName === "<module>") {
        const sourceFile = productionSourceIndex(program, workspaceRoot).modules.get(
          registration.module,
        );
        declarations = sourceFile ? [sourceFile] : [];
      } else {
        declarations = exceptionAdapterDeclarations(
          adapter,
          workspace,
          workspaceRoot,
          program,
          checker,
          signalAdapterKeys,
          packageRoots,
        );
      }
      if (declarations.length === 0) {
        throw new Error(`Core final exception adapter ${key} does not resolve to production code.`);
      }
      resolved.set(key, declarations);
    }

    const validRelationship = declarations.some((declaration) =>
      ts.isSourceFile(declaration)
        ? registration.direction === "signal-host" && moduleHasHostSignal(declaration)
        : callableHasExceptionRelationship(
            declaration,
            registration.direction,
            checker,
            workspaceRoot,
            signalAdapterKeys,
            packageRoots,
          ),
    );
    if (!validRelationship) {
      throw new Error(
        `Core final exception adapter ${key} has no smallest-callable ${registration.direction} relationship.`,
      );
    }
  }
}

function analyzeOpenProtocolAdapter(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const identity = nodeIdentity(node, workspaceRoot);
  const adapter = workspace.openProtocolAdapters.find((candidate) =>
    identityMatches(candidate.identity, identity),
  );
  if (!adapter) return;
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return;
  const parameter = node.parameters[adapter.protocolParameter];
  const inputValid = Boolean(
    parameter &&
    parameter.type &&
    typeNodeIsExactExternalProtocol(
      parameter.type,
      adapter.externalProtocol.package,
      adapter.externalProtocol.exportName,
      checker,
      packageRoots,
    ),
  );
  const returnType = checker.getReturnTypeOfSignature(signature);
  const fallback = adapter.fallbackVariant;
  const outputClosed = isClosedLocalDiscriminatedUnion(
    returnType,
    fallback.discriminant,
    checker,
    packageRoots,
    node,
  );
  const outputHasFallback =
    outputClosed &&
    returnType.isUnion() &&
    returnType.types.some(
      (member) =>
        discriminantValue(member, fallback.discriminant, checker, node) === fallback.value,
    );
  const implementationHasFallback = functionReturnsFallback(
    node,
    fallback.discriminant,
    fallback.value,
    checker,
  );
  if (inputValid && outputHasFallback && implementationHasFallback) return;
  const failures = [
    inputValid ? undefined : "the registered parameter is not the named external protocol",
    outputClosed ? undefined : "the return type is not a project-owned closed discriminated union",
    outputHasFallback ? undefined : "the return union lacks the registered fallback variant",
    implementationHasFallback
      ? undefined
      : "the implementation never explicitly returns the fallback variant",
  ].filter((failure): failure is string => failure !== undefined);
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/open-protocol-normalization",
      node,
      `Open-protocol adapter ${identity.symbolPath} is invalid: ${failures.join("; ")}.`,
      "Normalize the exact external protocol to a project-owned closed union and explicitly return the registered fallback variant.",
    ),
  );
}

function openProtocolSwitchInputExpression(node: ts.SwitchStatement): ts.Expression {
  if (
    ts.isPropertyAccessExpression(node.expression) ||
    ts.isElementAccessExpression(node.expression)
  ) {
    return node.expression.expression;
  }
  return node.expression;
}

function analyzeOpenProtocolSwitch(
  node: ts.SwitchStatement,
  checker: ts.TypeChecker,
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  packageRoots: readonly WorkspacePackageRoot[],
  diagnostics: ArchitectureDiagnostic[],
): void {
  const input = openProtocolSwitchInputExpression(node);
  const adapters = workspace.openProtocolAdapters.filter((adapter) =>
    expressionIsExactExternalProtocol(
      input,
      adapter.externalProtocol.package,
      adapter.externalProtocol.exportName,
      checker,
      packageRoots,
    ),
  );
  if (adapters.length === 0) return;
  const identity = nodeIdentity(node, workspaceRoot);
  if (adapters.some((adapter) => identityOwns(adapter.identity, identity))) return;
  const protocols = adapters
    .map((adapter) => `${adapter.externalProtocol.package}#${adapter.externalProtocol.exportName}`)
    .join(", ");
  diagnostics.push(
    makeDiagnostic(
      workspace,
      workspaceRoot,
      "architecture/open-protocol-normalization",
      node,
      `Open external protocol ${protocols} is switched directly in ${identity.symbolPath}.`,
      "Call the exactly registered open-protocol adapter and switch only on its closed local projection.",
    ),
  );
}

export function analyzeWorkspace(
  workspace: WorkspaceArchitecture,
  workspaceRoot: string,
  program: ts.Program,
  packageRoots: readonly WorkspacePackageRoot[] = [
    { packageName: workspace.packageName, root: workspaceRoot },
  ],
  activeEventDeliveryApiPackages: ReadonlySet<string> = new Set(
    workspace.eventDeliveryConsumers.map((registration) => registration.apiPackage),
  ),
  activePersistenceInfrastructure: ActivePersistenceInfrastructure = {
    persistedCodecs: workspace.persistedCodecs.map(({ identity }) => ({
      packageName: workspace.packageName,
      identity,
    })),
    sqliteTransactionAdapters: workspace.sqliteTransactionConsumers.map(({ adapter }) => ({
      packageName: adapter.package ?? workspace.packageName,
      identity: adapter,
    })),
    scanAllProductionModules: false,
  },
  approvedExceptionAdapters: readonly ApprovedExceptionAdapter[] = APPROVED_EXCEPTION_ADAPTER_CATALOG,
): readonly ArchitectureDiagnostic[] {
  assertOpenProtocolAdaptersResolve(workspace, workspaceRoot, program);
  assertOperationalResultApisResolve(workspace, workspaceRoot, program);
  const checker = program.getTypeChecker();
  const productionFiles = productionSourceIndex(program, workspaceRoot).files;
  const indexesResultUnknown = productionFiles.some((sourceFile) => {
    const module = relativeModulePath(workspaceRoot, sourceFile);
    return (
      ruleApplies(workspace, "architecture/no-domain-unknown", module) ||
      ruleApplies(workspace, "architecture/no-unknown-member-read", module)
    );
  });
  if (indexesResultUnknown) {
    indexIntrinsicResultUnknownBoundaries(productionFiles, checker, packageRoots);
  } else {
    INTRINSIC_RESULT_CATCH_MAPPERS.set(checker, new Set());
    INTRINSIC_RESULT_MATCH_HANDLERS.set(checker, new Set());
    INTRINSIC_RESULT_CLASSIFIER_PARAMETERS.set(checker, new Set());
  }
  assertEveryExceptionAdapterResolves(
    workspace,
    workspaceRoot,
    program,
    checker,
    approvedExceptionAdapters,
    packageRoots,
  );
  assertCoreFinalExceptionAdaptersResolve(
    workspace,
    workspaceRoot,
    program,
    checker,
    undefined,
    undefined,
    undefined,
    packageRoots,
  );
  const diagnostics: ArchitectureDiagnostic[] = [];
  assertPersistenceInfrastructureCallsResolve(
    workspace,
    workspaceRoot,
    program,
    checker,
    packageRoots,
    activePersistenceInfrastructure,
  );
  assertEventDeliveryConsumersResolve(
    workspace,
    workspaceRoot,
    program,
    checker,
    packageRoots,
    activeEventDeliveryApiPackages,
  );
  analyzeRegisteredEventInfrastructure(
    workspace,
    workspaceRoot,
    program,
    checker,
    packageRoots,
    diagnostics,
  );
  const reportedPredicates = new Set<string>();
  const reportedContracts = new Set<string>();
  const reportedCustomDecoders = new Set<string>();
  const reportedMaps = new Set<string>();

  for (const sourceFile of productionFiles) {
    const module = relativeModulePath(workspaceRoot, sourceFile);
    const activeRules = new Set(
      ARCHITECTURE_RULES.filter((rule) => ruleApplies(workspace, rule, module)),
    );
    if (activeRules.has("architecture/no-deprecated")) {
      analyzeDeprecatedReferences(program, sourceFile, workspace, workspaceRoot, diagnostics);
    }
    if (activeRules.has("architecture/no-repeated-result-match")) {
      analyzeRepeatedResultMatches(
        sourceFile,
        checker,
        workspace,
        workspaceRoot,
        packageRoots,
        diagnostics,
      );
    }
    const candidateNames = callCandidateNames(sourceFile, workspace, activeRules);
    const analyzeEveryCall =
      activeRules.has("architecture/no-manual-result-branching") ||
      activeRules.has("architecture/no-nested-result-continuation");
    const sourceExports = activeRules.has("architecture/no-unhandled-exception-contract")
      ? exportedSymbols(sourceFile, checker)
      : new Set<ts.Symbol>();

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        (analyzeEveryCall || candidateNames.has(expressionName(node.expression) ?? ""))
      ) {
        analyzeCall(
          node,
          checker,
          workspace,
          workspaceRoot,
          activeRules,
          packageRoots,
          diagnostics,
        );
      }
      if (
        activeRules.has("architecture/no-manual-result-branching") &&
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node) ||
          ts.isBindingElement(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node))
      ) {
        analyzeManualResultStatusRead(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (activeRules.has("architecture/no-domain-unknown") && ts.isParameter(node)) {
        analyzeParameter(node, checker, workspace, workspaceRoot, packageRoots, diagnostics);
      }
      if (
        activeRules.has("architecture/no-unknown-member-read") &&
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node) ||
          ts.isBindingElement(node))
      ) {
        analyzeUnknownMemberRead(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (
        activeRules.has("architecture/no-unknown-member-read") &&
        (ts.isForOfStatement(node) ||
          ts.isSpreadElement(node) ||
          ts.isSpreadAssignment(node) ||
          ts.isCallExpression(node))
      ) {
        analyzeUnknownExtraction(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (
        activeRules.has("architecture/no-unregistered-custom-decoder") &&
        ts.isFunctionLike(node)
      ) {
        analyzeCustomDecoder(
          node,
          checker,
          workspace,
          workspaceRoot,
          diagnostics,
          reportedCustomDecoders,
        );
      }
      if (
        activeRules.has("architecture/no-unknown-assertion") &&
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      ) {
        analyzeAssertion(node, checker, workspace, workspaceRoot, diagnostics);
      }
      if (activeRules.has("architecture/no-rich-unknown-predicate") && ts.isFunctionLike(node)) {
        analyzePredicate(node, checker, workspace, workspaceRoot, diagnostics, reportedPredicates);
      }
      if (
        activeRules.has("architecture/closed-union-exhaustiveness") &&
        ts.isSwitchStatement(node)
      ) {
        analyzeClosedUnionSwitch(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (activeRules.has("architecture/closed-union-map-exhaustiveness")) {
        if (
          (ts.isVariableDeclaration(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isPropertyAssignment(node)) &&
          node.initializer
        ) {
          analyzeDeclaredClosedUnionMap(
            node,
            checker,
            workspace,
            workspaceRoot,
            packageRoots,
            diagnostics,
            reportedMaps,
          );
        }
        if (ts.isElementAccessExpression(node) && node.argumentExpression) {
          const domain = literalDomain(
            checker.getTypeAtLocation(node.argumentExpression),
            checker,
            packageRoots,
            checker.getTypeAtLocation(node.argumentExpression),
            expressionTypeIsProjectOwned(node.argumentExpression, checker, packageRoots),
          );
          const resolution = mapResolutionFromExpression(node.expression, checker);
          if (domain && resolution) {
            analyzeClosedUnionMap(
              resolution,
              domain,
              checker,
              workspace,
              workspaceRoot,
              packageRoots,
              diagnostics,
              reportedMaps,
            );
          }
        }
      }
      if (activeRules.has("architecture/open-protocol-normalization") && ts.isFunctionLike(node)) {
        analyzeOpenProtocolAdapter(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (
        activeRules.has("architecture/open-protocol-normalization") &&
        ts.isSwitchStatement(node)
      ) {
        analyzeOpenProtocolSwitch(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
        );
      }
      if (
        ts.isFunctionLike(node) &&
        (activeRules.has("architecture/no-unhandled-exception-contract") ||
          activeRules.has("architecture/fallible-api-result"))
      ) {
        analyzeResultContract(
          node,
          checker,
          workspace,
          workspaceRoot,
          activeRules,
          packageRoots,
          diagnostics,
          reportedContracts,
          sourceExports,
        );
      }
      if (
        activeRules.has("architecture/no-unhandled-exception-contract") &&
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      ) {
        analyzeDeclaredResultContract(
          node,
          checker,
          workspace,
          workspaceRoot,
          packageRoots,
          diagnostics,
          reportedContracts,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [
    ...new Map(diagnostics.map((diagnostic) => [diagnostic.fingerprint, diagnostic])).values(),
  ];
}
