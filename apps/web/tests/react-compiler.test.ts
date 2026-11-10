import { expect, test } from "bun:test";
import path from "node:path";
import { bailEntries, type CompilerBail } from "./support/react-compiler-bails";

/**
 * Components the React Compiler skips today. Each skipped component rerenders its subtree in full,
 * so a hot component must compile or opt out with a `"use no memo"` directive that says why.
 */
const knownBails = [
  "src/design-system/Layout.tsx: ComputerDemo: Cannot access refs during render",
  "src/components/AgentWorkDemo.tsx: AgentWorkDemo: Cannot access variable before it is declared",
  "src/components/ComputerViewer.tsx: ComputerPanel: This value cannot be modified",
  "src/components/ExternalMessages.tsx: ExternalMessages: Use of incompatible library",
  "src/components/MonacoEditor.tsx: MonacoEditor: (BuildHIR::lowerExpression) Handle Import expressions",
  "src/components/QuestionDemo.tsx: useQuestionReplyDemo: Cannot access refs during render",
  "src/components/ResourcePreview.tsx: AttachmentPreviewBody: Cannot access variable before it is declared",
  "src/components/Settings.tsx: Settings: Cannot access refs during render",
  "src/components/SubagentPanel.tsx: NativeSubagentPanel: Existing memoization could not be preserved",
  "src/components/SubagentPanel.tsx: SubagentPanelView: Existing memoization could not be preserved",
  "src/components/ThreadReferenceView.tsx: ThreadReferenceView: (BuildHIR::lowerStatement) Handle for-await loops",
  "src/components/WorkspaceTree.tsx: WorkspaceTreeView: Cannot access variable before it is declared",
  "src/components/ui/toast.tsx: ToastAction: (BuildHIR::node.lowerReorderableExpression) Expression type `JSXElement` cannot be safely reordered",
  "src/components/ui/toast.tsx: ToastClose: (BuildHIR::node.lowerReorderableExpression) Expression type `JSXElement` cannot be safely reordered",
  "src/components/use-reading-anchor.ts: useReadingAnchor: This value cannot be modified",
  "src/components/use-timeline-scroll.ts: useTimelineScroll: This value cannot be modified",
];

async function scanBails(root: string): Promise<CompilerBail[]> {
  // Babel patches global stack-trace handling, so the scan runs outside the test process.
  const scan = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "support/react-compiler-bails.ts"), root],
    { stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(scan.stdout).text();
  expect(await scan.exited).toBe(0);
  return JSON.parse(output);
}

test("the React Compiler skips only the known components", async () => {
  const bails = await scanBails(path.resolve(import.meta.dir, ".."));
  expect(bailEntries(bails)).toEqual(knownBails.toSorted());
}, 60_000);

test("a second function that bails for a listed reason in a listed file is a new entry", async () => {
  const bails = await scanBails(path.join(import.meta.dir, "fixtures/react-compiler-bails"));
  expect(bailEntries(bails)).toEqual([
    "src/RefReads.tsx: FirstRefRead: Cannot access refs during render",
    "src/RefReads.tsx: SecondRefRead: Cannot access refs during render",
  ]);
}, 60_000);
