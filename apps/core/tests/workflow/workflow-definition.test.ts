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
  capabilities: {
    agents: {
      profiles: ["self", "explore", "self"],
      models: ["inherit"],
      maxConcurrent: 2,
      maxTotal: 8,
      editing: false,
      isolation: "shared",
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
    expect(validated.capabilities.agents.profiles).toEqual(["explore", "self"]);
    expect(validated.capabilities.waits).toEqual(["reply", "sleep"]);
    expect(validated.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { options: { additionalProperties: false } },
    });
    expect(validated.sensitiveFields).toEqual(["token"]);
    expect(validated.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.inputSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.capabilitySha256).toMatch(/^[a-f0-9]{64}$/);
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

  it("rejects syntax and AST shapes outside the exact static contract", () => {
    expect(() => validateWorkflowSource({ name: "Audit", source: source("Audit") })).toThrow(
      "strict lowercase kebab-case",
    );
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: `${source()}\nconsole.log("extra");`,
      }),
    ).toThrow("exactly one import and one default export");
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

  it("enforces editing isolation and source-declared limits", () => {
    const editing = source().replace("editing: false", "editing: true");
    expect(() => validateWorkflowSource({ name: "audit-routes", source: editing })).toThrow(
      "worktree isolation",
    );
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source("audit-routes", "limits: { maxSourceBytes: 10 },"),
      }),
    ).toThrow("declared maxSourceBytes");
  });

  it("rejects shadowed host APIs and backtracking-capable input regexes", () => {
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace(
          "return agent(`Audit ${args.directory}`);",
          "const agent = async () => 'forged'; return agent();",
        ),
      }),
    ).toThrow("shadow reserved host API");
    expect(() =>
      validateWorkflowSource({
        name: "audit-routes",
        source: source().replace("minLength: 1", 'pattern: "(a+)+$"'),
      }),
    ).toThrow("backtracking regex syntax");
  });
});
