import { createLogger } from "@stanley2058/lilac-utils/logging";
import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  type PersistedDataError,
} from "@stanley2058/lilac-utils/persistence";
import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils/tagged-error-log";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  decodeThreadSearchResponse,
  type ThreadSearchOperation,
  type ThreadSearchRequest,
  type ThreadSearchResponse,
} from "./thread-search-protocol";
import type { ConversationThreadSearchHit } from "./thread-store";
import {
  createWorkerMemoryTracker,
  DEFAULT_SEARCH_WORKER_MAX_ISOLATE_BYTES,
  type WorkerMemoryDiagnostics,
  type WorkerMemoryTracker,
} from "./worker-memory-watchdog";

const logger = createLogger({ module: "conversation-thread-search-pool" });

export class ThreadSearchWorkerFailed extends TaggedError("ThreadSearchWorkerFailed")<{
  message: string;
}> {}
export interface ThreadSearchTransport {
  postMessage(request: ThreadSearchRequest): void;
  terminate(): void;
  onMessage(listener: (event: MessageEvent<unknown>) => void): void;
  onError(listener: (error: Error) => void): void;
}
export function createThreadSearchTransport(): ThreadSearchTransport {
  const worker = new Worker(new URL("./thread-search-worker.ts", import.meta.url), {
    type: "module",
  });
  return {
    postMessage: (request) => worker.postMessage(request),
    terminate: () => worker.terminate(),
    onMessage: (listener) => {
      worker.onmessage = (event: MessageEvent<unknown>) => listener(event);
    },
    onError: (listener) => {
      worker.onerror = (event) => {
        if (Panic.is(event.error)) {
          listener(event.error);
          return;
        }
        if (event.error instanceof Error) {
          listener(event.error);
          return;
        }
        listener(
          new Panic({
            message: event.message || "Thread search worker failed",
            cause: event.error,
          }),
        );
      };
    },
  };
}
function responseHits(
  response: ThreadSearchResponse,
): ResultType<ConversationThreadSearchHit[], PersistedDataError> {
  if (response.type === "hits") return Result.ok(response.hits);
  if (response.type !== "persisted-error")
    return adaptToolResultToHost(
      Result.err(new Panic({ message: "Unexpected thread search response" })),
    );
  const error = response.error;
  switch (error._tag) {
    case "UnsupportedVersion":
      return Result.err(new UnsupportedVersion(error));
    case "MalformedSerialization":
      return Result.err(new MalformedSerialization(error));
    case "CorruptPersistedFields":
      return Result.err(new CorruptPersistedFields(error));
  }
}
type SearchPoolSlot = {
  readonly index: number;
  transport: ThreadSearchTransport | null;
  starting: boolean;
  pending: Map<
    string,
    { resolve: (response: ThreadSearchResponse) => void; reject: (error: Error) => void }
  >;
  readonly memory: WorkerMemoryTracker;
};

