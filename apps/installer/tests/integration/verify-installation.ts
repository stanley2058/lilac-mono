import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeHttpRPC } from "../../../../packages/client/src/transport";
import {
  createConfigDocument,
  getConfigValue,
  setConfigValue,
  deleteConfigValue,
  validateConfigDocument,
} from "../../src/config-document";
import { createDeployment, writeInstallation } from "../../src/deployment";
import { configureNative } from "../../src/native";
import { configureProviders } from "../../src/providers";
import type { Prompt, SetupDraft } from "../../src/types";

const image = process.argv[2];
assert(image, "Usage: bun apps/installer/tests/integration/verify-installation.ts IMAGE");
const root = await mkdtemp(join(tmpdir(), "lilac-installation-"));
const reply = "INSTALLATION_BOOT_REPLY_7d3f";
let modelRequests = 0;
const model = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/v1/models")
      return Response.json({ data: [{ id: "installation-test" }] });
    if (new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response(null, { status: 404 });
    const body = await request.json();
    assert.equal(body.model, "installation-test");
    assert.equal(body.stream, true);
    modelRequests++;
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "installation-test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      chunk({ role: "assistant", content: reply }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const compose = ["docker", "compose", "--file", join(root, "compose.yaml")];
async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${args.slice(0, 2).join(" ")} failed: ${stderr}`);
  return stdout.trim();
}
function answers(values: string[]): Prompt {
  const next = () => {
    const value = values.shift();
    assert(value !== undefined, "Missing installer answer");
    return value;
  };
  return {
    text: async () => next(),
    select: async (_message, choices) => {
      const value = next();
      const choice = choices.find((entry) => entry.value === value);
      assert(choice, "Unknown installer choice");
      return choice.value;
    },
    confirm: async () => false,
    note: () => {},
  };
}
try {
  const document = createConfigDocument();
  const draft: SetupDraft = {
    get: (key) => getConfigValue(document, key),
    set: (key, value) => setConfigValue(document, key, value),
    remove: (key) => deleteConfigValue(document, key),
    secrets: {},
    configuredEnvironmentKeys: new Set(),
    files: [],
    stagingDir: root,
    readExistingFile: async () => undefined,
    computerEnabled: false,
  };
  const password = crypto.randomUUID();
  await configureNative(answers(["local", "http://localhost:8789", "owner", password]), draft);
  await configureProviders(
    answers([
      "openai-compatible",
      `http://host.docker.internal:${model.port}/v1`,
      "installation-test-key",
      "installation-test",
      "provider-default",
      "",
      "done",
    ]),
    draft,
  );
  validateConfigDocument(document).unwrap();
  assert.equal(draft.secrets.DISCORD_TOKEN, undefined);
  const deployment = createDeployment(root, draft, { core: image, gateway: image, runner: image });
  // Allocate a host port so concurrent verification runs do not collide.
  deployment.setIn(["services", "lilac", "ports"], ["127.0.0.1::8789"]);
  (
    await writeInstallation({
      root,
      draft,
      config: document.toString(),
      compose: deployment.toString(),
      installExecutable: false,
      image,
    })
  ).unwrap();
  await run([...compose, "config", "--quiet"]);
  await run([...compose, "up", "-d", "--wait", "--wait-timeout", "180"]);
  const container = await run([...compose, "ps", "-q", "lilac"]);
  assert.equal(
    await run(["docker", "inspect", "--format", "{{.State.Health.Status}}", container]),
    "healthy",
  );
  const port = await run([...compose, "port", "lilac", "8789"]);
  const base = `http://${port}`;
  const info = await fetch(`${base}/api/auth/info`, { signal: AbortSignal.timeout(10_000) });
  assert(info.ok, `Auth info failed: ${info.status}`);
  assert.equal((await info.json()).provider, "local");
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Basic ${btoa(`owner:${password}`)}` },
  });
  assert(login.ok, `Local login failed: ${login.status}`);
  const { token } = await login.json();
  assert.equal(typeof token, "string");
  const tools = await run([
    ...compose,
    "exec",
    "-T",
    "--user",
    "root",
    "lilac",
    "/usr/local/bin/tools",
    "--operator",
    "--list",
  ]);
  assert(tools.includes("workflow"), "Running tool server did not return its tool catalog");
  assert(!tools.includes("bridge_unavailable"));
  const client = createNativeHttpRPC({
    url: `${base}/api/rpc`,
    headers: () => ({ authorization: `Bearer ${token}` }),
  });
  const signal = AbortSignal.timeout(90_000);
  const thread = await client.threads.create(
    { commandId: crypto.randomUUID(), title: "Installation boot" },
    { signal },
  );
  const receipt = await client.inputs.submit(
    {
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      text: "Say hello",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    },
    { signal },
  );
  const events = await client.threads.watch({ threadId: thread.id }, { signal });
  let complete = false;
  try {
    for await (const _event of events) {
      const snapshot = await client.threads.sync({ threadId: thread.id }, { signal });
      if (snapshot.kind !== "window") continue;
      const turn = snapshot.slots.find(
        (slot) => slot.kind === "ready" && slot.turnId === receipt.turnId,
      );
      if (!turn || turn.kind !== "ready") continue;
      assert(!["failed", "canceled"].includes(turn.state ?? ""), `Native turn ${turn.state}`);
      if (turn.state !== "complete") continue;
      assert(
        JSON.stringify(turn.messages).includes(reply),
        "Completed turn is missing fake model reply",
      );
      complete = true;
      break;
    }
  } finally {
    await events.return?.();
  }
  assert(complete, "Native request never completed");
  assert(modelRequests > 0, "Core did not reach the fake provider after installer validation");
  console.log(
    "Installation boot passed: healthy Core, auth info, local login, operator tools, native model reply.",
  );
} finally {
  model.stop(true);
  if (await Bun.file(join(root, "compose.yaml")).exists()) {
    // Do not print Core logs: they can include temporary auth and model request data.
    await run([...compose, "down", "-v", "--remove-orphans"]);
    await run([
      "docker",
      "run",
      "--rm",
      "--user",
      "root",
      "--entrypoint",
      "bun",
      "-v",
      `${root}/data:/data`,
      image,
      "-e",
      'const fs = require("node:fs/promises"); for (const name of await fs.readdir("/data")) await fs.rm("/data/" + name, {recursive:true, force:true}); await fs.chmod("/data", 0o777);',
    ]);
  }
  await rm(root, { recursive: true, force: true });
}
