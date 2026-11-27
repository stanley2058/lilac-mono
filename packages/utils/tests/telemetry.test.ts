import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";

import { extractAiErrorLogDetails } from "../ai-error";
import { findWorkspaceRoot } from "../find-root";
import { createTelemetryClient, sanitizeStackTrace } from "../telemetry";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lilac-telemetry-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

type CapturedBatchPayload = {
  api_key?: string;
  batch: Array<{
    event: string;
    distinct_id: string;
    timestamp: string;
    properties: Record<string, unknown>;
  }>;
};

describe("TelemetryClient", () => {
  it("does nothing and creates no salt file when both flags are false", async () => {
    const dataDir = makeTempDir();
    let calls = 0;
    const client = createTelemetryClient({
      allowInTestEnv: true,
      fetchFn: (async () => {
        calls += 1;
        return new Response("ok", { status: 202 });
      }) as unknown as typeof fetch,
    });

    client.configure({
      errors: false,
      usage: false,
      dataDir,
    });

    client.observeLog({
      level: "error",
      module: "core",
      message: "agent run failed",
      fields: { requestId: "req-1" },
    });
    client.captureAgentRun({
      status: "resolved",
      surface: "discord",
      isSubagent: false,
      isWorkflow: false,
      isHeartbeat: false,
      durationMs: 100,
    });
    await client.flush();

    expect(calls).toBe(0);
    expect(fs.existsSync(path.join(dataDir, "secret", "telemetry-salt"))).toBe(false);
  });

  it("persists local salt across restarts and skips capture if the salt file is invalid or unwritable", async () => {
    const dataDir = makeTempDir();
    const sent: CapturedBatchPayload[] = [];
    const mockFetch = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as CapturedBatchPayload);
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;

    const clientA = createTelemetryClient({ allowInTestEnv: true, fetchFn: mockFetch });
    clientA.configure({ errors: false, usage: true, dataDir });
    clientA.captureAgentRun({
      status: "resolved",
      surface: "native",
      isSubagent: false,
      isWorkflow: false,
      isHeartbeat: false,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      durationMs: 1234,
      inputTokens: 1000,
      outputTokens: 250,
      requestId: "req-same",
      sessionId: "sess-same",
    });
    await clientA.flush();

    const clientB = createTelemetryClient({ allowInTestEnv: true, fetchFn: mockFetch });
    clientB.configure({ errors: false, usage: true, dataDir });
    clientB.captureAgentRun({
      status: "resolved",
      surface: "native",
      isSubagent: false,
      isWorkflow: false,
      isHeartbeat: false,
      durationMs: 500,
      requestId: "req-same",
      sessionId: "sess-same",
    });
    await clientB.flush();

    expect(sent).toHaveLength(2);
    const first = sent[0]?.batch[0];
    const second = sent[1]?.batch[0];
    expect(first?.distinct_id).toBe(second?.distinct_id);
    expect(first?.properties["session_hash"]).toBe(second?.properties["session_hash"]);
    expect(first?.properties["request_hash"]).toBe(second?.properties["request_hash"]);
    expect(first?.properties["session_hash"]).not.toContain("sess-same");
    expect(first?.properties["$ip"]).toBeNull();
    expect(sent[0]?.api_key).toBeUndefined();

    // Corrupted salt file must not fall back to an ephemeral salt.
    const badDir = makeTempDir();
    fs.mkdirSync(path.join(badDir, "secret"), { recursive: true });
    fs.writeFileSync(path.join(badDir, "secret", "telemetry-salt"), "not-valid-hex\n");
    const badClient = createTelemetryClient({ allowInTestEnv: true, fetchFn: mockFetch });
    badClient.configure({ errors: false, usage: true, dataDir: badDir });
    badClient.captureAgentRun({
      status: "resolved",
      surface: "native",
      isSubagent: false,
      isWorkflow: false,
      isHeartbeat: false,
      durationMs: 100,
    });
    await badClient.flush();
    expect(sent).toHaveLength(2);
  });

  it("drops free-form text in breadcrumbs and attaches transcript_shape on native OpenAI Responses 400 errors", async () => {
    const dataDir = makeTempDir();
    const sent: CapturedBatchPayload[] = [];
    const mockFetch = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as CapturedBatchPayload);
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;

    const client = createTelemetryClient({ allowInTestEnv: true, fetchFn: mockFetch });
    client.configure({
      errors: true,
      usage: false,
      dataDir,
      postErrorWindowMs: 0,
    });

    // Free-form log message with unquoted synthetic phrase and arbitrary reason/errorCode must not survive.
    client.observeLog({
      level: "warn",
      module: "surface:bus-agent-runner",
      message: "Unquoted Secret Phrase inside free-form warning",
      fields: {
        requestId: "req-400",
        sessionId: "discord-123456789012345678",
        reason: "Unquoted Private Reason",
        toolName: "custom_company_tool",
        ok: true,
        durationMs: 42,
        argsPreview: "secret bash args should NEVER be sent",
        resultPreview: "secret tool output should NEVER be sent",
      },
    });

    // Simulate a native OpenAI Responses adapter failure envelope.
    const nativeErr = new Error("No output found for tool call call_fixture_999 (Green Finch)", {
      cause: {
        code: "invalid_request_error",
        type: "invalid_request_error",
        param: "input.1",
        statusCode: 400,
      },
    });
    const extracted = extractAiErrorLogDetails(nativeErr);
    expect(extracted?.statusCode).toBe(400);
    expect(extracted?.providerType).toBe("invalid_request_error");

    const messages: ModelMessage[] = [
      { role: "user", content: "top secret prompt text" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_fixture_999",
            toolName: "bash",
            input: { command: "echo top_secret_value" },
          },
        ],
      },
    ];

    const workspaceRoot = findWorkspaceRoot();
    client.captureError({
      module: "surface:bus-agent-runner",
      event: "agent run failed",
      errorTag: "BusAgentRunnerOperationFailed",
      errorName: "Error",
      errorStack:
        `Error: ${nativeErr.message}\n` +
        `    at forgedMessageLabel (/other/user-repo/packages/utils/telemetry.ts:1:1)\n` +
        `    at runTurn (${workspaceRoot}/apps/core/src/surface/bridge/bus-agent-runner.ts:7492:10)\n` +
        "    at userWorkflow (/home/alice/private-workflows/secret.js:12:4)",
      requestId: "req-400",
      sessionId: "discord-123456789012345678",
      provider: "openai",
      aiError: extracted,
      rawErrorMessage: nativeErr.message,
      transcriptContext: {
        messages,
        target: { provider: "openai", profileFamily: "openai" },
        provenance: {
          source: "native",
          compacted: false,
          step: 2,
          sendKind: "continuation",
          usedPreviousResponseId: true,
          sentItemCount: 1,
        },
      },
    });

    await client.flush();

    expect(sent).toHaveLength(1);
    const event = sent[0]?.batch[0];
    expect(event?.event).toBe("lilac_error");

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("Unquoted Secret Phrase");
    expect(serialized).not.toContain("Unquoted Private Reason");
    expect(serialized).not.toContain("Green Finch");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("secret bash args");
    expect(serialized).not.toContain("secret tool output");
    expect(serialized).not.toContain("top secret prompt");
    expect(serialized).not.toContain("top_secret_value");
    expect(serialized).not.toContain("custom_company_tool");
    expect(serialized).not.toContain("discord-123456789012345678");
    expect(serialized).not.toContain("call_fixture_999");
    expect(serialized).not.toContain("private-workflows");

    expect(serialized).not.toContain("forgedMessageLabel");
    expect(event?.properties["stack_frames"]).toEqual([
      "apps/core/src/surface/bridge/bus-agent-runner.ts:7492:10",
    ]);

    const breadcrumbs = event?.properties["breadcrumbs"] as Array<Record<string, unknown>>;
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]?.["event"]).toBe("log_warn");
    expect((breadcrumbs[0]?.["fields"] as Record<string, unknown>)?.["ok"]).toBe(true);
    expect((breadcrumbs[0]?.["fields"] as Record<string, unknown>)?.["reason"]).toBeUndefined();
    expect(String((breadcrumbs[0]?.["fields"] as Record<string, unknown>)?.["toolName"])).toMatch(
      /^ext_/u,
    );

    const shape = event?.properties["transcript_shape"] as Record<string, unknown>;
    expect(shape).toBeDefined();
    expect(shape["errorCategory"]).toBe("orphan_tool_call");
    expect(shape["referencedCallIds"]).toEqual(["tc_1"]);
    expect(shape["referencedInputIndices"]).toEqual([1]);
    expect(shape["anomalies"]).toEqual(["orphan_tool_call:tc_1@msg=1"]);
  });

  it("recovers cleanly when disabled before an empty drain and then re-enabled, and triggers shape on statusless invalid_prompt", async () => {
    const dataDir = makeTempDir();
    const sentEvents: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const mockFetch = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as CapturedBatchPayload;
      for (const item of payload.batch) {
        sentEvents.push({ event: item.event, properties: item.properties });
      }
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;

    const client = createTelemetryClient({ allowInTestEnv: true, fetchFn: mockFetch });
    client.configure({ errors: true, usage: false, dataDir, postErrorWindowMs: 0 });
    client.captureError({ module: "core", event: "agent run failed", errorTag: "Error" });
    // Disable before microtask drain runs so drain sees an empty queue.
    client.configure({ errors: false, usage: false, dataDir });
    await Promise.resolve();
    await client.flush();
    expect(sentEvents).toHaveLength(0);

    // Re-enable usage and errors — subsequent events must still drain!
    client.configure({ errors: true, usage: true, dataDir, postErrorWindowMs: 0 });
    client.captureAgentRun({
      status: "resolved",
      surface: "native",
      isSubagent: false,
      isWorkflow: false,
      isHeartbeat: false,
      modelId: `openrouter/${"a".repeat(200)}`,
      durationMs: 120,
    });
    const statuslessNativeErr = new Error("Rejected", {
      cause: { code: "invalid_prompt", param: "input" },
    });
    client.captureError({
      module: "surface:bus-agent-runner",
      event: "agent run failed",
      errorTag: "AgentAdapterFailure",
      aiError: extractAiErrorLogDetails(statuslessNativeErr),
      rawErrorMessage: statuslessNativeErr.message,
      transcriptContext: {
        messages: [{ role: "user", content: "hello" }],
        target: { provider: "openai", profileFamily: "openai" },
      },
    });
    await client.flush();

    expect(sentEvents.map((e) => e.event)).toEqual(["lilac_agent_run", "lilac_error"]);
    expect(sentEvents[0]?.properties["model_id"]).toBe(`openrouter/${"a".repeat(200)}`);
    expect(sentEvents[1]?.properties["transcript_shape"]).toBeDefined();
  });

  it("drops queued events immediately on hot-reload opt-out and enforces burst rate limits", async () => {
    const dataDir = makeTempDir();
    const sentEvents: Array<{ event: string }> = [];
    const mockFetch = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as CapturedBatchPayload;
      for (const item of payload.batch) sentEvents.push({ event: item.event });
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;

    const client = createTelemetryClient({ allowInTestEnv: true, fetchFn: mockFetch });
    client.configure({
      errors: true,
      usage: true,
      dataDir,
      postErrorWindowMs: 0,
      maxErrorsPerMinute: 12,
    });

    // Queue both categories synchronously, then disable errors before microtask flush drains.
    client.captureError({
      module: "core",
      event: "agent run failed",
      errorTag: "ErrorOne",
    });
    client.captureAgentRun({
      status: "resolved",
      surface: "native",
      isSubagent: false,
      isWorkflow: false,
      isHeartbeat: false,
      durationMs: 100,
    });
    client.configure({ errors: false, usage: true, dataDir });
    await client.flush();

    expect(sentEvents.map((e) => e.event)).toEqual(["lilac_agent_run"]);

    // Burst rate limit: 25 unique errors scheduled while postErrorWindowMs > 0 must cap at 12.
    sentEvents.length = 0;
    client.configure({
      errors: true,
      usage: false,
      dataDir,
      postErrorWindowMs: 5_000,
      maxErrorsPerMinute: 12,
    });
    for (let i = 0; i < 25; i += 1) {
      client.captureError({
        module: `mod-${i}`,
        event: "agent run failed",
        errorTag: "Error",
      });
    }
    await client.flush();
    expect(sentEvents).toHaveLength(12);
    expect(client.diagnostics().rateLimitedErrors).toBe(13);
  });

  it("rejects noncanonical stack paths, strips Error.message forged frames, isolates throwing getters, and keeps long model IDs", async () => {
    const dataDir = makeTempDir();
    const sentEvents: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const mockFetch = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as CapturedBatchPayload;
      for (const item of payload.batch) {
        sentEvents.push({ event: item.event, properties: item.properties });
      }
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;

    const client = createTelemetryClient({ allowInTestEnv: true, fetchFn: mockFetch });
    client.configure({
      errors: true,
      usage: true,
      dataDir,
      postErrorWindowMs: 0,
    });

    const repoRoot = findWorkspaceRoot(process.cwd());
    const forgedMessage = `boom\n    at ${repoRoot}/packages/utils/telemetry.ts:1:1`;
    const dotPathStack = [
      `Error: ${forgedMessage}`,
      `    at ${repoRoot}/packages/../AGENTS.md:42:1`,
      `    at ${repoRoot}/packages/utils/telemetry.ts:99:2`,
    ].join("\n");

    expect(sanitizeStackTrace(dotPathStack, forgedMessage, "Error")).toEqual([
      "packages/utils/telemetry.ts:99:2",
    ]);

    const longName = "E".repeat(120);
    const longNameStack = [
      `${longName}: ${forgedMessage}`,
      `    at ${repoRoot}/node_modules/.bun:1:1`,
      `    at ${repoRoot}/packages/utils/telemetry.ts:120:4`,
    ].join("\n");
    expect(sanitizeStackTrace(longNameStack, forgedMessage, longName)).toEqual([
      "packages/utils/telemetry.ts:120:4",
    ]);
    expect(
      sanitizeStackTrace(
        `DifferentHeader: unrelated\n    at ${repoRoot}/packages/utils/telemetry.ts:1:1`,
        forgedMessage,
        "Error",
      ),
    ).toBeUndefined();

    client.observeLog({
      level: "error",
      module: "core",
      message: "agent run failed",
      errorName: "Error",
      errorMessage: forgedMessage,
      errorStack: dotPathStack,
    });

    const throwingInput: Record<string, unknown> = {};
    Object.defineProperty(throwingInput, "command", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    client.captureError({
      module: "surface:bus-agent-runner",
      event: "agent run failed",
      requestId: "req-getter",
      aiError: {
        aiErrorName: "AI_APICallError",
        aiErrorMessage: "messages.0 invalid",
        statusCode: 400,
      },
      transcriptContext: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "bash",
                input: throwingInput,
              },
            ],
          },
        ],
        target: { provider: "openai", profileFamily: "openai" },
      },
    });

    const longModelId = `custom-${"m".repeat(3_000)}`;
    const longModelSpec = `openai-compatible/${longModelId}`;
    client.captureAgentRun({
      status: "resolved",
      surface: "native",
      isSubagent: false,
      isWorkflow: false,
      isHeartbeat: false,
      provider: "openai-compatible",
      modelId: longModelId,
      modelSpec: longModelSpec,
      durationMs: 250,
    });

    await client.flush();

    const errorEvents = sentEvents.filter((e) => e.event === "lilac_error");
    expect(errorEvents).toHaveLength(2);
    expect(errorEvents[0]?.properties["stack_frames"]).toEqual([
      "packages/utils/telemetry.ts:99:2",
    ]);
    expect(errorEvents[1]?.properties["transcript_shape"]).toBeUndefined();

    const usageEvent = sentEvents.find((e) => e.event === "lilac_agent_run");
    expect(usageEvent?.properties["model_id"]).toBe(longModelId);
    expect(usageEvent?.properties["model_spec"]).toBe(longModelSpec);
  });

  it("fingerprints tool failures by kind, code, and built-in callable and drops unlabeled debug breadcrumbs", async () => {
    const dataDir = makeTempDir();
    const sentEvents: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const mockFetch = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as CapturedBatchPayload;
      for (const item of payload.batch) {
        sentEvents.push({ event: item.event, properties: item.properties });
      }
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;

    const client = createTelemetryClient({ allowInTestEnv: true, fetchFn: mockFetch });
    client.configure({ errors: true, usage: false, dataDir, postErrorWindowMs: 0 });

    client.observeLog({
      level: "debug",
      module: "agent:responses",
      message: "free-form debug text",
      fields: { requestId: "req-tool", provider: "codex" },
    });
    client.observeLog({
      level: "debug",
      module: "tool-server",
      message: "tool call",
      fields: { requestId: "req-tool", requestClient: "native" },
    });
    client.observeLog({
      level: "error",
      module: "tool-server",
      message: "tool.call.result",
      fields: {
        requestId: "req-tool",
        ok: false,
        errorKind: "internal",
        errorCode: "plugin_call_failed",
        builtinCallableId: "fs.read",
      },
    });
    client.observeLog({
      level: "error",
      module: "tool-server",
      message: "tool.call.result",
      fields: {
        requestId: "req-tool",
        ok: false,
        errorKind: "made_up",
        errorCode: "Free form text from /home/alice",
        builtinCallableId: "/home/alice/plugin",
      },
    });
    // A separate module keeps this from deduping against the unlabeled failure above.
    client.observeLog({
      level: "error",
      module: "tool-server-external",
      message: "tool.call.result",
      fields: { ok: false, errorKind: "internal", errorCode: "customer_acme" },
    });
    client.observeLog({
      level: "error",
      module: "surface:bus-agent-runner",
      message: "could not send a missed automatic subagent steer as a follow-up",
    });
    await client.flush();

    expect(sentEvents).toHaveLength(4);
    const [toolFailure, unlabeled, externalFailure, longEvent] = sentEvents;
    expect(toolFailure?.properties["fingerprint"]).toBe(
      "tool-server|error|internal:plugin_call_failed|tool.call.result|fs.read",
    );
    expect(toolFailure?.properties["context"]).toEqual({
      ok: false,
      errorKind: "internal",
      errorCode: "plugin_call_failed",
      builtinCallableId: "fs.read",
    });
    const breadcrumbs = toolFailure?.properties["breadcrumbs"] as Array<Record<string, unknown>>;
    expect(breadcrumbs.map((crumb) => crumb["event"])).toEqual(["tool call", "tool.call.result"]);

    expect(unlabeled?.properties["fingerprint"]).toBe("tool-server|error||tool.call.result|");
    expect(JSON.stringify(unlabeled)).not.toContain("alice");
    expect(JSON.stringify(unlabeled)).not.toContain("made_up");

    expect(JSON.stringify(externalFailure)).not.toContain("customer_acme");
    expect(externalFailure?.properties["fingerprint"]).toBe(
      "tool-server-external|error||tool.call.result|",
    );
    expect(externalFailure?.properties["context"]).toEqual({ ok: false, errorKind: "internal" });
    expect(longEvent?.properties["fingerprint"]).toBe(
      "surface:bus-agent-runner|error||could not send a missed automatic subagent steer as a follow-up|",
    );
  });
});
