import { Panic, Result, type Result as ResultType } from "better-result";
import {
  classifyBunSqliteError,
  type PersistedDataError,
} from "@stanley2058/lilac-utils/persistence";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import { ConversationThreadStore, type ConversationThreadSearchHit } from "./thread-store";
import {
  decodeThreadSearchRequest,
  type ThreadSearchRequest,
  type ThreadSearchResponse,
} from "./thread-search-protocol";
import {
  DEFAULT_SEARCH_WORKER_MAX_ISOLATE_BYTES,
  startWorkerMemoryWatchdog,
} from "./worker-memory-watchdog";

let store: ConversationThreadStore | undefined;
type StoreOpenOutcome =
  | { readonly ok: true; readonly store: ConversationThreadStore }
  | { readonly ok: false; readonly sqliteCode: string }
  | { readonly ok: false; readonly panic: Panic };

function openStore(
  request: ThreadSearchRequest,
):
  | { readonly ok: true; readonly store: ConversationThreadStore }
  | { readonly ok: false; readonly response: ThreadSearchResponse } {
  if (store) return { ok: true, store };
  const opened = Result.try({
    try: () =>
      new ConversationThreadStore(request.searchDbPath, {
        surfaceDbPath: request.surfaceDbPath,
        nativeDbPath: request.nativeDbPath,
        mainAgentUserNames: request.botName ? [request.botName] : undefined,
      }),
    catch: (cause) => {
      if (cause instanceof Error) {
        const sqliteError = classifyBunSqliteError(cause);
        if (sqliteError) return { sqliteCode: sqliteError.code } as const;
      }
      const panic = Panic.is(cause)
        ? cause
        : new Panic({ message: "Thread search worker defect", cause });
      return { panic } as const;
    },
  }).match<StoreOpenOutcome>({
    ok: (openedStore) => ({ ok: true, store: openedStore }),
    err: (failure) => ({ ok: false, ...failure }),
  });
  if (!opened.ok && "panic" in opened) return adaptToolResultToHost(Result.err(opened.panic));
  if (!opened.ok) {
    return {
      ok: false,
      response: {
        id: request.id,
        type: "failed",
        message: `Thread search store open failed (${opened.sqliteCode})`,
      },
    };
  }
  store = opened.store;
  return { ok: true, store };
}
function hitsResponse(
  id: string,
  result: ResultType<ConversationThreadSearchHit[], PersistedDataError>,
): ThreadSearchResponse {
  return result.match<ThreadSearchResponse>({
    ok: (hits) => ({ id, type: "hits" as const, hits }),
    err: (error) => ({
      id,
      type: "persisted-error" as const,
      error: {
        _tag: error._tag,
        table: error.table,
        field: error.field,
        version: error.version,
        recordId: error.recordId,
        issueCode: error.issueCode,
        message: error.message,
      },
    }),
  });
}
async function execute(request: ThreadSearchRequest): Promise<ThreadSearchResponse> {
  const opened = openStore(request);
  if (!opened.ok) return opened.response;
  const activeStore = opened.store;
  const op = request.operation;
  switch (op.type) {
    case "prepare":
      return { id: request.id, type: "strings", strings: activeStore.prepareSearch(op) };
    case "corpus":
      return {
        id: request.id,
        type: "strings",
        strings: activeStore.listAutoInjectRankingDocuments(op.allowlist),
      };
    case "current":
      return { id: request.id, type: "hits", hits: activeStore.filterCurrentSearchHits(op) };
    case "semantic":
      return hitsResponse(request.id, activeStore.searchSemantic(op));
    case "lexical":
      return hitsResponse(request.id, activeStore.search(op));
    case "any-term":
      return hitsResponse(request.id, activeStore.searchAnyTerm(op));
  }
}
async function run(request: ThreadSearchRequest): Promise<void> {
  const [result] = await Promise.allSettled([execute(request)]);
  if (result.status === "fulfilled") {
    postMessage(result.value);
    return;
  }
  if (Panic.is(result.reason)) return adaptToolResultToHost(Result.err(result.reason));
  return adaptToolResultToHost(
    Result.err(new Panic({ message: "Thread search worker defect", cause: result.reason })),
  );
}
startWorkerMemoryWatchdog({
  workerName: "thread-search-worker",
  maxIsolateBytes: DEFAULT_SEARCH_WORKER_MAX_ISOLATE_BYTES,
  emit: (event) => postMessage(event),
  onExceeded: () => {
    store?.close();
    store = undefined;
  },
});

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = adaptToolResultToHost(decodeThreadSearchRequest(event));
  queue = queue.then(() => run(request));
});
