import { lazy, Suspense } from "react";
import type { MonacoEditorProps } from "./MonacoEditor";
const MonacoEditor = lazy(() => import("./MonacoEditor"));

export function CodeEditor(props: MonacoEditorProps) {
  if (typeof window === "undefined")
    return (
      <pre aria-label={props.label} className="overflow-auto whitespace-pre-wrap">
        {props.value}
      </pre>
    );
  return (
    <Suspense
      fallback={
        <div className="flex-1 min-h-0 p-3 text-sm text-muted-foreground" role="status">
          Loading editor…
        </div>
      }
    >
      <MonacoEditor {...props} />
    </Suspense>
  );
}
