import { describe, expect, test } from "bun:test";
import { parseDocument } from "yaml";

import type { ExistingDeployment, ResolvedDeployment } from "../src/compose-inspection";
import { createDeployment, resolveImages, type ImageReferences } from "../src/deployment";
import type { SetupDraft } from "../src/types";

const imageEnvironmentKeys = [
  "LILAC_IMAGE",
  "LILAC_COMPUTER_GATEWAY_IMAGE",
  "LILAC_COMPUTER_RUNNER_IMAGE",
  "LILAC_DEFAULT_IMAGE",
  "LILAC_DEFAULT_COMPUTER_GATEWAY_IMAGE",
  "LILAC_DEFAULT_COMPUTER_RUNNER_IMAGE",
] as const;

function imageEnvironment(
  values: Partial<Record<(typeof imageEnvironmentKeys)[number], string>> = {},
) {
  const previous = new Map(imageEnvironmentKeys.map((name) => [name, process.env[name]]));
  for (const name of imageEnvironmentKeys) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  return {
    [Symbol.dispose]() {
      for (const name of imageEnvironmentKeys) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const published: ImageReferences = {
  core: "ghcr.io/stanley2058/lilac-mono:latest",
  gateway: "ghcr.io/stanley2058/lilac-computer-gateway:latest",
  runner: "ghcr.io/stanley2058/lilac-computer:latest",
};
const resolvedImages: ImageReferences = {
  core: "registry.example/core:resolved",
  gateway: "registry.example/gateway:resolved",
  runner: "registry.example/runner:resolved",
};
const selected: ImageReferences = {
  core: "registry.example/core:selected",
  gateway: "registry.example/gateway:selected",
  runner: "registry.example/runner:selected",
};

type ResolvedService = ResolvedDeployment["services"]["lilac"];
function service(values: Partial<ResolvedService>): ResolvedService {
  return {
    environment: {},
    volumes: [],
    tmpfs: [],
    volumes_from: [],
    networks: { default: {} },
    ...values,
  };
}

function resolved(
  options: { coreBuild?: boolean; gatewayBuild?: boolean } = {},
): ResolvedDeployment {
  return {
    services: {
      lilac: service({
        image: resolvedImages.core,
        build: options.coreBuild ? { context: "/example/core" } : undefined,
      }),
      "computer-use-gateway": service({
        image: resolvedImages.gateway,
        build: options.gatewayBuild ? { context: "/example/gateway" } : undefined,
        environment: { RUNNER_IMAGE: resolvedImages.runner },
      }),
    },
  };
}

function draft(): SetupDraft {
  return {
    get: () => undefined,
    set: () => {},
    remove: () => {},
    secrets: {},
    files: [],
    stagingDir: "",
    readExistingFile: async () => undefined,
    computerEnabled: true,
  };
}

describe("installer image selection", () => {
  test.each([
    { label: "mapping", source: "    environment:\n      RUNNER_IMAGE: source-runner\n" },
    { label: "sequence", source: "    environment:\n      - RUNNER_IMAGE=source-runner\n" },
    { label: "env_file", source: "    env_file: ./gateway.env\n" },
    {
      label: "interpolation",
      source: "    environment:\n      RUNNER_IMAGE: ${OPERATOR_RUNNER_IMAGE}\n",
    },
  ])("uses resolved images and the effective runner from $label input", ({ source }) => {
    using _environment = imageEnvironment();
    const existing: ExistingDeployment = {
      document: parseDocument(
        `services:\n  lilac:\n    image: \${OPERATOR_CORE_IMAGE}\n  computer-use-gateway:\n    image: \${OPERATOR_GATEWAY_IMAGE}\n${source}`,
      ),
      resolved: resolved(),
    };
    const images = resolveImages(existing.resolved);
    expect(images).toEqual(resolvedImages);
    const updated = createDeployment("/example/instance", draft(), images, existing).toJS();
    expect(updated.services.lilac.image).toBe(resolvedImages.core);
    expect(updated.services["computer-use-gateway"].image).toBe(resolvedImages.gateway);
    const environment = updated.services["computer-use-gateway"].environment;
    if (Array.isArray(environment)) {
      expect(environment).toContain(`RUNNER_IMAGE=${resolvedImages.runner}`);
      return;
    }
    expect(environment.RUNNER_IMAGE).toBe(resolvedImages.runner);
  });

  test("explicit overrides win over resolved values, builds, and release defaults", () => {
    using _environment = imageEnvironment({
      LILAC_IMAGE: selected.core,
      LILAC_COMPUTER_GATEWAY_IMAGE: selected.gateway,
      LILAC_COMPUTER_RUNNER_IMAGE: selected.runner,
      LILAC_DEFAULT_IMAGE: "registry.example/core:default",
      LILAC_DEFAULT_COMPUTER_GATEWAY_IMAGE: "registry.example/gateway:default",
      LILAC_DEFAULT_COMPUTER_RUNNER_IMAGE: "registry.example/runner:default",
    });
    expect(resolveImages(resolved())).toEqual(selected);
    expect(resolveImages(resolved({ coreBuild: true, gatewayBuild: true }))).toEqual(selected);
  });

  test.each([
    { label: "published defaults", defaults: undefined },
    { label: "configured release defaults", defaults: selected },
  ])(
    "replaces build-backed Core with $label and keeps existing computer images",
    ({ defaults }) => {
      using _environment = imageEnvironment({ LILAC_DEFAULT_IMAGE: defaults?.core });
      const existing = resolved({ coreBuild: true });
      existing.services.lilac.image = "local-core:development";
      expect(resolveImages(existing)).toEqual({
        ...resolvedImages,
        core: defaults?.core ?? published.core,
      });
    },
  );

  test.each([
    { label: "published defaults", defaults: undefined },
    { label: "configured release defaults", defaults: selected },
  ])("replaces a build-backed gateway and runner together with $label", ({ defaults }) => {
    using _environment = imageEnvironment({
      LILAC_DEFAULT_COMPUTER_GATEWAY_IMAGE: defaults?.gateway,
      LILAC_DEFAULT_COMPUTER_RUNNER_IMAGE: defaults?.runner,
    });
    const existing = resolved({ gatewayBuild: true });
    expect(resolveImages(existing)).toEqual({
      core: resolvedImages.core,
      gateway: defaults?.gateway ?? published.gateway,
      runner: defaults?.runner ?? published.runner,
    });
  });
});

describe("installer build service conversion", () => {
  test("preserves aliases to managed image, build, and pull policy fields during conversion and reinstall", () => {
    const document = parseDocument(
      `services:
  lilac:
    image: &core-image local-core:development
    build: &core-build
      context: ./core
    pull_policy: &core-policy build
  computer-use-gateway:
    image: &gateway-image local-gateway:development
    build: &gateway-build
      context: ./gateway
    pull_policy: &gateway-policy build
    environment:
      RUNNER_IMAGE: local-runner:development
  unrelated-core:
    image: *core-image
    build: *core-build
    pull_policy: *core-policy
  unrelated-gateway:
    image: *gateway-image
    build: *gateway-build
    pull_policy: *gateway-policy
`,
      { merge: true },
    );
    const original = document.toJS();
    const converted = createDeployment("/example/instance", draft(), selected, {
      document,
      resolved: resolved({ coreBuild: true, gatewayBuild: true }),
    });
    const convertedDocument = parseDocument(converted.toString(), { merge: true });
    expect(convertedDocument.errors).toEqual([]);
    const installed: ResolvedDeployment = {
      services: {
        lilac: service({ image: selected.core }),
        "computer-use-gateway": service({
          image: selected.gateway,
          environment: { RUNNER_IMAGE: selected.runner },
        }),
      },
    };
    const reinstalled = createDeployment("/example/instance", draft(), selected, {
      document: convertedDocument,
      resolved: installed,
    });
    const reinstalledDocument = parseDocument(reinstalled.toString(), { merge: true });
    expect(reinstalledDocument.errors).toEqual([]);
    for (const output of [convertedDocument.toJS(), reinstalledDocument.toJS()]) {
      expect(output.services.lilac.image).toBe(selected.core);
      expect(output.services["computer-use-gateway"].image).toBe(selected.gateway);
      for (const name of ["lilac", "computer-use-gateway"]) {
        expect(output.services[name].build).toBeUndefined();
        expect(output.services[name].pull_policy).toBeUndefined();
      }
      expect(output.services["unrelated-core"]).toEqual(original.services["unrelated-core"]);
      expect(output.services["unrelated-gateway"]).toEqual(original.services["unrelated-gateway"]);
    }
    expect(document.toJS()).toEqual(original);
  });

  test.each([
    {
      label: "service aliases",
      services: "  lilac: *core\n  computer-use-gateway: *gateway\n",
    },
    {
      label: "service merge keys",
      services:
        "  lilac:\n    <<: *core\n    hostname: custom-core\n  computer-use-gateway:\n    <<: *gateway\n    hostname: custom-gateway\n",
    },
  ])("converts $label without changing other consumers", ({ services }) => {
    const source = `x-core: &core
  image: local-core:development
  build: ./core
  pull_policy: build
  environment:
    LOG_LEVEL: debug # shared setting
x-gateway: &gateway
  image: local-gateway:development
  build:
    context: ./gateway
  pull_policy: build
  environment:
    RUNNER_IMAGE: local-runner:development
services:
${services}  unrelated-core: *core
  unrelated-gateway: *gateway
`;
    const document = parseDocument(source, { merge: true });
    const original = document.toJS();
    const existing: ExistingDeployment = {
      document,
      resolved: resolved({ coreBuild: true, gatewayBuild: true }),
    };
    const updated = createDeployment("/example/instance", draft(), selected, existing);
    const output = parseDocument(updated.toString(), { merge: true }).toJS();
    expect(output.services.lilac.image).toBe(selected.core);
    expect(output.services["computer-use-gateway"].image).toBe(selected.gateway);
    expect(output.services["computer-use-gateway"].environment.RUNNER_IMAGE).toBe(selected.runner);
    for (const name of ["lilac", "computer-use-gateway"]) {
      expect(output.services[name].build).toBeUndefined();
      expect(output.services[name].pull_policy).toBeUndefined();
      expect(output.services[name].hostname).toBe(original.services[name].hostname);
    }
    expect(output.services.lilac.environment.LOG_LEVEL).toBe("debug");
    expect(output.services["unrelated-core"]).toEqual(original.services["unrelated-core"]);
    expect(output.services["unrelated-gateway"]).toEqual(original.services["unrelated-gateway"]);
    expect(output["x-core"]).toEqual(original["x-core"]);
    expect(output["x-gateway"]).toEqual(original["x-gateway"]);
    expect(document.toJS()).toEqual(original);
    expect(updated.toString()).toContain("# shared setting");
  });
});
