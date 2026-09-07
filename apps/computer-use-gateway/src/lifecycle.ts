import { randomBytes, randomUUID } from "node:crypto";
import { Result, type Result as ResultType } from "better-result";
import {
  failure,
  viewerInfo,
  type GatewayConfig,
  type GatewayFailure,
  type RunnerRecord,
  type RunnerContent,
  type RunnerReply,
} from "./contracts";
import type { Container, RunnerDocker } from "./docker";
import { RunnerStore } from "./store";

export class ComputerLifecycle {
  private readonly sessions = new Map<string, Promise<void>>();
  private pending = 0;
  private ready = false;

  constructor(
    readonly store: RunnerStore,
    private readonly docker: RunnerDocker,
    readonly config: GatewayConfig,
    private readonly now: () => number = Date.now,
  ) {}

  isReady() {
    return this.ready;
  }

  private serial<T>(
    session: string,
    operation: () => Promise<ResultType<T, GatewayFailure>>,
  ): Promise<ResultType<T, GatewayFailure>> {
    if (!this.ready)
      return Promise.resolve(Result.err(failure("unavailable", "Gateway is not ready")));
    if (this.pending >= 256)
      return Promise.resolve(
        Result.err(failure("capacity", "Gateway pending request limit reached")),
      );
    this.pending++;
    const previous = this.sessions.get(session) ?? Promise.resolve();
    const execution = previous.then(operation);
    const settled = Promise.allSettled([execution]).then(() => undefined);
    this.sessions.set(session, settled);
    void settled.then(() => {
      this.pending--;
      if (this.sessions.get(session) === settled) this.sessions.delete(session);
    });
    return execution;
  }

  private matches(record: RunnerRecord, container: Container) {
    return (
      record.containerId === container.id &&
      record.generation === container.generation &&
      record.session === container.session &&
      record.port === container.port &&
      record.port >= this.config.portStart &&
      record.port <= this.config.portEnd &&
      this.config.bindAddress === container.bindAddress &&
      container.running
    );
  }

  private async discard(record: RunnerRecord) {
    const self = this;
    return Result.gen(async function* () {
      yield* self.store.update({ ...record, state: "terminating" });
      const containers = yield* Result.await(self.docker.list());
      for (const container of containers) {
        if (container.generation !== record.generation || container.session !== record.session)
          continue;
        yield* Result.await(self.docker.remove(container.id));
      }
      yield* self.store.remove(record);
      return Result.ok(undefined);
    });
  }

  async reconcile() {
    this.ready = false;
    const self = this;
    return Result.gen(async function* () {
      const records = yield* self.store.list();
      const containers = yield* Result.await(self.docker.list());
      const retained = new Set<string>();
      for (const record of records) {
        const container = containers.find((item) => self.matches(record, item));
        if (
          record.state === "ready" &&
          record.runtimeId &&
          record.expiresAt > self.now() &&
          container
        ) {
          const healthy = yield* Result.await(self.runtimeUsable(record, "health"));
          if (healthy) {
            retained.add(container.id);
            continue;
          }
        }
        yield* Result.await(self.discard(record));
      }
      for (const container of containers) {
        if (retained.has(container.id)) continue;
        yield* Result.await(self.docker.remove(container.id));
      }
      self.ready = true;
      return Result.ok(undefined);
    });
  }

  provision(session: string, idleSeconds?: number, signal?: AbortSignal) {
    return this.serial(session, () => this.provisionLocked(session, idleSeconds, signal));
  }

