import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolServer } from "../src/tool-server/create-tool-server";
import { RequestControlAuthority } from "../src/tool-server/request-control-authority";
import { Skills } from "../src/tool-server/tools/skills";

const bridgeDir = path.resolve(import.meta.dir, "../../tool-bridge");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cli-"));
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
  const content =
    "---\nname: boundary-skill\ndescription: CLI boundary fixture\n---\nRead from the live workspace.\n";
  const skillDir = path.join(cwd, ".claude/skills/boundary-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content);
  const authority = new RequestControlAuthority();
  const capability = authority.issue({
    kind: "heartbeat",
    requestId: "cli-request",
    sessionId: "cli-session",
    platform: "unknown",
    principal: null,
    authenticatedOrigin: null,
    allowedCallables: ["skills.list", "skills.read"],
    profile: "primary",
    canonicalCwd: cwd,
    safetyMode: "trusted",
    expiresAt: Date.now() + 60_000,
  });
  const server = createToolServer({
    tools: [new Skills()],
    canonicalWorkspaceRoot: cwd,
    operatorTokenSha256: createHash("sha256").update("a".repeat(43)).digest("hex"),
    authorizeControlRequest: (input) => authority.authorize(input),
  });
  const requests: Array<{ pathname: string; headers: Headers }> = [];
  server.app.onRequest(({ request }) => {
    requests.push({
      pathname: new URL(request.url).pathname,
      headers: new Headers(request.headers),
    });
  });
  cleanups.push(() => server.stop());
  await server.init();
  await server.start(0);
  const url = `http://127.0.0.1:${server.app.server!.port}`;
  async function run(args: string[], stdin = "", launcher = false) {
    args = [...args, "--output=json"];
    const child = Bun.spawn(
      launcher
        ? [path.join(bridgeDir, "dist/tools"), ...args]
        : [process.execPath, path.join(bridgeDir, "client.ts"), ...args],
      {
        cwd,
        stdin: new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          TOOL_SERVER_BACKEND_URL: url,
          TOOL_SERVER_BACKEND_SOCKET: "",
          LILAC_REQUEST_ID: "cli-request",
          LILAC_SESSION_ID: "cli-session",
          LILAC_TOOL_CALL_ID: "cli-tool-call",
          LILAC_REQUEST_CLIENT: "unknown",
          LILAC_CONTROL_CAPABILITY: capability,
          LILAC_CWD: "/stale/inherited/workspace",
          LILAC_TOOL_WORKER_DIR: path.join(cwd, "workers"),
          LILAC_OPERATOR_TOKEN_FILE: path.join(cwd, "bad-token"),
        },
      },
    );
    const deadline = setTimeout(() => child.kill(), 8_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(deadline);
    }
  }
  return { cwd, content, requests, run, url };
}

describe("tools CLI against Core", () => {
  it("discovers, validates and calls real skills with live invocation headers", async () => {
    const { cwd, content, requests, run, url } = await fixture();
    const listed = await run(["--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("skills.read");
    expect(listed.stdout).toContain("skills.list");
    const help = await run(["skills.read", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("skills.read");
    expect(help.stdout).toContain("--name");
    for (const [args, stdin] of [
      [["skills.read", '--input={"name":"boundary-skill"}'], ""],
      [["skills.read", "--stdin"], '{"name":"boundary-skill"}'],
    ] as const) {
      const result = await run([...args], stdin);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ content });
    }
    const unknown = await run(["missing.callable", "--input={}"]);
    expect(unknown.code).toBe(4);
    expect(JSON.parse(unknown.stderr)).toMatchObject({
      status: "error",
      error: { kind: "not_found" },
    });
    const invalid = await run(["skills.read", '--input={"name":42}']);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ status: "error", error: { kind: "usage" } });
    await fs.writeFile(path.join(cwd, "bad-token"), "b".repeat(43));
    const denied = await run(["--operator", "--list"]);
    expect(denied.code).toBe(3);
    expect(JSON.parse(denied.stderr)).toMatchObject({ status: "error", error: { kind: "denied" } });
    const version = await run(["--version"]);
    expect(version.code).toBe(0);
    const backend = await (await fetch(`${url}/versionz`)).json();
    expect(backend.ok).toBe(true);
    expect(backend.pid).toBe(process.pid);
    expect(typeof backend.commit).toBe("string");
    expect(version.stdout).toContain("tools");
    expect(version.stdout).toContain(backend.commit);
    expect(version.stdout).toContain("[build: dev]");
    expect(requests.some((request) => request.pathname === "/versionz")).toBe(true);
    const calls = requests.filter((request) => request.pathname === "/call");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const { headers } of calls) {
      expect(headers.get("x-lilac-request-id")).toBe("cli-request");
      expect(headers.get("x-lilac-session-id")).toBe("cli-session");
      expect(headers.get("x-lilac-request-client")).toBe("unknown");
      expect(headers.get("x-lilac-tool-call-id")).toBe("cli-tool-call");
      expect(headers.get("x-lilac-cwd")).toBe(cwd);
      expect(headers.get("x-lilac-control-capability")).toBeTruthy();
    }
  });

  const hasGo = Bun.which("go") !== null;
  beforeAll(async () => {
    if (!hasGo) return;
    const build = Bun.spawn([process.execPath, "run", "build"], {
      cwd: bridgeDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
      new Response(build.stdout).text(),
    ]);
    expect(code, stderr).toBe(0);
  }, 60_000);
  it.skipIf(!hasGo)(
    "calls Core through dist/tools (requires Go; CI installs Go)",
    async () => {
      const { cwd, content, run, requests } = await fixture();
      try {
        const result = await run(["skills.read", '--input={"name":"boundary-skill"}'], "", true);
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ content });
        const call = requests.find((request) => request.pathname === "/call");
        expect(call?.headers.get("x-lilac-cwd")).toBe(cwd);
        expect(call?.headers.get("x-lilac-request-id")).toBe("cli-request");
      } finally {
        const workerDir = path.join(cwd, "workers", String(process.geteuid!()));
        const sockets = await fs.readdir(workerDir).catch(() => []);
        for (const socket of sockets.filter((name) => name.endsWith(".sock"))) {
          await fetch("http://localhost/shutdown", {
            method: "POST",
            unix: path.join(workerDir, socket),
          });
        }
      }
    },
    10_000,
  );
});
