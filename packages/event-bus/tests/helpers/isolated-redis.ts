import { createServer, connect, type Socket } from "node:net";
import Redis from "ioredis";

export async function withinRedisDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function docker(...args: string[]): Promise<string> {
  const commandProcess = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  try {
    const [code, stdout, stderr] = await withinRedisDeadline(
      Promise.all([
        commandProcess.exited,
        new Response(commandProcess.stdout).text(),
        new Response(commandProcess.stderr).text(),
      ]),
      `docker ${args[0]}`,
      30_000,
    );
    if (code !== 0)
      throw new Error(
        `Isolated Redis requires Docker with redis:7-alpine available: ${stderr.trim()}`,
      );
    return stdout.trim();
  } finally {
    if (commandProcess.exitCode === null) commandProcess.kill("SIGKILL");
  }
}

async function ready(url: string): Promise<void> {
  const redis = new Redis(url, { connectTimeout: 1_000, maxRetriesPerRequest: null });
  redis.on("error", () => {});
  try {
    await withinRedisDeadline(redis.ping(), "isolated Redis readiness");
  } finally {
    redis.disconnect();
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("No available Redis TCP port");
  return address.port;
}

export async function createIsolatedRedis() {
  const name = `lilac-redis-test-${crypto.randomUUID()}`;
  const port = await availablePort();
  const url = `redis://127.0.0.1:${port}`;
  let closed = false;
  try {
    await docker(
      "run",
      "--detach",
      "--name",
      name,
      "--publish",
      `127.0.0.1:${port}:6379`,
      "redis:7-alpine",
      "redis-server",
      "--appendonly",
      "yes",
      "--appendfsync",
      "always",
      "--save",
      "",
    );
    await ready(url);
  } catch (error) {
    await docker("rm", "--force", "--volumes", name).catch(() => undefined);
    throw error;
  }
  return {
    get url() {
      return url;
    },
    async stop() {
      await docker("kill", "--signal", "KILL", name);
    },
    async start() {
      await docker("start", name);
      await ready(url);
    },
    async close() {
      if (closed) return;
      await docker("rm", "--force", "--volumes", name);
      closed = true;
    },
  };
}

export async function createRedisFaultProxy(targetUrl: string) {
  const target = new URL(targetUrl);
  const sockets = new Set<Socket>();
  let closed = false;
  let offline = false;
  let suppressReplies = false;
  const server = createServer((client) => {
    if (offline) {
      client.destroy();
      return;
    }
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => {
      if (!suppressReplies) client.write(chunk);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy has no TCP address");
  return {
    url: `redis://127.0.0.1:${address.port}`,
    blockReplies() {
      suppressReplies = true;
    },
    disconnect() {
      offline = true;
      for (const socket of sockets) socket.destroy();
    },
    reconnect() {
      offline = false;
      suppressReplies = false;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
