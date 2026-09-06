import { expect, test } from "bun:test";
import { Panic } from "better-result";
import { createResponsesDiagnostics, type ResponsesDiagnosticFields } from "./diagnostics";

test("diagnostic children preserve independent request, attempt and connection correlation", () => {
  const records: ResponsesDiagnosticFields[] = [];
  const diagnostics = createResponsesDiagnostics(
    { provider: "codex", model: "gpt-6-astra", requestId: "request", sessionId: "session" },
    (_level, _event, fields) => records.push(fields),
  );
  const first = diagnostics.withContext({ attemptId: "first", connectionId: 1 });
  const second = diagnostics.withContext({ attemptId: "second", connectionId: 2 });
  first.log("responses transport selected", { transport: "websocket" });
  second.log("responses transport selected", { transport: "sse" });
  first.log("responses response completed", { responseId: "resp_first" });
  expect(records.map((record) => record.attemptId)).toEqual(["first", "second", "first"]);
  expect(records.map((record) => record.connectionId)).toEqual([1, 2, 1]);
  expect(
    records.every((record) => record.requestId === "request" && record.sessionId === "session"),
  ).toBe(true);
  expect(records[2]?.responseId).toBe("resp_first");
});

test("operational errors redact credentials and ordinary logging failures do not escape", () => {
  const records: ResponsesDiagnosticFields[] = [];
  const diagnostics = createResponsesDiagnostics(
    { provider: "openai", model: "gpt-6-astra" },
    (_level, _event, fields) => records.push(fields),
  );
  diagnostics.log(
    "responses connection failed",
    {
      errorMessage: "Bearer test-secret https://user:password@example.test/api?token=private",
    },
    "warn",
  );
  expect(records[0]?.errorMessage).not.toContain("test-secret");
  expect(records[0]?.errorMessage).not.toContain("password");
  expect(records[0]?.errorMessage).not.toContain("private");
  const broken = createResponsesDiagnostics({ provider: "openai", model: "gpt-6-astra" }, () => {
    throw new Error("log writer unavailable");
  });
  expect(() => broken.log("responses connection closed")).not.toThrow();
});

test("diagnostic logging preserves Panic identity", () => {
  const panic = new Panic({ message: "diagnostic defect", cause: new Error("defect") });
  const diagnostics = createResponsesDiagnostics(
    { provider: "openai", model: "gpt-6-astra" },
    () => {
      throw panic;
    },
  );
  expect(() => diagnostics.log("responses connection closed")).toThrow(panic);
});
