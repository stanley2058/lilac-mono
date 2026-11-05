import { createNativeHttpRPC } from "@stanley2058/lilac-client";
import { ORPCError } from "@orpc/client";
import {
  bootstrapReplySchema,
  type BootstrapInput,
  type BootstrapReply,
} from "@stanley2058/lilac-client-protocol";
import { Result, TaggedError } from "better-result";
import { z } from "zod";
import { readConnectionToken } from "./connection-credentials";

export class WebRequestFailed extends TaggedError("WebRequestFailed")<{
  code: "unauthenticated" | "forbidden" | "unavailable" | "incompatible" | "canceled";
  message: string;
}> {}
export const authInfoSchema = z.strictObject({
  provider: z.enum(["local", "clerk"]),
  publishableKey: z.string().optional(),
  issuer: z.string().optional(),
  oauthClientId: z.string().optional(),
});
export type AuthInfo = z.infer<typeof authInfoSchema>;

function failed(code: WebRequestFailed["code"], message: string): WebRequestFailed {
  return new WebRequestFailed({ code, message });
}

export function nativeWebHttpFailure(error: WebRequestFailed): never {
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

function httpValue<T>(result: Result<T, WebRequestFailed>): T {
  const settle = result.match({
    ok: (value) => () => value,
    err: (error) => () => nativeWebHttpFailure(error),
  });
  return settle();
}

function responseStatus(response: Response): Result<Response, WebRequestFailed> {
  if (response.status === 401) return Result.err(failed("unauthenticated", "Sign in to continue"));
  if (response.status === 403)
    return Result.err(failed("forbidden", "The owner has not added this account"));
  if (!response.ok) return Result.err(failed("unavailable", "Could not connect to Lilac"));
  return Result.ok(response);
}

function request(
  url: string | URL,
  init: RequestInit = {},
): Promise<Result<Response, WebRequestFailed>> {
  return Result.tryPromise({
    try: () => fetch(url, { ...init, credentials: "same-origin", cache: "no-store" }),
    catch: () =>
      init.signal?.aborted
        ? failed("canceled", "Request canceled")
        : failed("unavailable", "Could not connect to Lilac"),
  });
}

export function decodeWebBootstrap(value: unknown): Result<BootstrapReply, WebRequestFailed> {
  const parsed = bootstrapReplySchema.safeParse(value);
  if (!parsed.success)
    return Result.err(
      failed("incompatible", "Client and server versions differ. Reload to update."),
    );
  return Result.ok(parsed.data);
}

async function bootstrapResult(
  input: BootstrapInput,
  signal?: AbortSignal,
): Promise<Result<BootstrapReply, WebRequestFailed>> {
  const url = new URL("/api/bootstrap", location.origin);
  if (input.threadId) url.searchParams.set("threadId", input.threadId);
  if (input.checkpoint) url.searchParams.set("checkpoint", JSON.stringify(input.checkpoint));
  if (input.catalogRevision) url.searchParams.set("catalogRevision", input.catalogRevision);
  return Result.gen(async function* () {
    const token = yield* Result.await(
      Result.tryPromise({
        try: readConnectionToken,
        catch: () => failed("unavailable", "Could not refresh your session. Retry connection."),
      }),
    );
    if (signal?.aborted) return Result.err(failed("canceled", "Request canceled"));
    if (token === null) return Result.err(failed("unauthenticated", "Sign in to continue"));
    // Clerk may update its session cookie after getToken resolves. Use the returned token so a
    // foreground bootstrap cannot mistake that stale cookie for an ended session.
    const response = yield* Result.await(
      request(url, { signal, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) }),
    );
    yield* responseStatus(response);
    const body = yield* Result.await(
      Result.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: () => failed("incompatible", "Client and server versions differ. Reload to update."),
      }),
    );
    return decodeWebBootstrap(body);
  });
}

export async function readBootstrap(
  input: BootstrapInput,
  signal?: AbortSignal,
): Promise<BootstrapReply> {
  return httpValue(await bootstrapResult(input, signal));
}

export function openNativeHttp() {
  return createNativeHttpRPC({
    url: new URL("/api/rpc", location.origin),
    headers: async () => {
      const token = await readConnectionToken();
      if (token === null)
        return nativeWebHttpFailure(failed("unauthenticated", "Sign in to continue"));
      return token ? { authorization: `Bearer ${token}` } : {};
    },
  });
}

