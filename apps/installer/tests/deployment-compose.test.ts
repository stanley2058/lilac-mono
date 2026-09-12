import { describe, expect, it } from "bun:test";
import { isScalar, parseDocument, type Document } from "yaml";
import { createDeployment as assembleDeployment, type ImageReferences } from "../src/deployment";
import type { SetupDraft } from "../src/types";

const images = {
  core: "registry.example/lilac:release",
  gateway: "registry.example/gateway:release",
  runner: "registry.example/runner:release",
};

function createDeployment(
  root: string,
  state: SetupDraft,
  selectedImages: ImageReferences,
  existing?: Document,
) {
  return assembleDeployment(
    root,
    state,
    selectedImages,
    existing,
    new Set(Object.keys(state.secrets)),
  );
}

function draft(computerEnabled = true): SetupDraft {
  return {
    get: () => undefined,
    set: () => {},
    remove: () => {},
    secrets: {
      DISCORD_TOKEN: "replacement-discord-token",
      PROVIDER_KEY: "replacement-provider-key",
    },
    files: [],
    stagingDir: "",
    readExistingFile: async () => undefined,
    computerEnabled,
  };
}

function networkNames(networks: unknown): string[] {
  if (Array.isArray(networks)) return networks.filter((name) => typeof name === "string");
  if (networks !== null && typeof networks === "object") return Object.keys(networks);
  return ["default"];
}

