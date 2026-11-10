import { expect, test } from "bun:test";
import path from "node:path";
import type { CompilerBail } from "./support/react-compiler-bails";

/**
 * Components the React Compiler skips today. Each skipped component rerenders its subtree in full,
 * so a hot component must compile or opt out with a `"use no memo"` directive that says why.
 */
const knownBails = [
  "src/DesignSystem.tsx: Cannot access refs during render",
  "src/components/AgentWorkDemo.tsx: Cannot access variable before it is declared",
  "src/components/ComputerViewer.tsx: This value cannot be modified",
  "src/components/ExternalMessages.tsx: Use of incompatible library",
  "src/components/MonacoEditor.tsx: (BuildHIR::lowerExpression) Handle Import expressions",
  "src/components/QuestionDemo.tsx: Cannot access refs during render",
  "src/components/ResourcePreview.tsx: Cannot access variable before it is declared",
  "src/components/Settings.tsx: Cannot access refs during render",
  "src/components/SubagentPanel.tsx: Existing memoization could not be preserved",
  "src/components/ThreadReferenceView.tsx: (BuildHIR::lowerStatement) Handle for-await loops",
  "src/components/WorkspaceTree.tsx: Cannot access variable before it is declared",
  "src/components/ui/toast.tsx: (BuildHIR::node.lowerReorderableExpression) Expression type `JSXElement` cannot be safely reordered",
  "src/components/use-reading-anchor.ts: This value cannot be modified",
  "src/components/use-timeline-scroll.ts: This value cannot be modified",
];

test("the React Compiler skips only the known components", async () => {
  // Babel patches global stack-trace handling, so the scan runs outside the test process.
  const scan = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "support/react-compiler-bails.ts"),
      path.resolve(import.meta.dir, ".."),
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(scan.stdout).text();
  expect(await scan.exited).toBe(0);
  const bails: CompilerBail[] = JSON.parse(output);
  const found = [...new Set(bails.map((bail) => `${bail.file}: ${bail.reason}`))].sort();
  expect(found).toEqual(knownBails.toSorted());
}, 60_000);
