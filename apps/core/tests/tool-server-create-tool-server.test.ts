import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  ToolPluginManager,
  type Level1ToolSpec,
  type RequestContext,
} from "@stanley2058/lilac-plugin-runtime";

import {
  createToolServer,
  type ToolServerHealthSnapshot,
} from "../src/tool-server/create-tool-server";
import type { ServerTool } from "../src/tool-server/types";
import { parseToolInput } from "../src/tool-server/validation-error-message";

const originalMemoryUsage = process.memoryUsage;

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
    `export default {
  meta: { id: "${params.pluginId}" },
  create() {
    return {
      level2: [{
        id: "${params.pluginId}",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "${params.callableId}", name: "${params.callableId}", description: "${params.callableId}", shortInput: [], input: [] }]; },
        async call() { return { value: "${params.value}" }; },
      }],
    };
  },
};`,
    "utf8",
  );
}

describe("createToolServer", () => {
  it("sources workflow child context from an opaque server capability on list, help, and call", async () => {
    const calls: Array<{ callableId: string; sessionId?: string; cwd?: string }> = [];
    let searchPresent = true;
    const tool: ServerTool = {
      id: "workflow-child-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          { callableId: "fetch", name: "Fetch", description: "read", shortInput: [] },
          {
            callableId: "content.inspect",
            name: "Inspect",
            description: "inspect",
            shortInput: [],
          },
          { callableId: "search", name: "Search", description: "read", shortInput: [] },
          {
            callableId: "custom.directory-output",
            name: "Directory output",
            description: "temporarily unsafe output",
            shortInput: [],
            workflowPathAuthority: {
              inputs: [{ field: "outputDir", cardinality: "one", target: "write-directory" }],
            } as const,
          },
          {
            callableId: "skills.full",
            name: "Full skill",
            description: "global skill content",
            shortInput: [],
          },
          { callableId: "generate.image", name: "Generate", description: "write", shortInput: [] },
          {
            callableId: "onboarding.restart",
            name: "Restart",
            description: "admin",
            shortInput: [],
          },
          {
            callableId: "conversation.thread.read",
            name: "Global conversation read",
            description: "cross-session",
            shortInput: [],
          },
        ].filter((entry) => searchPresent || entry.callableId !== "search");
      },
      async call(callableId, _input, options) {
        calls.push({
          callableId,
          sessionId: options?.context?.sessionId,
          cwd: options?.context?.cwd,
        });
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      authorizeWorkflowRequest: ({ token }) =>
        token === "server-issued-control-token-123456"
          ? {
              requestId: "wfr:request",
              sessionId: "workflow:run:operation",
              platform: "unknown",
              expiresAt: Date.now() + 60_000,
              policy: {
                runId: "run-1",
                operationId: "operation-1",
                dispatchEpoch: "dispatch-epoch-0001",
                profile: "explore",
                model: null,
                reasoning: null,
                resolvedModel: "test/model",
                resolvedReasoning: null,
                resolvedModelRequest: {
                  spec: "test/model",
                  provider: "test",
                  modelId: "model",
                  reasoningDisplay: "simple",
                },
                safetyMode: "trusted",
                isolation: "shared",
                canonicalWorkspaceRoot: "/approved",
                canonicalAuthorityRoot: "/approved",
                canonicalAuthorityRootIdentity: { dev: "1", ino: "1" },
                canonicalRequestedCwd: "/approved",
                canonicalRequestedCwdIdentity: { dev: "1", ino: "1" },
                canonicalCwd: "/approved",
                canonicalCwdIdentity: { dev: "1", ino: "1" },
                canonicalScratchRoot: "/scratch/run-1",
                canonicalProjectId: "project-1",
                originSessionId: "origin-channel",
                originClient: "discord",
                originUserId: "user-1",
                revisionId: "revision-1",
                sourceSha256: "a".repeat(64),
                inputSchemaSha256: "b".repeat(64),
                argsSha256: "d".repeat(64),
                operationInputSha256: "e".repeat(64),
              },
            }
          : null,
    });
    await server.init();
    const headers = {
      "x-lilac-request-id": "wfr:request",
      "x-lilac-session-id": "workflow:run:operation",
      "x-lilac-request-client": "unknown",
      "x-lilac-workflow-control-token": "server-issued-control-token-123456",
    };
    try {
      const list = await server.app.handle(new Request("http://localhost/list", { headers }));
      const listed = (await list.json()) as { tools: Array<{ callableId: string }> };
      expect(listed.tools.map((entry) => entry.callableId)).toContain("custom.directory-output");
      expect(listed.tools.map((entry) => entry.callableId)).toContain("onboarding.restart");
      const help = await server.app.handle(new Request("http://localhost/help/fetch", { headers }));
      expect(help.status).toBe(200);
      const directoryHelp = await server.app.handle(
        new Request("http://localhost/help/custom.directory-output", { headers }),
      );
      expect(directoryHelp.status).toBe(200);
      const skillHelp = await server.app.handle(
        new Request("http://localhost/help/skills.full", { headers }),
      );
      expect(skillHelp.status).toBe(200);
      const call = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ callableId: "search", input: { query: "example" } }),
        }),
      );
      expect(await call.json()).toMatchObject({ isError: false, output: { ok: true } });
      expect(calls).toEqual([
        { callableId: "search", sessionId: "origin-channel", cwd: "/approved" },
      ]);

      searchPresent = false;
      const afterPluginRemoval = await server.app.handle(
        new Request("http://localhost/list", { headers }),
      );
      const refreshed = (await afterPluginRemoval.json()) as {
        tools: Array<{ callableId: string }>;
      };
      expect(refreshed.tools.map((entry) => entry.callableId)).not.toContain("search");
      expect(
        (await server.app.handle(new Request("http://localhost/help/search", { headers }))).status,
      ).toBe(404);
      expect(
        (
          await server.app.handle(
            new Request("http://localhost/call", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ callableId: "search", input: { query: "example" } }),
            }),
          )
        ).status,
      ).toBe(404);
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
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      canonicalWorkspaceRoot: "/workspace",
      authorizeControlRequest: (input) =>
        input.token === "unguessable-primary-token" &&
        input.requestId === "request-1" &&
        input.sessionId === "channel-1" &&
        input.platform === "discord"
          ? {
              kind: "primary" as const,
              principal: { platform: "discord" as const, userId: "user-1" },
              allowedCallables: null,
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
      ).toMatchObject({ isError: false, output: { ok: true } });
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.cwd).toBe("/workspace");
      expect(contexts[0]?.projectRoot).toBe("/attacker-controlled");
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
        return { ok: true };
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
      ).toMatchObject({ isError: false, output: { ok: true } });
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
      ).toMatchObject({ isError: false, output: { ok: true } });
      expect(contexts).toEqual([
        {
          requestId: "operator:request-1",
          toolCallId: "operator:request-1",
          cwd: "/canonical-workspace",
          projectRoot: "/canonical-workspace",
          safetyMode: "trusted",
          serverOwnedRequest: true,
          operator: true,
        },
        {
          requestId: "operator:request-1",
          toolCallId: "operator:request-1",
          cwd: "/canonical-workspace",
          projectRoot: "/operator-selected-project",
          safetyMode: "trusted",
          serverOwnedRequest: true,
          operator: true,
        },
      ]);
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
            workflowPathAuthority: {
              inputs: [{ field: "paths", cardinality: "many", target: "read-file" }],
            },
          },
          { callableId: "workflow.start", name: "start", description: "start", shortInput: [] },
          { callableId: "read_file", name: "read", description: "read", shortInput: [] },
        ];
      },
      async call(callableId, _input, options) {
        called.push(callableId);
        expect(options?.context?.cwd).toBe("/canonical-workspace");
        expect(options?.context?.projectRoot).toBeUndefined();
        expect(options?.context?.authenticatedPrincipal).toBeUndefined();
        return { ok: true };
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
              allowedCallables: ["surface.messages.send"],
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
        isError: true,
        output: expect.stringContaining("outside the internal request capability"),
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
        isError: true,
        output: expect.stringContaining("text-only"),
      });

      const allowedCall = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ callableId: "surface.messages.send", input: { content: "due" } }),
        }),
      );
      expect(await allowedCall.json()).toMatchObject({ isError: false, output: { ok: true } });
      expect(called).toEqual(["surface.messages.send"]);
    } finally {
      await server.stop();
    }
  });

  it("keeps native callables available and pins declared local paths to descriptors", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-path-authority-"));
    const workspace = path.join(tmpRoot, "workspace");
    const outside = path.join(tmpRoot, "outside.txt");
    const scratchRoot = path.join(workspace, ".lilac-data", "workflow-runtime", "scratch", "run-1");
    await fs.mkdir(workspace);
    await fs.mkdir(scratchRoot, { recursive: true });
    await fs.writeFile(path.join(workspace, "inside.txt"), "contained", "utf8");
    await fs.writeFile(path.join(workspace, "race.txt"), "authorized race", "utf8");
    await fs.writeFile(path.join(scratchRoot, "handoff.txt"), "scratch handoff", "utf8");
    await fs.writeFile(path.join(workspace, "hardlinked.txt"), "linked secret", "utf8");
    await fs.link(
      path.join(workspace, "hardlinked.txt"),
      path.join(workspace, "hardlink-alias.txt"),
    );
    await fs.mkdir(path.join(workspace, ".git"));
    await fs.mkdir(path.join(workspace, ".secrets"));
    await fs.mkdir(path.join(workspace, ".env.local"));
    await fs.writeFile(path.join(workspace, ".git", "index"), "git secret", "utf8");
    await fs.writeFile(path.join(workspace, ".secrets", "token"), "token secret", "utf8");
    await fs.writeFile(path.join(workspace, ".envrc"), "TOKEN=secret", "utf8");
    await fs.writeFile(path.join(workspace, ".env.local", "token"), "nested secret", "utf8");
    await fs.writeFile(outside, "secret", "utf8");
    await fs.symlink(outside, path.join(workspace, "linked.txt"));
    const workspaceStats = await fs.stat(workspace, { bigint: true });
    const workspaceIdentity = {
      dev: workspaceStats.dev.toString(10),
      ino: workspaceStats.ino.toString(10),
    };
    const seen: Record<string, unknown>[] = [];
    const tool: ServerTool = {
      id: "workflow-path-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "content.inspect",
            name: "inspect",
            description: "inspect",
            shortInput: [],
          },
          {
            callableId: "custom.pathless",
            name: "pathless",
            description: "pathless plugin callable",
            shortInput: [],
          },
          {
            callableId: "custom.pinned-read",
            name: "pinned read",
            description: "descriptor pin test",
            shortInput: [],
            workflowPathAuthority: {
              inputs: [{ field: "path", cardinality: "one", target: "read-file" }],
            },
          },
          {
            callableId: "surface.messages.send",
            name: "send",
            description: "send",
            shortInput: [],
            workflowPathAuthority: {
              inputs: [{ field: "paths", cardinality: "many", target: "read-file" }],
            },
          },
          {
            callableId: "surface.messages.edit",
            name: "edit",
            description: "edit",
            shortInput: [],
          },
          {
            callableId: "surface.messages.delete",
            name: "delete",
            description: "delete",
            shortInput: [],
          },
          {
            callableId: "surface.reactions.add",
            name: "react",
            description: "react",
            shortInput: [],
          },
        ];
      },
      async call(callableId, input) {
        seen.push(input);
        const descriptorPath =
          typeof input.path === "string"
            ? input.path
            : Array.isArray(input.paths) && typeof input.paths[0] === "string"
              ? input.paths[0]
              : undefined;
        if (callableId === "custom.pinned-read") {
          await fs.rename(
            path.join(workspace, "race.txt"),
            path.join(workspace, "race-original.txt"),
          );
          await fs.symlink(outside, path.join(workspace, "race.txt"));
        }
        return descriptorPath ? await fs.readFile(descriptorPath, "utf8") : { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      authorizeWorkflowRequest: ({ token }) =>
        token === "workflow-path-token-unguessable"
          ? {
              requestId: "wfr:path",
              sessionId: "workflow:path",
              platform: "unknown",
              expiresAt: Date.now() + 60_000,
              policy: {
                runId: "run-path",
                operationId: "operation-path",
                dispatchEpoch: "dispatch-epoch-path",
                profile: "general",
                model: null,
                reasoning: null,
                resolvedModel: "test/model",
                resolvedReasoning: null,
                resolvedModelRequest: {
                  spec: "test/model",
                  provider: "test",
                  modelId: "model",
                  reasoningDisplay: "simple",
                },
                safetyMode: "trusted",
                isolation: "shared",
                canonicalWorkspaceRoot: workspace,
                canonicalAuthorityRoot: workspace,
                canonicalAuthorityRootIdentity: workspaceIdentity,
                canonicalRequestedCwd: workspace,
                canonicalRequestedCwdIdentity: workspaceIdentity,
                canonicalCwd: workspace,
                canonicalCwdIdentity: workspaceIdentity,
                canonicalScratchRoot: scratchRoot,
                canonicalProjectId: "project-path",
                originSessionId: "origin-channel",
                originClient: "discord",
                originUserId: "user-1",
                revisionId: "revision-path",
                sourceSha256: "a".repeat(64),
                inputSchemaSha256: "b".repeat(64),
                argsSha256: "d".repeat(64),
                operationInputSha256: "e".repeat(64),
              },
            }
          : null,
    });
    await server.init();
    const headers = {
      "x-lilac-request-id": "wfr:path",
      "x-lilac-session-id": "workflow:path",
      "x-lilac-request-client": "unknown",
      "x-lilac-workflow-control-token": "workflow-path-token-unguessable",
      "content-type": "application/json",
    };
    try {
      const list = await server.app.handle(new Request("http://localhost/list", { headers }));
      expect(
        ((await list.json()) as { tools: Array<{ callableId: string }> }).tools.map(
          (item) => item.callableId,
        ),
      ).toEqual([
        "content.inspect",
        "custom.pathless",
        "custom.pinned-read",
        "surface.messages.send",
        "surface.messages.edit",
        "surface.messages.delete",
        "surface.reactions.add",
      ]);
      const pathless = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers,
          body: JSON.stringify({ callableId: "custom.pathless", input: { query: "status" } }),
        }),
      );
      expect(await pathless.json()).toMatchObject({ isError: false, output: { ok: true } });
      const undeclaredPluginPath = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers,
          body: JSON.stringify({
            callableId: "custom.pathless",
            input: { sourcePath: "inside.txt" },
          }),
        }),
      );
      expect(await undeclaredPluginPath.json()).toMatchObject({ isError: false });
      const inspect = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers,
          body: JSON.stringify({
            callableId: "surface.messages.send",
            input: { text: "attached", paths: ["inside.txt"] },
          }),
        }),
      );
      expect(await inspect.json()).toMatchObject({ isError: false, output: "contained" });
      expect(seen[2]?.paths).toEqual([expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/)]);
      const pinnedRead = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers,
          body: JSON.stringify({ callableId: "custom.pinned-read", input: { path: "race.txt" } }),
        }),
      );
      expect(await pinnedRead.json()).toMatchObject({
        isError: false,
        output: "authorized race",
      });
      expect(await fs.readFile(outside, "utf8")).toBe("secret");
      const scratchRead = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers,
          body: JSON.stringify({
            callableId: "surface.messages.send",
            input: { text: "scratch", paths: ["/run/lilac/scratch/handoff.txt"] },
          }),
        }),
      );
      expect(await scratchRead.json()).toMatchObject({
        isError: false,
        output: "scratch handoff",
      });
      const crossSession = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers,
          body: JSON.stringify({
            callableId: "surface.messages.send",
            input: { sessionId: "another-session", text: "escape" },
          }),
        }),
      );
      expect(await crossSession.json()).toMatchObject({ isError: false });
      const fixtureSecrets = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers,
          body: JSON.stringify({
            callableId: "surface.messages.send",
            input: { text: "fixture", paths: [".secrets/token"] },
          }),
        }),
      );
      expect(await fixtureSecrets.json()).toMatchObject({ isError: false, output: "token secret" });
      for (const allowed of [".envrc", ".env.local/token", ".git/index"]) {
        const response = await server.app.handle(
          new Request("http://localhost/call", {
            method: "POST",
            headers,
            body: JSON.stringify({
              callableId: "surface.messages.send",
              input: { text: "attached", paths: [allowed] },
            }),
          }),
        );
        expect(await response.json()).toMatchObject({ isError: false });
      }
      for (const forbidden of [outside, "linked.txt", "hardlink-alias.txt"]) {
        const response = await server.app.handle(
          new Request("http://localhost/call", {
            method: "POST",
            headers,
            body: JSON.stringify({
              callableId: "surface.messages.send",
              input: { text: "attached", paths: [forbidden] },
            }),
          }),
        );
        expect(response.status).toBe(500);
      }
      const tooMany = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers,
          body: JSON.stringify({
            callableId: "surface.messages.send",
            input: { text: "attached", paths: Array.from({ length: 65 }, () => "inside.txt") },
          }),
        }),
      );
      expect(tooMany.status).toBe(500);
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
          sessionId: opts?.context?.sessionId,
          requestClient: opts?.context?.requestClient,
          cwd: opts?.context?.cwd,
          messages: opts?.messages,
          serverOwnedRequest: opts?.context?.serverOwnedRequest,
        });
        return { ok: true, echo: input };
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
            ? { sessionId: "chan", platform: "discord", actorUserId: "user-1" }
            : undefined,
      },
    });

    await server.init();

    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lilac-request-id": "req:1",
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
    expect(body).toEqual({ isError: false, output: { ok: true, echo: { hello: "world" } } });

    const captured = seenCalls[0]!;
    expect(captured.callableId).toBe("test.echo");
    expect(captured.input).toEqual({ hello: "world" });
    expect(captured.requestId).toBe("req:1");
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
        return { ok: true };
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
        return { ok: true, callableId };
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
      isError: true,
      output: "Tool 'onboarding.restart' is not allowed in restricted public-session mode",
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
      isError: true,
      output: "Tool 'surface.messages.send' is not allowed in restricted public-session mode",
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
      isError: true,
      output: "Tool 'surface.messages.edit' is not allowed in restricted public-session mode",
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
      isError: false,
      output: { ok: true, callableId: "fetch" },
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
      isError: false,
      output: { ok: true, callableId: "discovery.search" },
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
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: (requestId) =>
          requestId === "request-1" ? [{ role: "user", content: "run workflow" }] : undefined,
        getOrigin: (requestId) =>
          requestId === "request-1"
            ? { sessionId: "channel-1", platform: "discord", actorUserId: "user-1" }
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
        isError: true,
        output: "Tool 'workflow.test' is not allowed in restricted public-session mode",
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
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
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
    expect(await firstCall.json()).toEqual({ isError: false, output: { value: "one" } });

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
    expect(await secondCall.json()).toEqual({ isError: false, output: { value: "two" } });

    await server.stop();
  });

  it("refreshes plugin-backed call mapping on list/help/call without explicit reload", async () => {
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
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
      initLevel2Item: async (tool) => {
        await tool.init();
      },
      destroyLevel2Item: async (tool) => {
        await tool.destroy();
      },
    });

    const server = createToolServer({ pluginManager });
    await server.init();

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
          callableId: "fresh.call.v2",
          name: "fresh.call.v2",
          description: "fresh.call.v2",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

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
    expect(await callRes.json()).toEqual({ isError: false, output: { value: "two" } });

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
      getLevel1Name: (spec) => spec.name,
      getLevel2CallableIds: async (tool) => (await tool.list()).map((entry) => entry.callableId),
      initLevel2Item: async (tool) => {
        await tool.init();
      },
      destroyLevel2Item: async (tool) => {
        await tool.destroy();
      },
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
        return await new Promise(() => {});
      },
    };

    const server = createToolServer({
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

    const callRes = await server.app.handle(
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
    expect(callRes.status).toBe(200);
    expect(await callRes.json()).toEqual({
      isError: true,
      output: "Tool call timed out after 20ms",
    });

    await Bun.sleep(20);

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(503);
    const healthBody = (await healthRes.json()) as {
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(healthBody.checks.find((check) => check.name === "tool-calls.overdue")?.ok).toBe(false);

    await server.stop();
  });

  it("does not leak active tool calls when tool.call throws synchronously", async () => {
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

    const server = createToolServer({
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
      isError: true,
      output: "sync boom",
    });

    await Bun.sleep(40);

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
        return parseToolInput({
          callableId: "validate.input",
          input,
          schema: z.object({
            paths: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
          }),
        });
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
      isError: true,
      output: [
        "validate.input has invalid input.",
        "Missing or invalid fields: paths",
        "Provided keys: files",
        "Run 'tools --help validate.input' for details.",
      ].join("\n"),
    });

    await server.stop();
  });

  it("preserves runtime Zod errors that are not input parsing failures", async () => {
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
        return z
          .object({
            tag: z.string(),
          })
          .parse({});
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
          callableId: "validate.runtime",
          input: {},
        }),
      }),
    );

    const body = (await callRes.json()) as { isError: boolean; output: string };
    expect(body.isError).toBe(true);
    expect(body.output).toContain('"tag"');
    expect(body.output).not.toContain("validate.runtime has invalid input.");

    await server.stop();
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
