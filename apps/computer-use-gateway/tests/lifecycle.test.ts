import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Result, type Result as ResultType } from "better-result";
import { ComputerLifecycle } from "../src/lifecycle";
import { RunnerStore } from "../src/store";
import {
  decodeConfig,
  failure,
  storageFailure,
  type GatewayConfig,
  type GatewayFailure,
  type RunnerRecord,
  type RunnerReply,
  type RunnerRequest,
} from "../src/contracts";
import type { Container, RunnerDocker } from "../src/docker";

const sessionA = "a".repeat(64);
const sessionB = "b".repeat(64);
const config: GatewayConfig = {
  bearer: "test-only",
  bindAddress: "127.0.0.1",
  renderedHost: "https://vnc.example.com",
  portStart: 17000,
  portEnd: 17001,
  image: "test",
  database: ":memory:",
  seccomp: "test",
  owner: "test",
};

function value<T>(result: ResultType<T, GatewayFailure>): T {
  return result.match({
    ok: (item) => item,
    err: (error) => {
      throw error;
    },
  });
}

class Docker implements RunnerDocker {
  containers: Container[] = [];
  runtimes = new Map<string, string>();
  starts = 0;
  failList = false;
  failRemove = false;
  dead = new Set<string>();
  occupied = new Set<number>();
  execution: (() => Promise<ResultType<RunnerReply, GatewayFailure>>) | undefined;
  async list() {
    return this.failList
      ? Result.err(failure("unavailable", "Docker unavailable"))
      : Result.ok([...this.containers]);
  }
  async create(record: RunnerRecord) {
    const id = String(this.starts + this.containers.length + 1).padStart(64, "0");
    this.containers.push({
      id,
      generation: record.generation,
      session: record.session,
      running: false,
      port: record.port,
      bindAddress: config.bindAddress,
    });
    this.runtimes.set(id, randomUUID());
    return Result.ok(id);
  }
  async start(id: string) {
    this.starts++;
    const container = this.containers.find((item) => item.id === id)!;
    if (this.occupied.has(container.port!)) return Result.err(failure("binding", "Occupied"));
    container.running = true;
    return Result.ok(undefined);
  }
  async remove(id: string) {
    if (this.failRemove) return Result.err(failure("unavailable", "Removal failed"));
    this.containers = this.containers.filter((item) => item.id !== id);
    return Result.ok(undefined);
  }
  async call(id: string, request: RunnerRequest): Promise<ResultType<RunnerReply, GatewayFailure>> {
    if (this.dead.has(id)) return Result.err(failure("unavailable", "Runtime missing"));
    if (request.operation === "execute" && this.execution) return this.execution();
    return Result.ok({
      ok: true,
      generation: this.runtimes.get(id)!,
      ...(request.operation === "execute"
        ? { content: [{ type: "text", text: "done" }], isError: false }
        : {}),
    });
  }
}