  private async waitForReady(containerId: string, signal?: AbortSignal) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (signal?.aborted) return Result.err(failure("cancelled", "Provisioning cancelled"));
      const probe = await this.docker.call(containerId, { operation: "health" }, signal);
      const reply = probe.match({ ok: (value) => value, err: () => null });
      if (reply?.ok) return Result.ok(reply.generation);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return Result.err(failure("timeout", "Desktop readiness deadline exceeded"));
  }

  private async provisionLocked(session: string, idleSeconds?: number, signal?: AbortSignal) {
    const self = this;
    return Result.gen(async function* () {
      if (signal?.aborted) return Result.err(failure("cancelled", "Provisioning cancelled"));
      const records = yield* self.store.list();
      const existing = records.find((record) => record.session === session);
      if (existing) {
        const live = yield* Result.await(self.existingInfo(existing));
        if (live) {
          const refreshed = {
            ...existing,
            idleSeconds: idleSeconds ?? existing.idleSeconds,
            expiresAt: self.now() + (idleSeconds ?? existing.idleSeconds) * 1000,
          };
          yield* self.store.update(refreshed);
          return Result.ok({
            ...viewerInfo(refreshed, self.config),
            created: false,
            message: "Runner already exists",
            viewer_password: refreshed.password,
          });
        }
        yield* Result.await(self.discard(existing));
      }
      for (let port = self.config.portStart; port <= self.config.portEnd; port++) {
        const current = yield* self.store.list();
        if (current.some((record) => record.port === port)) continue;
        const record: RunnerRecord = {
          session,
          generation: randomUUID(),
          containerId: null,
          runtimeId: null,
          port,
          state: "provisioning",
          password: randomBytes(6).toString("base64url"),
          idleSeconds: idleSeconds ?? 3600,
          expiresAt: self.now() + (idleSeconds ?? 3600) * 1000,
        };
        yield* self.store.reserve(record);
        const created = await self.createRunner(record, signal);
        const decision = created.match<{
          record: RunnerRecord | null;
          error: GatewayFailure | null;
        }>({
          ok: (value) => ({ record: value, error: null }),
          err: (error) => ({ record: null, error }),
        });
        if (decision.record)
          return Result.ok({
            ...viewerInfo(decision.record, self.config),
            created: true,
            message: "Runner created",
            viewer_password: decision.record.password,
          });
        yield* Result.await(self.discard(record));
        if (decision.error?.code === "binding") continue;
        return Result.err(decision.error ?? failure("unavailable", "Provisioning failed"));
      }
      return Result.err(failure("capacity", "No available runner port in the configured range"));
    });
  }

  private async createRunner(record: RunnerRecord, signal?: AbortSignal) {
    const self = this;
    return Result.gen(async function* () {
      const containerId = yield* Result.await(self.docker.create(record));
      yield* self.store.update({ ...record, containerId });
      yield* Result.await(self.docker.start(containerId));
      const runtimeId = yield* Result.await(self.waitForReady(containerId, signal));
      const ready: RunnerRecord = {
        ...record,
        containerId,
        runtimeId,
        state: "ready",
        expiresAt: self.now() + record.idleSeconds * 1000,
      };
      yield* self.store.update(ready);
      return Result.ok(ready);
    });
  }

  private async existingInfo(record: RunnerRecord) {
    const self = this;
    return Result.gen(async function* () {
      if (record.state !== "ready" || record.expiresAt <= self.now() || !record.containerId)
        return Result.ok(false);
      const containers = yield* Result.await(self.docker.list());
      if (!containers.some((item) => self.matches(record, item))) return Result.ok(false);
      return await self.runtimeUsable(record, "info");
    });
  }

  private async runtimeUsable(record: RunnerRecord, operation: "info" | "health") {
    if (!record.containerId) return Result.ok(false);
    const probe = await this.docker.call(record.containerId, { operation });
    const reply = probe.match({ ok: (value) => value, err: () => null });
    if (reply) return Result.ok(reply.ok && reply.generation === record.runtimeId);
    // A failed exec can mean a lost Python socket or a lost Docker daemon. Inspect before cleanup.
    return (await this.docker.list()).map(() => false);
  }

  execute(session: string, code: string, signal?: AbortSignal) {
    return this.serial(session, () => this.executeLocked(session, code, signal));
  }

  private async executeLocked(session: string, code: string, signal?: AbortSignal) {
    const self = this;
    return Result.gen(async function* () {
      if (signal?.aborted) return Result.err(failure("cancelled", "Execution cancelled"));
      const records = yield* self.store.list();
      const record = records.find((item) => item.session === session);
      if (!record)
        return Result.err(failure("not_provisioned", "Call provision before executing code"));
      const live = yield* Result.await(self.existingInfo(record));
      if (!live || !record.containerId) {
        yield* Result.await(self.discard(record));
        return Result.err(
          failure("not_provisioned", "Computer state was lost; call provision again"),
        );
      }
      const execution = await self.docker.call(
        record.containerId,
        { operation: "execute", code },
        signal,
      );
      const outcome = execution.match<{ reply: RunnerReply | null; error: GatewayFailure | null }>({
        ok: (value) => ({ reply: value, error: null }),
        err: (error) => ({ reply: null, error }),
      });
      if (
        !outcome.reply?.ok ||
        outcome.reply.generation !== record.runtimeId ||
        !outcome.reply.content
      ) {
        yield* Result.await(self.discard(record));
        return Result.err(
          outcome.error ??
            failure("unavailable", "Execution runtime was lost; call provision again"),
        );
      }
      const refreshed = { ...record, expiresAt: self.now() + record.idleSeconds * 1000 };
      yield* self.store.update(refreshed);
      const content: RunnerContent[] = [
        ...outcome.reply.content,
        { type: "text", text: JSON.stringify(viewerInfo(refreshed, self.config)) },
      ];
      return Result.ok({ content, isError: outcome.reply.isError ?? false });
    });
  }

  terminate(session: string) {
    return this.serial(session, async () => {
      const records = this.store.list();
      const decision = records.match<{
        record: RunnerRecord | undefined;
        error: GatewayFailure | null;
      }>({
        ok: (items) => ({ record: items.find((item) => item.session === session), error: null }),
        err: (error) => ({ record: undefined, error }),
      });
      if (decision.error) return Result.err(decision.error);
      if (!decision.record) return Result.ok(undefined);
      return this.discard(decision.record);
    });
  }

  async expire() {
    const self = this;
    return Result.gen(async function* () {
      const records = yield* self.store.list();
      for (const record of records) {
        if (self.sessions.has(record.session)) continue;
        if (record.state === "ready" && record.expiresAt > self.now()) continue;
        yield* Result.await(self.serial(record.session, () => self.expireSession(record.session)));
      }
      return Result.ok(undefined);
    });
  }

  private async expireSession(session: string) {
    const self = this;
    return Result.gen(async function* () {
      const records = yield* self.store.list();
      const current = records.find((record) => record.session === session);
      if (!current || (current.state === "ready" && current.expiresAt > self.now()))
        return Result.ok(undefined);
      return await self.discard(current);
    });
  }

  async drain() {
    this.ready = false;
    await Promise.all(this.sessions.values());
  }
}
