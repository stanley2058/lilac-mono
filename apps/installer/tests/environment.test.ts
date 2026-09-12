import { describe, expect, it } from "bun:test";
import path from "node:path";
import { Result } from "better-result";
import { parseDocument } from "yaml";
import {
  createDeployment,
  InstallerDeploymentFailed,
  validateDeploymentInputs,
} from "../src/deployment";
import { readSetupEnvironment } from "../src/environment";
import { command, InstallerSystemFailed } from "../src/system";
import type { SetupDraft } from "../src/types";

const root = "/example/lilac";
const project = "fixture-install";
const images = {
  core: "registry.example/lilac:release",
  gateway: "registry.example/gateway:release",
  runner: "registry.example/runner:release",
};

function compose(service: string) {
  return parseDocument(
    `name: ${project}\nservices:\n  lilac:\n    image: existing-core\n${service}`,
  );
}

function runner(stdout: string, code = 0) {
  const calls: { args: string[]; options: Parameters<typeof command>[1] }[] = [];
  const run: typeof command = async (args, options) => {
    calls.push({ args, options });
    return Result.ok({ code, stdout });
  };
  return { calls, run };
}

function resolvedEnvironment(environment: Record<string, string | null>) {
  const encoded = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      value === null ? null : value.replaceAll("$", () => "$$"),
    ]),
  );
  return JSON.stringify({ services: { lilac: { environment: encoded } } });
}

function expectPinnedConfig(call: ReturnType<typeof runner>["calls"][number], services: string[]) {
  expect(call.args.slice(0, 2)).toEqual(["docker", "compose"]);
  const file = call.args.indexOf("--file");
  expect(file).toBeGreaterThan(1);
  expect(call.args[file + 1]).toBe(path.join(root, "compose.yaml"));
  const name = call.args.indexOf("--project-name");
  expect(name).toBeGreaterThan(1);
  expect(call.args[name + 1]).toBe(project);
  expect(call.args.slice(call.args.indexOf("config"))).toEqual([
    "config",
    "--format",
    "json",
    ...services,
  ]);
  expect(call.args).not.toContain("--no-env-resolution");
  expect(call.options?.cwd).toBe(root);
  expect(call.options?.inherit).not.toBe(true);
}

