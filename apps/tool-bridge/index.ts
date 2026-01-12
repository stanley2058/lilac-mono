import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";
import Elysia, { NotFoundError } from "elysia";
import type { ServerTool } from "./tools/type";
import { Summarize, Web } from "./tools";
import { env } from "@stanley2058/lilac-utils";
import {
  BridgeFnRequest,
  BridgeFnResponse,
  BridgeListResponse,
} from "./schema";

const logger = new Logger({
  logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
  module: "tool-bridge",
});

const tools: ServerTool[] = [new Web(), new Summarize()];

const initResult = await Promise.allSettled(tools.map((t) => t.init()));
for (const result of initResult) {
  if (result.status === "rejected") {
    logger.error({ error: result.reason });
  }
}

const callMapping = new Map<string, ServerTool>();
async function refreshToolMapping() {
  for (const tool of tools) {
    for (const { callableId } of await tool.list()) {
      callMapping.set(callableId, tool);
    }
  }
}
await refreshToolMapping();

const app = new Elysia();

app.onError(({ code, error }) => {
  logger.error({ code, error });
});

app.get(
  "/list",
  async () => {
    const toolDescs = await Promise.allSettled(tools.map((t) => t.list()));
    const succeeded = toolDescs
      .filter((t) => t.status === "fulfilled")
      .map((t) => t.value);

    return {
      tools: succeeded.flatMap((s) =>
        s.map((t) => ({
          callableId: t.callableId,
          name: t.name,
          description: t.description,
          shortInput: t.shortInput,
        })),
      ),
    };
  },
  {
    response: BridgeListResponse,
  },
);
app.post("/reload", async () => {
  await Promise.allSettled(tools.map((t) => t.destroy()));
  await Promise.allSettled(tools.map((t) => t.init()));
  await refreshToolMapping();
});
app.get("/help/:callableId", async ({ params }) => {
  const tool = callMapping.get(params.callableId);
  if (!tool) {
    throw new NotFoundError(`Unknown callable ID '${params.callableId}'`);
  }
  const desc = await tool.list();
  const output = desc.find((d) => d.callableId === params.callableId);
  if (!output) return new NotFoundError();
  return output;
});
app.post(
  "/call",
  async ({ body, request }) => {
    const tool = callMapping.get(body.callableId);
    if (!tool) {
      throw new NotFoundError(`Unknown callable ID '${body.callableId}'`);
    }

    try {
      const output = await tool.call(
        body.callableId,
        body.input,
        request.signal,
      );
      return { isError: false, output };
    } catch (e) {
      return {
        isError: true,
        output: e instanceof Error ? e.message : String(e),
      };
    }
  },
  {
    body: BridgeFnRequest,
    response: {
      200: BridgeFnResponse,
    },
  },
);

app.listen(env.toolServer.port ?? 8080);
logger.info(
  `Tool server listening on port ${app.server?.hostname}:${app.server?.port}`,
);

process.on("SIGINT", async () => {
  logger.info("Gracefully shutting down...");
  await Promise.allSettled(tools.map((t) => t.destroy()));

  app.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  logger.info("Gracefully shutting down...");
  await Promise.allSettled(tools.map((t) => t.destroy()));

  app.stop();
  process.exit(0);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Caught unhandled rejection at:", reason, promise);
});
