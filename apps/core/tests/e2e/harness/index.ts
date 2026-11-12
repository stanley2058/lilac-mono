import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIsolatedRedis } from "../../../../../packages/event-bus/tests/helpers/isolated-redis";
import {
  prepareCore,
  startCore,
  type CoreConfigOptions,
  type CoreLayout,
  type CoreProcess,
} from "./core-process";
import { NativeSession, type NativeSessionOptions } from "./native-session";
import { ScriptedModel } from "./scripted-model";

export * from "./core-process";
export * from "./native-session";
export * from "./scripted-model";

export type E2E = {
  model: ScriptedModel;
  layout: CoreLayout;
  core: CoreProcess;
  redisUrl: string;
  session(options?: NativeSessionOptions): Promise<NativeSession>;
  /** Stops Core gracefully (or kills it) and boots a fresh process on the same data. */
  restart(options?: { kill?: boolean }): Promise<CoreProcess>;
  stopRedis(): Promise<void>;
  startRedis(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Boots one real Core process with isolated Redis, a scripted model, and its own data directory.
 * Every scenario shares one instance per file to keep the suite fast.
 */
export async function startE2E(options: Omit<CoreConfigOptions, "modelUrl"> = {}): Promise<E2E> {
  const cleanup = new AsyncDisposableStack();
  try {
    const redis = await createIsolatedRedis();
    cleanup.defer(() => redis.close());
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-e2e-"));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const model = new ScriptedModel().start();
    cleanup.defer(() => model.stop());
    const layout = await prepareCore(directory, { ...options, modelUrl: model.url });
    const sessions: NativeSession[] = [];
    let core = startCore(layout, redis.url);
    cleanup.defer(async () => {
      for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
      await core.stop().catch(() => core.kill());
    });
    await core.ready();
    const moved = cleanup.move();
    return {
      model,
      layout,
      get core() {
        return core;
      },
      redisUrl: redis.url,
      async session(sessionOptions) {
        const session = await NativeSession.open(layout.nativeUrl, sessionOptions);
        sessions.push(session);
        return session;
      },
      async restart(restartOptions = {}) {
        if (restartOptions.kill) await core.kill();
        else await core.stop();
        core = startCore(layout, redis.url);
        await core.ready();
        return core;
      },
      stopRedis: () => redis.stop(),
      startRedis: () => redis.start(),
      async [Symbol.asyncDispose]() {
        await moved.disposeAsync();
      },
    };
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}