describe("installer reused Compose credential wiring", () => {
  it.each([
    {
      label: "missing env_file",
      source: "",
      expected: [{ path: "./secrets.env", format: "raw" }],
    },
    {
      label: "scalar env_file",
      source: "    env_file: ./operator.env # operator environment\n",
      expected: ["./operator.env", { path: "./secrets.env", format: "raw" }],
    },
    {
      label: "multiple env_files",
      source:
        "    env_file:\n      - ./operator.env # operator environment\n      - path: ./secrets.env\n        required: false\n      - path: ./overrides.env # optional overrides\n        required: false\n",
      expected: [
        "./operator.env",
        { path: "./secrets.env", required: false },
        { path: "./overrides.env", required: false },
      ],
      preservedEnvironmentSource: 'DISCORD_TOKEN="saved-token"\n',
    },
  ])(
    "connects credentials while preserving $label order and formats on both services",
    ({ source, expected, preservedEnvironmentSource }) => {
      const existing = parseDocument(
        `services:\n  lilac:\n    image: old-core\n${source}  computer-use-gateway:\n    image: old-gateway\n${source}`,
      );
      const state = draft();
      state.preservedEnvironmentSource = preservedEnvironmentSource;
      const updated = createDeployment("/example/instance", state, images, existing);
      for (const service of ["lilac", "computer-use-gateway"]) {
        expect(updated.toJS().services[service].env_file).toEqual(expected);
      }
      if (source.includes("# operator environment"))
        expect(updated.toString().match(/# operator environment/g)).toHaveLength(2);
      if (source.includes("# optional overrides"))
        expect(updated.toString().match(/# optional overrides/g)).toHaveLength(2);
      expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
        updated.toString(),
      );
    },
  );

  it("removes explicit credential mappings while retaining unrelated values and comments", () => {
    const existing = parseDocument(
      `services:
  lilac:
    image: old-core
    environment:
      DISCORD_TOKEN: stale-token
      PROVIDER_KEY: null
      LOG_LEVEL: debug # operator log level
      CUSTOM_VALUE: keep
  computer-use-gateway:
    image: old-gateway
    environment:
      PROVIDER_KEY: stale-provider-key
      DISCORD_TOKEN: stale-token
      RUNNER_IMAGE: old-runner
      GATEWAY_PORT: "8080" # operator port
`,
    );
    const state = draft();
    const updated = createDeployment("/example/instance", state, images, existing);
    expect(updated.toJS().services.lilac.environment).toEqual({
      LOG_LEVEL: "debug",
      CUSTOM_VALUE: "keep",
    });
    expect(updated.toJS().services["computer-use-gateway"].environment).toEqual({
      RUNNER_IMAGE: images.runner,
      GATEWAY_PORT: "8080",
    });
    expect(updated.toString()).toContain("# operator log level");
    expect(updated.toString()).toContain("# operator port");
    for (const value of Object.values(state.secrets))
      expect(updated.toString()).not.toContain(value);
    expect(existing.toJS().services.lilac.environment.DISCORD_TOKEN).toBe("stale-token");
  });

  it("removes assigned and inherited credentials from sequences and updates the runner image", () => {
    const existing = parseDocument(
      `services:
  lilac:
    image: old-core
    environment:
      - DISCORD_TOKEN=stale-token
      - PROVIDER_KEY
      - CUSTOM_VALUE=keep=with=equals # operator value
      - HOST_SETTING
  computer-use-gateway:
    image: old-gateway
    environment:
      - DISCORD_TOKEN
      - PROVIDER_KEY=stale-provider-key
      - RUNNER_IMAGE=old-runner
      - GATEWAY_PORT=8080 # operator port
`,
    );
    const state = draft();
    const updated = createDeployment("/example/instance", state, images, existing);
    expect(updated.toJS().services.lilac.environment).toEqual([
      "CUSTOM_VALUE=keep=with=equals",
      "HOST_SETTING",
    ]);
    expect(updated.toJS().services["computer-use-gateway"].environment).toEqual([
      `RUNNER_IMAGE=${images.runner}`,
      "GATEWAY_PORT=8080",
    ]);
    expect(updated.toString()).toContain("# operator value");
    expect(updated.toString()).toContain("# operator port");
    for (const value of Object.values(state.secrets))
      expect(updated.toString()).not.toContain(value);
    expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
      updated.toString(),
    );
  });

  it("connects installer credentials when reusing the repository deployment", async () => {
    const existing = parseDocument(
      await Bun.file(new URL("../../../compose.yaml", import.meta.url)).text(),
    );
    const updated = createDeployment("/example/instance", draft(false), images, existing);
    expect(updated.toJS().services.lilac.env_file).toEqual([
      { path: "./secrets.env", format: "raw" },
    ]);
    expect(updated.toJS().services.lilac.environment.DISCORD_TOKEN).toBeUndefined();
    expect(updated.toJS().services.lilac.environment.REDIS_URL).toBe(
      existing.toJS().services.lilac.environment.REDIS_URL,
    );
    expect(updated.toString()).toContain(
      "# Persist global installs into the mounted data directory.",
    );
    expect(updated.toJS().services.redis).toEqual(existing.toJS().services.redis);
  });

  it("adds a missing runner image to sequence environment only once", () => {
    const existing = parseDocument(
      "services:\n  lilac:\n    image: old-core\n  computer-use-gateway:\n    image: old-gateway\n    environment:\n      - GATEWAY_PORT=8080\n",
    );
    const state = draft();
    const updated = createDeployment("/example/instance", state, images, existing);
    expect(updated.toJS().services["computer-use-gateway"].environment).toEqual([
      "GATEWAY_PORT=8080",
      `RUNNER_IMAGE=${images.runner}`,
    ]);
    expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
      updated.toString(),
    );
  });
});

describe("installer reused Compose computer-use networks", () => {
  it.each([
    { label: "network sequence", networks: ["agents", "backend"] },
    {
      label: "network mapping",
      networks: {
        agents: {
          ipv4_address: "172.28.0.10",
          mac_address: "02:42:ac:1c:00:0a",
          aliases: ["core-only"],
        },
        backend: null,
      },
    },
  ])("adds a new gateway to Core's $label without reusing endpoint settings", ({ networks }) => {
    const existing = parseDocument("services:\n  lilac:\n    image: old-core\n");
    existing.setIn(["services", "lilac", "networks"], existing.createNode(networks));
    existing.set("networks", existing.createNode({ agents: {}, backend: {} }));
    const updated = createDeployment("/example/instance", draft(), images, existing);
    const gatewayNetworks = updated.toJS().services["computer-use-gateway"].networks;
    expect(networkNames(gatewayNetworks).sort()).toEqual(["agents", "backend"]);
    expect(JSON.stringify(gatewayNetworks)).not.toContain("ipv4_address");
    expect(JSON.stringify(gatewayNetworks)).not.toContain("mac_address");
    expect(JSON.stringify(gatewayNetworks)).not.toContain("aliases");
    expect(updated.toJS().services.lilac.networks).toEqual(networks);
    expect(updated.toJS().networks).toEqual(existing.toJS().networks);
  });

  it.each([
    { label: "network sequence", gatewayNetworks: ["desktops"] },
    {
      label: "network mapping",
      gatewayNetworks: { desktops: { aliases: ["operator-gateway"] } },
    },
  ])(
    "preserves an existing gateway's $label and adds one shared network",
    ({ gatewayNetworks }) => {
      const existing = parseDocument(
        "services:\n  lilac:\n    image: old-core\n    networks: [agents, backend]\n  computer-use-gateway:\n    image: old-gateway\n",
      );
      existing.setIn(
        ["services", "computer-use-gateway", "networks"],
        existing.createNode(gatewayNetworks),
      );
      const state = draft();
      const updated = createDeployment("/example/instance", state, images, existing);
      const networks = updated.toJS().services["computer-use-gateway"].networks;
      const names = networkNames(networks);
      expect(names).toContain("desktops");
      expect(names).toHaveLength(2);
      expect(names.filter((name) => ["agents", "backend"].includes(name))).toHaveLength(1);
      if ("desktops" in gatewayNetworks)
        expect(networks.desktops).toEqual(gatewayNetworks.desktops);
      expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
        updated.toString(),
      );
    },
  );

  it("leaves an existing shared gateway network and its comments untouched", () => {
    const existing = parseDocument(
      `services:
  lilac:
    image: old-core
    networks: [agents, backend]
  computer-use-gateway:
    image: old-gateway
    networks:
      backend: # operator network
        aliases: [desktop-gateway]
      desktops: null
`,
    );
    const updated = createDeployment("/example/instance", draft(), images, existing);
    expect(updated.toJS().services["computer-use-gateway"].networks).toEqual(
      existing.toJS().services["computer-use-gateway"].networks,
    );
    expect(updated.toString()).toContain("# operator network");
  });

  it("joins Core's implicit default network without removing the gateway's custom network", () => {
    const existing = parseDocument(
      "services:\n  lilac:\n    image: old-core\n  computer-use-gateway:\n    image: old-gateway\n    networks: [desktops]\nnetworks:\n  desktops:\n    driver: bridge\n",
    );
    const updated = createDeployment("/example/instance", draft(), images, existing);
    expect(networkNames(updated.toJS().services["computer-use-gateway"].networks).sort()).toEqual([
      "default",
      "desktops",
    ]);
    expect(updated.toJS().networks).toEqual(existing.toJS().networks);
  });

  it.each(["host", "service:network-helper", "none"])(
    "preserves Core network_mode %s without adding gateway networks",
    (mode) => {
      const existing = parseDocument(
        `services:\n  lilac:\n    image: old-core\n    network_mode: ${mode}\n  network-helper:\n    image: network-helper\n`,
      );
      const state = draft();
      const updated = createDeployment("/example/instance", state, images, existing);
      expect(updated.toJS().services.lilac.network_mode).toBe(mode);
      expect(updated.toJS().services.lilac.networks).toBeUndefined();
      expect(updated.toJS().services["computer-use-gateway"].networks).toBeUndefined();
      expect(updated.toJS().services["computer-use-gateway"].network_mode).toBeUndefined();
      expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
        updated.toString(),
      );
    },
  );

  it.each(["host", "service:lilac", "none"])(
    "preserves existing gateway network_mode %s beside Core's named network",
    (mode) => {
      const existing = parseDocument(
        `services:\n  lilac:\n    image: old-core\n    networks: [agents]\n  computer-use-gateway:\n    image: old-gateway\n    network_mode: ${mode}\nnetworks:\n  agents: {}\n`,
      );
      const state = draft();
      const updated = createDeployment("/example/instance", state, images, existing);
      expect(updated.toJS().services["computer-use-gateway"].network_mode).toBe(mode);
      expect(updated.toJS().services["computer-use-gateway"].networks).toBeUndefined();
      expect(updated.toJS().services.lilac.networks).toEqual(["agents"]);
      expect(updated.toJS().networks).toEqual(existing.toJS().networks);
      expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
        updated.toString(),
      );
    },
  );
});

