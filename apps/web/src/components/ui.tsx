import { Kbd } from "./ui/kbd";
import { useShortcut } from "../shortcuts";
import type { ShortcutAction } from "../keybindings";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { X } from "lucide-react";
import { createVirtualListMotion } from "./virtual-list-motion";
import { useRovingRows } from "./roving-rows";
import { Result } from "better-result";

export function IconButton({
  label,
  tooltip = label,
  tooltipSide,
  shortcut,
  children,
  variant = "ghost",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tooltip?: ReactNode;
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
  shortcut?: ShortcutAction;
  variant?: ComponentProps<typeof Button>["variant"];
}) {
  const keys = useShortcut(shortcut);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={variant}
            size="icon"
            {...props}
            className={`icon-button rounded-sm ${variant === "ghost" ? "text-muted-foreground" : ""} ${props.className ?? ""}`}
            aria-label={label}
            aria-keyshortcuts={keys.aria ?? props["aria-keyshortcuts"]}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        {tooltip}
        {keys.label ? <Kbd>{keys.label}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  open: controlledOpen,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  open?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(true);
  const close = () => {
    if (controlledOpen !== undefined) onClose();
    else setLocalOpen(false);
  };
  return (
    <Dialog
      open={controlledOpen ?? localOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onOpenChangeComplete={(open) => {
        if (!open && controlledOpen === undefined) onClose();
      }}
    >
      <DialogContent
        className={`block max-h-[calc(100dvh-calc(var(--ui-space-unit)*8))] overflow-y-auto p-5 ${wide ? "sm:max-w-4xl" : "sm:max-w-lg"}`}
        showCloseButton={false}
      >
        <DialogHeader className="modal-header flex gap-4 mb-4 flex-row items-center justify-between">
          <DialogTitle>{title}</DialogTitle>
          <IconButton label="Close" onClick={close}>
            <X />
          </IconButton>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function VirtualList<T>({
  items,
  itemKey,
  render,
  label,
  className = "",
  estimate = 52,
  activeIndex,
  presentation = false,
  onEndReached,
  hasMore = false,
  loading = false,
  scrollFade = false,
  fillBeforeIndex,
  emptyState,
  animateChanges = false,
  reveal,
  loadOnlyAfterScroll = false,
  roving,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  label: string;
  className?: string;
  estimate?: number;
  activeIndex?: number;
  presentation?: boolean;
  onEndReached?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  scrollFade?: boolean;
  fillBeforeIndex?: number;
  emptyState?: ReactNode;
  animateChanges?: boolean;
  /** Scrolls an item to the top each time this object changes. */
  reveal?: { index: number };
  /** For lists that share a cursor with others, where a short list must not page for itself. */
  loadOnlyAfterScroll?: boolean;
  /** Makes the list one tab stop that arrow keys move through. */
  roving?: { primary?: string; selected?: string; enabled?: boolean };
}) {
  // TanStack Virtual returns a mutable virtualizer, which the compiler cannot memoize safely.
  "use no memo";
  const parent = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const motion = useRef<ReturnType<typeof createVirtualListMotion>>(undefined);
  useLayoutEffect(() => () => motion.current?.dispose(), []);
  useLayoutEffect(() => {
    if (!animateChanges && !motion.current) return;
    motion.current ??= createVirtualListMotion(canvas.current!);
    motion.current.update(items.map(itemKey), animateChanges);
  });
  const getItemKey = useCallback((index: number) => itemKey(items[index]!), [items, itemKey]);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => estimate,
    getItemKey,
    overscan: 5,
  });
  const fillSpace =
    fillBeforeIndex !== undefined && fillBeforeIndex >= 0
      ? Math.max(
          emptyState ? estimate : 0,
          (virtual.scrollRect?.height ?? 0) - virtual.getTotalSize(),
        )
      : 0;
  const remaining =
    virtual.getTotalSize() - (virtual.scrollOffset ?? 0) - (virtual.scrollRect?.height ?? 0);
  const nearEnd = remaining < estimate * 3;
  const reachEnd = useEffectEvent(() => onEndReached?.());
  const canLoad = !loadOnlyAfterScroll || (virtual.scrollOffset ?? 0) > 0;
  useEffect(() => {
    if (nearEnd && hasMore && !loading && canLoad) reachEnd();
  }, [nearEnd, hasMore, loading, canLoad, items.length]);
  useEffect(() => {
    if (activeIndex !== undefined) virtual.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, virtual]);
  useEffect(() => {
    if (reveal) virtual.scrollToIndex(reveal.index, { align: "start" });
  }, [reveal, virtual]);
  useRovingRows(parent, {
    enabled: !!roving && roving.enabled !== false,
    count: items.length,
    primary: roving?.primary,
    selected: roving?.selected,
    scrollToIndex: (index) => virtual.scrollToIndex(index, { align: "auto" }),
  });
  return (
    <div
      ref={parent}
      className={`virtual-list overflow-auto relative min-h-0 pr-1 mr-[calc(-1_*_calc(var(--ui-space-unit)*1))] ${className} ${scrollFade && (remaining > 1 || hasMore) ? "scroll-fade" : ""}`}
      aria-busy={loading || undefined}
      data-roving-list={roving ? "" : undefined}
      aria-label={presentation ? undefined : label}
      role={presentation ? "presentation" : "list"}
    >
      {emptyState ? (
        <div
          className="absolute inset-x-0 top-0"
          style={{ height: fillBeforeIndex === 0 ? fillSpace : "100%" }}
        >
          {emptyState}
        </div>
      ) : null}
      <div
        ref={canvas}
        className="virtual-canvas relative w-full"
        style={{ height: virtual.getTotalSize() + fillSpace }}
      >
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            ref={virtual.measureElement}
            data-index={row.index}
            data-motion-key={row.key}
            data-motion-top={
              row.start +
              (fillBeforeIndex !== undefined && row.index >= fillBeforeIndex ? fillSpace : 0)
            }
            role={presentation ? "presentation" : "listitem"}
            className="virtual-row absolute top-0 left-0 w-full"
            style={{
              transform: `translateY(${row.start + (fillBeforeIndex !== undefined && row.index >= fillBeforeIndex ? fillSpace : 0)}px)`,
            }}
          >
            {render(items[row.index]!, row.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function uiError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The request failed";
}

export async function attempt<T>(
  operation: () => Promise<T>,
  onError: (message: string) => void,
): Promise<T | undefined> {
  const result = await Result.tryPromise({ try: operation, catch: uiError });
  return result.match({
    ok: (value) => value,
    err: (message) => {
      onError(message);
      return undefined;
    },
  });
}

export function ErrorNotice({ message, onDismiss }: { message?: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div
      className="error-notice flex items-center gap-3 py-2 px-3 rounded-sm [background:color-mix(in_srgb,_var(--ui-danger)_10%,_var(--ui-background))] text-danger text-sm whitespace-pre-wrap wrap-anywhere"
      role="alert"
    >
      <span>{message}</span>
      {onDismiss ? (
        <IconButton label="Dismiss error" onClick={onDismiss}>
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}
