import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  buildToolInput,
  buildVersionTags,
  parseArgs,
  parseGlobalArgs,
  resolveBuildId,
} from "./client";

const CLIENT_ENTRY = path.join(import.meta.dir, "client.ts");

function expectOk<T>(
  result: { readonly status: "ok"; readonly value: T } | { readonly status: "error" },
): T {
  expect(result.status).toBe("ok");
  if (result.status === "error") throw new Error("expected Ok result");
  return result.value;
}

function expectErrorMessage(
  result:
    | { readonly status: "ok" }
    | { readonly status: "error"; readonly error: { readonly message: string } },
  message: string,
): void {
  expect(result.status).toBe("error");
  if (result.status === "ok") throw new Error("expected Err result");
  expect(result.error.message).toContain(message);
}

async function runToolBridgeCli(params: {
  args: readonly string[];
  backendUrl: string;
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLIENT_ENTRY, ...params.args], {
    cwd: params.cwd ?? import.meta.dir,
    env: {
      ...process.env,
      ...params.env,
      TOOL_SERVER_BACKEND_URL: params.backendUrl,
      NO_COLOR: "1",
    },
    stdin: params.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (params.stdin !== undefined) {
    if (!proc.stdin) {
      throw new Error("expected writable stdin");
    }
    proc.stdin.write(params.stdin);
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("tool-bridge build id", () => {
  it("uses the build-time ID for built entrypoints", async () => {
    await expect(
      resolveBuildId("/workspace/apps/tool-bridge/dist/client.js", "deadbeef"),
    ).resolves.toBe("deadbeef");
    await expect(
      resolveBuildId("/workspace/apps/tool-bridge/dist/index.js", "deadbeef"),
    ).resolves.toBe("deadbeef");
  });

  it("falls back to dev when running from source", async () => {
    await expect(resolveBuildId("/workspace/apps/tool-bridge/client.ts", "deadbeef")).resolves.toBe(
      "dev",
    );
  });

  it("shows backend dirty state even when commits match", () => {
    expect(
      buildVersionTags(
        {
          version: "dev",
          commit: "abc123def456",
          build: "deadbeef",
        },
        {
          ok: true,
          version: "dev",
          commit: "abc123def456",
          dirty: true,
          plugins: {
            loadedExternal: 2,
          },
        },
      ).map(stripVTControlCharacters),
    ).toEqual(["[commit: abc123def456]", "[build: deadbeef]", "[app-dirty]", "[plugins: 2]"]);
  });
});

describe("tool-bridge CLI runtime", () => {
  it("reads and forwards the operator token only when --operator or --op is explicit", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "tool-bridge-operator-"));
    const tokenPath = path.join(root, "operator-token");
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
    await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    const requests: Request[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/list") requests.push(req.clone());
        return Response.json({ tools: [] });
      },
    });
    try {
      expect(parseGlobalArgs(["--operator", "--list"])).toEqual({
        args: ["--list"],
        operator: true,
      });
      expect(parseGlobalArgs(["--op", "--list"])).toEqual({
        args: ["--list"],
        operator: true,
      });
      expect(parseGlobalArgs(["demo.echo", "--", "--operator"])).toEqual({
        args: ["demo.echo", "--", "--operator"],
        operator: false,
      });
      expect(parseGlobalArgs(["demo.echo", "--", "--op"])).toEqual({
        args: ["demo.echo", "--", "--op"],
        operator: false,
      });
      const result = await runToolBridgeCli({
        args: ["--op", "--list"],
        backendUrl: `http://127.0.0.1:${server.port}`,
        env: { LILAC_OPERATOR_TOKEN_FILE: tokenPath },
      });
      expect(result.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("x-lilac-operator-token")).toBe(token);
      expect(requests[0]?.headers.get("x-lilac-request-id")).toMatch(/^operator:/u);
      expect(requests[0]?.headers.get("x-lilac-tool-call-id")).toBe(
        requests[0]?.headers.get("x-lilac-request-id"),
      );
    } finally {
      server.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports the owned network failure after loading the operator token", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "tool-bridge-operator-network-"));
    const tokenPath = path.join(root, "operator-token");
    await fs.writeFile(tokenPath, "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678\n", { mode: 0o600 });

    try {
      const result = await runToolBridgeCli({
        args: ["--operator", "--list"],
        backendUrl: "http://127.0.0.1:1",
        env: { LILAC_OPERATOR_TOKEN_FILE: tokenPath },
      });

      expect(result).toEqual({
        stdout: "",
        stderr:
          '{"status":"error","error":{"kind":"unavailable","code":"bridge_unavailable","message":"fetch tools list failed","retryable":true}}\n',
        exitCode: 6,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("forwards generic control capability but not workflow capability", async () => {
    const requests: Request[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        requests.push(req.clone());
        const url = new URL(req.url);
        if (url.pathname === "/list") {
          return Response.json({ tools: [] });
        }
        return Response.json({
          callableId: "fetch",
          name: "Fetch",
          description: "Fetch URL",
          shortInput: [],
          input: [],
        });
      },
    });
    const env = {
      LILAC_REQUEST_ID: "wfr:request",
      LILAC_SESSION_ID: "workflow:run:operation",
      LILAC_REQUEST_CLIENT: "unknown",
      LILAC_CWD: "/approved",
      LILAC_TOOL_CALL_ID: "tool-call-1",
      LILAC_CONTROL_CAPABILITY: "control-capability",
      LILAC_CURRENT_TURN_USER_ID: "user-2",
      LILAC_WORKFLOW_CAPABILITY: "server-capability",
    };
    try {
      expect(
        (
          await runToolBridgeCli({
            args: ["--list"],
            backendUrl: `http://127.0.0.1:${server.port}`,
            env,
          })
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await runToolBridgeCli({
            args: ["--help", "fetch"],
            backendUrl: `http://127.0.0.1:${server.port}`,
            env,
          })
        ).exitCode,
      ).toBe(0);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.headers.get("x-lilac-request-id")).toBe("wfr:request");
        expect(request.headers.get("x-lilac-tool-call-id")).toBe("tool-call-1");
        expect(request.headers.get("x-lilac-control-capability")).toBe("control-capability");
        expect(request.headers.get("x-lilac-current-turn-user-id")).toBe("user-2");
        expect(request.headers.get("x-lilac-workflow-capability")).toBeNull();
      }
    } finally {
      server.stop(true);
    }
  });

  it("posts stdin JSON and reports the live process cwd instead of the inherited cwd hint", async () => {
    const requests: Array<{ pathname: string; headers: Headers; body: unknown }> = [];
    const invocationCwd = await fs.mkdtemp(path.join(tmpdir(), "tool-bridge-cwd-"));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({
          pathname: url.pathname,
          headers: req.headers,
          body: (await req.json()) as unknown,
        });

        return new Response(
          JSON.stringify({
            status: "ok",
            value: {
              ok: true,
              value: 42,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["demo.echo", "--stdin"],
        backendUrl: `http://127.0.0.1:${server.port}`,
        stdin: JSON.stringify({ message: "hello", nested: { count: 2 } }),
        env: {
          LILAC_REQUEST_ID: "request-123",
          LILAC_REQUEST_DELIVERY_ID: "delivery-234",
          LILAC_SESSION_ID: "session-456",
          LILAC_REQUEST_CLIENT: "test-client",
          LILAC_CWD: "/stale/workspace/project",
        },
        cwd: invocationCwd,
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('{"ok":true,"value":42}\n');

      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (!request) {
        throw new Error("expected backend request");
      }
      expect(request.pathname).toBe("/call");
      expect(request.headers.get("content-type")).toContain("application/json");
      expect(request.headers.get("x-lilac-request-id")).toBe("request-123");
      expect(request.headers.get("x-lilac-request-delivery-id")).toBe("delivery-234");
      expect(request.headers.get("x-lilac-session-id")).toBe("session-456");
      expect(request.headers.get("x-lilac-request-client")).toBe("test-client");
      expect(request.headers.get("x-lilac-cwd")).toBe(invocationCwd);
      expect(request.body).toEqual({
        callableId: "demo.echo",
        input: {
          message: "hello",
          nested: { count: 2 },
        },
      });
    } finally {
      server.stop(true);
      await fs.rm(invocationCwd, { recursive: true, force: true });
    }
  });

  it("supports explicit pretty JSON output", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ status: "ok", value: { ok: true, nested: { value: 42 } } });
      },
    });

    try {
      const pretty = await runToolBridgeCli({
        args: ["demo.echo", "--input={}", "--output=json-pretty"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(pretty).toEqual({
        stdout: '{\n  "ok": true,\n  "nested": {\n    "value": 42\n  }\n}\n',
        stderr: "",
        exitCode: 0,
      });
    } finally {
      server.stop(true);
    }
  });

  it("orchestrates non-interactive onboarding", async () => {
    const calls: Array<{ callableId: string; input: Record<string, unknown> }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { callableId: string; input: Record<string, unknown> };
        calls.push(body);
        if (body.callableId === "onboarding.bootstrap") {
          return Response.json({ status: "ok", value: { bootstrapped: true } });
        }
        if (body.callableId === "onboarding.vcs_env") {
          return Response.json({ status: "ok", value: { GIT_CONFIG_GLOBAL: "/tmp/gitconfig" } });
        }
        if (body.callableId === "onboarding.git_identity" && body.input.mode === "test") {
          return Response.json({ status: "ok", value: { ok: true } });
        }
        return Response.json({ status: "ok", value: { configured: true } });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["onboard", "--yes", "--no-sign", "--output=json"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output.ok).toBe(true);
      expect(output.userName).toBe("lilac-agent[bot]");
      expect(output.userEmail).toBe("lilac-agent[bot]@users.noreply.github.com");
      expect(output.signing).toEqual({ enabled: false });
      expect(output.vcsEnv).toEqual({ GIT_CONFIG_GLOBAL: "/tmp/gitconfig" });
      expect(output.gitTest).toEqual({ ok: true });
      expect(calls).toEqual([
        { callableId: "onboarding.bootstrap", input: {} },
        { callableId: "onboarding.vcs_env", input: {} },
        {
          callableId: "onboarding.git_identity",
          input: {
            mode: "configure",
            userName: "lilac-agent[bot]",
            userEmail: "lilac-agent[bot]@users.noreply.github.com",
            enableSigning: false,
          },
        },
        { callableId: "onboarding.git_identity", input: { mode: "test" } },
      ]);
    } finally {
      server.stop(true);
    }
  });

  it("propagates the originating server failure from onboarding", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { callableId: string };
        if (body.callableId === "onboarding.bootstrap") {
          return Response.json({ status: "ok", value: { bootstrapped: true } });
        }
        return Response.json({
          status: "error",
          error: {
            kind: "denied",
            code: "identity_denied",
            message: "Git identity configuration denied",
            retryable: false,
            details: { operation: "vcs_env" },
          },
        });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["onboard", "--yes", "--no-sign", "--output=json"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result).toEqual({
        stdout: "",
        stderr:
          '{"status":"error","error":{"kind":"denied","code":"identity_denied","message":"Git identity configuration denied","retryable":false,"details":{"operation":"vcs_env"}}}\n',
        exitCode: 3,
      });
    } finally {
      server.stop(true);
    }
  });

  it("advertises JSON output modes without compact output", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ ok: true, version: "dev", commit: "unknown", dirty: false });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["--help"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('--output=<"json" | "json-pretty"> (default: "json")');
      expect(result.stdout).toContain("Output and exit codes");
      expect(result.stdout).toContain(
        "1 internal, 2 usage, 3 denied, 4 not_found, 5 conflict, 6 unavailable, 7 timeout, 8 cancelled.",
      );
      expect(result.stdout).toContain('Failure writes {"status":"error","error"');
      expect(result.stdout).not.toContain("compact");
    } finally {
      server.stop(true);
    }
  });

  it("treats mcp.add as an opaque callable ID and flattens positional and flag input", async () => {
    const requests: Array<{ pathname: string; body?: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/help/mcp.add") {
          requests.push({ pathname });
          return Response.json({
            callableId: "mcp.add",
            name: "Add MCP server",
            description: "Add an MCP server",
            shortInput: [],
            input: [],
            primaryPositional: { field: "serverId" },
          });
        }

        requests.push({ pathname, body: (await req.json()) as unknown });
        return Response.json({ status: "ok", value: { ok: true } });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: [
          "mcp.add",
          "demo",
          "--transport=http",
          "--url=https://mcp.example.test/service",
          "--output=json",
        ],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(requests).toEqual([
        { pathname: "/help/mcp.add" },
        {
          pathname: "/call",
          body: {
            callableId: "mcp.add",
            input: {
              serverId: "demo",
              transport: "http",
              url: "https://mcp.example.test/service",
            },
          },
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  it("calls mcp.reload with and without its serverId positional", async () => {
    const requests: Array<{ pathname: string; body?: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/help/mcp.reload") {
          requests.push({ pathname });
          return Response.json({
            callableId: "mcp.reload",
            name: "Reload MCP server",
            description: "Reload MCP servers",
            shortInput: [],
            input: [],
            primaryPositional: { field: "serverId" },
          });
        }

        requests.push({ pathname, body: (await req.json()) as unknown });
        return Response.json({ status: "ok", value: { ok: true } });
      },
    });

    try {
      const withServerId = await runToolBridgeCli({
        args: ["mcp.reload", "demo", "--output=json"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });
      const withoutServerId = await runToolBridgeCli({
        args: ["mcp.reload", "--output=json"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(withServerId.exitCode).toBe(0);
      expect(withServerId.stderr).toBe("");
      expect(withoutServerId.exitCode).toBe(0);
      expect(withoutServerId.stderr).toBe("");
      expect(requests).toEqual([
        { pathname: "/help/mcp.reload" },
        {
          pathname: "/call",
          body: { callableId: "mcp.reload", input: { serverId: "demo" } },
        },
        {
          pathname: "/call",
          body: { callableId: "mcp.reload", input: {} },
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  it("preserves server tool failures and maps all semantic exit codes", async () => {
    const cases = [
      ["internal", 1],
      ["usage", 2],
      ["denied", 3],
      ["not_found", 4],
      ["conflict", 5],
      ["unavailable", 6],
      ["timeout", 7],
      ["cancelled", 8],
    ] as const;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { callableId: string };
        const kind = body.callableId.slice("demo.".length);
        return Response.json({
          status: "error",
          error: {
            kind,
            code: `${kind}_failure`,
            message: `${kind} failure`,
            retryable: kind === "timeout" || kind === "unavailable",
          },
        });
      },
    });

    try {
      for (const [kind, exitCode] of cases) {
        const result = await runToolBridgeCli({
          args: [`demo.${kind}`, "--input={}", "--output=json"],
          backendUrl: `http://127.0.0.1:${server.port}`,
        });

        expect(result).toEqual({
          stdout: "",
          stderr: JSON.stringify({
            status: "error",
            error: {
              kind,
              code: `${kind}_failure`,
              message: `${kind} failure`,
              retryable: kind === "timeout" || kind === "unavailable",
            },
          }).concat("\n"),
          exitCode,
        });
      }
    } finally {
      server.stop(true);
    }
  });

  it("pretty-prints semantic failures to stderr", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({
          status: "error",
          error: {
            kind: "conflict",
            code: "already_exists",
            message: "already exists",
            retryable: false,
          },
        });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["demo.conflict", "--input={}", "--output=json-pretty"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result).toEqual({
        stdout: "",
        stderr:
          '{\n  "status": "error",\n  "error": {\n    "kind": "conflict",\n    "code": "already_exists",\n    "message": "already exists",\n    "retryable": false\n  }\n}\n',
        exitCode: 5,
      });
    } finally {
      server.stop(true);
    }
  });

  it("suggests a nearby callable when an HTTP error reports an unknown callable", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/list") {
          return new Response(
            JSON.stringify({
              tools: [{ callableId: "workflow.run.trigger" }, { callableId: "fs.read" }],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }

        if (url.pathname === "/call") {
          await req.text();
          return new Response(
            JSON.stringify({ message: "Unknown callable ID 'workflo.run.trigger'" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["workflo.run.trigger", "--input={}"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        status: "error",
        error: {
          kind: "not_found",
          code: "http_not_found",
          message:
            "Unknown callable ID 'workflo.run.trigger'. Did you mean 'workflow.run.trigger'?",
          retryable: false,
        },
      });
    } finally {
      server.stop(true);
    }
  });

  it("projects HTTP failures into the server tool taxonomy", async () => {
    const cases = [
      ["usage", 400, 2],
      ["denied", 403, 3],
      ["conflict", 409, 5],
      ["timeout", 408, 7],
      ["unavailable", 503, 6],
    ] as const;
    const statuses = new Map(cases.map(([name, status]) => [`demo.${name}`, status]));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { callableId: string };
        return Response.json(
          { message: `${body.callableId} failed` },
          { status: statuses.get(body.callableId) ?? 500 },
        );
      },
    });

    try {
      for (const [kind, _status, exitCode] of cases) {
        const result = await runToolBridgeCli({
          args: [`demo.${kind}`, "--input={}"],
          backendUrl: `http://127.0.0.1:${server.port}`,
        });

        expect(result.exitCode).toBe(exitCode);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toEqual({
          status: "error",
          error: {
            kind,
            code: `http_${kind}`,
            message: `Failed to call tool: demo.${kind} failed`,
            retryable: kind === "timeout" || kind === "unavailable",
          },
        });
      }
    } finally {
      server.stop(true);
    }
  });

  it("extracts current Elysia errors but ignores legacy non-2xx output", async () => {
    const secret = "legacy-error-output-secret";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { callableId: string };
        if (body.callableId === "demo.current") {
          return Response.json(
            { error: { message: "Current Elysia validation detail" } },
            { status: 422 },
          );
        }
        return new Response(JSON.stringify({ isError: true, output: secret }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        });
      },
    });

    try {
      const current = await runToolBridgeCli({
        args: ["demo.current", "--input={}"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });
      const legacy = await runToolBridgeCli({
        args: ["demo.legacy", "--input={}"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(JSON.parse(current.stderr)).toMatchObject({
        error: {
          kind: "usage",
          message: "Failed to call tool: Current Elysia validation detail",
        },
      });
      expect(JSON.parse(legacy.stderr)).toMatchObject({
        error: { kind: "usage", message: "Failed to call tool: 400 Bad Request" },
      });
      expect(legacy.stderr).not.toContain(secret);
    } finally {
      server.stop(true);
    }
  });

  it("rejects legacy tool-call responses without leaking their payload", async () => {
    const secret = "secret-api-key-value";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ isError: false, output: { token: secret } });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["demo.echo", "--input={}"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        status: "error",
        error: {
          kind: "internal",
          code: "malformed_response",
          message: "Backend returned an invalid tool call response",
          retryable: false,
        },
      });
      expect(result.stderr).not.toContain(secret);
    } finally {
      server.stop(true);
    }
  });

  it("rejects malformed stdin JSON without leaking parser input", async () => {
    const secret = "secret-token-in-malformed-json";
    const result = await runToolBridgeCli({
      args: ["demo.echo", "--stdin"],
      backendUrl: "http://127.0.0.1:1",
      stdin: `{"token":"${secret}"`,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      status: "error",
      error: {
        kind: "usage",
        code: "invalid_json",
        message: "--input/--stdin is not valid JSON",
        retryable: false,
      },
    });
    expect(result.stderr).not.toContain(secret);
  });

  it("rejects incomplete help responses before using positional metadata", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ primaryPositional: { field: "url" } });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["fetch", "https://example.com"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        status: "error",
        error: {
          kind: "internal",
          code: "malformed_response",
          message: "Backend returned an invalid tool help response",
          retryable: false,
        },
      });
    } finally {
      server.stop(true);
    }
  });

  it("preserves OS SIGTERM and SIGINT behavior while a tool call is in flight", async () => {
    const cases = [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const;

    for (const [signal, expectedExitCode] of cases) {
      const requestStarted = Promise.withResolvers<void>();
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          requestStarted.resolve();
          return new Promise<Response>(() => {});
        },
      });
      const proc = Bun.spawn(["bun", CLIENT_ENTRY, "demo.wait", "--input={}"], {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          TOOL_SERVER_BACKEND_URL: `http://127.0.0.1:${server.port}`,
          NO_COLOR: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const guard = setTimeout(
        () => requestStarted.reject(new Error("request did not start")),
        5_000,
      );

      try {
        await requestStarted.promise;
        clearTimeout(guard);
        proc.kill(signal);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(expectedExitCode);
        expect(stdout).toBe("");
        expect(stderr).toBe("");
      } finally {
        clearTimeout(guard);
        proc.kill();
        server.stop(true);
      }
    }
  });
});

