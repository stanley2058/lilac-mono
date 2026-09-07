import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { MCPClientConfig } from "@ai-sdk/mcp";
import { Result } from "better-result";
import { z } from "zod";
import type { McpConvertedTool } from "./registry-types";

export const LILAC_SESSION_HEADER = "x-lilac-session-hash";
const currentSession = new AsyncLocalStorage<string | undefined>();
const methodSchema = z.object({ method: z.string() });

export function hashMcpSession(sessionId: string): string {
  return createHash("sha256").update("lilac:mcp-session:v1\0").update(sessionId).digest("hex");
}

export function decodeMcpRequestMethod(body: string): string | null {
  const decoded = Result.try({ try: (): unknown => JSON.parse(body), catch: () => null });
  const parsed = decoded.match({ ok: (value) => methodSchema.safeParse(value), err: () => null });
  return parsed?.success ? parsed.data.method : null;
}

export function bindMcpToolToSession(tool: McpConvertedTool, sessionId?: string): McpConvertedTool {
  const execute = tool.execute;
  if (!execute) return tool;
  const hash = sessionId === undefined ? undefined : hashMcpSession(sessionId);
  return {
    ...tool,
    execute: (input, options) => currentSession.run(hash, () => execute(input, options)),
  };
}

export function withMcpSessionHeaders(
  transport: MCPClientConfig["transport"],
): MCPClientConfig["transport"] {
  if ("start" in transport || transport.type !== "http") return transport;
  const fetchFn = transport.fetch ?? globalThis.fetch;
  const wrapped = async (...args: Parameters<typeof fetchFn>): Promise<Response> => {
    const request = new Request(...args);
    request.headers.delete(LILAC_SESSION_HEADER);
    const hash = currentSession.getStore();
    if (
      hash &&
      request.method === "POST" &&
      decodeMcpRequestMethod(await request.clone().text()) === "tools/call"
    ) {
      request.headers.set(LILAC_SESSION_HEADER, hash);
    }
    return fetchFn(request);
  };
  return { ...transport, fetch: Object.assign(wrapped, fetchFn) };
}
