import { describe, expect, it } from "bun:test";

import {
  DataUrlInvalidError,
  decodeDataUrl,
  decodeDataUrlResult,
  RestrictedToolPathError,
  resolveToolPathForRequestContext,
  resolveToolPathForRequestContextResult,
} from "../../src/shared/attachment-utils";
import {
  decodeRequiredRequestContext,
  RequestContextInvalidError,
  requireRequestContext,
} from "../../src/shared/req-context";

describe("partition 8 shared boundaries", () => {
  it("decodes complete request contexts and rejects malformed external values", () => {
    expect(
      decodeRequiredRequestContext(
        {
          requestId: "req-1",
          requestDeliveryId: "delivery-1",
          sessionId: "session-1",
          requestClient: "discord",
        },
        "test",
      ),
    ).toMatchObject({
      status: "ok",
      value: {
        requestId: "req-1",
        requestDeliveryId: "delivery-1",
        sessionId: "session-1",
        requestClient: "discord",
      },
    });

    const invalid = decodeRequiredRequestContext(
      { requestId: "req-1", sessionId: "session-1", requestClient: "future" },
      "test",
    );
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") expect(RequestContextInvalidError.is(invalid.error)).toBeTrue();
    expect(() => requireRequestContext(null, "test")).toThrow(RequestContextInvalidError);
  });

  it("returns typed restricted-path failures while preserving the throwing API", () => {
    const params = {
      cwd: "/tmp",
      inputPath: "~/secret",
      context: { sessionId: "session-1", safetyMode: "restricted" as const },
    };
    const resolved = resolveToolPathForRequestContextResult(params);
    expect(resolved.status).toBe("error");
    if (resolved.status === "error") expect(RestrictedToolPathError.is(resolved.error)).toBeTrue();
    expect(() => resolveToolPathForRequestContext(params)).toThrow(RestrictedToolPathError);
  });

  it("returns a typed malformed data URL failure while preserving decoded bytes", () => {
    const malformed = decodeDataUrlResult("data:text/plain");
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") expect(DataUrlInvalidError.is(malformed.error)).toBeTrue();
    expect(() => decodeDataUrl("data:text/plain")).toThrow(DataUrlInvalidError);
    expect(decodeDataUrl("data:text/plain;base64,aGk=")).toEqual({
      bytes: Buffer.from("hi"),
      mimeType: "text/plain",
    });
  });
});
