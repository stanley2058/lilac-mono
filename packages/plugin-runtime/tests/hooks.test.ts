import { describe, expect, it } from "bun:test";

import { Ok, Panic, Result, TaggedError } from "better-result";

import {
  decodeLevel1ExecutableMetadata,
  decodeServerTool,
  decodeToolPlugin,
  isPluginPanic,
  invokeLevel1CreateTool,
  invokeLevel1EditTargets,
  invokeLevel1FormatArgs,
  invokeLevel1IsEnabled,
  invokeLevel1SummarizeFailure,
  invokeLevel2Call,
  invokeLevel2List,
  opaquePluginExceptionMessage,
  type Level1ToolSpec,
  type ServerTool,
} from "..";

const context: { pluginId: string; source: "external" } = {
  pluginId: "hooks",
  source: "external",
};

function level1(overrides: Partial<Level1ToolSpec<unknown>> = {}): Level1ToolSpec<unknown> {
  return {
    name: "hook",
    createTool() {},
    isEnabled() {
      return true;
    },
    ...overrides,
  };
}

describe("plugin hook adapters", () => {
  it("maps hostile proxy classification traps to typed errors", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile prototype trap");
        },
        get() {
          throw new Error("hostile property trap");
        },
      },
    );
    const spec = level1({
      formatArgs() {
        throw hostile;
      },
    });

    expect(isPluginPanic(hostile)).toBe(false);
    const invoked = invokeLevel1FormatArgs({ ...context, spec, args: {} });
    expect(invoked.status).toBe("error");
    if (invoked.status === "ok") throw new Error("expected hostile hook failure");
    expect(invoked.error._tag).toBe("ToolPluginHookError");

    const plugin = new Proxy(
      {},
      {
        get() {
          throw hostile;
        },
      },
    );
    const decoded = decodeToolPlugin(plugin);
    expect(decoded.status).toBe("error");
    if (decoded.status === "ok") throw new Error("expected hostile capability failure");
    expect(decoded.error._tag).toBe("ToolPluginCapabilityError");
  });

  it("captures executable metadata getters as Results", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("metadata hostile prototype");
        },
        get() {
          throw new Error("metadata hostile property");
        },
      },
    );
    const executable = {};
    Object.defineProperty(executable, "title", {
      get() {
        throw hostile;
      },
    });
    const decoded = decodeLevel1ExecutableMetadata("metadata", executable);
    expect(decoded.status).toBe("error");
    if (decoded.status === "ok") throw new Error("expected hostile metadata failure");
    expect(decoded.error._tag).toBe("ToolPluginCapabilityError");
  });

  it("formats hostile and tagged external exceptions without throwing or exposing secrets", () => {
    class ExternalSecretError extends TaggedError("ExternalSecretError")<{
      readonly secret: string;
      readonly message: string;
    }> {}
    const tagged = new ExternalSecretError({
      secret: "plugin-token-secret-value",
      message: "token=plugin-token-secret-value",
    });
    const hostileMessage = Object.create(Error.prototype);
    Object.defineProperty(hostileMessage, "message", {
      get() {
        throw new Panic({ message: "hostile message getter" });
      },
    });
    const hostileCoercion = {
      toString() {
        throw new Panic({ message: "hostile coercion" });
      },
    };

    expect(opaquePluginExceptionMessage(tagged)).toBe("External tagged error");
    expect(opaquePluginExceptionMessage(hostileMessage)).toBe("Unknown plugin exception");
    expect(opaquePluginExceptionMessage(hostileCoercion)).toBe("Unknown plugin exception");
    expect(opaquePluginExceptionMessage(new Panic({ message: "panic text" }))).toBe(
      "External tagged error",
    );
  });

  it("preserves the Level 1 receiver", () => {
    const spec = level1();
    let receiverMatches = false;
    spec.createTool = function () {
      receiverMatches = this === spec;
      return { identity: spec };
    };
    const created = invokeLevel1CreateTool({
      ...context,
      spec,
      context: {
        runtime: undefined,
        cwd: "/",
        runProfile: "primary",
        editingToolMode: "none",
        subagentDepth: 0,
        subagentConfig: { enabled: false, idleTimeoutMs: 0, maxDepth: 0 },
        getTools: () => ({}),
        getLevel1ToolSpecs: () => new Map(),
        resolveEditTargets: async () => [],
      },
    });
    expect(created.status).toBe("ok");
    expect(receiverMatches).toBe(true);
  });

  it("validates rich Level 1 hook results", async () => {
    const spec = level1();
    Object.defineProperties(spec, {
      isEnabled: { value: () => "yes" },
      editTargets: { value: () => ["one", 2] },
      formatArgs: { value: () => 42 },
      summarizeFailure: { value: () => ({ ok: false, failureKind: "unknown" }) },
    });

    const enabled = invokeLevel1IsEnabled({
      ...context,
      spec,
      context: {
        runtime: undefined,
        cwd: "/",
        runProfile: "primary",
        editingToolMode: "none",
        subagentDepth: 0,
        subagentConfig: { enabled: false, idleTimeoutMs: 0, maxDepth: 0 },
      },
    });
    expect(enabled.status).toBe("error");
    expect((await invokeLevel1EditTargets({ ...context, spec, args: {}, cwd: "/" })).status).toBe(
      "error",
    );
    expect(invokeLevel1FormatArgs({ ...context, spec, args: {} }).status).toBe("error");
    expect(
      invokeLevel1SummarizeFailure({ ...context, spec, value: { isError: true, result: null } })
        .status,
    ).toBe("error");
  });

  it("decodes legacy and structured Level 1 failure summaries", () => {
    const legacy = level1({
      summarizeFailure: () => ({ ok: false, failureKind: "soft", error: "legacy failure" }),
    });
    const structured = level1({
      summarizeFailure: () => ({
        ok: false,
        failureKind: "soft",
        failureClass: "tool",
        failureCode: "nonzero_exit",
        retryable: false,
        exitCode: 17,
        error: "command failed",
      }),
    });

    expect(
      invokeLevel1SummarizeFailure({
        ...context,
        spec: legacy,
        value: { isError: false, result: null },
      }).status,
    ).toBe("ok");
    const decoded = invokeLevel1SummarizeFailure({
      ...context,
      spec: structured,
      value: { isError: false, result: null },
    });
    expect(decoded.status).toBe("ok");
    if (decoded.status === "error") throw new Error("expected structured summary");
    expect(decoded.value).toEqual({
      ok: false,
      failureKind: "soft",
      failureClass: "tool",
      failureCode: "nonzero_exit",
      retryable: false,
      exitCode: 17,
      error: "command failed",
    });
  });

  it("rejects invalid structured Level 1 failure fields", () => {
    const invalidValues = [
      { ok: false, failureClass: "host" },
      { ok: false, failureCode: "Nonzero Exit" },
      { ok: false, retryable: "no" },
      { ok: false, exitCode: 1.5 },
    ];

    for (const value of invalidValues) {
      const spec = level1();
      Object.defineProperty(spec, "summarizeFailure", { value: () => value });
      expect(
        invokeLevel1SummarizeFailure({
          ...context,
          spec,
          value: { isError: false, result: null },
        }).status,
      ).toBe("error");
    }
  });

  it("captures synchronous throws and asynchronous rejections", async () => {
    const sync = level1({
      formatArgs() {
        throw new Error("sync hook");
      },
    });
    const syncResult = invokeLevel1FormatArgs({ ...context, spec: sync, args: {} });
    expect(syncResult.status).toBe("error");
    if (syncResult.status === "ok") throw new Error("expected sync hook failure");
    expect(syncResult.error._tag).toBe("ToolPluginHookError");

    const tool: ServerTool = {
      id: "async",
      async init() {},
      async destroy() {},
      async list() {
        return [];
      },
      async call() {
        throw new Error("async hook");
      },
    };
    const asyncResult = await invokeLevel2Call({
      ...context,
      tool,
      callableId: "async.call",
      input: {},
    });
    expect(asyncResult.status).toBe("error");
    if (asyncResult.status === "ok") throw new Error("expected async hook failure");
    expect(asyncResult.error.message).toContain("async hook");
  });

  it("maps editTargets iterator failure", async () => {
    const throwingIterable = (failure: Error): Iterable<string> => ({
      [Symbol.iterator]() {
        return {
          next(): IteratorResult<string> {
            throw failure;
          },
        };
      },
    });
    const ordinary = level1({
      editTargets() {
        return throwingIterable(new Error("iterator failed"));
      },
    });
    const ordinaryResult = await invokeLevel1EditTargets({
      ...context,
      spec: ordinary,
      args: {},
      cwd: "/",
    });
    expect(ordinaryResult.status).toBe("error");
    if (ordinaryResult.status === "ok") throw new Error("expected iterator failure");
    expect(ordinaryResult.error._tag).toBe("ToolPluginHookError");
    if (ordinaryResult.error._tag !== "ToolPluginHookError") {
      throw new Error("expected hook error");
    }
    expect(ordinaryResult.error.hook).toBe("level1.editTargets");
    expect(ordinaryResult.error.message).toContain("iterator failed");
  });

  it("contains hostile Level 2 list getters and thrown values", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile list prototype");
        },
        get() {
          throw new Error("hostile list property");
        },
      },
    );
    const hostileGetter = {
      id: "hostile-getter",
      async init() {},
      async destroy() {},
      get list(): ServerTool["list"] {
        throw hostile;
      },
      async call() {
        return Result.ok();
      },
    };
    const decoded = decodeServerTool("hooks", hostileGetter);
    expect(decoded.status).toBe("error");
    if (decoded.status === "ok") throw new Error("expected hostile list getter failure");
    expect(decoded.error._tag).toBe("ToolPluginCapabilityError");

    const throwingList: ServerTool = {
      id: "hostile-list",
      async init() {},
      async destroy() {},
      async list() {
        throw hostile;
      },
      async call() {
        return Result.ok();
      },
    };
    const listed = await invokeLevel2List({ ...context, tool: throwingList });
    expect(listed.status).toBe("error");
    if (listed.status === "ok") throw new Error("expected hostile list hook failure");
    expect(listed.error._tag).toBe("ToolPluginHookError");
  });

  it("keeps semantic Level 2 failures inside outer invocation success", async () => {
    const failure = Result.err({
      kind: "unavailable" as const,
      code: "backend_offline",
      message: "Backend is offline",
      retryable: true,
      details: { region: "west", attempts: [1, 2] },
    });
    const tool: ServerTool = {
      id: "semantic-failure",
      async init() {},
      async destroy() {},
      async list() {
        return [];
      },
      async call() {
        return failure;
      },
    };

    const invoked = await invokeLevel2Call({
      ...context,
      tool,
      callableId: "semantic-failure.call",
      input: {},
    });
    expect(invoked.status).toBe("ok");
    if (invoked.status === "error") throw new Error(invoked.error.message);
    expect(invoked.value.status).toBe("error");
    if (invoked.value.status === "ok") throw new Error("expected semantic tool failure");
    expect(invoked.value.error).toEqual(failure.error);
    expect(invoked.value).not.toBe(failure);
  });

  it("reconstructs a genuine Result with a non-instance prototype", async () => {
    const local = Result.ok({ source: "alternate-copy" });
    const alternatePrototype = Object.create(null);
    Object.defineProperties(
      alternatePrototype,
      Object.getOwnPropertyDescriptors(Object.getPrototypeOf(local)),
    );
    const alternate = Object.create(alternatePrototype);
    Object.defineProperties(alternate, Object.getOwnPropertyDescriptors(local));
    expect(alternate).not.toBeInstanceOf(Ok);

    const tool = {
      id: "alternate-result",
      async init() {},
      async destroy() {},
      async list() {
        return [];
      },
      async call() {
        return alternate;
      },
    } as ServerTool;
    const invoked = await invokeLevel2Call({
      ...context,
      tool,
      callableId: "alternate-result.call",
      input: {},
    });

    expect(invoked.status).toBe("ok");
    if (invoked.status === "error") throw new Error(invoked.error.message);
    expect(invoked.value).toEqual(Result.ok({ source: "alternate-copy" }));
    expect(invoked.value).not.toBe(alternate);
    expect(invoked.value).toBeInstanceOf(Ok);
  });

  it("rejects legacy raw values and malformed inner failures as contract errors", async () => {
    const toolWithCall = (call: (...args: unknown[]) => unknown): ServerTool =>
      ({
        id: "invalid-result",
        async init() {},
        async destroy() {},
        async list() {
          return [];
        },
        call,
      }) as unknown as ServerTool;

    const raw = await invokeLevel2Call({
      ...context,
      tool: toolWithCall(async () => ({ legacy: true })),
      callableId: "invalid-result.raw",
      input: {},
    });
    expect(raw.status).toBe("error");
    if (raw.status === "ok") throw new Error("expected raw result contract failure");
    expect(raw.error._tag).toBe("ToolPluginCapabilityError");
    expect(raw.error).toHaveProperty("capability", "hook_result");

    const rawEnvelope = await invokeLevel2Call({
      ...context,
      tool: toolWithCall(async () => ({ status: "ok", value: { legacy: true } })),
      callableId: "invalid-result.envelope",
      input: {},
    });
    expect(rawEnvelope.status).toBe("error");
    if (rawEnvelope.status === "ok") throw new Error("expected raw envelope contract failure");
    expect(rawEnvelope.error._tag).toBe("ToolPluginCapabilityError");

    const malformed = await invokeLevel2Call({
      ...context,
      tool: toolWithCall(async () =>
        Result.err({
          kind: "retry_later",
          code: "bad_kind",
          message: "Malformed",
          retryable: "yes",
          details: { invalid: undefined },
        }),
      ),
      callableId: "invalid-result.failure",
      input: {},
    });
    expect(malformed.status).toBe("error");
    if (malformed.status === "ok") throw new Error("expected malformed failure contract error");
    expect(malformed.error._tag).toBe("ToolPluginCapabilityError");

    const emptyCode = await invokeLevel2Call({
      ...context,
      tool: toolWithCall(async () =>
        Result.err({
          kind: "internal",
          code: "",
          message: "Missing code",
          retryable: false,
        }),
      ),
      callableId: "invalid-result.empty-code",
      input: {},
    });
    expect(emptyCode.status).toBe("error");
    if (emptyCode.status === "ok") throw new Error("expected empty code contract error");
    expect(emptyCode.error._tag).toBe("ToolPluginCapabilityError");
  });
});
