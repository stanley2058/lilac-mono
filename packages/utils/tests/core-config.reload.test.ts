import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("a config edit during reload cannot be cached under the later fingerprint", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "config-reload-"));
  try {
    const script = String.raw`
      import { spyOn } from "bun:test";
      import { getCoreConfig, resolveCoreConfigPath } from ${JSON.stringify(path.resolve(import.meta.dir, "../core-config.ts"))};
      await getCoreConfig();
      const filename = resolveCoreConfigPath();
      await Bun.write(filename, "configVersion: 3\nagent:\n  reasoningDisplay: detailed\n");
      const file = Bun.file.bind(Bun);
      let changed = false;
      const spy = spyOn(Bun, "file").mockImplementation((...args) => {
        const result = file(...args);
        if (String(args[0]) !== filename) return result;
        const text = result.text.bind(result);
        result.text = async () => {
          const raw = await text();
          if (!changed) {
            changed = true;
            await Bun.write(filename, "configVersion: 3\nagent:\n  reasoningDisplay: none\n");
          }
          return raw;
        };
        return result;
      });
      await getCoreConfig({ forceReload: true });
      spy.mockRestore();
      if ((await getCoreConfig()).agent.reasoningDisplay !== "none") throw new Error("stale config cached");
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("loading core config registers named OpenAI-compatible servers", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "config-reload-"));
  try {
    const script = String.raw`
      import { getCoreConfig, resolveCoreConfigPath } from ${JSON.stringify(path.resolve(import.meta.dir, "../core-config.ts"))};
      import { routeOpenAICompatibleModel } from ${JSON.stringify(path.resolve(import.meta.dir, "../model-provider.ts"))};
      await getCoreConfig();
      if (routeOpenAICompatibleModel("vllm/qwen").status === "ok") throw new Error("route before config");
      await Bun.write(
        resolveCoreConfigPath(),
        "configVersion: 3\nmodels:\n  providers:\n    openaiCompatible:\n      vllm:\n        baseUrl: http://127.0.0.1:1/v1\n",
      );
      await getCoreConfig({ forceReload: true });
      if (routeOpenAICompatibleModel("vllm/qwen").status !== "ok") throw new Error("server not registered");
    `;
    const { OPENAI_COMPATIBLE_BASE_URL: _unset, ...parentEnv } = process.env;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...parentEnv, DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
