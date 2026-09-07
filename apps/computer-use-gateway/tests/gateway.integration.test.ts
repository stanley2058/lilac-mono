import { expect, test } from "bun:test";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { z } from "zod";
import { McpRegistry } from "../../core/src/mcp/registry";
import { bindMcpToolToSession } from "../../core/src/mcp/session-context";

async function docker(args: string[], env = process.env) {
  const child = Bun.spawn(["docker", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`Docker test operation ${args[0]} failed: ${error}`);
  return output.trim();
}

async function ready(url: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await Promise.allSettled([fetch(url)]);
    const first = result[0]!;
    if (first.status === "fulfilled" && first.value.ok) return;
  }
  throw new Error("Gateway readiness deadline exceeded");
}

async function authenticateViewer(viewerUrl: string, password: string) {
  const url = new URL(viewerUrl);
  url.protocol = "ws:";
  url.pathname = "/websockify";
  const socket = new WebSocket(url, "binary");
  socket.binaryType = "arraybuffer";
  let bytes = Buffer.alloc(0);
  let notify = () => {};
  let closed = false;
  socket.onmessage = (event) => {
    bytes = Buffer.concat([bytes, Buffer.from(event.data)]);
    notify();
  };
  socket.onclose = () => {
    closed = true;
    notify();
  };
  socket.onerror = () => {
    closed = true;
    notify();
  };
  async function take(length: number) {
    while (bytes.length < length) {
      if (closed) throw new Error("VNC connection closed before authentication completed");
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    const result = bytes.subarray(0, length);
    bytes = bytes.subarray(length);
    return result;
  }
  try {
    expect((await take(12)).toString()).toBe("RFB 003.008\n");
    socket.send(Buffer.from("RFB 003.008\n"));
    const security = await take((await take(1))[0]!);
    expect(security.includes(2)).toBe(true);
    socket.send(new Uint8Array([2]));
    const challenge = await take(16);
    const key = Buffer.from(password, "ascii");
    for (let i = 0; i < key.length; i++) {
      let reversed = 0;
      for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((key[i]! >> bit) & 1);
      key[i] = reversed;
    }
    const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null);
    cipher.setAutoPadding(false);
    socket.send(Buffer.concat([cipher.update(challenge), cipher.final()]));
    expect((await take(4)).readUInt32BE()).toBe(0);
    socket.send(new Uint8Array([1]));
    const dimensions = await take(4);
    expect([dimensions.readUInt16BE(0), dimensions.readUInt16BE(2)]).toEqual([1440, 900]);
  } finally {
    socket.close();
  }
}

const viewerSchema = z.object({
  generation: z.string(),
  viewer_url: z.string(),
  viewer_password: z.string(),
  created: z.boolean(),
});