describe("installer environment source", () => {
  it.each([
    { label: "fresh installation", existing: undefined },
    {
      label: "raw environment file",
      existing: compose("    env_file:\n      - path: ./secrets.env\n        format: raw\n"),
    },
    {
      label: "raw environment alias",
      existing: parseDocument(
        `name: ${project}\nx-env: &env\n  - path: ./secrets.env\n    format: raw\nservices:\n  lilac:\n    image: existing-core\n    env_file: *env\n`,
      ),
    },
  ])("uses literal values without running Compose for $label", async ({ existing }) => {
    const value = 'literal$VARIABLE#quote"value\\suffix';
    const source = `PROVIDER_KEY=${value}\r\nEMPTY=\r\n`;
    const fake = runner("unneeded command");
    const loaded = await readSetupEnvironment(root, existing, source, fake.run);
    expect(loaded.unwrap()).toEqual({ secrets: { PROVIDER_KEY: value, EMPTY: "" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts a fresh installation without an environment file", async () => {
    const fake = runner("unneeded command");
    expect((await readSetupEnvironment(root, undefined, undefined, fake.run)).unwrap()).toEqual({
      secrets: {},
    });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    { label: "string", existing: compose("    env_file: ./secrets.env\n") },
    { label: "unrelated environment file", existing: compose("    env_file: ./operator.env\n") },
    {
      label: "map without a format",
      existing: compose("    env_file:\n      - path: ./secrets.env\n"),
    },
    {
      label: "explicit dotenv map",
      existing: compose("    env_file:\n      - path: ./secrets.env\n        format: dotenv\n"),
    },
    {
      label: "entry alias",
      existing: parseDocument(
        `name: ${project}\nx-env: &env\n  path: ./secrets.env\nservices:\n  lilac:\n    image: existing-core\n    env_file:\n      - *env\n`,
      ),
    },
    {
      label: "merged service",
      existing: parseDocument(
        `name: ${project}\nx-service: &service\n  env_file: ./secrets.env\nservices:\n  lilac:\n    <<: *service\n    image: existing-core\n`,
      ),
    },
  ])("resolves dotenv $label through the pinned Compose project", async ({ existing }) => {
    const source =
      "# retain this comment\nDISCORD_TOKEN=\"quoted-token\"\nREFERENCE=${TOKEN_VALUE}\nMULTILINE='first\nsecond'\n";
    const values = {
      DISCORD_TOKEN: "quoted-token",
      REFERENCE: "expanded-token",
      MULTILINE: "first\nsecond",
      LITERAL_DOLLARS: "literal$TOKEN ${REFERENCE} $$",
    };
    const fake = runner(resolvedEnvironment({ ...values, UNSET: null }));
    const original = existing.toString();
    const loaded = (await readSetupEnvironment(root, existing, source, fake.run)).unwrap();
    expect(loaded.secrets).toEqual(values);
    expect(loaded.preservedEnvironmentSource).toBe(source);
    expect(existing.toString()).toBe(original);
    expect(fake.calls).toHaveLength(1);
    expectPinnedConfig(fake.calls[0]!, ["lilac"]);
  });

  it("uses gateway connection settings while retaining Core's shared credentials", async () => {
    const existing = compose(
      "    env_file:\n      - path: ./secrets.env\n        format: raw\n  computer-use-gateway:\n    image: existing-gateway\n    env_file: ./secrets.env\n",
    );
    const source = 'SHARED="source-token"\n';
    const gateway = {
      MCP_BEARER_SECRET: "gateway-bearer",
      BIND_ADDR: "0.0.0.0",
      RENDERED_HOST: "https://desktop.example",
      PORT_RANGE_START: "19000",
      PORT_RANGE_END: "19009",
    };
    const core = Object.fromEntries(Object.keys(gateway).map((key) => [key, "core-default"]));
    const fake = runner(
      JSON.stringify({
        services: {
          lilac: { environment: { ...core, SHARED: "core-token", CORE_ONLY: "core-value" } },
          "computer-use-gateway": {
            environment: { ...gateway, SHARED: "gateway-token", GATEWAY_ONLY: "gateway-value" },
          },
        },
      }),
    );
    const loaded = (await readSetupEnvironment(root, existing, source, fake.run)).unwrap();
    expect(loaded.secrets).toEqual({
      ...gateway,
      SHARED: "core-token",
      CORE_ONLY: "core-value",
      GATEWAY_ONLY: "gateway-value",
    });
    expect(loaded.preservedEnvironmentSource).toBe(source);
    expectPinnedConfig(fake.calls[0]!, ["lilac", "computer-use-gateway"]);
  });

  it.each([
    { label: "unsuccessful command", code: 1, stdout: "fixture-sensitive-value" },
    { label: "invalid JSON", code: 0, stdout: "fixture-sensitive-value{" },
    { label: "missing services", code: 0, stdout: '{"private":"fixture-sensitive-value"}' },
    { label: "missing Core", code: 0, stdout: '{"services":{}}' },
    {
      label: "non-string credential",
      code: 0,
      stdout:
        '{"services":{"lilac":{"environment":{"KEY":{"private":"fixture-sensitive-value"}}}}}',
    },
  ])("fails without disclosing projection content for $label", async ({ stdout, code }) => {
    const fake = runner(stdout, code);
    const result = await readSetupEnvironment(
      root,
      compose("    env_file: ./secrets.env\n"),
      "KEY=fixture-sensitive-value\n",
      fake.run,
    );
    expect(result.isErr()).toBe(true);
    const failure = result.match({ ok: () => undefined, err: (error) => error });
    expect(InstallerDeploymentFailed.is(failure)).toBe(true);
    expect(failure?.message).not.toContain("fixture-sensitive-value");
  });

  it("sanitizes command failures before returning them", async () => {
    const run: typeof command = async () =>
      Result.err(new InstallerSystemFailed({ message: "fixture-sensitive-value" }));
    const result = await readSetupEnvironment(
      root,
      compose("    env_file: ./secrets.env\n"),
      "KEY=fixture-sensitive-value\n",
      run,
    );
    expect(result.isErr()).toBe(true);
    const failure = result.match({ ok: () => undefined, err: (error) => error });
    expect(InstallerDeploymentFailed.is(failure)).toBe(true);
    expect(failure?.message).not.toContain("fixture-sensitive-value");
  });

  it("rejects an unreadable existing service projection before running Compose", async () => {
    const fake = runner(resolvedEnvironment({ KEY: "fixture-sensitive-value" }));
    const result = await readSetupEnvironment(
      root,
      parseDocument("name: fixture-install\nservices: ["),
      "KEY=fixture-sensitive-value\n",
      fake.run,
    );
    expect(result.isErr()).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("overrides only a selected credential without converting the preserved dotenv file", async () => {
    const existing = compose(
      "    env_file:\n      - path: ./secrets.env\n        format: dotenv\n    environment:\n      UNTOUCHED: operator-value\n",
    );
    const source =
      "# retain this comment\nDISCORD_TOKEN=\"old-token\"\nMULTILINE='first\nsecond'\n";
    const fake = runner(
      resolvedEnvironment({ DISCORD_TOKEN: "old-token", MULTILINE: "first\nsecond" }),
    );
    const loaded = (await readSetupEnvironment(root, existing, source, fake.run)).unwrap();
    const state: SetupDraft = {
      get: () => undefined,
      set: () => {},
      remove: () => {},
      ...loaded,
      secrets: { ...loaded.secrets, DISCORD_TOKEN: "selected$TOKEN#quote'value" },
      configuredEnvironmentKeys: new Set(["DISCORD_TOKEN"]),
      files: [],
      stagingDir: "",
      readExistingFile: async () => undefined,
      computerEnabled: false,
    };
    const updated = createDeployment(
      root,
      state,
      images,
      existing,
      state.configuredEnvironmentKeys,
    );
    expect(updated.toJS().services.lilac.env_file).toEqual([
      { path: "./secrets.env", format: "dotenv" },
    ]);
    expect(updated.toJS().services.lilac.environment).toEqual({
      UNTOUCHED: "operator-value",
      DISCORD_TOKEN: "selected$$TOKEN#quote'value",
    });
    expect(state.preservedEnvironmentSource).toBe(source);
  });

  it("retains an effective explicit credential override on a legacy reinstall", async () => {
    const existing = compose(
      "    env_file: ./secrets.env\n    environment:\n      DISCORD_TOKEN: 'operator$$TOKEN $${REFERENCE} $$$$'\n",
    );
    const source = 'DISCORD_TOKEN="older-token"\n';
    const fake = runner(resolvedEnvironment({ DISCORD_TOKEN: "operator$TOKEN ${REFERENCE} $$" }));
    const loaded = (await readSetupEnvironment(root, existing, source, fake.run)).unwrap();
    expect(loaded.secrets.DISCORD_TOKEN).toBe("operator$TOKEN ${REFERENCE} $$");
    const state: SetupDraft = {
      get: () => undefined,
      set: () => {},
      remove: () => {},
      ...loaded,
      configuredEnvironmentKeys: new Set(),
      files: [],
      stagingDir: "",
      readExistingFile: async () => undefined,
      computerEnabled: false,
    };
    const updated = createDeployment(
      root,
      state,
      images,
      existing,
      state.configuredEnvironmentKeys,
    );
    expect(updated.toJS().services.lilac.environment).toEqual(
      existing.toJS().services.lilac.environment,
    );
    expect(updated.toJS().services.lilac.env_file).toBe("./secrets.env");
    expect(state.preservedEnvironmentSource).toBe(source);
  });

  it("preserves interpolated file paths and later override precedence", async () => {
    const existing = compose(
      "    env_file:\n      - ${LOCAL_SECRETS:-./secrets.env}\n      - ./operator.env # keep this file last\n",
    );
    const source = 'DISCORD_TOKEN="quoted-token"\nBIND_ADDR="127.0.0.1"\n';
    const fake = runner(
      resolvedEnvironment({ DISCORD_TOKEN: "quoted-token", BIND_ADDR: "0.0.0.0" }),
    );
    const loaded = (await readSetupEnvironment(root, existing, source, fake.run)).unwrap();
    expect(loaded.secrets.DISCORD_TOKEN).toBe("quoted-token");
    expect(loaded.secrets.BIND_ADDR).toBe("0.0.0.0");
    expect(loaded.preservedEnvironmentSource).toBe(source);
    expect(fake.calls).toHaveLength(1);
    expectPinnedConfig(fake.calls[0]!, ["lilac"]);
    const state: SetupDraft = {
      get: () => undefined,
      set: () => {},
      remove: () => {},
      ...loaded,
      secrets: { ...loaded.secrets, DISCORD_TOKEN: "replacement-token" },
      configuredEnvironmentKeys: new Set(["DISCORD_TOKEN"]),
      files: [],
      stagingDir: "",
      readExistingFile: async () => undefined,
      computerEnabled: false,
    };
    const updated = createDeployment(
      root,
      state,
      images,
      existing,
      state.configuredEnvironmentKeys,
    );
    expect(updated.toJS().services.lilac.env_file).toEqual(existing.toJS().services.lilac.env_file);
    expect(updated.toString()).toContain("# keep this file last");
    expect(updated.toJS().services.lilac.environment).toEqual({
      DISCORD_TOKEN: "replacement-token",
    });
    expect(state.preservedEnvironmentSource).toBe(source);
  });

  it("accepts preserved multiline values but rejects newly configured multiline credentials", async () => {
    const existing = compose("    env_file: ./secrets.env\n");
    const source = "MULTILINE='first\nsecond'\n";
    const fake = runner(resolvedEnvironment({ MULTILINE: "first\nsecond" }));
    const loaded = (await readSetupEnvironment(root, existing, source, fake.run)).unwrap();
    const state: SetupDraft = {
      get: () => undefined,
      set: () => {},
      remove: () => {},
      ...loaded,
      configuredEnvironmentKeys: new Set(),
      files: [],
      stagingDir: "",
      readExistingFile: async () => undefined,
      computerEnabled: false,
    };
    expect(validateDeploymentInputs(state, images, existing).isOk()).toBe(true);
    state.configuredEnvironmentKeys?.add("MULTILINE");
    const result = validateDeploymentInputs(state, images, existing);
    expect(result.isErr()).toBe(true);
    const failure = result.match({ ok: () => undefined, err: (error) => error });
    expect(failure?.message).not.toContain("first");
    expect(failure?.message).not.toContain("second");
    expect(state.preservedEnvironmentSource).toBe(source);
  });
});