describe("installer reused Compose aliases", () => {
  it.each([
    {
      label: "sequence",
      extension:
        "x-env-files: &env-files\n  - ./operator.env # shared environment file\n  - path: ./overrides.env\n    required: false\n",
      field: "    env_file: *env-files\n",
      expected: [
        "./operator.env",
        { path: "./overrides.env", required: false },
        { path: "./secrets.env", format: "raw" },
      ],
    },
    {
      label: "scalar",
      extension: "x-env-files: &env-files ./operator.env # shared environment file\n",
      field: "    env_file: *env-files\n",
      expected: ["./operator.env", { path: "./secrets.env", format: "raw" }],
    },
    {
      label: "mapping entry",
      extension:
        "x-env-files: &env-files\n  path: ./operator.env # shared environment file\n  required: false\n",
      field: "    env_file:\n      - *env-files\n",
      expected: [
        { path: "./operator.env", required: false },
        { path: "./secrets.env", format: "raw" },
      ],
    },
    {
      label: "managed mapping entry",
      extension:
        "x-env-files: &env-files\n  path: ./secrets.env # shared environment file\n  format: dotenv\n",
      field: "    env_file:\n      - *env-files\n      - ./operator.env\n",
      expected: [{ path: "./secrets.env", format: "dotenv" }, "./operator.env"],
      preservedEnvironmentSource: 'DISCORD_TOKEN="saved-token"\n',
    },
  ])(
    "extends env_file $label aliases without changing shared definitions",
    ({ extension, field, expected, preservedEnvironmentSource }) => {
      const existing = parseDocument(
        `${extension}services:\n  lilac:\n    image: old-core\n${field}  computer-use-gateway:\n    image: old-gateway\n${field}  unrelated:\n    image: unrelated\n${field}`,
      );
      const original = existing.toJS();
      const state = draft();
      state.preservedEnvironmentSource = preservedEnvironmentSource;
      const updated = createDeployment("/example/instance", state, images, existing);
      const output = parseDocument(updated.toString()).toJS();
      for (const service of ["lilac", "computer-use-gateway"]) {
        expect(output.services[service].env_file).toEqual(expected);
      }
      expect(output["x-env-files"]).toEqual(original["x-env-files"]);
      expect(output.services.unrelated).toEqual(original.services.unrelated);
      expect(updated.toString()).toContain("# shared environment file");
      expect(existing.toJS()).toEqual(original);
      expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
        updated.toString(),
      );
    },
  );

  it.each([
    {
      label: "mapping",
      extension:
        "x-environment: &environment\n  DISCORD_TOKEN: stale-token\n  PROVIDER_KEY: stale-key\n  RUNNER_IMAGE: old-runner\n  LOG_LEVEL: debug # shared setting\n",
      core: { RUNNER_IMAGE: "old-runner", LOG_LEVEL: "debug" },
      gateway: { RUNNER_IMAGE: images.runner, LOG_LEVEL: "debug" },
    },
    {
      label: "sequence",
      extension:
        "x-environment: &environment\n  - DISCORD_TOKEN=stale-token\n  - PROVIDER_KEY\n  - RUNNER_IMAGE=old-runner\n  - LOG_LEVEL=debug # shared setting\n",
      core: ["RUNNER_IMAGE=old-runner", "LOG_LEVEL=debug"],
      gateway: [`RUNNER_IMAGE=${images.runner}`, "LOG_LEVEL=debug"],
    },
  ])(
    "updates managed environment $label aliases without changing other consumers",
    ({ extension, core, gateway }) => {
      const existing = parseDocument(
        `${extension}services:\n  lilac:\n    image: old-core\n    environment: *environment\n  computer-use-gateway:\n    image: old-gateway\n    environment: *environment\n  unrelated:\n    image: unrelated\n    environment: *environment\n`,
      );
      const original = existing.toJS();
      const state = draft();
      const updated = createDeployment("/example/instance", state, images, existing);
      const output = parseDocument(updated.toString()).toJS();
      expect(output.services.lilac.environment).toEqual(core);
      expect(output.services["computer-use-gateway"].environment).toEqual(gateway);
      expect(output["x-environment"]).toEqual(original["x-environment"]);
      expect(output.services.unrelated).toEqual(original.services.unrelated);
      expect(updated.toString()).toContain("# shared setting");
      for (const value of Object.values(state.secrets))
        expect(updated.toString()).not.toContain(value);
      expect(existing.toJS()).toEqual(original);
      expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
        updated.toString(),
      );
    },
  );

  it.each([
    {
      label: "sequence",
      extension: "x-core-networks: &core-networks\n  - agents # shared network\n  - backend\n",
    },
    {
      label: "mapping",
      extension:
        "x-core-networks: &core-networks\n  agents: # shared network\n    ipv4_address: 172.28.0.10\n    mac_address: 02:42:ac:1c:00:0a\n    aliases: [core-only]\n  backend: null\n",
    },
  ])("reads Core network $label aliases when adding a gateway", ({ extension }) => {
    const existing = parseDocument(
      `${extension}services:\n  lilac:\n    image: old-core\n    networks: *core-networks\n  unrelated:\n    image: unrelated\n    networks: *core-networks\nnetworks:\n  agents: {}\n  backend: {}\n`,
    );
    const original = existing.toJS();
    const state = draft();
    const updated = createDeployment("/example/instance", state, images, existing);
    const output = parseDocument(updated.toString()).toJS();
    const gatewayNetworks = output.services["computer-use-gateway"].networks;
    expect(networkNames(gatewayNetworks).sort()).toEqual(["agents", "backend"]);
    expect(JSON.stringify(gatewayNetworks)).not.toContain("ipv4_address");
    expect(JSON.stringify(gatewayNetworks)).not.toContain("mac_address");
    expect(JSON.stringify(gatewayNetworks)).not.toContain("aliases");
    expect(output.services.lilac.networks).toEqual(original.services.lilac.networks);
    expect(output.services.unrelated).toEqual(original.services.unrelated);
    expect(output["x-core-networks"]).toEqual(original["x-core-networks"]);
    expect(output.networks).toEqual(original.networks);
    expect(updated.toString()).toContain("# shared network");
    expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
      updated.toString(),
    );
  });

  it.each([
    {
      label: "sequence",
      extension: "x-gateway-networks: &gateway-networks\n  - desktops # shared gateway network\n",
    },
    {
      label: "mapping",
      extension:
        "x-gateway-networks: &gateway-networks\n  desktops: # shared gateway network\n    aliases: [operator-gateway]\n",
    },
  ])("extends gateway network $label aliases without changing other consumers", ({ extension }) => {
    const existing = parseDocument(
      `${extension}services:\n  lilac:\n    image: old-core\n    networks: [agents, backend]\n  computer-use-gateway:\n    image: old-gateway\n    networks: *gateway-networks\n  unrelated:\n    image: unrelated\n    networks: *gateway-networks\nnetworks:\n  agents: {}\n  backend: {}\n  desktops: {}\n`,
    );
    const original = existing.toJS();
    const state = draft();
    const updated = createDeployment("/example/instance", state, images, existing);
    const output = parseDocument(updated.toString()).toJS();
    const gatewayNetworks = output.services["computer-use-gateway"].networks;
    const names = networkNames(gatewayNetworks);
    expect(names).toContain("desktops");
    expect(names).toHaveLength(2);
    expect(names.filter((name) => ["agents", "backend"].includes(name))).toHaveLength(1);
    if (!Array.isArray(gatewayNetworks))
      expect(gatewayNetworks.desktops).toEqual(original["x-gateway-networks"].desktops);
    expect(output.services.unrelated).toEqual(original.services.unrelated);
    expect(output["x-gateway-networks"]).toEqual(original["x-gateway-networks"]);
    expect(output.services.lilac.networks).toEqual(original.services.lilac.networks);
    expect(output.networks).toEqual(original.networks);
    expect(updated.toString()).toContain("# shared gateway network");
    expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
      updated.toString(),
    );
  });
});

