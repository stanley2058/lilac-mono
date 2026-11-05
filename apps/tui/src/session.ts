import { ORPCError } from "@orpc/client";
import {
  createNativeHttpRPC,
  NativeClient,
  type CacheScope,
  type NativeCache,
} from "@stanley2058/lilac-client";
import {
  bootstrapReplySchema,
  type BootstrapInput,
  type BootstrapReply,
} from "@stanley2058/lilac-client-protocol";
import { Result, TaggedError } from "better-result";
import type { TuiAuthSession } from "./auth.ts";

const BunSocket = WebSocket as typeof WebSocket & {
  new (url: URL, options: Bun.WebSocketOptions): WebSocket;
};

export class TuiRequestError extends TaggedError("TuiRequestError")<{
  code: "unauthenticated" | "forbidden" | "unavailable" | "incompatible" | "canceled";
  message: string;
}> {}

export type TuiSession = {
  client: NativeClient;
  scope: CacheScope;
  initial: BootstrapReply;
  upload(
    resourceId: string,
    file: Blob,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  logout(): Promise<void>;
  dispose(): Promise<void>;
};

function failed(code: TuiRequestError["code"], message: string): TuiRequestError {
  return new TuiRequestError({ code, message });
}

export function nativeTuiHttpFailure(error: TuiRequestError): never {
  switch (error.code) {
    case "unauthenticated":
      throw new ORPCError("UNAUTHENTICATED", { message: error.message });
    case "forbidden":
      throw new ORPCError("FORBIDDEN", { message: error.message });
    case "canceled":
      throw new ORPCError("CLIENT_CLOSED_REQUEST", { message: error.message });
    case "incompatible":
      throw new ORPCError("BAD_GATEWAY", { message: error.message });
    case "unavailable":
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message });
  }
}

function httpValue<T>(result: Result<T, TuiRequestError>): T {
  const settle = result.match({
    ok: (value) => () => value,
    err: (error) => () => nativeTuiHttpFailure(error),
  });
  return settle();
}

function responseStatus(response: Response): Result<Response, TuiRequestError> {
  if (response.status === 401)
    return Result.err(
      failed("unauthenticated", "Temporary conversation ended. Restart lilac-tui."),
    );
  if (response.status === 403)
    return Result.err(
      failed(
        "forbidden",
        "This account does not have access. Ask the installation owner to add it.",
      ),
    );
  if (!response.ok)
    return Result.err(failed("unavailable", "The native server could not complete the request."));
  return Result.ok(response);
}

export function decodeTuiBootstrap(value: unknown): Result<BootstrapReply, TuiRequestError> {
  const parsed = bootstrapReplySchema.safeParse(value);
  if (!parsed.success)
    return Result.err(
      failed(
        "incompatible",
        "Client and server versions differ. Update lilac-tui and the native server, then reconnect.",
      ),
    );
  return Result.ok(parsed.data);
}

export function bootstrapUrl(baseUrl: string, input: BootstrapInput): URL {
  const url = new URL("/api/bootstrap", baseUrl);
  if (input.threadId) url.searchParams.set("threadId", input.threadId);
  if (input.checkpoint) url.searchParams.set("checkpoint", JSON.stringify(input.checkpoint));
  if (input.catalogRevision) url.searchParams.set("catalogRevision", input.catalogRevision);
  return url;
}

async function readBootstrap(
  baseUrl: string,
  auth: TuiAuthSession,
  input: BootstrapInput,
  signal?: AbortSignal,
): Promise<Result<BootstrapReply, TuiRequestError>> {
  return Result.gen(async function* () {
    const response = yield* Result.await(
      Result.tryPromise({
        try: () =>
          fetch(bootstrapUrl(baseUrl, input), {
            headers: {
              authorization: auth.authorization(),
              "x-lilac-operator-session": auth.sessionId,
            },
            signal,
            redirect: "error",
          }),
        catch: () =>
          signal?.aborted
            ? failed("canceled", "Request canceled.")
            : failed(
                "unavailable",
                "Could not connect to the native server. Check --url and that the server is running.",
              ),
      }),
    );
    yield* responseStatus(response);
    const value = yield* Result.await(
      Result.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: () =>
          failed(
            "incompatible",
            "The server returned an incompatible response. Update lilac-tui and check --url.",
          ),
      }),
    );
    return decodeTuiBootstrap(value);
  });
}

