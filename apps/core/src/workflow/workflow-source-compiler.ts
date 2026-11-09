import type ts from "typescript-codegen";
import { typescript } from "./typescript-compiler";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { sha256 } from "./workflow-definition";
import { compareCodeUnits } from "./workflow-domain";

const HOST_CALLS = new Set(["agent", "parallel", "pipeline", "phase", "waitForReply", "sleep"]);
const CONTEXT_NAMES = new Set(["args", ...HOST_CALLS]);

type SourceEdit = { start: number; end: number; text: string };

const MANIFEST_PREFIX = "/*lilac-workflow-call-sites:";
const MANIFEST_ENTRY_SOURCE = String.raw`\{"kind":"(?:agent|parallel|pipeline|phase|waitForReply|sleep)","callSiteId":"wfcs:[a-f0-9]{32}"\}`;
const MANIFEST_PATTERN = new RegExp(
  String.raw`^\[(?:${MANIFEST_ENTRY_SOURCE}(?:,${MANIFEST_ENTRY_SOURCE})*)?\]$`,
  "u",
);
const MANIFEST_ENTRY_PATTERN =
  /\{"kind":"(?<kind>agent|parallel|pipeline|phase|waitForReply|sleep)","callSiteId":"(?<callSiteId>wfcs:[a-f0-9]{32})"\}/gu;

export type WorkflowCallSiteManifestEntry = {
  readonly kind: "agent" | "parallel" | "pipeline" | "phase" | "waitForReply" | "sleep";
  readonly callSiteId: string;
};

export class WorkflowCallSiteManifestInvalid extends TaggedError(
  "WorkflowCallSiteManifestInvalid",
)<{ readonly message: string }> {}

export class WorkflowSourceCompileFailed extends TaggedError("WorkflowSourceCompileFailed")<{
  readonly message: string;
}> {}

function isHostCallKind(value: string): value is WorkflowCallSiteManifestEntry["kind"] {
  return HOST_CALLS.has(value);
}

export function parseWorkflowCallSiteManifestUnchecked(
  source: string,
): ResultType<readonly WorkflowCallSiteManifestEntry[], WorkflowCallSiteManifestInvalid> {
  const invalid = (message: string): ResultType<never, WorkflowCallSiteManifestInvalid> =>
    Result.err(new WorkflowCallSiteManifestInvalid({ message }));
  if (!source.startsWith(MANIFEST_PREFIX)) return Result.ok([]);
  const end = source.indexOf("*/");
  if (end < 0) return invalid("Compiled workflow call-site manifest is malformed");
  const encoded = source.slice(MANIFEST_PREFIX.length, end);
  const decodedBytes = Buffer.from(encoded, "base64url");
  if (
    decodedBytes.toString("base64url") !== encoded ||
    decodedBytes.byteLength > 16 * 1024 * 1024
  ) {
    return invalid("Compiled workflow call-site manifest is malformed");
  }
  const decoded = decodedBytes.toString("utf8");
  if (!MANIFEST_PATTERN.test(decoded)) {
    return invalid("Compiled workflow call-site manifest is malformed");
  }
  const entries: WorkflowCallSiteManifestEntry[] = [];
  for (const match of decoded.matchAll(MANIFEST_ENTRY_PATTERN)) {
    const kind = match.groups?.["kind"];
    const callSiteId = match.groups?.["callSiteId"];
    if (!kind || !callSiteId || !isHostCallKind(kind)) {
      return invalid("Compiled workflow call-site manifest is malformed");
    }
    entries.push({ kind, callSiteId });
  }
  if (entries.length > 100_000) return invalid("Compiled workflow call-site manifest is malformed");
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.callSiteId)) {
      return invalid(
        `Compiled workflow call-site manifest contains duplicate ID: ${entry.callSiteId}`,
      );
    }
    seen.add(entry.callSiteId);
  }
  return Result.ok(entries);
}

function propertyName(name: ts.PropertyName): string | null {
  return typescript.isIdentifier(name) || typescript.isStringLiteral(name) ? name.text : null;
}

export function compileWorkflowSourceResult(
  source: string,
  sourceSha256: string,
): ResultType<string, WorkflowSourceCompileFailed> {
  const invalid = (message: string): ResultType<never, WorkflowSourceCompileFailed> =>
    Result.err(new WorkflowSourceCompileFailed({ message }));
  if (sha256(source) !== sourceSha256) return invalid("Workflow compiler source hash mismatch");
  const sourceFile = typescript.createSourceFile(
    "workflow.js",
    source,
    typescript.ScriptTarget.ESNext,
    true,
    typescript.ScriptKind.JS,
  );
  const importStatement = sourceFile.statements[0];
  const exportStatement = sourceFile.statements[sourceFile.statements.length - 1];
  if (!importStatement || !typescript.isImportDeclaration(importStatement)) {
    return invalid("Workflow compiler expected the validated virtual import");
  }
  if (!exportStatement || !typescript.isExportAssignment(exportStatement)) {
    return invalid("Workflow compiler expected the validated default export");
  }
  const definitionCall = exportStatement.expression;
  if (!typescript.isCallExpression(definitionCall))
    return invalid("Workflow definition call is missing");
  const definition = definitionCall.arguments[0];
  if (!definition || !typescript.isObjectLiteralExpression(definition)) {
    return invalid("Workflow definition object is missing");
  }
  const run = definition.properties.find(
    (property): property is ts.MethodDeclaration =>
      typescript.isMethodDeclaration(property) &&
      property.name !== undefined &&
      propertyName(property.name) === "run",
  );
  const parameter = run?.parameters[0];
  if (!run?.body || !parameter || !typescript.isObjectBindingPattern(parameter.name)) {
    return invalid("Workflow run context must use object destructuring");
  }
  for (const element of parameter.name.elements) {
    if (
      element.dotDotDotToken ||
      element.initializer ||
      !typescript.isIdentifier(element.name) ||
      (element.propertyName !== undefined &&
        propertyName(element.propertyName) !== element.name.text) ||
      !CONTEXT_NAMES.has(element.name.text)
    ) {
      return invalid("Workflow run context may destructure only unaliased declared workflow APIs");
    }
  }

  const edits: SourceEdit[] = [
    { start: importStatement.getStart(sourceFile), end: importStatement.end, text: "" },
    {
      start: exportStatement.getStart(sourceFile),
      end: definition.getStart(sourceFile),
      text: "globalThis.__lilacWorkflow = ",
    },
    { start: definition.end, end: definitionCall.end, text: "" },
  ];
  const manifest: WorkflowCallSiteManifestEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (
      typescript.isCallExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      isHostCallKind(node.expression.text)
    ) {
      const kind = node.expression.text;
      const callSiteId = `wfcs:${sha256(`${sourceSha256}:${kind}:${node.getStart(sourceFile)}`).slice(0, 32)}`;
      manifest.push({ kind, callSiteId });
      edits.push({
        start: node.arguments.pos,
        end: node.arguments.pos,
        text: `${JSON.stringify(callSiteId)}${node.arguments.length > 0 ? ", " : ""}`,
      });
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);

  let compiled = source;
  for (const edit of edits.sort(
    (left, right) => right.start - left.start || compareCodeUnits(right.text, left.text),
  )) {
    compiled = `${compiled.slice(0, edit.start)}${edit.text}${compiled.slice(edit.end)}`;
  }
  manifest.sort((left, right) => compareCodeUnits(left.callSiteId, right.callSiteId));
  const encodedManifest = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64url");
  return Result.ok(`${MANIFEST_PREFIX}${encodedManifest}*/\n${compiled}`);
}
