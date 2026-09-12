import { describe, expect, it } from "bun:test";
import path from "node:path";
import { Result } from "better-result";
import { parseDocument } from "yaml";
import {
  inspectDeployment,
  validateManagedLayout,
  type ResolvedDeployment,
} from "../src/compose-inspection";
import { InstallerDeploymentFailed, parseDeployment } from "../src/deployment";
import { command, InstallerSystemFailed } from "../src/system";

const root = "/example/instance";
const document = (computerEnabled = false) =>
  parseDocument(
    "name: lilac_test\nservices:\n  lilac:\n    image: lilac\n" +
      (computerEnabled ? "  computer-use-gateway:\n    image: gateway\n" : ""),
  );
type CommandOutcome = Awaited<ReturnType<typeof command>>;
type Service = ResolvedDeployment["services"]["lilac"];

function deployment(overrides: Partial<Service> = {}): ResolvedDeployment {
  return {
    services: {
      lilac: {
        environment: {},
        volumes: [{ type: "bind", source: path.join(root, "data"), target: "/data" }],
        tmpfs: [],
        volumes_from: [],
        networks: {},
        ...overrides,
      },
    },
  };
}

function fakeCommand(
  outcome: CommandOutcome,
  metadata: CommandOutcome = Result.ok({ code: 0, stdout: "lilac\n" }),
) {
  const calls: { args: string[]; options: Parameters<typeof command>[1] }[] = [];
  const run: typeof command = async (args, options) => {
    calls.push({ args: [...args], options });
    if (args.at(-1) === "--services") return metadata;
    return outcome;
  };
  return { calls, run };
}

function jsonCommand(value: unknown) {
  let names = ["lilac"];
  if (
    value !== null &&
    typeof value === "object" &&
    "services" in value &&
    value.services !== null &&
    typeof value.services === "object"
  )
    names = [...new Set(["lilac", ...Object.keys(value.services)])];
  return fakeCommand(
    Result.ok({ code: 0, stdout: JSON.stringify(value) }),
    Result.ok({ code: 0, stdout: names.join("\n") + "\n" }),
  );
}

