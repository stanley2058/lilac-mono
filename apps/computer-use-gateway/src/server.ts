import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import { failure, idleTimeoutSchema, decodeSessionHeader, type GatewayFailure } from "./contracts";
import type { ComputerLifecycle } from "./lifecycle";

const usage =
  "Call provision before execute. State and Python variables persist until idle expiry, termination, or runtime failure, across turns. Inspect current computer state before acting and verify after short action sequences. Manual intervention during agent execution has undefined behavior. Files are temporary. Terminate when finished; leave a blocked desktop alive when sharing its viewer URL.";
const execution = `${usage} Execute Python directly in the desktop container as cua, with top-level await. Use await cua(name, **arguments) to call the pinned CUA driver; it returns a ToolResult with text, images, structured_json, and is_error. Use display(result) to emit its text and screenshots, or display(image_bytes, mime_type="image/png"). print emits text. A CUA session named lilac is already active with desktop capture. Inspect with display(await cua("get_desktop_state", session="lilac")). Coordinates are pixels in the returned full-resolution image, normally 1440x900; do not rescale them. Use print(await cua_tools()) to list installed CUA tool names and print(await cua_tools("click")) to inspect one tool and its argument schema. Variables persist, but pending Python async tasks are cancelled when a call ends. Limit each code argument to 32000 characters; execution has a 120-second deadline, text is limited to 64 KiB and images to eight / 12 MiB total base64. An uncertain execution destroys the runner; call provision explicitly for a fresh desktop and never replay uncertain actions automatically.`;

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
        description: `${usage} Provision a desktop or retrieve its current viewer URL and password. The default idle timeout is 3600 seconds; repeated calls refresh expiry and preserve the existing timeout unless supplied.`,
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
          "Remove this session's desktop and temporary files. Succeeds if already absent. A later provision creates a fresh desktop with new credentials.",
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
