import path from "node:path";

let cached: string | null = null;

export async function getRemoteRunnerJsText(): Promise<string> {
  if (cached) return cached;

  const filePath = path.resolve(
    import.meta.dir,
    "remote-js",
    "remote-runner.cjs",
  );

  const text = await Bun.file(filePath).text();
  cached = text;
  return text;
}