describe("installer Compose inspection", () => {
  it("pins metadata inspection and resolves only managed services with ambient profiles cleared", async () => {
    const resolved = deployment({
      image: "registry.example/lilac:release",
      build: { context: "/example/build" },
      environment: { DATA_DIR: "/data", INHERITED: null },
      tmpfs: ["/tmp:rw"],
      networks: { agents: {}, optional: null },
      user: "1000:1000",
    });
    resolved.services["computer-use-gateway"] = {
      image: "registry.example/gateway:release",
      environment: { RUNNER_IMAGE: "registry.example/runner:release" },
      volumes: [{ type: "volume", source: "desktops", target: "/data", read_only: false }],
      tmpfs: [],
      volumes_from: [],
      networks: {},
      network_mode: "host",
    };
    const fake = jsonCommand({
      ...resolved,
      services: { ...resolved.services, unrelated: { image: "unrelated" } },
    });
    const result = await inspectDeployment(root, document(true), fake.run);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.services.lilac).toEqual(resolved.services.lilac);
      expect(result.value.services["computer-use-gateway"]).toEqual(
        resolved.services["computer-use-gateway"],
      );
    }
    expect(fake.calls).toHaveLength(2);
    const prefix = [
      "docker",
      "compose",
      "--file",
      path.resolve(root, "compose.yaml"),
      "--project-name",
      "lilac_test",
    ];
    expect(fake.calls[0]?.args).toEqual([...prefix, "--profile", "*", "config", "--services"]);
    expect(fake.calls[1]?.args).toEqual([
      ...prefix,
      "--profile",
      "",
      "config",
      "--format",
      "json",
      "lilac",
      "computer-use-gateway",
    ]);
    for (const call of fake.calls) {
      expect(call.options?.cwd).toBe(root);
      expect(call.options?.inherit).not.toBe(true);
    }
  });

  it("supplies empty collections when optional resolved fields are absent", async () => {
    const fake = jsonCommand({
      services: { lilac: { volumes: deployment().services.lilac.volumes } },
    });
    const result = await inspectDeployment(root, document(), fake.run);
    expect(result).toEqual(Result.ok(deployment()));
  });

  it("decodes Compose dollar escaping exactly once across keys, values, and mount paths", async () => {
    const fake = jsonCommand({
      services: {
        lilac: {
          environment: {
            LITERAL$$KEY: "$${NAME}",
            PAIR: "$$$$",
            PUNCTUATION: 'literal$$TOKEN#quote"value=with\\suffix',
          },
          volumes: [{ type: "bind", source: "/example/$$storage/data", target: "/data" }],
        },
      },
    });
    const result = await inspectDeployment("/example/$storage", document(), fake.run);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.services.lilac.environment).toEqual({
        LITERAL$KEY: "${NAME}",
        PAIR: "$$",
        PUNCTUATION: 'literal$TOKEN#quote"value=with\\suffix',
      });
      expect(result.value.services.lilac.volumes[0]?.source).toBe("/example/$storage/data");
    }
  });

  it("rejects an invalid project name without invoking Compose", async () => {
    const fake = jsonCommand(deployment());
    const invalid = parseDocument("name: ${PROJECT_NAME}\nservices:\n  lilac:\n    image: lilac\n");
    const result = await inspectDeployment(root, invalid, fake.run);
    expect(result.isErr()).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("rejects a resolved Core layout that does not use the managed data bind", async () => {
    const resolved = deployment({
      volumes: [{ type: "volume", source: "operator-data", target: "/data" }],
    });
    const fake = jsonCommand(resolved);
    const result = await inspectDeployment(root, document(), fake.run);
    expect(result.isErr()).toBe(true);
    expect(fake.calls).toHaveLength(2);
    if (result.isErr()) expect(result.error.message).toMatch(/writable bind mount/i);
  });

  it.each([
    { label: "missing services", value: {} },
    { label: "missing Core", value: { services: {} } },
    { label: "null Core", value: { services: { lilac: null } } },
    { label: "numeric image", value: { services: { lilac: { image: 123 } } } },
    {
      label: "sequence environment",
      value: { services: { lilac: { environment: ["KEY=value"] } } },
    },
    {
      label: "numeric environment value",
      value: { services: { lilac: { environment: { KEY: 123 } } } },
    },
    {
      label: "volume without a target",
      value: { services: { lilac: { volumes: [{ type: "bind" }] } } },
    },
    {
      label: "string read-only flag",
      value: {
        services: { lilac: { volumes: [{ type: "bind", target: "/data", read_only: "true" }] } },
      },
    },
    { label: "null gateway", value: { services: { lilac: {}, "computer-use-gateway": null } } },
  ])("rejects malformed resolved output: $label", async ({ value }) => {
    const result = await inspectDeployment(root, document(true), jsonCommand(value).run);
    expect(result.isErr()).toBe(true);
  });

  it.each(["command", "exit", "json", "schema"])(
    "returns a generic secret-free failure after a %s error",
    async (kind) => {
      const secret = "fixture-provider-secret-never-in-error";
      let outcome: CommandOutcome = Result.ok({ code: 0, stdout: secret });
      if (kind === "command")
        outcome = Result.err(new InstallerSystemFailed({ message: `Fixture error: ${secret}` }));
      if (kind === "exit") outcome = Result.ok({ code: 1, stdout: secret });
      if (kind === "schema")
        outcome = Result.ok({ code: 0, stdout: JSON.stringify({ services: { lilac: secret } }) });
      const result = await inspectDeployment(root, document(), fakeCommand(outcome).run);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(InstallerDeploymentFailed);
        expect(JSON.stringify(result.error)).not.toContain(secret);
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    },
  );
});

