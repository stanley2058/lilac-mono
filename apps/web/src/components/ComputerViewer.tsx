import { useCallback, useEffect, useRef, useState, type RefObject, type PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Monitor, MousePointer2, X, RotateCw, GripHorizontal } from "lucide-react";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import { queryNativeRPC, useNativeOnline } from "../queries";
import { useWorkspace } from "../workspace-context";
import {
  clampComputerPosition,
  computerFrameUrl,
  decodeComputerState,
  type ComputerGeometry,
} from "../computer-viewer";
import { Button } from "./ui/button";
import "./computer-viewer.css";

type Desktop = NonNullable<NativeRpcOutputs["computer"]["read"]["desktop"]>;

export function NativeComputerViewer({
  threadId,
  enabled,
}: {
  threadId: string;
  enabled: boolean;
}) {
  const { client, panels } = useWorkspace();
  const saveGeometry = useCallback(
    (geometry: ComputerGeometry) => {
      panels.getState().setComputerGeometry(threadId, geometry);
    },
    [panels, threadId],
  );
  const online = useNativeOnline(client);
  const query = useQuery({
    queryKey: ["computer", threadId],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) => rpc.computer.read({ threadId }, { signal })),
    enabled: enabled && online,
    refetchInterval: 2000,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const desktop = query.data?.desktop;
  if (
    !enabled ||
    !online ||
    query.isError ||
    !desktop ||
    Date.parse(desktop.expiresAt) <= Date.now()
  )
    return null;
  return (
    <ComputerViewer
      key={`${threadId}:${desktop.generation}`}
      desktop={desktop}
      savedGeometry={panels.getState().computerGeometry.get(threadId)}
      onGeometryChange={saveGeometry}
    />
  );
}

function initialGeometry(): ComputerGeometry {
  const tokens = getComputedStyle(document.documentElement);
  const width = Number.parseFloat(tokens.getPropertyValue("--ui-computer-width"));
  const height = Number.parseFloat(tokens.getPropertyValue("--ui-computer-height"));
  return {
    x: Math.max(8, window.innerWidth - width - 16),
    y: Math.max(8, window.innerHeight - height - 16),
    width,
    height,
  };
}

