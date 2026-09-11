import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { env } from "@stanley2058/lilac-utils";
import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import type { Result as ResultType } from "better-result";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Generate } from "../src/tool-server/tools/generate";
import {
  configuredImageProviders,
  imageScriptInputSchema,
  runImageScript,
} from "../src/tool-server/tools/image-script";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+9n0AAAAASUVORK5CYII=";
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==";
const names = ["openai", "openrouter", "xai"] as const;
const originalProviders = Object.fromEntries(
  names.map((name) => [name, { ...env.providers[name] }]),
);

function value<T>(result: ResultType<T, ServerToolFailure>): T {
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

describe("image script execution", () => {
  let cwd: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(join(tmpdir(), "lilac-image-script-"));
    for (const name of names)
      Object.assign(env.providers[name], { apiKey: undefined, baseUrl: undefined });
  });
  afterEach(async () => {
    server?.stop(true);
    server = undefined;
    for (const name of names) Object.assign(env.providers[name], originalProviders[name]);
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("discovers configured providers without exposing credentials or endpoints", async () => {
    Object.assign(env.providers.openai, { apiKey: "test-image-secret" });
    Object.assign(env.providers.openrouter, { baseUrl: "http://localhost:1234/custom/" });
    expect(configuredImageProviders()).toEqual({
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "test-image-secret" },
      openrouter: { baseURL: "http://localhost:1234/custom" },
    });
    const tool = new Generate();
    const image = (await tool.list()).find((entry) => entry.callableId === "generate.image");
    expect(image?.description).toContain("Configured providers: openai, openrouter.");
    expect(image?.description).toContain("image-generation skill");
    expect(JSON.stringify(image)).not.toContain("test-image-secret");
    expect(JSON.stringify(image)).not.toContain("localhost:1234");
    expect(image?.primaryPositional).toEqual({ field: "code" });
    Object.assign(env.providers.openai, { apiKey: undefined });
    Object.assign(env.providers.openrouter, { baseUrl: undefined });
    expect((await tool.list()).some((entry) => entry.callableId === "generate.image")).toBe(false);
    expect(await runImageScript({ code: "throw new Error('must not run')" })).toMatchObject({
      status: "error",
      error: { kind: "unavailable" },
    });
  });

  it("accepts only code and rejects the former image arguments", () => {
    expect(imageScriptInputSchema.parse({ code: "console.log(1)" })).toEqual({
      code: "console.log(1)",
    });
    expect(() => imageScriptInputSchema.parse({ prompt: "cat", model: "gpt-image-2" })).toThrow();
    expect(() => imageScriptInputSchema.parse({ code: "" })).toThrow();
  });

  it("runs top-level await and relative imports in cwd with provider wiring and inherited env", async () => {
    Object.assign(env.providers.openai, { baseUrl: "http://localhost/custom/" });
    await fs.writeFile(join(cwd, "local.js"), "export const message = providers.openai.baseURL;");
    const code = `
      import { message } from './local.js';
      await Bun.write('result.txt', message);
      console.log(JSON.stringify({ cwd: process.cwd(), provider: providers.openai, inherited: process.env.PATH !== undefined }));
      console.error('diagnostic');
    `;
    const result = value(
      await new Generate().call("generate.image", { code }, { context: { cwd } }),
    );
    expect(result).toMatchObject({ exitCode: 0, stderr: "diagnostic\n", truncated: false });
    const parsed = result as { stdout: string };
    expect(JSON.parse(parsed.stdout)).toEqual({
      cwd,
      provider: { baseURL: "http://localhost/custom" },
      inherited: true,
    });
    expect(await fs.readFile(join(cwd, "result.txt"), "utf8")).toBe("http://localhost/custom");
  });

  it("reports script exceptions and explicit exit status without retrying", async () => {
    Object.assign(env.providers.openai, { apiKey: "test-secret" });
    const result = value(
      await runImageScript({ code: "throw new Error('invalid request')" }, { context: { cwd } }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("invalid request");
    const exited = value(
      await runImageScript(
        { code: "console.log('before exit'); process.exit(7);" },
        { context: { cwd } },
      ),
    );
    expect(exited).toMatchObject({ exitCode: 7, stdout: "before exit\n" });
  });

  it("returns a typed failure for a missing cwd", async () => {
    Object.assign(env.providers.openai, { apiKey: "test-secret" });
    expect(
      await runImageScript(
        { code: "console.log('no')" },
        { context: { cwd: join(cwd, "missing") } },
      ),
    ).toMatchObject({
      status: "error",
      error: { kind: "unavailable" },
    });
  });

  it("redacts configured keys and caps output while draining both streams", async () => {
    Object.assign(env.providers.openai, { apiKey: "image-secret-for-test" });
    const result = value(
      await runImageScript(
        {
          code: `
      console.log(providers.openai.apiKey);
      console.error(providers.openai.apiKey);
      console.log('x'.repeat(100000));
      console.error('y'.repeat(100000));
    `,
        },
        { context: { cwd } },
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(40 * 1024);
    expect(result.stderr.length).toBeLessThanOrEqual(40 * 1024);
    expect(JSON.stringify(result)).not.toContain("image-secret-for-test");
    expect(result.stdout).toContain("<redacted>");
  });

  it("rejects restricted execution and cancellation before starting", async () => {
    Object.assign(env.providers.openai, { apiKey: "test-secret" });
    const code = "await Bun.write('should-not-exist', 'no');";
    expect(
      await runImageScript({ code }, { context: { cwd, safetyMode: "restricted" } }),
    ).toMatchObject({
      status: "error",
      error: { kind: "denied" },
    });
    expect(
      await runImageScript({ code }, { context: { cwd }, signal: AbortSignal.abort() }),
    ).toMatchObject({
      status: "error",
      error: { kind: "cancelled" },
    });
    expect(await fs.readdir(cwd)).toEqual([]);
  });

  it("cancels a running script after it reaches the provider", async () => {
    const reached = Promise.withResolvers<void>();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        reached.resolve();
        return new Response("ready");
      },
    });
    Object.assign(env.providers.openai, { baseUrl: server.url.toString() });
    const controller = new AbortController();
    const running = runImageScript(
      { code: "await fetch(providers.openai.baseURL); setInterval(() => {}, 1000);" },
      { context: { cwd }, signal: controller.signal },
    );
    await reached.promise;
    controller.abort();
    expect(await running).toMatchObject({ status: "error", error: { kind: "cancelled" } });
  });

  it("reports the execution deadline separately from caller cancellation", async () => {
    const reached = Promise.withResolvers<void>();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        reached.resolve();
        return new Response("ready");
      },
    });
    Object.assign(env.providers.openai, { baseUrl: server.url.toString() });
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const running = runImageScript(
        { code: "await fetch(providers.openai.baseURL); setInterval(() => {}, 1000);" },
        { context: { cwd } },
      );
      await reached.promise;
      deadline.abort();
      expect(await running).toMatchObject({
        status: "error",
        error: { kind: "timeout", retryable: false },
      });
      expect(timeout).toHaveBeenCalledWith(10 * 60 * 1000);
    } finally {
      timeout.mockRestore();
    }
  });

  for (const termination of ["cancel", "timeout", "exit"] as const) {
    it(`closes inherited descendant pipes on ${termination}`, async () => {
      const reached = Promise.withResolvers<void>();
      let descendantPid: number | undefined;
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/child") {
            descendantPid = Number(url.searchParams.get("pid"));
            reached.resolve();
            return new Response("ready");
          }
          await reached.promise;
          return new Response("exit");
        },
      });
      Object.assign(env.providers.openai, { baseUrl: server.url.toString() });
      const controller = new AbortController();
      const timeout =
        termination === "timeout"
          ? spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
          : undefined;
      const childCode = `await fetch(${JSON.stringify(`${server.url}child?pid=`)} + process.pid); setInterval(() => {}, 1000);`;
      const code = `
        const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', ${JSON.stringify(childCode)}], { stdout: 'inherit', stderr: 'inherit' });
        ${termination === "exit" ? "await fetch(providers.openai.baseURL + '/parent'); process.exit(0);" : "await child.exited;"}
      `;
      const running = runImageScript(
        { code },
        { context: { cwd }, signal: termination === "cancel" ? controller.signal : undefined },
      );
      const deadline = Promise.withResolvers<never>();
      const guard = setTimeout(
        () => deadline.reject(new Error("Image script did not settle after process termination")),
        2000,
      );
      try {
        await Promise.race([reached.promise, deadline.promise]);
        if (termination !== "exit") controller.abort();
        const result = await Promise.race([running, deadline.promise]);
        if (termination === "exit") {
          expect(value(result).exitCode).toBe(0);
        } else {
          expect(result).toMatchObject({
            status: "error",
            error: { kind: termination === "cancel" ? "cancelled" : "timeout" },
          });
        }
      } finally {
        clearTimeout(guard);
        timeout?.mockRestore();
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {}
        }
        controller.abort();
        await running;
      }
    });
  }

  for (const [provider, recipeIndex, endpoint, model] of [
    ["openai", 0, "/v1/images/generations", "gpt-image-2.5-sunburst"],
    ["openai", 1, "/v1/images/edits", "gpt-image-2.5-sunburst"],
    ["openrouter", 0, "/v1/images", "google/gemini-3.1-flash-image-preview"],
    ["xai", 0, "/v1/images/generations", "grok-imagine-image-2.0"],
  ] as const) {
    it(`executes the bundled ${provider} recipe ${recipeIndex} against its native endpoint`, async () => {
      let requestPath = "";
      let authorization: string | null = null;
      let requestModel = "";
      let imageName: string | undefined;
      let maskName: string | undefined;
      let requestQuality: string | undefined;
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requestPath = new URL(request.url).pathname;
          authorization = request.headers.get("authorization");
          if (request.headers.get("content-type")?.startsWith("multipart/")) {
            const form = await request.formData();
            requestModel = String(form.get("model"));
            const image = form.get("image[]");
            const mask = form.get("mask");
            imageName = image instanceof File ? image.name : undefined;
            maskName = mask instanceof File ? mask.name : undefined;
          } else {
            const body = await request.json();
            requestModel = body.model;
            requestQuality = body.quality;
          }
          return Response.json({
            data: [{ b64_json: provider === "xai" ? JPEG : PNG, media_type: "image/png" }],
          });
        },
      });
      Object.assign(env.providers[provider], { baseUrl: `${server.url}v1/` });
      Object.assign(env.providers[provider], { apiKey: "mock-provider-key" });
      await fs.writeFile(join(cwd, "input.png"), Buffer.from(PNG, "base64"));
      await fs.writeFile(join(cwd, "mask.png"), Buffer.from(PNG, "base64"));
      const reference = await Bun.file(
        new URL(
          `../../../packages/utils/builtin-skills/image-generation/references/${provider}.md`,
          import.meta.url,
        ),
      ).text();
      const recipe = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)][recipeIndex]?.[1];
      expect(recipe).toBeDefined();
      const result = value(await runImageScript({ code: recipe! }, { context: { cwd } }));
      expect(result).toMatchObject({ exitCode: 0, stderr: "", truncated: false });
      expect(requestPath).toBe(endpoint);
      expect(requestModel).toBe(model);
      expect(String(authorization)).toBe("Bearer mock-provider-key");
      expect(requestQuality).toBeUndefined();
      if (recipeIndex === 1) {
        expect(imageName).toBe("input.png");
        expect(maskName).toBe("mask.png");
      }
      const output = JSON.parse(result.stdout);
      expect(output.path).toStartWith(cwd);
      expect(await fs.readFile(output.path)).toEqual(
        Buffer.from(provider === "xai" ? JPEG : PNG, "base64"),
      );
    });
  }
});
