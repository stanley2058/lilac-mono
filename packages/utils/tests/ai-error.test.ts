import { describe, expect, it } from "bun:test";
import { APICallError, RetryError } from "ai";

import { extractAiErrorLogDetails } from "../ai-error";

function createApiCallError(
  overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {},
) {
  return new APICallError({
    message: "Bad Request",
    url: "https://api.example.test/v1/responses?api_key=secret#fragment",
    requestBodyValues: {
      model: "example-model",
      input: "private prompt",
    },
    statusCode: 400,
    responseHeaders: {
      authorization: "Bearer secret",
      "x-request-id": "request-123",
    },
    responseBody: JSON.stringify({
      error: {
        message: "Unsupported response format",
        type: "invalid_request_error",
        param: "text.format",
        code: "unsupported_value",
      },
    }),
    isRetryable: false,
    ...overrides,
  });
}

describe("extractAiErrorLogDetails", () => {
  it("extracts safe APICallError diagnostics", () => {
    const details = extractAiErrorLogDetails(createApiCallError());

    expect(details).toEqual({
      aiErrorName: "AI_APICallError",
      aiErrorMessage: "Bad Request",
      retryReason: undefined,
      retryAttempts: undefined,
      statusCode: 400,
      requestUrl: "https://api.example.test/v1/responses",
      isRetryable: false,
      providerMessage: "Unsupported response format",
      providerCode: "unsupported_value",
      providerType: "invalid_request_error",
      providerParam: "text.format",
    });
    expect(details).not.toHaveProperty("requestBodyValues");
    expect(details).not.toHaveProperty("responseHeaders");
    expect(details).not.toHaveProperty("responseBody");
  });

  it("unwraps RetryError and nested wrapper values", () => {
    const firstError = createApiCallError({ message: "Service unavailable", statusCode: 503 });
    const lastError = createApiCallError({
      message: "Rate limited",
      statusCode: 429,
      responseBody: '{"error":{"message":"Try again later","code":429}}',
      isRetryable: true,
    });
    const retryError = new RetryError({
      message: "Failed after 2 attempts",
      reason: "maxRetriesExceeded",
      errors: [firstError, lastError],
    });

    const details = extractAiErrorLogDetails({ error: retryError });

    expect(details).toMatchObject({
      aiErrorName: "AI_RetryError",
      aiErrorMessage: "Failed after 2 attempts",
      retryReason: "maxRetriesExceeded",
      retryAttempts: 2,
      statusCode: 429,
      providerMessage: "Try again later",
      providerCode: 429,
      isRetryable: true,
    });
  });

  it("uses a redacted, bounded message for non-JSON response bodies", () => {
    const details = extractAiErrorLogDetails(
      createApiCallError({
        responseBody: `authorization=secret-token Bearer abc.def sk-${"x".repeat(20)} ${"z".repeat(1_100)}`,
      }),
    );

    expect(details?.providerMessage).not.toContain("secret-token");
    expect(details?.providerMessage).not.toContain("abc.def");
    expect(details?.providerMessage).not.toContain(`sk-${"x".repeat(20)}`);
    expect(details?.providerMessage).toContain("<redacted>");
    expect(details?.providerMessage?.length).toBeLessThanOrEqual(1_003);
    expect(details).not.toHaveProperty("responseBody");
  });

  it("does not retain unrelated JSON response fields", () => {
    const details = extractAiErrorLogDetails(
      createApiCallError({
        responseBody: JSON.stringify({
          error: { message: "Invalid request", code: "bad_request" },
          request: { prompt: "private prompt", apiKey: "secret-key" },
        }),
      }),
    );

    expect(details).toMatchObject({
      providerMessage: "Invalid request",
      providerCode: "bad_request",
    });
    expect(JSON.stringify(details)).not.toContain("private prompt");
    expect(JSON.stringify(details)).not.toContain("secret-key");
  });

  it("extracts Codex backend rejection details", () => {
    const details = extractAiErrorLogDetails(
      createApiCallError({
        responseBody: JSON.stringify({ detail: "Stream must be set to true" }),
      }),
    );

    expect(details?.providerMessage).toBe("Stream must be set to true");
  });

  it("ignores unrelated errors", () => {
    expect(extractAiErrorLogDetails(new Error("local failure"))).toBeUndefined();
  });
});
