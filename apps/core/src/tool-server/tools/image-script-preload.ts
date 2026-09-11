// The parent serializes its resolved connections; load them before static imports run.
const providers: unknown = JSON.parse(process.env.LILAC_IMAGE_PROVIDERS ?? "{}");
delete process.env.LILAC_IMAGE_PROVIDERS;
Object.defineProperty(globalThis, "providers", {
  value: providers,
  writable: true,
  configurable: true,
});

export {};
