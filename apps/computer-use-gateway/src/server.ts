import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import { failure, idleTimeoutSchema, decodeSessionHeader, type GatewayFailure } from "./contracts";
import type { ComputerLifecycle } from "./lifecycle";

const execution = `Run Python in the provisioned desktop with top-level await. The runtime provides cua, cua_tools, and display without imports or client setup.

Start:
1. Call provision and wait for success before executing code. Tool discovery alone does not establish that a desktop exists. Provisioning initializes a driver session named "lilac" with desktop capture; use that name where a command requires session.
2. On first use, list commands with print(await cua_tools()) and inspect the desktop with display(await cua("get_desktop_state", session="lilac")). Read the returned state before choosing actions.
3. Before using an unfamiliar command, read its argument schema with print(await cua_tools(name)), for example print(await cua_tools("click")). Call it with await cua(name, **arguments) using the discovered schema.
4. Check each result's is_error before continuing dependent actions. After a short action sequence, inspect the desktop again and verify the intended change. Use coordinates from the returned screenshot pixels. After user intervention, inspect again before resuming.

Output: cua returns a ToolResult with text, images, structured_json, and is_error. display(result) emits its text and screenshots; display(image_bytes, mime_type="image/png") emits raw image bytes. Use print for text and schemas.

Lifetime: Desktop state, files, and Python variables persist across calls and turns until idle expiry, termination, or runtime failure. Pending Python async tasks are cancelled when a call ends. Use terminate when the desktop task is complete; keep the desktop alive while awaiting user input or sharing its viewer for assistance.

Limits: Code is limited to 32000 characters, execution to 120 seconds, text to 64 KiB, and images to eight / 12 MiB total base64. An uncertain execution destroys the runner. Call provision for a fresh desktop, inspect the current application state, and determine what completed before continuing; never replay uncertain actions automatically.`;

type Operations = Pick<ComputerLifecycle, "isReady" | "provision" | "execute" | "terminate">;

function toolFailure(error: GatewayFailure): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${error.code}: ${error.message}` }],
  };
}

function metadata<T extends Record<string, string | number | boolean>>(
  result: ResultType<T, GatewayFailure>,
): CallToolResult {
  return result.match({
    ok: (value) => ({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    }),
    err: toolFailure,
  });
}

function authorized(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createGatewayHandler(lifecycle: Operations, bearer: string) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health")
      return new Response(lifecycle.isReady() ? "ready" : "unavailable", {
        status: lifecycle.isReady() ? 200 : 503,
      });
    if (path !== "/mcp") return new Response("Not found", { status: 404 });
    if (!authorized(request, bearer))
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    if (!lifecycle.isReady()) return new Response("Gateway unavailable", { status: 503 });
    const session = decodeSessionHeader(request.headers.get("x-lilac-session-hash"));
    const server = new McpServer({ name: "lilac-computer-use", version: "0.1.0" });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    server.registerTool(
      "provision",
      {
        description:
          "Create this Lilac session's desktop or retrieve its existing desktop. Wait for success before calling execute. Returns generation, viewer_url, and viewer_password; created: false means the existing desktop was reused. The default idle timeout is 3600 seconds. Repeated calls refresh expiry and preserve the existing timeout unless idle_timeout_seconds is supplied.",
        inputSchema: z.strictObject({ idle_timeout_seconds: idleTimeoutSchema.optional() }),
      },
      async (args, extra) => {
        if (!session)
          return toolFailure(failure("invalid", "Missing or invalid Lilac session header"));
        return metadata(
          await lifecycle.provision(
            session,
            args.idle_timeout_seconds,
            AbortSignal.any([request.signal, extra.signal]),
          ),
        );
      },
    );
    server.registerTool(
      "execute",
      { description: execution, inputSchema: z.strictObject({ code: z.string().max(32000) }) },
      async (args, extra) => {
        if (!session)
          return toolFailure(failure("invalid", "Missing or invalid Lilac session header"));
        return (
          await lifecycle.execute(
            session,
            args.code,
            AbortSignal.any([request.signal, extra.signal]),
          )
        ).match<CallToolResult>({ ok: (value) => value, err: toolFailure });
      },
    );
    server.registerTool(
      "terminate",
      {
        description:
          "Remove this Lilac session's desktop, files, and Python state when the desktop task is complete. Keep it alive while awaiting user input or sharing its viewer for assistance. Succeeds if already absent. A later provision creates a fresh desktop with new credentials.",
        inputSchema: z.strictObject({}),
      },
      async () => {
        if (!session)
          return toolFailure(failure("invalid", "Missing or invalid Lilac session header"));
        return metadata((await lifecycle.terminate(session)).map(() => ({ status: "terminated" })));
      },
    );
    const result = await Result.tryPromise({
      try: async () => {
        await server.connect(transport);
        return await transport.handleRequest(request);
      },
      catch: () => failure("unavailable", "MCP request failed"),
    });
    await server.close();
    return result.match({
      ok: (response) => response,
      err: () => new Response("MCP request failed", { status: 500 }),
    });
  };
}