describe("installer managed data layout", () => {
  it.each([undefined, null, "/data", "/data/", "/ignored/../data"])(
    "accepts DATA_DIR %j with the writable managed data bind",
    (dataDir) => {
      const environment: Service["environment"] = {};
      if (dataDir !== undefined) environment.DATA_DIR = dataDir;
      expect(validateManagedLayout(root, deployment({ environment })).isOk()).toBe(true);
    },
  );

  it.each(["", "data", "./data", "/other", "/data/child"])(
    "rejects DATA_DIR %j outside the managed root",
    (DATA_DIR) => {
      expect(validateManagedLayout(root, deployment({ environment: { DATA_DIR } })).isErr()).toBe(
        true,
      );
    },
  );

  it.each([
    { label: "missing data mount", volumes: [] },
    { label: "named data volume", volumes: [{ type: "volume", source: "data", target: "/data" }] },
    { label: "missing bind source", volumes: [{ type: "bind", target: "/data" }] },
    {
      label: "other bind source",
      volumes: [{ type: "bind", source: "/example/elsewhere", target: "/data" }],
    },
    {
      label: "read-only data",
      volumes: [
        { type: "bind", source: path.join(root, "data"), target: "/data", read_only: true },
      ],
    },
    {
      label: "duplicate data target",
      volumes: [
        { type: "bind", source: path.join(root, "data"), target: "/data" },
        { type: "bind", source: path.join(root, "data"), target: "/data" },
      ],
    },
    {
      label: "nested data mount",
      volumes: [
        { type: "bind", source: path.join(root, "data"), target: "/data" },
        { type: "volume", source: "credentials", target: "/data/secret" },
      ],
    },
    {
      label: "normalized nested data mount",
      volumes: [
        { type: "bind", source: path.join(root, "data"), target: "/data" },
        { type: "bind", source: "/example/credentials", target: "/tmp/../data/secret" },
      ],
    },
  ])("rejects $label", ({ volumes }) => {
    expect(validateManagedLayout(root, deployment({ volumes: [...volumes] })).isErr()).toBe(true);
  });

  it.each(["/data", "/data:rw", "/data/secret:rw", "/tmp/../data/secret:rw"])(
    "rejects tmpfs that hides managed files: %s",
    (entry) => {
      expect(validateManagedLayout(root, deployment({ tmpfs: [entry] })).isErr()).toBe(true);
    },
  );

  it("rejects inherited volumes because they can hide managed files", () => {
    expect(validateManagedLayout(root, deployment({ volumes_from: ["legacy:ro"] })).isErr()).toBe(
      true,
    );
  });

  it("allows unrelated mounts and tmpfs with similar names", () => {
    const value = deployment({
      volumes: [
        { type: "bind", source: path.join(root, "data"), target: "/data", read_only: false },
        { type: "volume", source: "database", target: "/database" },
      ],
      tmpfs: ["/tmp:rw", "/database-cache:rw"],
    });
    expect(validateManagedLayout(root, value).isOk()).toBe(true);
  });

  it.each([undefined, "1000", "1000:1000", "1000:staff", "lilac", "lilac:1000", "lilac:staff"])(
    "accepts service user %j",
    (user) => {
      expect(
        validateManagedLayout(root, deployment(user === undefined ? {} : { user })).isOk(),
      ).toBe(true);
    },
  );

  it.each(["", "0", "root", "1001", "other", "root:1000", "1001:lilac"])(
    "rejects service user %j",
    (user) => {
      expect(validateManagedLayout(root, deployment({ user })).isErr()).toBe(true);
    },
  );
});

describe("installer Compose managed service ownership", () => {
  const privateSource = "fixture-private-source-value";

  it.each([
    {
      label: "Core string extends",
      source: `services:\n  lilac:\n    extends: ${privateSource}\n`,
    },
    {
      label: "Core mapping extends",
      source: `services:\n  lilac:\n    extends:\n      file: ./${privateSource}.yaml\n      service: core\n`,
    },
    {
      label: "gateway string extends",
      source: `services:\n  lilac:\n    image: lilac\n  computer-use-gateway:\n    extends: ${privateSource}\n`,
    },
    {
      label: "gateway mapping extends",
      source: `services:\n  lilac:\n    image: lilac\n  computer-use-gateway:\n    extends:\n      file: ./${privateSource}.yaml\n      service: gateway\n`,
    },
    {
      label: "Core alias with extends",
      source: `x-core: &core\n  extends: ${privateSource}\nservices:\n  lilac: *core\n`,
    },
    {
      label: "Core merge with extends",
      source: `x-core: &core\n  extends:\n    file: ./${privateSource}.yaml\n    service: core\nservices:\n  lilac:\n    <<: *core\n    image: lilac\n`,
    },
    {
      label: "gateway alias with extends",
      source: `x-gateway: &gateway\n  extends: ${privateSource}\nservices:\n  lilac:\n    image: lilac\n  computer-use-gateway: *gateway\n`,
    },
    {
      label: "gateway merge with extends",
      source: `x-gateway: &gateway\n  extends:\n    file: ./${privateSource}.yaml\n    service: gateway\nservices:\n  lilac:\n    image: lilac\n  computer-use-gateway:\n    <<: *gateway\n    image: gateway\n`,
    },
  ])("rejects $label with a safe manual-setup instruction", async ({ source }) => {
    const resolved = deployment();
    if (source.includes("computer-use-gateway:"))
      resolved.services["computer-use-gateway"] = deployment().services.lilac;
    const fake = jsonCommand(resolved);
    const result = await inspectDeployment(
      root,
      parseDocument(`name: lilac_test\n${source}`),
      fake.run,
    );
    expect(result.isErr()).toBe(true);
    expect(fake.calls).toHaveLength(1);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(InstallerDeploymentFailed);
      expect(result.error.message).toMatch(/standalone|manual/i);
      expect(JSON.stringify(result.error)).not.toContain(privateSource);
    }
  });

  it.each([
    {
      label: "Core",
      source: "include: [./managed.yaml]\nservices:\n  unrelated:\n    image: unrelated\n",
      computerEnabled: false,
    },
    {
      label: "gateway",
      source: "include: [./managed.yaml]\nservices:\n  lilac:\n    image: lilac\n",
      computerEnabled: true,
    },
  ])(
    "rejects a resolved $label that is only defined by an include",
    async ({ source, computerEnabled }) => {
      const resolved = deployment();
      if (computerEnabled) resolved.services["computer-use-gateway"] = deployment().services.lilac;
      const fake = jsonCommand(resolved);
      const result = await inspectDeployment(
        root,
        parseDocument(`name: lilac_test\n${source}`),
        fake.run,
      );
      expect(result.isErr()).toBe(true);
      expect(fake.calls).toHaveLength(1);
      if (result.isErr()) expect(result.error.message).toMatch(/standalone|manual/i);
    },
  );

  it("allows includes that only supply unrelated services", async () => {
    const source = parseDocument(
      "name: lilac_test\ninclude: [./extras.yaml]\nservices:\n  lilac:\n    image: lilac\n",
    );
    const resolved = deployment();
    const fake = jsonCommand({
      ...resolved,
      services: { ...resolved.services, unrelated: { image: "unrelated" } },
    });
    expect((await inspectDeployment(root, source, fake.run)).isOk()).toBe(true);
  });

  it.each([
    {
      label: "aliases",
      source:
        "x-service: &service\n  image: managed\nservices:\n  lilac: *service\n  computer-use-gateway: *service\n",
    },
    {
      label: "merges",
      source:
        "x-service: &service\n  image: managed\nservices:\n  lilac:\n    <<: *service\n  computer-use-gateway:\n    <<: *service\n",
    },
  ])("allows local managed services defined through $label without extends", async ({ source }) => {
    const resolved = deployment();
    resolved.services["computer-use-gateway"] = deployment().services.lilac;
    const fake = jsonCommand(resolved);
    const result = await inspectDeployment(
      root,
      parseDocument(`name: lilac_test\n${source}`),
      fake.run,
    );
    expect(result.isOk()).toBe(true);
  });

  it.each([
    {
      label: "alias",
      source: "x-services: &services\n  lilac:\n    image: lilac\nservices: *services\n",
    },
    {
      label: "merge",
      source: "x-services: &services\n  lilac:\n    image: lilac\nservices:\n  <<: *services\n",
    },
  ])("parses and inspects a local services $label", async ({ source }) => {
    const parsed = parseDeployment(source);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk())
      expect(
        (await inspectDeployment(root, parsed.value, jsonCommand(deployment()).run)).isOk(),
      ).toBe(true);
  });

  it("rejects malformed normalized output after valid managed service metadata", async () => {
    const fake = jsonCommand({ services: { lilac: null } });
    const result = await inspectDeployment(root, document(), fake.run);
    expect(result.isErr()).toBe(true);
    expect(fake.calls).toHaveLength(2);
    if (result.isErr()) expect(result.error.message).toMatch(/could not inspect/i);
  });
});

