import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildToolInput,
  buildVersionTags,
  isMainModule,
  parseArgs,
  resolveBuildId,
} from "./client";

const CLIENT_ENTRY = path.join(import.meta.dir, "client.ts");

async function runToolBridgeCli(params: {
  args: readonly string[];
  backendUrl: string;
  stdin?: string;
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLIENT_ENTRY, ...params.args], {
    cwd: import.meta.dir,
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

describe("tool-bridge entrypoint detection", () => {
  it("treats the generated dist index wrapper as the main CLI entrypoint", () => {
    expect(
      isMainModule(
        [
          "/usr/bin/bun",
          "/workspace/apps/tool-bridge/dist/index.js",
          "fetch",
          "https://example.com",
        ],
        "/workspace",
        "/workspace/apps/tool-bridge/dist/client.js",
      ),
    ).toBe(true);
  });

  it("treats a symlinked `tools` entrypoint as the main CLI entrypoint", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "tool-bridge-"));

    try {
      const distDir = path.join(root, "dist");
      const binDir = path.join(root, "bin");
      const clientPath = path.join(distDir, "client.js");
      const indexPath = path.join(distDir, "index.js");
      const toolsPath = path.join(binDir, "tools");

      await fs.mkdir(distDir, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(clientPath, 'console.log("client");\n');
      await fs.writeFile(indexPath, 'import "./client.js";\n');
      await fs.symlink(indexPath, toolsPath);

      expect(isMainModule(["/usr/bin/bun", toolsPath, "--list"], root, clientPath)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("tool-bridge build id", () => {
  it("hashes the built client artifact and trims to 8 characters", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "tool-bridge-"));

    try {
      const distDir = path.join(root, "dist");
      const clientPath = path.join(distDir, "client.js");
      const indexPath = path.join(distDir, "index.js");
      const clientSource = 'console.log("built client");\n';
      const expected = createHash("sha256").update(clientSource).digest("hex").slice(0, 8);

      await fs.mkdir(distDir, { recursive: true });
      await fs.writeFile(clientPath, clientSource);
      await fs.writeFile(indexPath, 'import "./client.js";\n');

      await expect(resolveBuildId(clientPath)).resolves.toBe(expected);
      await expect(resolveBuildId(indexPath)).resolves.toBe(expected);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to dev when running from source", async () => {
    await expect(resolveBuildId("/workspace/apps/tool-bridge/client.ts")).resolves.toBe("dev");
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
      ),
    ).toEqual(["[commit: abc123def456]", "[build: deadbeef]", "[app-dirty]", "[plugins: 2]"]);
  });
});

describe("tool-bridge CLI runtime", () => {
  it("posts stdin JSON to the backend and forwards Lilac request headers", async () => {
    const requests: Array<{ pathname: string; headers: Headers; body: unknown }> = [];
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
            isError: false,
            output: {
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
        args: ["demo.echo", "--stdin", "--output=json"],
        backendUrl: `http://127.0.0.1:${server.port}`,
        stdin: JSON.stringify({ message: "hello", nested: { count: 2 } }),
        env: {
          LILAC_REQUEST_ID: "request-123",
          LILAC_SESSION_ID: "session-456",
          LILAC_REQUEST_CLIENT: "test-client",
          LILAC_CWD: "/workspace/project",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout) as unknown).toEqual({ ok: true, value: 42 });

      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (!request) {
        throw new Error("expected backend request");
      }
      expect(request.pathname).toBe("/call");
      expect(request.headers.get("content-type")).toContain("application/json");
      expect(request.headers.get("x-lilac-request-id")).toBe("request-123");
      expect(request.headers.get("x-lilac-session-id")).toBe("session-456");
      expect(request.headers.get("x-lilac-request-client")).toBe("test-client");
      expect(request.headers.get("x-lilac-cwd")).toBe("/workspace/project");
      expect(request.body).toEqual({
        callableId: "demo.echo",
        input: {
          message: "hello",
          nested: { count: 2 },
        },
      });
    } finally {
      server.stop(true);
    }
  });

  it("exits nonzero and writes stderr when the backend returns a tool error", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(JSON.stringify({ isError: true, output: "tool failed" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    try {
      const result = await runToolBridgeCli({
        args: ["demo.fail", "--input={}", "--output=json"],
        backendUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Error: tool failed");
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

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Unknown callable ID 'workflo.run.trigger'. Did you mean 'workflow.run.trigger'?",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("tool-bridge positional input", () => {
  it("builds workflow trigger input from JSON argument and progress flags", async () => {
    const parsed = parseArgs([
      "workflow.run.trigger",
      "--scope=auto",
      "--name=audit-routes",
      '--args:json={"directory":"src"}',
      '--progress:json={"requestOrigin":true}',
    ]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed)).resolves.toEqual({
      scope: "auto",
      name: "audit-routes",
      args: { directory: "src" },
      progress: { requestOrigin: true },
    });
  });

  it("parses a bare positional argument for tool calls", () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--mode=browser"]);

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.callableId).toBe("fetch");
    expect(parsed.positionalArgs).toEqual(["https://example.com"]);
    expect(parsed.fieldInputs).toEqual([{ field: "mode", value: "browser" }]);
  });

  it("treats bare tool flags as boolean true without consuming the next token", () => {
    const parsed = parseArgs(["search", "query", "--case-sensitive", "next"]);

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.positionalArgs).toEqual(["query", "next"]);
    expect(parsed.fieldInputs).toEqual([{ field: "caseSensitive", value: true }]);
  });

  it("requires equals syntax for value-required control flags", () => {
    expect(() => parseArgs(["fetch", "--output", "json"])).toThrow(
      "--output requires a value: --output=compact|json",
    );
    expect(() => parseArgs(["fetch", "--input", "payload.json"])).toThrow(
      "--input requires a value",
    );
  });

  it("supports `--` for positional values that begin with dashes", () => {
    const parsed = parseArgs(["fetch", "--", "--literal-value"]);

    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    expect(parsed.positionalArgs).toEqual(["--literal-value"]);
  });

  it("maps the primary positional argument into tool input", async () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--format=text"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "url" })).resolves.toEqual({
      url: "https://example.com",
      format: "text",
    });
  });

  it("keeps scalar primary positionals limited to one argument", async () => {
    const parsed = parseArgs(["fetch", "https://example.com", "extra"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "url" })).rejects.toThrow(
      "Tool 'fetch' accepts at most one positional argument: <url>.",
    );
  });

  it("maps variadic primary positionals into an array", async () => {
    const parsed = parseArgs(["attachment.add_files", "a.png", "b.png"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "paths", variadic: true })).resolves.toEqual({
      paths: ["a.png", "b.png"],
    });
  });

  it("allows flags alongside variadic primary positionals", async () => {
    const parsed = parseArgs([
      "attachment.add_files",
      "a.png",
      "b.png",
      '--filenames:json=["renamed-a.png","renamed-b.png"]',
    ]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "paths", variadic: true })).resolves.toEqual({
      paths: ["a.png", "b.png"],
      filenames: ["renamed-a.png", "renamed-b.png"],
    });
  });

  it("rejects duplicate variadic positional and named input for the same field", async () => {
    const parsed = parseArgs(["attachment.add_files", "a.png", '--input={"paths":["b.png"]}']);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "paths", variadic: true })).rejects.toThrow(
      "Primary positional <paths...> conflicts with an existing 'paths' value",
    );
  });

  it("rejects positional input for tools without primary positional metadata", async () => {
    const parsed = parseArgs(["search", "llms"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed)).rejects.toThrow(
      "Tool 'search' does not support positional input.",
    );
  });

  it("explains that space-separated tool flag values are not supported", async () => {
    const parsed = parseArgs(["surface.messages.list", "--session-id", "#meeting-room"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed)).rejects.toThrow(
      "Bare --session-id was parsed as boolean true; if you meant to pass a value, use --session-id=<value>.",
    );
  });

  it("rejects duplicate positional and named input for the same field", async () => {
    const parsed = parseArgs(["fetch", "https://example.com", "--url=https://other.example.com"]);
    expect(parsed.type).toBe("call");
    if (parsed.type !== "call") return;

    await expect(buildToolInput(parsed, { field: "url" })).rejects.toThrow(
      "Primary positional <url> conflicts with an existing 'url' value",
    );
  });
});
