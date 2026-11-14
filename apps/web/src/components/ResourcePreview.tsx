import { useEventCallback } from "../use-event-callback";
import { useImageFailure } from "../image-retry";
import { FileIcon } from "./FileIcon";
import { FileActions } from "./FileActions";
import type { FileTarget } from "../file-target";
import { useFileViewer } from "./file-viewer-context";
import { FileSource } from "./FileSource";
import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from "react";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import {
  PanelRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  ImageOff,
  Film,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  X,
} from "lucide-react";
import { copyPreviewImage } from "../image-clipboard";
import { loadResourcePreview } from "../resource-preview";
import { Button } from "./ui/button";
import {
  Attachment,
  AttachmentAction,
  AttachmentTitle,
  AttachmentDescription,
} from "./ui/attachment";
import { IconButton } from "./ui";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import "./message-presentation.css";
import "./resource-preview.css";

type ResourceData = Extract<DisplayPart, { type: "data-resource" }>["data"];
export type AttachmentKind = "image" | "video" | "audio" | "text" | "pdf";
export function attachmentKind(mediaType: string, name = ""): AttachmentKind {
  const genericType = mediaType === "" || mediaType === "application/octet-stream";
  if (mediaType === "application/pdf" || (genericType && /\.pdf$/iu.test(name))) return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "text";
}
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReadyAttachment({ data, href }: { data: ResourceData; href: string }) {
  const [imageFailed, failImage] = useImageFailure<true>();
  const failed = data.state === "failed" || !!imageFailed;
  const [preview, setPreview] = useState(false);
  const kind = attachmentKind(data.mediaType, data.name);
  return (
    <FileActions
      target={{
        type: "resource",
        href,
        name: data.name,
        mediaType: data.mediaType,
        resourceId: data.resourceId,
      }}
      onPreview={() => setPreview(true)}
    >
      <Attachment
        className={
          kind === "image"
            ? "attachment-image-card"
            : "attachment-card flex flex-col flex-nowrap items-stretch p-0 border-0 w-fit max-w-full overflow-hidden bg-surface text-card-foreground rounded-lg"
        }
        state={failed ? "error" : "done"}
      >
        {kind === "image" ? (
          <Button
            type="button"
            variant="ghost"
            className="attachment-image-thumbnail border-0 w-full h-full p-0 rounded-[inherit] cursor-zoom-in"
            aria-label={`Preview ${data.name}`}
            onClick={() => setPreview(true)}
          >
            {failed ? (
              <span
                className="attachment-image-unavailable flex flex-col items-center gap-2 whitespace-normal text-muted-foreground text-xs"
                role="status"
              >
                <ImageOff />
                <span>Image unavailable</span>
              </span>
            ) : (
              <img
                src={href}
                alt={data.name}
                loading="lazy"
                decoding="async"
                onError={() => failImage(true)}
              />
            )}
          </Button>
        ) : null}
        {kind === "video" ? (
          <button
            type="button"
            className="attachment-thumbnail block relative cursor-zoom-in p-2 border-0 bg-transparent"
            aria-label={`Preview ${data.name}`}
            onClick={() => setPreview(true)}
          >
            <video src={href} preload="metadata" muted playsInline aria-label={data.name} />
            <Film className="attachment-video-icon absolute left-4 bottom-4 bg-surface rounded-sm p-1 w-8 h-8" />
          </button>
        ) : null}
        {kind === "audio" ? (
          <audio
            className="attachment-audio max-w-full p-2"
            src={href}
            preload="none"
            controls
            aria-label={data.name}
          />
        ) : null}
        {kind !== "image" ? (
          <div className="attachment-file-row flex w-full min-w-0 items-center gap-2 p-2">
            <Button
              variant="ghost"
              className="attachment-open flex-auto overflow-hidden h-auto min-w-0 justify-start text-left whitespace-normal"
              onClick={() => setPreview(true)}
              aria-label={`Preview ${data.name}`}
            >
              <FileIcon name={data.name} mediaType={data.mediaType} />
              <span>
                <AttachmentTitle className="attachment-name block overflow-hidden whitespace-nowrap text-ellipsis">
                  {data.name}
                </AttachmentTitle>
                <AttachmentDescription className="attachment-size block text-muted-foreground text-xs">
                  {formatFileSize(data.size)}
                </AttachmentDescription>
              </span>
            </Button>
            <AttachmentAction
              className="attachment-download flex shrink-0 items-center justify-center w-[var(--ui-control-size)] h-[var(--ui-control-size)] rounded-full"
              size="icon"
              nativeButton={false}
              render={<a href={href} download={data.name} target="_blank" rel="noreferrer" />}
              aria-label={`Download ${data.name}`}
              title={`Download ${data.name}`}
            >
              <Download />
            </AttachmentAction>
          </div>
        ) : null}
        {preview ? (
          <ResourcePreview
            name={data.name}
            href={href}
            kind={kind}
            target={{
              type: "resource",
              href,
              name: data.name,
              mediaType: data.mediaType,
              resourceId: data.resourceId,
            }}
            onClose={() => setPreview(false)}
          />
        ) : null}
      </Attachment>
    </FileActions>
  );
}