describe("installer reused Compose source anchors", () => {
  it.each([
    {
      label: "sequence",
      field:
        "    env_file: &files\n      - ./operator.env # shared source file\n      - path: ./secrets.env\n        format: dotenv\n",
      preservedEnvironmentSource: 'DISCORD_TOKEN="saved-token"\n',
      expected: ["./operator.env", { path: "./secrets.env", format: "dotenv" }],
    },
    {
      label: "scalar",
      field: "    env_file: &files ./operator.env # shared source file\n",
      expected: ["./operator.env", { path: "./secrets.env", format: "raw" }],
    },
  ])(
    "preserves Core's env_file $label anchor consumers and existing formats",
    ({ field, expected, preservedEnvironmentSource }) => {
      const existing = parseDocument(
        `services:\n  lilac:\n    image: old-core\n${field}  unrelated:\n    image: unrelated\n    env_file: *files\n`,
      );
      const original = existing.toJS();
      const state = draft(false);
      state.preservedEnvironmentSource = preservedEnvironmentSource;
      const updated = createDeployment("/example/instance", state, images, existing);
      const output = parseDocument(updated.toString()).toJS();
      expect(output.services.lilac.env_file).toEqual(expected);
      expect(output.services.unrelated).toEqual(original.services.unrelated);
      expect(updated.toString()).toContain("# shared source file");
      expect(existing.toJS()).toEqual(original);
      expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
        updated.toString(),
      );
    },
  );

  it.each([
    {
      label: "mapping",
      field:
        "    environment: &environment\n      DISCORD_TOKEN: stale-token\n      PROVIDER_KEY: stale-key\n      RUNNER_IMAGE: old-runner\n      LOG_LEVEL: debug # shared source setting\n",
      core: { RUNNER_IMAGE: "old-runner", LOG_LEVEL: "debug" },
      gateway: { RUNNER_IMAGE: images.runner, LOG_LEVEL: "debug" },
    },
    {
      label: "sequence",
      field:
        "    environment: &environment\n      - DISCORD_TOKEN=stale-token\n      - PROVIDER_KEY\n      - RUNNER_IMAGE=old-runner\n      - LOG_LEVEL=debug # shared source setting\n",
      core: ["RUNNER_IMAGE=old-runner", "LOG_LEVEL=debug"],
      gateway: [`RUNNER_IMAGE=${images.runner}`, "LOG_LEVEL=debug"],
    },
  ])(
    "updates Core's environment $label anchor without changing unrelated consumers",
    ({ field, core, gateway }) => {
      const existing = parseDocument(
        `services:\n  lilac:\n    image: old-core\n${field}  computer-use-gateway:\n    image: old-gateway\n    environment: *environment\n  unrelated:\n    image: unrelated\n    environment: *environment\n`,
      );
      const original = existing.toJS();
      const state = draft();
      const updated = createDeployment("/example/instance", state, images, existing);
      const output = parseDocument(updated.toString()).toJS();
      expect(output.services.lilac.environment).toEqual(core);
      expect(output.services["computer-use-gateway"].environment).toEqual(gateway);
      expect(output.services.unrelated).toEqual(original.services.unrelated);
      expect(updated.toString()).toContain("# shared source setting");
      for (const value of Object.values(state.secrets))
        expect(updated.toString()).not.toContain(value);
      expect(existing.toJS()).toEqual(original);
      expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
        updated.toString(),
      );
    },
  );

  it.each([
    {
      label: "sequence",
      field: "    networks: &networks\n      - desktops # shared source network\n",
    },
    {
      label: "mapping",
      field:
        "    networks: &networks\n      desktops: # shared source network\n        aliases: [operator-gateway]\n",
    },
  ])("extends the gateway's network $label anchor without changing its consumers", ({ field }) => {
    const existing = parseDocument(
      `services:\n  lilac:\n    image: old-core\n    networks: [agents, backend]\n  computer-use-gateway:\n    image: old-gateway\n${field}  unrelated:\n    image: unrelated\n    networks: *networks\nnetworks:\n  agents: {}\n  backend: {}\n  desktops: {}\n`,
    );
    const original = existing.toJS();
    const state = draft();
    const updated = createDeployment("/example/instance", state, images, existing);
    const output = parseDocument(updated.toString()).toJS();
    const gatewayNetworks = output.services["computer-use-gateway"].networks;
    const names = networkNames(gatewayNetworks);
    expect(names).toContain("desktops");
    expect(names).toHaveLength(2);
    expect(names.filter((name) => ["agents", "backend"].includes(name))).toHaveLength(1);
    if (!Array.isArray(gatewayNetworks))
      expect(gatewayNetworks.desktops).toEqual(
        original.services["computer-use-gateway"].networks.desktops,
      );
    expect(output.services.unrelated).toEqual(original.services.unrelated);
    expect(updated.toString()).toContain("# shared source network");
    expect(existing.toJS()).toEqual(original);
    expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
      updated.toString(),
    );
  });

  it("removes inherited credential overrides while preserving local and shared environment settings", () => {
    const source = `x-environment: &shared
  DISCORD_TOKEN: stale-token
  PROVIDER_KEY: stale-key
  RUNNER_IMAGE: old-runner
  LOG_LEVEL: debug # inherited logging
services:
  lilac:
    image: old-core
    environment:
      <<: *shared
      LOCAL_SETTING: keep # local setting
  computer-use-gateway:
    image: old-gateway
    environment:
      <<: *shared
      GATEWAY_PORT: "8080"
  unrelated:
    image: unrelated
    environment:
      <<: *shared
      LOCAL_SETTING: unrelated
`;
    const existing = parseDocument(source);
    const original = parseDocument(source, { merge: true }).toJS();
    const state = draft();
    const updated = createDeployment("/example/instance", state, images, existing);
    const reparsed = parseDocument(updated.toString(), { merge: true });
    const output = reparsed.toJS();
    expect(output.services.lilac.environment).toEqual({
      RUNNER_IMAGE: "old-runner",
      LOG_LEVEL: "debug",
      LOCAL_SETTING: "keep",
    });
    expect(output.services["computer-use-gateway"].environment).toEqual({
      RUNNER_IMAGE: images.runner,
      LOG_LEVEL: "debug",
      GATEWAY_PORT: "8080",
    });
    expect(output["x-environment"]).toEqual(original["x-environment"]);
    expect(output.services.unrelated).toEqual(original.services.unrelated);
    expect(updated.toString()).toContain("# local setting");
    const inheritedSetting = reparsed.getIn(
      ["services", "lilac", "environment", "LOG_LEVEL"],
      true,
    );
    expect(isScalar(inheritedSetting) && inheritedSetting.comment?.trim()).toBe(
      "inherited logging",
    );
    for (const value of Object.values(state.secrets))
      expect(updated.toString()).not.toContain(value);
    expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
      updated.toString(),
    );
  });
});

