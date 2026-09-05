import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLilacBus,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  subscribeForTest,
  type TestRawMessageHandler,
  type TestRawSubscriptionHost,
} from "./helpers/result-raw-bus";
import type { RequestContext } from "../src/tool-server/types";
import { Attachment } from "../src/tool-server/tools/attachment";
import { resolveRestrictedSessionTmpDir } from "../src/shared/attachment-utils";
import { Panic, Result } from "better-result";
import {
  ResourceOriginUnavailable,
  ResourceTooLarge,
  type MaterializedResource,
  type ResourceAccess,
  type ResourceDescriptor,
  type VerifiedResourceRead,
} from "../src/resource";
import {
  createToolResultArtifactStore,
  type ToolResultArtifactStore,
} from "../src/artifacts/tool-result-artifact-store";
import { getTestBlobStore } from "./helpers/blob-store";

type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

let restoreFetch: (() => void) | undefined;

function installMockFetch(handler: MockFetch): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
    restoreFetch = undefined;
  };
}

afterEach(() => {
  restoreFetch?.();
});

async function callValue(
  tool: Attachment,
  ...args: Parameters<Attachment["call"]>
): Promise<unknown> {
  const outcome = (await tool.call(...args)).match<
    { readonly value: unknown } | { readonly error: { readonly message: string } }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in outcome) throw new Error(outcome.error.message);
  return outcome.value;
}

