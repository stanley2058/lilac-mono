import { Result } from "better-result";
import type { NativeClient } from "@stanley2058/lilac-client";
import { createStore } from "zustand/vanilla";
import {
  notificationPermission,
  requestNotificationPermission,
  type createNotificationPreferences,
  type NotificationPreferences,
} from "./notifications";

export function backgroundPushSupport() {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    return ios
      ? "Add Lilac to your Home Screen to enable background push."
      : "Background push is unavailable in this browser.";
  }
  return undefined;
}

function subscriptionKeys(subscription: PushSubscription) {
  const encode = (key: ArrayBuffer | null) =>
    key
      ? btoa(String.fromCharCode(...new Uint8Array(key)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "")
      : "";
  return {
    p256dh: encode(subscription.getKey("p256dh")),
    auth: encode(subscription.getKey("auth")),
  };
}

function capture<T>(operation: () => Promise<T>) {
  return Result.tryPromise({
    try: operation,
    catch: (error) =>
      error instanceof Error ? error.message : "Could not update background push.",
  });
}

function removeSubscription(
  rpc: NonNullable<NativeClient["rpc"]>,
  subscription: PushSubscription | null | undefined,
) {
  return Result.gen(async function* () {
    if (!subscription) return Result.ok(false);
    yield* Result.await(
      capture(() => rpc.notifications.unsubscribe({ endpoint: subscription.endpoint })),
    );
    yield* Result.await(capture(() => subscription.unsubscribe()));
    return Result.ok(false);
  });
}

function createSubscription(registration: ServiceWorkerRegistration, publicKey: string) {
  const key = Uint8Array.from(
    atob(publicKey.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  return capture(() =>
    registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
  );
}

export function createBackgroundPush(
  client: Pick<NativeClient, "rpc" | "subscribe">,
  preferences: ReturnType<typeof createNotificationPreferences>,
) {
  const store = createStore<{ busy: boolean; error?: string }>(() => ({ busy: false }));
  async function apply(changes: Partial<NotificationPreferences>, requestPermission = false) {
    if (store.getState().busy) return false;
    store.setState({ busy: true, error: undefined });
    // Permission must be requested before awaiting registration or network work on iOS.
    const permission = requestPermission
      ? await requestNotificationPermission()
      : notificationPermission();
    const next = { ...preferences.store.getState(), ...changes };
    const captured = await Result.gen(async function* () {
      const rpc = client.rpc;
      if (!rpc) return Result.err("Connect to Lilac to change background push.");
      const registration = yield* Result.await(
        capture(async () => navigator.serviceWorker?.getRegistration()),
      );
      let subscription = yield* Result.await(
        capture(async () => registration?.pushManager.getSubscription()),
      );
      if (!next.enabled || !next.background) return await removeSubscription(rpc, subscription);
      if (permission !== "granted")
        return Result.err("Allow notifications in your browser's site settings.");
      if (!registration?.active)
        return Result.err("Reload Lilac to finish setting up background push.");
      const { publicKey } = yield* Result.await(capture(() => rpc.notifications.key({})));
      if (!subscription)
        subscription = yield* Result.await(createSubscription(registration, publicKey));
      yield* Result.await(
        capture(() =>
          rpc.notifications.subscribe({
            endpoint: subscription!.endpoint,
            keys: subscriptionKeys(subscription!),
            completion: next.completion,
            failure: next.failure,
          }),
        ),
      );
      return Result.ok(true);
    });
    if (captured.isErr()) {
      store.setState({ busy: false, error: captured.error });
      return false;
    }
    preferences.update({ ...changes, background: captured.value });
    store.setState({ busy: false, error: undefined });
    return true;
  }
  async function sync() {
    if (backgroundPushSupport()) return;
    if (client.rpc) await apply({});
  }
  function start() {
    void sync();
    const unsubscribe = client.subscribe((event) => {
      if (event.kind === "connection" && event.state === "online") void sync();
    });
    return () => {
      unsubscribe();
    };
  }
  return { store, apply, start };
}
