import ts from "typescript-codegen";

import { sha256 } from "./workflow-definition";
import { compareCodeUnits } from "./workflow-domain";

const HOST_CALLS = new Set(["agent", "parallel", "pipeline", "phase", "waitForReply", "sleep"]);
const CONTEXT_NAMES = new Set(["args", ...HOST_CALLS]);

type SourceEdit = { start: number; end: number; text: string };

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
  const exportStatement = sourceFile.statements[1];
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
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      HOST_CALLS.has(node.expression.text)
    ) {
      const kind = node.expression.text;
      const callSiteId = `wfcs:${sha256(`${sourceSha256}:${kind}:${node.getStart(sourceFile)}`).slice(0, 32)}`;
      edits.push({
        start: node.arguments.pos,
        end: node.arguments.pos,
        text: `${JSON.stringify(callSiteId)}${node.arguments.length > 0 ? ", " : ""}`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(run.body);

  let compiled = source;
  for (const edit of edits.sort(
    (left, right) => right.start - left.start || compareCodeUnits(right.text, left.text),
  )) {
    compiled = `${compiled.slice(0, edit.start)}${edit.text}${compiled.slice(edit.end)}`;
  }
  return compiled;
}
