import {
  decodeHtmlPreviewFrameMessage,
  HTML_PREVIEW_LANGUAGE,
  HTML_PREVIEW_MAX_HEIGHT,
  HTML_PREVIEW_MIN_HEIGHT,
  htmlPreviewHref,
  htmlPreviewPath,
  htmlPreviewResult,
  htmlPreviewThemeFragment,
  htmlPreviewThemeMessage,
  type HtmlPreviewTheme,
} from "@stanley2058/lilac-client-protocol";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAppliedTheme } from "../theme/theme";
import { RequestActiveContext } from "./ActivityLog";
import { CodeBlock } from "./CodeBlock";
import { Skeleton } from "./ui/skeleton";

export const HtmlPreviewMessageContext = createContext<{
  threadId: string;
  messageId: string;
} | null>(null);

// Preview variable names follow shadcn; each reads the app's resolved `--ui-*` role.
const THEME_VARIABLES = [
  ["background", "background"],
  ["foreground", "foreground"],
  ["muted", "muted"],
  ["muted-foreground", "muted-foreground"],
  ["card", "surface"],
  ["card-foreground", "surface-foreground"],
  ["popover", "surface-raised"],
  ["popover-foreground", "surface-raised-foreground"],
  ["primary", "primary"],
  ["primary-foreground", "primary-foreground"],
  ["secondary", "secondary"],
  ["secondary-foreground", "secondary-foreground"],
  ["accent", "surface-hover"],
  ["accent-foreground", "hover-foreground"],
  ["destructive", "danger"],
  ["success", "success"],
  ["warning", "warning"],
  ["info", "info"],
  ["border", "border"],
  ["input", "input-border"],
  ["ring", "focus"],
  ["link", "link"],
  ["chart-1", "primary"],
  ["chart-2", "info"],
  ["chart-3", "success"],
  ["chart-4", "warning"],
  ["chart-5", "danger"],
  ["radius", "radius-md"],
  ["font-sans", "font-sans"],
  ["font-mono", "font-mono"],
] as const;

const DEFAULT_HEIGHT = 240;
/** Heights the pages reported, so a row that remounts reserves the same space while its frame reloads. */
const reportedHeights = new Map<string, number>();
const MAX_REPORTED_HEIGHTS = 512;

function rememberHeight(src: string, height: number) {
  reportedHeights.delete(src);
  reportedHeights.set(src, height);
  if (reportedHeights.size <= MAX_REPORTED_HEIGHTS) return;
  const oldest = reportedHeights.keys().next().value;
  if (oldest !== undefined) reportedHeights.delete(oldest);
}

export function HtmlPreviewSkeleton({ height = DEFAULT_HEIGHT }: { height?: number }) {
  return (
    <Skeleton
      data-ui="html-preview-pending"
      role="status"
      aria-label="Loading preview"
      className="w-(--ui-chat-width) max-w-full"
      style={{ height }}
    />
  );
}

function readTheme(appearance: HtmlPreviewTheme["appearance"]): HtmlPreviewTheme {
  const style = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const [name, role] of THEME_VARIABLES) {
    const value = style.getPropertyValue(`--ui-${role}`).trim();
    if (value) variables[`--${name}`] = value;
  }
  return { appearance, variables };
}

function clampHeight(height: number) {
  return Math.min(HTML_PREVIEW_MAX_HEIGHT, Math.max(HTML_PREVIEW_MIN_HEIGHT, Math.ceil(height)));
}

export function HtmlPreviewFrame({
  src,
  title,
  fill = false,
}: {
  src: string;
  title: string;
  fill?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const applied = useAppliedTheme();
  // The URL carries only the first theme; changing it would reload the page, so later themes are posted.
  const [initialSrc] = useState(() => `${src}${htmlPreviewThemeFragment(readTheme(applied.kind))}`);
  const [height, setHeight] = useState(() => reportedHeights.get(src) ?? DEFAULT_HEIGHT);
  const [loaded, setLoaded] = useState(false);
  const postTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      htmlPreviewThemeMessage(readTheme(applied.kind)),
      "*",
    );
  }, [applied]);
  useEffect(postTheme, [postTheme]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const message = decodeHtmlPreviewFrameMessage(event.data);
      if (message?.kind === "size") {
        if (fill) return;
        const next = clampHeight(message.height);
        rememberHeight(src, next);
        setHeight(next);
        return;
      }
      if (message?.kind !== "link") return;
      window.open(message.url, "_blank", "noopener,noreferrer");
      frame.postMessage(htmlPreviewResult(message.id), "*");
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [fill, src]);
  return (
    <div
      className={
        fill ? "relative flex-1 min-h-0 w-full h-full" : "relative w-(--ui-chat-width) max-w-full"
      }
      aria-busy={!loaded}
    >
      {!loaded ? <HtmlPreviewSkeleton height={height} /> : null}
      <iframe
        ref={frameRef}
        src={initialSrc}
        title={title}
        // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
        // A frame has no content width, so it asks for the chat width and the reply card clamps it.
        sandbox="allow-scripts allow-forms allow-popups"
        loading="eager"
        onLoad={() => {
          postTheme();
          setLoaded(true);
        }}
        data-ui="html-preview"
        data-loaded={loaded}
        className="block w-full border-0 bg-transparent data-[loaded=false]:absolute data-[loaded=false]:inset-0 data-[loaded=false]:invisible"
        style={{ height: fill ? "100%" : height, colorScheme: applied.kind }}
      />
    </div>
  );
}

export function HtmlPreviewBlock({ source }: { source: string }) {
  const message = useContext(HtmlPreviewMessageContext);
  const active = useContext(RequestActiveContext);
  const path = htmlPreviewPath(source);
  if (!message || path === undefined)
    return <CodeBlock source={source} language={HTML_PREVIEW_LANGUAGE} />;
  if (active) return <HtmlPreviewSkeleton />;
  const href = htmlPreviewHref({ ...message, path });
  return <HtmlPreviewFrame key={href} src={href} title={path.split("/").at(-1) || path} />;
}
