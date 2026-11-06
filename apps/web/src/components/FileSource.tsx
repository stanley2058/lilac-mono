import { lazy, Suspense, useState, useLayoutEffect, type ReactNode } from "react";
import { Eye, Code, WrapText } from "lucide-react";
import { IconButton } from "./ui";
import { HtmlFilePreview } from "./HtmlFilePreview";
import { Markdown } from "./Markdown";
import { fileLanguage, type FileTarget } from "../file-target";
import type { TextPreviewState } from "./ResourcePreview";
import "./file-viewer.css";

const FileCode = lazy(() => import("./FileCode"));

export function FileSource({
  name,
  href,
  text,
  line,
  endLine,
  navigation,
  heading,
  actions,
}: {
  name: string;
  href?: string;
  text: TextPreviewState;
  line?: number;
  endLine?: number;
  navigation?: FileTarget;
  heading?: ReactNode;
  actions?: ReactNode;
}) {
  const [wrap, setWrap] = useState(true);
  const [preview, setPreview] = useState(false);
  useLayoutEffect(() => {
    if (line) setPreview(false);
  }, [line, endLine, navigation]);
  const markdown = /\.(md|markdown|mdx)$/i.test(name);
  const html = /\.html?$/i.test(name) && !!href;
  const htmlPreview = preview && html;
  return (
    <div data-ui="file-source" className="file-source flex flex-col flex-1 min-w-0 min-h-0 h-full">
      <div className="file-source-toolbar flex items-center flex-none justify-end py-1 px-2 gap-1">
        {heading ? <div className="file-source-heading flex-1 min-w-0">{heading}</div> : null}
        {markdown || html ? (
          <IconButton
            label={preview ? "Show source" : `Preview ${html ? "HTML" : "Markdown"}`}
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? <Code /> : <Eye />}
          </IconButton>
        ) : null}
        {!preview ? (
          <IconButton label="Word wrap" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText />
          </IconButton>
        ) : null}
        {actions}
      </div>
      {htmlPreview ? <HtmlFilePreview key={href} href={href} name={name} /> : null}
      {!htmlPreview && text.status === "loading" ? (
        <div
          className="file-status grid place-content-center flex-1 p-4 text-sm text-muted-foreground"
          role="status"
        >
          Loading file…
        </div>
      ) : null}
      {!htmlPreview && text.status === "error" ? (
        <div
          className="file-status grid place-content-center flex-1 p-4 error-text text-danger text-sm"
          role="status"
        >
          {text.message}
        </div>
      ) : null}
      {!htmlPreview && text.status === "ready" ? (
        <>
          {preview && markdown ? (
            <div className="file-markdown flex-1 min-h-0 overflow-auto p-3">
              <Markdown text={text.text} wrap />
            </div>
          ) : (
            <Suspense
              fallback={
                <pre
                  className="file-code overflow-auto flex-1 min-h-0 font-mono text-sm leading-code [overscroll-behavior:contain] file-code-fallback whitespace-pre-wrap wrap-anywhere p-3"
                  data-wrap={wrap}
                >
                  {text.text}
                </pre>
              }
            >
              <FileCode
                source={text.text}
                language={fileLanguage(name)}
                wrap={wrap}
                line={line}
                endLine={endLine}
                navigation={navigation}
              />
            </Suspense>
          )}
          {text.truncated ? (
            <p className="file-notice flex-none p-2 text-muted-foreground text-xs">
              Showing the first 64 KB.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
