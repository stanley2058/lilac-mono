import { afterEach, expect, test } from "bun:test";
import {
  decodeResourcePreview,
  loadResourcePreview,
  loadHtmlFile,
  previewUrl,
} from "../src/resource-preview";
import { imageFitScale } from "../src/components/ResourcePreview";

const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

test("preview preserves the authorized resource URL and validates bounded payloads", async () => {
  expect(previewUrl("/api/files/id?revision=1", "https://lilac.local")).toBe(
    "https://lilac.local/api/files/id/preview?revision=1",
  );
  expect(decodeResourcePreview({ text: "hello", truncated: false, byteLength: 5 }).isOk()).toBe(
    true,
  );
  expect(
    decodeResourcePreview({
      text: "x".repeat(65_537),
      truncated: true,
      byteLength: 65_537,
    }).isErr(),
  ).toBe(true);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://lilac.local" },
  });
  let requested = "";
  let requestOptions: RequestInit | undefined;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input);
      requestOptions = init;
      return Response.json({ text: "source", truncated: true, byteLength: 6 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const signal = new AbortController().signal;
  const result = await loadResourcePreview("/api/resources/id", signal);
  expect(result.isOk()).toBe(true);
  expect(requested).toBe("https://lilac.local/api/resources/id/preview");
  expect(requestOptions).toMatchObject({ signal, credentials: "same-origin", cache: "no-store" });
});

test("binary and missing files produce bounded local messages", async () => {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://lilac.local" },
  });
  for (const status of [422, 404]) {
    globalThis.fetch = Object.assign(
      async () => new Response("private backend details", { status }),
      { preconnect: originalFetch.preconnect },
    );
    const result = await loadResourcePreview("/api/resources/id", new AbortController().signal);
    expect(result.match({ ok: () => "unexpected", err: (error) => error.message })).toBe(
      status === 422
        ? "Text preview is unavailable for this binary file."
        : "This file is unavailable.",
    );
  }
});

test("HTML rendering fetches complete authorized bytes and forwards cancellation", async () => {
  const source = "<!doctype html>" + " ".repeat(70_000) + "<h1>End of report</h1>";
  const signal = new AbortController().signal;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/files/id?revision=1");
      expect(init).toMatchObject({ signal, credentials: "same-origin", cache: "no-store" });
      return new Response(source);
    },
    { preconnect: originalFetch.preconnect },
  );
  expect((await loadHtmlFile("/api/files/id?revision=1", signal)).unwrap()).toBe(source);
});

test("HTML rendering does not display failed response bodies", async () => {
  globalThis.fetch = Object.assign(
    async () => new Response("private backend details", { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
  const result = await loadHtmlFile("/api/files/missing", new AbortController().signal);
  expect(result.match({ ok: () => "unexpected", err: (error) => error.message })).toBe(
    "This file is unavailable.",
  );
});

test("a small image previews at its natural size and a large one fits the preview", () => {
  const viewport = { width: 800, height: 600 };
  expect(imageFitScale({ width: 200, height: 100 }, viewport)).toBe(0.25);
  expect(imageFitScale({ width: 1600, height: 300 }, viewport)).toBe(1);
  expect(imageFitScale({ width: 400, height: 1200 }, viewport)).toBe(1);
  expect(imageFitScale({ width: 0, height: 0 }, viewport)).toBe(1);
});
