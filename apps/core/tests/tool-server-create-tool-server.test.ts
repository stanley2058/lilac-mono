import { afterEach, describe, expect, it, jest } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  serverToolFailure,
  ToolPluginCleanupError,
  ToolPluginHookError,
  ToolPluginManager,
  type Level1ToolSpec,
} from "@stanley2058/lilac-plugin-runtime";
import { createLogger, parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError } from "better-result";

import {
  createToolServer as createToolServerImpl,
  type ToolServerOptions,
  type ToolServerHealthSnapshot,
} from "../src/tool-server/create-tool-server";
import type { RequestContext, ServerTool } from "../src/tool-server/types";
import { RequestControlAuthority } from "../src/tool-server/request-control-authority";
import { requestInvocationCwd } from "../src/tool-server/request-invocation-cwd";
import { decodeToolInput } from "../src/tool-server/validation-error-message";
import type { AuthenticatedRequestProjection } from "../src/surface/authenticated-request";

const originalMemoryUsage = process.memoryUsage;
const TEST_OPERATOR_TOKEN = "tool-server-test-operator";

function createToolServer(options: ToolServerOptions) {
  const hasExplicitAuthority =
    options.authorizeControlRequest !== undefined ||
    options.requestMessageCache !== undefined ||
    options.getConfig !== undefined ||
    options.resolveServerSafetyMode !== undefined ||
    options.operatorTokenSha256 !== undefined;
  if (hasExplicitAuthority) return createToolServerImpl(options);
  const server = createToolServerImpl({
    ...options,
    canonicalWorkspaceRoot: options.canonicalWorkspaceRoot ?? "/workspace",
    operatorTokenSha256: createHash("sha256").update(TEST_OPERATOR_TOKEN).digest("hex"),
  });
  const handle = server.app.handle.bind(server.app);
  server.app.handle = (request: Request) => {
    const hasLilacHeader = Array.from(request.headers.keys()).some((key) =>
      key.startsWith("x-lilac-"),
    );
    if (hasLilacHeader) return handle(request);
    const headers = new Headers(request.headers);
    headers.set("x-lilac-operator-token", TEST_OPERATOR_TOKEN);
    return handle(new Request(request, { headers }));
  };
  return server;
}

function discordRequestProjection(input: {
  readonly requestId: string;
  readonly sessionId: string;
  readonly userId?: string;
  readonly verifiedIngress?: boolean;
}): AuthenticatedRequestProjection {
  const sessionRef = { platform: "discord" as const, channelId: input.sessionId };
  return {
    requestId: input.requestId,
    requestClient: "discord",
    sessionId: input.sessionId,
    source: "external",
    platform: "discord",
    sessionRef,
    ...(input.userId
      ? {
          authenticatedOrigin: {
            platform: "discord" as const,
            userId: input.userId,
            sessionRef,
          },
        }
      : {}),
    authenticationMetadataKind: input.userId ? "origin" : "absent",
    verifiedIngress: input.verifiedIngress ?? input.userId !== undefined,
  };
}

type BuildEnvSnapshot = {
  LILAC_BUILD_VERSION: string | undefined;
  LILAC_BUILD_COMMIT: string | undefined;
  LILAC_BUILD_DIRTY: string | undefined;
  LILAC_BUILD_AT: string | undefined;
};

function setMockMemoryUsage(memory: ReturnType<typeof process.memoryUsage>) {
  process.memoryUsage = (() => memory) as typeof process.memoryUsage;
}

function snapshotBuildEnv(): BuildEnvSnapshot {
  return {
    LILAC_BUILD_VERSION: process.env.LILAC_BUILD_VERSION,
    LILAC_BUILD_COMMIT: process.env.LILAC_BUILD_COMMIT,
    LILAC_BUILD_DIRTY: process.env.LILAC_BUILD_DIRTY,
    LILAC_BUILD_AT: process.env.LILAC_BUILD_AT,
  };
}

