import { describe, expect, it } from "bun:test";
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
import { Result } from "better-result";
import {
  ResourceTooLarge,
  type ResourceAccess,
  type ResourceDescriptor,
  type VerifiedResourceRead,
} from "../src/resource";
import {
  createToolResultArtifactStore,
  type ToolResultArtifactStore,
} from "../src/artifacts/tool-result-artifact-store";
import { getTestBlobStore } from "./helpers/blob-store";

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
  it("rejects the removed attachment.download callable", async () => {
    const tool = createAttachment(createLilacBus(createInMemoryRawBus()));
    expect((await tool.list()).some((entry) => entry.callableId === "attachment.download")).toBe(
      false,
    );
    expect(
      (await tool.call("attachment.download", {})).match({ ok: () => null, err: (error) => error }),
    ).toMatchObject({
      kind: "not_found",
      code: "unknown_callable",
    });
  });

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
});
