import { Result } from "better-result";
import { ORPCError } from "@orpc/client";
import type {
  BootstrapInput,
  BootstrapReply,
  CatalogEvent,
  NativeInput,
  NativeInputReceipt,
  NativeThread,
  ReplayCheckpoint,
  ThreadEvent,
  DisplayStreamTarget,
  NativeTransport,
} from "@stanley2058/lilac-client-protocol";
import {
  mergeCachePatches,
  type CachePatch,
  type CacheScope,
  type CacheCommitOutcome,
  type NativeCache,
  NoNativeCache,
} from "./cache.ts";
import { DisplayCatalogCache } from "./catalog.ts";
import { NativeThreadStore } from "./thread-store.ts";
import { createNativeRPC, reconnectDelay, type NativeRPC } from "./transport.ts";

export type ClientFailure = {
  kind: "auth" | "forbidden" | "conflict" | "network" | "rejected";
  message: string;
};
export type CommandOutcome =
  | { kind: "accepted"; receipt: NativeInputReceipt }
  | { kind: "uncertain"; commandId: string }
  | { kind: "rejected"; error: ClientFailure };
export type ClientEvent =
  | { kind: "connection"; state: "connecting" | "online" | "offline" | "logged-out" }
  | { kind: "bootstrap"; bootstrap: BootstrapReply }
  | { kind: "thread"; thread: NativeThread }
  | { kind: "removed"; threadId: string }
  | { kind: "input"; threadId: string; receipt: NativeInputReceipt }
  | { kind: "catalog" }
  | { kind: "checkpoint"; threadId: string; checkpoint: ReplayCheckpoint }
  | { kind: "error"; error: ClientFailure };
export type NativeClientOptions = {
  scope: CacheScope;
  openSocket: () => WebSocket;
  openHttp?: () => NativeRPC;
  transport?: NativeTransport;
  bootstrap: (input: BootstrapInput, signal: AbortSignal) => Promise<BootstrapReply>;
  prepareConnection?: (request: { fresh: boolean }) => Promise<void>;
  cache?: NativeCache;
  catalogs?: DisplayCatalogCache;
  onEvent?: (event: ClientEvent) => void;
};

function captureFailure(error: unknown): ClientFailure {
  if (error instanceof ORPCError) {
    switch (error.code) {
      case "UNAUTHENTICATED":
      case "UNAUTHORIZED":
        return { kind: "auth", message: error.message };
      case "FORBIDDEN":
        return { kind: "forbidden", message: error.message };
      case "CONFLICT":
        return { kind: "conflict", message: error.message };
      case "INVALID_INPUT":
      case "NOT_FOUND":
        return { kind: "rejected", message: error.message };
      default:
        return { kind: "network", message: error.message };
    }
  }
  return { kind: "network", message: error instanceof Error ? error.message : "Connection failed" };
}

export function displayStreamKey(target: DisplayStreamTarget): string {
  return target.kind === "thread"
    ? target.threadId
    : `subagent:${target.threadId}:${target.agentId}`;
}

export const MAX_INACTIVE_THREAD_STORES = 8;

export class NativeClient {
  private readonly observedStreams = new Map<
    string,
    { target: DisplayStreamTarget; observers: number }
  >();
  private readonly streamTargets = new Map<string, DisplayStreamTarget>();
  private readonly streamFailures = new Map<string, string>();
  private readonly stores = new Map<string, NativeThreadStore>();
  private readonly cache: NativeCache;
  readonly catalogs: DisplayCatalogCache;
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private readonly streams = new Map<string, AbortController>();
  private readonly streamTasks = new Set<Promise<void>>();
  private readonly historyRequests = new Map<
    string,
    {
      threadId: string;
      controller: AbortController;
      done: Promise<void>;
      aroundPosition?: number;
    }
  >();
  private readonly pendingCachePatches = new Map<string, CachePatch>();
  private readonly cacheWrites = new Map<string, Promise<void>>();
  /** Threads re-cached after eviction whose next incremental commit has not landed yet. */
  private readonly recachingThreads = new Set<string>();
  private transport: NativeTransport;
  private httpFallback = false;
  private activeTransport: "websocket" | "http-sse" = "websocket";
  private socketOpened = false;
  private socket: WebSocket | undefined;
  private connection: NativeRPC | undefined;
  private lifetime = new AbortController();
  private stopped = false;
  private generation = 0;
  private readonly threadEpochs = new Map<string, number>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  private selectedThreadId: string | undefined;
  private catalogCursor: string | undefined;
  private readonly pending = new Map<string, NativeInput>();
  private readonly receipts = new Map<
    string,
    { input: NativeInput; receipt: NativeInputReceipt }
  >();
  private bootstrapSequence = 0;
  private bootstrapPending = true;
  private bootstrapRequest: AbortController | undefined;
  private connectionAttempt = 0;
  private connectionLifetime = new AbortController();
  private connectionDeadline: ReturnType<typeof setTimeout> | undefined;
  private credentialRetry = false;
  private state: Extract<ClientEvent, { kind: "connection" }>["state"] = "connecting";