function restoreBuildEnv(snapshot: BuildEnvSnapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

async function writePluginServerTool(params: {
  dataDir: string;
  pluginId: string;
  callableId: string;
  value: string;
}): Promise<void> {
  const pluginDir = path.join(params.dataDir, "plugins", params.pluginId, "dist");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "..", "package.json"),
    JSON.stringify(
      {
        name: params.pluginId,
        version: "0.0.1",
        lilac: {
          plugin: "./dist/index.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `import { Result } from ${JSON.stringify(import.meta.resolve("better-result"))};
export default {
  meta: { id: "${params.pluginId}" },
  create() {
    return {
      level2: [{
        id: "${params.pluginId}",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "${params.callableId}", name: "${params.callableId}", description: "${params.callableId}", shortInput: [], input: [] }]; },
        async call() { return Result.ok({ value: "${params.value}" }); },
      }],
    };
  },
};`,
    "utf8",
  );
}

describe("createToolServer", () => {
  it("serves and cleans up the configured unix socket", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-socket-"));
    const socketPath = path.join(root, "tool-server.sock");
    const unrelatedPath = path.join(root, "unrelated.txt");
    const previousSocket = process.env.TOOL_SERVER_BACKEND_SOCKET;
    process.env.TOOL_SERVER_BACKEND_SOCKET = socketPath;
    const server = createToolServer({ tools: [] });
    let stopped = false;

    try {
      await server.init();
      await server.start(0);
      const response = await fetch("http://localhost/healthz", {
        unix: socketPath,
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as { live: boolean }).toMatchObject({
        live: true,
      });
      await fs.writeFile(unrelatedPath, "keep");
      process.env.TOOL_SERVER_BACKEND_SOCKET = unrelatedPath;
      await server.stop();
      stopped = true;
      expect(await fs.readFile(unrelatedPath, "utf8")).toBe("keep");
    } finally {
      if (!stopped) await server.stop();
      if (previousSocket === undefined) delete process.env.TOOL_SERVER_BACKEND_SOCKET;
      else process.env.TOOL_SERVER_BACKEND_SOCKET = previousSocket;
      expect(await Bun.file(socketPath).exists()).toBe(false);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to replace a non-socket unix path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-file-"));
    const socketPath = path.join(root, "tool-server.sock");
    const previousSocket = process.env.TOOL_SERVER_BACKEND_SOCKET;
    await fs.writeFile(socketPath, "keep");
    process.env.TOOL_SERVER_BACKEND_SOCKET = socketPath;
    const server = createToolServer({ tools: [] });

    try {
      await server.init();
      await expect(server.start(0)).rejects.toThrow("Refusing to remove non-socket");
      expect(await fs.readFile(socketPath, "utf8")).toBe("keep");
    } finally {
      await server.stop();
      if (previousSocket === undefined) delete process.env.TOOL_SERVER_BACKEND_SOCKET;
      else process.env.TOOL_SERVER_BACKEND_SOCKET = previousSocket;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("finishes transport cleanup without replacing the original shutdown failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-cleanup-"));
    const socketPath = path.join(root, "tool-server.sock");
    const previousSocket = process.env.TOOL_SERVER_BACKEND_SOCKET;
    const secret = "token=cleanup-secret";
    const destroyFailure = new Error(`destroy failed: ${secret}`);
    const stopFailure = new Error("http stop failed");
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    process.env.TOOL_SERVER_BACKEND_SOCKET = socketPath;
    const server = createToolServer({
      pluginManager: {
        init: async () => Result.ok(undefined),
        destroy: async () => Promise.reject(destroyFailure),
        reload: async () => Result.ok(undefined),
        getLevel2Tools: () => [],
      },
      logger: createLogger({
        module: "tool-server-cleanup-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
    });

    try {
      await server.init();
      await server.start(0);
      const originalStop = server.app.stop.bind(server.app);
      jest.spyOn(server.app, "stop").mockImplementation(() => {
        originalStop();
        throw stopFailure;
      });

      await expect(server.stop()).rejects.toBe(destroyFailure);
      expect(server.app.server).toBeNull();
      expect(await Bun.file(socketPath).exists()).toBe(false);
      expect(chunks.join("\n")).not.toContain(secret);
    } finally {
      jest.restoreAllMocks();
      if (previousSocket === undefined) delete process.env.TOOL_SERVER_BACKEND_SOCKET;
      else process.env.TOOL_SERVER_BACKEND_SOCKET = previousSocket;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces a cleanup Panic after attempting every transport cleanup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-panic-"));
    const socketPath = path.join(root, "tool-server.sock");
    const previousSocket = process.env.TOOL_SERVER_BACKEND_SOCKET;
    const destroyFailure = new Error("destroy failed");
    const cleanupPanic = new Panic({ message: "http stop invariant" });
    process.env.TOOL_SERVER_BACKEND_SOCKET = socketPath;
    const server = createToolServer({
      pluginManager: {
        init: async () => Result.ok(undefined),
        destroy: async () => Promise.reject(destroyFailure),
        reload: async () => Result.ok(undefined),
        getLevel2Tools: () => [],
      },
    });

    try {
      await server.init();
      await server.start(0);
      const originalStop = server.app.stop.bind(server.app);
      jest.spyOn(server.app, "stop").mockImplementation(() => {
        originalStop();
        throw cleanupPanic;
      });

      await expect(server.stop()).rejects.toBe(cleanupPanic);
      expect(server.app.server).toBeNull();
      expect(await Bun.file(socketPath).exists()).toBe(false);
    } finally {
      jest.restoreAllMocks();
      if (previousSocket === undefined) delete process.env.TOOL_SERVER_BACKEND_SOCKET;
      else process.env.TOOL_SERVER_BACKEND_SOCKET = previousSocket;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces an ordinary transport cleanup failure after shutdown", async () => {
    const stopFailure = new Error("http stop failed");
    const server = createToolServer({ tools: [] });
    await server.init();
    await server.start(0);
    const originalStop = server.app.stop.bind(server.app);
    jest.spyOn(server.app, "stop").mockImplementation(() => {
      originalStop();
      throw stopFailure;
    });

    try {
      await expect(server.stop()).rejects.toBe(stopFailure);
      expect(server.app.server).toBeNull();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it("rejects an invalid operator-token digest through the host option adapter", () => {
    expect(() => createToolServer({ operatorTokenSha256: "not-a-sha256-digest" })).toThrow(
      "operatorTokenSha256 must be a SHA-256 hex digest",
    );
  });

  it("returns a typed not-found failure for an unknown /call callable", async () => {
    const server = createToolServer({ tools: [] });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "missing.call", input: {} }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "error",
        error: {
          kind: "not_found",
          code: "unknown_callable",
          message: "Unknown callable ID 'missing.call'",
          retryable: false,
        },
      });
    } finally {
      await server.stop();
    }
  });

  it("returns a typed denial when /call authentication fails", async () => {
    const tool: ServerTool = {
      id: "authentication-test",
      async init() {},
      async destroy() {},
      async list() {
        return [{ callableId: "auth.call", name: "Auth", description: "Auth", shortInput: [] }];
      },
      async call() {
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({
      tools: [tool],
      authorizeControlRequest: () => null,
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "auth.call", input: {} }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "error",
        error: {
          kind: "denied",
          code: "authentication_failed",
          message: "Level-2 tools require an active server-issued request capability",
          retryable: false,
        },
      });
    } finally {
      await server.stop();
    }
  });

  it("preserves typed semantic tool failures over HTTP 200", async () => {
    const failure = serverToolFailure({
      kind: "unavailable",
      code: "backend_offline",
      message: "Backend is offline",
      retryable: true,
      details: { region: "west", attempts: [1, 2] },
    });
    const tool: ServerTool = {
      id: "semantic-failure",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "semantic.fail",
            name: "Semantic failure",
            description: "Returns a typed failure",
            shortInput: [],
          },
        ];
      },
      async call() {
        return Result.err(failure);
      },
    };
    const server = createToolServer({ tools: [tool] });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "semantic.fail", input: {} }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "error", error: failure });
    } finally {
      await server.stop();
    }
  });

  it("normalizes a side-effect-like successful value without executing the tool twice", async () => {
    let calls = 0;
    const tool: ServerTool = {
      id: "successful-output-projection",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "projection.side-effect",
            name: "Projection side effect",
            description: "Returns an optional success field",
            shortInput: [],
          },
        ];
      },
      async call() {
        calls += 1;
        return Result.ok({ ok: true, optional: undefined });
      },
    };
    const server = createToolServer({ tools: [tool] });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "projection.side-effect", input: {} }),
        }),
      );

      expect(await response.json()).toEqual({ status: "ok", value: { ok: true } });
      expect(calls).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it("reports output serialization defects opaquely while preserving mcp.add safety", async () => {
    const secret = "mcp-output-serialization-secret";
    const reported: Error[] = [];
    let calls = 0;
    const tool: ServerTool = {
      id: "output-serialization-defect",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "mcp.add",
            name: "MCP add",
            description: "Returns an unserializable successful value",
            shortInput: [],
          },
        ];
      },
      async call() {
        calls += 1;
        return Result.ok({
          toJSON() {
            throw new Error(secret);
          },
        });
      },
    };
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "output-serialization-defect-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
      reportFatalToolCallDefect: (defect) => reported.push(defect),
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "mcp.add", input: {} }),
        }),
      );
      const body = await response.json();

      expect(body).toEqual({
        status: "error",
        error: {
          kind: "internal",
          code: "mcp_add_failed",
          message: "mcp.add failed without exposing sensitive configuration",
          retryable: false,
        },
      });
      expect(calls).toBe(1);
      expect(reported).toHaveLength(1);
      expect(reported[0]?.message).toBe("Plugin tool output violated the JSON wire contract");
      expect(
        `${JSON.stringify(body)}\n${chunks.join("\n")}\n${reported[0]?.message}`,
      ).not.toContain(secret);
    } finally {
      await server.stop();
    }
  });

  it("turns malformed plugin Results into opaque internal contract failures", async () => {
    const secret = "legacy-result-secret";
    const reported: Error[] = [];
    const chunks: string[] = [];
    const tool = {
      id: "legacy-result",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "legacy.envelope",
            name: "Legacy envelope",
            description: "Returns a raw wire-shaped envelope",
            shortInput: [],
          },
          {
            callableId: "legacy.empty-code",
            name: "Empty failure code",
            description: "Returns a malformed Result failure",
            shortInput: [],
          },
        ];
      },
      async call(callableId: string) {
        if (callableId === "legacy.envelope") {
          return { status: "ok", value: { secret } };
        }
        return Result.err({
          kind: "internal",
          code: "",
          message: "Missing failure code",
          retryable: false,
          details: { secret },
        });
      },
    } as unknown as ServerTool;
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "malformed-result-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
      reportFatalToolCallDefect: (defect) => reported.push(defect),
    });
    await server.init();
    try {
      for (const callableId of ["legacy.envelope", "legacy.empty-code"]) {
        const response = await server.app.handle(
          new Request("http://localhost/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ callableId, input: {} }),
          }),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
          status: "error",
          error: {
            kind: "internal",
            code: "plugin_call_failed",
            message: "Internal tool server failure",
            retryable: false,
          },
        });
        expect(JSON.stringify(body)).not.toContain(secret);
      }
      expect(reported).toEqual([]);
      expect(chunks.join("\n")).not.toContain(secret);
    } finally {
      await server.stop();
    }
  });

  it("redacts nested sensitive JSON fields before ordinary tool-input logging", async () => {
    const chunks: string[] = [];
    const secret = "ordinary-tool-secret";
    const tool: ServerTool = {
      id: "preview-redaction",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "preview.redaction",
            name: "Preview redaction",
            description: "Tests input logging",
            shortInput: [],
          },
        ];
      },
      async call() {
        return Result.ok({ ok: true });
      },
    };
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "tool-preview-redaction-test",
        logLevel: "debug",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "preview.redaction",
            input: { nested: { authorization: secret }, visible: "retained" },
          }),
        }),
      );
      expect(await response.json()).toEqual({ status: "ok", value: { ok: true } });
      const logged = chunks.join("\n");
      expect(logged).toContain("<redacted>");
      expect(logged).toContain("retained");
      expect(logged).not.toContain(secret);
    } finally {
      await server.stop();
    }
  });

  it("projects opaque unhandled rejections without serializing TaggedError fields", async () => {
    class SecretUnhandledRejection extends TaggedError("SecretUnhandledRejection")<{
      readonly token: string;
      readonly message: string;
    }> {}
    const secret = "unhandled-rejection-secret";
    const server = createToolServer({ tools: [] });
    await server.init();
    try {
      server.recordUnhandledRejection(
        new SecretUnhandledRejection({ token: secret, message: `token=${secret}` }),
      );
      const snapshot = await server.getHealthSnapshot();
      expect(snapshot.info.unhandledRejection).toMatchObject({
        count: 1,
        lastReason: "External tagged error",
      });
      expect(JSON.stringify(snapshot.info.unhandledRejection)).not.toContain(secret);
    } finally {
      await server.stop();
    }
  });

  it("uses the same request capability and native profile context for direct and workflow children", async () => {
    const contexts: RequestContext[] = [];
    const authority = new RequestControlAuthority();
    const capabilities = new Map<string, string>();
    for (const requestId of ["sub:direct", "wfr:workflow"] as const) {
      const workflowChild = requestId === "wfr:workflow";
      capabilities.set(
        requestId,
        authority.issue({
          kind: "primary",
          requestId,
          sessionId: workflowChild ? "workflow-child-session" : "origin-session",
          platform: workflowChild ? "unknown" : "discord",
          principal: { platform: "discord", userId: "user-1" },
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-1",
            sessionRef: { platform: "discord", channelId: "origin-session" },
          },
          allowedCallables: null,
          profile: "general",
          canonicalCwd: "/selected/child/cwd",
          safetyMode: "trusted",
          expiresAt: Date.now() + 60_000,
        }),
      );
    }
    const tool: ServerTool = {
      id: "native-child-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.test",
            name: "Workflow Test",
            description: "ordinary native-profile callable",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) =>
          requestId === "wfr:workflow"
            ? {
                requestId,
                requestClient: "unknown",
                sessionId: "workflow-child-session",
                source: "internal-delegated",
                authenticatedOrigin: {
                  platform: "discord",
                  userId: "user-1",
                  sessionRef: { platform: "discord", channelId: "origin-session" },
                },
                authenticationMetadataKind: "origin",
                verifiedIngress: false,
              }
            : discordRequestProjection({
                requestId,
                sessionId: "origin-session",
                userId: "user-1",
              }),
      },
      authorizeControlRequest: (input) => authority.authorize(input),
    });
    await server.init();
    try {
      for (const requestId of ["sub:direct", "wfr:workflow"] as const) {
        const capability = capabilities.get(requestId);
        if (!capability) throw new Error(`missing test capability for ${requestId}`);
        const workflowChild = requestId === "wfr:workflow";
        const headers = {
          "x-lilac-request-id": requestId,
          "x-lilac-session-id": workflowChild ? "workflow-child-session" : "origin-session",
          "x-lilac-request-client": workflowChild ? "unknown" : "discord",
          "x-lilac-cwd": "/selected/child/cwd",
          "x-lilac-control-capability": capability,
          "x-lilac-current-turn-user-id": "user-2",
        };
        const list = await server.app.handle(new Request("http://localhost/list", { headers }));
        expect(await list.json()).toMatchObject({ tools: [{ callableId: "workflow.test" }] });
        expect(
          (await server.app.handle(new Request("http://localhost/help/workflow.test", { headers })))
            .status,
        ).toBe(200);
        const call = await server.app.handle(
          new Request("http://localhost/call", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ callableId: "workflow.test", input: {} }),
          }),
        );
        expect(await call.json()).toMatchObject({ status: "ok", value: { ok: true } });
      }
      expect(
        contexts.map(
          ({
            cwd,
            subagentProfile,
            controlPolicy,
            requestInitiator,
            requestInitiatorSessionId,
            currentTurnUserId,
            safetyMode,
          }) => ({
            cwd,
            subagentProfile,
            controlPolicy,
            requestInitiator,
            requestInitiatorSessionId,
            currentTurnUserId,
            safetyMode,
          }),
        ),
      ).toEqual([
        {
          cwd: "/selected/child/cwd",
          subagentProfile: "general",
          controlPolicy: { kind: "primary", allowedCallables: null },
          requestInitiator: { platform: "discord", userId: "user-1" },
          requestInitiatorSessionId: "origin-session",
          currentTurnUserId: "user-2",
          safetyMode: "trusted",
        },
        {
          cwd: "/selected/child/cwd",
          subagentProfile: "general",
          controlPolicy: { kind: "primary", allowedCallables: null },
          requestInitiator: { platform: "discord", userId: "user-1" },
          requestInitiatorSessionId: "origin-session",
          currentTurnUserId: "user-2",
          safetyMode: "trusted",
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("enforces the capability-bound native profile without trusting the profile header", async () => {
    const authority = new RequestControlAuthority();
    const capability = authority.issue({
      kind: "primary",
      requestId: "native-profile-capability",
      sessionId: "native-profile-session",
      platform: "discord",
      principal: null,
      authenticatedOrigin: null,
      allowedCallables: null,
      profile: "general",
      canonicalCwd: "/workspace",
      safetyMode: "trusted",
      expiresAt: Date.now() + 60_000,
    });
    const calls: string[] = [];
    const tool: ServerTool = {
      id: "profile-plugin",
      async init() {},
      async destroy() {},
      async list() {
        return ["profile.allowed", "profile.denied"].map((callableId) => ({
          callableId,
          name: callableId,
          description: callableId,
          shortInput: [],
        }));
      },
      async call(callableId) {
        calls.push(callableId);
        return Result.ok({ callableId });
      },
    };
    const pluginManager = {
      async init() {
        return Result.ok();
      },
      async destroy() {
        return Result.ok();
      },
      async reload() {
        return Result.ok();
      },
      async ensureFresh() {
        return Result.ok();
      },
      getLevel2Tools: () => [tool],
      getLevel2ContributionInfo: () =>
        new Map([[tool, { pluginId: "profile-plugin", source: "builtin" as const }]]),
    };
    const config = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      agent: {
        subagents: {
          profiles: {
            general: {
              level2: {
                callables: ["profile.allowed"],
                plugins: ["profile-plugin"],
              },
            },
          },
        },
      },
    });
    const server = createToolServer({
      pluginManager,
      getConfig: async () => config,
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) =>
          discordRequestProjection({ requestId, sessionId: "native-profile-session" }),
      },
      authorizeControlRequest: (input) => authority.authorize(input),
    });
    await server.init();
    const headers = {
      "x-lilac-request-id": "native-profile-capability",
      "x-lilac-session-id": "native-profile-session",
      "x-lilac-request-client": "discord",
      "x-lilac-cwd": "/workspace",
      "x-lilac-control-capability": capability,
    };
    try {
      const list = await server.app.handle(new Request("http://localhost/list", { headers }));
      expect(await list.json()).toMatchObject({
        tools: [{ callableId: "profile.allowed" }],
      });

      const denied = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "x-lilac-subagent-profile": "self",
          },
          body: JSON.stringify({ callableId: "profile.denied", input: {} }),
        }),
      );
      expect(await denied.json()).toEqual({
        status: "error",
        error: {
          kind: "denied",
          code: "profile_denied",
          message: "Tool 'profile.denied' is not enabled for this subagent profile",
          retryable: false,
        },
      });
      expect(calls).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("requires a request-bound control capability on list, help, and call", async () => {
    const contexts: RequestContext[] = [];
    const tool: ServerTool = {
      id: "control-test",
      async init() {},
      async destroy() {},
      async list() {
        return [{ callableId: "control.read", name: "read", description: "read", shortInput: [] }];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({
      tools: [tool],
      canonicalWorkspaceRoot: "/workspace",
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) =>
          discordRequestProjection({ requestId, sessionId: "channel-1", userId: "user-1" }),
      },
      authorizeControlRequest: (input) =>
        input.token === "unguessable-primary-token" &&
        input.requestId === "request-1" &&
        input.sessionId === "channel-1" &&
        input.platform === "discord"
          ? {
              kind: "primary" as const,
              principal: { platform: "discord" as const, userId: "user-1" },
              authenticatedOrigin: {
                platform: "discord" as const,
                userId: "user-1",
                sessionRef: { platform: "discord" as const, channelId: "channel-1" },
              },
              allowedCallables: null,
              profile: "primary" as const,
              canonicalCwd: "/workspace",
              safetyMode: "trusted" as const,
            }
          : null,
    });
    await server.init();
    const headers = {
      "x-lilac-request-id": "request-1",
      "x-lilac-session-id": "channel-1",
      "x-lilac-request-client": "discord",
      "x-lilac-cwd": "/attacker-controlled",
      "x-lilac-control-capability": "unguessable-primary-token",
    };
    try {
      expect((await server.app.handle(new Request("http://localhost/list"))).status).toBe(500);
      expect(
        (await server.app.handle(new Request("http://localhost/list", { headers }))).status,
      ).toBe(200);
      expect(
        (await server.app.handle(new Request("http://localhost/help/control.read", { headers })))
          .status,
      ).toBe(200);
      expect(
        await (
          await server.app.handle(
            new Request("http://localhost/call", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ callableId: "control.read", input: {} }),
            }),
          )
        ).json(),
      ).toMatchObject({ status: "ok", value: { ok: true } });
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.cwd).toBe("/workspace");
      expect(contexts[0] && requestInvocationCwd(contexts[0])).toBe("/attacker-controlled");
      expect(
        (
          await server.app.handle(
            new Request("http://localhost/list", {
              headers: { ...headers, "x-lilac-session-id": "other-channel" },
            }),
          )
        ).status,
      ).toBe(500);
    } finally {
      await server.stop();
    }
  });

  it("rejects a control capability whose principal conflicts with the cached origin", async () => {
    const server = createToolServer({
      tools: [],
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) => ({
          requestId,
          requestClient: "discord",
          sessionId: "channel-1",
          source: "external",
          platform: "discord",
          sessionRef: { platform: "discord", channelId: "channel-1" },
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-1",
            sessionRef: { platform: "discord", channelId: "channel-1" },
          },
          authenticationMetadataKind: "origin",
          verifiedIngress: true,
        }),
      },
      authorizeControlRequest: () => ({
        kind: "primary",
        principal: { platform: "discord", userId: "user-2" },
        authenticatedOrigin: {
          platform: "discord",
          userId: "user-2",
          sessionRef: { platform: "discord", channelId: "channel-1" },
        },
        allowedCallables: null,
        profile: "primary",
        canonicalCwd: "/workspace",
        safetyMode: "trusted",
      }),
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/list", {
          headers: {
            "x-lilac-request-id": "request-1",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
            "x-lilac-cwd": "/workspace",
            "x-lilac-control-capability": "capability",
          },
        }),
      );
      expect(response.status).toBe(500);
    } finally {
      await server.stop();
    }
  });

  it("rejects primary capabilities after their cached projection is missing or expired", async () => {
    const authority = new RequestControlAuthority();
    const capability = authority.issue({
      kind: "primary",
      requestId: "expired-cache-request",
      sessionId: "channel-1",
      platform: "discord",
      principal: { platform: "discord", userId: "user-1" },
      authenticatedOrigin: {
        platform: "discord",
        userId: "user-1",
        sessionRef: { platform: "discord", channelId: "channel-1" },
      },
      allowedCallables: null,
      profile: "primary",
      canonicalCwd: "/workspace",
      safetyMode: "trusted",
      expiresAt: Date.now() + 60_000,
    });
    const server = createToolServer({
      tools: [],
      requestMessageCache: { get: () => undefined, getOrigin: () => undefined },
      authorizeControlRequest: (input) => authority.authorize(input),
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/list", {
          headers: {
            "x-lilac-request-id": "expired-cache-request",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
            "x-lilac-cwd": "/workspace",
            "x-lilac-control-capability": capability,
          },
        }),
      );
      expect(response.status).toBe(500);
    } finally {
      await server.stop();
    }
  });

  it("keeps standalone non-operator requests restricted", async () => {
    const tool: ServerTool = {
      id: "standalone-restricted",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.standalone-restricted",
            name: "restricted",
            description: "restricted",
            shortInput: [],
          },
        ];
      },
      async call() {
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServerImpl({ tools: [tool] });
    await server.init();
    try {
      const listed = await server.app.handle(new Request("http://localhost/list"));
      expect(await listed.json()).toEqual({ tools: [] });
      const called = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "workflow.standalone-restricted", input: {} }),
        }),
      );
      expect(await called.json()).toMatchObject({
        status: "error",
        error: {
          kind: "denied",
          code: "restricted_mode_denied",
          message: expect.stringContaining("restricted public-session mode"),
          retryable: false,
        },
      });
    } finally {
      await server.stop();
    }
  });

  it("applies verified GitHub and validated Discord safety precedence without inventing principals", async () => {
    const contexts: RequestContext[] = [];
    let discordPolicyCalls = 0;
    const tool: ServerTool = {
      id: "safety-precedence",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.safety-precedence",
            name: "safety",
            description: "safety",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) => {
          const github = requestId === "github-request";
          if (github) {
            return {
              requestId,
              requestClient: "github",
              sessionId: "owner/repo#1",
              source: "external",
              platform: "github",
              sessionRef: { platform: "github", channelId: "owner/repo#1" },
              authenticationMetadataKind: "github-trigger",
              verifiedIngress: true,
            };
          }
          return {
            requestId,
            requestClient: "discord",
            sessionId: "channel-1",
            source: "external",
            platform: "discord",
            sessionRef: { platform: "discord", channelId: "channel-1" },
            authenticationMetadataKind: "origin",
            verifiedIngress: true,
          };
        },
      },
      resolveServerSafetyMode: async () => {
        discordPolicyCalls += 1;
        return "trusted";
      },
    });
    await server.init();
    try {
      for (const [requestId, sessionId, requestClient] of [
        ["github-request", "owner/repo#1", "github"],
        ["discord-request", "channel-1", "discord"],
      ] as const) {
        const response = await server.app.handle(
          new Request("http://localhost/call", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-lilac-request-id": requestId,
              "x-lilac-session-id": sessionId,
              "x-lilac-request-client": requestClient,
            },
            body: JSON.stringify({ callableId: "workflow.safety-precedence", input: {} }),
          }),
        );
        expect(await response.json()).toMatchObject({ status: "ok" });
      }
      expect(discordPolicyCalls).toBe(1);
      expect(contexts.map((context) => context.requestInitiator)).toEqual([undefined, undefined]);
    } finally {
      await server.stop();
    }
  });

  it("keeps actor-only GitHub principals restricted without verified trigger metadata", async () => {
    const contexts: RequestContext[] = [];
    const tool: ServerTool = {
      id: "github-actor-only",
      async init() {},
      async destroy() {},
      async list() {
        return [{ callableId: "fetch", name: "fetch", description: "fetch", shortInput: [] }];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) => ({
          requestId,
          requestClient: "github",
          sessionId: "owner/repo#1",
          source: "external",
          platform: "github",
          sessionRef: { platform: "github", channelId: "owner/repo#1" },
          authenticatedOrigin: {
            platform: "github",
            userId: "octocat",
            sessionRef: { platform: "github", channelId: "owner/repo#1" },
          },
          authenticationMetadataKind: "actor",
          verifiedIngress: false,
        }),
      },
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lilac-request-id": "github-actor-only",
            "x-lilac-session-id": "owner/repo#1",
            "x-lilac-request-client": "github",
          },
          body: JSON.stringify({ callableId: "fetch", input: {} }),
        }),
      );
      expect(await response.json()).toMatchObject({ status: "ok" });
      expect(contexts[0]).toMatchObject({
        safetyMode: "restricted",
        serverOwnedRequest: false,
        requestInitiator: { platform: "github", userId: "octocat" },
        requestInitiatorSessionId: "owner/repo#1",
      });
    } finally {
      await server.stop();
    }
  });

  it("grants full trusted access only to the hashed operator token", async () => {
    const token = "operator-token-for-focused-test";
    const contexts: RequestContext[] = [];
    const tool: ServerTool = {
      id: "operator-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.operator-test",
            name: "operator test",
            description: "operator test",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({
      tools: [tool],
      canonicalWorkspaceRoot: "/canonical-workspace",
      operatorTokenSha256: createHash("sha256").update(token).digest("hex"),
      authorizeControlRequest: () => null,
      resolveServerSafetyMode: async () => "restricted",
    });
    await server.init();
    const headers = {
      "x-lilac-operator-token": token,
      "x-lilac-request-id": "operator:request-1",
      "x-lilac-tool-call-id": "operator:request-1",
    };
    try {
      expect(
        (
          await server.app.handle(
            new Request("http://localhost/list", {
              headers: { "x-lilac-operator-token": "wrong-token" },
            }),
          )
        ).status,
      ).toBe(500);
      expect(
        await (await server.app.handle(new Request("http://localhost/list", { headers }))).json(),
      ).toMatchObject({ tools: [{ callableId: "workflow.operator-test" }] });
      expect(
        (
          await server.app.handle(
            new Request("http://localhost/help/workflow.operator-test", { headers }),
          )
        ).status,
      ).toBe(200);
      expect(
        await (
          await server.app.handle(
            new Request("http://localhost/call", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ callableId: "workflow.operator-test", input: {} }),
            }),
          )
        ).json(),
      ).toMatchObject({ status: "ok", value: { ok: true } });
      expect(
        await (
          await server.app.handle(
            new Request("http://localhost/call", {
              method: "POST",
              headers: {
                ...headers,
                "content-type": "application/json",
                "x-lilac-cwd": "/operator-selected-project",
              },
              body: JSON.stringify({ callableId: "workflow.operator-test", input: {} }),
            }),
          )
        ).json(),
      ).toMatchObject({ status: "ok", value: { ok: true } });
      expect(contexts).toEqual([
        {
          requestId: "operator:request-1",
          toolCallId: "operator:request-1",
          cwd: "/canonical-workspace",
          safetyMode: "trusted",
          serverOwnedRequest: true,
          operator: true,
        },
        {
          requestId: "operator:request-1",
          toolCallId: "operator:request-1",
          cwd: "/canonical-workspace",
          safetyMode: "trusted",
          serverOwnedRequest: true,
          operator: true,
        },
      ]);
      expect(contexts.map(requestInvocationCwd)).toEqual([undefined, "/operator-selected-project"]);
    } finally {
      await server.stop();
    }
  });

  it("limits heartbeat authority to its internal callable allowlist", async () => {
    const called: string[] = [];
    const tool: ServerTool = {
      id: "heartbeat-capability-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "surface.messages.send",
            name: "send",
            description: "send",
            shortInput: [],
          },
          { callableId: "workflow.start", name: "start", description: "start", shortInput: [] },
          { callableId: "read_file", name: "read", description: "read", shortInput: [] },
        ];
      },
      async call(callableId, _input, options) {
        called.push(callableId);
        expect(options?.context?.cwd).toBe("/canonical-workspace");
        expect(options?.context?.requestInitiator).toBeUndefined();
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: () => undefined,
        getOrigin: () => undefined,
      },
      authorizeControlRequest: ({ token }) =>
        token === "heartbeat-capability-token"
          ? {
              kind: "heartbeat" as const,
              principal: null,
              authenticatedOrigin: null,
              allowedCallables: ["surface.messages.send"],
              profile: "primary" as const,
              canonicalCwd: "/canonical-workspace",
              safetyMode: "trusted" as const,
            }
          : null,
    });
    await server.init();
    const headers = {
      "x-lilac-request-id": "heartbeat:request-1",
      "x-lilac-session-id": "heartbeat:discord:channel-1",
      "x-lilac-request-client": "discord",
      "x-lilac-cwd": "/stale-cache-workspace",
      "x-lilac-safety-mode": "restricted",
      "x-lilac-control-capability": "heartbeat-capability-token",
    };
    try {
      const list = await server.app.handle(new Request("http://localhost/list", { headers }));
      expect(await list.json()).toMatchObject({
        tools: [{ callableId: "surface.messages.send" }],
      });

      const deniedHelp = await server.app.handle(
        new Request("http://localhost/help/workflow.start", { headers }),
      );
      expect(deniedHelp.status).toBe(404);

      const deniedCall = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ callableId: "read_file", input: { path: "README.md" } }),
        }),
      );
      expect(await deniedCall.json()).toMatchObject({
        status: "error",
        error: {
          kind: "denied",
          code: "capability_denied",
          message: expect.stringContaining("outside the internal request capability"),
          retryable: false,
        },
      });

      const deniedAttachment = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "surface.messages.send",
            input: { content: "due", paths: ["secret.txt"] },
          }),
        }),
      );
      expect(await deniedAttachment.json()).toMatchObject({
        status: "error",
        error: {
          kind: "denied",
          code: "heartbeat_attachments_denied",
          message: expect.stringContaining("text-only"),
          retryable: false,
        },
      });

      const allowedCall = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ callableId: "surface.messages.send", input: { content: "due" } }),
        }),
      );
      expect(await allowedCall.json()).toMatchObject({ status: "ok", value: { ok: true } });
      expect(called).toEqual(["surface.messages.send"]);
    } finally {
      await server.stop();
    }
  });

  let tmpRoot: string | null = null;

  afterEach(async () => {
    process.memoryUsage = originalMemoryUsage;
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("passes x-lilac request context and cached messages to tool.call", async () => {
    const seenCalls: Array<{
      callableId: string;
      input: Record<string, unknown>;
      requestId?: string;
      requestDeliveryId?: string;
      sessionId?: string;
      requestClient?: string;
      cwd?: string;
      messages?: readonly unknown[];
      serverOwnedRequest?: boolean;
    }> = [];

    const tool: ServerTool = {
      id: "test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "test.echo",
            name: "Test Echo",
            description: "echo",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call(callableId, input, opts) {
        seenCalls.push({
          callableId,
          input,
          requestId: opts?.context?.requestId,
          requestDeliveryId: opts?.context?.requestDeliveryId,
          sessionId: opts?.context?.sessionId,
          requestClient: opts?.context?.requestClient,
          cwd: opts?.context?.cwd,
          messages: opts?.messages,
          serverOwnedRequest: opts?.context?.serverOwnedRequest,
        });
        return Result.ok({ ok: true, echo: input });
      },
    };

    const cachedMessages = [{ role: "user", content: "cached" }];
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get(requestId: string) {
          return requestId === "req:1" ? cachedMessages : undefined;
        },
        getOrigin: (requestId) =>
          requestId === "req:1"
            ? {
                requestId,
                requestClient: "discord",
                sessionId: "chan",
                source: "external",
                platform: "discord",
                sessionRef: { platform: "discord", channelId: "chan" },
                authenticatedOrigin: {
                  platform: "discord",
                  userId: "user-1",
                  sessionRef: { platform: "discord", channelId: "chan" },
                },
                authenticationMetadataKind: "origin",
                verifiedIngress: true,
              }
            : undefined,
      },
      resolveServerSafetyMode: async () => "trusted",
    });

    await server.init();

    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lilac-request-id": "req:1",
          "x-lilac-request-delivery-id": "delivery-1",
          "x-lilac-session-id": "chan",
          "x-lilac-request-client": "discord",
          "x-lilac-cwd": "/tmp/work",
        },
        body: JSON.stringify({
          callableId: "test.echo",
          input: { hello: "world" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok", value: { ok: true, echo: { hello: "world" } } });

    const captured = seenCalls[0]!;
    expect(captured.callableId).toBe("test.echo");
    expect(captured.input).toEqual({ hello: "world" });
    expect(captured.requestId).toBe("req:1");
    expect(captured.requestDeliveryId).toBe("delivery-1");
    expect(captured.sessionId).toBe("chan");
    expect(captured.requestClient).toBe("discord");
    expect(captured.cwd).toBe("/tmp/work");
    expect(captured.messages).toEqual(cachedMessages);
    expect(captured.serverOwnedRequest).toBe(true);
  });

  it("includes primary positional metadata in list and help responses", async () => {
    const tool: ServerTool = {
      id: "test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "fetch",
            name: "Fetch",
            description: "Fetch a web page",
            shortInput: ["--url=<string>"],
            input: ["--url=<string>"],
            primaryPositional: {
              field: "url",
              variadic: true,
            },
          },
        ];
      },
      async call() {
        return Result.ok({ ok: true });
      },
    };

    const server = createToolServer({
      tools: [tool],
    });

    await server.init();

    const listRes = await server.app.handle(new Request("http://localhost/list"));
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({
      tools: [
        {
          callableId: "fetch",
          name: "Fetch",
          description: "Fetch a web page",
          shortInput: ["--url=<string>"],
          primaryPositional: {
            field: "url",
            variadic: true,
          },
          hidden: undefined,
        },
      ],
    });

    const helpRes = await server.app.handle(new Request("http://localhost/help/fetch"));
    expect(helpRes.status).toBe(200);
    expect(await helpRes.json()).toEqual({
      callableId: "fetch",
      name: "Fetch",
      description: "Fetch a web page",
      shortInput: ["--url=<string>"],
      input: ["--url=<string>"],
      primaryPositional: {
        field: "url",
        variadic: true,
      },
    });

    await server.stop();
  });

  it("filters and rejects restricted public-session callables", async () => {
    const calls: string[] = [];
    const tool: ServerTool = {
      id: "test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "attachment.add_files",
            name: "Attachment Add Files",
            description: "Attachment add files",
            shortInput: [],
            input: [],
          },
          {
            callableId: "attachment.download",
            name: "Attachment Download",
            description: "Attachment download",
            shortInput: [],
            input: [],
          },
          {
            callableId: "discovery.search",
            name: "Discovery Search",
            description: "Discovery search",
            shortInput: [],
            input: [],
          },
          {
            callableId: "fetch",
            name: "Fetch",
            description: "Fetch a web page",
            shortInput: [],
            input: [],
          },
          {
            callableId: "generate.image",
            name: "Generate Image",
            description: "Generate image",
            shortInput: [],
            input: [],
          },
          {
            callableId: "generate.video",
            name: "Generate Video",
            description: "Generate video",
            shortInput: [],
            input: [],
          },
          {
            callableId: "onboarding.restart",
            name: "Restart",
            description: "Restart",
            shortInput: [],
            input: [],
          },
          {
            callableId: "surface.messages.delete",
            name: "Delete",
            description: "Delete",
            shortInput: [],
            input: [],
          },
          {
            callableId: "surface.messages.edit",
            name: "Edit",
            description: "Edit",
            shortInput: [],
            input: [],
          },
          {
            callableId: "surface.messages.send",
            name: "Send",
            description: "Send",
            shortInput: [],
            input: [],
          },
          {
            callableId: "surface.reactions.remove",
            name: "Remove Reaction",
            description: "Remove reaction",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call(callableId) {
        calls.push(callableId);
        return Result.ok({ ok: true, callableId });
      },
    };

    const server = createToolServer({
      tools: [tool],
    });

    await server.init();

    const restrictedHeaders = {
      "x-lilac-safety-mode": "restricted",
      "x-lilac-session-id": "chan",
      "x-lilac-request-id": "req:1",
      "x-lilac-request-client": "discord",
    };

    const listRes = await server.app.handle(
      new Request("http://localhost/list", {
        headers: restrictedHeaders,
      }),
    );
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({
      tools: [
        {
          callableId: "attachment.add_files",
          name: "Attachment Add Files",
          description: "Attachment add files",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "attachment.download",
          name: "Attachment Download",
          description: "Attachment download",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "discovery.search",
          name: "Discovery Search",
          description: "Discovery search",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "fetch",
          name: "Fetch",
          description: "Fetch a web page",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "generate.image",
          name: "Generate Image",
          description: "Generate image",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "generate.video",
          name: "Generate Video",
          description: "Generate video",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "surface.messages.delete",
          name: "Delete",
          description: "Delete",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "surface.messages.edit",
          name: "Edit",
          description: "Edit",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "surface.messages.send",
          name: "Send",
          description: "Send",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "surface.reactions.remove",
          name: "Remove Reaction",
          description: "Remove reaction",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
      ],
    });

    const blockedRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "onboarding.restart", input: {} }),
      }),
    );
    expect(blockedRes.status).toBe(200);
    expect(await blockedRes.json()).toEqual({
      status: "error",
      error: {
        kind: "denied",
        code: "restricted_mode_denied",
        message: "Tool 'onboarding.restart' is not allowed in restricted public-session mode",
        retryable: false,
      },
    });

    const crossSessionRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "surface.messages.send",
          input: { sessionId: "other", text: "hi" },
        }),
      }),
    );
    expect(crossSessionRes.status).toBe(200);
    expect(await crossSessionRes.json()).toEqual({
      status: "error",
      error: {
        kind: "denied",
        code: "restricted_mode_denied",
        message: "Tool 'surface.messages.send' is not allowed in restricted public-session mode",
        retryable: false,
      },
    });

    const crossSessionEditRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "surface.messages.edit",
          input: { sessionId: "other", messageId: "m1", text: "hi" },
        }),
      }),
    );
    expect(crossSessionEditRes.status).toBe(200);
    expect(await crossSessionEditRes.json()).toEqual({
      status: "error",
      error: {
        kind: "denied",
        code: "restricted_mode_denied",
        message: "Tool 'surface.messages.edit' is not allowed in restricted public-session mode",
        retryable: false,
      },
    });

    const allowedRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "fetch", input: { url: "https://example.com" } }),
      }),
    );
    expect(allowedRes.status).toBe(200);
    expect(await allowedRes.json()).toEqual({
      status: "ok",
      value: { ok: true, callableId: "fetch" },
    });
    const discoveryRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "discovery.search", input: { query: "context" } }),
      }),
    );
    expect(discoveryRes.status).toBe(200);
    expect(await discoveryRes.json()).toEqual({
      status: "ok",
      value: { ok: true, callableId: "discovery.search" },
    });

    expect(calls).toEqual(["fetch", "discovery.search"]);

    await server.stop();
  });

  it("fails closed when server-side safety lookup fails for a privileged workflow call", async () => {
    let called = false;
    const tool: ServerTool = {
      id: "workflow-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.test",
            name: "Workflow Test",
            description: "privileged",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call() {
        called = true;
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: (requestId) =>
          requestId === "request-1" ? [{ role: "user", content: "run workflow" }] : undefined,
        getOrigin: (requestId) =>
          requestId === "request-1"
            ? {
                requestId,
                requestClient: "discord",
                sessionId: "channel-1",
                source: "external",
                platform: "discord",
                sessionRef: { platform: "discord", channelId: "channel-1" },
                authenticatedOrigin: {
                  platform: "discord",
                  userId: "user-1",
                  sessionRef: { platform: "discord", channelId: "channel-1" },
                },
                authenticationMetadataKind: "origin",
                verifiedIngress: true,
              }
            : undefined,
      },
      getConfig: async () => {
        throw new Error("configuration unavailable");
      },
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lilac-request-id": "request-1",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
          },
          body: JSON.stringify({ callableId: "workflow.test", input: {} }),
        }),
      );
      expect(await response.json()).toEqual({
        status: "error",
        error: {
          kind: "denied",
          code: "restricted_mode_denied",
          message: "Tool 'workflow.test' is not allowed in restricted public-session mode",
          retryable: false,
        },
      });
      expect(called).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("supports plugin-backed list/call/reload flows", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-plugin-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePluginServerTool({
      dataDir,
      pluginId: "echo-plugin",
      callableId: "echo.call",
      value: "one",
    });

    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir,
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (tool) => tool,
    });

    const server = createToolServer({
      pluginManager,
    });

    await server.init();

    const firstList = await server.app.handle(new Request("http://localhost/list"));
    expect(firstList.status).toBe(200);
    expect(await firstList.json()).toEqual({
      tools: [
        {
          callableId: "echo.call",
          name: "echo.call",
          description: "echo.call",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const firstCall = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "echo.call", input: {} }),
      }),
    );
    expect(await firstCall.json()).toEqual({ status: "ok", value: { value: "one" } });

    // test-wait-justification: advances filesystem mtime so explicit reload observes the rewritten plugin bundle
    await Bun.sleep(5);
    await writePluginServerTool({
      dataDir,
      pluginId: "echo-plugin",
      callableId: "echo.call.v2",
      value: "two",
    });

    const reload = await server.app.handle(
      new Request("http://localhost/reload", {
        method: "POST",
      }),
    );
    expect(await reload.json()).toEqual({ ok: true });

    const secondList = await server.app.handle(new Request("http://localhost/list"));
    expect(await secondList.json()).toEqual({
      tools: [
        {
          callableId: "echo.call.v2",
          name: "echo.call.v2",
          description: "echo.call.v2",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const secondCall = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "echo.call.v2", input: {} }),
      }),
    );
    expect(await secondCall.json()).toEqual({ status: "ok", value: { value: "two" } });

    await server.stop();
  });

  it("reads initialization-dependent catalogs and caches them until reload", async () => {
    let listCalls = 0;
    let initialized = false;
    let callableId = "dynamic.call.v1";
    const tool: ServerTool = {
      id: "stateful-list",
      async init() {
        initialized = true;
      },
      async destroy() {},
      async list() {
        if (!initialized) throw new Error("list called before init");
        listCalls += 1;
        return [{ callableId, name: callableId, description: callableId, shortInput: [] }];
      },
      async call(callableId) {
        return Result.ok({ callableId });
      },
    };
    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir: "/tmp/tool-server-stateful-list-unused",
      builtinPlugins: [{ meta: { id: "stateful-list" }, create: () => ({ level2: [tool] }) }],
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (item) => item,
    });
    const server = createToolServer({ pluginManager });

    await server.init();
    expect(listCalls).toBe(2);
    callableId = "dynamic.call.v2";
    const cached = await server.app.handle(new Request("http://localhost/list"));
    expect(await cached.json()).toMatchObject({ tools: [{ callableId: "dynamic.call.v1" }] });
    expect(
      (await server.app.handle(new Request("http://localhost/help/dynamic.call.v2"))).status,
    ).toBe(404);

    await server.reload();
    const listed = await server.app.handle(new Request("http://localhost/list"));
    expect(await listed.json()).toMatchObject({ tools: [{ callableId: "dynamic.call.v2" }] });
    expect(
      (await server.app.handle(new Request("http://localhost/help/dynamic.call.v2"))).status,
    ).toBe(200);
    const called = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "dynamic.call.v2", input: {} }),
      }),
    );
    expect(await called.json()).toEqual({
      status: "ok",
      value: { callableId: "dynamic.call.v2" },
    });
    expect(listCalls).toBe(4);
    await server.stop();
  });

  it("drains active tool calls before swapping plugin generations", async () => {
    const firstCallStarted = Promise.withResolvers<void>();
    const releaseFirstCall = Promise.withResolvers<void>();
    const callGenerations: number[] = [];
    let generation = 0;
    let firstCallActive = false;
    let destroyedWhileActive = false;
    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir: "/tmp/tool-server-generation-lease-unused",
      builtinPlugins: [
        {
          meta: { id: "generation-lease" },
          create() {
            generation++;
            const current = generation;
            return {
              level2: [
                {
                  id: `generation-${current}`,
                  async init() {},
                  async destroy() {
                    if (current === 1 && firstCallActive) destroyedWhileActive = true;
                  },
                  async list() {
                    return [
                      {
                        callableId: "generation.call",
                        name: "generation.call",
                        description: "generation.call",
                        shortInput: [],
                      },
                    ];
                  },
                  async call() {
                    callGenerations.push(current);
                    if (current === 1) {
                      firstCallActive = true;
                      firstCallStarted.resolve();
                      await releaseFirstCall.promise;
                      firstCallActive = false;
                    }
                    return Result.ok({ generation: current });
                  },
                } satisfies ServerTool,
              ],
            };
          },
        },
      ],
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (item) => item,
    });
    const server = createToolServer({ pluginManager });
    const call = () =>
      server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "generation.call", input: {} }),
        }),
      );

    await server.init();
    const firstResponse = call();
    await firstCallStarted.promise;

    const reload = server.reload();
    const secondResponse = call();
    await Promise.resolve();
    expect(callGenerations).toEqual([1]);
    expect(destroyedWhileActive).toBe(false);

    releaseFirstCall.resolve();
    expect(await (await firstResponse).json()).toEqual({ status: "ok", value: { generation: 1 } });
    await reload;
    expect(await (await secondResponse).json()).toEqual({ status: "ok", value: { generation: 2 } });
    expect(callGenerations).toEqual([1, 2]);
    expect(destroyedWhileActive).toBe(false);
    await server.stop();
  });

  it("reloads onboarding tools after the initiating call releases its generation", async () => {
    const callGenerations: number[] = [];
    const destroyedGenerations: number[] = [];
    let generation = 0;
    let activeGeneration: number | null = null;
    let destroyedWhileActive = false;
    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir: "/tmp/tool-server-onboarding-reload-unused",
      builtinPlugins: [
        {
          meta: { id: "onboarding" },
          create() {
            generation++;
            const current = generation;
            return {
              level2: [
                {
                  id: "onboarding",
                  async init() {},
                  async destroy() {
                    destroyedGenerations.push(current);
                    if (activeGeneration === current) destroyedWhileActive = true;
                  },
                  async list() {
                    return [
                      {
                        callableId: "onboarding.reload_tools",
                        name: "onboarding.reload_tools",
                        description: "onboarding.reload_tools",
                        shortInput: [],
                      },
                    ];
                  },
                  async call() {
                    activeGeneration = current;
                    callGenerations.push(current);
                    await Promise.resolve();
                    activeGeneration = null;
                    return Result.ok({ ok: true });
                  },
                } satisfies ServerTool,
              ],
            };
          },
        },
      ],
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (item) => item,
    });
    const server = createToolServer({ pluginManager });

    await server.init();
    const runGeneration = pluginManager.acquireGeneration();
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "onboarding.reload_tools", input: {} }),
      }),
    );

    expect(await response.json()).toEqual({ status: "ok", value: { ok: true } });
    expect(callGenerations).toEqual([1]);
    expect(generation).toBe(2);
    expect(destroyedWhileActive).toBe(false);
    expect(destroyedGenerations).toEqual([]);
    expect((await runGeneration.release()).status).toBe("ok");
    expect(destroyedGenerations).toEqual([1]);
    await server.stop();
  });

  it("refreshes routing after a committed reload whose previous-state cleanup fails", async () => {
    const chunks: string[] = [];
    let generation = 0;
    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir: "/tmp/tool-server-committed-cleanup-unused",
      builtinPlugins: [
        {
          meta: { id: "committed-cleanup" },
          create() {
            generation += 1;
            const current = generation;
            const callableId = `committed.call.${current}`;
            return {
              level2: [
                {
                  id: `committed-${current}`,
                  async init() {},
                  async destroy() {},
                  async list() {
                    return [
                      { callableId, name: callableId, description: callableId, shortInput: [] },
                    ];
                  },
                  async call() {
                    return Result.ok({ generation: current });
                  },
                },
              ],
              async destroy() {
                if (current === 1) throw new Error("previous cleanup failed");
              },
            };
          },
        },
      ],
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (item) => item,
    });
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const server = createToolServer({
      pluginManager,
      logger: createLogger({
        module: "committed-cleanup-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
    });

    await server.init();
    const reload = await server.app.handle(
      new Request("http://localhost/reload", { method: "POST" }),
    );
    expect(await reload.json()).toEqual({ ok: true });
    const called = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "committed.call.2", input: {} }),
      }),
    );
    expect(await called.json()).toEqual({ status: "ok", value: { generation: 2 } });
    expect(chunks.join("\n")).toContain("reload committed");
    await server.stop();
  });

  it("keeps plugin-backed call mapping stable until explicit reload", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-plugin-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePluginServerTool({
      dataDir,
      pluginId: "fresh-plugin",
      callableId: "fresh.call",
      value: "one",
    });

    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir,
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (tool) => tool,
    });

    const server = createToolServer({ pluginManager });
    await server.init();

    // test-wait-justification: advances filesystem mtime so explicit reload observes the rewritten plugin bundle
    await Bun.sleep(5);
    await writePluginServerTool({
      dataDir,
      pluginId: "fresh-plugin",
      callableId: "fresh.call.v2",
      value: "two",
    });

    const listRes = await server.app.handle(new Request("http://localhost/list"));
    expect(await listRes.json()).toEqual({
      tools: [
        {
          callableId: "fresh.call",
          name: "fresh.call",
          description: "fresh.call",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const staleCall = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "fresh.call", input: {} }),
      }),
    );
    expect(await staleCall.json()).toEqual({ status: "ok", value: { value: "one" } });

    const reload = await server.app.handle(
      new Request("http://localhost/reload", { method: "POST" }),
    );
    expect(await reload.json()).toEqual({ ok: true });

    const helpRes = await server.app.handle(new Request("http://localhost/help/fresh.call.v2"));
    expect(helpRes.status).toBe(200);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "fresh.call.v2", input: {} }),
      }),
    );
    expect(await callRes.json()).toEqual({ status: "ok", value: { value: "two" } });

    await server.stop();
  });

  it("reports build metadata and loaded external plugin count from /versionz", async () => {
    const originalEnv = snapshotBuildEnv();
    process.env.LILAC_BUILD_VERSION = "2026.03.22";
    process.env.LILAC_BUILD_COMMIT = "abc123def456";
    process.env.LILAC_BUILD_DIRTY = "1";
    process.env.LILAC_BUILD_AT = "2026-03-22T00:00:00.000Z";

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-plugin-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePluginServerTool({
      dataDir,
      pluginId: "version-plugin",
      callableId: "version.call",
      value: "one",
    });

    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir,
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (tool) => tool,
    });

    const server = createToolServer({ pluginManager });

    try {
      await server.init();

      const response = await server.app.handle(new Request("http://localhost/versionz"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        version: "2026.03.22",
        commit: "abc123def456",
        dirty: true,
        builtAt: "2026-03-22T00:00:00.000Z",
        plugins: {
          loadedExternal: 1,
        },
      });
    } finally {
      restoreBuildEnv(originalEnv);
      await server.stop();
    }
  });

  it("reports live and ready health separately", async () => {
    const server = createToolServer({
      tools: [],
      healthProvider: () => ({
        checks: [
          {
            name: "runtime.ready",
            ok: false,
            impact: "ready",
            reason: "warming up",
          },
        ],
        info: {
          runtime: {
            state: "warming",
          },
        },
      }),
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: Number.MAX_SAFE_INTEGER,
      },
    });

    await server.init();
    await server.start(0);
    // test-wait-justification: allows the server health sampler to establish a baseline before rejection injection
    await Bun.sleep(5);
    server.recordUnhandledRejection(new Error("timer exploded"));

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    const healthBody = (await healthRes.json()) as {
      live: boolean;
      ready: boolean;
      info: {
        external?: Record<string, unknown>;
        unhandledRejection?: {
          count: number;
          lastReason: string;
        };
      };
    };
    expect(healthBody.live).toBe(true);
    expect(healthBody.ready).toBe(false);
    expect(healthBody.info.external).toEqual({
      runtime: {
        state: "warming",
      },
    });
    expect(healthBody.info.unhandledRejection).toMatchObject({
      count: 1,
      lastReason: "timer exploded",
    });

    const readyRes = await server.app.handle(new Request("http://localhost/readyz"));
    const readyBody = (await readyRes.json()) as {
      ready: boolean;
    };
    expect(readyBody.ready).toBe(false);

    await server.stop();
  });

  it("ignores heap accounting and only uses rss for memory health", async () => {
    setMockMemoryUsage({
      rss: 300 * 1024 * 1024,
      heapUsed: 90 * 1024 * 1024,
      heapTotal: 70 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    });

    const server = createToolServer({
      tools: [],
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: Number.MAX_SAFE_INTEGER,
      },
    });

    await server.init();
    await server.start(0);

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as {
      checks: Array<{ name: string; ok: boolean; details?: Record<string, unknown> }>;
    };
    const memoryCheck = healthBody.checks.find((check) => check.name === "process.memory");
    expect(memoryCheck?.ok).toBe(true);
    expect(memoryCheck?.details).toMatchObject({
      rss: 300 * 1024 * 1024,
      heapUsed: 90 * 1024 * 1024,
      heapTotal: 70 * 1024 * 1024,
    });

    await server.stop();
  });

  it("fails health when rss exceeds the limit", async () => {
    setMockMemoryUsage({
      rss: 300 * 1024 * 1024,
      heapUsed: 98 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    });

    const server = createToolServer({
      tools: [],
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: 256 * 1024 * 1024,
      },
    });

    await server.init();
    await server.start(0);

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(503);
    const healthBody = (await healthRes.json()) as {
      checks: Array<{ name: string; ok: boolean; reason?: string }>;
    };
    expect(healthBody.checks.find((check) => check.name === "process.memory")).toMatchObject({
      ok: false,
      reason: `rss ${300 * 1024 * 1024} exceeded limit ${256 * 1024 * 1024}`,
    });

    await server.stop();
  });

  it("times out tool calls and marks wedged calls unhealthy", async () => {
    const started = Promise.withResolvers<void>();
    const tool: ServerTool = {
      id: "hang",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "hang.forever",
            name: "Hang Forever",
            description: "never resolves",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call() {
        started.resolve();
        return await new Promise(() => {});
      },
    };

    jest.useFakeTimers({ now: 0 });
    let server: ReturnType<typeof createToolServer> | undefined;
    try {
      server = createToolServer({
        tools: [tool],
        toolCallTimeouts: {
          defaultTimeoutMs: 20,
        },
        healthConfig: {
          eventLoopLagFailMs: 60_000,
          maxRssBytes: Number.MAX_SAFE_INTEGER,
          toolCallOverdueGraceMs: 10,
        },
      });
      await server.init();
      await server.start(0);

      const callResponse = server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            callableId: "hang.forever",
            input: {},
          }),
        }),
      );
      await started.promise;
      jest.advanceTimersByTime(20);

      const callRes = await callResponse;
      expect(callRes.status).toBe(200);
      expect(await callRes.json()).toEqual({
        status: "error",
        error: {
          kind: "timeout",
          code: "tool_timeout",
          message: "Tool call timed out after 20ms",
          retryable: true,
        },
      });

      jest.advanceTimersByTime(11);

      const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
      expect(healthRes.status).toBe(503);
      const healthBody = (await healthRes.json()) as {
        checks: Array<{ name: string; ok: boolean }>;
      };
      expect(healthBody.checks.find((check) => check.name === "tool-calls.overdue")?.ok).toBe(
        false,
      );
    } finally {
      try {
        await server?.stop();
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it("reports an immediate Level 2 Panic to the fatal supervisor", async () => {
    const panic = new Panic({ message: "immediate tool invariant" });
    const observed = Promise.withResolvers<unknown>();
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const tool: ServerTool = {
      id: "immediate-panic",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "immediate-panic.call",
            name: "Immediate Panic",
            description: "rejects immediately with Panic",
            shortInput: [],
          },
        ];
      },
      async call() {
        throw panic;
      },
    };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "immediate-panic-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
      reportFatalToolCallDefect: observed.resolve,
    });

    await server.init();
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "immediate-panic.call", input: {} }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await observed.promise).toBe(panic);
    await server.stop();
  });

  it("invokes the fatal supervisor for a late Panic without changing the timeout response", async () => {
    const panic = new Panic({ message: "late tool invariant" });
    const started = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<Panic>();
    let fatalReports = 0;
    const tool: ServerTool = {
      id: "late-panic",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "late-panic.call",
            name: "Late Panic",
            description: "rejects with Panic after cancellation",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(panic), { once: true });
          started.resolve();
        });
      },
    };
    jest.useFakeTimers({ now: 0 });
    let server: ReturnType<typeof createToolServer> | undefined;
    try {
      server = createToolServer({
        tools: [tool],
        toolCallTimeouts: { defaultTimeoutMs: 10 },
        reportFatalToolCallDefect: (reported) => {
          fatalReports += 1;
          if (Panic.is(reported)) observed.resolve(reported);
        },
      });
      await server.init();
      const responsePromise = server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "late-panic.call", input: {} }),
        }),
      );
      await started.promise;
      jest.advanceTimersByTime(10);

      const response = await responsePromise;
      expect(await response.json()).toEqual({
        status: "error",
        error: {
          kind: "timeout",
          code: "tool_timeout",
          message: "Tool call timed out after 10ms",
          retryable: true,
        },
      });
      expect(await observed.promise).toBe(panic);
      expect(fatalReports).toBe(1);
    } finally {
      try {
        await server?.stop();
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it("reports a late non-Panic rejection to the fatal supervisor", async () => {
    const defect = new Error("late logging defect");
    const started = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<readonly Error[]>();
    const reported: Error[] = [];
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const logger = createLogger({
      module: "late-error-test",
      outputFormat: "jsonl",
      stdout: output,
      stderr: output,
    });
    Object.defineProperty(logger, "error", {
      value(message: string) {
        if (message === "tool plugin operation failed") throw defect;
      },
    });
    const tool: ServerTool = {
      id: "late-error",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "late-error.call",
            name: "Late Error",
            description: "settles through a broken logger after cancellation",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("expected plugin cancellation failure")),
            { once: true },
          );
          started.resolve();
        });
      },
    };
    jest.useFakeTimers({ now: 0 });
    let server: ReturnType<typeof createToolServer> | undefined;
    try {
      server = createToolServer({
        tools: [tool],
        logger,
        toolCallTimeouts: { defaultTimeoutMs: 10 },
        reportFatalToolCallDefect: (fatalDefect) => {
          reported.push(fatalDefect);
          if (reported.length === 2) observed.resolve(reported);
        },
      });
      await server.init();
      const responsePromise = server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "late-error.call", input: {} }),
        }),
      );
      await started.promise;
      jest.advanceTimersByTime(10);

      const response = await responsePromise;
      expect(await response.json()).toEqual({
        status: "error",
        error: {
          kind: "timeout",
          code: "tool_timeout",
          message: "Tool call timed out after 10ms",
          retryable: true,
        },
      });
      expect((await observed.promise).map((error) => error.message)).toEqual([
        "expected plugin cancellation failure",
        defect.message,
      ]);
    } finally {
      try {
        await server?.stop();
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it("does not report an ordinary Level 2 completion after timeout", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    let fatalReports = 0;
    const tool: ServerTool = {
      id: "late-success",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "late-success.call",
            name: "Late Success",
            description: "resolves after the caller deadline",
            shortInput: [],
          },
        ];
      },
      async call() {
        started.resolve();
        await release.promise;
        settled.resolve();
        return Result.ok({ late: true });
      },
    };
    jest.useFakeTimers({ now: 0 });
    let server: ReturnType<typeof createToolServer> | undefined;
    try {
      server = createToolServer({
        tools: [tool],
        toolCallTimeouts: { defaultTimeoutMs: 10 },
        reportFatalToolCallDefect: () => {
          fatalReports += 1;
        },
      });
      await server.init();
      const responsePromise = server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "late-success.call", input: {} }),
        }),
      );
      await started.promise;
      jest.advanceTimersByTime(10);

      const response = await responsePromise;
      expect(await response.json()).toEqual({
        status: "error",
        error: {
          kind: "timeout",
          code: "tool_timeout",
          message: "Tool call timed out after 10ms",
          retryable: true,
        },
      });
      release.resolve();
      await settled.promise;
      await Promise.resolve();
      expect(fatalReports).toBe(0);
    } finally {
      release.resolve();
      try {
        await server?.stop();
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it("leaves internal result-orchestration defects on the framework error path", async () => {
    const defect = new Error("result logging defect");
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const logger = createLogger({
      module: "result-orchestration-defect-test",
      outputFormat: "jsonl",
      stdout: output,
      stderr: output,
    });
    Object.defineProperty(logger, "info", {
      value(message: string) {
        if (message === "tool.call.result") throw defect;
      },
    });
    const tool: ServerTool = {
      id: "orchestration-defect",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "orchestration-defect.call",
            name: "Orchestration Defect",
            description: "completes before internal result logging fails",
            shortInput: [],
          },
        ];
      },
      async call() {
        return Result.ok({ ok: true });
      },
    };
    const server = createToolServer({ tools: [tool], logger });

    await server.init();
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "orchestration-defect.call", input: {} }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('"status":"error"');
    await server.stop();
  });

  it("does not leak active tool calls when tool.call throws synchronously", async () => {
    const reported: Error[] = [];
    const tool: ServerTool = {
      id: "sync-throw",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "sync-throw.fail",
            name: "Sync Throw",
            description: "throws before returning a promise",
            shortInput: [],
            input: [],
          },
        ];
      },
      call() {
        throw new Error("sync boom");
      },
    };

    jest.useFakeTimers({ now: 0 });
    let server: ReturnType<typeof createToolServer> | undefined;
    try {
      server = createToolServer({
        tools: [tool],
        toolCallTimeouts: {
          defaultTimeoutMs: 20,
        },
        healthConfig: {
          eventLoopLagFailMs: 60_000,
          maxRssBytes: Number.MAX_SAFE_INTEGER,
          toolCallOverdueGraceMs: 10,
        },
        reportFatalToolCallDefect: (defect) => reported.push(defect),
      });
      await server.init();
      await server.start(0);

      const callRes = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            callableId: "sync-throw.fail",
            input: {},
          }),
        }),
      );
      expect(await callRes.json()).toEqual({
        status: "error",
        error: {
          kind: "internal",
          code: "plugin_call_failed",
          message: "Internal tool server failure",
          retryable: false,
        },
      });
      expect(reported).toHaveLength(1);
      expect(reported[0]?.message).toBe("sync boom");

      jest.advanceTimersByTime(31);

      const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
      const healthBody = (await healthRes.json()) as {
        checks: Array<{ name: string; ok: boolean }>;
        info: {
          toolServer: {
            activeCalls: unknown[];
          };
        };
      };
      expect(healthBody.checks.find((check) => check.name === "tool-calls.overdue")?.ok).toBe(true);
      expect(healthBody.info.toolServer.activeCalls).toEqual([]);
    } finally {
      try {
        await server?.stop();
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it("wraps external TaggedErrors without returning or logging their causes or secrets", async () => {
    class ExternalPluginSecretError extends TaggedError("ExternalPluginSecretError")<{
      readonly token: string;
      readonly message: string;
    }> {}
    const chunks: string[] = [];
    const reported: Error[] = [];
    const secret = "plugin-tagged-secret-value";
    const tool: ServerTool = {
      id: "tagged-secret",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "tagged-secret.fail",
            name: "Tagged Secret",
            description: "throws an external TaggedError",
            shortInput: [],
          },
        ];
      },
      async call() {
        throw new ExternalPluginSecretError({ token: secret, message: `token=${secret}` });
      },
    };
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "tagged-plugin-error-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
      reportFatalToolCallDefect: (defect) => reported.push(defect),
    });

    await server.init();
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "tagged-secret.fail", input: {} }),
      }),
    );
    const body = await response.json();
    expect(body).toEqual({
      status: "error",
      error: {
        kind: "internal",
        code: "plugin_call_failed",
        message: "Internal tool server failure",
        retryable: false,
      },
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toBe("External tagged error");
    expect(`${JSON.stringify(body)}\n${chunks.join("\n")}`).not.toContain(secret);
    await server.stop();
  });

  it("returns guided validation errors for invalid tool input", async () => {
    const tool: ServerTool = {
      id: "validate",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "validate.input",
            name: "Validate Input",
            description: "validates request input",
            shortInput: ["--paths=<string | string[]>"],
            input: ["--paths=<string | string[]> | Local file paths"],
          },
        ];
      },
      async call(_callableId, input) {
        return decodeToolInput({
          callableId: "validate.input",
          input,
          schema: z.object({
            paths: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
          }),
        }).mapError((error) =>
          serverToolFailure({
            kind: "usage",
            code: "invalid_input",
            message: error.message,
            retryable: false,
          }),
        );
      },
    };

    const server = createToolServer({
      tools: [tool],
    });

    await server.init();
    await server.start(0);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "validate.input",
          input: {
            files: ["/tmp/generated-image.png"],
          },
        }),
      }),
    );

    expect(await callRes.json()).toEqual({
      status: "error",
      error: {
        kind: "usage",
        code: "invalid_input",
        message: [
          "validate.input has invalid input.",
          "Missing or invalid fields: paths",
          "Provided keys: files",
          "Run 'tools --help validate.input' for details.",
        ].join("\n"),
        retryable: false,
      },
    });

    await server.stop();
  });

  it("never logs mcp.add input or retained validation secrets", async () => {
    const chunks: string[] = [];
    const reported: Error[] = [];
    const output = {
      write(chunk: string) {
        chunks.push(chunk);
      },
    };
    const tool: ServerTool = {
      id: "mcp-log-redaction",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "mcp.add",
            name: "MCP Add",
            description: "validates sensitive MCP input",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call(callableId, input) {
        if (input && typeof input === "object" && Reflect.get(input, "transport") === "defect") {
          throw new Error(`MCP defect: ${JSON.stringify(input)}`);
        }
        if (input && typeof input === "object" && Reflect.get(input, "transport") === "stdio") {
          return Result.err(
            serverToolFailure({
              kind: "unavailable",
              code: "mcp_unavailable",
              message: `MCP runtime failed: ${JSON.stringify(input)}`,
              retryable: true,
              details: { retained: "env-secret-value" },
            }),
          );
        }
        return decodeToolInput({
          callableId,
          input,
          schema: z.strictObject({
            serverId: z.string(),
            transport: z.literal("http"),
            url: z.url(),
          }),
        }).mapError((error) =>
          serverToolFailure({
            kind: "usage",
            code: "invalid_input",
            message: error.message,
            retryable: false,
          }),
        );
      },
    };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "mcp-log-redaction-test",
        logLevel: "debug",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
      reportFatalToolCallDefect: (defect) => reported.push(defect),
    });
    const secrets = {
      clientSecret: "client-secret-value",
      authorization: "Bearer header-secret-value",
      envToken: "env-secret-value",
      commandToken: "command-token-value",
      argumentToken: "argument-token-value",
      code: "query-code-value",
      state: "query-state-value",
    };

    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "mcp.add",
            input: {
              transport: "http",
              url: `https://mcp.example/callback?code=${secrets.code}&state=${secrets.state}`,
              auth: {
                client: { clientSecret: secrets.clientSecret },
              },
              headers: { authorization: secrets.authorization },
              env: { MCP_TOKEN: secrets.envToken },
            },
          }),
        }),
      );
      const validationResult = await response.json();
      expect(validationResult).toEqual({
        status: "error",
        error: {
          kind: "usage",
          code: "invalid_input",
          message: "mcp.add input validation failed",
          retryable: false,
        },
      });

      const runtimeResponse = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "mcp.add",
            input: {
              transport: "stdio",
              command: `bun --token=${secrets.commandToken}`,
              args: [`--api-key=${secrets.argumentToken}`],
              url: `https://mcp.example/callback?code=${secrets.code}&state=${secrets.state}`,
              auth: {
                client: { clientSecret: secrets.clientSecret },
              },
              headers: { authorization: secrets.authorization },
              env: { MCP_TOKEN: secrets.envToken },
            },
          }),
        }),
      );
      const runtimeResult = await runtimeResponse.json();
      expect(runtimeResult).toEqual({
        status: "error",
        error: {
          kind: "unavailable",
          code: "mcp_add_failed",
          message: "mcp.add failed without exposing sensitive configuration",
          retryable: true,
        },
      });

      const defectResponse = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "mcp.add",
            input: {
              transport: "defect",
              command: `bun --token=${secrets.commandToken}`,
              env: { MCP_TOKEN: secrets.envToken },
            },
          }),
        }),
      );
      const defectResult = await defectResponse.json();
      expect(defectResult).toEqual({
        status: "error",
        error: {
          kind: "internal",
          code: "mcp_add_failed",
          message: "mcp.add failed without exposing sensitive configuration",
          retryable: false,
        },
      });

      const logged = chunks.join("");
      expect(logged).toContain("<redacted mcp.add input>");
      expect(logged).toContain("mcp_add_failed");
      expect(logged).not.toContain("MCP runtime failed");
      expect(logged).not.toContain("mcp.add has invalid input");
      expect(logged).not.toContain("?code=");
      expect(reported).toHaveLength(1);
      const observableOutput = `${logged}\n${reported[0]?.message}\n${JSON.stringify({ validationResult, runtimeResult, defectResult })}`;
      for (const secret of Object.values(secrets)) expect(observableOutput).not.toContain(secret);
    } finally {
      await server.stop();
    }
  });

  it("returns an opaque internal failure for runtime Zod defects", async () => {
    const reported: Error[] = [];
    const tool: ServerTool = {
      id: "validate-runtime",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "validate.runtime",
            name: "Validate Runtime",
            description: "parses non-input runtime data",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call() {
        const parsed = z
          .object({
            tag: z.string(),
          })
          .parse({});
        return Result.ok(parsed);
      },
    };

    const server = createToolServer({
      tools: [tool],
      reportFatalToolCallDefect: (defect) => reported.push(defect),
    });

    await server.init();
    await server.start(0);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "validate.runtime",
          input: {},
        }),
      }),
    );

    expect(await callRes.json()).toEqual({
      status: "error",
      error: {
        kind: "internal",
        code: "plugin_call_failed",
        message: "Internal tool server failure",
        retryable: false,
      },
    });
    expect(reported).toHaveLength(1);

    await server.stop();
  });

  it("keeps plugin startup failure fatal without leaking TaggedError", async () => {
    const failure = new ToolPluginHookError({
      pluginId: "startup",
      source: "builtin",
      hook: "plugin.create",
      cause: new Error("startup boom"),
      message: "startup boom",
    });
    const pluginManager = {
      init: async () => Result.err(failure),
      destroy: async () => Result.ok(),
      reload: async () => Result.ok(),
      ensureFresh: async () => Result.ok(),
      getLevel2Tools: () => [],
      getStatuses: () => [],
    };
    const server = createToolServer({ pluginManager });

    try {
      await server.init();
      throw new Error("expected startup failure");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBe(failure);
      expect(cause instanceof Error ? cause.message : "").toContain("startup boom");
    }
  });

  it("omits tools whose list hook fails while retaining healthy tools", async () => {
    const healthy: ServerTool = {
      id: "healthy",
      async init() {},
      async destroy() {},
      async list() {
        return [
          { callableId: "healthy.call", name: "Healthy", description: "Healthy", shortInput: [] },
        ];
      },
      async call() {
        return Result.ok(null);
      },
    };
    const broken: ServerTool = {
      id: "broken",
      async init() {},
      async destroy() {},
      async list() {
        throw new Error("list boom");
      },
      async call() {
        return Result.ok(null);
      },
    };
    const server = createToolServer({ tools: [healthy, broken] });
    await server.init();
    const response = await server.app.handle(new Request("http://localhost/list"));
    expect(await response.json()).toEqual({
      tools: [
        {
          callableId: "healthy.call",
          name: "Healthy",
          description: "Healthy",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });
    await server.stop();
  });

  it("propagates Panic from Level 2 hooks", async () => {
    const panic = new Panic({ message: "list invariant" });
    const tool: ServerTool = {
      id: "panic",
      async init() {},
      async destroy() {},
      async list() {
        throw panic;
      },
      async call() {
        return Result.ok(null);
      },
    };
    const server = createToolServer({ tools: [tool] });
    try {
      await server.init();
      throw new Error("expected Panic");
    } catch (cause) {
      expect(Panic.is(cause)).toBe(true);
    }
  });

  it("continues shutdown after aggregated plugin cleanup failure", async () => {
    const hookFailure = new ToolPluginHookError({
      pluginId: "cleanup",
      source: "builtin",
      hook: "instance.destroy",
      cause: new Error("cleanup boom"),
      message: "cleanup boom",
    });
    const cleanupFailure = new ToolPluginCleanupError({
      failures: [hookFailure],
      message: "cleanup boom",
    });
    const pluginManager = {
      init: async () => Result.ok(),
      destroy: async () => Result.err(cleanupFailure),
      reload: async () => Result.ok(),
      ensureFresh: async () => Result.ok(),
      getLevel2Tools: () => [],
      getStatuses: () => [],
    };
    const server = createToolServer({ pluginManager });
    await server.init();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("stops the host and surfaces plugin cleanup Panic identity", async () => {
    const panic = new Panic({ message: "plugin cleanup invariant" });
    const pluginManager = {
      init: async () => Result.ok(),
      destroy: async () => {
        throw panic;
      },
      reload: async () => Result.ok(),
      ensureFresh: async () => Result.ok(),
      getLevel2Tools: () => [],
      getStatuses: () => [],
    };
    const server = createToolServer({ pluginManager });
    await server.init();
    await server.start(0);

    await expect(server.stop()).rejects.toBe(panic);
    expect(server.app.server).toBeNull();
  });

  it("invokes the unhealthy watchdog after repeated live failures", async () => {
    const unhealthySnapshots: ToolServerHealthSnapshot[] = [];
    const server = createToolServer({
      tools: [],
      healthProvider: () => ({
        checks: [
          {
            name: "runtime.redis",
            ok: false,
            impact: "live",
            reason: "redis ping failed",
          },
        ],
      }),
      onUnhealthy: async (snapshot) => {
        unhealthySnapshots.push(snapshot);
      },
      healthConfig: {
        watchdogIntervalMs: 10,
        watchdogFailureThreshold: 2,
      },
    });

    await server.init();
    await server.start(0);

    // test-wait-justification: allows two real watchdog intervals to trigger the configured unhealthy callback
    await Bun.sleep(40);

    expect(unhealthySnapshots).toHaveLength(1);
    expect(
      unhealthySnapshots[0]?.checks.find(
        (check: ToolServerHealthSnapshot["checks"][number]) => check.name === "runtime.redis",
      )?.ok,
    ).toBe(false);

    await server.stop();
  });
});
