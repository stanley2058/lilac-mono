import { loadRunnerTemplate } from "./runner-template";
import { Result } from "better-result";
import { decodeConfig, failure } from "./contracts";
import { DockerCli } from "./docker";
import { createExpiryTick } from "./expiry";
import { ComputerLifecycle } from "./lifecycle";
import { createGatewayHandler } from "./server";
import { RunnerStore } from "./store";

async function main() {
  return Result.gen(async function* () {
    const config = yield* decodeConfig(process.env);
    const template = yield* Result.await(loadRunnerTemplate(config.runnerTemplatePath));
    const docker = new DockerCli(config, undefined, template);
    yield* Result.await(docker.validateMounts());
    const store = yield* RunnerStore.open(config.database);
    const lifecycle = new ComputerLifecycle(store, docker, config);
    const reconciled = await lifecycle.reconcile();
    const error = reconciled.match({ ok: () => null, err: (value) => value });
    if (error) {
      store.close();
      return Result.err(error);
    }
    const handler = createGatewayHandler(lifecycle, config.bearer);
    const listening = Result.try({
      try: () =>
        Bun.serve({
          port: 8080,
          hostname: "0.0.0.0",
          maxRequestBodySize: 262144,
          idleTimeout: 0,
          fetch: handler,
        }),
      catch: () => failure("unavailable", "Cannot listen on gateway port 8080"),
    });
    const server = listening.match({ ok: (value) => value, err: () => null });
    if (!server) {
      store.close();
      return Result.err(failure("unavailable", "Cannot listen on gateway port 8080"));
    }
    const timer = setInterval(
      createExpiryTick(
        () => lifecycle.expire(),
        (error) => console.error(error.message),
      ),
      10000,
    );
    console.info("Computer-use gateway listening on port 8080");
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    clearInterval(timer);
    await lifecycle.drain();
    await server.stop();
    store.close();
    return Result.ok(undefined);
  });
}

(await main()).match({
  ok: () => {},
  err: (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
});
