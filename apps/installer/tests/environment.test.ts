import { describe, expect, it } from "bun:test";
import { parseDocument } from "yaml";
import type { ResolvedDeployment } from "../src/compose-inspection";
import { createDeployment, validateDeploymentInputs } from "../src/deployment";
import { readSetupEnvironment } from "../src/environment";
import type { SetupDraft } from "../src/types";

const root = "/example/lilac";
const images = {
  core: "registry.example/lilac:release",
  gateway: "registry.example/gateway:release",
  runner: "registry.example/runner:release",
};
type Environment = Record<string, string | null>;

function resolved(core: Environment, gateway?: Environment): ResolvedDeployment {
  const service = (environment: Environment) => ({
    environment,
    volumes: [],
    tmpfs: [],
    volumes_from: [],
    networks: {},
  });
  return {
    services: {
      lilac: service(core),
      ...(gateway ? { "computer-use-gateway": service(gateway) } : {}),
    },
  };
}

function compose(service: string) {
  return parseDocument(
    `name: fixture-install\nservices:\n  lilac:\n    image: existing-core\n${service}`,
  );
}

function draft(
  environment: ReturnType<typeof readSetupEnvironment>,
  selected: string[] = [],
): SetupDraft {
  return {
    get: () => undefined,
    set: () => {},
    remove: () => {},
    ...environment,
    configuredEnvironmentKeys: new Set(selected),
    files: [],
    stagingDir: "",
    readExistingFile: async () => undefined,
    computerEnabled: false,
  };
}