export function openNativeSocket(): WebSocket {
  const url = new URL("/api/socket", location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}

export function decodeWebAuthInfo(value: unknown): Result<AuthInfo, WebRequestFailed> {
  const parsed = authInfoSchema.safeParse(value);
  if (!parsed.success)
    return Result.err(failed("incompatible", "Authentication settings are incompatible"));
  return Result.ok(parsed.data);
}

export async function readAuthInfo(): Promise<Result<AuthInfo, WebRequestFailed>> {
  return Result.gen(async function* () {
    const response = yield* Result.await(request("/api/auth/info"));
    yield* responseStatus(response);
    const body = yield* Result.await(
      Result.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: () => failed("incompatible", "Authentication settings are incompatible"),
      }),
    );
    return decodeWebAuthInfo(body);
  });
}

export async function localLogin(
  username: string,
  password: string,
): Promise<Result<void, WebRequestFailed>> {
  const encoded = new TextEncoder().encode(`${username}:${password}`);
  let bytes = "";
  for (const byte of encoded) bytes += String.fromCharCode(byte);
  return Result.gen(async function* () {
    const response = yield* Result.await(
      request("/api/auth/login", {
        method: "POST",
        headers: { authorization: `Basic ${btoa(bytes)}` },
      }),
    );
    if (!response.ok)
      return Result.err(
        failed("unauthenticated", "Sign-in failed. Check your username and password."),
      );
    return Result.ok();
  });
}

export async function logoutHttp(): Promise<Result<void, WebRequestFailed>> {
  return Result.gen(async function* () {
    const response = yield* Result.await(request("/api/auth/logout", { method: "POST" }));
    if (response.status === 401) return Result.ok();
    yield* responseStatus(response);
    return Result.ok();
  });
}

function uploadResult(
  resourceId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Result<void, WebRequestFailed>> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(Result.err(failed("canceled", "Upload canceled")));
      return;
    }
    let xhr: XMLHttpRequest | undefined;
    let settled = false;
    const abort = () => xhr?.abort();
    const finish = (result: Result<void, WebRequestFailed>) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (xhr) {
        xhr.onload = null;
        xhr.onerror = null;
        xhr.onabort = null;
        xhr.ontimeout = null;
        xhr.upload.onprogress = null;
      }
      resolve(result);
    };
    const started = Result.try({
      try: () => {
        const current = new XMLHttpRequest();
        xhr = current;
        current.open("PUT", `/api/uploads/${encodeURIComponent(resourceId)}`);
        current.withCredentials = true;
        current.setRequestHeader("content-type", file.type || "application/octet-stream");
        current.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0)
            onProgress(Math.min(1, Math.max(0, event.loaded / event.total)));
        };
        current.onerror = () =>
          finish(Result.err(failed("unavailable", "Upload interrupted. Retry this file.")));
        current.onabort = () => finish(Result.err(failed("canceled", "Upload canceled")));
        current.ontimeout = () =>
          finish(Result.err(failed("unavailable", "Upload interrupted. Retry this file.")));
        current.onload = () => {
          if (current.status === 401) {
            finish(Result.err(failed("unauthenticated", "Sign in to upload this file")));
            return;
          }
          if (current.status === 403) {
            finish(Result.err(failed("forbidden", "You no longer have access to this thread")));
            return;
          }
          if (current.status < 200 || current.status >= 300) {
            finish(Result.err(failed("unavailable", "Upload failed. Retry this file.")));
            return;
          }
          onProgress(1);
          finish(Result.ok());
        };
        signal?.addEventListener("abort", abort, { once: true });
        current.send(file);
      },
      catch: () => failed("unavailable", "Upload interrupted. Retry this file."),
    });
    started.match({ ok: () => undefined, err: (error) => finish(Result.err(error)) });
  });
}

export async function uploadResource(
  resourceId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  httpValue(await uploadResult(resourceId, file, onProgress, signal));
}

export function resourceUrl(resourceId: string): string {
  return `/api/resources/${encodeURIComponent(resourceId)}`;
}
