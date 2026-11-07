import { lazy, Suspense } from "react";
import type { MonacoEditorProps } from "./MonacoEditor";
import "./file-viewer.css";
const MonacoEditor = lazy(() => import("./MonacoEditor"));

/** Mirrors the editor's gutter and line metrics so the swap to Monaco does not jump. */
export function CodeFallback({ value, wrap }: { value: string; wrap?: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading editor"
      data-ui="code-fallback"
      data-wrap={wrap !== false}
      className="code-fallback flex-1 min-h-0 min-w-0 overflow-auto font-mono text-sm leading-code"
    >
      <ol className="code-fallback-lines">
        {value.split("\n").map((text, index) => (
          <li key={index}>
            <span className="code-fallback-number">{index + 1}</span>
            <code>{text || " "}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CodeEditor(props: MonacoEditorProps) {
  if (typeof window === "undefined")
    return (
      <pre aria-label={props.label} className="overflow-auto whitespace-pre-wrap">
        {props.value}
      </pre>
    );
  return (
    <Suspense fallback={<CodeFallback value={props.value} wrap={props.wrap} />}>
      <MonacoEditor {...props} />
    </Suspense>
  );
}
