import { afterEach, describe, expect, it } from "bun:test";

import { Web } from "../../src/tool-server/tools/web";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

function startServer(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: handler,
  });
  servers.push(server);
  return server;
}

describe("web tool fetch", () => {
  it("propagates abort signals through fetch mode", async () => {
    const server = startServer(async () => {
      await Bun.sleep(200);
      return new Response("hello", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    });
    const tool = new Web();
    const controller = new AbortController();

    const promise = tool.call(
      "fetch",
      {
        url: `http://127.0.0.1:${server.port}/slow`,
        mode: "fetch",
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);

    await expect(promise).resolves.toMatchObject({
      isError: true,
      error: expect.stringMatching(/abort/i),
    });
  });

  it("rejects unsupported binary content types", async () => {
    const server = startServer(() => {
      return new Response("%PDF-1.7", {
        headers: {
          "content-type": "application/pdf",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/binary`,
        mode: "fetch",
      }),
    ).resolves.toMatchObject({
      isError: true,
      contentType: "application/pdf",
    });
  });

  it("rejects oversized responses before buffering them", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024 + 10);
    const server = startServer(() => {
      return new Response(oversized, {
        headers: {
          "content-type": "text/plain",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/oversized`,
        mode: "fetch",
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: expect.stringContaining("response too large"),
    });
  });

  it("falls back to simple extraction for large html pages", async () => {
    const repeatedScript = "<script>" + "x".repeat(800_000) + "</script>";
    const html = [
      "<!doctype html>",
      "<html><head><title>Large Page</title></head><body>",
      repeatedScript,
      "<main><h1>Important content</h1><p>Readable fallback text.</p></main>",
      "</body></html>",
    ].join("");
    const server = startServer(() => {
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/large`,
        mode: "fetch",
        format: "text",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Large Page",
      content: expect.stringContaining("Important content"),
    });
  });
});