export class ConversationThreadSearchPool {
  private readonly slots: SearchPoolSlot[];
  private readonly create: () => ThreadSearchTransport;
  private failure: Error | undefined;
  constructor(
    private readonly paths: Omit<ThreadSearchRequest, "id" | "operation">,
    create: () => ThreadSearchTransport = createThreadSearchTransport,
  ) {
    this.create = create;
    this.slots = [];
    const created = Result.try({
      try: () => {
        for (let i = 0; i < 3; i++) {
          this.slots.push({
            index: i,
            transport: create(),
            starting: false,
            pending: new Map(),
            memory: createWorkerMemoryTracker(DEFAULT_SEARCH_WORKER_MAX_ISOLATE_BYTES),
          });
        }
      },
      catch: (cause) =>
        Panic.is(cause)
          ? cause
          : new Panic({ message: "Thread search worker startup failed", cause }),
    });
    if (created.isErr()) {
      this.stop(created.error);
      adaptToolResultToHost(Result.err(created.error));
    }
    for (const slot of this.slots) {
      if (slot.transport) this.attachSlot(slot, slot.transport);
    }
  }
  private retireSlot(
    slot: SearchPoolSlot,
    failure: ThreadSearchWorkerFailed,
    terminalFailure: Error = failure,
  ): void {
    for (const pending of slot.pending.values()) pending.reject(failure);
    slot.pending.clear();
    slot.transport?.terminate();
    slot.transport = null;
    slot.starting = false;
    slot.memory.clearSample();

    const remainingHealthySlots = this.slots.filter(
      (candidate) => candidate.transport !== null,
    ).length;
    logger.error("thread search worker replacement failed", {
      slot: slot.index,
      remainingHealthySlots,
      ...formatTaggedErrorForLog(failure),
    });
    if (remainingHealthySlots === 0) this.stop(terminalFailure);
  }
  private attachSlot(slot: SearchPoolSlot, transport: ThreadSearchTransport): void {
    transport.onError((error) => {
      if (slot.transport !== transport) return;
      if (slot.starting && !Panic.is(error)) {
        const failure = new ThreadSearchWorkerFailed({
          message: `Thread search worker startup failed: ${error.message}`,
        });
        this.retireSlot(slot, failure, error);
        return;
      }
      this.stop(error);
    });
    transport.onMessage((event) => {
      if (slot.transport !== transport) return;
      const decoded = decodeThreadSearchResponse(event).match<
        { response: ThreadSearchResponse } | { error: Error }
      >({
        ok: (response) => ({ response }),
        err: (error) => ({ error }),
      });
      if ("error" in decoded) {
        this.stop(decoded.error);
        return;
      }
      const response = decoded.response;
      if (response.type === "worker-memory") {
        slot.memory.recordSample(response);
        return;
      }
      if (response.type === "worker-watchdog-exceeded") {
        slot.memory.recordSample(response);
        this.restartSlot(slot, response.reason);
        return;
      }
      const pending = slot.pending.get(response.id);
      if (!pending) {
        this.stop(new ThreadSearchWorkerFailed({ message: "Unknown thread search response" }));
        return;
      }
      slot.pending.delete(response.id);
      if (response.type === "failed") {
        const failure = new ThreadSearchWorkerFailed({ message: response.message });
        pending.reject(failure);
        if (slot.starting) this.retireSlot(slot, failure);
        return;
      }
      slot.starting = false;
      pending.resolve(response);
    });
  }
  private restartSlot(slot: SearchPoolSlot, reason: string): void {
    if (this.failure) return;
    const currentSnapshot = slot.memory.snapshot("running");
    logger.warn("thread search worker exceeded memory watchdog limit; restarting worker", {
      slot: slot.index,
      reason,
      memory: currentSnapshot.lastMemory,
      limitBytes: currentSnapshot.limitBytes,
    });
    const restartError = new ThreadSearchWorkerFailed({
      message: `Thread search worker restarted: ${reason}`,
    });
    for (const pending of slot.pending.values()) pending.reject(restartError);
    slot.pending.clear();
    slot.transport?.terminate();
    slot.transport = null;
    slot.starting = false;
    slot.memory.recordRestart(reason);

    const recreated = Result.try({
      try: () => this.create(),
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    if (recreated.isErr()) {
      const cause = recreated.error.restoreCause();
      if (Panic.is(cause)) {
        this.stop(cause);
        return;
      }
      const failure = new ThreadSearchWorkerFailed({
        message: cause instanceof Error ? cause.message : "Thread search worker restart failed",
      });
      const terminal = new Panic({ message: "Thread search worker restart failed", cause });
      this.retireSlot(slot, failure, terminal);
      return;
    }
    slot.transport = recreated.value;
    slot.starting = true;
    this.attachSlot(slot, slot.transport);
  }
  getMemoryDiagnostics(): readonly WorkerMemoryDiagnostics[] {
    return this.slots.map((slot) =>
      slot.memory.snapshot(this.failure || !slot.transport ? "stopped" : "running"),
    );
  }
  close(): void {
    this.stop(new ThreadSearchWorkerFailed({ message: "Thread search pool stopped" }));
  }
  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const slot of this.slots) {
      for (const pending of slot.pending.values()) pending.reject(error);
      slot.pending.clear();
      slot.transport?.terminate();
      slot.transport = null;
    }
  }
  private async request(operation: ThreadSearchOperation): Promise<ThreadSearchResponse> {
    if (this.failure) return adaptToolResultToHost(Result.err(this.failure));
    const available = this.slots.filter(
      (candidate): candidate is SearchPoolSlot & { transport: ThreadSearchTransport } =>
        candidate.transport !== null,
    );
    if (available.length === 0) {
      return adaptToolResultToHost(
        Result.err(new ThreadSearchWorkerFailed({ message: "No thread search workers available" })),
      );
    }
    const slot = available.reduce((left, right) =>
      left.pending.size <= right.pending.size ? left : right,
    );
    const transport = slot.transport;
    const id = crypto.randomUUID();
    const result = new Promise<ThreadSearchResponse>((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
    });
    const sent = Result.try({
      try: () => transport.postMessage({ ...this.paths, id, operation }),
      catch: (cause) =>
        Panic.is(cause) ? cause : new Panic({ message: "Thread search dispatch failed", cause }),
    });
    sent.match({ ok: () => undefined, err: (error) => this.stop(error) });
    return result;
  }
  async strings(
    operation: Extract<ThreadSearchOperation, { type: "prepare" | "corpus" }>,
  ): Promise<string[]> {
    const response = await this.request(operation);
    if (response.type === "strings") return response.strings;
    return adaptToolResultToHost(
      Result.err(new Panic({ message: "Unexpected thread search response" })),
    );
  }
  async hits(
    operation: Exclude<ThreadSearchOperation, { type: "prepare" | "corpus" }>,
  ): Promise<ResultType<ConversationThreadSearchHit[], PersistedDataError>> {
    return responseHits(await this.request(operation));
  }
}
