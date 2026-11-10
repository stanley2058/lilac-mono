import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  pointerWithin,
  closestCenter,
  type DragOverEvent,
  type KeyboardCoordinateGetter,
  type CollisionDetection,
} from "@dnd-kit/core";
import { Check, ChevronDown, Pin, PinOff, Undo2 } from "lucide-react";
import type { SidebarSection } from "@stanley2058/lilac-client-protocol";
import {
  dropAction,
  moveInQueues,
  queueSection,
  sidebarLabels,
  sidebarSections,
  type QueueThread,
  type ThreadMove,
  type ThreadQueues,
} from "../sidebar-order";
import { VirtualList } from "./ui";
import { ThreadCard, threadDisplayState } from "./ThreadSelect";
import { Button } from "./ui/button";
import { readMotionDuration } from "../theme/motion";
import "./thread-queue.css";

type QueueRow =
  | { id: string; section: SidebarSection; kind: "heading" | "end" | "draft-divider" }
  | { id: string; section: SidebarSection; kind: "thread"; thread: QueueThread };
const keyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return;
  event.preventDefault();
  const direction = event.code === "ArrowDown" ? 1 : -1;
  const currentY =
    (context.collisionRect?.top ?? currentCoordinates.y) + (context.collisionRect?.height ?? 0) / 2;
  const candidates = context.droppableContainers
    .getEnabled()
    .flatMap((container) => {
      if (container.id === context.active?.id) return [];
      const rect = context.droppableRects.get(container.id);
      if (!rect) return [];
      const y = rect.top + rect.height / 2;
      return (y - currentY) * direction > 1 ? [{ x: rect.left + rect.width / 2, y }] : [];
    })
    .sort((a, b) => (a.y - b.y) * direction);
  const next = candidates[0];
  return next
    ? { x: currentCoordinates.x, y: currentCoordinates.y + next.y - currentY }
    : undefined;
};
const collision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