describe("installer selective environment updates", () => {
  const source = `services:
  lilac:
    image: old-core
    environment:
      DISCORD_TOKEN: old-discord-token
      PROVIDER_KEY: old-provider-key
      BIND_ADDR: 127.0.0.1
  computer-use-gateway:
    image: old-gateway
    environment:
      DISCORD_TOKEN: old-discord-token
      PROVIDER_KEY: old-provider-key
      BIND_ADDR: 127.0.0.1 # operator binding
      RUNNER_IMAGE: old-runner
`;

  it("preserves saved settings unless their keys were actively configured", () => {
    const state = draft();
    state.secrets.BIND_ADDR = "0.0.0.0";
    const existing = parseDocument(source);
    const updated = assembleDeployment(
      "/example/instance",
      state,
      images,
      existing,
      new Set(["PROVIDER_KEY"]),
    );
    for (const service of ["lilac", "computer-use-gateway"]) {
      expect(updated.toJS().services[service].environment.PROVIDER_KEY).toBeUndefined();
      expect(updated.toJS().services[service].environment.DISCORD_TOKEN).toBe("old-discord-token");
      expect(updated.toJS().services[service].environment.BIND_ADDR).toBe("127.0.0.1");
    }
    expect(updated.toString()).toContain("# operator binding");
  });

  it.each([undefined, new Set<string>()])(
    "preserves explicit credentials when reinstalling without actively configured keys (%j)",
    (managedKeys) => {
      const state = draft();
      state.secrets.BIND_ADDR = "0.0.0.0";
      const existing = parseDocument(source);
      const updated = assembleDeployment("/example/instance", state, images, existing, managedKeys);
      expect(updated.toJS().services.lilac.environment).toEqual(
        existing.toJS().services.lilac.environment,
      );
      expect(updated.toJS().services["computer-use-gateway"].environment).toEqual({
        ...existing.toJS().services["computer-use-gateway"].environment,
        RUNNER_IMAGE: images.runner,
      });
    },
  );
});