function createInMemoryRawBus(
  onPublish?: (message: Message<unknown>) => void,
): RawBus & TestRawSubscriptionHost {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: TestRawMessageHandler;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-0`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);
      onPublish?.(stored);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, id);
      }

      return { id, cursor: id };
    },

    subscribe: subscribeForTest,
    openTestSubscription: async (
      topic: string,
      opts: SubscriptionOptions,
      handler: TestRawMessageHandler,
    ) => {
      const entry = { topic, opts, handler };
      subs.add(entry);

      if (opts.mode === "tail" && opts.offset?.type === "begin") {
        const existing = topics.get(topic) ?? [];
        for (const m of existing) {
          await handler(m, m.id);
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },

    fetch: async (topic: string, _opts: FetchOptions) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };
}

function createAttachment(
  bus: ReturnType<typeof createLilacBus>,
  onRegister?: (input: {
    readonly requestId: string;
    readonly requestDeliveryId?: string;
    readonly objectId: string;
  }) => void,
  resourceAccess?: ResourceAccess,
  toolResultArtifacts?: ToolResultArtifactStore,
): Attachment {
  let nextObjectId = 0;
  const blobStore: BlobStore = {
    async startStagedUpload() {
      throw new Error("Staged uploads are not supported by this test store");
    },
    async adopt() {
      throw new Error("Blob adoption is not supported by this test store");
    },
    startUpload: async ({ source, retention }) => {
      const bytes = source instanceof Uint8Array ? source : new Uint8Array();
      const objectId = `b1_${(++nextObjectId).toString(16).padStart(32, "0")}`;
      const handle = { version: 1 as const, objectId };
      const ref = {
        ...handle,
        sha256: "0".repeat(64),
        byteLength: bytes.byteLength,
        ...(retention.kind === "expires" ? { expiresAt: retention.expiresAt } : {}),
      };
      return Result.ok({ handle, completion: Promise.resolve(Result.ok(ref)) });
    },
    resolve: async (handle) => Result.ok({ ...handle, sha256: "0".repeat(64), byteLength: 0 }),
    open: async (ref) =>
      Result.ok({
        ref,
        stream: new ReadableStream({ start: (controller) => controller.close() }),
        completion: Promise.resolve(Result.ok({ sha256: ref.sha256, byteLength: ref.byteLength })),
      }),
    delete: async () => Result.ok("deleted" as const),
    maintain: async () => Result.ok({ inspected: 0, deleted: 0, remaining: false }),
    close: async () => Result.ok({ completedUploads: 0, interruptedUploads: 0 }),
  };
  return new Attachment({
    bus,
    blobStore,
    outputLifecycle: {
      registerOutputHandle: async (input) => {
        onRegister?.({
          requestId: input.requestId,
          requestDeliveryId: input.requestDeliveryId,
          objectId: input.handle.objectId,
        });
        return Result.ok(undefined);
      },
    },
    ...(resourceAccess ? { resourceAccess } : {}),
    ...(toolResultArtifacts ? { toolResultArtifacts } : {}),
  });
}

function fakeResourceAccess(materialize: ResourceAccess["materialize"]): ResourceAccess {
  return { materialize } as ResourceAccess;
}

function fakeOpenResourceAccess(open: ResourceAccess["open"]): ResourceAccess {
  return { open } as ResourceAccess;
}

function verifiedTextResource(
  uri: string,
  content: Uint8Array,
  filename: string,
): VerifiedResourceRead {
  const sha256 = "a".repeat(64);
  return {
    descriptor: {
      uri: uri as ResourceDescriptor["uri"],
      filename,
      detectedMediaType: "text/plain",
      cachedByteLength: content.byteLength,
    },
    classification: { kind: "text", mediaType: "text/plain", encoding: "utf-8" },
    blob: {
      version: 1,
      objectId: "b1_00000000000000000000000000000001",
      sha256,
      byteLength: content.byteLength,
    },
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    }),
    completion: Promise.resolve(Result.ok({ sha256, byteLength: content.byteLength })),
  };
}

function isAddFilesResult(
  value: unknown,
): value is { ok: true; attachments: Array<{ filename: string }> } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ok === true && Array.isArray(record.attachments);
}

describe("tool-server attachment", () => {
  it("uses collision-resistant restricted tmp directories", () => {
    expect(resolveRestrictedSessionTmpDir(".")).not.toBe("/tmp/lilac-restricted");
    expect(resolveRestrictedSessionTmpDir("..")).not.toBe("/tmp");
    expect(resolveRestrictedSessionTmpDir("a/b")).not.toBe(resolveRestrictedSessionTmpDir("a_b"));
  });

  it("advertises paths as variadic primary positional input", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tool = createAttachment(bus);

    const entries = await tool.list();
    const addFiles = entries.find((entry) => entry.callableId === "attachment.add_files");

    expect(addFiles?.primaryPositional).toEqual({
      field: "paths",
      variadic: true,
    });
    expect(addFiles?.description).toBe(
      "Reads local files or resources and attaches them to the current reply.",
    );
  });

  it("keeps attachment.download callable but marks it deprecated and hidden", async () => {
    const raw = createInMemoryRawBus();
    const tool = createAttachment(createLilacBus(raw));

    const entry = (await tool.list()).find(
      (candidate) => candidate.callableId === "attachment.download",
    );

    expect(entry?.hidden).toBe(true);
    expect(entry?.description).toBe(
      "Deprecated: materialize inbound resources. Prefer resource.materialize.",
    );
  });

  it("accepts scalar paths and filenames", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-tool-server-"));
    const p = join(tmp, "hello.txt");
    await fs.writeFile(p, "hello", "utf8");

    try {
      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const tool = createAttachment(bus);

      const ctx: RequestContext = {
        requestId: "discord:c1:m1",
        sessionId: "c1",
        requestClient: "discord",
        cwd: tmp,
      };

      const res = await callValue(
        tool,
        "attachment.add_files",
        {
          paths: p,
          filenames: "renamed.txt",
        },
        { context: ctx },
      );

      expect(isAddFilesResult(res)).toBe(true);
      if (!isAddFilesResult(res)) return;
      expect(res.attachments.length).toBe(1);
      expect(res.attachments[0]?.filename).toBe("renamed.txt");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("registers a durable blob handle before publishing generated output", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-tool-server-"));
    const path = join(tmp, "hello.txt");
    await fs.writeFile(path, "hello", "utf8");

    try {
      let registeredObjectId: string | undefined;
      let publishedData: unknown;
      const raw = createInMemoryRawBus((message) => {
        expect(registeredObjectId).toBeDefined();
        publishedData = message.data;
      });
      const tool = createAttachment(createLilacBus(raw), (input) => {
        expect(input.requestId).toBe("discord:c1:m1");
        expect(input.requestDeliveryId).toBe("delivery-1");
        registeredObjectId = input.objectId;
      });

      await callValue(
        tool,
        "attachment.add_files",
        { paths: path },
        {
          context: {
            requestId: "discord:c1:m1",
            requestDeliveryId: "delivery-1",
            sessionId: "c1",
            requestClient: "discord",
            cwd: tmp,
          },
        },
      );

      expect(publishedData).toEqual({
        blob: { version: 1, objectId: registeredObjectId },
        mimeType: "text/plain",
        filename: "hello.txt",
      });
      expect(publishedData).not.toHaveProperty("dataBase64");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("accepts files as an alias for paths", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-tool-server-"));
    const p = join(tmp, "hello.txt");
    await fs.writeFile(p, "hello", "utf8");

    try {
      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const tool = createAttachment(bus);

      const ctx: RequestContext = {
        requestId: "discord:c1:m1",
        sessionId: "c1",
        requestClient: "discord",
        cwd: tmp,
      };

      const res = await callValue(
        tool,
        "attachment.add_files",
        {
          files: p,
          filenames: "aliased.txt",
        },
        { context: ctx },
      );

      expect(isAddFilesResult(res)).toBe(true);
      if (!isAddFilesResult(res)) return;
      expect(res.attachments.length).toBe(1);
      expect(res.attachments[0]?.filename).toBe("aliased.txt");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("attaches retained resource URIs without resolving them as filesystem paths", async () => {
    const uri = "resource://r1_00000000000000000000000000000001";
    const content = Buffer.from("retained resource", "utf8");
    let openOptions: Parameters<ResourceAccess["open"]>[1] | undefined;
    const resourceAccess = fakeOpenResourceAccess(async (inputUri, options) => {
      openOptions = options;
      return Result.ok(verifiedTextResource(inputUri, content, "retained.txt"));
    });
    const tool = createAttachment(
      createLilacBus(createInMemoryRawBus()),
      undefined,
      resourceAccess,
    );

    const value = await callValue(
      tool,
      "attachment.add_files",
      { paths: uri },
      {
        context: {
          requestId: "discord:c1:m1",
          sessionId: "c1",
          requestClient: "discord",
          cwd: "/workspace",
          safetyMode: "restricted",
        },
      },
    );

    expect(value).toEqual({
      ok: true,
      attachments: [
        { filename: "retained.txt", mimeType: "text/plain", bytes: content.byteLength },
      ],
    });
    expect(openOptions).toMatchObject({ maxBytes: 8 * 1024 * 1024, expected: "any" });
  });

  it("rejects an oversized retained resource before publishing it", async () => {
    const uri = "resource://r1_00000000000000000000000000000001";
    let publishCount = 0;
    const raw = createInMemoryRawBus(() => {
      publishCount += 1;
    });
    const resourceAccess = fakeOpenResourceAccess(async (inputUri, options) =>
      Result.err(
        new ResourceTooLarge({
          uri: inputUri,
          limit: options.maxBytes,
          limitKind: "operation",
          reportedBytes: options.maxBytes + 1,
          message: `Resource exceeds the ${options.maxBytes}-byte limit`,
        }),
      ),
    );
    const tool = createAttachment(createLilacBus(raw), undefined, resourceAccess);

    const result = await tool.call(
      "attachment.add_files",
      { paths: uri },
      {
        context: {
          requestId: "discord:c1:m1",
          sessionId: "c1",
          requestClient: "discord",
          cwd: "/workspace",
        },
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatchObject({ kind: "usage" });
    }
    expect(publishCount).toBe(0);
  });

  it("enforces the total byte limit across mixed local and resource sources", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lilac-att-mixed-limit-"));
    const localPath = join(root, "local.txt");
    await fs.writeFile(localPath, "x", "utf8");
    const resourceBytes = Buffer.alloc(8 * 1024 * 1024, 1);
    const firstUri = "resource://r1_00000000000000000000000000000001";
    const secondUri = "resource://r1_00000000000000000000000000000002";
    let publishCount = 0;
    const raw = createInMemoryRawBus(() => {
      publishCount += 1;
    });
    const resourceAccess = fakeOpenResourceAccess(async (uri) =>
      Result.ok(verifiedTextResource(uri, resourceBytes, `${uri.slice(-2)}.txt`)),
    );
    const tool = createAttachment(createLilacBus(raw), undefined, resourceAccess);

    try {
      const result = await tool.call(
        "attachment.add_files",
        { paths: [localPath, firstUri, secondUri] },
        {
          context: {
            requestId: "discord:c1:m1",
            sessionId: "c1",
            requestClient: "discord",
            cwd: root,
          },
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toMatchObject({
          kind: "usage",
          message: expect.stringContaining("Total attachment bytes too large"),
        });
      }
      expect(publishCount).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("attaches transient resource URIs only within their session scope", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lilac-att-transient-resource-"));
    try {
      const artifacts = createToolResultArtifactStore(
        join(root, "artifacts"),
        await getTestBlobStore(),
      );
      await artifacts.init();
      const created = (
        await artifacts.create({
          scopeId: "session-a",
          requestId: "request-a",
          toolCallId: "call-a",
          toolName: "bash",
          content: "transient content",
          ttlMs: 60_000,
          maxBytesPerScope: 1024,
        })
      ).match({
        ok: (value) => value,
        err: (error) => {
          throw error;
        },
      });
      const tool = createAttachment(
        createLilacBus(createInMemoryRawBus()),
        undefined,
        undefined,
        artifacts,
      );
      const context = {
        requestId: "request-a",
        sessionId: "session-a",
        requestClient: "discord",
        cwd: root,
      };

      const value = await callValue(
        tool,
        "attachment.add_files",
        { paths: created.uri },
        { context },
      );
      expect(value).toEqual({
        ok: true,
        attachments: [
          {
            filename: `tool-result-${created.id.replaceAll("-", "").slice(0, 8)}.txt`,
            mimeType: "text/plain",
            bytes: Buffer.byteLength("transient content"),
          },
        ],
      });

      const foreign = await tool.call(
        "attachment.add_files",
        { paths: created.uri },
        { context: { ...context, sessionId: "session-b" } },
      );
      expect(foreign.status).toBe("error");
      if (foreign.status === "error") {
        expect(foreign.error).toMatchObject({ kind: "not_found" });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows restricted attachment reads from sandbox /tmp", async () => {
    const sessionId = "restricted-attachment-test";
    const restrictedTmp = resolveRestrictedSessionTmpDir(sessionId);
    await fs.mkdir(restrictedTmp, { recursive: true });
    await fs.writeFile(join(restrictedTmp, "hello.txt"), "hello", "utf8");

    try {
      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const tool = createAttachment(bus);

      const ctx: RequestContext = {
        requestId: "discord:c1:m1",
        sessionId,
        requestClient: "discord",
        cwd: "/tmp",
        safetyMode: "restricted",
      };

      const res = await callValue(
        tool,
        "attachment.add_files",
        {
          paths: "hello.txt",
        },
        { context: ctx },
      );

      expect(isAddFilesResult(res)).toBe(true);
      if (!isAddFilesResult(res)) return;
      expect(res.attachments[0]?.filename).toBe("hello.txt");
    } finally {
      await fs.rm(restrictedTmp, { recursive: true, force: true });
    }
  });

  it("rejects restricted attachment reads outside sandbox /tmp", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tool = createAttachment(bus);

    const ctx: RequestContext = {
      requestId: "discord:c1:m1",
      sessionId: "restricted-attachment-test",
      requestClient: "discord",
      cwd: "/workspace",
      safetyMode: "restricted",
    };

    const result = await tool.call(
      "attachment.add_files",
      {
        paths: "secret.txt",
      },
      { context: ctx },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatchObject({
        kind: "denied",
        message: "Restricted mode only allows file paths under /tmp.",
      });
    }
  });

  it("reports restricted attachment download paths as sandbox /tmp paths", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tool = createAttachment(bus);

    const res = await callValue(
      tool,
      "attachment.download",
      {},
      {
        context: {
          requestId: "discord:c1:m1",
          sessionId: "restricted-attachment-test",
          requestClient: "discord",
          cwd: "/workspace",
          safetyMode: "restricted",
        },
        messages: [],
      },
    );

    expect(res).toEqual({ ok: true, downloadDir: "/tmp", files: [] });
  });

  it("materializes current request resources without exposing an origin URL", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-resource-"));
    const uri = "resource://r1_00000000000000000000000000000001";
    try {
      const resourceAccess = fakeResourceAccess(async (inputUri, options) =>
        Result.ok({
          uri: inputUri,
          path: join(options.targetDirectory, "report.pdf"),
          filename: "report.pdf",
          mimeType: "application/pdf",
          bytes: 7,
          sha256: "a".repeat(64),
        } as MaterializedResource),
      );
      const tool = createAttachment(
        createLilacBus(createInMemoryRawBus()),
        undefined,
        resourceAccess,
      );

      const value = await callValue(
        tool,
        "attachment.download",
        { downloadDir: tmp },
        {
          context: { cwd: tmp, safetyMode: "trusted" },
          messages: [
            {
              role: "user",
              content: [
                { type: "resource", uri, filename: "report.pdf", mediaType: "application/pdf" },
              ],
            },
          ],
        },
      );

      expect(value).toEqual({
        ok: true,
        downloadDir: tmp,
        files: [
          {
            path: join(tmp, "report.pdf"),
            sha10: "aaaaaaaaaa",
            bytes: 7,
            sourceUrl: uri,
            mimeType: "application/pdf",
          },
        ],
      });
      expect(JSON.stringify(value)).not.toContain("discordapp.com");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps earlier resource files when a later deprecated download item fails", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-resource-"));
    const firstUri = "resource://r1_00000000000000000000000000000001";
    const secondUri = "resource://r1_00000000000000000000000000000002";
    const calls: string[] = [];
    try {
      const resourceAccess = fakeResourceAccess(async (uri, options) => {
        calls.push(uri);
        if (uri === secondUri) {
          return Result.err(
            new ResourceOriginUnavailable({
              uri,
              retryable: true,
              message: "origin is unavailable",
            }),
          );
        }
        await fs.writeFile(join(options.targetDirectory, "first.txt"), "first", "utf8");
        return Result.ok({
          uri,
          path: join(options.targetDirectory, "first.txt"),
          filename: "first.txt",
          mimeType: "text/plain",
          bytes: 5,
          sha256: "b".repeat(64),
        } as MaterializedResource);
      });
      const tool = createAttachment(
        createLilacBus(createInMemoryRawBus()),
        undefined,
        resourceAccess,
      );

      const result = await tool.call(
        "attachment.download",
        { downloadDir: tmp },
        {
          context: { cwd: tmp, safetyMode: "trusted" },
          messages: [
            {
              role: "user",
              content: [
                { type: "resource", uri: firstUri },
                { type: "resource", uri: secondUri },
              ],
            },
          ],
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toMatchObject({ kind: "unavailable" });
      }
      expect(calls).toEqual([firstUri, secondUri]);
      expect(await fs.readFile(join(tmp, "first.txt"), "utf8")).toBe("first");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the historical stored-blob download path", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-blob-"));
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    try {
      const tool = createAttachment(createLilacBus(createInMemoryRawBus()));

      const value = await callValue(
        tool,
        "attachment.download",
        { downloadDir: tmp },
        {
          context: { cwd: tmp, safetyMode: "trusted" },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "blob",
                  blob: {
                    version: 1,
                    objectId: "b1_00000000000000000000000000000001",
                    sha256,
                    byteLength: 0,
                  },
                  mediaType: "text/plain",
                  filename: "legacy.txt",
                },
              ],
            },
          ],
        },
      );

      expect(value).toEqual({
        ok: true,
        downloadDir: tmp,
        files: [
          {
            path: join(tmp, "e3b0c44298.txt"),
            sha10: "e3b0c44298",
            bytes: 0,
            sourceUrl: "inline",
            mimeType: "text/plain",
          },
        ],
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects attachment.download URLs outside Discord CDN hosts", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tool = createAttachment(bus);

    const result = await tool.call(
      "attachment.download",
      {},
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "application/pdf",
                filename: "external.pdf",
                data: "https://example.com/external.pdf",
              },
            ],
          },
        ],
      },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("denied");
      expect(result.error.message).toContain("Blocked attachment host 'example.com'");
    }
  });

  it("redacts signed URL query strings from download failures", async () => {
    installMockFetch(async () => new Response("unavailable", { status: 503 }));
    const raw = createInMemoryRawBus();
    const tool = createAttachment(createLilacBus(raw));
    const signedUrl =
      "https://cdn.discordapp.com/attachments/1/2/report.pdf?ex=secret-expiry&sig=secret-signature";

    const result = await tool.call(
      "attachment.download",
      {},
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "application/pdf",
                filename: "report.pdf",
                data: signedUrl,
              },
            ],
          },
        ],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain(
        "https://cdn.discordapp.com/attachments/1/2/report.pdf",
      );
      expect(result.error.message).not.toContain("secret-expiry");
      expect(result.error.message).not.toContain("secret-signature");
      expect(result.error.message).not.toContain("?");
    }
  });

  it("preserves Panic from attachment downloads", async () => {
    const panic = new Panic({ message: "attachment fetch invariant" });
    installMockFetch(async () => {
      throw panic;
    });
    const raw = createInMemoryRawBus();
    const tool = createAttachment(createLilacBus(raw));

    const [settled] = await Promise.allSettled([
      tool.call(
        "attachment.download",
        {},
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "file",
                  mediaType: "application/pdf",
                  filename: "report.pdf",
                  data: "https://cdn.discordapp.com/attachments/1/2/report.pdf?sig=secret",
                },
              ],
            },
          ],
        },
      ),
    ]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
  });
});