export function ThreadQueue({
  queues,
  totals,
  renderThread,
  onMove,
  disabled = false,
  hasMore = false,
  loading = false,
  onEndReached,
  settledOpen,
  onSettledOpen,
  emptyState,
}: {
  queues: ThreadQueues;
  totals: Record<SidebarSection, number>;
  renderThread: (thread: QueueThread, section: SidebarSection) => ReactNode;
  onMove: (move: ThreadMove) => void;
  disabled?: boolean;
  hasMore?: boolean;
  loading?: boolean;
  onEndReached?: () => void;
  settledOpen: boolean;
  onSettledOpen: (open: boolean) => void;
  emptyState?: ReactNode;
}) {
  const [dropDuration, setDropDuration] = useState(150);
  const [drag, setDrag] = useState<
    { id: string; from: SidebarSection; move?: ThreadMove; thread: QueueThread } | undefined
  >();
  const dragRef = useRef(drag);
  const keyboardDirection = useRef(1);
  const keyboardGetter: KeyboardCoordinateGetter = (event, context) => {
    keyboardDirection.current = event.code === "ArrowDown" ? 1 : -1;
    return keyboardCoordinates(event, context);
  };
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardGetter,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );
  const move = drag?.move;
  const visible = useMemo(() => (move ? moveInQueues(queues, move) : queues), [queues, move]);
  const dragging = !!drag;
  const rows = useMemo<QueueRow[]>(() => {
    const drafts = visible.active.filter((thread) => !thread.source);
    return [
      ...drafts.map((thread) => ({
        id: thread.id,
        section: "active" as const,
        kind: "thread" as const,
        thread,
      })),
      ...(drafts.length
        ? [{ id: "draft-divider", section: "active" as const, kind: "draft-divider" as const }]
        : []),
      ...sidebarSections.flatMap((section) => [
        ...(dragging || section === "settled"
          ? [{ id: `heading:${section}`, section, kind: "heading" as const }]
          : []),
        ...(section !== "settled" || settledOpen
          ? visible[section]
              .filter((thread) => !!thread.source)
              .map((thread) => ({
                id: thread.id,
                section,
                kind: "thread" as const,
                thread,
              }))
          : []),
        ...(dragging && (section !== "settled" || settledOpen)
          ? [{ id: `end:${section}`, section, kind: "end" as const }]
          : []),
      ]),
    ];
  }, [visible, settledOpen, dragging]);
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  function over(event: DragOverEvent) {
    const current = dragRef.current;
    if (!current || !event.over || event.over.id === current.id) return;
    const target = rowsById.get(String(event.over.id));
    if (!target || target.kind === "draft-divider") return;
    let move: ThreadMove = { threadId: current.id, section: target.section };
    if (target.kind === "heading") move = { ...move, atStart: true };
    if (target.kind === "end")
      move = {
        ...move,
        afterId: visible[target.section]
          .filter((thread) => thread.source && thread.id !== current.id)
          .at(-1)?.id,
      };
    if (target.kind === "thread") {
      if (!target.thread.source) return;
      const below =
        event.activatorEvent instanceof KeyboardEvent
          ? keyboardDirection.current > 0
          : (event.active.rect.current.translated?.top ?? 0) +
              (event.active.rect.current.translated?.height ?? 0) / 2 >=
            event.over.rect.top + event.over.rect.height / 2;
      move = below ? { ...move, afterId: target.id } : { ...move, beforeId: target.id };
    }
    if (
      current.move?.section === move.section &&
      current.move.beforeId === move.beforeId &&
      current.move.afterId === move.afterId &&
      current.move.atStart === move.atStart
    )
      return;
    const next = { ...current, move };
    dragRef.current = next;
    setDrag(next);
  }
  const action = drag?.move ? dropAction(drag.from, drag.move.section) : undefined;
  const ActionIcon = { Pin, Unpin: PinOff, Settle: Check, Unsettle: Undo2 }[action ?? "Pin"];
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={({ active }) => {
        setDropDuration(readMotionDuration());
        const id = String(active.id),
          from = queueSection(queues, id);
        if (!from) return;
        const thread = queues[from].find((item) => item.id === id);
        if (!thread) return;
        const next = { id, from, thread };
        dragRef.current = next;
        setDrag(next);
      }}
      onDragOver={over}
      onDragMove={over}
      onDragCancel={() => {
        dragRef.current = undefined;
        setDrag(undefined);
      }}
      onDragEnd={({ over }) => {
        const move = dragRef.current?.move;
        dragRef.current = undefined;
        setDrag(undefined);
        if (over && move) onMove(move);
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press Space to move a conversation, use the arrow keys to choose a position or section, and press Space to drop. Press Escape to cancel.",
        },
      }}
    >
      <VirtualList
        items={rows}
        emptyState={dragging ? null : emptyState}
        animateChanges={!dragging}
        itemKey={(row) => row.id}
        estimate={40}
        fillBeforeIndex={rows.findIndex((row) => row.id === "heading:settled")}
        label="Conversations"
        className={`thread-list flex-1 thread-queue ${drag ? "is-dragging" : ""}`}
        // A keyboard drag moves with the arrow keys, so rows stop taking them while one runs.
        roving={{ primary: ".thread-card-select", selected: "[aria-current]", enabled: !drag }}
        scrollFade
        hasMore={hasMore}
        loading={loading}
        onEndReached={onEndReached}
        render={(row) => {
          if (row.kind === "draft-divider")
            return (
              <div
                className="queue-draft-divider h-px m-3 bg-border"
                role="separator"
                aria-label="Drafts"
              />
            );
          if (row.kind !== "thread")
            return (
              <QueueTarget
                row={row}
                highlighted={drag?.move?.section === row.section}
                count={totals[row.section]}
                open={settledOpen}
                toggle={() => onSettledOpen(!settledOpen)}
                dragging={!!drag}
              />
            );
          if (!row.thread.source)
            return (
              <div className="queue-draft pb-2">
                <QueueCard thread={row.thread} section={row.section} renderThread={renderThread} />
              </div>
            );
          return (
            <QueueItem id={row.id} disabled={disabled} title={row.thread.source.title}>
              <QueueCard thread={row.thread} section={row.section} renderThread={renderThread} />
            </QueueItem>
          );
        }}
      />
      {createPortal(
        <DragOverlay dropAnimation={{ duration: dropDuration, easing: "ease" }}>
          {drag ? (
            <div className="thread-drag-preview relative bg-surface-raised shadow-overlay rounded-md cursor-grabbing">
              <ThreadCard
                pinned={(drag.move?.section ?? drag.from) === "pinned"}
                settled={(drag.move?.section ?? drag.from) === "settled"}
                title={drag.thread.source?.title ?? "Untitled"}
                starterName={drag.thread.source?.starterDisplayName ?? ""}
                starterAvatarUrl={drag.thread.source?.starterAvatarUrl}
                updatedAt={drag.thread.source?.updatedAt ?? 0}
                workingSince={drag.thread.source?.workingSince}
                state={drag.thread.source ? threadDisplayState(drag.thread.source) : "idle"}
                onSelect={() => {}}
              />
              {action ? (
                <span className="thread-drop-action absolute right-2 top-1 flex items-center gap-1 text-primary [border:1px_solid_currentColor] bg-surface-raised rounded-sm py-[2px] px-[6px] text-xs">
                  <ActionIcon />
                  {action}
                </span>
              ) : null}
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
const QueueCard = memo(function QueueCard({
  thread,
  section,
  renderThread,
}: {
  thread: QueueThread;
  section: SidebarSection;
  renderThread: (thread: QueueThread, section: SidebarSection) => ReactNode;
}) {
  return renderThread(thread, section);
});

function QueueItem({
  id,
  title,
  disabled,
  children,
}: {
  id: string;
  title: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const draggable = useDraggable({ id, disabled });
  const droppable = useDroppable({ id, disabled });
  const setDragNode = draggable.setNodeRef;
  const setDropNode = droppable.setNodeRef;
  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDragNode(node);
      setDropNode(node);
    },
    [setDragNode, setDropNode],
  );
  return (
    <div
      ref={setNodeRef}
      className={`queue-thread rounded-md outline-none ${draggable.isDragging ? "drag-source" : ""}`}
      {...draggable.attributes}
      {...draggable.listeners}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) draggable.listeners?.onKeyDown?.(event);
      }}
      role="group"
      aria-label={`Move ${title || "Untitled"}`}
      onMouseDownCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-ui=thread-card-actions]")
        )
          event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}
