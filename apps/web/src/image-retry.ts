import { useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { NativeClient } from "@stanley2058/lilac-client";

const reconnects = createStore(() => ({ generation: 0 }));

export function currentGeneration(): number {
  return reconnects.getState().generation;
}

/** Clears image failures each time the client reconnects, so failed images request again. */
export function watchImageRetries(
  client: Pick<NativeClient, "subscribe" | "connectionState">,
): () => void {
  let online = client.connectionState === "online";
  return client.subscribe((event) => {
    if (event.kind !== "connection") return;
    const reconnected = event.state === "online" && !online;
    online = event.state === "online";
    if (!reconnected) return;
    reconnects.setState((state) => ({ generation: state.generation + 1 }));
  });
}

/**
 * Remembers which image source failed until the next reconnect. A failed `<img>` never requests
 * again by itself, so the component must render it anew.
 */
export function useImageFailure<T>(): [failed: T | undefined, fail: (value: T) => void] {
  const [failure, setFailure] = useState<{ value: T; generation: number }>();
  // Images without a current failure select undefined, so a reconnect does not rerender them.
  const failed = useStore(reconnects, (state) =>
    failure?.generation === state.generation ? failure.value : undefined,
  );
  const fail = (value: T) => setFailure({ value, generation: currentGeneration() });
  return [failed, fail];
}
