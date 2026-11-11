import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";
import { nativeFailure } from "./errors";
import type { NativeStore, NativeStoreResult } from "./store";

export function subscribeNativeDeferredSends(options: {
  bus: LilacBus;
  subscriptionPrefix: string;
  store: NativeStore;
  flush: () => NativeStoreResult<void>;
}) {
  return options.bus.subscribeTopic(
    "evt.request",
    {
      mode: "fanout",
      startFrom: "beginning",
      subscriptionId: `${options.subscriptionPrefix}:native-deferred-sends`,
      consumerId: `${options.subscriptionPrefix}:native-deferred-sends:${process.pid}`,
    },
    async (message) =>
      Result.gen(function* () {
        if (message.type !== lilacEventTypes.EvtRequestLifecycleChanged)
          return Result.ok(undefined);
        const state = message.data.state;
        if (state !== "resolved" && state !== "failed" && state !== "cancelled")
          return Result.ok(undefined);
        const requestId = message.headers?.request_id;
        if (requestId) yield* options.store.settleSurfaceSends(requestId, true);
        yield* options.flush();
        return Result.ok(undefined);
      }),
    () => "retry",
  );
}

export function reconcileNativeDeferredSends(
  store: NativeStore,
  deliveryState: (
    id: string,
  ) => ResultType<"missing" | "owned" | "completed" | "failed" | "cancelled" | "abandoned", Error>,
): NativeStoreResult<void> {
  return Result.gen(function* () {
    const groups = yield* store.listUnsettledSurfaceSends();
    for (const group of groups) {
      const state = yield* deliveryState(group.deliveryId).mapError(() =>
        nativeFailure("sqlite", "Deferred send origin could not be read"),
      );
      if (state === "owned" || state === "missing") continue;
      yield* store.settleSurfaceSends(group.requestId);
    }
    return Result.ok(undefined);
  });
}
