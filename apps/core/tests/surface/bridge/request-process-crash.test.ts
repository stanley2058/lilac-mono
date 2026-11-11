import { expect, it } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { env } from "@stanley2058/lilac-utils";
import { createRealCoreBusFixture, withBusDeadline } from "../../helpers/real-core-bus";

const worker = join(import.meta.dir, "fixtures/request-process-worker.ts");
const phases = ["prepared", "published", "accepted", "output-persisted", "completed"] as const;
const barrierSchema = z.object({
  kind: z.literal("barrier"),
  phase: z.string(),
  pid: z.number(),
  state: z.string(),
  terminalHead: z.boolean(),
  modelCalls: z.number(),
});
const recoveredSchema = z.object({
  kind: z.literal("recovered"),
  pid: z.number(),
  state: z.string(),
  modelCalls: z.number(),
  attachment: z.string(),
  finalOutputs: z.array(z.object({ finalText: z.string() })),
  transcript: z.string(),
  recoveryResumed: z.number(),
  recoveryTerminalized: z.number(),
});

for (const phase of phases) {
  it(`recovers durable execution after SIGKILL at ${phase}`, async () => {
    const f = await createRealCoreBusFixture();
    const deliveryId = crypto.randomUUID();
    const requestId = `process-${deliveryId}`;
    const children: Array<Bun.Subprocess> = [];
    const start = (recover: boolean) => {
      const received = Promise.withResolvers<unknown>();
      const child = Bun.spawn(
        [
          process.execPath,
          worker,
          JSON.stringify({
            directory: f.directory,
            keyPrefix: f.keyPrefix,
            redisUrl: env.redisUrl || "redis://127.0.0.1:6379",
            deliveryId,
            requestId,
            phase,
            recover,
          }),
        ],
        {
          env: { ...process.env, DATA_DIR: join(f.directory, "data") },
          stdout: "pipe",
          stderr: "pipe",
          ipc: (message) => received.resolve(message),
        },
      );
      children.push(child);
      const stderr = new Response(child.stderr).text();
      const stdout = new Response(child.stdout).text();
      const exit = child.exited.then(async (code) => {
        if (code !== 0) throw new Error(`Worker exited ${code}: ${await stderr}\n${await stdout}`);
        throw new Error("Worker exited without an IPC checkpoint");
      });
      void exit.catch(() => undefined);
      return {
        child,
        message: withBusDeadline(
          Promise.race([received.promise, exit]),
          `process ${phase} checkpoint`,
          15_000,
        ),
        stderr,
      };
    };
    try {
      const first = start(false);
      const before = barrierSchema.parse(await first.message);
      expect(before.phase).toBe(phase);
      expect(before.pid).toBe(first.child.pid);
      expect(before.state).toBe(
        phase === "prepared" || phase === "published"
          ? "prepared"
          : phase === "completed"
            ? "terminal"
            : "accepted",
      );
      if (phase === "output-persisted") expect(before.terminalHead).toBe(true);
      first.child.kill("SIGKILL");
      await withBusDeadline(first.child.exited, "killed process exit");
      expect(first.child.signalCode).toBe("SIGKILL");
      if (phase === "published") {
        expect(await f.redis.xlen(`${f.keyPrefix}:v2:cmd.request`)).toBe(1);
        // Advance the crashed producer's real Redis lease expiry without a fixed TTL sleep.
        expect(
          await f.redis.pexpire(`${f.keyPrefix}:v2:request-publication-claim:${deliveryId}`, 0),
        ).toBe(1);
      }
      const second = start(true);
      const after = recoveredSchema.parse(await second.message);
      expect(after.pid).not.toBe(before.pid);
      expect(after.state).toBe("terminal");
      expect(after.modelCalls).toBe(phase === "output-persisted" || phase === "completed" ? 0 : 1);
      expect(after.attachment).toBe("retained process attachment");
      expect(after.finalOutputs).toEqual([{ finalText: "Recovered answer" }]);
      expect(after.transcript).toBe("Recovered answer");
      if (phase === "output-persisted") expect(after.recoveryTerminalized).toBe(1);
      expect(await withBusDeadline(second.child.exited, "recovered process exit")).toBe(0);
      expect(await f.redis.xlen(`${f.keyPrefix}:v2:cmd.request`)).toBe(1);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      await f.close();
    }
  }, 30_000);
}