function QueueTarget({
  row,
  highlighted,
  count,
  open,
  toggle,
  dragging,
}: {
  row: Exclude<QueueRow, { kind: "thread" }>;
  highlighted: boolean;
  count: number;
  open: boolean;
  toggle: () => void;
  dragging: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: row.id });
  if (row.kind === "end")
    return <div ref={setNodeRef} className="queue-section-end h-[12px]"></div>;
  return (
    <div
      ref={setNodeRef}
      className={`queue-heading py-2 px-1 text-muted-foreground ${highlighted ? "drop-highlight text-primary [border-color:var(--ui-primary)]" : ""}`}
    >
      <Button
        variant="ghost"
        disabled={row.section !== "settled"}
        onClick={toggle}
        aria-expanded={row.section === "settled" ? open : undefined}
      >
        {sidebarLabels[row.section]}
        {row.section === "settled" ? ` (${count})` : null}
        <span />
        {row.section === "settled" ? (
          <ChevronDown className={open ? "queue-expanded" : ""} />
        ) : null}
      </Button>
      {row.section === "settled" && !open && dragging ? (
        <div className="queue-drop-zone m-1 p-3 [border:1px_dashed_var(--ui-border)] rounded-md text-center text-muted-foreground text-sm">
          Settle
        </div>
      ) : null}
    </div>
  );
}