export type TextPreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; truncated: boolean };

export function isMarkdownAttachment(name: string): boolean {
  return /\.(?:md|markdown|mdx)$/iu.test(name);
}

function PreviewDownload({ name, href }: { name: string; href: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      nativeButton={false}
      render={<a href={href} download={name} />}
      aria-label={`Download ${name}`}
      title={`Download ${name}`}
    >
      <Download />
    </Button>
  );
}

function PreviewFrame({
  children,
  toolbar,
  note,
  fill = false,
}: {
  children: ReactNode;
  toolbar: ReactNode;
  note?: ReactNode;
  fill?: boolean;
}) {
  return (
    <div className="attachment-preview-body" data-fill={fill}>
      <div className="attachment-preview-stage [grid-area:1_/_1] min-w-0 min-h-0 h-full overflow-hidden">
        {children}
      </div>
      <div
        data-ui="attachment-preview-footer"
        className="attachment-preview-footer [grid-area:2_/_1] min-w-0 text-center"
      >
        {note}
        <div
          data-ui="media-preview-toolbar"
          className="media-preview-toolbar flex items-center justify-center flex-wrap gap-2 pt-3 text-sm pointer-events-none"
        >
          {toolbar}
        </div>
      </div>
    </div>
  );
}

function PreviewStatus({ children }: { children: ReactNode }) {
  return (
    <div data-ui="attachment-preview-empty" className="attachment-preview-empty" role="status">
      <div>{children}</div>
    </div>
  );
}

function TextAttachmentPreview({
  name,
  href,
  text,
  fill = false,
  line,
  endLine,
  actions,
}: {
  name: string;
  href: string;
  text?: TextPreviewState;
  fill?: boolean;
  line?: number;
  endLine?: number;
  actions?: ReactNode;
}) {
  return (
    <PreviewFrame
      fill={fill}
      toolbar={
        <>
          <PreviewDownload name={name} href={href} />
          {actions}
        </>
      }
    >
      <div className="attachment-source-body h-full min-h-0 flex flex-col w-full max-w-[var(--ui-chat-width)] mx-auto">
        <FileSource
          href={href}
          name={name}
          text={text ?? { status: "loading" }}
          line={line}
          endLine={endLine}
        />
      </div>
    </PreviewFrame>
  );
}

