/**
 * A real MCP server for e2e scenarios, served over stdio or Streamable HTTP with the official SDK.
 * Usage: bun mcp-server.ts stdio | bun mcp-server.ts http <port>
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// One-pixel PNG.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function createServer(): McpServer {
  const server = new McpServer({ name: "e2e-fixture", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a message back with a marker.",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({ content: [{ type: "text", text: `mcp-echo:${message}` }] }),
  );
  server.registerTool(
    "weather",
    {
      description: "Structured forecast for a city.",
      inputSchema: { city: z.string() },
      outputSchema: { city: z.string(), celsius: z.number() },
    },
    async ({ city }) => {
      const forecast = { city, celsius: 21 };
      return {
        content: [{ type: "text", text: JSON.stringify(forecast) }],
        structuredContent: forecast,
      };
    },
  );
  server.registerTool(
    "pixel",
    { description: "Return a tiny PNG image.", inputSchema: {} },
    async () => ({
      content: [
        { type: "text", text: "Here is the pixel." },
        { type: "image", data: PIXEL, mimeType: "image/png" },
      ],
    }),
  );
  server.registerTool("explode", { description: "Always fails.", inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: "text", text: "mcp-failure: fixture refused" }],
  }));
  return server;
}

const [mode, port] = process.argv.slice(2);
if (mode === "http") {
  // Stateless Streamable HTTP: a new transport per request, as the SDK recommends for that mode.
  Bun.serve({
    hostname: "127.0.0.1",
    port: Number(port),
    async fetch(request) {
      if (new URL(request.url).pathname !== "/mcp")
        return new Response("Not found", { status: 404 });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await createServer().connect(transport);
      return transport.handleRequest(request);
    },
  });
  console.log("ready");
} else {
  await createServer().connect(new StdioServerTransport());
}
