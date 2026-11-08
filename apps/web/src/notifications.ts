import { Result } from "better-result";
import type { NativeClient, CacheScope } from "@stanley2058/lilac-client";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { createStore } from "zustand/vanilla";

export type NotificationPreferences = {
  enabled: boolean;
  background: boolean;
  completion: boolean;
  failure: boolean;
};
export const defaultNotifications: NotificationPreferences = {
  enabled: false,
  background: false,
  completion: true,
  failure: true,
};
export function notificationScope(scope: Pick<CacheScope, "installationId" | "principalId">) {
  return `lilac-notifications-v1:${JSON.stringify([scope.installationId, scope.principalId])}`;
}
export function createNotificationPreferences(
  scope: Pick<CacheScope, "installationId" | "principalId">,
) {
  const key = notificationScope(scope);
  const read = (): NotificationPreferences =>
    Result.try({
      try: () => localStorage.getItem(key),
      catch: () => "Storage unavailable",
    }).match({
      ok: (value) =>
        /^[01]{3,4}$/.test(value ?? "")
          ? {
              enabled: value?.[0] === "1",
              background: value?.[3] === "1",
              completion: value?.[1] === "1",
              failure: value?.[2] === "1",
            }
          : defaultNotifications,
      err: () => defaultNotifications,
    });
  const store = createStore<NotificationPreferences>(() => read());
  return {
    store,
    sync: () => store.setState(read()),
    update(value: Partial<NotificationPreferences>) {
      store.setState(value);
      const state = store.getState();
      Result.try({
        try: () =>
          localStorage.setItem(
            key,
            [state.enabled, state.completion, state.failure, state.background].map(Number).join(""),
          ),
        catch: () => "Storage unavailable",
      }).match({ ok: () => {}, err: () => {} });
    },
  };
}
export type NotificationPermissionState = NotificationPermission | "unsupported";
export function notificationPermission(): NotificationPermissionState {
  if (!window.isSecureContext || !("Notification" in window) || !navigator.locks)
    return "unsupported";
  return Notification.permission;
}
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (notificationPermission() === "unsupported") return "unsupported";
  return Result.tryPromise({
    try: () => Notification.requestPermission(),
    catch: () => "default" as const,
  }).then((result) => result.match({ ok: (value) => value, err: (value) => value }));
}

function needsInput(thread: NativeThread) {
  return thread.displayStatus === "input" || thread.waitingOn === "input";
}

export function notificationTransition(previous: NativeThread | undefined, current: NativeThread) {
  if (
    !previous ||
    !current.capabilities.read ||
    current.archived ||
    current.revision <= previous.revision
  )
    return;
  if (previous.displayStatus !== "working") return;
  if (needsInput(current)) return needsInput(previous) ? undefined : "input";
  if (current.displayStatus === "completed") return "completion";
  if (current.displayStatus === "error") return "failure";
}

type NotificationKind = NonNullable<ReturnType<typeof notificationTransition>>;

/** A question uses the response toggle so it needs no new stored preference. */
function notificationEnabled(prefs: NotificationPreferences, kind: NotificationKind) {
  return kind === "failure" ? prefs.failure : prefs.completion;
}

const notificationFallbackBody: Record<NotificationKind, string> = {
  completion: "Response finished",
  failure: "Run failed",
  input: "Needs your input",
};

