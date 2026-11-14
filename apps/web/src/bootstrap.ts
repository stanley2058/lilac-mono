import { threadIdFromUrl } from "./thread-location";
import { NativeClient, type CacheScope } from "@stanley2058/lilac-client";
import type { BootstrapInput, BootstrapReply } from "@stanley2058/lilac-client-protocol";
import { ORPCError } from "@orpc/client";
import { Result } from "better-result";
import { z } from "zod";
import { createWebNativeCache, type WebNativeCache } from "./cache";
import {
  logoutHttp,
  openNativeSocket,
  openNativeHttp,
  readBootstrap,
  nativeWebHttpFailure,
  WebRequestFailed,
} from "./http";
import { prepareWebConnection } from "./connection-credentials";

export type WebSession = {
  client: NativeClient;
  scope: CacheScope;
  initial: BootstrapReply;
  initialThreadId?: string;
};
export type WebState =
  | { kind: "starting" }
  | { kind: "ready"; session: WebSession }
  | { kind: "login"; message?: string; signingOut?: boolean; logoutFailed?: boolean }
  | { kind: "offline"; message: string };
export type WebSessionOptions = {
  cache?: WebNativeCache;
  openSocket?: () => WebSocket;
  openHttp?: typeof openNativeHttp;
  bootstrap?: typeof readBootstrap;
  socketBootstrap?: SocketBootstrap;
  logout?: () => Promise<Result<void, Error>>;
  currentUrl?: () => URL;
  channel?: BroadcastChannel | null;
};

type SocketBootstrap = (
  rpc: NonNullable<NativeClient["rpc"]>,
  input: BootstrapInput,
  signal: AbortSignal,
) => Promise<BootstrapReply>;

export const webCache = createWebNativeCache();

function socketOpened(socket: WebSocket, signal: AbortSignal): Promise<boolean> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve(true);
  if (socket.readyState !== WebSocket.CONNECTING || signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (opened: boolean) => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onClose);
      resolve(opened);
    };
    const onOpen = () => finish(true);
    const onClose = () => finish(false);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onClose, { once: true });
  });
}

function requestError(error: unknown): WebState {
  if (
    error instanceof ORPCError &&
    (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN")
  ) {
    return { kind: "login", message: error.message };
  }
  return {
    kind: "offline",
    message: "Could not connect to Lilac. Your drafts are saved on this device.",
  };
}

const sessionNoticeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ending"), id: z.string().min(1).max(128) }),
  z.strictObject({
    kind: z.literal("ended"),
    id: z.string().min(1).max(128).optional(),
    failed: z.boolean().optional(),
  }),
]);
function decodeSessionNotice(value: unknown): z.infer<typeof sessionNoticeSchema> | undefined {
  const parsed = sessionNoticeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function createSessionChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  return Result.try({
    try: () => new BroadcastChannel("lilac-session"),
    catch: () => undefined,
  }).match({ ok: (channel) => channel, err: () => undefined });
}

export class WebSessionController {
  private state: WebState = { kind: "starting" };
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private disposed = false;
  private readonly pendingSignouts = new Set<string>();
  private logoutFailed = false;
  private logoutTask: Promise<void> | undefined;
  private active: NativeClient | undefined;
  private activeScope: CacheScope | undefined;
  private stopEvents: (() => void) | undefined;
  private startup = new AbortController();
  private cleanup: Promise<void> = Promise.resolve();
  private readonly saves = new Set<Promise<void>>();
  private readonly cache: WebNativeCache;
  private readonly openSocket: () => WebSocket;
  private readonly openHttp: typeof openNativeHttp;
  private readonly fetchBootstrap: typeof readBootstrap;
  private readonly socketBootstrap: SocketBootstrap;
  private readonly endRemoteSession: () => Promise<Result<void, Error>>;
  private readonly currentUrl: () => URL;
  private readonly channel: BroadcastChannel | undefined;