export function AttachmentPreviewBody({
  line,
  endLine,
  actions,
  name,
  href,
  kind,
  text,
  fill = false,
}: {
  name: string;
  href: string;
  kind: AttachmentKind;
  line?: number;
  endLine?: number;
  actions?: ReactNode;
  text?: TextPreviewState;
  fill?: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const [failed, fail] = useImageFailure<true>();
  const [loaded, setLoaded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">("idle");
  const [copyError, setCopyError] = useState<string>();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  function startPan(event: PointerEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    if (
      pan.current ||
      kind !== "image" ||
      event.button !== 0 ||
      (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)
    )
      return;
    event.preventDefault();
    pan.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    element.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    const origin = pan.current;
    if (!origin || origin.id !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = origin.left + origin.x - event.clientX;
    event.currentTarget.scrollTop = origin.top + origin.y - event.clientY;
  }
  function stopPan(event: PointerEvent<HTMLDivElement>) {
    if (pan.current?.id !== event.pointerId) return;
    pan.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }
  const previewImage = useRef<HTMLImageElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const measureFit = useEventCallback(() => {
    const image = previewImage.current;
    const element = viewport.current;
    if (!image?.naturalWidth || !element?.clientWidth) return;
    setFitScale(
      imageFitScale(
        { width: image.naturalWidth, height: image.naturalHeight },
        { width: element.clientWidth, height: element.clientHeight },
      ),
    );
  });
  useEffect(() => {
    const element = viewport.current;
    if (!element || kind !== "image") return;
    const observer = new ResizeObserver(() => measureFit());
    observer.observe(element);
    return () => observer.disconnect();
  }, [kind, measureFit, failed]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || kind !== "image") return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      changeZoom(event.deltaY < 0 ? 0.1 : -0.1);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [kind, failed]);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    const center = measureViewportCenter();
    if (!anchor || !center) return;
    center.viewport.scrollLeft += (anchor.x - center.x) * center.width;
    center.viewport.scrollTop += (anchor.y - center.y) * center.height;
  }, [zoom]);
  function changeZoom(amount: number) {
    // The content box resizes from its top-left corner, so remember which point sits at the
    // viewport center before the resize and scroll it back to the center afterward.
    zoomAnchor.current = measureViewportCenter();
    setZoom((current) => Math.min(4, Math.max(0.25, current + amount)));
  }
  function measureViewportCenter() {
    const viewportElement = viewport.current;
    const contentElement = content.current;
    if (!viewportElement || !contentElement) return null;
    const viewportRect = viewportElement.getBoundingClientRect();
    const contentRect = contentElement.getBoundingClientRect();
    if (contentRect.width <= 0 || contentRect.height <= 0) return null;
    return {
      viewport: viewportElement,
      x:
        (viewportRect.left + viewportElement.clientWidth / 2 - contentRect.left) /
        contentRect.width,
      y:
        (viewportRect.top + viewportElement.clientHeight / 2 - contentRect.top) /
        contentRect.height,
      width: contentRect.width,
      height: contentRect.height,
    };
  }
  async function copyImage() {
    const image = previewImage.current;
    if (!image) return;
    setCopyState("copying");
    setCopyError(undefined);
    const copied = await copyPreviewImage(image);
    copied.match({
      ok: () => setCopyState("copied"),
      err: (error) => {
        setCopyState("idle");
        setCopyError(error.message);
      },
    });
  }
  const download = (
    <>
      <PreviewDownload name={name} href={href} />
      {actions}
    </>
  );
  if (kind === "text")
    return (
      <TextAttachmentPreview
        name={name}
        href={href}
        text={text}
        fill={fill}
        line={line}
        endLine={endLine}
        actions={actions}
      />
    );
  if (failed)
    return (
      <PreviewFrame fill={fill} toolbar={download}>
        <PreviewStatus>
          <p className="error-text text-danger text-sm">This file is unavailable.</p>
        </PreviewStatus>
      </PreviewFrame>
    );
  if (kind === "pdf")
    return (
      <PreviewFrame
        fill={fill}
        toolbar={
          <>
            <Button
              variant="ghost"
              size="icon"
              nativeButton={false}
              render={<a href={href} target="_blank" rel="noreferrer" />}
              aria-label="Open PDF in new tab"
              title="Open PDF in new tab"
            >
              <ExternalLink />
            </Button>
            {download}
          </>
        }
      >
        <object
          className="attachment-pdf-preview block"
          data={href}
          type="application/pdf"
          aria-label={`${name} PDF preview`}
        >
          <PreviewStatus>
            Your browser cannot display this PDF.{" "}
            <a href={href} download={name}>
              Download {name}
            </a>
          </PreviewStatus>
        </object>
      </PreviewFrame>
    );
  if (kind === "audio")
    return (
      <PreviewFrame fill={fill} toolbar={download}>
        <div className="attachment-audio-preview">
          <audio
            src={href}
            controls
            autoPlay={false}
            preload="metadata"
            aria-label={name}
            onError={() => fail(true)}
          />
        </div>
      </PreviewFrame>
    );
  return (
    <PreviewFrame
      fill={fill}
      note={
        copyError ? (
          <p className="error-text text-danger text-sm" role="status">
            {copyError}
          </p>
        ) : null
      }
      toolbar={
        <>
          {kind === "image" ? (
            <>
              <IconButton
                label="Zoom out"
                disabled={zoom <= 0.25}
                onClick={() => changeZoom(-0.25)}
              >
                <ZoomOut />
              </IconButton>
              <span aria-live="polite">{Math.round(zoom * 100)}%</span>
              <IconButton label="Zoom in" disabled={zoom >= 4} onClick={() => changeZoom(0.25)}>
                <ZoomIn />
              </IconButton>
              <IconButton label="Reset zoom" onClick={() => setZoom(1)}>
                <RotateCcw />
              </IconButton>
              <IconButton
                label={copyState === "copied" ? "Image copied" : "Copy image"}
                disabled={!loaded || copyState === "copying"}
                onClick={() => {
                  void copyImage();
                }}
              >
                {copyState === "copied" ? <Check /> : <Copy />}
              </IconButton>
            </>
          ) : null}
          {download}
        </>
      }
    >
      <div
        ref={viewport}
        data-ui="media-preview-viewport"
        className="media-preview-viewport h-full w-full flex overflow-auto [overscroll-behavior:contain] bg-background rounded-md"
        tabIndex={0}
        role="region"
        aria-label={`${name} preview`}
        data-pan-enabled={kind === "image" && zoom > 1}
        data-dragging={dragging}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
        onLostPointerCapture={stopPan}
      >
        <div
          ref={content}
          className="media-preview-content min-w-0 [flex:0_0_auto] flex items-center justify-center m-auto"
          style={{ width: `${zoom * fitScale * 100}%`, height: `${zoom * fitScale * 100}%` }}
        >
          {kind === "image" ? (
            <img
              ref={previewImage}
              src={href}
              alt={name}
              draggable={false}
              onLoad={() => {
                setLoaded(true);
                measureFit();
              }}
              onError={() => fail(true)}
            />
          ) : (
            <video
              src={href}
              controls
              preload="metadata"
              aria-label={name}
              onError={() => fail(true)}
            />
          )}
        </div>
      </div>
    </PreviewFrame>
  );
}

