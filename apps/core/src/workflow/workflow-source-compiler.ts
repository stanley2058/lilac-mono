import ts from "typescript-codegen";
import { z } from "zod";

import { sha256 } from "./workflow-definition";
import { compareCodeUnits } from "./workflow-domain";

const HOST_CALLS = new Set(["agent", "parallel", "pipeline", "phase", "waitForReply", "sleep"]);
const CONTEXT_NAMES = new Set(["args", ...HOST_CALLS]);

type SourceEdit = { start: number; end: number; text: string };

const MANIFEST_PREFIX = "/*lilac-workflow-call-sites:";
const manifestEntrySchema = z.strictObject({
  kind: z.enum(["agent", "parallel", "pipeline", "phase", "waitForReply", "sleep"]),
  callSiteId: z.string().regex(/^wfcs:[a-f0-9]{32}$/u),
});
const manifestSchema = z.array(manifestEntrySchema).max(100_000);
export type WorkflowCallSiteManifestEntry = z.infer<typeof manifestEntrySchema>;

function isHostCallKind(value: string): value is WorkflowCallSiteManifestEntry["kind"] {
  return HOST_CALLS.has(value);
}

export function parseWorkflowCallSiteManifest(
  source: string,
): readonly WorkflowCallSiteManifestEntry[] {
  if (!source.startsWith(MANIFEST_PREFIX)) return [];
  const end = source.indexOf("*/");
  if (end < 0) throw new Error("Compiled workflow call-site manifest is malformed");
  const encoded = source.slice(MANIFEST_PREFIX.length, end);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Compiled workflow call-site manifest is malformed");
  }
  const entries = manifestSchema.parse(decoded);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.callSiteId)) {
      throw new Error(
        `Compiled workflow call-site manifest contains duplicate ID: ${entry.callSiteId}`,
      );
    }
    seen.add(entry.callSiteId);
  }
  return entries;
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

export function compileWorkflowSource(source: string, sourceSha256: string): string {
  if (sha256(source) !== sourceSha256) throw new Error("Workflow compiler source hash mismatch");
  const sourceFile = ts.createSourceFile(
    "workflow.js",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const importStatement = sourceFile.statements[0];
  const exportStatement = sourceFile.statements[sourceFile.statements.length - 1];
  if (!importStatement || !ts.isImportDeclaration(importStatement)) {
    throw new Error("Workflow compiler expected the validated virtual import");
  }
  if (!exportStatement || !ts.isExportAssignment(exportStatement)) {
    throw new Error("Workflow compiler expected the validated default export");
  }
  const definitionCall = exportStatement.expression;
  if (!ts.isCallExpression(definitionCall)) throw new Error("Workflow definition call is missing");
  const definition = definitionCall.arguments[0];
  if (!definition || !ts.isObjectLiteralExpression(definition)) {
    throw new Error("Workflow definition object is missing");
  }
  const run = definition.properties.find(
    (property): property is ts.MethodDeclaration =>
      ts.isMethodDeclaration(property) &&
      property.name !== undefined &&
      propertyName(property.name) === "run",
  );
  const parameter = run?.parameters[0];
  if (!run?.body || !parameter || !ts.isObjectBindingPattern(parameter.name)) {
    throw new Error("Workflow run context must use object destructuring");
  }
  for (const element of parameter.name.elements) {
    if (
      element.dotDotDotToken ||
      element.initializer ||
      !ts.isIdentifier(element.name) ||
      (element.propertyName !== undefined &&
        propertyName(element.propertyName) !== element.name.text) ||
      !CONTEXT_NAMES.has(element.name.text)
    ) {
      throw new Error("Workflow run context may destructure only unaliased declared workflow APIs");
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
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
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
    ts.forEachChild(node, visit);
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
  return `${MANIFEST_PREFIX}${encodedManifest}*/\n${compiled}`;
}