  constructor(options: WebSessionOptions = {}) {
    this.cache = options.cache ?? webCache;
    this.openSocket = options.openSocket ?? openNativeSocket;
    this.openHttp = options.openHttp ?? openNativeHttp;
    this.fetchBootstrap = options.bootstrap ?? readBootstrap;
    this.socketBootstrap =
      options.socketBootstrap ?? ((rpc, input, signal) => rpc.bootstrap.get(input, { signal }));
    this.endRemoteSession = options.logout ?? logoutHttp;
    this.currentUrl = options.currentUrl ?? (() => new URL(location.href));
    this.channel =
      options.channel === undefined ? createSessionChannel() : (options.channel ?? undefined);
    this.channel?.addEventListener("message", this.receiveSessionEvent);
  }
  private readonly receiveSessionEvent = (event: MessageEvent<unknown>): void => {
    const notice = decodeSessionNotice(event.data);
    if (!notice) return;
    if (notice.kind === "ending") this.pendingSignouts.add(notice.id);
    if (notice.kind === "ended") {
      if (notice.id) this.pendingSignouts.delete(notice.id);
      this.logoutFailed = notice.failed ?? false;
    }
    void this.clearSession(false);
  };
  getSnapshot = (): WebState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(state: WebState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  async start(): Promise<void> {
    if (this.disposed || this.pendingSignouts.size || this.logoutFailed) return;
    const epoch = ++this.epoch;
    this.startup.abort();
    this.startup = new AbortController();
    const signal = this.startup.signal;
    this.stopEvents?.();
    this.stopEvents = undefined;
    const previous = this.active;
    this.active = undefined;
    await previous?.dispose();
    await this.cleanup;
    if (epoch !== this.epoch) return;
    const result = await Result.tryPromise({
      try: () => this.startSession(epoch, signal),
      catch: requestError,
    });
    if (epoch !== this.epoch) return;
    const failure = result.match({ ok: () => undefined, err: (state) => state });
    if (!failure) return;
    await this.settleStartFailure(failure);
  }
  private async settleStartFailure(failure: WebState): Promise<void> {
    this.stopEvents?.();
    this.stopEvents = undefined;
    const active = this.active;
    this.active = undefined;
    this.set(failure);
    await active?.dispose();
  }
  private async startSession(epoch: number, signal: AbortSignal): Promise<void> {
    const threadId = threadIdFromUrl(this.currentUrl());
    const cached = await this.cache.readLatestBootstrap();
    if (epoch !== this.epoch) return;
    if (cached) {
      const {
        selectedThread: _selected,
        selectedThreadUnavailable: _unavailable,
        ...initial
      } = cached.bootstrap;
      const session = this.create(cached.scope, initial, threadId, this.openSocket);
      this.set({ kind: "ready", session });
      await session.client.start(threadId);
      return;
    }
    const bootstrap = await this.fetchBootstrap({ threadId }, signal);
    if (epoch !== this.epoch) return;
    const scope: CacheScope = {
      installationId: bootstrap.installationId,
      principalId: bootstrap.viewer.id,
      protocolVersion: 1,
      projectionVersion: 1,
    };
    const session = this.create(scope, bootstrap, threadId, this.openSocket, bootstrap);
    this.set({ kind: "ready", session });
    await session.client.start(threadId);
  }
  private create(
    scope: CacheScope,
    initial: BootstrapReply,
    initialThreadId: string | undefined,
    openSocket: () => WebSocket,
    prefetched?: BootstrapReply,
  ): WebSession {
    let socket: WebSocket | undefined;
    let pending = prefetched;
    const client: NativeClient = new NativeClient({
      scope,
      transport: initial.transport,
      openHttp: this.openHttp,
      cache: this.cache,
      openSocket: () => {
        socket = openSocket();
        return socket;
      },
      bootstrap: async (input, signal) => {
        const reply = pending;
        pending = undefined;
        return reply ?? this.connectionBootstrap(client, socket, input, signal);
      },
      prepareConnection: prepareWebConnection,
      networkUnavailable: () => navigator.onLine === false,
    });
    if (initial.catalog.kind === "catalog") client.catalogs.put(scope, initial.catalog.catalog);
    if (initialThreadId && initial.selectedThread)
      client.thread(initialThreadId).replay(initial.selectedThread);
    this.active = client;
    this.activeScope = scope;
    this.stopEvents = client.subscribe((event) => {
      if (this.active !== client) return;
      if (event.kind === "connection" && event.state === "logged-out") {
        void this.clearSession(true);
        return;
      }
      if (event.kind !== "bootstrap") return;
      const catalog = client.catalogs.get(scope);
      const snapshot: BootstrapReply = catalog
        ? { ...event.bootstrap, catalog: { kind: "catalog", catalog } }
        : event.bootstrap;
      const save = this.saveSnapshot(this.epoch, client, scope, snapshot);
      this.saves.add(save);
      void save.then(() => {
        this.saves.delete(save);
      });
    });
    return { client, scope, initial, initialThreadId };
  }
  private async connectionBootstrap(
    client: NativeClient,
    socket: WebSocket | undefined,
    input: BootstrapInput,
    signal: AbortSignal,
  ): Promise<BootstrapReply> {
    const rpc = client.rpc;
    // A resumed page can reuse a pooled HTTP connection that died in the background, while each
    // socket opens a new connection.
    if (
      client.currentTransport === "websocket" &&
      socket &&
      rpc &&
      (await socketOpened(socket, signal))
    )
      return this.socketBootstrap(rpc, input, signal);
    if (signal.aborted)
      return nativeWebHttpFailure(
        new WebRequestFailed({ code: "canceled", message: "Request canceled" }),
      );
    // Browsers hide the status of a rejected upgrade, so HTTP reports whether the session ended.
    return this.fetchBootstrap(input, signal);
  }
  private async saveSnapshot(
    epoch: number,
    client: NativeClient,
    scope: CacheScope,
    snapshot: BootstrapReply,
  ): Promise<void> {
    if (epoch !== this.epoch || this.active !== client) return;
    const result = await Result.tryPromise({
      try: () => this.cache.saveBootstrap(scope, snapshot),
      catch: () => undefined,
    });
    result.match({ ok: () => {}, err: () => {} });
  }
  logout(providerOperation?: () => Promise<Result<void, Error>>): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    const task = this.performLogout(providerOperation);
    this.logoutTask = task;
    void task.then(() => {
      if (this.logoutTask === task) this.logoutTask = undefined;
    });
    return task;
  }
  private async performLogout(
    providerOperation?: () => Promise<Result<void, Error>>,
  ): Promise<void> {
    const id = crypto.randomUUID();
    this.pendingSignouts.add(id);
    this.broadcast({ kind: "ending", id });
    const remote = Result.tryPromise({
      try: () => this.endRemoteSession(),
      catch: () => new Error("Could not sign out of Lilac. Retry before leaving this device."),
    });
    const provider = Result.tryPromise({
      try: () => providerOperation?.() ?? Promise.resolve(Result.ok()),
      catch: () => new Error("Could not sign out of the authentication provider. Try again."),
    });
    await this.clearSession(false);
    const [result, providerResult] = await Promise.all([remote, provider]);
    const remoteMessage = result
      .andThen((value) => value)
      .match({
        ok: () => undefined,
        err: () => "Could not sign out of Lilac. Retry before leaving this device.",
      });
    const providerMessage = providerResult
      .andThen((value) => value)
      .match({ ok: () => undefined, err: (error) => error.message });
    const message = remoteMessage ?? providerMessage;
    this.logoutFailed = !!message;
    this.pendingSignouts.delete(id);
    this.broadcast({ kind: "ended", id, failed: this.logoutFailed });
    if (!this.disposed)
      this.set({
        kind: "login",
        signingOut: this.pendingSignouts.size > 0,
        logoutFailed: this.logoutFailed,
        message,
      });
  }
  private broadcast(notice: z.infer<typeof sessionNoticeSchema>): void {
    Result.try({ try: () => this.channel?.postMessage(notice), catch: () => undefined }).match({
      ok: () => {},
      err: () => {},
    });
  }
  private clearSession(broadcast: boolean): Promise<void> {
    ++this.epoch;
    this.startup.abort();
    const client = this.active;
    const scope = this.activeScope;
    this.active = undefined;
    this.activeScope = undefined;
    this.stopEvents?.();
    this.stopEvents = undefined;
    this.set({
      kind: "login",
      signingOut: this.pendingSignouts.size > 0,
      logoutFailed: this.logoutFailed,
      ...(this.logoutFailed
        ? { message: "Could not finish signing out. Retry before leaving this device." }
        : {}),
    });
    if (broadcast) this.broadcast({ kind: "ended" });
    const saves = [...this.saves];
    this.cleanup = this.cleanup.then(() => this.purgeSession(client, scope, saves));
    return this.cleanup;
  }
  private async purgeSession(
    client: NativeClient | undefined,
    scope: CacheScope | undefined,
    saves: Promise<void>[],
  ): Promise<void> {
    const result = await Result.tryPromise({
      try: async () => {
        await client?.logout();
        await Promise.all(saves);
        const identity = scope ?? (await this.cache.readLatestBootstrap())?.scope;
        if (identity) await this.cache.purge(identity);
      },
      catch: () => undefined,
    });
    result.match({ ok: () => {}, err: () => {} });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    ++this.epoch;
    this.startup.abort();
    this.stopEvents?.();
    this.stopEvents = undefined;
    const active = this.active;
    this.active = undefined;
    this.channel?.removeEventListener("message", this.receiveSessionEvent);
    await active?.dispose();
    await this.cleanup;
    await Promise.all(this.saves);
    await this.logoutTask;
    this.channel?.close();
  }
}
