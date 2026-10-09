import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  type PersistedDataError,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  decodeThreadSearchResponse,
  type ThreadSearchOperation,
  type ThreadSearchRequest,
  type ThreadSearchResponse,
} from "./thread-search-protocol";
import type { ConversationThreadSearchHit } from "./thread-store";

export class ThreadSearchWorkerFailed extends TaggedError("ThreadSearchWorkerFailed")<{
  message: string;
}> {}
export interface ThreadSearchTransport {
  postMessage(request: ThreadSearchRequest): void;
  terminate(): void;
  onMessage(listener: (event: MessageEvent<unknown>) => void): void;
  onError(listener: (error: Error) => void): void;
}
function createTransport(): ThreadSearchTransport {
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
      worker.onerror = (event) =>
        listener(
          new Panic({
            message: event.message || "Thread search worker failed",
            cause: event.error,
          }),
        );
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
export class ConversationThreadSearchPool {
  private readonly slots: Array<{
    transport: ThreadSearchTransport;
    pending: Map<
      string,
      { resolve: (response: ThreadSearchResponse) => void; reject: (error: Error) => void }
    >;
  }>;
  private failure: Error | undefined;
  constructor(
    private readonly paths: Omit<ThreadSearchRequest, "id" | "operation">,
    create: () => ThreadSearchTransport = createTransport,
  ) {
    this.slots = [];
    const created = Result.try({
      try: () => {
        for (let i = 0; i < 3; i++) this.slots.push({ transport: create(), pending: new Map() });
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
      slot.transport.onError((error) => this.stop(error));
      slot.transport.onMessage((event) => {
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
        const pending = slot.pending.get(response.id);
        if (!pending) {
          this.stop(new ThreadSearchWorkerFailed({ message: "Unknown thread search response" }));
          return;
        }
        slot.pending.delete(response.id);
        if (response.type === "failed") {
          pending.reject(new ThreadSearchWorkerFailed({ message: response.message }));
          return;
        }
        pending.resolve(response);
      });
    }
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
      slot.transport.terminate();
    }
  }
  private async request(operation: ThreadSearchOperation): Promise<ThreadSearchResponse> {
    if (this.failure) return adaptToolResultToHost(Result.err(this.failure));
    const slot = this.slots.reduce((left, right) =>
      left.pending.size <= right.pending.size ? left : right,
    );
    const id = crypto.randomUUID();
    const result = new Promise<ThreadSearchResponse>((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
    });
    const sent = Result.try({
      try: () => slot.transport.postMessage({ ...this.paths, id, operation }),
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