const stores: RunnerStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function setup() {
  const store = value(RunnerStore.open(":memory:"));
  stores.push(store);
  const docker = new Docker();
  let time = 100000;
  const lifecycle = new ComputerLifecycle(store, docker, config, () => time);
  value(await lifecycle.reconcile());
  return {
    store,
    docker,
    lifecycle,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}

describe("computer lifecycle", () => {
  test("provision is serialized and preserves credentials, while sessions remain separate", async () => {
    const { lifecycle, docker, advance } = await setup();
    const [a, again] = await Promise.all([
      lifecycle.provision(sessionA),
      lifecycle.provision(sessionA),
    ]);
    expect(value(a).created).toBe(true);
    expect(value(again).created).toBe(false);
    expect(value(a).viewer_password).toBe(value(again).viewer_password);
    expect(value(a).generation).toBe(value(again).generation);
    advance(1000);
    const refreshed = value(await lifecycle.provision(sessionA, 20));
    expect(refreshed.idle_timeout_seconds).toBe(20);
    expect(value(await lifecycle.provision(sessionA)).idle_timeout_seconds).toBe(20);
    const b = value(await lifecycle.provision(sessionB));
    expect(b.viewer_url).not.toBe(value(a).viewer_url);
    expect(b.viewer_password).not.toBe(value(a).viewer_password);
    expect(docker.starts).toBe(2);
    expect((await lifecycle.provision("c".repeat(64))).isErr()).toBe(true);
  });

  test("binding conflicts try other allowed ports and release failed reservations", async () => {
    const { lifecycle, docker, store } = await setup();
    docker.occupied.add(17000);
    const result = value(await lifecycle.provision(sessionA));
    expect(result.viewer_url).toContain(":17001/");
    expect(value(store.list())).toHaveLength(1);
    expect(docker.containers).toHaveLength(1);
  });

  test("termination is durable before Docker removal, idempotent, and rotates reused-port credentials", async () => {
    const { lifecycle, docker, store } = await setup();
    const first = value(await lifecycle.provision(sessionA));
    docker.failRemove = true;
    expect((await lifecycle.terminate(sessionA)).isErr()).toBe(true);
    expect(value(store.list())[0]!.state).toBe("terminating");
    docker.failRemove = false;
    value(await lifecycle.reconcile());
    expect(value(store.list())).toEqual([]);
    expect(docker.containers).toEqual([]);
    value(await lifecycle.terminate(sessionA));
    const second = value(await lifecycle.provision(sessionA));
    expect(second.viewer_password).not.toBe(first.viewer_password);
  });

  test("startup retains only the intersection, does not respawn, and keeps recorded expiry", async () => {
    const { lifecycle, docker, store, advance } = await setup();
    value(await lifecycle.provision(sessionA));
    value(await lifecycle.provision(sessionB));
    const records = value(store.list());
    const expiry = records[0]!.expiresAt;
    docker.containers = docker.containers.filter((item) => item.session !== sessionB);
    docker.containers.push({
      id: "f".repeat(64),
      generation: randomUUID(),
      session: sessionB,
      port: 18000,
      bindAddress: "127.0.0.1",
      running: true,
    });
    advance(2000);
    value(await lifecycle.reconcile());
    expect(value(store.list())).toHaveLength(1);
    expect(docker.containers).toHaveLength(1);
    expect(value(store.list())[0]!.expiresAt).toBe(expiry);
    expect(docker.starts).toBe(2);
  });

  test("dead runtime errors permit startup cleanup and explicit replacement", async () => {
    const { lifecycle, docker, store } = await setup();
    const first = value(await lifecycle.provision(sessionA));
    docker.dead.add(value(store.list())[0]!.containerId!);
    const replacement = value(await lifecycle.provision(sessionA));
    expect(replacement.created).toBe(true);
    expect(replacement.generation).not.toBe(first.generation);
    docker.dead.add(value(store.list())[0]!.containerId!);
    value(await lifecycle.reconcile());
    expect(lifecycle.isReady()).toBe(true);
    expect(value(store.list())).toEqual([]);
    expect(docker.containers).toEqual([]);
  });

  test("startup removes published ports outside a narrowed allowed range", async () => {
    const { lifecycle, store, docker, now } = await setup();
    value(await lifecycle.provision(sessionA));
    value(await lifecycle.provision(sessionB));
    const narrowed = new ComputerLifecycle(store, docker, { ...config, portStart: 17001 }, now);
    value(await narrowed.reconcile());
    expect(value(store.list()).map((row) => row.port)).toEqual([17001]);
    expect(docker.containers).toHaveLength(1);
  });

  test("startup preserves persisted failure classification without touching Docker", async () => {
    const { lifecycle, store, docker } = await setup();
    const error = storageFailure("corrupt_fields", "Invalid computer lifecycle records");
    store.list = () => Result.err(error);
    let inspections = 0;
    docker.list = async () => {
      inspections++;
      return Result.ok([]);
    };
    const result = await lifecycle.reconcile();
    expect(result.match({ ok: () => null, err: (value) => value })).toBe(error);
    expect(inspections).toBe(0);
    expect(lifecycle.isReady()).toBe(false);
  });

  test("Docker unavailability preserves reservations and fails readiness", async () => {
    const { lifecycle, docker, store } = await setup();
    value(await lifecycle.provision(sessionA));
    docker.failList = true;
    expect((await lifecycle.reconcile()).isErr()).toBe(true);
    expect(lifecycle.isReady()).toBe(false);
    expect(value(store.list())).toHaveLength(1);
  });

  test("expiry and lost runtime require explicit provisioning", async () => {
    const { lifecycle, store, docker, advance } = await setup();
    expect((await lifecycle.execute(sessionA, "code")).isErr()).toBe(true);
    value(await lifecycle.provision(sessionA, 1));
    advance(1001);
    value(await lifecycle.expire());
    expect(value(store.list())).toEqual([]);
    value(await lifecycle.provision(sessionA));
    const row = value(store.list())[0]!;
    docker.runtimes.set(row.containerId!, randomUUID());
    expect((await lifecycle.execute(sessionA, "code")).isErr()).toBe(true);
    expect(value(store.list())).toEqual([]);
    expect(docker.starts).toBe(2);
  });

  test("active execution suppresses expiry and refreshes it after completion", async () => {
    const { lifecycle, docker, store, advance } = await setup();
    value(await lifecycle.provision(sessionA, 1));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ResultType<RunnerReply, GatewayFailure>>();
    docker.execution = () => {
      entered.resolve();
      return release.promise;
    };
    const execution = lifecycle.execute(sessionA, "code");
    await entered.promise;
    advance(2000);
    value(await lifecycle.expire());
    expect(value(store.list())).toHaveLength(1);
    release.resolve(
      Result.ok({
        ok: true,
        generation: value(store.list())[0]!.runtimeId!,
        content: [{ type: "text", text: "done" }],
      }),
    );
    expect(value(await execution).content.at(-1)).toMatchObject({ type: "text" });
    value(await lifecycle.expire());
    expect(value(store.list())).toHaveLength(1);
  });

  test("expiry rechecks a refreshed session after waiting for another session's cleanup", async () => {
    const { lifecycle, docker, store, advance } = await setup();
    value(await lifecycle.provision(sessionA, 1));
    value(await lifecycle.provision(sessionB, 1));
    const records = value(store.list());
    const a = records.find((record) => record.session === sessionA)!;
    const b = records.find((record) => record.session === sessionB)!;
    const executing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<ResultType<RunnerReply, GatewayFailure>>();
    docker.execution = () => {
      executing.resolve();
      return finish.promise;
    };
    const execution = lifecycle.execute(sessionB, "code");
    await executing.promise;
    advance(2000);
    const removing = Promise.withResolvers<void>();
    const remove = Promise.withResolvers<void>();
    const originalRemove = docker.remove.bind(docker);
    docker.remove = async (id) => {
      if (id === a.containerId) {
        removing.resolve();
        await remove.promise;
      }
      return originalRemove(id);
    };
    const cleanup = lifecycle.expire();
    await removing.promise;
    finish.resolve(Result.ok({ ok: true, generation: b.runtimeId!, content: [] }));
    value(await execution);
    remove.resolve();
    value(await cleanup);
    expect(value(store.list()).map((record) => record.generation)).toEqual([b.generation]);
    expect(docker.containers.map((container) => container.session)).toEqual([sessionB]);
  });

  test("uncertain execution removes the runner without replay", async () => {
    const { lifecycle, docker, store } = await setup();
    value(await lifecycle.provision(sessionA));
    let calls = 0;
    docker.execution = async () => {
      calls++;
      return Result.err(failure("timeout", "Deadline"));
    };
    expect((await lifecycle.execute(sessionA, "code")).isErr()).toBe(true);
    expect(calls).toBe(1);
    expect(value(store.list())).toEqual([]);
    expect((await lifecycle.execute(sessionA, "code")).isErr()).toBe(true);
    expect(calls).toBe(1);
  });

  test("incomplete reservations and expired rows are removed at startup", async () => {
    const { lifecycle, store, docker, advance } = await setup();
    value(await lifecycle.provision(sessionA, 1));
    value(await lifecycle.provision(sessionB));
    const b = value(store.list()).find((row) => row.session === sessionB)!;
    value(store.update({ ...b, state: "provisioning" }));
    advance(1001);
    value(await lifecycle.reconcile());
    expect(value(store.list())).toEqual([]);
    expect(docker.containers).toEqual([]);
    expect(docker.starts).toBe(2);
  });
});

test("configuration separates bind address and rendered origin", () => {
  expect(
    value(
      decodeConfig({
        MCP_BEARER_SECRET: "test",
        BIND_ADDR: "0.0.0.0",
        RENDERED_HOST: "https://vnc.example.com",
      }),
    ),
  ).toMatchObject({ bindAddress: "0.0.0.0", renderedHost: "https://vnc.example.com" });
  for (const env of [
    {},
    { MCP_BEARER_SECRET: "test", PORT_RANGE_START: "2", PORT_RANGE_END: "1" },
    { MCP_BEARER_SECRET: "test", RENDERED_HOST: "https://user:password@host" },
  ])
    expect(decodeConfig(env).isErr()).toBe(true);
});
