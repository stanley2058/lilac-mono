import { expect, test } from "bun:test";
import type { ClientEvent } from "@stanley2058/lilac-client";
import { currentGeneration, watchImageRetries } from "../src/image-retry";

function fakeClient(state: "connecting" | "online" | "offline") {
  const listeners = new Set<(event: ClientEvent) => void>();
  return {
    connectionState: state,
    subscribe(listener: (event: ClientEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(state: "connecting" | "online" | "offline") {
      for (const listener of listeners) listener({ kind: "connection", state });
    },
  };
}

test("image failures reset only when the connection comes back", () => {
  const client = fakeClient("online");
  const stop = watchImageRetries(client);
  const start = currentGeneration();
  client.emit("online");
  expect(currentGeneration()).toBe(start);
  client.emit("offline");
  client.emit("connecting");
  expect(currentGeneration()).toBe(start);
  client.emit("online");
  expect(currentGeneration()).toBe(start + 1);
  client.emit("online");
  expect(currentGeneration()).toBe(start + 1);
  stop();
  client.emit("offline");
  client.emit("online");
  expect(currentGeneration()).toBe(start + 1);
});