describe("installer reused Compose nested source anchors", () => {
  it("preserves a managed env_file format and aliases while updating credentials", () => {
    const existing = parseDocument(`services:
  lilac:
    image: old-core
    env_file:
      - &file
        path: ./secrets.env
        format: dotenv # original format
  extra:
    image: extra
    env_file:
      - *file
`);
    const original = existing.toJS();
    const state = draft(false);
    state.preservedEnvironmentSource = 'DISCORD_TOKEN="saved-token"\n';
    const updated = createDeployment("/example/instance", state, images, existing);
    const output = parseDocument(updated.toString()).toJS();
    expect(output.services.lilac.env_file).toEqual([{ path: "./secrets.env", format: "dotenv" }]);
    expect(output.services.lilac.environment).toEqual(state.secrets);
    expect(output.services.extra).toEqual(original.services.extra);
    expect(updated.toString()).toContain("# original format");
  });

  it("removes a credential scalar anchor while retaining an unrelated alias value", () => {
    const existing = parseDocument(`services:
  lilac:
    image: old-core
    environment:
      DISCORD_TOKEN: &token old-discord-token
      LOG_LEVEL: debug
  extra:
    image: extra
    environment:
      CUSTOM_TOKEN: *token
`);
    const original = existing.toJS();
    const updated = createDeployment("/example/instance", draft(false), images, existing);
    const output = parseDocument(updated.toString()).toJS();
    expect(output.services.lilac.environment).toEqual({ LOG_LEVEL: "debug" });
    expect(output.services.extra).toEqual(original.services.extra);
  });

  it("updates a runner sequence scalar anchor without changing an unrelated runner alias", () => {
    const existing = parseDocument(`services:
  lilac:
    image: old-core
  computer-use-gateway:
    image: old-gateway
    environment:
      - &runner RUNNER_IMAGE=old-runner
      - GATEWAY_PORT=8080
  extra:
    image: extra
    environment:
      - *runner
`);
    const original = existing.toJS();
    const state = draft();
    const updated = createDeployment("/example/instance", state, images, existing);
    const output = parseDocument(updated.toString()).toJS();
    expect(output.services["computer-use-gateway"].environment).toEqual([
      `RUNNER_IMAGE=${images.runner}`,
      "GATEWAY_PORT=8080",
    ]);
    expect(output.services.extra).toEqual(original.services.extra);
    expect(createDeployment("/example/instance", state, images, updated).toString()).toBe(
      updated.toString(),
    );
  });
});