/**
 * How much of the viewport the content box takes at 100% zoom. A small image shows at its natural
 * size instead of stretching to fill the preview.
 */
export function imageFitScale(
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0)
    return 1;
  return Math.min(1, Math.max(image.width / viewport.width, image.height / viewport.height));
}

export function isWithinContainedImage(
  point: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number },
  image: { width: number; height: number },
): boolean {
  if (image.width <= 0 || image.height <= 0) return false;
  const scale = Math.min(bounds.width / image.width, bounds.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  return point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height;
}

function isPreviewBackdrop(target: EventTarget, x: number, y: number): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      "button, a, audio, video, object, [data-ui=file-source], [data-ui=media-preview-toolbar], [data-ui=attachment-preview-note], [data-ui=resource-preview-title], [data-ui=attachment-preview-empty] > *",
    )
  )
    return false;
  const image = target.closest("[data-ui=media-preview-viewport]")?.querySelector("img");
  if (!image) return true;
  return !isWithinContainedImage({ x, y }, image.getBoundingClientRect(), {
    width: image.naturalWidth,
    height: image.naturalHeight,
  });
}

export function useResourcePreviewText(
  href: string,
  kind: AttachmentKind,
  enabled = true,
): TextPreviewState {
  const preview = useQuery({
    queryKey: ["resource-preview", href],
    queryFn: ({ signal }) => loadResourcePreview(href, signal),
    enabled: enabled && kind === "text" && !!href,
    staleTime: 0,
    gcTime: 60_000,
  });
  return (
    preview.data?.match({
      ok: (value): TextPreviewState => ({
        status: "ready",
        text: value.text,
        truncated: value.truncated,
      }),
      err: (error): TextPreviewState => ({ status: "error", message: error.message }),
    }) ?? { status: "loading" }
  );
}