  constructor(private readonly options: NativeClientOptions) {
    this.transport = options.transport ?? "auto";
    this.cache = options.cache ?? new NoNativeCache();
    this.catalogs = options.catalogs ?? new DisplayCatalogCache();
    if (options.onEvent) this.listeners.add(options.onEvent);
  }
  get rpc(): NativeRPC | undefined {
    return this.connection;
  }
  get currentTransport() {
    return this.activeTransport;
  }
  private desiredTransport(): "websocket" | "http-sse" {
    if (!this.options.openHttp) return "websocket";
    return this.transport === "http-sse" || (this.transport === "auto" && this.httpFallback)
      ? "http-sse"
      : "websocket";
  }
  private fallback(): boolean {
    if (this.transport !== "auto" || this.activeTransport !== "websocket" || !this.options.openHttp)
      return false;
    this.restartConnection(true);
    return true;
  }
  get connectionState() {
    return this.state;
  }
  subscribe(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: ClientEvent): void {
    if (event.kind === "connection") this.state = event.state;
    for (const listener of this.listeners) listener(event);
  }
  thread(threadId: string): NativeThreadStore {
    const existing = this.stores.get(threadId);
    if (existing) {
      this.stores.delete(threadId);
      this.stores.set(threadId, existing);
      return existing;
    }
    const store = new NativeThreadStore(() => this.trimStores());
    store.subscribe(({ patch }) => {
      if (!patch || this.stopped || this.stores.get(threadId) !== store) return;
      this.emit({ kind: "checkpoint", threadId, checkpoint: patch.checkpoint });
      this.pendingCachePatches.set(
        threadId,
        mergeCachePatches(this.pendingCachePatches.get(threadId), patch),
      );
      if (this.cacheWrites.has(threadId)) return;
      const write = Promise.resolve().then(async () => {
        while (this.pendingCachePatches.has(threadId)) {
          const pending = this.pendingCachePatches.get(threadId)!;
          this.pendingCachePatches.delete(threadId);
          const outcome = await this.persist(threadId, pending);
          this.afterCacheCommit(threadId, store, pending, outcome);
        }
        this.cacheWrites.delete(threadId);
      });
      this.cacheWrites.set(threadId, write);
    });
    this.stores.set(threadId, store);
    this.trimStores(threadId);
    return store;
  }
  stream(target: DisplayStreamTarget): NativeThreadStore {
    const key = displayStreamKey(target);
    this.streamTargets.set(key, target);
    return this.thread(key);
  }
  streamError(target: DisplayStreamTarget): string | undefined {
    return this.streamFailures.get(displayStreamKey(target));
  }
  observeStream(target: DisplayStreamTarget): () => void {
    const key = displayStreamKey(target);
    const existing = this.observedStreams.get(key);
    this.observedStreams.set(key, { target, observers: (existing?.observers ?? 0) + 1 });
    this.streamTargets.set(key, target);
    this.streamFailures.delete(key);
    void this.startObservedStream(target);
    return () => {
      const current = this.observedStreams.get(key);
      if (!current) return;
      if (current.observers > 1) {
        current.observers--;
        return;
      }
      this.observedStreams.delete(key);
      if (key !== this.selectedThreadId) this.stopStream(key);
      this.abortHistory(key);
      this.trimStores();
    };
  }
  private async startObservedStream(target: DisplayStreamTarget): Promise<void> {
    const key = displayStreamKey(target);
    if (!this.stream(target).checkpoint && !this.threadEpochs.has(target.threadId))
      await this.loadCached(key);
    if (!this.observedStreams.has(key) || this.stopped) return;
    this.watchTarget(target);
  }
  private trimStores(requestedThreadId?: string): void {
    const limit = this.cache instanceof NoNativeCache ? 0 : MAX_INACTIVE_THREAD_STORES;
    const inactive: string[] = [];
    for (const [threadId, store] of this.stores) {
      if (
        threadId === this.selectedThreadId ||
        this.streams.has(threadId) ||
        this.observedStreams.has(threadId) ||
        store.observerCount > 1
      )
        continue;
      inactive.push(threadId);
    }
    let excess = inactive.length - limit;
    for (const threadId of inactive) {
      if (excess <= 0) return;
      if (threadId === requestedThreadId) continue;
      this.stores.delete(threadId);
      this.streamTargets.delete(threadId);
      this.streamFailures.delete(threadId);
      excess--;
    }
  }
  private async persist(
    threadId: string,
    patch: Parameters<NativeCache["commit"]>[2],
  ): Promise<CacheCommitOutcome> {
    const captured = await Result.tryPromise({
      try: () => this.cache.commit(this.options.scope, threadId, patch),
      catch: captureFailure,
    });
    return captured.match({
      ok: (outcome) => outcome,
      err: (error) => this.emit({ kind: "error", error }),
    });
  }
  private afterCacheCommit(
    threadId: string,
    store: NativeThreadStore,
    patch: CachePatch,
    outcome: CacheCommitOutcome,
  ): void {
    if (outcome !== "missing") {
      if (!patch.replace) this.recachingThreads.delete(threadId);
      return;
    }
    // A re-cached thread missing again was evicted by its own replace, as when it alone exceeds the
    // cache budget. Stop rewriting it in full on every update for the rest of the session.
    if (this.recachingThreads.has(threadId)) return;
    this.recachingThreads.add(threadId);
    this.queueFullCheckpoint(threadId, store);
  }
  /** Replaces whatever is pending with the store's full state, which already includes those patches. */
  private queueFullCheckpoint(threadId: string, store: NativeThreadStore): void {
    const checkpoint = store.checkpoint;
    if (!checkpoint || this.stopped || this.stores.get(threadId) !== store) return;
    const put = store.slotIds
      .map((slotId) => store.getVersioned(slotId))
      .filter((slot) => slot !== undefined);
    this.pendingCachePatches.set(threadId, { checkpoint, replace: true, put, remove: [] });
  }
  async loadCached(threadId: string): Promise<void> {
    if (this.threadEpochs.has(threadId)) return;
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(threadId);
    await this.cacheWrites.get(threadId);
    const captured = await Result.tryPromise({
      try: () => this.cache.read(this.options.scope, threadId),
      catch: captureFailure,
    });
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(threadId) ||
      this.stopped
    )
      return;
    captured.match({
      ok: (value) => {
        if (value) this.thread(threadId).restore(value);
      },
      err: () => {},
    });
  }
  async start(selectedThreadId?: string): Promise<void> {
    this.selectedThreadId = selectedThreadId ?? this.selectedThreadId;
    this.bootstrapPending = true;
    this.stopped = false;
    this.lifetime = new AbortController();
    await this.connect();
  }
  reconnect(): void {
    this.restartConnection(false);
  }
  private restartConnection(httpFallback: boolean): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.bootstrapTimer);
    this.attempt = 0;
    this.connectionLifetime.abort();
    const streams = [...this.streamTasks];
    this.abortStreams();
    this.abortHistory();
    const socket = this.socket;
    this.socket = undefined;
    this.connection = undefined;
    if (socket?.readyState === WebSocket.CONNECTING) socket.close();
    // Stream cancellation sends an RPC abort before an established socket closes.
    void Promise.all(streams).then(() => socket?.close());
    this.bootstrapPending = true;
    void this.connect(httpFallback);
  }
  private async connect(httpFallback = false): Promise<void> {
    this.httpFallback = httpFallback;
    const attempt = ++this.connectionAttempt;
    clearTimeout(this.bootstrapTimer);
    this.connectionLifetime.abort();
    this.connectionLifetime = new AbortController();
    ++this.bootstrapSequence;
    this.bootstrapRequest?.abort();
    this.emit({ kind: "connection", state: "connecting" });
    this.armConnectionDeadline();
    const prepare = this.options.prepareConnection;
    if (prepare && !(await this.prepareConnection(prepare, attempt))) return;
    if (this.stopped || attempt !== this.connectionAttempt) return;
    this.open();
    if (this.selectedThreadId && !this.thread(this.selectedThreadId).checkpoint)
      await this.loadCached(this.selectedThreadId);
    if (this.stopped || attempt !== this.connectionAttempt) return;
    await this.bootstrap();
  }
  private async prepareConnection(
    operation: NonNullable<NativeClientOptions["prepareConnection"]>,
    attempt: number,
  ): Promise<boolean> {
    const fresh = this.credentialRetry;
    const prepared = await Result.tryPromise({
      try: () => operation({ fresh }),
      catch: captureFailure,
    });
    if (this.stopped || attempt !== this.connectionAttempt) return false;
    const error = prepared.match({ ok: () => undefined, err: (error) => error });
    if (error) {
      this.disconnected();
      return false;
    }
    return true;
  }
  private armConnectionDeadline(): void {
    const attempt = this.connectionAttempt;
    clearTimeout(this.connectionDeadline);
    this.connectionDeadline = setTimeout(() => {
      if (this.stopped || attempt !== this.connectionAttempt) return;
      if (this.socket && !this.socketOpened && this.fallback()) return;
      this.reconnect();
    }, 10_000);
  }
  private connected(): void {
    if (this.bootstrapPending || !this.connection) return;
    if (this.activeTransport === "websocket" && this.socket?.readyState !== WebSocket.OPEN) return;
    clearTimeout(this.connectionDeadline);
    this.attempt = 0;
    this.emit({ kind: "connection", state: "online" });
  }
  private open(): void {
    if (this.stopped) return;
    this.emit({ kind: "connection", state: "connecting" });
    this.activeTransport = this.desiredTransport();
    this.socketOpened = false;
    if (this.activeTransport === "http-sse" && this.options.openHttp) {
      this.connection = this.options.openHttp();
      return;
    }
    const opened = Result.try({ try: this.options.openSocket, catch: captureFailure });
    const socket = opened.match({ ok: (value) => value, err: () => undefined });
    if (!socket) {
      this.disconnected();
      return;
    }
    this.socket = socket;
    this.connection = createNativeRPC(socket);
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.socketOpened = true;
      this.connected();
    });
    if (socket.readyState === WebSocket.OPEN) {
      this.socketOpened = true;
      this.connected();
    }
    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.stopped) return;
      if (!this.socketOpened && this.fallback()) return;
      this.disconnected();
    });
  }
  private disconnected(): void {
    this.bootstrapPending = true;
    this.emit({ kind: "connection", state: "offline" });
    this.abortStreams();
    this.connection = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(
      () => {
        void this.connect();
      },
      reconnectDelay(this.attempt++),
    );
  }

  private async bootstrap(): Promise<void> {
    clearTimeout(this.bootstrapTimer);
    this.armConnectionDeadline();
    this.bootstrapTimer = undefined;
    this.bootstrapPending = true;
    this.bootstrapRequest?.abort();
    const request = new AbortController();
    this.bootstrapRequest = request;
    const sequence = ++this.bootstrapSequence;
    const generation = this.generation;
    const threadId = this.selectedThreadId;
    const threadEpoch = threadId ? this.threadEpochs.get(threadId) : undefined;
    const input: BootstrapInput = {
      threadId,
      checkpoint: threadId ? this.thread(threadId).checkpoint : undefined,
      catalogRevision: this.catalogs.get(this.options.scope)?.revision,
    };
    const captured = await Result.tryPromise({
      try: () =>
        this.options.bootstrap(input, AbortSignal.any([this.lifetime.signal, request.signal])),
      catch: captureFailure,
    });
    if (generation !== this.generation || this.stopped || sequence !== this.bootstrapSequence)
      return;
    const outcome = captured.match<{ reply: BootstrapReply } | { error: ClientFailure }>({
      ok: (reply) => ({ reply }),
      err: (error) => ({ error }),
    });
    if ("error" in outcome) {
      if (outcome.error.kind === "forbidden") {
        await this.logout();
        return;
      }
      await this.failure(outcome.error);
      return;
    }
    const reply = outcome.reply;
    this.credentialRetry = false;
    if (
      reply.installationId !== this.options.scope.installationId ||
      reply.viewer.id !== this.options.scope.principalId
    ) {
      await this.logout();
      return;
    }
    if (reply.transport && reply.transport !== this.transport) {
      this.transport = reply.transport;
      this.httpFallback = false;
    }
    if (this.options.openHttp && this.desiredTransport() !== this.activeTransport) {
      this.reconnect();
      return;
    }
    this.catalogCursor = reply.catalogCursor;
    if (reply.catalog.kind === "catalog")
      this.catalogs.put(this.options.scope, reply.catalog.catalog);
    if (threadId && reply.selectedThreadUnavailable) await this.revoke(threadId);
    if (threadId && reply.selectedThread && threadEpoch === this.threadEpochs.get(threadId))
      this.thread(threadId).replay(reply.selectedThread);
    this.bootstrapPending = false;
    if (
      this.activeTransport === "websocket" &&
      !this.socketOpened &&
      (!this.socket || this.socket.readyState >= WebSocket.CLOSING) &&
      this.fallback()
    )
      return;
    this.connected();
    this.emit({ kind: "bootstrap", bootstrap: reply });
    this.watchCatalog();
    if (
      this.selectedThreadId &&
      (!reply.selectedThreadUnavailable || this.selectedThreadId !== threadId)
    )
      this.watchThread(this.selectedThreadId);
    for (const observed of this.observedStreams.values())
      void this.startObservedStream(observed.target);
  }
  private retryBootstrap(): void {
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = setTimeout(
      () => {
        if (this.stopped) return;
        if (this.transport === "auto" && this.activeTransport === "http-sse") {
          this.reconnect();
          return;
        }
        void this.bootstrap();
      },
      reconnectDelay(this.attempt++),
    );
  }
  async selectThread(threadId?: string): Promise<void> {
    const previous = this.selectedThreadId;
    this.selectedThreadId = threadId;
    if (previous && previous !== threadId) {
      this.stopStream(previous);
      this.abortHistory(previous);
    }
    this.trimStores(threadId);
    if (!threadId) return;
    if (!this.thread(threadId).checkpoint) await this.loadCached(threadId);
    if (this.selectedThreadId !== threadId || this.stopped || this.bootstrapPending) return;
    this.watchThread(threadId);
  }
  private trackStream(task: Promise<void>): void {
    this.streamTasks.add(task);
    void task.then(() => {
      this.streamTasks.delete(task);
    });
  }
  private stopStream(key: string): void {
    this.streams.get(key)?.abort();
    this.streams.delete(key);
  }
  private abortStreams(): void {
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
  }
  private watchThread(threadId: string): void {
    this.watchTarget({ kind: "thread", threadId });
  }
  private watchTarget(target: DisplayStreamTarget): void {
    const threadId = displayStreamKey(target);
    const rpc = this.connection;
    if (!rpc || this.bootstrapPending || this.streams.has(threadId)) return;
    this.streamTargets.set(threadId, target);
    const controller = new AbortController();
    this.streams.set(threadId, controller);
    this.trackStream(this.consumeThread(rpc, threadId, controller, target));
  }
  private async consumeThread(
    rpc: NativeRPC,
    threadId: string,
    controller: AbortController,
    target: DisplayStreamTarget,
  ): Promise<void> {
    const captured = await Result.tryPromise({
      try: async () => {
        const iterator = await rpc.streams.watch(
          { target, checkpoint: this.thread(threadId).checkpoint },
          { signal: controller.signal },
        );
        for await (const event of iterator) {
          if (controller.signal.aborted) return;
          await this.threadEvent(threadId, event, target);
        }
      },
      catch: captureFailure,
    });
    if (controller.signal.aborted) return;
    if (this.streams.get(threadId) === controller) this.streams.delete(threadId);
    const error = captured.match({ ok: () => undefined, err: (failure) => failure });
    if (error?.kind === "forbidden" || error?.kind === "rejected") {
      this.streamFailures.set(threadId, error.message);
      await this.revoke(threadId);
      return;
    }
    if (error) {
      await this.failure(error);
      return;
    }
    if (!this.stopped) this.retryBootstrap();
  }
  private async threadEvent(
    threadId: string,
    event: ThreadEvent,
    target: DisplayStreamTarget,
  ): Promise<void> {
    const store = this.thread(threadId);
    switch (event.kind) {
      case "replay":
        store.replay(event.reply);
        break;
      case "update":
        store.update(event.update);
        break;
      case "hydration":
        store.hydrate(event.hydration);
        break;
      case "thread":
        this.emit(event);
        return;
      case "input": {
        const commandId = event.receipt.commandId;
        const input = commandId ? this.pending.get(commandId) : undefined;
        if (commandId && input?.threadId === threadId) {
          this.pending.delete(commandId);
          this.receipts.set(commandId, { input, receipt: event.receipt });
          if (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!);
        }
        this.emit({ ...event, threadId });
        return;
      }
      case "deleted":
      case "revoked":
        this.streamFailures.set(threadId, "Conversation is no longer available.");
        await this.revoke(threadId);
        return;
    }
    if (!store.resyncRequired || !this.connection) return;
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(threadId);
    const captured = await Result.tryPromise({
      try: () => this.connection!.streams.sync({ target }),
      catch: captureFailure,
    });
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(threadId) ||
      this.stopped
    )
      return;
    captured.match({
      ok: (reply) => {
        store.replay(reply);
      },
      err: (error) => this.emit({ kind: "error", error }),
    });
  }
  private watchCatalog(): void {
    if (!this.connection || !this.catalogCursor) return;
    this.stopStream("__catalog");
    const controller = new AbortController();
    this.streams.set("__catalog", controller);
    this.trackStream(this.consumeCatalog(this.connection, this.catalogCursor, controller));
  }
  private async consumeCatalog(
    rpc: NativeRPC,
    cursor: string,
    controller: AbortController,
  ): Promise<void> {
    const captured = await Result.tryPromise({
      try: async () => {
        const iterator = await rpc.bootstrap.watch({ cursor }, { signal: controller.signal });
        for await (const event of iterator) {
          if (controller.signal.aborted) return;
          await this.catalogEvent(event);
        }
      },
      catch: captureFailure,
    });
    if (controller.signal.aborted) return;
    const error = captured.match({ ok: () => undefined, err: (failure) => failure });
    if (error) {
      await this.failure(error);
      return;
    }
    if (!this.stopped) this.retryBootstrap();
  }
  private async catalogEvent(event: CatalogEvent): Promise<void> {
    this.catalogCursor = event.cursor;
    switch (event.kind) {
      case "thread":
        this.emit(event);
        return;
      case "removed":
        await this.revoke(event.threadId);
        return;
      case "resync":
        await this.bootstrap();
        return;
      case "catalog-invalidated": {
        const generation = this.generation;
        const rpc = this.connection;
        if (!rpc) return;
        const captured = await Result.tryPromise({
          try: () =>
            rpc.catalogs.get({ revision: this.catalogs.get(this.options.scope)?.revision }),
          catch: captureFailure,
        });
        if (generation !== this.generation || this.stopped) return;
        captured.match({
          ok: (reply) => {
            if (reply.kind === "catalog") this.catalogs.put(this.options.scope, reply.catalog);
            this.emit({ kind: "catalog" });
          },
          err: (error) => this.emit({ kind: "error", error }),
        });
        return;
      }
    }
  }
  private abortHistory(threadId?: string): void {
    for (const [key, request] of this.historyRequests) {
      if (threadId !== undefined && request.threadId !== threadId) continue;
      request.controller.abort();
      this.historyRequests.delete(key);
    }
  }
  async hydrate(
    threadId: string,
    slotId: string,
    options?: { aroundPosition?: number },
  ): Promise<void> {
    return this.hydrateStream({ kind: "thread", threadId }, slotId, options);
  }
  async hydrateStream(
    target: DisplayStreamTarget,
    slotId: string,
    options?: { aroundPosition?: number },
  ): Promise<void> {
    const threadId = displayStreamKey(target);
    const key = JSON.stringify([threadId, slotId]);
    // A caller waiting on this range shares the request already loading it, unless it targets a
    // different turn; that jump replaces the pending one so it costs a single round trip.
    const pending = this.historyRequests.get(key);
    if (pending && (options?.aroundPosition ?? pending.aroundPosition) === pending.aroundPosition)
      return pending.done;
    const rpc = this.connection;
    const store = this.thread(threadId);
    const checkpoint = store.checkpoint;
    const slot = store.getVersioned(slotId);
    if (!rpc || !checkpoint || !slot || slot.slot.kind === "ready") return;
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(threadId);
    pending?.controller.abort();
    const controller = new AbortController();
    const done = (async () => {
      const captured = await Result.tryPromise({
        try: () =>
          rpc.streams.hydrate(
            {
              target,
              slotId,
              historyGeneration: checkpoint.historyGeneration,
              projectionRevision: checkpoint.projectionRevision,
              ...(options?.aroundPosition === undefined
                ? {}
                : { aroundPosition: options.aroundPosition }),
            },
            { signal: controller.signal },
          ),
        catch: captureFailure,
      });
      if (this.historyRequests.get(key)?.controller === controller)
        this.historyRequests.delete(key);
      if (
        generation !== this.generation ||
        threadEpoch !== this.threadEpochs.get(threadId) ||
        this.stopped ||
        controller.signal.aborted
      )
        return;
      captured.match({
        ok: (hydration) => {
          store.hydrate(hydration);
        },
        err: (error) => store.failHydration(slotId, error.message),
      });
    })();
    this.historyRequests.set(key, {
      threadId,
      controller,
      done,
      ...(options?.aroundPosition === undefined ? {} : { aroundPosition: options.aroundPosition }),
    });
    return done;
  }
  async loadTurnPage(threadId: string, slotId: string): Promise<void> {
    return this.loadStreamTurnPage({ kind: "thread", threadId }, slotId);
  }
  async loadStreamTurnPage(target: DisplayStreamTarget, slotId: string): Promise<void> {
    const threadId = displayStreamKey(target);
    const rpc = this.connection;
    const store = this.thread(threadId);
    const checkpoint = store.checkpoint;
    const stored = store.getVersioned(slotId);
    if (!rpc || !checkpoint || !stored || stored.slot.kind !== "ready" || !stored.slot.partsCursor)
      return;
    const cursor = stored.slot.partsCursor;
    const turnId = stored.slot.turnId;
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(threadId);
    const captured = await Result.tryPromise({
      try: () =>
        rpc.streams.turnPage({
          target,
          turnId,
          cursor,
          historyGeneration: checkpoint.historyGeneration,
          projectionRevision: checkpoint.projectionRevision,
        }),
      catch: captureFailure,
    });
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(threadId) ||
      this.stopped
    )
      return;
    captured.match({
      ok: (page) => {
        store.turnPage(slotId, cursor, page);
      },
      err: (error) => this.emit({ kind: "error", error }),
    });
  }
  // A network path that drops silently leaves the socket open with no close event. An unchanged
  // catalog read is the cheapest round trip that proves the socket still delivers replies.
  async checkConnection(): Promise<void> {
    const rpc = this.connection;
    if (!rpc || this.stopped || this.state !== "online") return;
    const captured = await Result.tryPromise({
      try: () =>
        rpc.catalogs.get(
          { revision: this.catalogs.get(this.options.scope)?.revision },
          {
            signal: AbortSignal.any([this.connectionLifetime.signal, AbortSignal.timeout(10_000)]),
          },
        ),
      catch: captureFailure,
    });
    if (rpc !== this.connection || this.stopped) return;
    const failed = captured.match({ ok: () => false, err: (error) => error.kind === "network" });
    if (failed) this.reconnect();
  }
  async reauthenticate(token: string): Promise<boolean> {
    const rpc = this.connection;
    if (!rpc) return false;
    const captured = await Result.tryPromise({
      try: () =>
        rpc.connection.reauthenticate(
          { token },
          {
            signal: AbortSignal.any([this.connectionLifetime.signal, AbortSignal.timeout(10_000)]),
          },
        ),
      catch: captureFailure,
    });
    if (rpc !== this.connection || this.stopped) return false;
    const outcome = captured.match<{ accepted: boolean } | { error: ClientFailure }>({
      ok: (viewer) => ({ accepted: viewer.id === this.options.scope.principalId }),
      err: (error) => ({ error }),
    });
    if ("error" in outcome) {
      if (outcome.error.kind === "network") {
        this.reconnect();
        return false;
      }
      await this.failure(outcome.error);
      return false;
    }
    if (!outcome.accepted) {
      await this.logout();
      return false;
    }
    if (this.activeTransport === "http-sse") this.renewHttpSubscriptions();
    return true;
  }
  private renewHttpSubscriptions(): void {
    // Each SSE request retains its opening credential. Renew streams without another online event,
    // because authentication listeners use that event to request their own refresh.
    const watched = [...this.streams.keys()];
    this.abortStreams();
    for (const key of watched) {
      if (key === "__catalog") {
        this.watchCatalog();
        continue;
      }
      const target = this.streamTargets.get(key);
      if (target) this.watchTarget(target);
    }
  }
  async submit(input: NativeInput): Promise<CommandOutcome> {
    const known = this.receipts.get(input.commandId);
    const existing = this.pending.get(input.commandId) ?? known?.input;
    if (existing && JSON.stringify(existing) !== JSON.stringify(input))
      return {
        kind: "rejected",
        error: { kind: "conflict", message: "A command ID cannot be reused for different input" },
      };
    if (known) return { kind: "accepted", receipt: known.receipt };
    if (this.pending.size >= 256 && !existing)
      return {
        kind: "rejected",
        error: { kind: "rejected", message: "Resolve pending sends before sending more messages" },
      };
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(input.threadId);
    this.pending.set(input.commandId, structuredClone(input));
    const rpc = this.connection;
    if (!rpc) return { kind: "uncertain", commandId: input.commandId };
    // A dead socket reports its close only after the browser gives up, so a replaced connection
    // settles the send as uncertain.
    const signal = this.connectionLifetime.signal;
    const captured = await Result.tryPromise({
      try: () => rpc.inputs.submit(input, { signal }),
      catch: captureFailure,
    });
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(input.threadId) ||
      this.stopped
    )
      return { kind: "uncertain", commandId: input.commandId };
    const outcome = captured.match<{ receipt: NativeInputReceipt } | { error: ClientFailure }>({
      ok: (value) => ({ receipt: value }),
      err: (error) => ({ error }),
    });
    if ("receipt" in outcome) {
      this.pending.delete(input.commandId);
      this.receipts.set(input.commandId, {
        input: structuredClone(input),
        receipt: outcome.receipt,
      });
      if (this.receipts.size > 256) {
        const oldest = this.receipts.keys().next().value;
        if (oldest) this.receipts.delete(oldest);
      }
      return { kind: "accepted", receipt: outcome.receipt };
    }
    if (outcome.error.kind === "network") return { kind: "uncertain", commandId: input.commandId };
    this.pending.delete(input.commandId);
    if (outcome.error.kind === "auth") await this.logout();
    return { kind: "rejected", error: outcome.error };
  }
  async retry(commandId: string): Promise<CommandOutcome> {
    const input = this.pending.get(commandId);
    if (input) return this.submit(input);
    const receipt = this.receipts.get(commandId);
    if (receipt) return { kind: "accepted", receipt: receipt.receipt };
    return { kind: "rejected", error: { kind: "rejected", message: "Unknown command" } };
  }
  private async failure(error: ClientFailure): Promise<void> {
    // A cached provider token can expire by the server's clock. Only a rejected fresh token ends the
    // session, because logout purges cached private data.
    if (error.kind === "auth" && !this.credentialRetry && !this.stopped) {
      this.credentialRetry = true;
      this.reconnect();
      return;
    }
    if (error.kind === "auth") {
      await this.logout();
      return;
    }
    if (error.kind === "network") {
      this.emit({ kind: "connection", state: "offline" });
      if (!this.stopped) this.retryBootstrap();
      return;
    }
    this.emit({ kind: "error", error });
  }
  async revoke(threadId: string): Promise<void> {
    const children = new Set(
      [...this.streamTargets]
        .filter(([key, target]) => key !== threadId && target.threadId === threadId)
        .map(([key]) => key),
    );
    for (const key of this.cacheWrites.keys())
      if (key.startsWith(`subagent:${threadId}:`)) children.add(key);
    for (const key of children) await this.revoke(key);
    this.observedStreams.delete(threadId);
    this.streamTargets.delete(threadId);
    this.threadEpochs.set(threadId, (this.threadEpochs.get(threadId) ?? 0) + 1);
    for (const [id, input] of this.pending) {
      if (input.threadId === threadId) this.pending.delete(id);
    }
    for (const [id, value] of this.receipts) {
      if (value.input.threadId === threadId) this.receipts.delete(id);
    }
    this.stopStream(threadId);
    this.abortHistory(threadId);
    this.stores.get(threadId)?.clear();
    this.stores.delete(threadId);
    await this.cacheWrites.get(threadId);
    const captured = await Result.tryPromise({
      try: () => this.cache.remove(this.options.scope, threadId),
      catch: captureFailure,
    });
    captured.match({ ok: () => {}, err: (error) => this.emit({ kind: "error", error }) });
    this.emit({ kind: "removed", threadId });
  }
  async logout(): Promise<void> {
    void this.dispose();
    for (const store of this.stores.values()) store.clear();
    this.stores.clear();
    this.observedStreams.clear();
    this.streamTargets.clear();
    this.streamFailures.clear();
    this.pending.clear();
    this.receipts.clear();
    this.catalogs.purge(this.options.scope);
    await Promise.all(this.cacheWrites.values());
    const captured = await Result.tryPromise({
      try: () => this.cache.purge(this.options.scope),
      catch: captureFailure,
    });
    captured.match({ ok: () => {}, err: (error) => this.emit({ kind: "error", error }) });
    this.emit({ kind: "connection", state: "logged-out" });
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.lifetime.abort();
    this.connectionLifetime.abort();
    clearTimeout(this.connectionDeadline);
    this.abortStreams();
    this.abortHistory();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.bootstrapTimer);
    this.connection = undefined;
    if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.close();
    await Promise.all(this.streamTasks);
    this.socket?.close();
  }
}