describe("installer existing environment file precedence", () => {
  const cases = [
    {
      label: "mapping",
      field: `    environment:
      SELECTED_KEY: old-selected-key
      BIND_ADDR: 127.0.0.1 # operator binding
      UNTOUCHED_TOKEN: \${EXISTING_TOKEN}
      RUNNER_IMAGE: ${images.runner}
`,
    },
    {
      label: "sequence",
      field: `    environment:
      - SELECTED_KEY=old-selected-key
      - BIND_ADDR=127.0.0.1 # operator binding
      - UNTOUCHED_TOKEN
      - RUNNER_IMAGE=${images.runner}
`,
    },
  ];

  function existingDeployment(field: string) {
    const files =
      "    env_file:\n      - path: ./secrets.env\n        format: raw\n      - ./custom.env # later overrides\n";
    return parseDocument(
      `services:\n  lilac:\n    image: old-core\n${files}${field}  computer-use-gateway:\n    image: old-gateway\n${files}${field}`,
    );
  }

  it.each(cases)(
    "preserves file order and unselected $label values while applying confirmed credentials",
    ({ field }) => {
      const existing = existingDeployment(field);
      const original = existing.toJS();
      const state = draft();
      state.secrets.SELECTED_KEY = 'literal$TOKEN#quote"value=with\\suffix';
      state.secrets.BIND_ADDR = "0.0.0.0";
      state.secrets.UNTOUCHED_TOKEN = "saved-unselected-token";
      const keys = new Set(["SELECTED_KEY"]);
      const updated = assembleDeployment("/example/instance", state, images, existing, keys);
      const output = parseDocument(updated.toString()).toJS();
      const escaped = 'literal$$TOKEN#quote"value=with\\suffix';
      for (const service of ["lilac", "computer-use-gateway"]) {
        expect(output.services[service].env_file).toEqual(original.services[service].env_file);
        const environment = original.services[service].environment;
        const expected = Array.isArray(environment)
          ? environment.map((value) =>
              value.startsWith("SELECTED_KEY=") ? `SELECTED_KEY=${escaped}` : value,
            )
          : { ...environment, SELECTED_KEY: escaped };
        expect(output.services[service].environment).toEqual(expected);
      }
      expect(updated.toString()).toContain("# operator binding");
      expect(updated.toString()).toContain("# later overrides");
      expect(updated.toString()).not.toContain("saved-unselected-token");
      expect(assembleDeployment("/example/instance", state, images, updated, keys).toString()).toBe(
        updated.toString(),
      );
    },
  );

  it.each(cases)(
    "preserves $label environment and file order on reinstall with no configured keys",
    ({ field }) => {
      const existing = existingDeployment(field);
      const state = draft();
      state.secrets.SELECTED_KEY = "saved-selected-key";
      state.secrets.BIND_ADDR = "0.0.0.0";
      const original = existing.toJS();
      for (const keys of [undefined, new Set<string>()]) {
        const updated = assembleDeployment("/example/instance", state, images, existing, keys);
        const output = parseDocument(updated.toString()).toJS();
        for (const service of ["lilac", "computer-use-gateway"]) {
          expect(output.services[service].env_file).toEqual(original.services[service].env_file);
          expect(output.services[service].environment).toEqual(
            original.services[service].environment,
          );
        }
      }
    },
  );
});