export function ResourcePreview({
  target,
  textState,
  line,
  endLine,
  name,
  href,
  kind,
  onClose,
}: {
  name: string;
  href: string;
  kind: AttachmentKind;
  onClose: () => void;
  line?: number;
  endLine?: number;
  target?: FileTarget;
  textState?: TextPreviewState;
}) {
  const viewer = useFileViewer();
  const loaded = useResourcePreviewText(textState ? "" : href, kind);
  const text = textState ?? loaded;
  const [open, setOpen] = useState(true);
  const backdropPress = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  function beginBackdropPress(event: PointerEvent<HTMLDivElement>) {
    backdropPress.current = null;
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      !isPreviewBackdrop(event.target, event.clientX, event.clientY)
    )
      return;
    backdropPress.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  }
  function moveBackdropPress(event: PointerEvent<HTMLDivElement>) {
    const press = backdropPress.current;
    if (!press || press.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.moved = true;
  }
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="resource-preview-dialog translate-none"
        showCloseButton={false}
        // Portal events must not reach the attachment's context-menu trigger.
        onContextMenu={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onPointerDownCapture={beginBackdropPress}
        onPointerMoveCapture={moveBackdropPress}
        onPointerCancelCapture={() => {
          backdropPress.current = null;
        }}
        onClickCapture={(event) => {
          const press = backdropPress.current;
          backdropPress.current = null;
          if (
            !press ||
            press.moved ||
            !isPreviewBackdrop(event.target, event.clientX, event.clientY)
          )
            return;
          setOpen(false);
        }}
      >
        <header className="resource-preview-header grid [grid-template-columns:var(--ui-control-size)_minmax(0,_1fr)_var(--ui-control-size)] items-center gap-3 [flex:0_0_auto] min-w-0 pointer-events-none">
          <DialogTitle
            data-ui="resource-preview-title"
            className="resource-preview-title"
            title={name}
          >
            <FileIcon
              name={name}
              mediaType={target?.type === "resource" ? target.mediaType : undefined}
            />
            <span>{name}</span>
          </DialogTitle>
          <IconButton
            label="Close preview"
            className="resource-preview-close [grid-column:3]"
            onClick={() => setOpen(false)}
          >
            <X />
          </IconButton>
        </header>
        <AttachmentPreviewBody
          actions={
            viewer ? (
              <Button
                aria-label="Open in right panel"
                title="Open in right panel"
                variant="ghost"
                size="icon"
                onClick={() => {
                  viewer.openFile(
                    target ?? {
                      type: "resource",
                      name,
                      href,
                      mediaType: previewMediaType(kind),
                      line,
                      endLine,
                    },
                  );
                  setOpen(false);
                }}
              >
                <PanelRight />
              </Button>
            ) : null
          }
          key={href}
          name={name}
          href={href}
          kind={kind}
          text={text}
          line={line}
          endLine={endLine}
          fill
        />
      </DialogContent>
    </Dialog>
  );
}

function previewMediaType(kind: AttachmentKind): string {
  if (kind === "text") return "text/plain";
  if (kind === "pdf") return "application/pdf";
  return `${kind}/*`;
}