describe("tool-bridge positional input", () => {
  it("builds workflow trigger input from JSON argument and progress flags", async () => {
    const parsed = expectOk(
      parseArgs([
        "workflow.run.trigger",
        "--scope=auto",
        "--name=audit-routes",
        '--args:json={"directory":"src"}',
        '--progress:json={"requestOrigin":true}',
      ]),
    );
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(expectOk(await buildToolInput(parsed))).toEqual({
      scope: "auto",
      name: "audit-routes",
      args: { directory: "src" },
      progress: { requestOrigin: true },
    });
  });

  it("parses a bare positional argument for tool calls", () => {
    const parsed = expectOk(parseArgs(["fetch", "https://example.com", "--mode=browser"]));

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.callableId).toBe("fetch");
    expect(parsed.positionalArgs).toEqual(["https://example.com"]);
    expect(parsed.fieldInputs).toEqual([{ field: "mode", value: "browser" }]);
  });

  it("treats bare tool flags as boolean true without consuming the next token", () => {
    const parsed = expectOk(parseArgs(["search", "query", "--case-sensitive", "next"]));

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.positionalArgs).toEqual(["query", "next"]);
    expect(parsed.fieldInputs).toEqual([{ field: "caseSensitive", value: true }]);
  });

  it("requires equals syntax for value-required control flags", () => {
    expectErrorMessage(
      parseArgs(["fetch", "--output", "json"]),
      "--output requires a value: --output=json|json-pretty",
    );
    expectErrorMessage(parseArgs(["fetch", "--input", "payload.json"]), "--input requires a value");
  });

  it("defaults to JSON and rejects removed compact output", () => {
    const parsed = expectOk(parseArgs(["fetch"]));
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;
    expect(parsed.outputMode).toBe("json");

    const onboarded = expectOk(parseArgs(["onboard", "--yes", "--no-sign"]));
    expect(onboarded.type).toBe("onboard");
    if (onboarded.type !== "onboard") return;
    expect(onboarded.outputMode).toBe("json");

    expectErrorMessage(
      parseArgs(["fetch", "--output=compact"]),
      "Invalid --output value 'compact' (expected json|json-pretty)",
    );
    expectErrorMessage(
      parseArgs(["onboard", "--output=compact"]),
      "Invalid --output value 'compact' (expected json|json-pretty)",
    );
  });

  it("supports `--` for positional values that begin with dashes", () => {
    const parsed = expectOk(parseArgs(["fetch", "--", "--literal-value"]));

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.positionalArgs).toEqual(["--literal-value"]);
  });

  it("maps the primary positional argument into tool input", async () => {
    const parsed = expectOk(parseArgs(["fetch", "https://example.com", "--format=text"]));
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(expectOk(await buildToolInput(parsed, { field: "url" }))).toEqual({
      url: "https://example.com",
      format: "text",
    });
  });

  it("keeps scalar primary positionals limited to one argument", async () => {
    const parsed = expectOk(parseArgs(["fetch", "https://example.com", "extra"]));
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expectErrorMessage(
      await buildToolInput(parsed, { field: "url" }),
      "Tool 'fetch' accepts at most one positional argument: <url>.",
    );
  });

  it("allows flags alongside variadic primary positionals", async () => {
    const parsed = expectOk(
      parseArgs([
        "attachment.add_files",
        "a.png",
        "b.png",
        '--filenames:json=["renamed-a.png","renamed-b.png"]',
      ]),
    );
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(expectOk(await buildToolInput(parsed, { field: "paths", variadic: true }))).toEqual({
      paths: ["a.png", "b.png"],
      filenames: ["renamed-a.png", "renamed-b.png"],
    });
  });

  it("rejects duplicate variadic positional and named input for the same field", async () => {
    const parsed = expectOk(
      parseArgs(["attachment.add_files", "a.png", '--input={"paths":["b.png"]}']),
    );
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expectErrorMessage(
      await buildToolInput(parsed, { field: "paths", variadic: true }),
      "Primary positional <paths...> conflicts with an existing 'paths' value",
    );
  });

  it("rejects positional input for tools without primary positional metadata", async () => {
    const parsed = expectOk(parseArgs(["search", "llms"]));
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expectErrorMessage(
      await buildToolInput(parsed),
      "Tool 'search' does not support positional input.",
    );
  });

  it("explains that space-separated tool flag values are not supported", async () => {
    const parsed = expectOk(parseArgs(["surface.messages.list", "--session-id", "#meeting-room"]));
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expectErrorMessage(
      await buildToolInput(parsed),
      "Bare --session-id was parsed as boolean true; if you meant to pass a value, use --session-id=<value>.",
    );
  });

  it("rejects duplicate positional and named input for the same field", async () => {
    const parsed = expectOk(
      parseArgs(["fetch", "https://example.com", "--url=https://other.example.com"]),
    );
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expectErrorMessage(
      await buildToolInput(parsed, { field: "url" }),
      "Primary positional <url> conflicts with an existing 'url' value",
    );
  });
});