describe("installer Compose service metadata", () => {
  const secret = "fixture-metadata-secret-never-in-error";

  it.each([
    {
      label: "command failure",
      outcome: Result.err(new InstallerSystemFailed({ message: secret })),
    },
    { label: "nonzero exit", outcome: Result.ok({ code: 1, stdout: secret }) },
    { label: "empty service list", outcome: Result.ok({ code: 0, stdout: "" }) },
    {
      label: "malformed service name",
      outcome: Result.ok({ code: 0, stdout: `lilac\ninvalid service ${secret}\n` }),
    },
    { label: "missing Core service", outcome: Result.ok({ code: 0, stdout: "unrelated\n" }) },
  ])("stops before resolving environments after $label", async ({ outcome }) => {
    const fake = fakeCommand(Result.ok({ code: 0, stdout: JSON.stringify(deployment()) }), outcome);
    const result = await inspectDeployment(root, document(), fake.run);
    expect(result.isErr()).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args.at(-1)).toBe("--services");
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(InstallerDeploymentFailed);
      expect(JSON.stringify(result.error)).not.toContain(secret);
    }
  });

  it("does not resolve an unrelated service's missing env file", async () => {
    const source = parseDocument(`name: lilac_test
services:
  lilac:
    image: lilac
  unrelated:
    image: unrelated
    profiles: [maintenance]
    env_file: ./missing-unrelated.env
`);
    const fake = fakeCommand(
      Result.ok({ code: 0, stdout: JSON.stringify(deployment()) }),
      Result.ok({ code: 0, stdout: "lilac\nunrelated\n" }),
    );
    const result = await inspectDeployment(root, source, fake.run);
    expect(result.isOk()).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.args.slice(-4)).toEqual(["--profile", "*", "config", "--services"]);
    expect(fake.calls[1]?.args).toEqual([
      "docker",
      "compose",
      "--file",
      path.resolve(root, "compose.yaml"),
      "--project-name",
      "lilac_test",
      "--profile",
      "",
      "config",
      "--format",
      "json",
      "lilac",
    ]);
  });
});
