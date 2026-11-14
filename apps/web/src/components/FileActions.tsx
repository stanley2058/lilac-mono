import { FileIcon } from "./FileIcon";
import { useImageFailure } from "../image-retry";
import { useState, type ReactNode } from "react";
import { Copy, ImageOff, ScanEye, PanelRight } from "lucide-react";
import { copyMessage, messageClipboardData } from "../message-clipboard";
import { copyPreviewImage } from "../image-clipboard";
import type { FileTarget } from "../file-target";
import { useFileResolution, useFileViewer } from "./file-viewer-context";
import { FileTargetPreview } from "./FileViewer";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./ui/context-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Button } from "./ui/button";
import { toast as toastManager } from "./ui/toast";
import { attempt } from "./ui";

export function FileActions({
  target,
  children,
  onPreview,
  disabled = false,
}: {
  target: FileTarget;
  children: ReactNode;
  onPreview?: () => void;
  disabled?: boolean;
}) {
  const viewer = useFileViewer();
  const [preview, setPreview] = useState(false);
  async function copy() {
    const message =
      target.type === "resource" && target.resourceId
        ? {
            text: "",
            resources: [
              { resourceId: target.resourceId, name: target.name, mediaType: target.mediaType },
            ],
          }
        : undefined;
    if (target.type === "resource" && target.mediaType.startsWith("image/")) {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = target.href;
      await image.decode();
      const result = await copyPreviewImage(
        image,
        message && ((pngUrl) => messageClipboardData(message, pngUrl)),
      );
      result.match({
        ok: () => toastManager.add({ title: "Copied!", type: "success" }),
        err: (error) => toastManager.add({ title: error.message, type: "error" }),
      });
      return;
    }
    if (message) {
      await copyMessage(message);
      toastManager.add({ title: "Copied!", type: "success" });
      return;
    }
    await navigator.clipboard.writeText(
      target.type === "path" ? target.path : (target.path ?? target.href),
    );
    toastManager.add({ title: "Copied!", type: "success" });
  }
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={<span className="file-context-target contents" />}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={disabled}
            onClick={() =>
              void attempt(copy, (message) => toastManager.add({ title: message, type: "error" }))
            }
          >
            <Copy />
            Copy
          </ContextMenuItem>
          <ContextMenuItem
            disabled={disabled}
            onClick={() => (onPreview ? onPreview() : setPreview(true))}
          >
            <ScanEye />
            Open in preview
          </ContextMenuItem>
          <ContextMenuItem disabled={disabled || !viewer} onClick={() => viewer?.openFile(target)}>
            <PanelRight />
            Open in right panel
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {preview ? <FileTargetPreview target={target} onClose={() => setPreview(false)} /> : null}
    </>
  );
}

export function FileLink({ target }: { target: FileTarget }) {
  const viewer = useFileViewer();
  if (!viewer && target.type === "resource") return <a href={target.href}>{target.name}</a>;
  if (!viewer)
    return (
      <code>
        {target.type === "path" ? target.path : target.name}
        {target.line ? `:${target.line}` : ""}
        {target.endLine ? `-${target.endLine}` : ""}
      </code>
    );
  return <ResolvedFileLink target={target} />;
}

function ResolvedFileLink({ target }: { target: FileTarget }) {
  const viewer = useFileViewer();
  const [preview, setPreview] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { file } = useFileResolution(target, hovered);
  const resolved = file ?? target;
  const path = file?.path ?? (target.type === "path" ? target.path : (target.path ?? target.name));
  return (
    <FileActions target={resolved} onPreview={() => setPreview(true)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="reference"
              className="file-link"
              data-copy-content
              onPointerEnter={() => setHovered(true)}
              onFocus={() => setHovered(true)}
              onClick={() => (viewer ? viewer.openFile(resolved) : setPreview(true))}
            />
          }
        >
          <FileIcon
            name={target.name}
            mediaType={target.type === "resource" ? target.mediaType : undefined}
          />
          <span>
            {target.name}
            {target.line ? ` · L${target.line}` : ""}
            {target.endLine ? `-${target.endLine}` : ""}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {path}
          {target.line ? `:${target.line}` : ""}
          {target.endLine ? `-${target.endLine}` : ""}
        </TooltipContent>
      </Tooltip>
      {preview ? <FileTargetPreview target={resolved} onClose={() => setPreview(false)} /> : null}
    </FileActions>
  );
}

export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [preview, setPreview] = useState(false);
  const [failed, fail] = useImageFailure<string>();
  if (!src) return <img alt={alt ?? ""} />;
  if (failed === src)
    return (
      <span
        className="inline-flex max-w-full items-center gap-2 rounded-md bg-surface px-3 py-2 align-middle text-xs text-muted-foreground [&_svg]:size-4 [&_svg]:flex-none"
        role="img"
        aria-label={alt ? `${alt}, image unavailable` : "Image unavailable"}
        data-copy-content
      >
        <ImageOff aria-hidden />
        <span className="min-w-0 truncate">{alt || "Image unavailable"}</span>
      </span>
    );
  const target: FileTarget = {
    type: "resource",
    href: src,
    name: alt || src.split("/").at(-1) || "Image",
    mediaType: "image/*",
  };
  return (
    <FileActions target={target} onPreview={() => setPreview(true)}>
      <Button
        variant="ghost"
        className="markdown-image-trigger"
        data-copy-content
        aria-label={`Preview ${target.name}`}
        onClick={() => setPreview(true)}
      >
        <img
          src={src}
          alt={alt ?? ""}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => fail(src)}
        />
      </Button>
      {preview ? <FileTargetPreview target={target} onClose={() => setPreview(false)} /> : null}
    </FileActions>
  );
}
