import { useEffect, useRef } from "react";
import { useAppliedTheme } from "../../theme/theme";
import { monaco, prepareEditor } from "../monaco-runtime";

/** Read-only inline diff of the saved file against the draft. */
export default function ConfigDiffEditor({
  original,
  modified,
  label,
}: {
  original: string;
  modified: string;
  label: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const { theme } = useAppliedTheme();
  useEffect(() => {
    void prepareEditor("yaml", theme);
  }, [theme]);
  useEffect(() => {
    const before = monaco.editor.createModel(original, "yaml");
    const after = monaco.editor.createModel(modified, "yaml");
    const typography = getComputedStyle(container.current!);
    const view = monaco.editor.createDiffEditor(container.current!, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3 },
      renderOverviewRuler: false,
      ariaLabel: label,
      fontFamily: typography.fontFamily,
      fontSize: parseFloat(typography.fontSize),
      lineHeight: parseFloat(typography.lineHeight),
      lineNumbersMinChars: 4,
      glyphMargin: false,
      padding: { top: 8, bottom: 8 },
    });
    view.setModel({ original: before, modified: after });
    return () => {
      view.dispose();
      before.dispose();
      after.dispose();
    };
  }, [original, modified, label]);
  return (
    <div
      ref={container}
      data-ui="code-editor"
      className="h-full min-h-0 w-full font-mono text-sm leading-code"
    />
  );
}
