import { spyOn } from "bun:test";
import * as nativeRuntime from "../../../src/surface/native/runtime";

let holdIngressStop = false;
const continueStop = Promise.withResolvers<void>();
const createNativeRuntime = nativeRuntime.createNativeRuntime;
spyOn(nativeRuntime, "createNativeRuntime").mockImplementation(async (options) => {
  const result = await createNativeRuntime(options);
  if (result.isErr()) return result;
  const stopIngress = result.value.stopIngress;
  result.value.stopIngress = async () => {
    if (holdIngressStop) {
      process.send?.({ phase: "ingress-stop-held" });
      await continueStop.promise;
    }
    await stopIngress();
  };
  return result;
});
const { createCoreRuntime } = await import("../../../src/runtime/create-core-runtime");

const created = await createCoreRuntime({
  cwd: process.env.LILAC_WORKSPACE_DIR!,
  toolServerPort: Number(process.env.LL_TOOL_SERVER_PORT),
  subscriptionPrefix: "runtime-resilience",
  logLevel: "error",
  reportFatalError(error) {
    process.send?.({ phase: "fatal", error: error.message });
  },
});
if (created.kind === "panic") throw created.panic;
const runtime = created.result.unwrap();
const started = await runtime.start();
if (started.kind === "panic") throw started.panic;
started.result.unwrap();
process.send?.({ phase: "ready" });
process.on("message", (message: unknown) => {
  if (message === "continue-stop") {
    continueStop.resolve();
    return;
  }
  if (message !== "stop" && message !== "stop-held") return;
  holdIngressStop = message === "stop-held";
  const stopping = runtime.stop(null, Date.now() + 1_000);
  process.send?.({ phase: "stopping" });
  void stopping.then(
    () => {
      process.send?.({ phase: "stopped" });
      process.exit(0);
    },
    (error: Error) => {
      process.send?.({ phase: "fatal", error: error.message });
      process.exit(1);
    },
  );
});
