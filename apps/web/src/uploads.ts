import type { NativeClient, NativeRPC } from "@stanley2058/lilac-client";
import type { AppProps, Attachment, LocalAttachment, UploadReference } from "./types";
import { attempt } from "./components/ui";
import { isConnectionFailure } from "./connection-lifecycle";
import { UPLOAD_ALREADY_ACTIVE_ERROR, UPLOAD_INTERRUPTED_ERROR } from "./http";

const empty: readonly LocalAttachment[] = [];

function isTransferConnectionFailure(error: string, recovering: boolean): boolean {
  return (
    isConnectionFailure(error) ||
    error === UPLOAD_INTERRUPTED_ERROR ||
    (recovering && error === UPLOAD_ALREADY_ACTIVE_ERROR)
  );
}

export class UploadPool {
  private readonly threads = new Map<string, readonly LocalAttachment[]>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly lifetime = new AbortController();
  private readonly transfers = new Map<
    string,
    { controller: AbortController; commandId: string; draftKey: string }
  >();
  private readonly readyListeners = new Set<
    (threadId: string, attachment: LocalAttachment, draftKey: string) => void
  >();
  private readonly released = new Set<string>();
  private readonly retryOnReconnect = new Set<string>();
  private readonly published = new Set<string>();
  private onlineGeneration = 0;
  private stopConnection?: () => void;
  markPublished(ids: readonly string[]) {
    for (const id of ids) this.published.add(id);
  }
  isPublished(id: string | undefined): boolean {
    return id !== undefined && this.published.has(id);
  }
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }
  constructor(
    private readonly client: {
      readonly rpc: { resources: Pick<NativeRPC["resources"], "reserve"> } | undefined;
      readonly subscribe?: NativeClient["subscribe"];
      readonly checkConnection?: NativeClient["checkConnection"];
    },
    private readonly upload: AppProps["upload"],
  ) {}
  start(): () => void {
    if (this.signal.aborted || !this.client.subscribe) return () => {};
    this.stopConnection?.();
    const unsubscribe = this.client.subscribe((event) => {
      if (event.kind !== "connection" || event.state !== "online") return;
      this.onlineGeneration++;
      this.retryConnectionFailures();
    });
    const stop = () => {
      if (this.stopConnection === stop) this.stopConnection = undefined;
      unsubscribe();
    };
    this.stopConnection = stop;
    return stop;
  }
  private queueReconnectRetry(key: string, attemptGeneration: number): boolean {
    if (this.onlineGeneration > attemptGeneration) return true;
    this.retryOnReconnect.add(key);
    void this.client.checkConnection?.();
    return false;
  }
  private retryConnectionFailures() {
    if (this.signal.aborted || !this.retryOnReconnect.size) return;
    const targets: Array<{ threadId: string; key: string }> = [];
    for (const [threadId, entries] of this.threads) {
      for (const item of entries) {
        if (item.state === "failed" && this.retryOnReconnect.has(item.key))
          targets.push({ threadId, key: item.key });
      }
    }
    for (const target of targets) this.retry(target.threadId, target.key, true);
  }
  private failDisconnectedReservation(threadId: string, key: string) {
    if (this.released.has(key)) {
      this.remove(threadId, key);
      return;
    }
    this.retryOnReconnect.add(key);
    this.update(threadId, key, {
      state: "failed",
      error: "Connect to upload this file",
    });
  }
  private async settleFailedReservation(
    threadId: string,
    key: string,
    retryNow: boolean,
  ): Promise<string | undefined> {
    if (this.released.has(key)) {
      this.remove(threadId, key);
      return undefined;
    }
    if (!retryNow) return undefined;
    this.retry(threadId, key, true);
    const next = this.get(threadId).find((item) => item.key === key)?.reservation;
    return next ? await next : undefined;
  }
  get(threadId: string): readonly LocalAttachment[] {
    return this.threads.get(threadId) ?? empty;
  }
  subscribe(threadId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
  subscribeReady(
    listener: (threadId: string, attachment: LocalAttachment, draftKey: string) => void,
  ): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }
  private update(threadId: string, key: string, change: Partial<LocalAttachment>) {
    if (this.signal.aborted || !this.get(threadId).some((item) => item.key === key)) return;
    this.threads.set(
      threadId,
      this.get(threadId).map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
    for (const listener of this.listeners.get(threadId) ?? []) listener();
  }
  add(
    threadId: string,
    file: File,
    historyGeneration?: number,
    key: string = crypto.randomUUID(),
    draftKey = threadId,
  ): string {
    if (this.signal.aborted) return key;
    this.retryOnReconnect.delete(key);
    // Undo keeps the chip key, while each replacement upload needs a fresh reservation.
    this.transfers.set(key, {
      controller: new AbortController(),
      commandId: crypto.randomUUID(),
      draftKey,
    });
    const pending = Promise.withResolvers<string | undefined>();
    const attachment: LocalAttachment = {
      key,
      file,
      reservation: pending.promise,
      progress: 0,
      state: "reserving",
      ...(historyGeneration === undefined
        ? {}
        : {
            staging: { threadId, historyGeneration, expiresAt: Date.now() + 24 * 60 * 60_000 },
          }),
      ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
    };
    this.threads.set(threadId, [...this.get(threadId), attachment]);
    for (const listener of this.listeners.get(threadId) ?? []) listener();
    void this.reserve(threadId, attachment, pending.resolve);
    return key;
  }
  keepFile(
    threadId: string,
    key: string,
    file: File,
    reference?: UploadReference,
  ): LocalAttachment {
    const attachment: LocalAttachment = {
      key,
      file,
      resourceId: reference?.resourceId,
      staging: reference?.staging,
      reservation: Promise.resolve(reference?.resourceId),
      progress: reference ? 1 : 0,
      state: reference ? "ready" : "failed",
      ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
    };
    this.threads.set(threadId, [...this.get(threadId), attachment]);
    for (const listener of this.listeners.get(threadId) ?? []) listener();
    return attachment;
  }
  private async reserve(
    threadId: string,
    attachment: LocalAttachment,
    resolve: (id: string | undefined) => void,
  ) {
    const signal = this.attachmentSignal(attachment.key);
    const rpc = this.client.rpc;
    const transfer = this.transfers.get(attachment.key);
    if (signal.aborted || !transfer) {
      resolve(undefined);
      return;
    }
    if (!rpc) {
      this.failDisconnectedReservation(threadId, attachment.key);
      resolve(undefined);
      return;
    }
    const attemptGeneration = this.onlineGeneration;
    let retryNow = false;
    const resource = await attempt(
      () =>
        rpc.resources.reserve(
          {
            threadId,
            commandId: transfer.commandId,
            name: attachment.file.name,
            size: attachment.file.size,
            mediaType: attachment.file.type || "application/octet-stream",
          },
          { signal },
        ),
      (error) => {
        if (signal.aborted) return;
        this.update(threadId, attachment.key, { state: "failed", error });
        if (!this.released.has(attachment.key) && isConnectionFailure(error))
          retryNow = this.queueReconnectRetry(attachment.key, attemptGeneration);
      },
    );
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    if (!resource) {
      resolve(await this.settleFailedReservation(threadId, attachment.key, retryNow));
      return;
    }
    resolve(resource.id);
    this.retryOnReconnect.delete(attachment.key);
    this.update(threadId, attachment.key, { resourceId: resource.id, state: "uploading" });
    await this.transfer(threadId, attachment.key, resource.id, attachment.file);
  }
  private async transfer(
    threadId: string,
    key: string,
    resourceId: string,
    file: File,
    recovering = false,
  ) {
    const signal = this.attachmentSignal(key);
    if (signal.aborted) return;
    const attemptGeneration = this.onlineGeneration;
    let retryNow = false;
    const outcome = await attempt(
      async () => {
        await this.upload(
          resourceId,
          file,
          (progress) => {
            if (!signal.aborted) this.update(threadId, key, { progress });
          },
          signal,
        );
        return true;
      },
      (error) => {
        if (signal.aborted) return;
        this.update(threadId, key, { state: "failed", error });
        if (!this.released.has(key) && isTransferConnectionFailure(error, recovering))
          retryNow = this.queueReconnectRetry(key, attemptGeneration);
      },
    );
    if (outcome && !signal.aborted) {
      this.retryOnReconnect.delete(key);
      this.update(threadId, key, { state: "ready", progress: 1, error: undefined });
      const ready = this.get(threadId).find((item) => item.key === key);
      const target = this.transfers.get(key);
      if (ready && target)
        for (const listener of this.readyListeners) listener(threadId, ready, target.draftKey);
    }
    if (signal.aborted) return;
    if (this.released.has(key)) {
      this.remove(threadId, key);
      return;
    }
    if (!outcome && retryNow) this.retry(threadId, key, true);
  }
  retry(threadId: string, key: string, recovering = false) {
    const item = this.get(threadId).find((entry) => entry.key === key);
    if (!item || item.state !== "failed" || this.signal.aborted) return;
    const recovery = recovering || this.retryOnReconnect.has(key);
    this.retryOnReconnect.delete(key);
    this.update(threadId, key, {
      state: item.resourceId ? "uploading" : "reserving",
      error: undefined,
    });
    if (item.resourceId) {
      void this.transfer(threadId, key, item.resourceId, item.file, recovery);
      return;
    }
    const pending = Promise.withResolvers<string | undefined>();
    this.update(threadId, key, { reservation: pending.promise });
    void this.reserve(threadId, item, pending.resolve);
  }
  private attachmentSignal(key: string): AbortSignal {
    const controller = this.transfers.get(key)?.controller;
    return controller ? AbortSignal.any([this.signal, controller.signal]) : AbortSignal.abort();
  }
  release(threadId: string, key: string) {
    this.retryOnReconnect.delete(key);
    const item = this.get(threadId).find((entry) => entry.key === key);
    if (!item) return;
    if (item.state === "ready" || item.state === "failed") {
      this.remove(threadId, key);
      return;
    }
    this.released.add(key);
  }
  remove(threadId: string, key: string) {
    const entries = this.get(threadId);
    const item = entries.find((entry) => entry.key === key);
    this.transfers.get(key)?.controller.abort();
    this.transfers.delete(key);
    this.released.delete(key);
    this.retryOnReconnect.delete(key);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    const remaining = entries.filter((entry) => entry.key !== key);
    if (remaining.length) this.threads.set(threadId, remaining);
    else this.threads.delete(threadId);
    for (const listener of this.listeners.get(threadId) ?? []) listener();
  }
  dispose() {
    this.stopConnection?.();
    this.lifetime.abort();
    this.transfers.clear();
    this.released.clear();
    this.retryOnReconnect.clear();
    this.published.clear();
    for (const entries of this.threads.values())
      for (const item of entries) if (item.preview) URL.revokeObjectURL(item.preview);
    this.threads.clear();
    this.listeners.clear();
    this.readyListeners.clear();
  }
}

export async function resolveAttachmentIds(
  pool: Pick<UploadPool, "get" | "retry">,
  threadId: string,
  attachments: readonly Attachment[],
  retryFailed: boolean,
): Promise<(string | undefined)[]> {
  if (retryFailed) {
    for (const attachment of attachments) {
      const current = pool.get(threadId).find((item) => item.key === attachment.key);
      if (current?.state === "failed") pool.retry(threadId, current.key);
    }
  }
  return Promise.all(
    attachments.map(
      (attachment) =>
        (pool.get(threadId).find((current) => current.key === attachment.key) ?? attachment)
          .reservation,
    ),
  );
}
