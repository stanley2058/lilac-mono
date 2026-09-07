import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as ResultType } from "better-result";
import { ComputerLifecycle } from "../src/lifecycle";
import { DockerCli, dockerCommand } from "../src/docker";
import { RunnerStore } from "../src/store";
import type { GatewayConfig, GatewayFailure } from "../src/contracts";

function value<T>(result: ResultType<T, GatewayFailure>): T {
  return result.match({
    ok: (item) => item,
    err: (error) => {
      throw new Error(`${error.code}: ${error.message}`);
    },
  });
}

test.skipIf(process.env.LILAC_COMPUTER_DOCKER_TEST !== "1")(
  "real Docker lifecycle, reconnect, screenshots, and cancellation",
  async () => {
    const config: GatewayConfig = {
      bearer: "unused-test",
      bindAddress: "127.0.0.1",
      renderedHost: "http://127.0.0.1",
      portStart: 17990,
      portEnd: 17999,
      image: "lilac-computer:local",
      database: ":memory:",
      seccomp: resolve(
        import.meta.dir,
        "../../..",
        "packages/computer-use-runner/seccomp-chromium.json",
      ),
      owner: `test-${randomUUID()}`,
    };
    const docker = new DockerCli(config);
    const store = value(RunnerStore.open(":memory:"));
    const session = "e".repeat(64);
    let lifecycle = new ComputerLifecycle(store, docker, config);
    try {
      value(await lifecycle.reconcile());
      const provisioned = value(await lifecycle.provision(session));
      expect(provisioned.created).toBe(true);
      expect((await fetch(provisioned.viewer_url)).status).toBe(200);
      value(await lifecycle.execute(session, "answer = 40"));
      await lifecycle.drain();
      lifecycle = new ComputerLifecycle(store, new DockerCli(config), config);
      value(await lifecycle.reconcile());
      const existing = value(await lifecycle.provision(session));
      expect(existing.created).toBe(false);
      expect(existing.generation).toBe(provisioned.generation);
      expect(existing.viewer_password).toBe(provisioned.viewer_password);
      const response = value(
        await lifecycle.execute(
          session,
          'answer += 2\nprint(answer)\ndisplay(await cua("get_desktop_state", session="lilac"))',
        ),
      );
      expect(response.isError).toBe(false);
      expect(response.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("42\n"),
      });
      expect(response.content.some((part) => part.type === "image")).toBe(true);
      const original = value(store.list())[0]!;
      const raced = new DockerCli(config, async (args, options) => {
        if (args[0] === "ps") return Result.ok(`${original.containerId}\n${"f".repeat(64)}\n`);
        return dockerCommand(args, options);
      });
      expect(value(await raced.list())).toHaveLength(1);
      const breakSocket = Bun.spawn(
        ["docker", "exec", original.containerId!, "rm", "/tmp/lilac-computer.sock"],
        { stdout: "ignore", stderr: "ignore" },
      );
      expect(await breakSocket.exited).toBe(0);
      value(await lifecycle.reconcile());
      expect(value(store.list())).toEqual([]);
      const fresh = value(await lifecycle.provision(session));
      expect(fresh.generation).not.toBe(provisioned.generation);
      const row = value(store.list())[0]!;
      const abort = new AbortController();
      const pending = lifecycle.execute(
        session,
        'import asyncio\nopen("/tmp/lilac-test-entered", "w").close()\nawait asyncio.Event().wait()',
        abort.signal,
      );
      const deadline = Date.now() + 10000;
      while (true) {
        const probe = Bun.spawn(
          ["docker", "exec", row.containerId!, "test", "-f", "/tmp/lilac-test-entered"],
          { stdout: "ignore", stderr: "ignore" },
        );
        if ((await probe.exited) === 0) break;
        if (Date.now() > deadline) throw new Error("Execution did not enter");
      }
      abort.abort();
      expect((await pending).isErr()).toBe(true);
      expect(value(store.list())).toEqual([]);
      expect(value(await docker.list())).toEqual([]);
      expect((await lifecycle.execute(session, "print(answer)")).isErr()).toBe(true);
      value(await lifecycle.terminate(session));
    } finally {
      for (const container of value(await docker.list())) value(await docker.remove(container.id));
      store.close();
    }
  },
  90000,
);
