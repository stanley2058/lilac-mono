import { Panic, Result, type Result as ResultType } from "better-result";
import type { PersistedDataError } from "@stanley2058/lilac-utils";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import { ConversationThreadStore, type ConversationThreadSearchHit } from "./thread-store";
import {
  decodeThreadSearchRequest,
  type ThreadSearchRequest,
  type ThreadSearchResponse,
} from "./thread-search-protocol";

let store: ConversationThreadStore | undefined;
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
  store ??= new ConversationThreadStore(request.searchDbPath, {
    surfaceDbPath: request.surfaceDbPath,
    nativeDbPath: request.nativeDbPath,
    mainAgentUserNames: request.botName ? [request.botName] : undefined,
  });
  const op = request.operation;
  switch (op.type) {
    case "prepare":
      return { id: request.id, type: "strings", strings: store.prepareSearch(op) };
    case "corpus":
      return {
        id: request.id,
        type: "strings",
        strings: store.listAutoInjectRankingDocuments(op.allowlist),
      };
    case "current":
      return { id: request.id, type: "hits", hits: store.filterCurrentSearchHits(op) };
    case "semantic":
      return hitsResponse(request.id, store.searchSemantic(op));
    case "lexical":
      return hitsResponse(request.id, store.search(op));
    case "any-term":
      return hitsResponse(request.id, store.searchAnyTerm(op));
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
let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = adaptToolResultToHost(decodeThreadSearchRequest(event));
  queue = queue.then(() => run(request));
});
