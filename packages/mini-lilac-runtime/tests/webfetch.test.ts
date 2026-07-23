import { describe, expect, it } from "bun:test";

import { WEBFETCH_MAX_RESPONSE_BYTES, executeWebfetch, webfetchInputSchema } from "../src/webfetch";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }] as const;

describe("Mini Lilac webfetch", () => {
  it("applies bounded defaults and rejects non-HTTP URLs and credentials", () => {
    expect(webfetchInputSchema.parse({ url: "https://example.com" })).toEqual({
      url: "https://example.com",
      format: "markdown",
      timeoutMs: 30_000,
      maxCharacters: 50_000,
    });
    expect(() => webfetchInputSchema.parse({ url: "file:///etc/passwd" })).toThrow();
    expect(() => webfetchInputSchema.parse({ url: "https://user:secret@example.com" })).toThrow(
      "credentials",
    );
    expect(() => webfetchInputSchema.parse({ url: "https://example.com", extra: true })).toThrow();
  });

  it("blocks local, private, mapped, metadata, and mixed DNS destinations before fetching", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return new Response("unexpected");
    };

    for (const url of [
      "http://127.1/",
      "http://2130706433/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "https://metadata.google.internal/",
      "https://service.internal/",
    ]) {
      await expect(
        executeWebfetch({ url }, {}, { fetch: fetchImpl, lookup: publicLookup }),
      ).rejects.toThrow(/blocked/u);
    }

    await expect(
      executeWebfetch(
        { url: "https://public.example.com" },
        {},
        {
          fetch: fetchImpl,
          lookup: async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "10.0.0.1", family: 4 },
          ],
        },
      ),
    ).rejects.toThrow("blocked destination");
    expect(fetches).toBe(0);
  });

  it("refuses inherited proxies and retries validated addresses after connection failures", async () => {
    await expect(
      executeWebfetch(
        { url: "https://public.example.com" },
        {},
        { environment: { HTTPS_PROXY: "http://proxy.example.com" } },
      ),
    ).rejects.toThrow("proxy routing bypasses destination pinning");

    const requested: string[] = [];
    const result = await executeWebfetch(
      { url: "https://public.example.com", format: "text" },
      {},
      {
        lookup: async () => [
          { address: "2606:4700:4700::1111", family: 6 },
          { address: "93.184.216.34", family: 4 },
        ],
        fetch: async (url) => {
          requested.push(String(url));
          if (requested.length === 1) throw new Error("IPv6 unavailable");
          return new Response("fallback worked", {
            headers: { "content-type": "text/plain" },
          });
        },
      },
    );
    expect(requested).toEqual(["https://[2606:4700:4700::1111]/", "https://93.184.216.34/"]);
    expect(result.content).toBe("fallback worked");
  });

  it("converts bounded HTML to Markdown without active content", async () => {
    const result = await executeWebfetch(
      {
        url: "https://public.example.com/article#section",
        maxCharacters: 100,
      },
      {},
      {
        lookup: publicLookup,
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://93.184.216.34/article");
          expect(init?.redirect).toBe("manual");
          expect(new Headers(init?.headers).get("user-agent")).toBe("MiniLilac/1.0 webfetch");
          expect(new Headers(init?.headers).get("host")).toBe("public.example.com");
          expect(init?.tls?.serverName).toBe("public.example.com");
          return new Response(
            "<html><head><title> Example Article </title><script>ignore()</script></head><body><h1>Hello</h1><p>Useful <strong>evidence</strong>.</p></body></html>",
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        },
      },
    );

    expect(result.requestedUrl).toBe("https://public.example.com/article");
    expect(result.title).toBe("Example Article");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("**evidence**");
    expect(result.content).not.toContain("ignore");
    expect(result.truncated).toBe(false);
  });

  it("revalidates relative redirects and blocks HTTPS downgrades", async () => {
    const requested: string[] = [];
    const result = await executeWebfetch(
      { url: "https://public.example.com/start", format: "text" },
      {},
      {
        lookup: publicLookup,
        fetch: async (url) => {
          requested.push(String(url));
          if (requested.length === 1) {
            return new Response(null, { status: 302, headers: { location: "/final" } });
          }
          return new Response("finished", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        },
      },
    );
    expect(requested).toEqual(["https://93.184.216.34/start", "https://93.184.216.34/final"]);
    expect(result.url).toBe("https://public.example.com/final");
    expect(result.redirects).toBe(1);

    await expect(
      executeWebfetch(
        { url: "https://public.example.com/start" },
        {},
        {
          lookup: publicLookup,
          fetch: async () =>
            new Response(null, {
              status: 302,
              headers: { location: "http://public.example.com/final" },
            }),
        },
      ),
    ).rejects.toThrow("HTTPS to HTTP");

    let privateRedirectFetches = 0;
    await expect(
      executeWebfetch(
        { url: "https://public.example.com/start" },
        {},
        {
          lookup: publicLookup,
          fetch: async () => {
            privateRedirectFetches += 1;
            return new Response(null, {
              status: 302,
              headers: { location: "https://127.0.0.1/private" },
            });
          },
        },
      ),
    ).rejects.toThrow("blocked address");
    expect(privateRedirectFetches).toBe(1);
  });

  it("cancels a stalled response body when the caller aborts", async () => {
    const abortController = new AbortController();
    let bodyCancelled = false;
    let responseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    const pending = executeWebfetch(
      { url: "https://public.example.com/stalled" },
      { abortSignal: abortController.signal },
      {
        lookup: publicLookup,
        fetch: async () => {
          responseStarted?.();
          return new Response(
            new ReadableStream({
              cancel() {
                bodyCancelled = true;
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        },
      },
    );
    await started;
    await Bun.sleep(0);
    abortController.abort(new Error("cancelled by test"));
    await expect(pending).rejects.toThrow("cancelled by test");
    expect(bodyCancelled).toBe(true);
  });

  it("rejects unsupported content and oversized responses, and reports output truncation", async () => {
    await expect(
      executeWebfetch(
        { url: "https://public.example.com/file" },
        {},
        {
          lookup: publicLookup,
          fetch: async () =>
            new Response("pdf", { headers: { "content-type": "application/pdf" } }),
        },
      ),
    ).rejects.toThrow("does not support Content-Type");

    let oversizedCancelled = false;
    await expect(
      executeWebfetch(
        { url: "https://public.example.com/large" },
        {},
        {
          lookup: publicLookup,
          fetch: async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  oversizedCancelled = true;
                },
              }),
              {
                headers: {
                  "content-type": "text/plain",
                  "content-length": String(WEBFETCH_MAX_RESPONSE_BYTES + 1),
                },
              },
            ),
        },
      ),
    ).rejects.toThrow("exceeds");
    expect(oversizedCancelled).toBe(true);

    const truncated = await executeWebfetch(
      { url: "https://public.example.com/text", format: "text", maxCharacters: 4 },
      {},
      {
        lookup: publicLookup,
        fetch: async () => new Response("abcdefgh", { headers: { "content-type": "text/plain" } }),
      },
    );
    expect(truncated.content).toBe("abcd");
    expect(truncated.truncated).toBe(true);
  });
});