test.skipIf(process.env.LILAC_COMPUTER_DOCKER_TEST !== "1")(
  "Core MCP registry to container gateway, two desktops, restart, VNC, and sandboxed Chromium",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "lilac-computer-e2e-"));
    const owner = `test-${randomUUID()}`;
    const gateway = `lilac-gateway-${randomUUID()}`;
    const secret = randomBytes(24).toString("base64url");
    let registry: McpRegistry | undefined;
    try {
      await docker(
        [
          "run",
          "-d",
          "--name",
          gateway,
          "--publish",
          "127.0.0.1::8080",
          "--volume",
          "/var/run/docker.sock:/var/run/docker.sock",
          "--volume",
          `${dir}:/data`,
          "--env",
          "MCP_BEARER_SECRET",
          "--env",
          `GATEWAY_OWNER=${owner}`,
          "--env",
          "PORT_RANGE_START=18100",
          "--env",
          "PORT_RANGE_END=18109",
          "lilac-computer-gateway:local",
        ],
        { ...process.env, MCP_BEARER_SECRET: secret },
      );
      let address = await docker(["port", gateway, "8080/tcp"]);
      let url = `http://${address}/mcp`;
      await ready(`http://${address}/health`);
      registry = new McpRegistry({
        configPath: join(dir, "unused-mcp.yaml"),
        reportFatalError: (error) => {
          throw error;
        },
        dependencies: {
          readConfig: async () =>
            Result.ok({
              configPath: join(dir, "unused-mcp.yaml"),
              exists: true,
              config: {
                configVersion: 1,
                servers: {
                  computer_use: {
                    id: "computer_use",
                    transportConfig: {
                      transport: "http",
                      url,
                      headers: { Authorization: `Bearer ${secret}` },
                    },
                  },
                },
              },
            }),
        },
      });
      await registry.init();
      const tools = [...registry.getTools()];
      expect(tools).toHaveLength(3);
      const options = { toolCallId: "integration", messages: [], context: {} };
      async function call(
        session: string,
        name: string,
        input: Record<string, string | number> = {},
      ) {
        const entry = tools.find((tool) => tool.identity.rawToolName === name)!;
        const tool = bindMcpToolToSession(entry.tool, session);
        const result = await tool.execute!(input, options);
        if (Symbol.asyncIterator in result) throw new Error("Expected completed MCP result");
        return {
          result: z
            .object({
              content: z.array(
                z.discriminatedUnion("type", [
                  z.object({ type: z.literal("text"), text: z.string() }),
                  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
                ]),
              ),
              isError: z.boolean().optional(),
            })
            .parse(result),
          tool,
        };
      }
      function viewer(output: Awaited<ReturnType<typeof call>>) {
        const content = output.result.content;
        const text = content.find((part) => part.type === "text");
        if (!text || text.type !== "text") throw new Error("Missing viewer metadata");
        return viewerSchema.parse(JSON.parse(text.text));
      }
      const [first, second] = await Promise.all([
        call("session-A", "provision"),
        call("session-B", "provision"),
      ]);
      const a = viewer(first),
        b = viewer(second);
      expect(a.viewer_url !== b.viewer_url).toBe(true);
      expect(a.viewer_password !== b.viewer_password).toBe(true);
      await authenticateViewer(a.viewer_url, a.viewer_password);
      const before = await call("session-A", "execute", {
        code: 'answer = 40\ndisplay(await cua("get_desktop_state", session="lilac"))',
      });
      expect(before.result.isError).toBe(false);
      const image = before.result.content.find((part) => part.type === "image");
      expect(image?.type).toBe("image");
      if (image?.type !== "image") throw new Error("Screenshot missing");
      const png = Buffer.from(image.data, "base64");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1440, 900]);
      const projected = await before.tool.toModelOutput!({
        toolCallId: "integration",
        input: {},
        output: before.result,
      });
      expect(
        projected.type === "content" &&
          projected.value.some((part) => part.type === "file" && part.mediaType === "image/png"),
      ).toBe(true);
      const isolated = await call("session-B", "execute", {
        code: 'assert "answer" not in globals()',
      });
      expect(isolated.result.isError).toBe(false);
      await docker(["restart", "--time", "180", gateway]);
      address = await docker(["port", gateway, "8080/tcp"]);
      url = `http://${address}/mcp`;
      await ready(`http://${address}/health`);
      await registry.reload();
      tools.splice(0, tools.length, ...registry.getTools());
      const restored = viewer(await call("session-A", "provision"));
      expect(restored.created).toBe(false);
      expect(restored.generation === a.generation).toBe(true);
      expect(restored.viewer_password === a.viewer_password).toBe(true);
      const continued = await call("session-A", "execute", {
        code: 'answer += 2\nassert answer == 42\nimport subprocess\np = subprocess.run(["chromium", "--headless", "--disable-gpu", "--dump-dom", "about:blank"], capture_output=True, text=True, timeout=30)\nassert p.returncode == 0, p.stderr[-2000:]\nassert "<html>" in p.stdout',
      });
      expect(continued.result.isError).toBe(false);
      await call("session-A", "terminate");
      await call("session-A", "terminate");
      await call("session-B", "terminate");
      expect(
        await docker(["ps", "-aq", "--filter", `label=io.lilac.computer.owner=${owner}`]),
      ).toBe("");
    } finally {
      await registry?.shutdown();
      for (const id of (
        await docker(["ps", "-aq", "--filter", `label=io.lilac.computer.owner=${owner}`])
      )
        .split(/\s+/)
        .filter(Boolean))
        await docker(["rm", "-fv", id]);
      await docker(["rm", "-fv", gateway]);
      await rm(dir, { recursive: true, force: true });
    }
  },
  180000,
);
