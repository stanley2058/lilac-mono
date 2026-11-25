import { describe, expect, it } from "bun:test";
import { buildTranscriptShapeSnapshot } from "../../packages/utils/transcript-shape";
import { handleTelemetryProxyRequest } from "./src/index";

const VALID_DISTINCT_ID = "0123456789abcdef0123456789abcdef";

describe("telemetry-proxy worker", () => {
  it("enforces strict per-field enums, types, and alias formats while injecting api_key and stripping headers", async () => {
    const forwarded: Array<{
      readonly url: string;
      readonly headers: Headers;
      readonly body: { api_key?: string; batch?: Array<Record<string, unknown>> };
    }> = [];

    const mockFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      forwarded.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as {
          api_key?: string;
          batch?: Array<Record<string, unknown>>;
        },
      });
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as typeof fetch;

    const req = new Request("https://t.lilac.stw.tw/batch/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-for": "203.0.113.42",
        cookie: "session=secret",
      },
      body: JSON.stringify({
        api_key: "client_supplied_should_be_overwritten",
        batch: [
          {
            event: "lilac_error",
            distinct_id: VALID_DISTINCT_ID,
            timestamp: "2026-11-25T06:00:00.000Z",
            extra_top_level: "dropped",
            properties: {
              module: "core",
              event_message: "PRIVATE PROSE MUST BE DROPPED",
              $ip: "1.2.3.4",
              client_ip: "203.0.113.42",
              prompt: "SECRET USER PROMPT MUST BE DROPPED",
              context: {
                ok: false,
                statusCode: "400-not-a-number-drop",
                durationMs: 42,
                secretArg: "SHOULD_BE_DROPPED",
              },
              transcript_shape: {
                totalMessages: 2,
                roleTrace: "u(s),a(tc_1)",
                errorCategory: "orphan_tool_call",
                referencedCallIds: ["tc_1", "raw_toolu_must_be_dropped"],
                anomalies: [
                  "orphan_tool_call:tc_1@msg=1",
                  "private prose anomaly",
                  "arbitrary_lowercase_marker",
                ],
                window: [
                  {
                    i: 1,
                    role: "assistant",
                    contentKind: "array",
                    parts: [
                      {
                        type: "tool-call",
                        tool: "bash",
                        callId: "tc_1",
                        inputShape: {
                          kind: "object",
                          keyCount: 2,
                          keys: { command: "string", secretKey: "privateLeaf" },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            event: "lilac_error",
            distinct_id: VALID_DISTINCT_ID,
            timestamp: "2026-99-99T99:99:99Z",
            properties: { module: "core" },
          },
          {
            event: "not_allowed_event",
            distinct_id: VALID_DISTINCT_ID,
            properties: {},
          },
          {
            event: "lilac_error",
            distinct_id: "not-a-valid-32-char-hex-id",
            properties: { module: "core" },
          },
        ],
      }),
    });

    const res = await handleTelemetryProxyRequest(
      req,
      { POSTHOG_API_KEY: "phc_real_secret", POSTHOG_HOST: "https://us.i.posthog.com" },
      mockFetch,
    );

    expect(res.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    const sent = forwarded[0];
    expect(sent?.url).toBe("https://us.i.posthog.com/batch/");
    expect(sent?.headers.get("cf-connecting-ip")).toBeNull();
    expect(sent?.headers.get("x-forwarded-for")).toBeNull();
    expect(sent?.headers.get("cookie")).toBeNull();
    expect(sent?.body.api_key).toBe("phc_real_secret");
    expect(sent?.body.batch).toHaveLength(1);

    const serialized = JSON.stringify(sent?.body.batch?.[0]);
    expect(serialized).not.toContain("PRIVATE PROSE");
    expect(serialized).not.toContain("arbitrary_lowercase_marker");
    expect(serialized).not.toContain("raw_toolu_must_be_dropped");
    expect(serialized).not.toContain("secretKey");
    expect(serialized).not.toContain("privateLeaf");
    expect(serialized).not.toContain("400-not-a-number-drop");

    expect(sent?.body.batch?.[0]).toEqual({
      event: "lilac_error",
      distinct_id: VALID_DISTINCT_ID,
      timestamp: "2026-11-25T06:00:00.000Z",
      properties: {
        $ip: null,
        module: "core",
        context: {
          ok: false,
          durationMs: 42,
        },
        transcript_shape: {
          totalMessages: 2,
          roleTrace: "u(s),a(tc_1)",
          errorCategory: "orphan_tool_call",
          referencedCallIds: ["tc_1"],
          anomalies: ["orphan_tool_call:tc_1@msg=1"],
          window: [
            {
              i: 1,
              role: "assistant",
              contentKind: "array",
              parts: [
                {
                  type: "tool-call",
                  tool: "bash",
                  callId: "tc_1",
                  inputShape: {
                    kind: "object",
                    keyCount: 2,
                    keys: { command: "string" },
                  },
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("cancels streamed bodies over 256 KiB without Content-Length and rejects disallowed requests", async () => {
    const env = { POSTHOG_API_KEY: "phc_test" };
    const noopFetch = (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch;

    const health = await handleTelemetryProxyRequest(
      new Request("https://t.lilac.stw.tw/health"),
      env,
      noopFetch,
    );
    expect(health.status).toBe(200);

    const wrongPath = await handleTelemetryProxyRequest(
      new Request("https://t.lilac.stw.tw/capture", { method: "POST", body: "{}" }),
      env,
      noopFetch,
    );
    expect(wrongPath.status).toBe(404);

    const wrongMethod = await handleTelemetryProxyRequest(
      new Request("https://t.lilac.stw.tw/batch/", { method: "GET" }),
      env,
      noopFetch,
    );
    expect(wrongMethod.status).toBe(405);

    let chunksPulled = 0;
    let streamCancelled = false;
    const hugeStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const oversize = await handleTelemetryProxyRequest(
      new Request("https://t.lilac.stw.tw/batch/", {
        method: "POST",
        body: hugeStream,
      }),
      env,
      noopFetch,
    );
    expect(oversize.status).toBe(413);
    expect(streamCancelled).toBe(true);
    expect(chunksPulled).toBeLessThanOrEqual(5);

    const rejectedEvents = await handleTelemetryProxyRequest(
      new Request("https://t.lilac.stw.tw/batch/", {
        method: "POST",
        body: JSON.stringify({
          batch: [{ event: "$pageview", distinct_id: VALID_DISTINCT_ID, properties: {} }],
        }),
      }),
      env,
      noopFetch,
    );
    expect(rejectedEvents.status).toBe(400);
  });

  it("rejects dot-segment stack frames, accepts empty/truncated role traces, and preserves long model IDs", async () => {
    const forwarded: Array<Record<string, unknown>> = [];
    const mockFetch = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      forwarded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const longModelId = `custom-${"m".repeat(3_000)}`;
    const longModelSpec = `openai-compatible/${longModelId}`;
    const res = await handleTelemetryProxyRequest(
      new Request("https://t.lilac.stw.tw/batch/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          batch: [
            {
              event: "lilac_error",
              distinct_id: VALID_DISTINCT_ID,
              properties: {
                level: "error",
                module: "core",
                fingerprint: "core|Error|400|packages/../AGENTS.md:42:1|",
                stack_frames: ["packages/../AGENTS.md:42:1", "packages/utils/telemetry.ts:99:2"],
                transcript_shape: {
                  totalMessages: 0,
                  roleTrace: "",
                  errorCategory: "invalid_request",
                  anomalies: [],
                  preProjectionSummary: { totalMessages: 0, roleTrace: "" },
                  window: [],
                },
              },
            },
            {
              event: "lilac_error",
              distinct_id: VALID_DISTINCT_ID,
              properties: {
                level: "error",
                module: "core",
                transcript_shape: {
                  totalMessages: 1,
                  roleTrace: "a(tc_1,tc_2)...",
                  errorCategory: "invalid_request",
                  anomalies: [],
                  window: [],
                },
              },
            },
            {
              event: "lilac_error",
              distinct_id: VALID_DISTINCT_ID,
              properties: {
                level: "error",
                module: "core",
                transcript_shape: {
                  totalMessages: 1,
                  roleTrace: "u(s),secret...",
                  errorCategory: "invalid_request",
                  anomalies: [],
                  window: [],
                },
              },
            },
            {
              event: "lilac_agent_run",
              distinct_id: VALID_DISTINCT_ID,
              properties: {
                status: "resolved",
                surface: "native",
                provider: "openai-compatible",
                model_id: longModelId,
                model_spec: longModelSpec,
                duration_ms: 120,
              },
            },
          ],
        }),
      }),
      { POSTHOG_API_KEY: "phc_test" },
      mockFetch,
    );

    expect(res.status).toBe(202);
    const batch = (forwarded[0]?.["batch"] ?? []) as Array<{
      event: string;
      properties: Record<string, unknown>;
    }>;
    expect(batch).toHaveLength(4);
    expect(batch[0]?.properties["fingerprint"]).toBeUndefined();
    expect(batch[0]?.properties["stack_frames"]).toEqual(["packages/utils/telemetry.ts:99:2"]);
    expect(batch[0]?.properties["transcript_shape"]).toEqual({
      totalMessages: 0,
      roleTrace: "",
      errorCategory: "invalid_request",
      anomalies: [],
      preProjectionSummary: { totalMessages: 0, roleTrace: "" },
      window: [],
    });
    expect(batch[1]?.properties["transcript_shape"]).toEqual({
      totalMessages: 1,
      roleTrace: "a(tc_1,tc_2)...",
      errorCategory: "invalid_request",
      anomalies: [],
      window: [],
    });
    expect(batch[2]?.properties["transcript_shape"]).toBeUndefined();
    expect(batch[3]?.properties["model_id"]).toBe(longModelId);
    expect(batch[3]?.properties["model_spec"]).toBe(longModelSpec);
  });

  it("round-trips Core transcript shapes with reasoning-file parts and Bun store stack frames", async () => {
    const forwarded: Array<Record<string, unknown>> = [];
    const mockFetch = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      forwarded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const messages: Parameters<typeof buildTranscriptShapeSnapshot>[0]["messages"] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning-file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
          },
          { type: "text", text: "done" },
        ],
      },
      { role: "user", content: "next" },
    ];
    const snapshot = buildTranscriptShapeSnapshot({
      messages,
      errorDetails: {
        aiErrorName: "AI_APICallError",
        aiErrorMessage: "messages.0 invalid",
        statusCode: 400,
      },
      hashExternalName: (_d, raw) => raw.slice(0, 8),
    });

    const bunFrame =
      "node_modules/.bun/better-result@2.7.0+abcdef/node_modules/better-result/dist/index.mjs:10:2";
    const res = await handleTelemetryProxyRequest(
      new Request("https://t.lilac.stw.tw/batch/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          batch: [
            {
              event: "lilac_error",
              distinct_id: VALID_DISTINCT_ID,
              properties: {
                level: "error",
                module: "surface:bus-agent-runner",
                stack_frames: [bunFrame],
                transcript_shape: snapshot,
              },
            },
          ],
        }),
      }),
      { POSTHOG_API_KEY: "phc_test" },
      mockFetch,
    );

    expect(res.status).toBe(202);
    const batch = (forwarded[0]?.["batch"] ?? []) as Array<{
      event: string;
      properties: Record<string, unknown>;
    }>;
    expect(batch[0]?.properties["stack_frames"]).toEqual([bunFrame]);
    const shape = batch[0]?.properties["transcript_shape"] as
      | { roleTrace?: string; window?: Array<{ parts?: Array<{ type?: string }> }> }
      | undefined;
    expect(shape?.roleTrace).toBe("a(reasoning-file,t),u(s)");
    expect(shape?.window?.[0]?.parts?.[0]?.type).toBe("reasoning-file");
  });
});
