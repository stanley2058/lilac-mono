import { createCoreRuntime } from "../../../src/runtime/create-core-runtime";

const created = await createCoreRuntime({
  cwd: process.env.LILAC_WORKSPACE_DIR!,
  toolServerPort: Number(process.env.LL_TOOL_SERVER_PORT),
  subscriptionPrefix: "e2e",
  logLevel: process.env.LILAC_E2E_LOG_LEVEL === "debug" ? "debug" : "error",
  reportFatalError(error) {
    process.send?.({ phase: "fatal", error: error.stack ?? error.message });
  },
});
if (created.kind === "panic") throw created.panic;
const runtime = created.result.unwrap();
const started = await runtime.start();
if (started.kind === "panic") throw started.panic;
started.result.unwrap();
process.send?.({ phase: "ready" });
process.on("message", (message: unknown) => {
  if (message !== "stop") return;
  void runtime.stop(null, Date.now() + 5_000).then(
    () => {
      process.send?.({ phase: "stopped" });
      process.exit(0);
    },
    (error: Error) => {
      process.send?.({ phase: "fatal", error: error.stack ?? error.message });
      process.exit(1);
    },
  );
});