export function holdNotificationLock(name: string): () => void {
  const controller = new AbortController();
  let release: (() => void) | undefined;
  void Result.tryPromise({
    try: () =>
      navigator.locks.request(
        name,
        { mode: "shared", signal: controller.signal },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    catch: () => "Lock unavailable",
  });
  return () => {
    controller.abort();
    release?.();
  };
}

export function watchNotifications(options: {
  client: Pick<NativeClient, "subscribe" | "connectionState"> & Partial<Pick<NativeClient, "rpc">>;
  initial: NativeThread[];
  scope: Pick<CacheScope, "installationId" | "principalId">;
  preferences: ReturnType<typeof createNotificationPreferences>;
  openThread: (id: string) => void;
}) {
  const { client, preferences } = options;
  const scope = notificationScope(options.scope);
  const threads = new Map<string, NativeThread>();
  const workingThreads = new Map<string, NativeThread>();
  function trackWorkingThread(thread: NativeThread) {
    const working = workingThreads.get(thread.id);
    // Run cleanup can publish idle before the terminal output projection arrives.
    if (thread.displayStatus === "idle" && thread.capabilities.read && !thread.archived)
      return working;
    workingThreads.delete(thread.id);
    if (thread.displayStatus === "working" && thread.capabilities.read && !thread.archived)
      workingThreads.set(thread.id, thread);
    return working;
  }
  function resetThreads(items: NativeThread[]) {
    threads.clear();
    workingThreads.clear();
    for (const thread of items) {
      threads.set(thread.id, thread);
      trackWorkingThread(thread);
    }
  }
  resetThreads(options.initial);
  let epoch = 0;
  let leader = false;
  let disposed = false;
  let leadership: AbortController | undefined;
  let release: (() => void) | undefined;
  const shown = new Set<Notification>();
  function releaseLeadership() {
    leader = false;
    leadership?.abort();
    release?.();
    leadership = undefined;
    release = undefined;
  }
  function claimLeadership() {
    if (!navigator.locks || leadership || disposed) return;
    leadership = new AbortController();
    void Result.tryPromise({
      try: () =>
        navigator.locks.request(scope, { signal: leadership?.signal }, () => {
          leader = true;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }),
      catch: () => "Lock unavailable",
    });
  }
  if (client.connectionState === "online") claimLeadership();
  async function notify(thread: NativeThread, kind: NotificationKind) {
    const startedEpoch = epoch;
    const registration = await Result.tryPromise({
      try: async () => navigator.serviceWorker?.getRegistration(),
      catch: () => "Service worker unavailable",
    }).then((result) => result.match({ ok: (value) => value, err: () => undefined }));
    const captured = await Result.tryPromise({
      try: () => navigator.locks.query(),
      catch: () => "Lock unavailable",
    });
    const locks = captured.match({ ok: (value) => value, err: () => undefined });
    const prefs = preferences.store.getState();
    if (
      !locks ||
      disposed ||
      !leader ||
      !prefs.enabled ||
      prefs.background ||
      !notificationEnabled(prefs, kind) ||
      notificationPermission() !== "granted"
    )
      return;
    if (locks.held?.some((lock) => lock.name === `${scope}:view:${thread.id}`)) return;
    const current = threads.get(thread.id);
    if (
      epoch !== startedEpoch ||
      !current?.capabilities.read ||
      current.archived ||
      current.displayStatus !== thread.displayStatus ||
      current.waitingOn !== thread.waitingOn
    )
      return;
    const content = await Result.tryPromise({
      try: async () => client.rpc?.notifications.read({ threadId: thread.id }),
      catch: () => "Notification unavailable",
    }).then((result) => result.match({ ok: (value) => value, err: () => undefined }));
    const latestPreferences = preferences.store.getState();
    if (
      disposed ||
      epoch !== startedEpoch ||
      !latestPreferences.enabled ||
      latestPreferences.background ||
      !notificationEnabled(latestPreferences, kind) ||
      (client.rpc && !content)
    )
      return;
    const latest = threads.get(thread.id);
    if (
      !latest?.capabilities.read ||
      latest.archived ||
      latest.displayStatus !== thread.displayStatus ||
      latest.waitingOn !== thread.waitingOn
    )
      return;
    const tag = content?.tag ?? `lilac:${thread.id}:${thread.revision}`;
    const title = content?.title ?? `Lilac · ${current.title || "Untitled thread"}`;
    const body = content?.body ?? notificationFallbackBody[kind];
    if (registration?.active) {
      await Result.tryPromise({
        try: () =>
          registration.showNotification(title, {
            body,
            tag,
            data: { threadId: thread.id },
          }),
        catch: () => "Notification unavailable",
      });
      return;
    }
    Result.try({
      try: () => {
        const notification = new Notification(title, {
          body,
          tag,
        });
        shown.add(notification);
        notification.onclose = () => shown.delete(notification);
        notification.onclick = () => {
          window.focus();
          options.openThread(thread.id);
          notification.close();
        };
      },
      catch: () => "Notification unavailable",
    }).match({ ok: () => {}, err: () => {} });
  }
  const sync = () => preferences.sync();
  window.addEventListener("storage", sync);
  const unsubscribe = client.subscribe((event) => {
    if (event.kind === "connection") {
      if (event.state === "online") {
        claimLeadership();
        return;
      }
      epoch += 1;
      threads.clear();
      workingThreads.clear();
      releaseLeadership();
      return;
    }
    if (event.kind === "bootstrap") {
      epoch += 1;
      resetThreads(event.bootstrap.threads.items);
      return;
    }
    if (event.kind === "removed") {
      threads.delete(event.threadId);
      workingThreads.delete(event.threadId);
      return;
    }
    if (event.kind !== "thread") return;
    const previous = threads.get(event.thread.id);
    if (previous && event.thread.revision <= previous.revision) return;
    threads.set(event.thread.id, event.thread);
    const kind = notificationTransition(trackWorkingThread(event.thread), event.thread);
    if (!kind || !leader || client.connectionState !== "online") return;
    const prefs = preferences.store.getState();
    if (
      prefs.enabled &&
      !prefs.background &&
      notificationEnabled(prefs, kind) &&
      notificationPermission() === "granted"
    )
      return notify(event.thread, kind);
  });
  return () => {
    disposed = true;
    unsubscribe();
    window.removeEventListener("storage", sync);
    releaseLeadership();
    for (const notification of shown) notification.close();
  };
}

export async function sendTestNotification(threadId?: string) {
  const permission = await requestNotificationPermission();
  if (permission === "unsupported")
    return Result.err("Notifications are unavailable in this browser.");
  if (permission !== "granted")
    return Result.err("Allow notifications in your browser's site settings.");
  return Result.tryPromise({
    try: async () => {
      const title = "Lilac · Notification test";
      const options: NotificationOptions = {
        body: "Your response is ready. This is a preview of the completed response.",
        tag: "lilac-notification-test",
        data: threadId ? { threadId } : { designSystem: true },
      };
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration?.active) {
        await registration.showNotification(title, options);
        return;
      }
      const notification = new Notification(title, options);
      notification.onclick = () => {
        window.focus();
        window.location.assign(
          threadId ? `/threads/${encodeURIComponent(threadId)}` : "/design-system#notifications",
        );
        notification.close();
      };
    },
    catch: () => "Could not show the test notification.",
  });
}
