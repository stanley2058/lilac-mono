import { describe, expect, it } from "bun:test";

import { createToolServer } from "../src/tool-server/create-tool-server";
import type { ServerTool } from "../src/tool-server/types";

describe("createToolServer", () => {
  it("passes x-lilac request context and cached messages to tool.call", async () => {
    const seenCalls: Array<{
      callableId: string;
      input: Record<string, unknown>;
      requestId?: string;
      sessionId?: string;
      requestClient?: string;
      cwd?: string;
      messages?: readonly unknown[];
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
  });
});