describe("installer environment source", () => {
  it("reads literal values for a fresh installation", () => {
    const value = 'literal$VARIABLE#quote"value\\suffix';
    const source = `PROVIDER_KEY=${value}\r\nEMPTY=\r\n`;
    expect(readSetupEnvironment(undefined, source)).toEqual({
      secrets: { PROVIDER_KEY: value, EMPTY: "" },
    });
    expect(readSetupEnvironment()).toEqual({ secrets: {} });
  });

  it.each([
    { format: "raw", source: "# retain raw bytes\r\nKEY=literal$TOKEN#value\r\n" },
    { format: "dotenv", source: '# retain dotenv bytes\nKEY="${TOKEN_VALUE}"\n' },
  ])("uses resolved values and preserves the $format source exactly", ({ source }) => {
    const existing = resolved({ KEY: "effective-override", EMPTY: "", UNSET: null });
    const original = structuredClone(existing);
    expect(readSetupEnvironment(existing, source)).toEqual({
      secrets: { KEY: "effective-override", EMPTY: "" },
      preservedEnvironmentSource: source,
    });
    expect(existing).toEqual(original);
  });

  it("preserves an absent source for an existing deployment without inventing values", () => {
    expect(readSetupEnvironment(resolved({ KEY: "from-another-env-file" }))).toEqual({
      secrets: { KEY: "from-another-env-file" },
      preservedEnvironmentSource: "",
    });
  });

  it("retains dollars already decoded by Compose inspection", () => {
    const value = "literal$TOKEN ${REFERENCE} $$ $$$$";
    expect(readSetupEnvironment(resolved({ KEY: value }), "KEY=older\n").secrets.KEY).toBe(value);
  });

  it("takes gateway connection settings and Core shared credentials from effective values", () => {
    const gateway = {
      MCP_BEARER_SECRET: "gateway-bearer",
      BIND_ADDR: "0.0.0.0",
      RENDERED_HOST: "https://desktop.example",
      PORT_RANGE_START: "19000",
      PORT_RANGE_END: "19009",
    };
    const core = Object.fromEntries(Object.keys(gateway).map((key) => [key, "core-default"]));
    const loaded = readSetupEnvironment(
      resolved(
        { ...core, SHARED: "core-token", CORE_ONLY: "core-value", UNSET: null },
        { ...gateway, SHARED: "gateway-token", GATEWAY_ONLY: "gateway-value", UNSET: "shadowed" },
      ),
      'SHARED="source-token"\n',
    );
    expect(loaded.secrets).toEqual({
      ...gateway,
      SHARED: "core-token",
      CORE_ONLY: "core-value",
      GATEWAY_ONLY: "gateway-value",
    });
    expect(loaded.preservedEnvironmentSource).toBe('SHARED="source-token"\n');
  });

  it.each(["raw", "dotenv"])(
    "overrides only a selected credential while preserving a %s env_file",
    (format) => {
      const existing = compose(
        `    env_file:\n      - path: ./secrets.env\n        format: ${format}\n    environment:\n      UNTOUCHED: operator-value\n`,
      );
      const source = `# retain this comment\nDISCORD_TOKEN="old-token"\nMULTILINE='first\nsecond'\n`;
      const effective = resolved({
        DISCORD_TOKEN: "effective-token",
        UNTOUCHED: "operator-value",
        MULTILINE: "first\nsecond",
      });
      const loaded = readSetupEnvironment(effective, source);
      const state = draft(loaded, ["DISCORD_TOKEN"]);
      state.secrets.DISCORD_TOKEN = "selected$TOKEN#quote'value";
      const updated = createDeployment(
        root,
        state,
        images,
        { document: existing, resolved: effective },
        state.configuredEnvironmentKeys,
      );
      expect(updated.toJS().services.lilac.env_file).toEqual([{ path: "./secrets.env", format }]);
      expect(updated.toJS().services.lilac.environment).toEqual({
        UNTOUCHED: "operator-value",
        DISCORD_TOKEN: "selected$$TOKEN#quote'value",
      });
      expect(state.preservedEnvironmentSource).toBe(source);
      expect(validateDeploymentInputs(state, images, effective).isOk()).toBe(true);
    },
  );

  it.each(["raw", "dotenv"])(
    "retains skipped explicit overrides when reinstalling with a %s env_file",
    (format) => {
      const existing = compose(
        `    env_file:\n      - path: ./secrets.env\n        format: ${format}\n` +
          "    environment:\n      DISCORD_TOKEN: 'operator$$TOKEN $${REFERENCE} $$$$'\n",
      );
      const source = "DISCORD_TOKEN=older-token\n";
      const effective = resolved({ DISCORD_TOKEN: "operator$TOKEN ${REFERENCE} $$" });
      const state = draft(readSetupEnvironment(effective, source));
      expect(state.secrets.DISCORD_TOKEN).toBe("operator$TOKEN ${REFERENCE} $$");
      const updated = createDeployment(
        root,
        state,
        images,
        { document: existing, resolved: effective },
        state.configuredEnvironmentKeys,
      );
      expect(updated.toJS().services.lilac.environment).toEqual(
        existing.toJS().services.lilac.environment,
      );
      expect(updated.toJS().services.lilac.env_file).toEqual(
        existing.toJS().services.lilac.env_file,
      );
      expect(state.preservedEnvironmentSource).toBe(source);
    },
  );

  it("preserves interpolated file paths, comments, and later override precedence", () => {
    const existing = compose(
      "    env_file:\n      - ${LOCAL_SECRETS:-./secrets.env}\n      - ./operator.env # keep this file last\n",
    );
    const source = 'DISCORD_TOKEN="quoted-token"\nBIND_ADDR="127.0.0.1"\n';
    const effective = resolved({ DISCORD_TOKEN: "quoted-token", BIND_ADDR: "0.0.0.0" });
    const state = draft(readSetupEnvironment(effective, source), ["DISCORD_TOKEN"]);
    expect(state.secrets.BIND_ADDR).toBe("0.0.0.0");
    state.secrets.DISCORD_TOKEN = "replacement-token";
    const updated = createDeployment(
      root,
      state,
      images,
      { document: existing, resolved: effective },
      state.configuredEnvironmentKeys,
    );
    expect(updated.toJS().services.lilac.env_file).toEqual(existing.toJS().services.lilac.env_file);
    expect(updated.toString()).toContain("# keep this file last");
    expect(updated.toJS().services.lilac.environment).toEqual({
      DISCORD_TOKEN: "replacement-token",
    });
    expect(state.preservedEnvironmentSource).toBe(source);
  });

  it("accepts preserved multiline values but rejects newly configured multiline credentials", () => {
    const source = "MULTILINE='first\nsecond'\n";
    const effective = resolved({ MULTILINE: "first\nsecond" });
    const state = draft(readSetupEnvironment(effective, source));
    expect(validateDeploymentInputs(state, images, effective).isOk()).toBe(true);
    state.configuredEnvironmentKeys?.add("MULTILINE");
    const result = validateDeploymentInputs(state, images, effective);
    expect(result.isErr()).toBe(true);
    const failure = result.match({ ok: () => undefined, err: (error) => error });
    expect(failure?.message).not.toContain("first");
    expect(failure?.message).not.toContain("second");
    expect(state.preservedEnvironmentSource).toBe(source);
  });
});
