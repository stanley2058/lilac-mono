import { Result, type Result as ResultType } from "better-result";
import { RichRenderFailed } from "./rich-render-error";
import { memo, useEffect, useId, useState } from "react";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { diagramSourceAllowed } from "./markdown-policy";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  maxTextSize: 32 * 1024,
  suppressErrorRendering: true,
});

export function sanitizeDiagram(svg: string): string {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "a", "style", "animate", "set"],
    FORBID_ATTR: ["href", "xlink:href", "style"],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const element of fragment.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? "";
      if (
        value.includes("\\") ||
        (/url\s*\(/iu.test(value) && !/^url\(#[a-z\d_-]+\)$/iu.test(value))
      )
        element.removeAttribute(name);
    }
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}

/** Finished diagrams, so a row that remounts keeps its height instead of starting from the source. */
const finished = new Map<string, string>();
const MAX_FINISHED = 128;

function rememberDiagram(source: string, svg: string) {
  finished.delete(source);
  finished.set(source, svg);
  if (finished.size <= MAX_FINISHED) return;
  const oldest = finished.keys().next().value;
  if (oldest !== undefined) finished.delete(oldest);
}

export function renderDiagram(
  id: string,
  source: string,
): Promise<ResultType<string, RichRenderFailed>> {
  return Result.tryPromise({
    try: async () => sanitizeDiagram((await mermaid.render(id, source)).svg),
    catch: () => new RichRenderFailed({ message: "Diagram rendering is unavailable" }),
  });
}

export default memo(function Diagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-z\d]/giu, "");
  const [rendered, setRendered] = useState<{ source: string; svg: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const known = finished.get(source);
  useEffect(() => {
    if (known !== undefined || !diagramSourceAllowed(source)) return;
    let active = true;
    function accept(svg: string) {
      rememberDiagram(source, svg);
      setRendered({ source, svg });
    }
    async function render() {
      const result = await renderDiagram(`diagram-${id}`, source);
      if (!active) return;
      result.match({ ok: accept, err: () => setFailed(source) });
    }
    // Leave a paint for conversation text before Mermaid performs synchronous layout work.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => void render());
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [id, source, known]);
  const svg = known ?? (rendered?.source === source ? rendered.svg : undefined);
  if (svg !== undefined)
    return (
      <div
        className="markdown-diagram"
        role="img"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  return (
    <pre
      className="markdown-code"
      data-render-failed={failed === source || !diagramSourceAllowed(source) || undefined}
    >
      <code>{source}</code>
    </pre>
  );
});