export async function uploadTuiResource(
  baseUrl: string,
  authorization: string,
  resourceId: string,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<Result<void, TuiRequestError>> {
  if (signal?.aborted) return Result.err(failed("canceled", "Upload canceled."));
  let loaded = 0;
  onProgress(0);
  const body = file.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress(Math.min(0.99, loaded / Math.max(1, file.size)));
        controller.enqueue(chunk);
      },
    }),
  );
  const response = await Result.tryPromise({
    try: () =>
      fetch(new URL(`/api/uploads/${encodeURIComponent(resourceId)}`, baseUrl), {
        method: "PUT",
        headers: {
          authorization,
          ...(sessionId ? { "x-lilac-operator-session": sessionId } : {}),
          "content-type": file.type || "application/octet-stream",
          "content-length": String(file.size),
        },
        body,
        signal,
        redirect: "error",
      }),
    catch: () =>
      signal?.aborted
        ? failed("canceled", "Upload canceled.")
        : failed("unavailable", "Upload interrupted. Retry this file."),
  });
  return response.andThen(responseStatus).map(() => {
    onProgress(1);
  });
}

export async function createTuiSession(
  baseUrl: string,
  auth: TuiAuthSession,
  cache: NativeCache,
  signal?: AbortSignal,
): Promise<Result<TuiSession, TuiRequestError>> {
  const loaded = await readBootstrap(baseUrl, auth, { threadId: auth.threadId }, signal);
  const decision = loaded.match<{ initial: BootstrapReply } | { error: TuiRequestError }>({
    ok: (initial) => ({ initial }),
    err: (error) => ({ error }),
  });
  if ("error" in decision) return Result.err(decision.error);
  const initial = decision.initial;
  const scope: CacheScope = {
    installationId: initial.installationId,
    principalId: initial.viewer.id,
    protocolVersion: 1,
    projectionVersion: 1,
  };
  const lifetime = new AbortController();
  let firstBootstrap = true;
  const client = new NativeClient({
    scope,
    transport: initial.transport,
    openHttp: () =>
      createNativeHttpRPC({
        url: new URL("/api/rpc", baseUrl),
        headers: () => ({
          authorization: auth.authorization(),
          "x-lilac-operator-session": auth.sessionId,
        }),
      }),
    cache,
    openSocket: () => {
      const url = new URL("/api/socket", baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new BunSocket(url, {
        headers: {
          authorization: auth.authorization(),
          "x-lilac-operator-session": auth.sessionId,
        },
      });
    },
    bootstrap: async (input, requestSignal) => {
      if (firstBootstrap) {
        firstBootstrap = false;
        return initial;
      }
      return httpValue(await readBootstrap(baseUrl, auth, input, requestSignal));
    },
  });
  if (initial.catalog.kind === "catalog") client.catalogs.put(scope, initial.catalog.catalog);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTask: Promise<void> | undefined;
  let disposed = false;
  let stopping = false;
  const scheduleRefresh = () => {
    if (disposed || stopping) return;
    refreshTimer = setTimeout(() => {
      refreshTask = refresh();
    }, 10_000);
  };
  async function refresh(): Promise<void> {
    const outcome = await auth.refresh();
    if (disposed || stopping) return;
    const error = outcome.match({ ok: () => undefined, err: (failure) => failure });
    if (error?.code === "network" && auth.expiresAt * 1000 > Date.now()) {
      refreshTimer = setTimeout(
        () => {
          refreshTask = refresh();
        },
        Math.min(5000, auth.expiresAt * 1000 - Date.now()),
      );
      return;
    }
    if (error) {
      await client.logout();
      return;
    }
    if (client.rpc) await client.reauthenticate(auth.token);
    scheduleRefresh();
  }
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    auth.dispose();
    clearTimeout(refreshTimer);
    await refreshTask;
    await client.dispose();
  }
  const stopEvents = client.subscribe((event) => {
    if (event.kind !== "connection" || event.state !== "logged-out") return;
    if (stopping) return;
    void dispose();
    stopEvents();
  });
  scheduleRefresh();
  return Result.ok({
    client,
    scope,
    initial,
    async upload(resourceId, file, onProgress, uploadSignal) {
      const uploadLifetime = uploadSignal
        ? AbortSignal.any([lifetime.signal, uploadSignal])
        : lifetime.signal;
      httpValue(
        await uploadTuiResource(
          baseUrl,
          auth.authorization(),
          resourceId,
          file,
          onProgress,
          uploadLifetime,
          auth.sessionId,
        ),
      );
    },
    async logout() {
      stopping = true;
      clearTimeout(refreshTimer);
      await refreshTask;
      const ended = await auth.logout();
      await client.logout();
      await dispose();
      httpValue(ended.mapError((error) => failed("unavailable", error.message)));
    },
    dispose,
  });
}