export function ComputerViewer({
  desktop,
  savedGeometry,
  onGeometryChange,
}: {
  desktop: Desktop;
  savedGeometry?: ComputerGeometry;
  onGeometryChange?: (geometry: ComputerGeometry) => void;
}) {
  const [initial] = useState(() => savedGeometry ?? initialGeometry());
  const geometry = useRef(initial);
  const [hidden, setHidden] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (hidden)
    return (
      <Button
        className="fixed bottom-4 right-4 z-40 shadow-lg"
        variant="secondary"
        onClick={() => setHidden(false)}
      >
        <Monitor /> Computer
      </Button>
    );
  return (
    <ComputerPanel
      key={attempt}
      desktop={desktop}
      geometry={geometry}
      onGeometryChange={onGeometryChange}
      onClose={() => setHidden(true)}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

function ComputerPanel({
  geometry,
  onGeometryChange,
  desktop,
  onClose,
  onRetry,
}: {
  desktop: Desktop;
  geometry: RefObject<ComputerGeometry>;
  onGeometryChange?: (geometry: ComputerGeometry) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [position, setPosition] = useState(() =>
    clampComputerPosition(
      geometry.current.x,
      geometry.current.y,
      Math.min(geometry.current.width, window.innerWidth - 16),
      Math.min(geometry.current.height, window.innerHeight - 16),
      window.innerWidth,
      window.innerHeight,
    ),
  );
  const [size] = useState(() => ({
    width: geometry.current.width,
    height: geometry.current.height,
  }));
  useEffect(() => {
    geometry.current = { ...geometry.current, ...position };
    onGeometryChange?.(geometry.current);
  }, [position, geometry, onGeometryChange]);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      geometry.current = { ...geometry.current, width: rect.width, height: rect.height };
      onGeometryChange?.(geometry.current);
      setPosition((value) => {
        const next = clampComputerPosition(
          value.x,
          value.y,
          rect.width,
          rect.height,
          window.innerWidth,
          window.innerHeight,
        );
        return next.x === value.x && next.y === value.y ? value : next;
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [geometry, onGeometryChange]);
  const [state, setState] = useState<"connecting" | "connected" | "disconnected" | "failed">(
    "connecting",
  );
  const [controlling, setControlling] = useState(false);
  const origin = new URL(desktop.url, window.location.origin).origin;
  const src = computerFrameUrl(desktop.url, window.location.origin);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const next = decodeComputerState(event.data);
      if (!next) return;
      if (next === "ready") {
        frame.current?.contentWindow?.postMessage(
          { type: "lilac-computer-connect", password: desktop.password },
          origin,
        );
        return;
      }
      setState(next);
      setControlling(false);
    };
    window.addEventListener("message", receive);
    const timeout = window.setTimeout(
      () => setState((value) => (value === "connecting" ? "failed" : value)),
      15000,
    );
    return () => {
      window.removeEventListener("message", receive);
      window.clearTimeout(timeout);
    };
  }, [origin, desktop.password]);

  useEffect(() => {
    const resize = () => {
      const rect = panel.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition((value) =>
        clampComputerPosition(
          value.x,
          value.y,
          rect.width,
          rect.height,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function toggleControl() {
    const enabled = !controlling;
    frame.current?.contentWindow?.postMessage({ type: "lilac-computer-input", enabled }, origin);
    setControlling(enabled);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current;
    const rect = panel.current?.getBoundingClientRect();
    if (!start || !rect) return;
    setPosition(
      clampComputerPosition(
        start.left + event.clientX - start.x,
        start.top + event.clientY - start.y,
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }
  const failed = state === "failed" || state === "disconnected";
  return (
    <div
      ref={panel}
      role="region"
      aria-label="Computer viewer"
      data-computer-viewer
      data-controlling={controlling}
      className="computer-viewer fixed z-40 flex flex-col overflow-hidden rounded-xl bg-background text-foreground shadow-xl ring-1 ring-border"
      style={{
        width: size.width,
        height: size.height,
        left: position.x,
        top: position.y,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: "calc(100dvh - 16px)",
      }}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        <button
          aria-label="Move computer viewer"
          className="flex min-w-0 flex-1 touch-none cursor-move items-center gap-2 text-sm"
          onPointerDown={(event) => {
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              left: position.x,
              top: position.y,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={move}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            const steps: Record<string, [number, number]> = {
              ArrowLeft: [-20, 0],
              ArrowRight: [20, 0],
              ArrowUp: [0, -20],
              ArrowDown: [0, 20],
            };
            const step = steps[event.key];
            const rect = panel.current?.getBoundingClientRect();
            if (!step || !rect) return;
            event.preventDefault();
            setPosition(
              clampComputerPosition(
                position.x + step[0],
                position.y + step[1],
                rect.width,
                rect.height,
                window.innerWidth,
                window.innerHeight,
              ),
            );
          }}
        >
          <GripHorizontal className="size-4 text-muted-foreground" />
          <span>Computer</span>
        </button>
        <Button
          size="sm"
          variant={controlling ? "secondary" : "ghost"}
          disabled={state !== "connected"}
          aria-pressed={controlling}
          onClick={toggleControl}
        >
          <MousePointer2 />
          {controlling ? "Stop controlling" : "Take control"}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Hide computer viewer" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-muted">
        <iframe
          ref={frame}
          src={src}
          title="Agent computer"
          className="h-full w-full border-0"
          tabIndex={controlling ? 0 : -1}
          inert={!controlling}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          onLoad={() =>
            frame.current?.contentWindow?.postMessage(
              { type: "lilac-computer-connect", password: desktop.password },
              origin,
            )
          }
          onError={() => setState("failed")}
        />
        {state !== "connected" ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
            role="status"
          >
            {failed ? "Computer disconnected" : "Connecting…"}
            {failed ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                <RotateCw /> Reconnect
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="shrink-0 px-2 py-1 text-xs text-muted-foreground">
        {controlling ? "You and the agent can both control this computer" : "View only"}
      </div>
    </div>
  );
}
