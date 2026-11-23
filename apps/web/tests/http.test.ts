import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BootstrapReply } from "@stanley2058/lilac-client-protocol";
import { registerConnectionCredentials } from "../src/connection-credentials";
import {
  readBootstrap,
  readAuthInfo,
  localLogin,
  logoutHttp,
  uploadResource,
  openNativeSocket,
  resourceUrl,
  UPLOAD_ALREADY_ACTIVE_ERROR,
} from "../src/http";

const bootstrap: BootstrapReply = {
  installationId: "install",
  viewer: { id: "owner", displayName: "Owner", role: "owner", toolMode: "full" },
  threads: { items: [] },
  catalog: {
    kind: "catalog",
    catalog: { revision: "catalog", models: [], skills: [], commands: [] },
  },
  catalogCursor: "cursor",
};
const originals = new Map<string, PropertyDescriptor | undefined>();
let stopCredentials: (() => void) | undefined;
function replaceGlobal(key: string, value: unknown): void {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
beforeEach(() => {
  replaceGlobal("location", { origin: "https://lilac.test", protocol: "https:" });
});
afterEach(() => {
  stopCredentials?.();
  stopCredentials = undefined;
  mock.restore();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
  UploadRequest.instances.length = 0;
});

class UploadRequest {
  static instances: UploadRequest[] = [];
  status = 0;
  responseText = "";
  withCredentials = false;
  method = "";
  url = "";
  body?: File;
  headers = new Map<string, string>();
  upload: {
    onprogress:
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() {
    UploadRequest.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  send(file: File): void {
    this.body = file;
  }
  abort(): void {
    this.onabort?.();
  }
  complete(status: number, responseText = ""): void {
    this.status = status;
    this.responseText = responseText;
    this.onload?.();
  }
}

describe("native web HTTP", () => {
  test("bootstrap sends one authenticated request with all reconciliation cursors", async () => {
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(bootstrap));
    const checkpoint = {
      protocolVersion: 1 as const,
      historyGeneration: 2,
      projectionRevision: 7,
      cursor: "thread_cursor",
    };
    expect(
      await readBootstrap({ threadId: "thread", checkpoint, catalogRevision: "catalog" }),
    ).toEqual(bootstrap);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [target, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(target));
    expect(url.origin).toBe("https://lilac.test");
    expect(url.searchParams.get("checkpoint")).toBe(JSON.stringify(checkpoint));
    expect(url.searchParams.get("threadId")).toBe("thread");
    expect(url.searchParams.get("catalogRevision")).toBe("catalog");
    expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });

  test("bootstrap uses refreshed credentials before Clerk updates the cookie", async () => {
    const token = Promise.withResolvers<string>();
    stopCredentials = registerConnectionCredentials(() => token.promise);
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          // The cookie still contains an expired token. Only the freshly returned token is valid.
          if (new Headers(init?.headers).get("authorization") !== "Bearer fresh-token")
            return new Response(null, { status: 401 });
          return Response.json(bootstrap);
        },
        { preconnect: fetch.preconnect },
      ),
    );
    const reading = readBootstrap({ threadId: "thread" });
    expect(fetcher).not.toHaveBeenCalled();
    token.resolve("fresh-token");
    expect(await reading).toEqual(bootstrap);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("a failed token refresh is retryable and an ended session requires sign-in", async () => {
    const fetcher = spyOn(globalThis, "fetch");
    stopCredentials = registerConnectionCredentials(async () => {
      throw new Error("Provider temporarily unavailable");
    });
    await expect(readBootstrap({})).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    stopCredentials();
    stopCredentials = registerConnectionCredentials(async () => null);
    await expect(readBootstrap({})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("canceling during credential refresh prevents a stale bootstrap request", async () => {
    const token = Promise.withResolvers<string>();
    stopCredentials = registerConnectionCredentials(() => token.promise);
    const controller = new AbortController();
    const fetcher = spyOn(globalThis, "fetch");
    const reading = readBootstrap({}, controller.signal);
    controller.abort();
    token.resolve("fresh-token");
    await expect(reading).rejects.toMatchObject({ code: "CLIENT_CLOSED_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [503, "SERVICE_UNAVAILABLE"],
  ] as const)("bootstrap preserves HTTP %s as an oRPC %s failure", async (status, code) => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    await expect(readBootstrap({})).rejects.toMatchObject({ code });
  });

  test("bootstrap invalid JSON and incompatible output become reload errors", async () => {
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{"));
    await expect(readBootstrap({})).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    fetcher.mockResolvedValue(Response.json({ privateUnexpected: true }));
    await expect(readBootstrap({})).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });

  test("aborted bootstrap forwards its signal and has a distinct outcome", async () => {
    const controller = new AbortController();
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        },
        { preconnect: fetch.preconnect },
      ),
    );
    await expect(readBootstrap({}, controller.signal)).rejects.toMatchObject({
      code: "CLIENT_CLOSED_REQUEST",
    });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  test("auth settings decode strictly, login keeps only the HttpOnly cookie, and logout uses POST", async () => {
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ provider: "local" }),
    );
    expect((await readAuthInfo()).unwrap()).toEqual({ provider: "local" });
    fetcher.mockResolvedValue(Response.json({ provider: "local", secretKey: "never-accepted" }));
    expect((await readAuthInfo()).isErr()).toBe(true);
    fetcher.mockResolvedValue(Response.json({ token: "ignored" }));
    expect((await localLogin("operator", "pássword")).isOk()).toBe(true);
    const request = fetcher.mock.calls.at(-1)!;
    expect(request[0]).toBe("/api/auth/login");
    const header = new Headers(request[1]?.headers).get("authorization")!;
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header.slice(6)), (character) => character.charCodeAt(0)),
    );
    expect(decoded).toBe("operator:pássword");
    expect(request[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect((await logoutHttp()).isOk()).toBe(true);
    expect(fetcher.mock.calls.at(-1)).toEqual([
      "/api/auth/logout",
      { method: "POST", credentials: "same-origin", cache: "no-store" },
    ]);
  });

  test("upload returns immediately while HTTP body and progress remain independent of message submission", async () => {
    replaceGlobal("XMLHttpRequest", UploadRequest);
    const file = new File([new Uint8Array(1024 * 1024)], "large.bin", {
      type: "application/octet-stream",
    });
    const progress: number[] = [];
    let completed = false;
    const upload = uploadResource("resource", file, (fraction) => progress.push(fraction)).then(
      () => {
        completed = true;
      },
    );
    const request = UploadRequest.instances[0]!;
    const submit = mock(() => Promise.resolve({ state: "uploading" }));
    expect(await submit()).toEqual({ state: "uploading" });
    expect(completed).toBe(false);
    expect(request.body).toBe(file);
    expect(request.method).toBe("PUT");
    expect(request.withCredentials).toBe(true);
    request.upload.onprogress?.({ lengthComputable: true, loaded: 512, total: 1024 });
    expect(progress).toEqual([0.5]);
    request.complete(200);
    await upload;
    expect(completed).toBe(true);
    expect(progress).toEqual([0.5, 1]);
    expect(request.upload.onprogress).toBeNull();
  });

  test("upload cancellation and failed authorization settle without reporting readiness", async () => {
    replaceGlobal("XMLHttpRequest", UploadRequest);
    const file = new File(["hello"], "note.txt");
    const controller = new AbortController();
    const progress = mock(() => undefined);
    const canceled = uploadResource("resource", file, progress, controller.signal);
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ code: "CLIENT_CLOSED_REQUEST" });
    expect(progress).not.toHaveBeenCalled();
    const denied = uploadResource("resource", file, progress);
    UploadRequest.instances.at(-1)!.complete(403);
    await expect(denied).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(progress).not.toHaveBeenCalled();
    const alreadyCanceled = new AbortController();
    alreadyCanceled.abort();
    const before = UploadRequest.instances.length;
    await expect(
      uploadResource("resource", file, progress, alreadyCanceled.signal),
    ).rejects.toMatchObject({ code: "CLIENT_CLOSED_REQUEST" });
    expect(UploadRequest.instances).toHaveLength(before);

    const activeConflict = uploadResource("resource", file, progress);
    UploadRequest.instances
      .at(-1)!
      .complete(409, JSON.stringify({ error: UPLOAD_ALREADY_ACTIVE_ERROR }));
    await expect(activeConflict).rejects.toThrow(UPLOAD_ALREADY_ACTIVE_ERROR);

    const genericConflict = uploadResource("resource", file, progress);
    UploadRequest.instances
      .at(-1)!
      .complete(409, JSON.stringify({ error: "Upload is no longer writable" }));
    await expect(genericConflict).rejects.toThrow("Upload failed. Retry this file.");

    const malformedConflict = uploadResource("resource", file, progress);
    UploadRequest.instances.at(-1)!.complete(409, "not-json");
    await expect(malformedConflict).rejects.toThrow("Upload failed. Retry this file.");
  });

  test("socket uses the same origin without query credentials and resource IDs stay opaque", () => {
    const urls: string[] = [];
    replaceGlobal(
      "WebSocket",
      class {
        constructor(url: URL) {
          urls.push(String(url));
        }
      },
    );
    openNativeSocket();
    expect(urls).toEqual(["wss://lilac.test/api/socket"]);
    expect(resourceUrl("path/with?characters")).toBe("/api/resources/path%2Fwith%3Fcharacters");
  });
});

test("logout accepts an already-expired session but preserves server failures", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  expect((await logoutHttp()).isOk()).toBe(true);
  fetcher.mockResolvedValue(new Response(null, { status: 503 }));
  expect((await logoutHttp()).isErr()).toBe(true);
});
