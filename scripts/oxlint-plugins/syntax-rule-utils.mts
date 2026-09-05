import { createHash } from "node:crypto";

import ts from "typescript-codegen";

import {
  createProductionFileExclusionMatcher,
  type ProductionFileExclusionMatcher,
} from "../architecture/source-policy.ts";

export {
  createProductionFileExclusionMatcher,
  type ProductionFileExclusionMatcher,
} from "../architecture/source-policy.ts";

export interface SourceIdentity {
  readonly module: string;
  readonly workspace: string;
}

export interface SyntacticFinding<Kind extends string> {
  readonly column: number;
  readonly digest: string;
  readonly kind: Kind;
  readonly line: number;
  readonly message: string;
  readonly module: string;
  readonly symbol: string;
  readonly workspace: string;
}

interface ProductionExclusion {
  readonly pattern: string;
}

const PRODUCTION_EXCLUSION_MATCHERS = new WeakMap<
  readonly ProductionExclusion[],
  ProductionFileExclusionMatcher
>();

export function normalizeFilePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

export function sourceIdentity(filePath: string): SourceIdentity {
  const normalized = normalizeFilePath(filePath);
  const match = /(?:^|\/)((?:apps|packages)\/[^/]+)\/(.+)$/u.exec(normalized);
  if (!match?.[1] || !match[2]) return { workspace: "<external>", module: normalized };
  return {
    workspace: match[1],
    module: match[2].replace(/\.(?:[cm]?[jt]sx?)$/iu, ""),
  };
}

export function isExcludedProductionFile(
  filePath: string,
  exclusions: readonly ProductionExclusion[],
): boolean {
  let matcher = PRODUCTION_EXCLUSION_MATCHERS.get(exclusions);
  if (!matcher) {
    matcher = createProductionFileExclusionMatcher(exclusions);
    PRODUCTION_EXCLUSION_MATCHERS.set(exclusions, matcher);
  }
  return matcher(filePath);
}

export function scriptKindFor(filePath: string): ts.ScriptKind {
  if (/\.tsx$/iu.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/iu.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/iu.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function objectLiteralPath(object: ts.ObjectLiteralExpression): string | undefined {
  const parent = object.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) {
    const property = propertyNameText(parent.name);
    const owner = ts.isObjectLiteralExpression(parent.parent)
      ? objectLiteralPath(parent.parent)
      : undefined;
    return property && owner ? `${owner}.${property}` : property;
  }
  if (ts.isPropertyDeclaration(parent)) return propertyNameText(parent.name);
  return undefined;
}

function rawFunctionMemberPath(node: ts.FunctionLikeDeclaration): string | undefined {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyDeclaration(parent)) return propertyNameText(parent.name);
  if (ts.isPropertyAssignment(parent)) {
    const property = propertyNameText(parent.name);
    const owner = ts.isObjectLiteralExpression(parent.parent)
      ? objectLiteralPath(parent.parent)
      : undefined;
    return property && owner ? `${owner}.${property}` : property;
  }
  if (ts.isCallExpression(parent)) {
    const argumentIndex = parent.arguments.indexOf(node as ts.Expression);
    const expression = parent.expression;
    const called = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : undefined;
    if (argumentIndex >= 0 && called) return `${called}.<callback@${argumentIndex + 1}>`;
  }
  let owner: ts.Node | undefined = parent;
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

function rawContainingSymbol(node: ts.Node): string {
  const segments: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current) || ts.isGetAccessor(current) || ts.isSetAccessor(current)) {
      segments.push(propertyNameText(current.name) ?? "<computed-method>");
    } else if (ts.isConstructorDeclaration(current)) {
      segments.push("constructor");
    } else if (ts.isFunctionDeclaration(current) && current.name) {
      segments.push(current.name.text);
    } else if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const member = rawFunctionMemberPath(current);
      if (member) segments.push(member);
    } else if (ts.isClassDeclaration(current) && current.name) {
      segments.push(current.name.text);
    } else if (ts.isClassExpression(current)) {
      const name = classExpressionName(current);
      if (name) segments.push(name);
    }
    current = current.parent;
  }
  return segments.reverse().join(".") || "<module>";
}

const DISAMBIGUATED_FUNCTION_MEMBERS = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<ts.FunctionExpression | ts.ArrowFunction, string>
>();

function disambiguatedFunctionMembers(
  sourceFile: ts.SourceFile,
): ReadonlyMap<ts.FunctionExpression | ts.ArrowFunction, string> {
  const cached = DISAMBIGUATED_FUNCTION_MEMBERS.get(sourceFile);
  if (cached) return cached;
  const groups = new Map<string, (ts.FunctionExpression | ts.ArrowFunction)[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const key = rawContainingSymbol(node.body);
      const group = groups.get(key) ?? [];
      group.push(node);
      groups.set(key, group);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const members = new Map<ts.FunctionExpression | ts.ArrowFunction, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.forEach((node, index) => {
      members.set(node, `${rawFunctionMemberPath(node) ?? "<callback>"}@${index + 1}`);
    });
  }
  DISAMBIGUATED_FUNCTION_MEMBERS.set(sourceFile, members);
  return members;
}

function functionMemberPath(node: ts.FunctionLikeDeclaration): string | undefined {
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return (
      disambiguatedFunctionMembers(node.getSourceFile()).get(node) ?? rawFunctionMemberPath(node)
    );
  }
  return rawFunctionMemberPath(node);
}

function classExpressionName(node: ts.ClassExpression): string | undefined {
  if (node.name) return node.name.text;
  const parent = node.parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? parent.name.text
    : undefined;
}

export function containingSymbol(node: ts.Node): string {
  const segments: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current) || ts.isGetAccessor(current) || ts.isSetAccessor(current)) {
      segments.push(propertyNameText(current.name) ?? "<computed-method>");
    } else if (ts.isConstructorDeclaration(current)) {
      segments.push("constructor");
    } else if (ts.isFunctionDeclaration(current) && current.name) {
      segments.push(current.name.text);
    } else if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const member = functionMemberPath(current);
      if (member) segments.push(member);
    } else if (ts.isClassDeclaration(current) && current.name) {
      segments.push(current.name.text);
    } else if (ts.isClassExpression(current)) {
      const name = classExpressionName(current);
      if (name) segments.push(name);
    }
    current = current.parent;
  }
  return segments.reverse().join(".") || "<module>";
}

function normalizedStructuralContext(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    node.getText(sourceFile),
  );
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.WhitespaceTrivia ||
      token === ts.SyntaxKind.NewLineTrivia ||
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    tokens.push(scanner.getTokenText());
  }
  return tokens.join(" ");
}

export function createFinding<Kind extends string>(
  sourceFile: ts.SourceFile,
  filePath: string,
  node: ts.Node,
  kind: Kind,
  message: string,
  owner: ts.Node = node,
): SyntacticFinding<Kind> {
  const identity = sourceIdentity(filePath);
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    line: location.line + 1,
    column: location.character + 1,
    digest: createHash("sha256").update(normalizedStructuralContext(node)).digest("hex"),
    kind,
    message,
    module: identity.module,
    symbol: containingSymbol(owner),
    workspace: identity.workspace,
  };
}
