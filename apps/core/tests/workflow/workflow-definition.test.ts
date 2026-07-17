import { describe, expect, it } from "bun:test";

import {
  canonicalJson,
  validateWorkflowArgs,
  validateWorkflowSource,
} from "../../src/workflow/workflow-definition";

function source(name = "audit-routes", properties = "") {
  return `import { defineWorkflow } from "@lilac/workflow";

export default defineWorkflow({
  name: "${name}",
  description: "Audit routes",
  input: {
    type: "object",
    required: ["directory"],
    properties: {
      directory: { type: "string", minLength: 1 },
      token: { type: "string", sensitive: true },
      options: {
        type: "object",
        properties: { retries: { type: "integer", minimum: 0, maximum: 3 } },
      },
    },
  },
  resources: {
    agents: {
      maxConcurrent: 2,
      maxTotal: 8,
    },
    waits: ["sleep", "reply", "sleep"],
  },
  ${properties}
  async run({ args, agent }) {
    return agent(\`Audit \${args.directory}\`);
  },
});
`;
}

describe("workflow definition validation", () => {
  it("normalizes static metadata and deterministically hashes canonical values", () => {
    const validated = validateWorkflowSource({ name: "audit-routes", source: source() });
    expect(validated.metadata).toEqual({ name: "audit-routes", description: "Audit routes" });
    expect(validated.resources.agents).toEqual({ maxConcurrent: 2, maxTotal: 8 });
    expect(validated.resources.waits).toEqual(["reply", "sleep"]);
    expect(validated.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { options: { additionalProperties: false } },
    });
    expect(validated.sensitiveFields).toEqual(["token"]);
    expect(validated.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.inputSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.resourcePolicySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it("validates concrete JSON arguments without coercion or unknown properties", () => {
    const validated = validateWorkflowSource({ name: "audit-routes", source: source() });
    expect(
      validateWorkflowArgs({
        inputSchema: validated.inputSchema,
        args: { directory: "src", options: { retries: 2 } },
        maxInputBytes: validated.limits.maxInputBytes,
      }),
    ).toEqual({ directory: "src", options: { retries: 2 } });
    expect(() =>
      validateWorkflowArgs({
        inputSchema: validated.inputSchema,
        args: { directory: "src", unknown: true },
        maxInputBytes: validated.limits.maxInputBytes,
      }),
    ).toThrow("unknown property");
    expect(() =>
      validateWorkflowArgs({
        inputSchema: validated.inputSchema,
        args: { directory: 12 },
        maxInputBytes: validated.limits.maxInputBytes,
      }),
    ).toThrow("expected string");
  });

  it("rejects removed revision authority allowlists", () => {
    for (const removed of [
      'profiles: ["explore"],',
      'models: ["deep"],',
      'allowedRoots: ["project"],',
      'tools: ["read_file"],',
      'executables: "none",',
      'editing: ["shared"],',
      "delegation: false,",
    ]) {
      expect(() =>
        validateWorkflowSource({
          name: "audit-routes",
          source: source().replace("maxConcurrent: 2,", `maxConcurrent: 2,\n      ${removed}`),
        }),
      ).toThrow("migrate to profile-native agent() options");
    }
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          'waits: ["sleep", "reply", "sleep"],',
          'level2: { callables: ["search"] },\n    waits: ["sleep", "reply", "sleep"],',
        ),
      }),
    ).toThrow("profiles now own agent tool access");
  });

  it("provides migration guidance for removed safety and memory fields", () => {
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          'waits: ["sleep", "reply", "sleep"],',
          'waits: ["sleep", "reply", "sleep"],\n    safety: { originatingMode: "trusted" },',
        ),
      }),
    ).toThrow(
      "Workflow revision field 'resources.safety' was removed; delete it from the workflow definition",
    );
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "async run({ args, agent })",
          "limits: { maxRuntimeMemoryBytes: 268435456 },\n  async run({ args, agent })",
        ),
      }),
    ).toThrow(
      "Workflow revision field 'limits.maxRuntimeMemoryBytes' was removed; delete it from the workflow definition",
    );
  });

  it("rejects syntax and AST shapes outside the exact static contract", () => {
    expect(() => validateWorkflowSource({ name: "Audit", source: source("Audit") })).toThrow(
      "strict lowercase kebab-case",
    );
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: `${source()}\nconsole.log("extra");`,
      }),
    ).toThrow("last statement must be the default defineWorkflow export");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "return agent(`Audit ${args.directory}`);",
          'return eval("unsafe");',
        ),
      }),
    ).toThrow("eval is not allowed");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace("async run", "run"),
      }),
    ).toThrow("async method");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace('from "@lilac/workflow"', 'from "node:fs"'),
      }),
    ).toThrow("may import only");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "async run({ args, agent })",
          "async run({ args }) {},\nasync run({ agent })",
        ),
      }),
    ).toThrow("Duplicate workflow definition property");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "async run({ args, agent })",
          "async run({ args, agent }: object)",
        ),
      }),
    ).toThrow("Invalid workflow JavaScript syntax");
  });

  it("allows same-file pure function and constant helpers", () => {
    const composed = source()
      .replace(
        "export default defineWorkflow({",
        `const PROMPT_PREFIX = "Audit";

async function audit(agent, directory) {
  return await agent(\`${"${PROMPT_PREFIX}"} ${"${directory}"}\`);
}

const auditAll = async (pipeline, agent, directories) =>
  await pipeline(directories, (directory) => audit(agent, directory));

export default defineWorkflow({`,
      )
      .replace("async run({ args, agent })", "async run({ args, agent, pipeline })")
      .replace(
        "return agent(`Audit ${args.directory}`);",
        "return auditAll(pipeline, agent, [args.directory]);",
      );

    expect(() => validateWorkflowSource({ name: "audit-routes", source: composed })).not.toThrow();

    const directArrow = source()
      .replace(
        "export default defineWorkflow({",
        "const invoke = (agent, prompt) => agent(prompt);\nexport default defineWorkflow({",
      )
      .replace(
        "return agent(`Audit ${args.directory}`);",
        "return invoke(agent, `Audit ${args.directory}`);",
      );
    expect(() =>
      validateWorkflowSource({ name: "audit-routes", source: directArrow }),
    ).not.toThrow();
  });

  it("rejects executable, mutable, reserved, and module top-level declarations", () => {
    const beforeExport = (declaration: string) =>
      source().replace(
        "export default defineWorkflow({",
        `${declaration}\nexport default defineWorkflow({`,
      );

    for (const declaration of [
      "const now = Date.now();",
      'const parsed = JSON.parse("{}");',
      "let mutable = 1;",
      "const agent = () => null;",
      'async function implicitHost() { return agent("missing parameter"); }',
      'async function dynamicModule() { return import("./helper.js"); }',
      'function ambientModule() { return require("./helper.js"); }',
      'import helper from "./helper.js";',
    ]) {
      expect(() =>
        validateWorkflowSource({ name: "audit-routes", source: beforeExport(declaration) }),
      ).toThrow();
    }
  });

  it("rejects host API aliases, member calls, writes, and unsafe helper reuse", () => {
    const withBody = (body: string) =>
      source().replace("return agent(`Audit ${args.directory}`);", body);
    for (const body of [
      "const alias = agent; return alias('forged');",
      "agent = async () => 'forged'; return agent('forged');",
      "return agent.call(null, 'forged');",
      "return ({ agent }).agent('forged');",
      'return ({ agent })["agent"]("forged");',
    ]) {
      expect(() =>
        validateWorkflowSource({ name: "audit-routes", source: withBody(body) }),
      ).toThrow();
    }

    const wrongForwarding = source()
      .replace(
        "export default defineWorkflow({",
        "async function invoke(other, prompt) { return other(prompt); }\nexport default defineWorkflow({",
      )
      .replace("return agent(`Audit ${args.directory}`);", "return invoke(agent, 'forged');");
    expect(() => validateWorkflowSource({ name: "audit-routes", source: wrongForwarding })).toThrow(
      "same-named helper parameter",
    );

    const fakeForwarding = source()
      .replace(
        "export default defineWorkflow({",
        "async function invoke(agent, prompt) { return agent(prompt); }\nexport default defineWorkflow({",
      )
      .replace(
        "return agent(`Audit ${args.directory}`);",
        "return invoke(async () => 'forged', 'forged');",
      );
    expect(() => validateWorkflowSource({ name: "audit-routes", source: fakeForwarding })).toThrow(
      "requires same-named host binding agent",
    );

    const concurrentReuse = source()
      .replace(
        "export default defineWorkflow({",
        "async function invoke(agent, prompt) { return agent(prompt); }\nexport default defineWorkflow({",
      )
      .replace("async run({ args, agent })", "async run({ args, agent, parallel })")
      .replace(
        "return agent(`Audit ${args.directory}`);",
        "return parallel([invoke(agent, 'a'), invoke(agent, 'b')]);",
      );
    expect(() => validateWorkflowSource({ name: "audit-routes", source: concurrentReuse })).toThrow(
      "cannot be invoked from multiple call sites",
    );

    const callbackReuse = concurrentReuse
      .replace("async run({ args, agent, parallel })", "async run({ args, agent, pipeline })")
      .replace(
        "return parallel([invoke(agent, 'a'), invoke(agent, 'b')]);",
        "return pipeline(['a'], invoke);",
      );
    expect(() => validateWorkflowSource({ name: "audit-routes", source: callbackReuse })).toThrow(
      "must be invoked directly",
    );

    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: withBody("return [args.directory].map(async (item) => agent(item));"),
      }),
    ).toThrow("cannot be called from an unscoped callback");
  });

  it("allows pure nested helpers without hiding host bindings", () => {
    const nested = source().replace(
      "return agent(`Audit ${args.directory}`);",
      "function prompt(directory) { return `Audit ${directory}`; } return agent(prompt(args.directory));",
    );
    expect(() => validateWorkflowSource({ name: "audit-routes", source: nested })).not.toThrow();
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "return agent(`Audit ${args.directory}`);",
          "async function invoke(prompt) { return agent(prompt); } return invoke(`Audit ${args.directory}`);",
        ),
      }),
    ).toThrow("unscoped callback");
  });

  it("rejects non-finite numeric literals anywhere in workflow code", () => {
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace("minimum: 0", "minimum: 1e999"),
      }),
    ).toThrow("numeric literals must be finite");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace("return agent(`Audit ${args.directory}`);", "return 1e999;"),
      }),
    ).toThrow("numeric literals must be finite");
  });

  it("enforces source-declared resource limits", () => {
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source("audit-routes", "limits: { maxSourceBytes: 10 },"),
      }),
    ).toThrow("declared maxSourceBytes");
  });

  it("rejects all shadowed host APIs and user-defined input regexes", () => {
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "return agent(`Audit ${args.directory}`);",
          "const agent = async () => 'forged'; return agent();",
        ),
      }),
    ).toThrow("only be called directly or forwarded unchanged");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace("minLength: 1", 'pattern: "(a+)+$"'),
      }),
    ).toThrow("pattern");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "return agent(`Audit ${args.directory}`);",
          "const helper = function agent() {}; return helper();",
        ),
      }),
    ).toThrow("only be called directly or forwarded unchanged");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "return agent(`Audit ${args.directory}`);",
          "const Helper = class agent {}; return String(Helper);",
        ),
      }),
    ).toThrow("only be called directly or forwarded unchanged");
  });

  it("permits profile-native agent options without revision authority declarations", () => {
    const profileNative = source().replace(
      "return agent(`Audit ${args.directory}`);",
      'return agent(`Audit ${args.directory}`, { profile: "general", isolation: "shared" });',
    );
    expect(() =>
      validateWorkflowSource({ name: "audit-routes", source: profileNative }),
    ).not.toThrow();
  });
});
